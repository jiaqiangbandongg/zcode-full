import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelConfigRules, ProviderConfigMap } from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderProvisioningTarget as createLegacyTarget } from "./fixtures/provisioning-v1/target.js";
import { createProviderProvisioningSource } from "../src/model-provider/providerProvisioningSource.js";
import { createProviderProvisioningTarget } from "../src/model-provider/providerProvisioningTarget.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function createEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    syncId: "sync-1",
    personalConfig: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "custom",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "new-key" },
              api: { type: "openai-chat-completions", baseUrl: "https://example.com/v1" },
              personalModelIds: ["model-a"],
            },
          },
        ],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      providerOrder: ["custom"],
      defaultModelSelection: { providerId: "custom", modelId: "model-a" },
    },
    accountSettings: {
      providerFamilyDomain: "zai",
      providerFamilyConnectionSelections: { zai: { kind: "individual-coding-plan" } },
    },
    credentials: [{ scope: "oauth-session", key: "oauth:zai:access_token", value: "new-token" }],
    ...overrides,
  };
}

async function createTarget(
  overrides: {
    legacy?: boolean;
    refresh?: () => Promise<unknown>;
    initialCredentials?: Readonly<Record<string, string>>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "provider-provisioning-target-"));
  const personalConfigFilePath = join(directory, "provider_config.json");
  const personal = new NodePersonalProviderConfigRepository({
    filePath: personalConfigFilePath,
    pollingIntervalMs: false,
  });
  cleanups.push(async () => {
    personal.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  await personal.update(() => ({
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
    providerOrder: [],
    defaultModelSelection: { providerId: "old", modelId: "old-model" },
  }));
  const replacePersonalConfig = vi.spyOn(personal, "update");
  let currentSettings = {
    providerFamilyDomain: "bigmodel" as const,
    providerFamilyConnectionSelections: {},
  };
  const credentialValues = new Map<string, string | null>([
    ["oauth:zai:access_token", "old-token"],
    ...Object.entries(overrides.initialCredentials ?? {}),
  ]);
  const settingUpdate = vi.fn(async (patch: unknown) => {
    currentSettings = { ...currentSettings, ...(patch as Partial<typeof currentSettings>) };
  });
  const credentialSave = vi.fn(async (key: string, value: string) => {
    credentialValues.set(key, value);
  });
  const credentialService = {
    load: vi.fn(async (key: string) => credentialValues.get(key) ?? null),
    save: credentialSave,
    delete: vi.fn(async (key: string) => {
      credentialValues.set(key, null);
    }),
  };
  const target = (overrides.legacy ? createLegacyTarget : createProviderProvisioningTarget)({
    providerRuntime: {
      start: vi.fn(async () => undefined),
      registryService: {
        refresh: vi.fn(async () => {
          await overrides.refresh?.();
          return { sourceRevisions: { config: "target-revision" } };
        }),
        validateSelection: vi.fn(() => ({ ok: true })),
      },
    } as never,
    personalRepository: personal,
    accountProviderSource: { refresh: vi.fn(async () => undefined) } as never,
    credentialService,
    listProvisioningCredentialKeys: async () => [...credentialValues.keys()],
    settingService: { get: vi.fn(async () => currentSettings), update: settingUpdate } as never,
    personalConfigFilePath,
    stateFilePath: join(directory, "provisioning.json"),
  });
  return {
    target,
    personal,
    replacePersonalConfig,
    settingUpdate,
    credentialSave,
    credentialLoad: credentialService.load,
    credentialDelete: credentialService.delete,
    credentialValues,
    personalConfigFilePath,
    directory,
  };
}

describe("Provider Provisioning Target", () => {
  it.each(["write", "commit"])("%s 阶段失败保留安全错误码且回滚原数据", async (phase) => {
    const f = await createTarget();
    const before = await f.personal.read();
    if (phase === "write") f.settingUpdate.mockRejectedValueOnce(new Error("fixture write failed"));
    else await mkdir(join(f.directory, "provisioning.json"));
    expect(await f.target.apply(createEnvelope() as never)).toMatchObject({
      status: "failed",
      errorCode: phase === "write" ? "target-write-failed" : "target-commit-failed",
      rolledBack: true,
    });
    expect((await f.personal.read()).revision).toBe(before.revision);
    expect(f.credentialValues.get("oauth:zai:access_token")).toBe("old-token");
  });

  it.each([false, true])("新 Source → legacy Target=%s，不删除旧 Key", async (legacy) => {
    const key = "account-provider:zai:api-key";
    const f = await createTarget({ legacy, initialCredentials: { [key]: "old-key" } });
    const source = createProviderProvisioningSource({
      personalRepository: f.personal,
      settingService: { get: async () => ({ providerFamilyDomain: "zai" }) } as never,
      credentialFilePath: join(f.directory, "source-credentials.json"),
      personalConfigFilePath: f.personalConfigFilePath,
    });
    const envelope = await source.read("new-source");
    if (legacy) {
      await expect(f.target.apply(envelope)).rejects.toThrow();
      expect(f.settingUpdate).not.toHaveBeenCalled();
      expect(f.credentialSave).not.toHaveBeenCalled();
      expect(f.credentialDelete).not.toHaveBeenCalled();
      expect(f.replacePersonalConfig).not.toHaveBeenCalled();
      expect(f.credentialValues.get("oauth:zai:access_token")).toBe("old-token");
    } else {
      // 空配置无默认模型，避免测试 fake Registry 对未知默认的校验影响协议断言。
      delete envelope.personalConfig.defaultModelSelection;
      await expect(f.target.apply(envelope)).resolves.toMatchObject({ status: "applied" });
      expect(f.credentialValues.get("oauth:zai:access_token")).toBeNull();
    }
    expect(f.credentialValues.get(key)).toBe("old-key");
  });

  it("旧 Target fixture 保留基线的缺失 Key 删除行为，防止假阳性", async () => {
    const key = "account-provider:zai:api-key";
    const f = await createTarget({ legacy: true, initialCredentials: { [key]: "old-key" } });
    await expect(f.target.apply(createEnvelope())).resolves.toMatchObject({ status: "applied" });
    expect(f.credentialDelete).toHaveBeenCalledWith(key);
  });

  it.each([0, 3, 99])("未知 schemaVersion=%s 在任何写入前失败", async (schemaVersion) => {
    const f = await createTarget();
    await expect(f.target.apply(createEnvelope({ schemaVersion }))).rejects.toThrow();
    expect(f.settingUpdate).not.toHaveBeenCalled();
    expect(f.credentialSave).not.toHaveBeenCalled();
    expect(f.credentialDelete).not.toHaveBeenCalled();
  });

  it("v2 禁止传入历史账号 Key，v1 兼容不能扩散为新发送契约", async () => {
    const f = await createTarget();
    await expect(
      f.target.apply(
        createEnvelope({
          schemaVersion: 2,
          credentials: [
            { scope: "account-provider", key: "account-provider:zai:api-key", value: "legacy" },
          ],
        }),
      ),
    ).rejects.toThrow("Provisioning v2 only accepts OAuth credentials");
    expect(f.settingUpdate).not.toHaveBeenCalled();
    expect(f.credentialSave).not.toHaveBeenCalled();
  });

  it("writes all target stores, refreshes the registry and is idempotent", async () => {
    const { target, personal, replacePersonalConfig, settingUpdate, credentialSave } =
      await createTarget();

    await expect(target.apply(createEnvelope())).resolves.toMatchObject({
      status: "applied",
      syncId: "sync-1",
      personalProviderCount: 1,
      credentialCount: 1,
      configRevision: "target-revision",
      rolledBack: false,
    });
    expect(settingUpdate).toHaveBeenCalledOnce();
    expect(credentialSave).toHaveBeenCalledWith("oauth:zai:access_token", "new-token");
    expect(replacePersonalConfig).toHaveBeenCalledOnce();
    expect((await personal.read()).defaultModelSelection).toEqual({
      providerId: "custom",
      modelId: "model-a",
    });

    await expect(target.apply(createEnvelope())).resolves.toMatchObject({
      status: "already-applied",
      syncId: "sync-1",
    });
    expect(replacePersonalConfig).toHaveBeenCalledOnce();
  });

  it("keeps an idempotency history so an older retry cannot reapply stale data", async () => {
    const { target, replacePersonalConfig } = await createTarget();

    await expect(target.apply(createEnvelope({ syncId: "sync-a" }))).resolves.toMatchObject({
      status: "applied",
    });
    await expect(target.apply(createEnvelope({ syncId: "sync-b" }))).resolves.toMatchObject({
      status: "applied",
    });
    await expect(target.apply(createEnvelope({ syncId: "sync-a" }))).resolves.toMatchObject({
      status: "already-applied",
      syncId: "sync-a",
    });
    expect(replacePersonalConfig).toHaveBeenCalledTimes(2);
  });

  it("applies an empty Personal snapshot so local deletion clears the remote mirror", async () => {
    const { target, replacePersonalConfig } = await createTarget();
    await expect(
      target.apply(
        createEnvelope({
          syncId: "sync-empty-overlay",
          personalConfig: {
            providerConfigRules: { providerRules: [] },
            modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
            providerOrder: [],
          },
        }),
      ),
    ).resolves.toMatchObject({ status: "applied", personalProviderCount: 0 });
    expect(replacePersonalConfig).toHaveBeenCalledOnce();
    expect(
      (await replacePersonalConfig.mock.results[0]!.value).defaultModelSelection,
    ).toBeUndefined();
  });

  it("replaces allowlisted credentials and preserves credentials outside the allowlist", async () => {
    const { target, credentialDelete, credentialValues } = await createTarget({
      initialCredentials: {
        "oauth:bigmodel:access_token": "stale-token",
        "ssh:password": "keep-me",
      },
    });

    await expect(target.apply(createEnvelope())).resolves.toMatchObject({ status: "applied" });

    expect(credentialDelete).toHaveBeenCalledWith("oauth:bigmodel:access_token");
    expect(credentialValues.get("oauth:bigmodel:access_token")).toBeNull();
    expect(credentialValues.get("ssh:password")).toBe("keep-me");
  });

  it("同步 OAuth 时不读取或删除本地坏旧 Key，兼容忽略旧信封的 Key", async () => {
    const legacyKey = "account-provider:coding-plan:provider:account:user:api-key";
    const f = await createTarget({ initialCredentials: { [legacyKey]: "enc:v1:broken" } });
    f.credentialLoad.mockImplementation(async (key) => {
      if (key === legacyKey) throw new Error("legacy ciphertext corrupt");
      return f.credentialValues.get(key) ?? null;
    });
    const incoming = createEnvelope();
    await expect(
      f.target.apply(
        createEnvelope({
          credentials: [
            ...incoming.credentials,
            { scope: "account-provider", key: legacyKey, value: "old-source-key" },
          ],
        }),
      ),
    ).resolves.toMatchObject({ status: "applied", credentialCount: 1 });
    expect(f.credentialLoad).not.toHaveBeenCalledWith(legacyKey);
    expect(f.credentialValues.get(legacyKey)).toBe("enc:v1:broken");
    expect(f.credentialDelete).not.toHaveBeenCalledWith(legacyKey);
    expect(f.credentialSave).not.toHaveBeenCalledWith(legacyKey, expect.anything());
  });

  it("rolls back settings, credentials and config when a later write fails", async () => {
    const { target, replacePersonalConfig, settingUpdate, credentialSave } = await createTarget({
      refresh: vi
        .fn()
        .mockRejectedValueOnce(new Error("registry refresh failed"))
        .mockResolvedValue(undefined),
    });

    await expect(target.apply(createEnvelope({ syncId: "sync-rollback" }))).resolves.toMatchObject({
      status: "failed",
      rolledBack: true,
    });
    expect(settingUpdate).toHaveBeenCalledTimes(2);
    expect(credentialSave).toHaveBeenCalledWith("oauth:zai:access_token", "old-token");
    expect(replacePersonalConfig).toHaveBeenCalledTimes(2);
  });

  it("does not delete a credential changed concurrently when rollback starts", async () => {
    const { target, credentialSave, credentialDelete, credentialValues } = await createTarget({
      refresh: vi
        .fn()
        .mockRejectedValueOnce(new Error("registry refresh failed"))
        .mockResolvedValue(undefined),
    });
    credentialSave.mockImplementation(async (_key: string, value: string) => {
      if (value === "new-token") {
        credentialValues.set("oauth:zai:access_token", "concurrent-token");
      }
    });

    await expect(
      target.apply(createEnvelope({ syncId: "sync-concurrent" })),
    ).resolves.toMatchObject({
      status: "rollback_failed",
      rolledBack: false,
    });
    expect(credentialDelete).not.toHaveBeenCalledWith("oauth:zai:access_token");
    expect(credentialValues.get("oauth:zai:access_token")).toBe("concurrent-token");
  });

  it("rejects credential keys outside the provisioning allowlist before writes", async () => {
    const { target, settingUpdate } = await createTarget();

    await expect(
      target.apply(
        createEnvelope({
          syncId: "sync-invalid",
          credentials: [{ scope: "oauth-session", key: "ssh:password", value: "secret" }],
        }),
      ),
    ).rejects.toThrow("不允许同步");
    expect(settingUpdate).not.toHaveBeenCalled();
  });

  it("rejects account identity keys even when they share the account-provider namespace", async () => {
    const { target, settingUpdate } = await createTarget();

    await expect(
      target.apply(
        createEnvelope({
          syncId: "sync-identity",
          credentials: [
            { scope: "account-provider", key: "account-provider:custom:identity", value: "user-1" },
          ],
        }),
      ),
    ).rejects.toThrow("不允许同步");
    expect(settingUpdate).not.toHaveBeenCalled();
  });
});
