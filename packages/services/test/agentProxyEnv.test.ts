import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOfficialMcpTrustedOriginRegistry,
  resolveRuntimeZCodeEndpointOrigin,
} from "@zcode/shared";
import {
  buildAgentCaCertEnv,
  buildAgentEndpointOriginEnv,
  buildAgentNoProxyEnv,
  buildAgentProxyEnv,
  buildAgentRuntimeEnv,
  buildAgentWorkspaceIdentityEnv,
} from "../src/runtime-tools/agentProxyEnv.js";

describe("buildAgentProxyEnv", () => {
  it("returns an empty patch when no proxy is configured", () => {
    expect(buildAgentProxyEnv(undefined)).toEqual({});
    expect(buildAgentProxyEnv("")).toEqual({});
    expect(buildAgentProxyEnv("   ")).toEqual({});
  });

  it("sets the standard uppercase proxy keys plus ZCODE_HTTP_PROXY", () => {
    expect(buildAgentProxyEnv("http://127.0.0.1:7890")).toEqual({
      HTTP_PROXY: "http://127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      ALL_PROXY: "http://127.0.0.1:7890",
      ZCODE_HTTP_PROXY: "http://127.0.0.1:7890",
    });
  });

  it("prepends http:// to a bare host:port", () => {
    expect(buildAgentProxyEnv("127.0.0.1:7890").HTTP_PROXY).toBe("http://127.0.0.1:7890");
  });

  it("preserves an explicit scheme such as socks5", () => {
    expect(buildAgentProxyEnv("socks5://127.0.0.1:1080").ALL_PROXY).toBe("socks5://127.0.0.1:1080");
  });
});

describe("buildAgentCaCertEnv", () => {
  it("returns an empty patch without a cert path", () => {
    expect(buildAgentCaCertEnv(undefined)).toEqual({});
    expect(buildAgentCaCertEnv("  ")).toEqual({});
  });

  it("sets NODE_EXTRA_CA_CERTS and ZCODE_AGENT_CA_CERT to the cert path", () => {
    expect(buildAgentCaCertEnv("/tmp/zcode-network-ca.pem")).toEqual({
      NODE_EXTRA_CA_CERTS: "/tmp/zcode-network-ca.pem",
      ZCODE_AGENT_CA_CERT: "/tmp/zcode-network-ca.pem",
    });
  });
});

describe("buildAgentNoProxyEnv", () => {
  it("returns an empty patch without bypass rules", () => {
    expect(buildAgentNoProxyEnv(undefined)).toEqual({});
    expect(buildAgentNoProxyEnv("  ")).toEqual({});
  });

  it("sets standard no-proxy keys plus ZCODE_NO_PROXY", () => {
    expect(buildAgentNoProxyEnv(" localhost, 127.0.0.1 ,.example.com ")).toEqual({
      NO_PROXY: "localhost,127.0.0.1,.example.com",
      no_proxy: "localhost,127.0.0.1,.example.com",
      ZCODE_NO_PROXY: "localhost,127.0.0.1,.example.com",
    });
  });
});

describe("buildAgentRuntimeEnv", () => {
  it("merges proxy, no-proxy and the configured CA cert", () => {
    expect(
      buildAgentRuntimeEnv({
        httpProxy: "http://127.0.0.1:7890",
        noProxy: "localhost,127.0.0.1",
        caCertPath: "/tmp/root-ca.pem",
      }),
    ).toEqual({
      HTTP_PROXY: "http://127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      ALL_PROXY: "http://127.0.0.1:7890",
      ZCODE_HTTP_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
      ZCODE_NO_PROXY: "localhost,127.0.0.1",
      NODE_EXTRA_CA_CERTS: "/tmp/root-ca.pem",
      ZCODE_AGENT_CA_CERT: "/tmp/root-ca.pem",
    });
  });

  it("injects no CA when the setting is empty, even if proxy is configured", () => {
    expect(buildAgentRuntimeEnv({ httpProxy: "http://127.0.0.1:7890" })).toEqual({
      HTTP_PROXY: "http://127.0.0.1:7890",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      ALL_PROXY: "http://127.0.0.1:7890",
      ZCODE_HTTP_PROXY: "http://127.0.0.1:7890",
    });
  });

  it("injects the configured CA even without a proxy", () => {
    expect(
      buildAgentRuntimeEnv({ httpProxy: undefined, caCertPath: " /tmp/root-ca.pem " }),
    ).toEqual({
      NODE_EXTRA_CA_CERTS: "/tmp/root-ca.pem",
      ZCODE_AGENT_CA_CERT: "/tmp/root-ca.pem",
    });
  });
});

/* CR-01：官方 MCP 信任判定的单源不变量。
   两侧共用 @zcode/shared 的同一份实现，但只有"输入也相同"时结论才必然一致。
   host 的输入是 env + settings 覆盖，agent 的输入只有 env——因此必须把 host 解析出的
   权威 origin 通过 ZCODE_BASE_URL 下发，否则 test env + 自定义端点时两侧必然分叉。 */
describe("buildAgentEndpointOriginEnv", () => {
  it("returns an empty patch when the origin is missing or blank", () => {
    expect(buildAgentEndpointOriginEnv(undefined)).toEqual({});
    expect(buildAgentEndpointOriginEnv("")).toEqual({});
    expect(buildAgentEndpointOriginEnv("   ")).toEqual({});
  });

  it("pins the resolved origin onto ZCODE_BASE_URL", () => {
    expect(buildAgentEndpointOriginEnv("https://zcode.z.ai")).toEqual({
      ZCODE_BASE_URL: "https://zcode.z.ai",
    });
  });

  it("outranks the inherited endpoint keys it must override", () => {
    // ZCODE_BASE_URL 必须压过继承来的 ZCODE_ENDPOINT_ORIGIN / ZCODE_TEST_BASE_URL，
    // 否则注入了也不生效。
    const hostEnv = {
      ZCODE_ENDPOINT_ORIGIN: "https://inherited-endpoint.example",
      ZCODE_ENV: "test",
      ZCODE_TEST_BASE_URL: "https://inherited-test.example",
    };
    const agentEnv = {
      ...hostEnv,
      ...buildAgentEndpointOriginEnv("https://authoritative.example"),
    };

    expect(resolveRuntimeZCodeEndpointOrigin(agentEnv)).toBe("https://authoritative.example");
  });
});

describe("buildAgentWorkspaceIdentityEnv", () => {
  it("injects only a trimmed remote workspace identity", () => {
    expect(buildAgentWorkspaceIdentityEnv(" remote:ssh:host:/repo ")).toEqual({
      ZCODE_WORKSPACE_IDENTITY: "remote:ssh:host:/repo",
    });
    expect(buildAgentWorkspaceIdentityEnv("   ")).toEqual({});
    expect(buildAgentWorkspaceIdentityEnv(undefined)).toEqual({});
  });
});

describe("official MCP trust: host and agent must agree on the ZCode API origin", () => {
  // 设置页自定义端点：任何不同于 env base URL 的 origin 都成立；用中性域名，避免开源导出把
  // 测试环境域名改写成正式域名后与生产 base URL 重合。
  const SETTINGS_ORIGIN = "https://custom-endpoint.example";
  const PLUGIN_ID = "official-tools@zcode-plugins-local";

  /** host 口径：env + settings 覆盖（node.ts resolveCurrentZCodeEndpointOrigin）。 */
  function hostRegistry(env: Record<string, string>, overrideOrigin: string | undefined) {
    return createOfficialMcpTrustedOriginRegistry({
      resolveZCodeApiOrigin: () => resolveRuntimeZCodeEndpointOrigin(env, { overrideOrigin }),
    });
  }

  /** agent 口径：只有 env（zcode-protocol-entrypoint.ts）。 */
  function agentRegistry(env: Record<string, string>) {
    return createOfficialMcpTrustedOriginRegistry({
      resolveZCodeApiOrigin: () => resolveRuntimeZCodeEndpointOrigin(env),
    });
  }

  async function verdict(
    registry: ReturnType<typeof createOfficialMcpTrustedOriginRegistry>,
    origin: string,
  ) {
    return (await registry.isTrusted({ mcpKey: "image_search", origin, pluginId: PLUGIN_ID }))
      .trusted;
  }

  it("agrees in test env once the resolved origin is injected", async () => {
    // 复现场景：ZCODE_ENV=test（桌面测试包显式下发）+ 设置页自定义端点 ≠ env base URL。
    const hostEnv = { ZCODE_ENV: "test", ZCODE_BASE_URL: "https://env-derived.example" };
    const agentEnv = {
      ...hostEnv,
      ...buildAgentEndpointOriginEnv(
        resolveRuntimeZCodeEndpointOrigin(hostEnv, { overrideOrigin: SETTINGS_ORIGIN }),
      ),
    };
    const host = hostRegistry(hostEnv, SETTINGS_ORIGIN);
    const agent = agentRegistry(agentEnv);

    for (const origin of [
      SETTINGS_ORIGIN,
      "https://env-derived.example",
      "https://attacker.example",
    ]) {
      expect(await verdict(agent, origin)).toBe(await verdict(host, origin));
    }
    // 且两侧都认设置页那个 origin——不是"一致地都拒绝"这种假通过。
    expect(await verdict(host, SETTINGS_ORIGIN)).toBe(true);
    expect(await verdict(agent, SETTINGS_ORIGIN)).toBe(true);
  });

  it("would diverge without the injection (guards against silently dropping it)", async () => {
    // 反向护栏：去掉注入后本用例必须观察到分叉，否则上面那条就是恒真的假护栏。
    const hostEnv = { ZCODE_ENV: "test", ZCODE_BASE_URL: "https://env-derived.example" };
    const host = hostRegistry(hostEnv, SETTINGS_ORIGIN);
    const agentWithoutInjection = agentRegistry(hostEnv);

    expect(await verdict(host, SETTINGS_ORIGIN)).toBe(true);
    expect(await verdict(agentWithoutInjection, SETTINGS_ORIGIN)).toBe(false);
  });

  it("agrees in production, where the settings override is ignored on both sides", async () => {
    // production 下 override 被忽略，注入值等于 env 派生值，行为不得改变。
    const hostEnv = { ZCODE_ENV: "production", ZCODE_BASE_URL: "https://zcode.z.ai" };
    const injected = resolveRuntimeZCodeEndpointOrigin(hostEnv, {
      overrideOrigin: SETTINGS_ORIGIN,
    });
    expect(injected).toBe("https://zcode.z.ai");

    const agentEnv = { ...hostEnv, ...buildAgentEndpointOriginEnv(injected) };
    const host = hostRegistry(hostEnv, SETTINGS_ORIGIN);
    const agent = agentRegistry(agentEnv);

    for (const origin of ["https://zcode.z.ai", SETTINGS_ORIGIN]) {
      expect(await verdict(agent, origin)).toBe(await verdict(host, origin));
    }
    expect(await verdict(host, "https://zcode.z.ai")).toBe(true);
    expect(await verdict(host, SETTINGS_ORIGIN)).toBe(false);
  });
});

/* 上面的用例证明"注入之后两侧一致"，但证明不了 node.ts 真的注入了。
   createNodeServices 是 1200+ 行、107 个 import 的容器，resolveSpawnEnv 又是其中的内联闭包，
   为它搭 mock 不划算；这里退而对接线做源码断言，至少能挡住"整行被删/被接错解析器"。 */
describe("node.ts wires the authoritative origin into resolveSpawnEnv", () => {
  const source = readFileSync(resolve(process.cwd(), "packages/services/src/node.ts"), "utf8");
  // 提取起点不写死参数列表：CUA 集成把闭包改成 `async (context) =>`（需要 workspace
  // registry），写死 `async () =>` 会让 slice 取到空串、两条断言变成永假的空匹配。
  const spawnEnvStart = source.indexOf("resolveSpawnEnv: async (");
  const spawnEnvBlock = source.slice(
    spawnEnvStart,
    source.indexOf("...buildAgentTelemetrySpawnEnv({", spawnEnvStart),
  );

  it("locates the resolveSpawnEnv closure at all", () => {
    // 守卫上面的 slice：起点或终点找不到时 block 会静默变空，让后续 toContain 失去意义。
    expect(spawnEnvStart).toBeGreaterThanOrEqual(0);
    expect(spawnEnvBlock.length).toBeGreaterThan(0);
  });

  it("injects the origin patch inside resolveSpawnEnv", () => {
    expect(spawnEnvBlock).toContain("buildAgentEndpointOriginEnv(");
  });

  it("feeds it the settings-aware resolver, not the env-only one", () => {
    // 承重项：必须用 resolveCurrentZCodeEndpointOrigin（含 settings 覆盖）。
    // 接成 resolveRuntimeZCodeEndpointOrigin(process.env) 会让这次修复完全失效，
    // 而两侧仍然"看起来"都在解析 origin。
    expect(spawnEnvBlock).toContain(
      "buildAgentEndpointOriginEnv(await resolveCurrentZCodeEndpointOrigin())",
    );
  });
});

describe("node.ts lazy CUA spawn helper selection", () => {
  const source = readFileSync(resolve(__dirname, "../src/node.ts"), "utf8");
  const spawnEnvStart = source.indexOf("resolveSpawnEnv: async (");

  it("locates the resolveSpawnEnv closure at all", () => {
    expect(spawnEnvStart).toBeGreaterThanOrEqual(0);
  });

  it("routes darwin through the lazy branch with the stable broker socket (MC-3)", () => {
    expect(spawnEnvStart).toBeGreaterThanOrEqual(0);
    const cuaBlock = source.slice(spawnEnvStart, spawnEnvStart + 4000);
    const darwinIdx = cuaBlock.indexOf('process.platform === "darwin"');
    expect(darwinIdx).toBeGreaterThanOrEqual(0);
    expect(cuaBlock.slice(darwinIdx, darwinIdx + 60)).toContain("win32");
    const stableSocketIdx = cuaBlock.indexOf("resolveBrokerSocketPath()");
    expect(stableSocketIdx).toBeGreaterThan(darwinIdx);
  });

  it("keeps win32 spawn off the acquire path (MC-4)", () => {
    expect(spawnEnvStart).toBeGreaterThanOrEqual(0);
    const cuaBlock = source.slice(spawnEnvStart, spawnEnvStart + 6000);
    expect(cuaBlock).toContain("getStableCuaPipeName()");
    expect(cuaBlock.indexOf("getOrCreateDefaultCuaProductHelper(context)")).toBe(-1);
    expect(cuaBlock).toContain("ZCODE_CUA_WIN_HELPER_RECIPE");
  });
});
