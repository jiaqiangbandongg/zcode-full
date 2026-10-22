import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountProviderService,
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderConfigMap,
  parsePersonalProviderConfigMap,
  resolveInitialModelSelection,
} from "@zcode/provider";
import { encodeProviderConfigFile, NodeModelSelectionConfigRepository } from "@zcode/provider-node";
import type { ProviderProvisioningEnvelope } from "@zcode/shared";
import { createCredentialService } from "../src/credential/credentialService.js";
import { createCredentialCipherProvider } from "../src/credential/providers/credentialCipherProvider.js";
import { createSettingService } from "../src/setting/settingService.js";
import { getDataBaseDir, setDataBaseDir } from "../src/paths.js";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";
import { createProviderRuntimeFromConfigRuntime } from "../src/model-provider/providerRuntime.js";
import { createProviderProvisioningTarget } from "../src/model-provider/providerProvisioningTarget.js";

const selection = {
  providerId: "r3-store",
  modelId: "r3-model",
  options: { reasoningLevel: "disabled" },
};

function providerEntry(key: string, modelId = "r3-model") {
  return {
    providerId: "r3-store",
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: key },
      api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:1/v1" },
      personalModelIds: [modelId],
    },
  };
}

function completeModel() {
  return new ModelConfig({
    enabled: true,
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 32_000,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: { values: ["disabled"], map: "{}" },
      maxOutputTokens: { max: 4096, map: '{"max_tokens":maxOutputTokens}' },
    }),
  });
}

function envelope(syncId: string, key: string): ProviderProvisioningEnvelope {
  const config = encodeProviderConfigFile({
    providers: parsePersonalProviderConfigMap({ providerRules: [providerEntry(key)] }),
    models: ModelConfigRules.empty().setExact("r3-store", "r3-model", completeModel()),
    providerOrder: ["r3-store"],
    // 只有基线信封携带默认选择；后续失败信封会清默认，回滚必须把它一起复原。
    ...(syncId === "baseline" ? { defaultModelSelection: selection } : {}),
  });
  return {
    schemaVersion: 1,
    syncId,
    personalConfig: config.config,
    accountSettings: {
      providerFamilyDomain: syncId === "baseline" ? "bigmodel" : "zai",
      providerFamilyConnectionSelections: {},
    },
    credentials: [{ scope: "oauth-session", key: "oauth:zai:access_token", value: key }],
  };
}

async function createFixture(root: string) {
  setDataBaseDir(root);
  // 设置服务独立读取HOME；仅在Vitest worker中模拟系统用户目录，避免触及真实用户设置。
  vi.stubEnv("HOME", root);
  const dir = join(root, ".zcode/v2");
  await mkdir(dir, { recursive: true });
  const builtin = join(root, "builtin.json");
  await writeFile(
    builtin,
    JSON.stringify({
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
    }),
  );
  const personal = join(dir, "provider_config.json");
  const state = join(dir, "provisioning-state.json");
  const config = createProviderConfigRuntime({
    zcodeBuiltinFilePath: builtin,
    personalFilePath: personal,
    watch: false,
    personalPollingIntervalMs: false,
  });
  // 本测试无账号Provider；权益解析固定为空，事务与Registry、四类Store均使用真实实现。
  const account = new AccountProviderService({
    configSource: config.configService,
    resolve: async () => ({ providers: ProviderConfigMap.empty(), states: {} }),
  });
  const runtime = createProviderRuntimeFromConfigRuntime({
    configRuntime: config,
    accountSource: account,
  });
  // 默认选择只是 Personal 文件的一个字段，与 Provisioning 走同一份 Repository。
  const defaults = new NodeModelSelectionConfigRepository({
    personalRepository: config.personalRepository,
  });
  const credentials = createCredentialService({
    cipherProvider: createCredentialCipherProvider({
      env: { ZCODE_CREDENTIAL_SECRET: "r3-real-stores-test-cipher" },
    }),
  });
  const settings = createSettingService();
  const target = createProviderProvisioningTarget({
    providerRuntime: runtime,
    personalRepository: config.personalRepository,
    accountProviderSource: account,
    credentialService: credentials,
    settingService: settings,
    personalConfigFilePath: personal,
    stateFilePath: state,
    listProvisioningCredentialKeys: async () => ["oauth:zai:access_token"],
  });
  await settings.update({ locale: "en-US", providerFamilyDomain: "bigmodel" });
  await credentials.save("ssh:r3-sentinel", "not-provisioned");
  const baseline = await target.apply(envelope("baseline", "old-value"));
  expect(baseline).toMatchObject({ status: "applied" });
  return {
    runtime,
    account,
    defaults,
    personalRepository: config.personalRepository,
    credentials,
    settings,
    target,
    state,
    personal,
    dir,
    builtin,
    dispose() {
      runtime.dispose();
      account.dispose();
      defaults.dispose();
    },
  };
}

describe("R3A-PRV-08/09 正式磁盘Store与Registry事务", () => {
  let root: string;
  let previousRoot: string;
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  beforeEach(async () => {
    previousRoot = getDataBaseDir();
    root = await mkdtemp(join(tmpdir(), "r3-provisioning-stores-"));
    fixture = await createFixture(root);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    fixture?.dispose();
    setDataBaseDir(previousRoot);
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it.each(["settings", "credentials", "personal"] as const)(
    "PRV-08 %s提交后报错，逆序恢复正式存储及内存Registry",
    async (stage) => {
      const before = await readFile(fixture.personal, "utf8");
      const builtin = await readFile(fixture.builtin, "utf8");
      const inject = <T extends object, K extends keyof T>(object: T, key: K) => {
        const original = object[key] as (...args: unknown[]) => Promise<unknown>;
        vi.spyOn(object, key as never).mockImplementationOnce((async (...args: unknown[]) => {
          await original.apply(object, args);
          throw new Error(`R3_FAULT_AFTER_${stage}`);
        }) as never);
      };
      if (stage === "settings") inject(fixture.settings, "update");
      if (stage === "credentials") inject(fixture.credentials, "save");
      if (stage === "personal") inject(fixture.personalRepository, "update");
      const result = await fixture.target.apply(envelope(`fail-${stage}`, "new-value"));
      expect(result).toMatchObject({ status: "failed", rolledBack: true });
      expect(await readFile(fixture.personal, "utf8")).toBe(before);
      expect(await fixture.defaults.read()).toEqual(selection);
      expect(await fixture.credentials.load("oauth:zai:access_token")).toBe("old-value");
      expect(await fixture.credentials.load("ssh:r3-sentinel")).toBe("not-provisioned");
      expect(await fixture.settings.get()).toMatchObject({
        locale: "en-US",
        providerFamilyDomain: "bigmodel",
      });
      expect(fixture.runtime.registryService.validateSelection(selection).ok).toBe(true);
      const snapshot = await fixture.runtime.configService.read();
      expect(snapshot.personalProviders.get("r3-store")?.access).toMatchObject({
        apiKey: "old-value",
      });
      expect(await readFile(fixture.builtin, "utf8")).toBe(builtin);
      expect(await readFile(fixture.state, "utf8")).not.toContain(`fail-${stage}`);
      expect(await readFile(join(fixture.dir, "credentials.json"), "utf8")).not.toContain(
        "old-value",
      );
    },
  );

  it("PRV-09 丢弃ACK后同syncId重试，再重放更早syncId不会覆盖新配置", async () => {
    await fixture.target.apply(envelope("ack-lost", "middle-value"));
    const stateAfterCommit = await readFile(fixture.state, "utf8");
    expect((await fixture.target.apply(envelope("ack-lost", "middle-value"))).status).toBe(
      "already-applied",
    );
    expect(await readFile(fixture.state, "utf8")).toBe(stateAfterCommit);
    expect((await fixture.target.apply(envelope("newest", "newest-value"))).status).toBe("applied");
    const after = await readFile(fixture.personal, "utf8");
    expect((await fixture.target.apply(envelope("ack-lost", "middle-value"))).status).toBe(
      "already-applied",
    );
    expect(await readFile(fixture.personal, "utf8")).toBe(after);
    expect(await fixture.credentials.load("oauth:zai:access_token")).toBe("newest-value");
    expect(fixture.runtime.registryService.validateSelection(selection).ok).toBe(true);
    expect(JSON.parse(await readFile(fixture.state, "utf8")).records).toHaveLength(3);
  });

  it("PRV-08 回滚自身失败时返回rollback_failed且不登记成功", async () => {
    const update = fixture.personalRepository.update.bind(fixture.personalRepository);
    vi.spyOn(fixture.personalRepository, "update")
      .mockImplementationOnce(async (mutate) => {
        const snapshot = await update(mutate);
        throw Object.assign(new Error("R3_AFTER_COMMIT"), { snapshot });
      })
      .mockRejectedValue(new Error("R3_ROLLBACK_DISK_FAILURE"));
    const result = await fixture.target.apply(envelope("rollback-failed", "new-value"));
    expect(result).toMatchObject({ status: "rollback_failed", rolledBack: false });
    expect(await readFile(fixture.state, "utf8")).not.toContain("rollback-failed");
  });
});

// R3A-PRV-05/06/07/10/11 与 PRV-02 的 Target 侧状态：同一真实 Store/Registry fixture。
function customEnvelope(
  syncId: string,
  input: {
    providerRules: readonly ReturnType<typeof providerEntry>[];
    models?: ModelConfigRules;
    defaultModelSelection?: typeof selection | undefined;
    credentials?: ProviderProvisioningEnvelope["credentials"];
    accountSettings?: ProviderProvisioningEnvelope["accountSettings"];
  },
): ProviderProvisioningEnvelope {
  const config = encodeProviderConfigFile({
    providers: parsePersonalProviderConfigMap({ providerRules: input.providerRules }),
    models: input.models ?? ModelConfigRules.empty(),
    providerOrder: input.providerRules.map((rule) => rule.providerId),
    ...(input.defaultModelSelection ? { defaultModelSelection: input.defaultModelSelection } : {}),
  });
  return {
    schemaVersion: 1,
    syncId,
    personalConfig: config.config,
    accountSettings: input.accountSettings ?? {
      providerFamilyDomain: "bigmodel",
      providerFamilyConnectionSelections: {},
    },
    credentials: input.credentials ?? [
      { scope: "oauth-session", key: "oauth:zai:access_token", value: "old-value" },
    ],
  };
}

function brokenProviderEntry(key: string) {
  return {
    providerId: "r3-broken",
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: key },
      api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:1/v1" },
      personalModelIds: ["broken-model"],
    },
  };
}

describe("R3A-PRV-05/06/07/10/11 完整替换、allowlist 凭据、窄设置与无效配置", () => {
  let root: string;
  let previousRoot: string;
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  beforeEach(async () => {
    previousRoot = getDataBaseDir();
    root = await mkdtemp(join(tmpdir(), "r3-provisioning-stores-b-"));
    fixture = await createFixture(root);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    fixture?.dispose();
    setDataBaseDir(previousRoot);
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("PRV-05 本地删除 provider 后完整替换：目标不保留被删镜像，空配置也真实写入", async () => {
    const result = await fixture.target.apply(
      customEnvelope("delete-provider", { providerRules: [], defaultModelSelection: undefined }),
    );
    expect(result).toMatchObject({ status: "applied", personalProviderCount: 0 });
    const snapshot = await fixture.runtime.configService.read();
    expect(snapshot.personalProviders.keys()).toHaveLength(0);
    expect(await fixture.defaults.read()).toBeUndefined();
    expect(await readFile(fixture.personal, "utf8")).not.toContain("r3-store");
    expect(fixture.runtime.registryService.validateSelection(selection).ok).toBe(false);
  });

  it("PRV-05 删除 provider 后完整替换并保留失效默认，空 Registry 不伪造推荐", async () => {
    const input = customEnvelope("delete-but-default", {
      providerRules: [],
      defaultModelSelection: selection,
    });
    const result = await fixture.target.apply(input);
    // 默认偏好已与同步成功解耦；旧断言遗漏该契约更新，错误要求恢复已删除的 Provider。
    expect(result).toMatchObject({
      status: "applied",
      rolledBack: false,
      personalProviderCount: 0,
    });
    expect(JSON.parse(await readFile(fixture.personal, "utf8")).config).toEqual(
      input.personalConfig,
    );
    expect((await fixture.runtime.configService.read()).personalProviders.keys()).toEqual([]);
    expect(await fixture.defaults.read()).toEqual(selection);
    expect(fixture.runtime.registryService.validateSelection(selection).ok).toBe(false);
    expect(
      resolveInitialModelSelection({
        configuredDefault: await fixture.defaults.read(),
        registry: fixture.runtime.registryService.getView(),
      }),
    ).toEqual({ source: "none" });
  });

  it("PRV-05 清除默认（default undefined）只清默认，provider 保留", async () => {
    const result = await fixture.target.apply(
      customEnvelope("clear-default", {
        providerRules: [providerEntry("old-value")],
        models: ModelConfigRules.empty().setExact("r3-store", "r3-model", completeModel()),
        defaultModelSelection: undefined,
      }),
    );
    expect(result.status).toBe("applied");
    expect(await fixture.defaults.read()).toBeUndefined();
    expect(fixture.runtime.registryService.validateSelection(selection).ok).toBe(true);
  });

  it("PRV-06 allowlist 凭据同名删除传播、新值经目标 cipher 重加密；非 allowlist 凭据不变", async () => {
    await fixture.credentials.save("mcp:oauth:r3:token", "mcp-not-allowlisted");
    const result = await fixture.target.apply(
      customEnvelope("cred-delete", {
        providerRules: [providerEntry("old-value")],
        models: ModelConfigRules.empty().setExact("r3-store", "r3-model", completeModel()),
        defaultModelSelection: selection,
        credentials: [],
      }),
    );
    expect(result).toMatchObject({ status: "applied", credentialCount: 0 });
    expect(await fixture.credentials.load("oauth:zai:access_token")).toBeNull();
    expect(await fixture.credentials.load("ssh:r3-sentinel")).toBe("not-provisioned");
    expect(await fixture.credentials.load("mcp:oauth:r3:token")).toBe("mcp-not-allowlisted");

    const restored = await fixture.target.apply(
      customEnvelope("cred-restore", {
        providerRules: [providerEntry("old-value")],
        models: ModelConfigRules.empty().setExact("r3-store", "r3-model", completeModel()),
        defaultModelSelection: selection,
        credentials: [
          { scope: "oauth-session", key: "oauth:zai:access_token", value: "re-encrypted" },
        ],
      }),
    );
    expect(restored.status).toBe("applied");
    expect(await fixture.credentials.load("oauth:zai:access_token")).toBe("re-encrypted");
    const raw = await readFile(join(fixture.dir, "credentials.json"), "utf8");
    expect(raw).not.toContain("re-encrypted");
    expect(raw).not.toContain("mcp-not-allowlisted");
  });

  it("PRV-07 只改约定的账号窄字段，locale 等其它设置与 Built-in 文件不变", async () => {
    await fixture.settings.update({ locale: "zh-CN", terminalInheritSystemProfile: false });
    const builtinBefore = await readFile(fixture.builtin, "utf8");
    const result = await fixture.target.apply(
      customEnvelope("narrow-settings", {
        providerRules: [providerEntry("old-value")],
        models: ModelConfigRules.empty().setExact("r3-store", "r3-model", completeModel()),
        defaultModelSelection: selection,
        accountSettings: {
          providerFamilyDomain: "zai",
          providerFamilyConnectionSelections: { zai: { kind: "individual-coding-plan" } },
        },
      }),
    );
    expect(result.status).toBe("applied");
    const settings = await fixture.settings.get();
    expect(settings).toMatchObject({
      locale: "zh-CN",
      terminalInheritSystemProfile: false,
      providerFamilyDomain: "zai",
      providerFamilyConnectionSelections: { zai: { kind: "individual-coding-plan" } },
    });
    expect(await readFile(fixture.builtin, "utf8")).toBe(builtinBefore);
  });

  it("PRV-11 合法 provider 可用、无效项 fail-closed；保留失效默认并推荐合法模型", async () => {
    // r3-broken 只有 enabled，缺 maxOutputTokens；空 Built-in 层下必须被 Registry 拒绝。
    const models = () =>
      ModelConfigRules.empty()
        .setExact("r3-store", "r3-model", completeModel())
        .setExact("r3-broken", "broken-model", new ModelConfig({ enabled: true }));
    const applied = await fixture.target.apply(
      customEnvelope("mixed-valid", {
        providerRules: [providerEntry("old-value"), brokenProviderEntry("old-value")],
        models: models(),
        defaultModelSelection: selection,
      }),
    );
    expect(applied).toMatchObject({ status: "applied", personalProviderCount: 2 });
    expect(fixture.runtime.registryService.validateSelection(selection).ok).toBe(true);
    expect(
      fixture.runtime.registryService.validateSelection({
        providerId: "r3-broken",
        modelId: "broken-model",
        options: { reasoningLevel: "disabled" },
      }).ok,
    ).toBe(false);
    const snapshot = await fixture.runtime.configService.read();
    expect(snapshot.personalProviders.keys()).toEqual(
      expect.arrayContaining(["r3-store", "r3-broken"]),
    );

    const invalidSelection = {
      providerId: "r3-broken",
      modelId: "broken-model",
      options: { reasoningLevel: "disabled" },
    };
    const input = customEnvelope("mixed-broken-default", {
      providerRules: [providerEntry("old-value"), brokenProviderEntry("old-value")],
      models: models(),
      defaultModelSelection: invalidSelection,
    });
    const brokenDefault = await fixture.target.apply(input);
    // 失效偏好需要原样复制，但不授予模型执行能力；推荐只由 Host 现有解析器产生。
    expect(brokenDefault).toMatchObject({
      status: "applied",
      rolledBack: false,
      personalProviderCount: 2,
    });
    expect(JSON.parse(await readFile(fixture.personal, "utf8")).config).toEqual(
      input.personalConfig,
    );
    expect(fixture.runtime.registryService.validateSelection(invalidSelection).ok).toBe(false);
    expect(fixture.runtime.registryService.validateSelection(selection).ok).toBe(true);
    expect(
      resolveInitialModelSelection({
        configuredDefault: await fixture.defaults.read(),
        registry: fixture.runtime.registryService.getView(),
      }),
    ).toEqual({ source: "registry-fallback", selection });
    expect(await fixture.defaults.read()).toEqual(invalidSelection);
    expect((await fixture.runtime.configService.read()).personalProviders.keys()).toEqual(
      expect.arrayContaining(["r3-store", "r3-broken"]),
    );
  });

  it("PRV-10 未知 schemaVersion / 损坏 provider 配置在任何写入前明确失败", async () => {
    const before = {
      personal: await readFile(fixture.personal, "utf8"),
      state: await readFile(fixture.state, "utf8"),
      settings: await fixture.settings.get(),
    };
    const unknownSchema = { ...envelope("unknown-schema", "x"), schemaVersion: 99 };
    await expect(
      fixture.target.apply(unknownSchema as unknown as ProviderProvisioningEnvelope),
    ).rejects.toThrow();
    const broken = envelope("broken-config", "x") as unknown as {
      personalConfig: { providerConfigRules: { providerRules: unknown[] } };
    };
    broken.personalConfig.providerConfigRules.providerRules = [
      { providerId: "r3-store", config: { group: "standard-personal", api: 42 } },
    ];
    await expect(
      fixture.target.apply(broken as unknown as ProviderProvisioningEnvelope),
    ).rejects.toThrow();
    expect(await readFile(fixture.personal, "utf8")).toBe(before.personal);
    expect(await readFile(fixture.state, "utf8")).toBe(before.state);
    expect(await fixture.settings.get()).toEqual(before.settings);
    expect(await fixture.credentials.load("oauth:zai:access_token")).toBe("old-value");
    expect(fixture.runtime.registryService.validateSelection(selection).ok).toBe(true);
  });

  it("PRV-02 Target 结果只会是 applied / already-applied / failed / rollback_failed 之一，失败不登记", async () => {
    vi.spyOn(fixture.account, "refresh").mockRejectedValueOnce(new Error("R3_FIRST_APPLY_FAULT"));
    const failed = await fixture.target.apply(envelope("first-apply-failed", "v2"));
    expect(failed).toMatchObject({ status: "failed", rolledBack: true });
    expect(await readFile(fixture.state, "utf8")).not.toContain("first-apply-failed");
    const retry = await fixture.target.apply(envelope("first-apply-failed", "v2"));
    expect(retry.status).toBe("applied");
  });
});
