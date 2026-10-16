import { describe, expect, it, vi } from "vitest";
import {
  AccountProviderService,
  ModelConfigRules,
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  type AccountProviderResolver,
  type AccountProviderResolveInput,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "../src/index.js";
import {
  createAccountProviderConfig,
  createApiKeyProviderConfig,
} from "./provider-config-fixtures.js";

// 此组专测刷新编排，账号状态行为由 account-provider-resolution 测试覆盖。
function configOnlyResolver(
  resolve: (input: AccountProviderResolveInput) => Promise<ProviderConfigMap>,
): AccountProviderResolver {
  return async (input) => ({ providers: await resolve(input), states: {} });
}

class MutableConfigSource implements ProviderSource<ProviderConfigSnapshot> {
  readonly #listeners = new Set<(reason: string) => void>();

  constructor(public snapshot: ProviderConfigSnapshot) {}

  async read(): Promise<ProviderConfigSnapshot> {
    return this.snapshot;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(reason: string): void {
    for (const listener of this.#listeners) listener(reason);
  }
}

function configSnapshot(
  revision: string,
  accountModels: readonly string[],
): ProviderConfigSnapshot {
  return {
    revision,
    zcodeBuiltinRevision: revision,
    personalRevision: "personal-1",
    zcodeBuiltinProviders: new ProviderConfigMap([
      [
        "account-plan",
        createAccountProviderConfig({
          apiFormat: "anthropic-messages",
          baseURL: "https://plan.example.com",
          models: accountModels,
        }),
      ],
      [
        "api-provider",
        createApiKeyProviderConfig({
          apiFormat: "anthropic-messages",
          baseURL: "https://api.example.com",
          apiKey: "secret",
          models: ["api-model"],
        }),
      ],
    ]),
    personalProviders: ProviderConfigMap.empty(),
    zcodeBuiltinModelRules: ModelConfigRules.empty(),
    personalModels: ModelConfigRules.empty(),
  };
}

describe("AccountProviderService", () => {
  it("重建期间 Built-in/凭据变化，旧结果不发布，重算当前快照", async () => {
    const configSource = new MutableConfigSource(configSnapshot("config-1", ["model-a"]));
    let release!: () => void;
    const resolve = vi.fn(async () => ({ providers: ProviderConfigMap.empty(), states: {} }));
    const service = new AccountProviderService({ configSource, resolve });
    await service.read();
    const published: string[] = [];
    service.onDidChange(() => {
      void service.read().then((snapshot) => published.push(snapshot.basedOnZCodeBuiltinRevision));
    });
    resolve.mockImplementationOnce(async () => {
      await new Promise<void>((done) => {
        release = done;
      });
      return { providers: ProviderConfigMap.empty(), states: {} };
    });
    configSource.snapshot = configSnapshot("config-2", ["model-b"]);
    const pending = service.refresh("credential-change");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    configSource.snapshot = configSnapshot("config-3", ["model-c"]);
    configSource.emit("builtin-update");
    release();
    await pending;
    expect((await service.read()).basedOnZCodeBuiltinRevision).toBe("config-3");
    expect(published).toEqual(["config-3"]);
    service.dispose();
  });
  it("只从 ZCode Built-in Provider Config 解析 Account Provider Config", async () => {
    const configSource = new MutableConfigSource(configSnapshot("config-1", ["model-a"]));
    const resolve = vi.fn(async ({ configuredProviders, reasons }) => {
      expect(reasons).toEqual(["start"]);
      expect(configuredProviders.get("api-provider")?.access?.type).toBe("api-key");
      return new ProviderConfigMap([
        [
          "account-plan",
          new ProviderConfig({
            access: new ZhipuAccountAccessConfig({ entitled: true }),
          }),
        ],
      ]);
    });
    const service = new AccountProviderService({
      configSource,
      resolve: configOnlyResolver(resolve),
    });
    const changed = vi.fn();
    service.onDidChange(changed);

    const snapshot = await service.read();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(changed).not.toHaveBeenCalled();
    expect(
      Object.fromEntries(snapshot.providers.entries().map(([id, config]) => [id, config.toJSON()])),
    ).toEqual({
      "account-plan": {
        access: { type: "zhipu-account", entitled: true },
      },
    });
    expect(snapshot.basedOnZCodeBuiltinRevision).toBe("config-1");
    service.dispose();
  });

  it("不把 Personal Provider Config 交给账号解析器", async () => {
    const snapshot = configSnapshot("config-1", ["builtin-model"]);
    const configSource = new MutableConfigSource({
      ...snapshot,
      personalProviders: new ProviderConfigMap([
        ["account-plan", createAccountProviderConfig({ models: ["personal-model"] })],
        [
          "personal-only",
          createApiKeyProviderConfig({
            apiFormat: "anthropic-messages",
            baseURL: "https://personal.example.com",
            apiKey: "personal-secret",
            models: ["personal-model"],
          }),
        ],
      ]),
    });
    const resolve = vi.fn(async ({ configuredProviders }) => {
      expect(configuredProviders.keys()).toEqual(["account-plan", "api-provider"]);
      expect(configuredProviders.get("account-plan")?.builtinModelIds).toEqual(["builtin-model"]);
      return new ProviderConfigMap([
        [
          "account-plan",
          createAccountProviderConfig({
            group: null,
            models: configuredProviders.get("account-plan")?.builtinModelIds,
          }),
        ],
      ]);
    });
    const service = new AccountProviderService({
      configSource,
      resolve: configOnlyResolver(resolve),
    });

    await service.read();

    expect(resolve).toHaveBeenCalledOnce();
    service.dispose();
  });

  it("Config 变化后刷新 Account Snapshot 并通知 Registry", async () => {
    const configSource = new MutableConfigSource(configSnapshot("config-1", ["model-a"]));
    const service = new AccountProviderService({
      configSource,
      resolve: configOnlyResolver(
        async ({ configuredProviders }) =>
          new ProviderConfigMap([
            [
              "account-plan",
              createAccountProviderConfig({
                models: configuredProviders.get("account-plan")?.builtinModelIds,
              }),
            ],
          ]),
      ),
    });
    await service.read();
    const changed = vi.fn();
    service.onDidChange(changed);

    configSource.snapshot = configSnapshot("config-2", ["model-b"]);
    configSource.emit("personal-saved");

    await vi.waitFor(async () => {
      await expect(service.read()).resolves.toMatchObject({
        providers: expect.any(ProviderConfigMap),
      });
      expect(
        Object.fromEntries(
          (await service.read()).providers.entries().map(([id, config]) => [id, config.toJSON()]),
        ),
      ).toMatchObject({
        "account-plan": { builtinModelIds: ["model-b"] },
      });
    });
    expect(changed).toHaveBeenCalledWith("config:personal-saved");
    expect((await service.read()).basedOnZCodeBuiltinRevision).toBe("config-2");
    service.dispose();
  });

  it("Built-in revision 变化时即使 Overlay 内容相同也发布新来源快照", async () => {
    const configSource = new MutableConfigSource(configSnapshot("builtin-1", ["model-a"]));
    const service = new AccountProviderService({
      configSource,
      resolve: configOnlyResolver(
        async () =>
          new ProviderConfigMap([
            [
              "account-plan",
              createAccountProviderConfig({
                models: ["model-a"],
              }),
            ],
          ]),
      ),
    });
    const initial = await service.read();
    const changed = vi.fn();
    service.onDidChange(changed);

    configSource.snapshot = configSnapshot("builtin-2", ["model-a"]);
    configSource.emit("remote-updated");

    await vi.waitFor(async () =>
      expect((await service.read()).basedOnZCodeBuiltinRevision).toBe("builtin-2"),
    );
    expect((await service.read()).revision).not.toBe(initial.revision);
    expect(changed).toHaveBeenCalledOnce();
    service.dispose();
  });

  it("刷新失败时保留上一份成功的 Account Snapshot", async () => {
    const configSource = new MutableConfigSource(configSnapshot("config-1", ["model-a"]));
    let shouldFail = false;
    const service = new AccountProviderService({
      configSource,
      resolve: configOnlyResolver(async () => {
        if (shouldFail) throw new Error("account service unavailable");
        return new ProviderConfigMap([
          [
            "account-plan",
            createAccountProviderConfig({
              models: ["model-a"],
            }),
          ],
        ]);
      }),
    });
    const initial = await service.read();
    const refreshError = vi.fn();
    service.onDidRefreshError(refreshError);
    shouldFail = true;

    await expect(service.refresh("account-changed")).rejects.toThrow("account service unavailable");

    await expect(service.read()).resolves.toBe(initial);
    expect(refreshError).toHaveBeenCalledWith(
      expect.objectContaining({ reasons: ["account-changed"] }),
    );
    service.dispose();
  });

  it("当前刷新失败后继续处理执行期间到达的刷新事件", async () => {
    const configSource = new MutableConfigSource(configSnapshot("config-1", ["model-a"]));
    let releaseFailedRefresh!: () => void;
    const failedRefreshBlocked = new Promise<void>((resolve) => {
      releaseFailedRefresh = resolve;
    });
    let attempt = 0;
    const resolve = vi.fn(async ({ configuredProviders }) => {
      attempt += 1;
      if (attempt === 2) {
        await failedRefreshBlocked;
        throw new Error("account service unavailable");
      }
      return new ProviderConfigMap([
        [
          "account-plan",
          createAccountProviderConfig({
            models: configuredProviders.get("account-plan")?.builtinModelIds,
          }),
        ],
      ]);
    });
    const service = new AccountProviderService({
      configSource,
      resolve: configOnlyResolver(resolve),
    });
    await service.read();

    const failed = service.refresh("manual-a");
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    configSource.snapshot = configSnapshot("config-2", ["model-b"]);
    configSource.emit("personal-saved-b");
    releaseFailedRefresh();

    await expect(failed).rejects.toThrow("account service unavailable");
    await vi.waitFor(async () => {
      expect(resolve).toHaveBeenCalledTimes(3);
      expect(
        Object.fromEntries(
          (await service.read()).providers.entries().map(([id, config]) => [id, config.toJSON()]),
        ),
      ).toMatchObject({
        "account-plan": { builtinModelIds: ["model-b"] },
      });
    });
    expect(resolve.mock.calls[2]?.[0].reasons).toEqual(["config:personal-saved-b"]);
    service.dispose();
  });

  it("首次解析失败时发布与 Built-in 对齐的 fail-closed Account Overlay", async () => {
    const initial = configSnapshot("config-1", ["model-a"]);
    const offPeakProviderId = "account:zai-offpeak-idle-plan";
    const configSource = new MutableConfigSource({
      ...initial,
      zcodeBuiltinProviders: initial.zcodeBuiltinProviders.set(
        offPeakProviderId,
        new ProviderConfig({
          group: "zai-family",
          access: new ZhipuAccountAccessConfig({ accountType: "zai", mode: "off-peak" }),
          builtinModelIds: ["model-a"],
          visibility: "hidden",
        }),
      ),
    });
    const service = new AccountProviderService({
      configSource,
      resolve: configOnlyResolver(async () => {
        throw new Error("account service unavailable");
      }),
    });

    const refreshError = vi.fn();
    service.onDidRefreshError(refreshError);

    await expect(service.read()).resolves.toMatchObject({
      basedOnZCodeBuiltinRevision: "config-1",
      providers: expect.any(ProviderConfigMap),
    });
    expect((await service.read()).providers.get("account-plan")?.access).toMatchObject({
      type: "zhipu-account",
      entitled: false,
    });
    expect((await service.read()).providers.get(offPeakProviderId)?.access).toMatchObject({
      type: "zhipu-account",
      entitled: false,
    });
    expect((await service.read()).providers.has("api-provider")).toBe(false);
    expect(refreshError).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error), reasons: ["start"] }),
    );
    service.dispose();
  });

  it("允许 Account Source 为执行期鉴权的 Built-in Provider 发布 entitlement Overlay", async () => {
    const initial = configSnapshot("config-1", ["model-a"]);
    const offPeakProviderId = "account:zai-offpeak-idle-plan";
    const configSource = new MutableConfigSource({
      ...initial,
      zcodeBuiltinProviders: initial.zcodeBuiltinProviders.set(
        offPeakProviderId,
        new ProviderConfig({
          group: "zai-family",
          access: new ZhipuAccountAccessConfig({ accountType: "zai", mode: "off-peak" }),
          builtinModelIds: ["model-a"],
          visibility: "hidden",
        }),
      ),
    });
    const service = new AccountProviderService({
      configSource,
      resolve: configOnlyResolver(
        async () =>
          new ProviderConfigMap([
            [
              offPeakProviderId,
              new ProviderConfig({
                access: new ZhipuAccountAccessConfig({ entitled: true }),
              }),
            ],
          ]),
      ),
    });

    await expect(service.read()).resolves.toMatchObject({
      providers: expect.any(ProviderConfigMap),
    });
    expect(
      Object.fromEntries(
        (await service.read()).providers.entries().map(([id, config]) => [id, config.toJSON()]),
      ),
    ).toEqual({
      [offPeakProviderId]: { access: { type: "zhipu-account", entitled: true } },
    });
    service.dispose();
  });

  it("刷新进行中发起的 refresh 等待本次请求之后开始的一轮，不复用进行中轮的结果", async () => {
    const configSource = new MutableConfigSource(configSnapshot("config-1", ["model-a"]));
    let releaseStaleRefresh!: () => void;
    const staleRefreshBlocked = new Promise<void>((resolve) => {
      releaseStaleRefresh = resolve;
    });
    let attempt = 0;
    const resolve = vi.fn(async ({ configuredProviders }: AccountProviderResolveInput) => {
      attempt += 1;
      if (attempt === 2) {
        // 模拟进行中的一轮在收尾校验时发现账号身份被后来的写入改变而丢弃结果。
        await staleRefreshBlocked;
        throw new Error("账号查询期间连接或身份发生变化，丢弃过期结果");
      }
      return new ProviderConfigMap([
        [
          "account-plan",
          createAccountProviderConfig({
            models: configuredProviders.get("account-plan")?.builtinModelIds,
          }),
        ],
      ]);
    });
    const service = new AccountProviderService({
      configSource,
      resolve: configOnlyResolver(resolve),
    });
    await service.read();

    const stale = service.refresh("settings:providerFamilyDomain");
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
    // 调用方在进行中轮开始之后才完成自己的写入并请求刷新，它需要的是覆盖这些写入的新一轮。
    const requested = service.refresh("provider-provisioning");
    releaseStaleRefresh();

    await expect(stale).rejects.toThrow("账号查询期间连接或身份发生变化");
    await expect(requested).resolves.toMatchObject({
      providers: expect.any(ProviderConfigMap),
    });
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(resolve.mock.calls[2]?.[0].reasons).toEqual(["provider-provisioning"]);
    service.dispose();
  });
});
