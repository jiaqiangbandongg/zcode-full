import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AccountProviderService, ProviderConfigMap } from "@zcode/provider";
import { describe, expect, it, vi } from "vitest";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";
import { createProviderRuntimeFromConfigRuntime } from "../src/model-provider/providerRuntime.js";

describe("App Built-in / Account 失败恢复", () => {
  it("Account 新版解析失败保留完整旧 Registry；下一分钟在下载 TTL 内仅重建 Account", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const root = await mkdtemp(join(tmpdir(), "provider-account-recovery-"));
    const builtin = join(root, "builtin.json");
    const release = {
      schemaVersion: 1,
      revision: 1,
      config: {
        providerConfigRules: { templateRules: [], providerRules: [] },
        modelConfigRules: {
          modelRules: [],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [],
          builtinProviderModelRules: [],
        },
      },
    };
    await writeFile(builtin, JSON.stringify(release));
    const download = vi.fn(async () => null);
    const configRuntime = createProviderConfigRuntime({
      zcodeBuiltinFilePath: builtin,
      personalFilePath: join(root, "personal.json"),
      personalPollingIntervalMs: false,
      zcodeBuiltinRemote: {
        controlFilePath: join(root, "control.json"),
        resolveEndpointKey: () => "https://control.example",
        fetchRelease: download,
      },
    });
    let fail = false;
    const resolve = vi.fn(async () => {
      if (fail) throw new Error("temporary account failure");
      return { providers: ProviderConfigMap.empty(), states: {} };
    });
    const account = new AccountProviderService({
      configSource: configRuntime.configService,
      resolve,
    });
    const errors = vi.fn();
    account.onDidRefreshError(errors);
    const runtime = createProviderRuntimeFromConfigRuntime({
      configRuntime,
      accountSource: account,
      disposeAccountSource: () => account.dispose(),
    });
    try {
      await runtime.start();
      await configRuntime.refreshZCodeBuiltin();
      const old = runtime.registryService.getSnapshot()!;
      fail = true;
      await writeFile(builtin, JSON.stringify({ ...release, revision: 2 }));
      await vi.waitFor(() => expect(errors).toHaveBeenCalled());
      expect(runtime.registryService.getSnapshot()!.config.zcodeBuiltinRevision).toBe(
        old.config.zcodeBuiltinRevision,
      );
      fail = false;
      const beforeRecovery = resolve.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() =>
        expect(runtime.registryService.getSnapshot()!.config.zcodeBuiltinRevision).toMatch(
          "zcode-builtin:2:",
        ),
      );
      const next = runtime.registryService.getSnapshot()!;
      expect(next.account.basedOnZCodeBuiltinRevision).toBe(next.config.zcodeBuiltinRevision);
      expect(resolve.mock.calls.length).toBe(beforeRecovery + 1);
      expect(download).toHaveBeenCalledTimes(1);
    } finally {
      runtime.dispose();
      vi.useRealTimers();
      await rm(root, { recursive: true, force: true });
    }
  });
});
