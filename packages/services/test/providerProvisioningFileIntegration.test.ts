import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModelConfigRules,
  ModelConfig,
  ModelOptionSpecsConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderRegistry,
  resolveInitialModelSelection,
  type ModelSelection,
  type ModelSelectionValidation,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";
import {
  NodePersonalProviderConfigRepository,
  NodeModelSelectionConfigRepository,
  encodeProviderConfigFile,
} from "@zcode/provider-node";
import { providerProvisioningEnvelopeSchema } from "@zcode/shared";
import { createProviderProvisioningSource } from "../src/model-provider/providerProvisioningSource.js";
import { createProviderProvisioningTarget } from "../src/model-provider/providerProvisioningTarget.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const selection = { providerId: "fixture", modelId: "model-a" };
function config(name: string, withDefault = true): ProviderConfigLayerUpdate {
  return {
    providers: new ProviderConfigMap([
      {
        providerId: "fixture",
        providerName: name,
        config: new ProviderConfig({ personalModelIds: ["model-a"] }),
      },
    ]),
    models: ModelConfigRules.empty(),
    ...(withDefault ? { defaultModelSelection: selection } : {}),
  };
}
const accountSettings = { providerFamilyDomain: null, providerFamilyConnectionSelections: {} };
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "todo104-provision-file-"));
  const filePath = join(directory, "provider_config.json");
  const personal = new NodePersonalProviderConfigRepository({ filePath, pollingIntervalMs: false });
  cleanups.push(async () => {
    personal.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await personal.update(() => config("Before"));
  const settings = {
    get: vi.fn(async () => accountSettings),
    update: vi.fn(async () => undefined),
  };
  const account = { refresh: vi.fn(async () => undefined) };
  const registry = {
    refresh: vi.fn(async () => ({ sourceRevisions: { config: "config:fixture" } })),
    validateSelection: vi.fn<(selection: ModelSelection) => ModelSelectionValidation>(() => ({
      ok: true,
    })),
  };
  const target = createProviderProvisioningTarget({
    personalRepository: personal,
    providerRuntime: { start: async () => undefined, registryService: registry } as never,
    accountProviderSource: account as never,
    settingService: settings as never,
    credentialService: {
      load: async () => null,
      save: async () => undefined,
      delete: async () => undefined,
    } as never,
    personalConfigFilePath: filePath,
    stateFilePath: join(directory, "provisioning.json"),
  });
  function envelope(withDefault = true) {
    return providerProvisioningEnvelopeSchema.parse({
      schemaVersion: 1,
      syncId: "fixture-sync",
      personalConfig: encodeProviderConfigFile(config("Incoming", withDefault)).config,
      accountSettings,
      credentials: [],
    });
  }
  return { directory, filePath, personal, settings, account, registry, target, envelope };
}

describe("Todo104 分发同文件原子边界", () => {
  it.each([
    "missing-reasoning",
    "unsupported-reasoning",
    "missing-model",
    "missing-provider",
    "empty-registry",
    "valid",
  ])("完整同步保留默认偏好 %s，由 Host 解析新会话推荐", async (kind) => {
    const { personal, target, envelope, registry } = await setup();
    const realRegistry = new ProviderRegistry([
      {
        providerId: "fixture",
        config: new ProviderConfig({ personalModelIds: ["model-a"] }),
        models: [
          {
            modelId: "model-a",
            config: new ModelConfig({
              optionSpecs: new ModelOptionSpecsConfig({
                reasoningLevel: { values: ["low", "high"], map: "{}" },
              }),
            }),
          },
        ],
      },
    ]);
    if (kind === "empty-registry") realRegistry.replace([], "fixture-empty");
    registry.validateSelection.mockImplementation((value) => realRegistry.validateSelection(value));
    const input = envelope();
    const preferred: ModelSelection = {
      providerId: kind === "missing-provider" ? "removed" : "fixture",
      modelId: kind === "missing-model" ? "removed" : "model-a",
      ...(kind === "missing-reasoning"
        ? {}
        : {
            options: { reasoningLevel: kind === "unsupported-reasoning" ? "removed" : "high" },
          }),
    };
    input.personalConfig.defaultModelSelection = preferred;
    expect(await target.apply(input)).toMatchObject({ status: "applied", rolledBack: false });
    expect((await personal.read()).defaultModelSelection).toEqual(preferred);
    const recommendation = resolveInitialModelSelection({
      configuredDefault: (await personal.read()).defaultModelSelection,
      registry: realRegistry.getView(),
    });
    if (kind === "empty-registry") {
      expect(recommendation).toEqual({ source: "none" });
      return;
    }
    expect(recommendation).toMatchObject({
      source: kind === "valid" ? "configured-default" : "registry-fallback",
      selection: { providerId: "fixture", modelId: "model-a", options: { reasoningLevel: "high" } },
    });
  });

  it("Source 读取期间文件被另一个写入更新时拒绝旧快照，不拼接默认选择", async () => {
    const { directory, filePath, personal, settings } = await setup();
    const read = personal.read.bind(personal);
    vi.spyOn(personal, "read").mockImplementationOnce(async () => {
      const previous = await read();
      await personal.update((current) => ({
        ...current,
        defaultModelSelection: { providerId: "fixture", modelId: "new-default" },
      }));
      return previous;
    });
    const source = createProviderProvisioningSource({
      personalRepository: personal,
      settingService: settings as never,
      credentialFilePath: join(directory, "credentials.json"),
      personalConfigFilePath: filePath,
    });
    await expect(source.read("stale-read")).rejects.toThrow("无法同步");
    expect((await read()).defaultModelSelection?.modelId).toBe("new-default");
  });

  it("写入其他域时 Personal 已发生变化，前向替换也必须保留并发值", async () => {
    const { personal, settings, target, envelope } = await setup();
    settings.update.mockImplementationOnce(async () => {
      await personal.update((current) => ({
        ...current,
        defaultModelSelection: { providerId: "fixture", modelId: "new-before-apply" },
      }));
    });
    expect(await target.apply(envelope(false))).toMatchObject({ status: "rollback_failed" });
    const current = await personal.read();
    expect(current.defaultModelSelection?.modelId).toBe("new-before-apply");
    expect(current.providers.getRule("fixture")?.providerName).toBe("Before");
  });

  it("Source 从同一快照导出完整 Personal；不再携带重复默认或 sourceRevision", async () => {
    const { directory, filePath, personal, settings } = await setup();
    const source = createProviderProvisioningSource({
      personalRepository: personal,
      settingService: settings as never,
      credentialFilePath: join(directory, "credentials.json"),
      personalConfigFilePath: filePath,
    });
    const result = await source.read("read-one");
    expect(result.personalConfig).toEqual(encodeProviderConfigFile(await personal.read()).config);
    expect(result.personalConfig.defaultModelSelection).toEqual(selection);
    expect(result).not.toHaveProperty("configuredDefault");
    expect(result).not.toHaveProperty("sourceRevision");
    await writeFile(filePath, "{broken");
    await expect(source.read("read-bad")).rejects.toThrow("无法同步");
    expect(await readFile(filePath, "utf8")).toBe("{broken");
  });

  it("Target 一次更新同时清除缺省默认，重复 syncId 不重新应用", async () => {
    const { personal, target, envelope } = await setup();
    const defaults = new NodeModelSelectionConfigRepository({ personalRepository: personal });
    const changed = vi.fn();
    defaults.onDidChange(changed);
    try {
      expect(await target.apply(envelope(false))).toMatchObject({
        status: "applied",
        configRevision: "config:fixture",
      });
      expect((await personal.read()).providers.getRule("fixture")?.providerName).toBe("Incoming");
      expect(await defaults.read()).toBeUndefined();
      expect(changed).toHaveBeenCalledTimes(1);
      expect(await target.apply(envelope(false))).toMatchObject({ status: "already-applied" });
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      defaults.dispose();
    }
  });

  it("后续刷新失败时整份恢复 Provider 和默认选择", async () => {
    const { personal, account, target, envelope } = await setup();
    const before = encodeProviderConfigFile(await personal.read());
    account.refresh.mockRejectedValueOnce(new Error("refresh failed"));
    expect(await target.apply(envelope(false))).toMatchObject({
      status: "failed",
      rolledBack: true,
      errorCode: "target-refresh-failed",
    });
    expect(encodeProviderConfigFile(await personal.read())).toEqual(before);
  });

  it.each(["provider", "default"])(
    "刷新失败前另一个写入修改 %s，不能用旧回滚覆盖",
    async (field) => {
      const { personal, account, target, envelope } = await setup();
      account.refresh.mockImplementationOnce(async () => {
        await personal.update((current) =>
          field === "provider"
            ? {
                ...current,
                providers: current.providers.setRule({
                  ...current.providers.getRule("fixture")!,
                  providerName: "Concurrent",
                }),
              }
            : {
                ...current,
                defaultModelSelection: { providerId: "fixture", modelId: "concurrent-model" },
              },
        );
        throw new Error("refresh failed after concurrent edit");
      });
      expect(await target.apply(envelope(false))).toMatchObject({
        status: "rollback_failed",
        rolledBack: false,
      });
      const current = await personal.read();
      if (field === "provider")
        expect(current.providers.getRule("fixture")?.providerName).toBe("Concurrent");
      else expect(current.defaultModelSelection?.modelId).toBe("concurrent-model");
    },
  );
});
