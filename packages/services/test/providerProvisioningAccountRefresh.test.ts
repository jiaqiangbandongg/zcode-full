import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelConfigRules,
  ProviderConfigMap,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "@zcode/provider-node";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindAccountProviderInvalidation } from "../src/model-provider/accountProviderInvalidation.js";
import { createAccountProviderConfigSource } from "../src/model-provider/accountProviderConnectionResolver.js";
import { createProviderProvisioningTarget } from "../src/model-provider/providerProvisioningTarget.js";
import { createAccountProviderConfig } from "./providerConfigFixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class StaticConfigSource implements ProviderSource<ProviderConfigSnapshot> {
  async read(): Promise<ProviderConfigSnapshot> {
    return {
      revision: "config-1",
      zcodeBuiltinRevision: "builtin-1",
      personalRevision: "personal-1",
      zcodeBuiltinProviders: new ProviderConfigMap([
        [
          BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan,
          createAccountProviderConfig({
            accountType: "zai",
            mode: "individual-coding-plan",
            models: ["GLM-5.2"],
          }),
        ],
        [
          BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan,
          createAccountProviderConfig({
            accountType: "bigmodel",
            mode: "start-plan",
            models: ["GLM-5.3"],
          }),
        ],
      ]),
      personalProviders: ProviderConfigMap.empty(),
      zcodeBuiltinModelRules: ModelConfigRules.empty(),
      personalModels: ModelConfigRules.empty(),
    };
  }

  onDidChange(): () => void {
    return () => {};
  }
}

interface SettingUpdateEvent {
  readonly keys: string[];
}

/**
 * 把 Target 接到真实的 AccountProviderService、账号连接解析器和设置失效绑定上。
 * 远端 Setting/Credential 用内存实现并带落盘延迟，套餐查询用固定延迟代替网络。
 */
async function createRemoteTarget() {
  const directory = await mkdtemp(join(tmpdir(), "provider-provisioning-account-refresh-"));
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

  let settings: Record<string, unknown> = {
    providerFamilyDomain: "zai",
    providerFamilyConnectionSelections: {
      zai: { kind: "individual-coding-plan" },
      bigmodel: { kind: "start-plan" },
    },
  };
  const settingListeners = new Set<(event: SettingUpdateEvent) => void>();
  const settingDomainWrites: unknown[] = [];
  const settingService = {
    get: async () => settings,
    update: async (patch: Record<string, unknown>) => {
      await delay(2);
      settings = { ...settings, ...patch };
      settingDomainWrites.push(settings.providerFamilyDomain);
      for (const listener of settingListeners) listener({ keys: Object.keys(patch) });
    },
    onDidUpdate: (listener: (event: SettingUpdateEvent) => void) => {
      settingListeners.add(listener);
      return () => settingListeners.delete(listener);
    },
  };
  // 远端上一次同步留下的账号身份；本次同步会替换整个 allowlist，从而改变身份。
  const credentials = new Map<string, string>([
    ["oauth:active_provider", "zai"],
    ["oauth:zai:user_info", JSON.stringify({ id: "zai-user" })],
    ["zcodejwttoken", "jwt-old"],
  ]);
  // 评审 SG-01：竞态不再依赖真实调度（delay(40) vs delay(2) 的胜负在 Windows 与 Linux
  // 上不同）。gate 只拦"写入期间启动、已捕获旧身份"的第一轮 availability 查询——进入
  // 该调用即代表本轮 loadAccountIdentity 已完成捕获；用例在凭据切换完成后放行，让身份
  // 守卫确定性地丢弃过期轮。后续轮（apply 自己的刷新）直通。
  let availabilityGateArmed = false;
  let notifyAvailabilityCaptured: (() => void) | undefined;
  const availabilityCaptured = new Promise<void>((resolve) => {
    notifyAvailabilityCaptured = resolve;
  });
  let releaseAvailabilityGate: (() => void) | undefined;
  const availabilityReleased = new Promise<void>((resolve) => {
    releaseAvailabilityGate = resolve;
  });
  const credentialService = {
    load: async (key: string) => credentials.get(key) ?? null,
    save: async (key: string, value: string) => {
      await delay(2);
      credentials.set(key, value);
    },
    delete: async (key: string) => {
      await delay(2);
      credentials.delete(key);
    },
  };
  const accountSource = createAccountProviderConfigSource({
    configSource: new StaticConfigSource(),
    readSettings: async () =>
      ({
        providerFamilyDomain: settings.providerFamilyDomain ?? null,
        selections: settings.providerFamilyConnectionSelections ?? {},
      }) as never,
    loadCodingPlanApiKey: async () => null,
    loadAccountIdentity: async (family) => {
      const raw = credentials.get(`oauth:${family}:user_info`);
      return raw ? ((JSON.parse(raw) as { id?: string }).id ?? null) : null;
    },
    resolveFamilyAvailability: async ({ providers }) => {
      if (availabilityGateArmed) {
        availabilityGateArmed = false;
        notifyAvailabilityCaptured?.();
        await availabilityReleased;
      }
      return Object.fromEntries(
        providers.map((provider) => [
          provider.providerId,
          { kind: "available" as const, models: ["GLM-5.3"] },
        ]),
      );
    },
  });
  cleanups.push(async () => accountSource.dispose());
  const refreshErrors: string[][] = [];
  accountSource.onDidRefreshError((event) => refreshErrors.push([...event.reasons]));
  await accountSource.read();
  bindAccountProviderInvalidation({
    onDidUpdateSetting: (listener) => settingService.onDidUpdate(listener as never),
    refresh: (reason) => accountSource.refresh(reason),
  });

  const target = createProviderProvisioningTarget({
    providerRuntime: {
      start: async () => undefined,
      registryService: {
        refresh: async () => ({ sourceRevisions: { config: "target-revision" } }),
        validateSelection: () => ({ ok: true }),
      },
    } as never,
    personalRepository: personal,
    accountProviderSource: accountSource,
    credentialService,
    listProvisioningCredentialKeys: async () => [...credentials.keys()],
    settingService: settingService as never,
    personalConfigFilePath,
    stateFilePath: join(directory, "provisioning.json"),
  });
  return {
    target,
    accountSource,
    credentials,
    settingDomainWrites,
    refreshErrors,
    availabilityGate: {
      arm: () => {
        availabilityGateArmed = true;
      },
      captured: availabilityCaptured,
      release: () => {
        releaseAvailabilityGate?.();
      },
    },
  };
}

function createEnvelope() {
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
      providerFamilyDomain: "bigmodel",
      providerFamilyConnectionSelections: {
        zai: { kind: "individual-coding-plan" },
        bigmodel: { kind: "start-plan" },
      },
    },
    credentials: [
      { scope: "oauth-session", key: "oauth:active_provider", value: "bigmodel" },
      {
        scope: "oauth-session",
        key: "oauth:bigmodel:user_info",
        value: JSON.stringify({ id: "user-1" }),
      },
      { scope: "oauth-session", key: "zcodejwttoken", value: "jwt-1" },
    ],
  };
}

describe("Provider Provisioning Target 与真实账号刷新链路", () => {
  it("同步期间由自身写入触发的过期刷新失败不影响本次同步结果", async () => {
    const {
      target,
      accountSource,
      credentials,
      settingDomainWrites,
      refreshErrors,
      availabilityGate,
    } = await createRemoteTarget();

    availabilityGate.arm();
    const applyPromise = target.apply(createEnvelope() as never);
    // 写入 Settings 触发的失效刷新必须先于凭据切换捕获旧身份；gate 进入点即证明捕获完成。
    await availabilityGate.captured;
    // 等 apply 写完凭据、身份事实切换（zai 的 user_info 被删除——身份守卫比较的正是它），
    // 再放行过期轮。
    await vi.waitFor(() => {
      expect(credentials.has("oauth:zai:user_info")).toBe(false);
    });
    availabilityGate.release();
    await expect(applyPromise).resolves.toMatchObject({
      status: "applied",
      rolledBack: false,
    });
    // 写入期间开始的那一轮刷新捕获的是旧身份，被身份变化守卫丢弃属于预期，但不能成为本次同步的结果。
    // apply 等待的自身刷新在串行 refresh loop 中排在过期轮之后，因此此刻错误必然已上报。
    expect(refreshErrors).toEqual([
      ["settings:providerFamilyDomain,providerFamilyConnectionSelections"],
    ]);
    expect(settingDomainWrites).toEqual(["bigmodel"]);
    expect([...credentials.keys()].sort()).toEqual([
      "oauth:active_provider",
      "oauth:bigmodel:user_info",
      "zcodejwttoken",
    ]);
    const snapshot = await accountSource.read();
    expect(snapshot.states[BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan]).toMatchObject({
      availability: "available",
      entitled: true,
      current: true,
    });
  });
});
