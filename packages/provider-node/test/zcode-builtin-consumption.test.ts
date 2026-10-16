import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountProviderService,
  ApiKeyAccessConfig,
  ModelConfigRules,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ModelConfig,
  ModelPropertiesConfig,
} from "@zcode/provider";
import { expect, it, vi } from "vitest";
import {
  NodeProviderRegistryRuntime,
  NodeZCodeBuiltinProviderConfigSource,
  decodeZCodeBuiltinRelease,
} from "../src/index.js";

it("更新只改变后续 Registry 消费，Personal 覆盖/历史选择与已取得模型配置不被代写", async () => {
  const root = await mkdtemp(join(tmpdir(), "builtin-consumption-"));
  const bundled = join(root, "bundled.json");
  const active = join(root, "active.json");
  const personal = join(root, "personal.json");
  const release = JSON.parse(
    await readFile(new URL("../../../config/provider/zcode-builtin.json", import.meta.url), "utf8"),
  );
  release.config.modelConfigRules.modelRules.push({
    modelMatch: "test-model-.*",
    config: { properties: { contextWindow: 500_000 } },
  });
  await writeFile(bundled, JSON.stringify(release));
  const source = new NodeZCodeBuiltinProviderConfigSource({
    bundledFilePath: bundled,
    activeFilePath: active,
    watch: false,
  });
  await source.read();
  let account!: AccountProviderService;
  const runtime = new NodeProviderRegistryRuntime({
    zcodeBuiltinFilePath: active,
    personalFilePath: personal,
    personalPollingIntervalMs: false,
    createAccountSource(configSource) {
      account = new AccountProviderService({
        configSource,
        resolve: async () => ({ providers: ProviderConfigMap.empty(), states: {} }),
      });
      return account;
    },
  });
  try {
    await runtime.personalRepository.update(() => ({
      providers: new ProviderConfigMap([
        [
          "manual",
          new ProviderConfig({
            group: "standard-personal",
            api: new ProviderApiConfig({
              type: "openai-chat-completions",
              baseUrl: "https://test.invalid/v1",
            }),
            access: new ApiKeyAccessConfig({ apiKey: "test-only" }),
            personalModelIds: ["test-model-inherit", "test-model-personal"],
          }),
        ],
      ]),
      models: new ModelConfigRules([
        {
          type: "provider-model",
          providerId: "manual",
          modelId: "test-model-personal",
          config: new ModelConfig({
            properties: new ModelPropertiesConfig({ contextWindow: 123_456 }),
          }),
        },
      ]),
      defaultModelSelection: {
        providerId: "manual",
        modelId: "test-model-inherit",
        options: { reasoningLevel: "disabled" },
      },
    }));
    await runtime.start();
    const beforeFile = await readFile(personal, "utf8");
    const old = runtime.registryService.getModel("manual", "test-model-inherit")!;
    expect(old.config.properties.contextWindow).toBe(500_000);
    release.revision += 1;
    release.config.modelConfigRules.modelRules.at(-1).config.properties.contextWindow = 700_000;
    await source.applyRemoteRelease(decodeZCodeBuiltinRelease(release));
    await vi.waitFor(() =>
      expect(
        runtime.registryService.getModel("manual", "test-model-inherit")!.config.properties
          .contextWindow,
      ).toBe(700_000),
    );
    expect(
      runtime.registryService.getModel("manual", "test-model-personal")!.config.properties
        .contextWindow,
    ).toBe(123_456);
    expect(old.config.properties.contextWindow).toBe(500_000);
    expect(await readFile(personal, "utf8")).toBe(beforeFile);
  } finally {
    runtime.dispose();
    account?.dispose();
    source.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
