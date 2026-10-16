import { describe, expect, it, vi } from "vitest";
import {
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderConfigMap,
  ProviderRegistryService,
  MutableAccountProviderConfigSource,
  type AccountProviderConfigSnapshot,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "../src/index.js";
import {
  createAccountProviderConfig,
  createApiKeyProviderConfig,
} from "./provider-config-fixtures.js";

class MutableSource<TSnapshot> implements ProviderSource<TSnapshot> {
  current: TSnapshot;
  nextRead: (() => Promise<TSnapshot>) | null = null;
  readonly read = vi.fn(async (): Promise<TSnapshot> => {
    const nextRead = this.nextRead;
    this.nextRead = null;
    return nextRead ? nextRead() : this.current;
  });
  readonly #listeners = new Set<(reason: string) => void>();

  constructor(initial: TSnapshot) {
    this.current = initial;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(reason: string): void {
    for (const listener of this.#listeners) listener(reason);
  }
}

function modelConfig(contextWindow = 200_000): ModelConfig {
  return new ModelConfig({
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: { values: ["disabled"], map: "{}" },
      maxOutputTokens: {
        max: 32_000,
        map: "{'max_tokens': maxOutputTokens}",
      },
    }),
    enabled: true,
  });
}

function configSnapshot(revision: string, modelId: string): ProviderConfigSnapshot {
  return {
    revision,
    zcodeBuiltinRevision: revision,
    personalRevision: "personal-1",
    zcodeBuiltinProviders: new ProviderConfigMap([
      [
        "local",
        createApiKeyProviderConfig({
          apiFormat: "anthropic-messages",
          baseURL: "https://api.example.com",
          apiKey: "test-key",
          models: [modelId],
        }),
      ],
    ]),
    personalProviders: ProviderConfigMap.empty(),
    zcodeBuiltinModelRules: new ModelConfigRules([
      { type: "model", modelMatch: modelId, config: modelConfig() },
    ]),
    personalModels: ModelConfigRules.empty(),
  };
}

function accountSnapshot(
  revision = "account-1",
  basedOnZCodeBuiltinRevision = "config-1",
): AccountProviderConfigSnapshot {
  return { revision, basedOnZCodeBuiltinRevision, providers: ProviderConfigMap.empty() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("ProviderRegistryService", () => {
  it("start 只返回就绪；Account 更新后显式读取当前快照，不重复启动刷新", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const accountSource = new MutableSource(accountSnapshot());
    const service = new ProviderRegistryService({ configSource, accountSource });
    try {
      expect(await service.start()).toBeUndefined();
      accountSource.current = accountSnapshot("account-2");
      await service.refresh("account-change");
      const reads = configSource.read.mock.calls.length;
      expect(await service.start()).toBeUndefined();
      expect(service.getSnapshot()?.sourceRevisions.account).toBe("account-2");
      expect(configSource.read).toHaveBeenCalledTimes(reads);
    } finally {
      service.dispose();
    }
  });
  it("Mutable Account Config Source 替换第三层 Overlay 后驱动 Registry 刷新", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const accountSource = new MutableAccountProviderConfigSource();
    accountSource.replace({
      revision: "account-1",
      basedOnZCodeBuiltinRevision: "config-1",
      providers: ProviderConfigMap.empty(),
    });
    const service = new ProviderRegistryService({ configSource, accountSource });
    await service.start();

    accountSource.replace(
      {
        revision: "account-2",
        basedOnZCodeBuiltinRevision: "config-1",
        providers: new ProviderConfigMap([
          [
            "account-provider",
            createAccountProviderConfig({
              models: ["model-a"],
            }),
          ],
        ]),
      },
      "workspace-registry",
    );

    await service.refresh("wait-for-account-source");
    await expect(accountSource.read()).resolves.toMatchObject({ revision: "account-2" });
  });

  it("通过注入的 Config 和 Account Source 初始化并发布完整快照", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const accountSource = new MutableSource(accountSnapshot());
    const service = new ProviderRegistryService({ configSource, accountSource });
    const listener = vi.fn();
    service.onDidChange(listener);

    await service.start();
    const snapshot = service.getSnapshot()!;

    expect(snapshot.sourceRevisions).toEqual({ config: "config-1", account: "account-1" });
    expect(service.listProviders()[0]?.models[0]?.modelId).toBe("model-a");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].reasons).toEqual(["start"]);
  });

  it("读取期间发生新失效时丢弃过时代际，只发布最新 Source", async () => {
    const configV1 = configSnapshot("config-1", "model-a");
    const configV2 = configSnapshot("config-2", "model-b");
    const firstRead = deferred<ProviderConfigSnapshot>();
    const configSource = new MutableSource(configV1);
    configSource.nextRead = () => firstRead.promise;
    const accountSource = new MutableSource(accountSnapshot("account-2", "config-2"));
    const service = new ProviderRegistryService({ configSource, accountSource });
    const listener = vi.fn();
    service.onDidChange(listener);

    const start = service.start();
    await vi.waitFor(() => expect(configSource.read).toHaveBeenCalledTimes(1));
    configSource.current = configV2;
    configSource.emit("config-file-changed");
    firstRead.resolve(configV1);
    await start;

    expect(configSource.read).toHaveBeenCalledTimes(2);
    expect(service.listProviders()[0]?.models[0]?.modelId).toBe("model-b");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].reasons).toEqual(
      expect.arrayContaining(["start", "config:config-file-changed"]),
    );
  });

  it("Source revision 未变化时不重复发布 Registry", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const accountSource = new MutableSource(accountSnapshot());
    const service = new ProviderRegistryService({ configSource, accountSource });
    const listener = vi.fn();
    service.onDidChange(listener);
    await service.start();
    const initial = service.getSnapshot()!;

    const duplicate = await service.refresh("explicit-refresh");

    expect(duplicate).toBe(initial);
    expect(service.getView().revision).toBe(initial.registry.revision);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("发布回调中请求的新刷新不会被即将结束的旧刷新吞掉", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const accountSource = new MutableSource(accountSnapshot());
    const service = new ProviderRegistryService({ configSource, accountSource });
    let followUp: Promise<unknown> | null = null;
    service.onDidChange(() => {
      if (followUp) return;
      configSource.current = configSnapshot("config-2", "model-b");
      accountSource.current = accountSnapshot("account-2", "config-2");
      followUp = service.refresh("listener-refresh");
    });

    await service.start();
    await followUp;

    expect(service.getSnapshot()?.sourceRevisions.config).toBe("config-2");
    expect(service.listProviders()[0]?.models[0]?.modelId).toBe("model-b");
  });

  it("刷新失败保留上一份成功 View，并允许后续刷新恢复", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const accountSource = new MutableSource(accountSnapshot());
    const service = new ProviderRegistryService({ configSource, accountSource });
    const errorListener = vi.fn();
    service.onDidRefreshError(errorListener);
    await service.start();
    const initial = service.getSnapshot()!;

    configSource.nextRead = async () => {
      throw new Error("config unavailable");
    };
    await expect(service.refresh("broken-config")).rejects.toThrow("config unavailable");

    expect(service.getSnapshot()).toBe(initial);
    expect(service.listProviders()[0]?.models[0]?.modelId).toBe("model-a");
    expect(errorListener).toHaveBeenCalledTimes(1);

    configSource.current = configSnapshot("config-2", "model-b");
    accountSource.current = accountSnapshot("account-2", "config-2");
    const recovered = await service.refresh("config-recovered");
    expect(recovered.sourceRevisions.config).toBe("config-2");
    expect(service.listProviders()[0]?.models[0]?.modelId).toBe("model-b");
  });

  it("Built-in 与 Account 来源 revision 不匹配时保留旧 Registry，匹配后只发布最终组合", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const accountSource = new MutableSource(accountSnapshot("account-1", "config-1"));
    const service = new ProviderRegistryService({ configSource, accountSource });
    const listener = vi.fn();
    service.onDidChange(listener);
    await service.start();
    const initial = service.getSnapshot()!;

    configSource.current = configSnapshot("config-2", "model-b");
    const held = service.refresh("builtin-updated");
    await expect(held).resolves.toBe(initial);

    expect(service.getSnapshot()).toBe(initial);
    expect(service.listProviders()[0]?.models[0]?.modelId).toBe("model-a");
    expect(listener).toHaveBeenCalledTimes(1);

    accountSource.current = accountSnapshot("account-2", "config-2");
    accountSource.emit("account-recomputed");
    await vi.waitFor(() => expect(service.listProviders()[0]?.models[0]?.modelId).toBe("model-b"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("Personal-only revision 变化不等待新的 Account Snapshot", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const accountSource = new MutableSource(accountSnapshot("account-1", "config-1"));
    const service = new ProviderRegistryService({ configSource, accountSource });
    await service.start();

    configSource.current = {
      ...configSnapshot("combined-2", "model-a"),
      zcodeBuiltinRevision: "config-1",
      personalRevision: "personal-2",
    };
    const next = await service.refresh("personal-updated");

    expect(next.config.personalRevision).toBe("personal-2");
    expect(next.account).toBeDefined();
  });
});
