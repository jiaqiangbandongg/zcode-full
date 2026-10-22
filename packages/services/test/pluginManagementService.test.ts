import { describe, expect, it, vi } from "vitest";
import { withPluginTelemetry } from "../src/plugins/pluginManagement.js";
import { createPluginManagementService } from "../src/plugins/pluginManagementService.js";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";

describe("plugin management terminal telemetry", () => {
  const plugin = {
    id: "demo@market",
    name: "demo",
    marketplace: "market",
    version: "1.0",
    enabled: true,
    scope: "user" as const,
  };
  function setup(result: unknown, reject = false) {
    const reportTelemetryEvent = vi.fn();
    const installPlugin = reject
      ? vi.fn().mockRejectedValue(result)
      : vi.fn().mockResolvedValue(result);
    const service = createPluginManagementService({
      zcodeAgentService: { installPlugin } as unknown as IZCodeAgentService,
      reportTelemetryEvent,
    });
    return { service, installPlugin, reportTelemetryEvent };
  }
  const params = {
    workspacePath: "/private/work",
    pluginName: "demo",
    marketplace: "market",
    telemetry: { entry: "store_detail" as const, client_kind: "desktop" as const },
  };
  it("reports a single final result and strips telemetry before forwarding", async () => {
    const result = { installedPlugins: [plugin], dependencyClosure: [plugin.id], diagnostics: [] };
    const { service, installPlugin, reportTelemetryEvent } = setup(result);
    expect(await service.installPlugin(params)).toBe(result);
    expect(installPlugin).toHaveBeenCalledWith({
      workspacePath: params.workspacePath,
      pluginName: "demo",
      marketplace: "market",
    });
    expect(reportTelemetryEvent).toHaveBeenCalledTimes(1);
    expect(reportTelemetryEvent.mock.calls[0][0]).toMatchObject({
      elementName: "plugin_lifecycle",
      eventExtraDetail: {
        action: "install",
        result: "success",
        plugin_id: plugin.id,
        version_after: "1.0",
        entry: "store_detail",
      },
    });
    expect(JSON.stringify(reportTelemetryEvent.mock.calls)).not.toContain(params.workspacePath);
    expect(JSON.stringify(reportTelemetryEvent.mock.calls)).not.toContain("operation_id");
  });
  it("uses diagnostics, not Promise resolution, as success", async () => {
    const { service, reportTelemetryEvent } = setup({
      installedPlugins: [],
      dependencyClosure: [],
      diagnostics: [{ severity: "error", message: "secret" }],
    });
    await service.installPlugin(params);
    expect(reportTelemetryEvent.mock.calls[0][0].eventExtraDetail).toMatchObject({
      result: "failure",
      error_category: "diagnostic",
    });
    expect(JSON.stringify(reportTelemetryEvent.mock.calls)).not.toContain("secret");
  });
  it("does not report dry runs", async () => {
    const { service, reportTelemetryEvent } = setup({
      installedPlugins: [plugin],
      dependencyClosure: [],
      diagnostics: [],
    });
    await service.installPlugin({ ...params, dryRun: true });
    expect(reportTelemetryEvent).not.toHaveBeenCalled();
  });
  it("does not let reporter failure change the business result", async () => {
    const result = { installedPlugins: [plugin], dependencyClosure: [], diagnostics: [] };
    const { service, reportTelemetryEvent } = setup(result);
    reportTelemetryEvent.mockImplementation(() => {
      throw new Error("report unavailable");
    });
    await expect(service.installPlugin(params)).resolves.toBe(result);
  });
  it("preserves the original rejection without disclosing it", async () => {
    const error = new Error("token=secret");
    const { service, reportTelemetryEvent } = setup(error, true);
    await expect(service.installPlugin(params)).rejects.toBe(error);
    expect(reportTelemetryEvent.mock.calls[0][0].eventExtraDetail.result).toBe("failure");
    expect(JSON.stringify(reportTelemetryEvent.mock.calls)).not.toContain("secret");
  });
});

describe("plugin telemetry operation boundaries", () => {
  it("reports no-op uninstall and preserves the cancellation protocol", async () => {
    const reportTelemetryEvent = vi.fn();
    const cancelPluginOperation = vi.fn(async () => ({ cancelled: true, operationId: "cancel-1" }));
    const service = createPluginManagementService({
      zcodeAgentService: {
        uninstallPlugin: vi.fn(async () => ({ diagnostics: [] })),
        cancelPluginOperation,
      } as unknown as IZCodeAgentService,
      reportTelemetryEvent,
    });
    await service.uninstallPlugin({ workspacePath: "/work", pluginId: "demo@market" });
    expect(reportTelemetryEvent.mock.calls[0][0].eventExtraDetail).toMatchObject({
      action: "uninstall",
      result: "noop",
    });
    await service.cancelPluginOperation({ operationId: "cancel-1" });
    expect(cancelPluginOperation).toHaveBeenCalledWith({ operationId: "cancel-1" });
    expect(reportTelemetryEvent).toHaveBeenCalledTimes(1);
  });
  it("records explicit cancellation and batch partial separately", async () => {
    const reportTelemetryEvent = vi.fn();
    const service = createPluginManagementService({
      zcodeAgentService: {
        installPlugin: vi.fn(async () => {
          throw Object.assign(new Error("private"), { name: "AbortError" });
        }),
        updatePlugin: vi.fn(async () => ({
          installedPlugins: [{ id: "a@market", marketplace: "market", scope: "user" }],
          diagnostics: [{ severity: "error", code: "failed", message: "secret" }],
          dependencyClosure: [],
        })),
      } as unknown as IZCodeAgentService,
      reportTelemetryEvent,
    });
    await expect(
      service.installPlugin({ workspacePath: "/work", pluginName: "a", marketplace: "market" }),
    ).rejects.toThrow();
    await service.updatePlugin({ workspacePath: "/work" });
    expect(reportTelemetryEvent.mock.calls.map(([x]) => x.eventExtraDetail.result)).toEqual([
      "cancelled",
      "partial",
    ]);
  });
  it("isolates concurrent durations and does not wait for the reporter", async () => {
    const reportTelemetryEvent = vi.fn(() => new Promise<void>(() => {}));
    let clock = 0;
    const finishes: Array<(value: unknown) => void> = [];
    const service = createPluginManagementService({
      zcodeAgentService: {
        installPlugin: vi.fn(() => new Promise((resolve) => finishes.push(resolve))),
      } as unknown as IZCodeAgentService,
      reportTelemetryEvent,
      now: () => clock,
    });
    const a = service.installPlugin({
      workspacePath: "/a",
      pluginName: "a",
      marketplace: "market",
    });
    clock = 10;
    const b = service.installPlugin({
      workspacePath: "/b",
      pluginName: "b",
      marketplace: "market",
    });
    clock = 25;
    finishes[1]({
      installedPlugins: [{ id: "b@market", marketplace: "market", scope: "user" }],
      diagnostics: [],
      dependencyClosure: [],
    });
    await b;
    clock = 50;
    finishes[0]({
      installedPlugins: [{ id: "a@market", marketplace: "market", scope: "user" }],
      diagnostics: [],
      dependencyClosure: [],
    });
    await a;
    expect(
      reportTelemetryEvent.mock.calls.map(([x]) => [
        x.eventExtraDetail.plugin_id,
        x.eventExtraDetail.duration_ms,
      ]),
    ).toEqual([
      ["b@market", "15"],
      ["a@market", "50"],
    ]);
  });
});

describe("serialized cancellation telemetry", () => {
  it("recognizes original AbortError type preserved by JSON-RPC", async () => {
    const error = Object.assign(new Error("opaque transport error"), {
      data: { name: "AbortError", stack: "private" },
    });
    const reportTelemetryEvent = vi.fn();
    const service = createPluginManagementService({
      zcodeAgentService: {
        installPlugin: vi.fn().mockRejectedValue(error),
      } as unknown as IZCodeAgentService,
      reportTelemetryEvent,
    });
    await expect(
      service.installPlugin({
        workspacePath: "/private",
        pluginName: "demo",
        marketplace: "market",
      }),
    ).rejects.toBe(error);
    expect(reportTelemetryEvent.mock.calls[0][0].eventExtraDetail.result).toBe("cancelled");
    expect(JSON.stringify(reportTelemetryEvent.mock.calls)).not.toContain("private");
  });
});

it("preserves non-enumerable RPC methods when tagging plugin operations", async () => {
  const listPlugins = vi.fn(async () => ({ plugins: [], diagnostics: [] }));
  const installPlugin = vi.fn(async () => ({ installedPlugins: [], diagnostics: [] }));
  const remote = new Proxy(
    {},
    { get: (_target, key) => ({ listPlugins, installPlugin })[key as "listPlugins"] },
  );
  const tagged = withPluginTelemetry(remote as never, {
    entry: "store_detail",
    client_kind: "desktop",
  });
  const params = { workspacePath: "/workspace", pluginName: "demo", marketplace: "market" };
  await tagged.listPlugins(params);
  await tagged.installPlugin(params);
  expect(listPlugins).toHaveBeenCalledWith(params);
  expect(installPlugin).toHaveBeenCalledWith({
    ...params,
    telemetry: { entry: "store_detail", client_kind: "desktop" },
  });
});
