import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountProviderService, ProviderConfigMap } from "@zcode/provider";
import { downloadZCodeBuiltinRelease } from "@zcode/provider-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderConfigRuntime } from "#src/model-provider/providerConfigRuntime.js";
import { createProviderRuntimeFromConfigRuntime } from "#src/model-provider/providerRuntime.js";
import { createAccountProviderConfig } from "./providerConfigFixtures.js";

const plans = ["account:bigmodel-team-coding-plan", "account:bigmodel-start-plan"] as const;
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function setup(active = false) {
  const root = await mkdtemp(join(tmpdir(), "builtin-refresh-failure-"));
  const bundled = join(root, "bundled.json");
  const activePath = join(root, "active.json");
  const release = JSON.parse(
    await readFile(new URL("../../../config/provider/zcode-builtin.json", import.meta.url), "utf8"),
  );
  release.revision = 1;
  await writeFile(bundled, JSON.stringify(release));
  if (active) await writeFile(activePath, JSON.stringify({ ...release, revision: 2 }));
  const download = vi.fn(async () => null);
  const configRuntime = createProviderConfigRuntime({
    zcodeBuiltinFilePath: bundled,
    zcodeBuiltinActiveFilePath: activePath,
    personalFilePath: join(root, "personal.json"),
    personalPollingIntervalMs: false,
    watch: false,
    zcodeBuiltinRemote: {
      controlFilePath: join(root, "refresh.json"),
      resolveEndpointKey: () => "https://control.example.com",
      fetchRelease: download,
    },
  });
  let entitled = false;
  const resolve = vi.fn(async () => ({
    providers: new ProviderConfigMap(
      plans.map((id) => [
        id,
        createAccountProviderConfig({
          accountType: "bigmodel",
          mode: id === plans[0] ? "team-coding-plan" : "start-plan",
          entitled,
        }),
      ]),
    ),
    states: {},
  }));
  const account = new AccountProviderService({
    configSource: configRuntime.configService,
    resolve,
  });
  const runtime = createProviderRuntimeFromConfigRuntime({
    configRuntime,
    accountSource: account,
    disposeAccountSource: () => account.dispose(),
  });
  cleanups.push(async () => {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.start();
  await configRuntime.refreshZCodeBuiltin();
  return {
    runtime,
    configRuntime,
    bundled,
    activePath,
    download,
    resolve,
    grant: () => {
      entitled = true;
    },
  };
}

describe("Builtin 远端失败不阻断有效本地配置的业务刷新", () => {
  it.each([
    ["HTTP 地址校验失败", false, "invalid-url"],
    ["下载服务 503", true, "http-error"],
    ["下载正文不是 JSON", false, "invalid-json"],
    ["请求取消", true, "cancelled"],
  ] as const)("%s：继续更新 Team/Start 权益并保留本地 Release", async (_, active, failure) => {
    const fixture = await setup(active);
    const before = await readFile(fixture.activePath, "utf8");
    const request = vi.fn(async () => {
      if (failure === "http-error") return new Response("unavailable", { status: 503 });
      if (failure === "invalid-json") return new Response("not json");
      return Response.json({
        code: 0,
        data: { configs: { builtin_provider_config_json: "http://cdn.example.com/release.json" } },
      });
    });
    fixture.download.mockImplementation(async () => {
      await downloadZCodeBuiltinRelease({
        endpointOrigin: "https://control.example.com",
        platform: "linux-x86_64",
        appVersion: "test",
        request,
        ...(failure === "cancelled" ? { signal: AbortSignal.abort() } : {}),
      });
      return null;
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    fixture.grant();
    await fixture.runtime.providerSettings.refresh("composer-connection");
    const view = await fixture.runtime.modelSelection.getView();
    for (const id of plans) {
      const provider = view.providers.find((entry) => entry.providerId === id);
      expect(provider?.config.access).toMatchObject({ entitled: true });
      expect(provider?.models.length).toBeGreaterThan(0);
    }
    expect(fixture.resolve).toHaveBeenCalled();
    expect(warning).toHaveBeenCalled();
    expect(await readFile(fixture.activePath, "utf8")).toBe(before);
    if (failure === "invalid-url") expect(request).toHaveBeenCalledTimes(1);
  });

  it("远端和账号同时失败时，返回真实账号错误，不用旧权益伪装成功", async () => {
    const fixture = await setup();
    fixture.download.mockRejectedValue(new Error("remote unavailable"));
    const accountError = new Error("account entitlement unavailable");
    fixture.resolve.mockRejectedValue(accountError);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(fixture.runtime.providerSettings.refresh("composer-connection")).rejects.toBe(
      accountError,
    );
  });

  it("本地 Bundled 与 Active 都不可用时，仍拒绝刷新", async () => {
    const fixture = await setup();
    await writeFile(fixture.bundled, "invalid json");
    await writeFile(fixture.activePath, "invalid json");
    fixture.download.mockRejectedValue(new Error("remote unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(fixture.runtime.providerSettings.refresh("settings-manual")).rejects.toThrow();
  });
});
