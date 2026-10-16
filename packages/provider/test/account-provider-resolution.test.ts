import { describe, expect, it } from "vitest";
import {
  createAccountProviderConfigResolver,
  ApiKeyAccessConfig,
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  resolveAccountProviderConfigs,
} from "../src/index.js";
import {
  createAccountProviderConfig,
  createApiKeyProviderConfig,
} from "./provider-config-fixtures.js";

function configuredProviders(): ProviderConfigMap {
  return new ProviderConfigMap([
    [
      "start-plan",
      createAccountProviderConfig({
        apiFormat: "anthropic-messages",
        baseURL: "https://start.example.com",
        models: ["model-a", "model-b"],
        mode: "start-plan",
      }),
    ],
    [
      "coding-plan",
      createAccountProviderConfig({
        apiFormat: "anthropic-messages",
        baseURL: "https://coding.example.com",
        models: ["model-a", "model-c"],
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
  ]);
}

describe("resolveAccountProviderConfigs", () => {
  it("连接身份只留在运行态，不投影进 Provider Config", async () => {
    const resolve = createAccountProviderConfigResolver(async () => [
      {
        providerId: "start-plan",
        status: "available",
        current: true,
        connectionKey: "opaque-scope",
      },
    ]);
    const result = await resolve({
      configRevision: "config",
      configuredProviders: configuredProviders(),
      previousProviders: new ProviderConfigMap(),
    });
    expect(result.states["start-plan"]?.connectionKey).toBe("opaque-scope");
    expect(JSON.stringify(result.providers.get("start-plan"))).not.toContain("opaque-scope");
  });
  it("账号或 Team 身份已变更时 unknown 不得借用旧权益与展示事实", async () => {
    const resolve = createAccountProviderConfigResolver(async () => [
      {
        providerId: "start-plan",
        status: "unknown",
        current: true,
        resetPrevious: true,
      },
    ]);
    const result = await resolve({
      configRevision: "config",
      configuredProviders: configuredProviders(),
      previousProviders: new ProviderConfigMap([
        [
          "start-plan",
          new ProviderConfig({
            access: new ZhipuAccountAccessConfig({ entitled: true }),
            builtinModelIds: ["old"],
          }),
        ],
      ]),
      previousStates: { "start-plan": { availability: "available", entitled: true } },
    });
    expect(result.providers.get("start-plan")?.access?.entitled).toBe(false);
    expect(result.states["start-plan"]).toEqual({
      availability: "unknown",
      entitled: false,
      current: true,
    });
  });
  it("状态与 Overlay 同轮返回，unknown 保留权益但不能恢复旧 current", async () => {
    const resolve = createAccountProviderConfigResolver(async () => [
      {
        providerId: "start-plan",
        status: "pending",
        current: false,
        models: [],
        effectiveAt: 2000,
      },
      { providerId: "coding-plan", status: "unknown", current: false },
    ]);
    const result = await resolve({
      configRevision: "config",
      configuredProviders: configuredProviders(),
      previousProviders: new ProviderConfigMap([
        [
          "coding-plan",
          new ProviderConfig({ access: new ZhipuAccountAccessConfig({ entitled: true }) }),
        ],
      ]),
      previousStates: {
        "coding-plan": { availability: "available", entitled: true, current: true },
      },
    });
    expect(result.states).toEqual({
      "start-plan": { availability: "pending", current: false, entitled: false, effectiveAt: 2000 },
      "coding-plan": { availability: "available", current: false, entitled: true },
    });
  });
  it("已生效但模型为空时保留权益并清空旧白名单；pending 不借用旧权益", () => {
    const previousProviders = new ProviderConfigMap([
      [
        "start-plan",
        new ProviderConfig({
          access: new ZhipuAccountAccessConfig({ entitled: true }),
          builtinModelIds: ["old-model"],
        }),
      ],
    ]);
    const resolve = (status: "available" | "pending") =>
      resolveAccountProviderConfigs({
        configuredProviders: configuredProviders(),
        previousProviders,
        connections: [{ providerId: "start-plan", status, models: [], effectiveAt: 2000 }],
      })
        .get("start-plan")
        ?.toJSON();
    expect(resolve("available")).toEqual({
      access: { type: "zhipu-account", entitled: true },
      builtinModelIds: [],
    });
    expect(resolve("pending")).toEqual({
      access: { type: "zhipu-account", entitled: false },
      builtinModelIds: [],
    });
  });
  it("把 Connection Resolver 接到 AccountProviderService 的 Config Resolver", async () => {
    expect(configuredProviders().get("coding-plan")?.builtinModelIds).toEqual([
      "model-a",
      "model-c",
    ]);
    const resolve = createAccountProviderConfigResolver(async () => [
      {
        providerId: "coding-plan",
        status: "available",
      },
      { providerId: "start-plan", status: "unavailable" },
    ]);

    const result = await resolve({
      configRevision: "config-1",
      configuredProviders: configuredProviders(),
      previousProviders: ProviderConfigMap.empty(),
    });

    expect(
      Object.fromEntries(result.providers.entries().map(([id, config]) => [id, config.toJSON()])),
    ).toEqual({
      "coding-plan": {
        access: { type: "zhipu-account", entitled: true },
      },
      "start-plan": { access: { type: "zhipu-account", entitled: false } },
    });
  });

  it("available 连接只生成 entitlement/models Overlay，并沿用 Config 模型顺序", () => {
    const result = resolveAccountProviderConfigs({
      configuredProviders: configuredProviders(),
      previousProviders: ProviderConfigMap.empty(),
      connections: [
        {
          providerId: "start-plan",
          status: "available",
          models: ["model-b"],
        },
        {
          providerId: "coding-plan",
          status: "available",
        },
      ],
    });

    expect(
      Object.fromEntries(result.entries().map(([id, config]) => [id, config.toJSON()])),
    ).toEqual({
      "start-plan": {
        access: { type: "zhipu-account", entitled: true },
        builtinModelIds: ["model-b"],
      },
      "coding-plan": {
        access: { type: "zhipu-account", entitled: true },
      },
    });
  });

  it("available 只设置 Account Access entitlement，不复制 Provider 静态事实", () => {
    const result = resolveAccountProviderConfigs({
      configuredProviders: new ProviderConfigMap([
        [
          "coding-plan",
          createAccountProviderConfig({
            models: ["model-a"],
          }),
        ],
      ]),
      previousProviders: ProviderConfigMap.empty(),
      connections: [
        {
          providerId: "coding-plan",
          status: "available",
        },
      ],
    });

    expect(
      Object.fromEntries(result.entries().map(([id, config]) => [id, config.toJSON()])),
    ).toEqual({
      "coding-plan": {
        access: { type: "zhipu-account", entitled: true },
      },
    });
  });

  it("unknown 保留该 Provider 上次成功结果，unavailable 显式取消权益", () => {
    const previousProviders = new ProviderConfigMap([
      [
        "start-plan",
        new ProviderConfig({
          access: new ZhipuAccountAccessConfig({ entitled: true }),
          builtinModelIds: ["model-a"],
        }),
      ],
      [
        "coding-plan",
        new ProviderConfig({ access: new ZhipuAccountAccessConfig({ entitled: true }) }),
      ],
    ]);

    const result = resolveAccountProviderConfigs({
      configuredProviders: configuredProviders(),
      previousProviders,
      connections: [
        { providerId: "start-plan", status: "unknown" },
        { providerId: "coding-plan", status: "unavailable" },
      ],
    });

    expect(
      Object.fromEntries(result.entries().map(([id, config]) => [id, config.toJSON()])),
    ).toEqual({
      "start-plan": {
        access: { type: "zhipu-account", entitled: true },
        builtinModelIds: ["model-a"],
      },
      "coding-plan": { access: { type: "zhipu-account", entitled: false } },
    });
  });

  it("首次 unknown 时以 entitled=false fail-closed", () => {
    expect(
      Object.fromEntries(
        resolveAccountProviderConfigs({
          configuredProviders: configuredProviders(),
          previousProviders: ProviderConfigMap.empty(),
          connections: [],
        })
          .entries()
          .map(([id, config]) => [id, config.toJSON()]),
      ),
    ).toEqual({
      "start-plan": { access: { type: "zhipu-account", entitled: false } },
      "coding-plan": { access: { type: "zhipu-account", entitled: false } },
    });
  });

  it("Start Plan 的明确空白名单同时适用于首次与刷新，不能恢复旧模型", () => {
    const connection = {
      providerId: "start-plan",
      status: "available" as const,
      models: [],
    };
    const previous = new ProviderConfigMap([
      [
        "start-plan",
        new ProviderConfig({
          access: new ZhipuAccountAccessConfig({ entitled: true }),
          builtinModelIds: ["model-a"],
        }),
      ],
    ]);

    expect(
      resolveAccountProviderConfigs({
        configuredProviders: configuredProviders(),
        previousProviders: previous,
        connections: [connection, { providerId: "coding-plan", status: "unavailable" }],
      })
        .get("start-plan")
        ?.toJSON(),
    ).toEqual({ access: { type: "zhipu-account", entitled: true }, builtinModelIds: [] });
    expect(
      Object.fromEntries(
        resolveAccountProviderConfigs({
          configuredProviders: configuredProviders(),
          previousProviders: ProviderConfigMap.empty(),
          connections: [connection, { providerId: "coding-plan", status: "unavailable" }],
        })
          .entries()
          .map(([id, config]) => [id, config.toJSON()]),
      ),
    ).toEqual({
      "start-plan": { access: { type: "zhipu-account", entitled: true }, builtinModelIds: [] },
      "coding-plan": { access: { type: "zhipu-account", entitled: false } },
    });
  });

  it("拒绝连接结果引用未配置或非 Account Provider", () => {
    expect(() =>
      resolveAccountProviderConfigs({
        configuredProviders: configuredProviders(),
        previousProviders: ProviderConfigMap.empty(),
        connections: [
          {
            providerId: "api-provider",
            status: "available",
          },
        ],
      }),
    ).toThrow("Account 连接指向非 Account Provider: api-provider");
  });

  it("普通 api-key Provider 不属于 Account Overlay", () => {
    const configured = new ProviderConfigMap([
      [
        "generic-api",
        new ProviderConfig({
          access: new ApiKeyAccessConfig({ apiKey: "secret" }),
        }),
      ],
    ]);

    expect(
      Object.fromEntries(
        resolveAccountProviderConfigs({
          configuredProviders: configured,
          previousProviders: ProviderConfigMap.empty(),
          connections: [],
        })
          .entries()
          .map(([id, config]) => [id, config.toJSON()]),
      ),
    ).toEqual({});
    expect(() =>
      resolveAccountProviderConfigs({
        configuredProviders: configured,
        previousProviders: ProviderConfigMap.empty(),
        connections: [{ providerId: "generic-api", status: "available" }],
      }),
    ).toThrow("Account 连接指向非 Account Provider: generic-api");
  });
});
