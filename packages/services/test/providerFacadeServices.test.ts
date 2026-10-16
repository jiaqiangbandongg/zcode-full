import type {
  ModelSelectionFacade,
  ModelSelectionView,
  ProviderSettingsFacade,
} from "@zcode/provider";
import { describe, expect, it, vi } from "vitest";
import {
  createModelSelectionService,
  createProviderSettingsService,
} from "../src/model-provider/providerFacadeServices.js";

describe("Provider Settings 目标环境写入", () => {
  it.each(["missing-provider", "missing-model", "upstream"])(
    "连接测试边界区分 %s",
    async (kind) => {
      const facade = {
        onDidChange: vi.fn(),
        waitForProviderOperations: vi.fn(async () => {}),
        getView: vi.fn(() => ({
          providers:
            kind === "missing-provider"
              ? []
              : [
                  {
                    providerId: "p",
                    enabled: true,
                    executable: true,
                    models:
                      kind === "missing-model"
                        ? []
                        : [{ modelId: "m", enabled: true, executable: true, issues: [] }],
                  },
                ],
        })),
      };
      const failure = { success: false as const, error: { message: "signature upstream failure" } };
      const testConnectivity = vi.fn(async () => failure);
      const service = createProviderSettingsService(
        facade as unknown as ProviderSettingsFacade,
        undefined,
        testConnectivity,
      );
      const result = await service.testModelConnectivity({
        workspacePath: "/p",
        workspaceIdentity: "ssh:fixture:/p",
        providerId: "p",
        modelId: "m",
      });
      if (kind === "upstream") {
        expect(result).toBe(failure);
        expect(testConnectivity).toHaveBeenCalledWith({
          workspacePath: "/p",
          workspaceIdentity: "ssh:fixture:/p",
          providerId: "p",
          modelId: "m",
        });
      } else {
        expect(result).toMatchObject({
          success: false,
          error: {
            code: kind === "missing-provider" ? "provider-unavailable" : "model-unavailable",
          },
        });
        expect(testConnectivity).not.toHaveBeenCalled();
      }
    },
  );
  it.each([
    {
      enabled: false,
      executable: false,
      modelEnabled: true,
      modelExecutable: false,
      code: "provider-unavailable",
    },
    {
      enabled: true,
      executable: false,
      modelEnabled: false,
      modelExecutable: false,
      code: "model-unavailable",
    },
    {
      enabled: true,
      executable: false,
      modelEnabled: true,
      modelExecutable: false,
      code: "provider-unavailable",
    },
    { enabled: true, executable: true, modelEnabled: true, modelExecutable: true, code: undefined },
  ])(
    "测试读取操作完成后的公共资格 $code",
    async ({ enabled, executable, modelEnabled, modelExecutable, code }) => {
      let release!: () => void;
      const operations = new Promise<void>((resolve) => {
        release = resolve;
      });
      const facade = {
        onDidChange: vi.fn(),
        waitForProviderOperations: vi.fn(() => operations),
        getView: vi.fn(() => ({
          providers: [
            {
              providerId: "p",
              enabled,
              executable,
              issues: [],
              models: [
                { modelId: "m", enabled: modelEnabled, executable: modelExecutable, issues: [] },
              ],
            },
          ],
        })),
      };
      const testConnectivity = vi.fn(async () => ({ success: true as const }));
      const service = createProviderSettingsService(
        facade as unknown as ProviderSettingsFacade,
        undefined,
        testConnectivity,
      );
      const pending = service.testModelConnectivity({
        workspacePath: "/p",
        providerId: "p",
        modelId: "m",
      });
      expect(facade.getView).not.toHaveBeenCalled();
      release();
      const result = await pending;
      expect(facade.getView).toHaveBeenCalledTimes(1);
      if (code) {
        expect(result).toMatchObject({ success: false, error: { code } });
        expect(testConnectivity).not.toHaveBeenCalled();
      } else {
        expect(result).toEqual({ success: true });
        expect(testConnectivity).toHaveBeenCalledWith({
          workspacePath: "/p",
          providerId: "p",
          modelId: "m",
        });
      }
    },
  );
  it("启停等待目标环境就绪，只调用该环境 Facade 并返回其 View", async () => {
    const local = { setPersonalModelEnabled: vi.fn(), onDidChange: vi.fn() };
    const view = { revision: 8, providers: [] };
    const remote = { setPersonalModelEnabled: vi.fn(async () => view), onDidChange: vi.fn() };
    let ready!: () => void;
    const gate = new Promise<void>((resolve) => {
      ready = resolve;
    });
    createProviderSettingsService(local as unknown as ProviderSettingsFacade);
    const service = createProviderSettingsService(
      remote as unknown as ProviderSettingsFacade,
      () => gate,
    );
    const pending = service.setPersonalModelEnabled("account", "model", false);
    expect(remote.setPersonalModelEnabled).not.toHaveBeenCalled();
    ready();
    expect(await pending).toBe(view);
    expect(remote.setPersonalModelEnabled).toHaveBeenCalledWith("account", "model", false);
    expect(local.setPersonalModelEnabled).not.toHaveBeenCalled();
    remote.setPersonalModelEnabled.mockRejectedValueOnce(new Error("write failed"));
    await expect(service.setPersonalModelEnabled("account", "model", true)).rejects.toThrow(
      "write failed",
    );
  });
});

describe("createModelSelectionService", () => {
  it("读取参数只交给该次 Facade 调用，不进入广播或其他消费者", async () => {
    let emit: (() => void) | undefined;
    const base: ModelSelectionView = { revision: 1, providers: [] };
    const facade = {
      getView: vi.fn((_default, revision, input) => ({
        ...base,
        revision: revision ?? base.revision,
        ...(input ? { effectiveSelection: input.selection } : {}),
      })),
      onDidChange: vi.fn((listener) => {
        emit = listener;
        return () => {};
      }),
    } as unknown as ModelSelectionFacade;
    const service = createModelSelectionService(facade);
    const a = { providerId: "a", modelId: "m", options: { reasoningLevel: "low" } };
    const b = { ...a, providerId: "b" };
    const results = await Promise.all([
      service.getView({ selection: a }),
      service.getView({ selection: b }),
    ]);
    expect(results.map((view) => view.effectiveSelection)).toEqual([a, b]);
    const listener = vi.fn();
    service.onDidChange(listener);
    emit?.();
    await vi.waitFor(() => expect(listener).toHaveBeenCalled());
    expect(listener.mock.calls[0]?.[0]).not.toHaveProperty("effectiveSelection");
    expect(await service.getView()).not.toHaveProperty("effectiveSelection");
    service.dispose();
  });

  it("dispose 后终止已经在途的事件 View 重建，不再读取配置源", async () => {
    let emit: (() => void) | undefined;
    let releaseReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const view: ModelSelectionView = { revision: 1, providers: [] };
    const facade = {
      getView: vi.fn(() => view),
      onDidChange: vi.fn((listener: () => void) => {
        emit = listener;
        return () => {};
      }),
    } as unknown as ModelSelectionFacade;
    const configuredDefaultSource = {
      read: vi.fn(async () => undefined),
    };
    const service = createModelSelectionService(facade, () => ready, configuredDefaultSource);

    emit?.();
    service.dispose();
    releaseReady?.();
    await ready;
    await Promise.resolve();

    expect(configuredDefaultSource.read).not.toHaveBeenCalled();
    expect(facade.getView).not.toHaveBeenCalled();
  });
});
