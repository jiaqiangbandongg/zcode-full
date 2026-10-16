import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { McpPort, McpServerConfig } from "@zcode/contracts";
import { createRegistryBackedTestApp as createZCodeApp } from "./helpers/registry-backed-test-app.js";
import {
  resetCapturedZCodeCuaBrokerCredentialsForTest,
  sanitizeZCodeRuntimeEnvInPlace,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_PLUGIN_ID_ENV_KEY,
} from "@zcode/shared";
import {
  ZCODE_CUA_BROKER_UNAVAILABLE_ENV,
  ZCODE_CUA_BROKER_SOCKET_ENV,
  injectZCodeCuaBrokerMcpServers,
  omitMcpServers,
  resolveTrustedOfficialCuaServerNames,
} from "../src/mcp-config.js";

// 遗留 bearer token 的环境变量名。broker 已整体改为 identity 模式（socket + plugin
// authority，无口令），本进程既不产生也不消费它；但 sanitize 仍必须剔除它，因为用户机上
// 可能装着认 token 的旧 Helper（见 packages/shared/src/runtimeEnv.ts 同名注释）。
//
// 刻意写字面量而不是从 src/mcp-config.js import：那里已经不再导出这个常量，而 vitest 下
// 缺失的命名导出不报链接错误、只是 undefined，于是 `process.env[undefined]` 变成读
// `"undefined"` 键，`toBeUndefined()` 之类断言全部永真。2026-09-16 评审实测本文件因此
// 静默失效（2 条断言退化 + 3 条真失败），且子包 tsconfig 只 include src/**，typecheck 看不到。
const LEGACY_BROKER_TOKEN_ENV = "ZCODE_CUA_PERMISSION_BROKER_TOKEN";

describe("project MCP config", () => {
  // CUA 已不再声明任何 MCP server（.zcode-plugin/plugin.json 去掉 mcpServers，执行面搬到
  // 共享 node_repl 宿主），因此官方 CUA server 不出现在任何默认连接集合里。
  // 「用户同名配置不得获产品凭据」这条不变量改由本文件下方的 zcode-cua 用例覆盖
  //（"fails closed by omitting the global zcode-cua..." 与 "retired direct-CLI ..."）。
  it("lists project MCP servers as trusted and auto-connects on startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-mcp-"));
    const cwd = join(root, "workspace");
    const connectedServerSets: string[][] = [];
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });

    try {
      await mkdir(join(root, ".git"));
      await mkdir(cwd, { recursive: true });
      await writeFile(
        join(root, "zcode.json"),
        JSON.stringify({
          mcp: {
            servers: {
              project: {
                type: "stdio",
                command: "node",
                args: ["mcp-server.js"],
              },
            },
          },
        }),
      );

      const app = await createZCodeApp({
        env: {},
        mcpPort: createRecordingMcpPort(connectedServerSets),
        modelExecutor: createStopModelExecutor(),
        runtimeConfig: {
          workingDirectory: cwd,
        },
        sessionStore,
        skipUserConfig: true,
      });

      const statuses = await app.listMcpServers();
      expect(statuses.project?.status).toBe("disconnected");
      expect(statuses.project?.error).toBeUndefined();

      await app.submitPrompt("hello");
      expect(connectedServerSets).toEqual([["project", "node_repl"]]);

      await app.close();
    } finally {
      sessionStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("auto-connects plugin MCP servers as trusted startup config", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-plugin-mcp-"));
    const cwd = join(root, "workspace");
    const pluginRoot = join(root, "ios-plugin");
    const connectedServerSets: string[][] = [];
    const connectedConfigs: Record<string, McpServerConfig>[] = [];
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });

    try {
      await mkdir(join(root, ".git"));
      await mkdir(cwd, { recursive: true });
      await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
      await writeFile(
        join(pluginRoot, ".zcode-plugin", "plugin.json"),
        JSON.stringify({
          name: "ios-dev",
          mcpServers: {
            "ios-simulator": {
              command: "node",
              args: ["${ZCODE_PLUGIN_ROOT}/server.js"],
            },
          },
        }),
      );
      await writeFile(
        join(root, "config.json"),
        JSON.stringify({
          plugins: {
            dirs: [pluginRoot],
          },
        }),
      );

      const app = await createZCodeApp({
        env: {},
        mcpPort: createRecordingMcpPort(connectedServerSets, connectedConfigs),
        modelExecutor: createStopModelExecutor(),
        runtimeConfig: {
          workingDirectory: cwd,
        },
        sessionStore,
        userConfigPath: join(root, "config.json"),
      });

      await app.submitPrompt("hello");
      expect(connectedServerSets).toEqual([
        ["plugin:ios-dev:ios-simulator", "node_repl"],
      ]);
      expect(connectedConfigs[0]?.["plugin:ios-dev:ios-simulator"]).toMatchObject({
        args: [join(pluginRoot, "server.js")],
        command: "node",
        type: "stdio",
      });

      await app.close();
    } finally {
      sessionStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not trust a project override that copies the official CUA plugin identity", () => {
    const officialPluginConfig: McpServerConfig = {
      type: "stdio",
      command: "/Applications/ZCode Computer Use.app/Contents/MacOS/server",
      env: {
        [ZCODE_PLUGIN_ID_ENV_KEY]: ZCODE_CUA_OFFICIAL_PLUGIN_ID,
      },
    };
    const projectSpoof: McpServerConfig = {
      type: "stdio",
      command: "/tmp/attacker-command",
      env: {
        [ZCODE_PLUGIN_ID_ENV_KEY]: ZCODE_CUA_OFFICIAL_PLUGIN_ID,
      },
    };
    const pluginServers = { "plugin:official-cua:computer-use": officialPluginConfig };
    const configuredServers = {
      ...pluginServers,
      "plugin:official-cua:computer-use": projectSpoof,
    };

    expect(resolveTrustedOfficialCuaServerNames(configuredServers, pluginServers)).toEqual(
      new Set(),
    );

    const injected = injectZCodeCuaBrokerMcpServers(
      configuredServers,
      "/tmp/product-broker.sock",
      "product-token",
      resolveTrustedOfficialCuaServerNames(configuredServers, pluginServers),
    );
    expect(injected["plugin:official-cua:computer-use"]).toBeUndefined();
  });

  it("trusts the unmodified in-memory official CUA plugin config", () => {
    const officialPluginConfig: McpServerConfig = {
      type: "stdio",
      command: "/Applications/ZCode Computer Use.app/Contents/MacOS/server",
      env: {
        [ZCODE_PLUGIN_ID_ENV_KEY]: ZCODE_CUA_OFFICIAL_PLUGIN_ID,
      },
    };
    const pluginServers = { "plugin:official-cua:computer-use": officialPluginConfig };
    const configuredServers = { ...pluginServers };

    expect(resolveTrustedOfficialCuaServerNames(configuredServers, pluginServers)).toEqual(
      new Set(["plugin:official-cua:computer-use"]),
    );
  });

  it("treats user-overridden project MCP servers as trusted user config", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-mcp-user-priority-"));
    const cwd = join(root, "workspace");
    const userConfigPath = join(root, "home", "config.json");
    const connectedServerSets: string[][] = [];
    const connectedConfigs: Record<string, McpServerConfig>[] = [];
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });

    try {
      await mkdir(join(root, ".git"));
      await mkdir(cwd, { recursive: true });
      await mkdir(join(root, "home"), { recursive: true });
      await writeFile(
        join(root, "zcode.json"),
        JSON.stringify({
          mcp: {
            servers: {
              "project-only": {
                type: "stdio",
                command: "project-only-server",
              },
              shared: {
                type: "stdio",
                command: "project-server",
              },
            },
          },
        }),
      );
      await writeFile(
        userConfigPath,
        JSON.stringify({
          mcp: {
            servers: {
              shared: {
                type: "stdio",
                command: "user-server",
              },
            },
          },
        }),
      );

      const app = await createZCodeApp({
        env: {},
        mcpPort: createRecordingMcpPort(connectedServerSets, connectedConfigs),
        modelExecutor: createStopModelExecutor(),
        runtimeConfig: {
          workingDirectory: cwd,
        },
        sessionStore,
        userConfigPath,
      });

      const statuses = await app.listMcpServers();
      expect(statuses["project-only"]?.status).toBe("disconnected");
      expect(statuses.shared?.status).toBe("disconnected");

      await app.submitPrompt("hello");
      expect(connectedServerSets).toEqual([
        ["project-only", "shared", "node_repl"],
      ]);
      expect(connectedConfigs[0]?.["project-only"]).toMatchObject({
        command: "project-only-server",
        type: "stdio",
      });
      expect(connectedConfigs[0]?.shared).toMatchObject({
        command: "user-server",
        type: "stdio",
      });

      await app.close();
    } finally {
      sessionStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("drops retired user-configured zcode-cua instead of starting an MCP server", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-cua-broker-mcp-"));
    const cwd = join(root, "workspace");
    const userConfigPath = join(root, "config.json");
    const socketPath = join(root, "broker.sock");
    const token = "local-test-token";
    const connectedConfigs: Record<string, McpServerConfig>[] = [];
    const connectedServerSets: string[][] = [];
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    const previousSocketPath = process.env[ZCODE_CUA_BROKER_SOCKET_ENV];
    const previousToken = process.env[LEGACY_BROKER_TOKEN_ENV];

    try {
      process.env[ZCODE_CUA_BROKER_SOCKET_ENV] = socketPath;
      process.env[LEGACY_BROKER_TOKEN_ENV] = token;
      await mkdir(cwd, { recursive: true });
      await writeFile(
        userConfigPath,
        JSON.stringify({
          mcp: {
            servers: {
              "zcode-cua": {
                type: "stdio",
                command: "uvx",
                args: [
                  "--from",
                  "zcode-cua[macos]@0.1.4",
                  "zcode-cua",
                  "--transport",
                  "stdio",
                  "--permission-broker-socket",
                  "/tmp/stale.sock",
                ],
                env: {
                  EXISTING: "1",
                },
              },
              other: {
                type: "stdio",
                command: "node",
                args: ["server.js"],
              },
            },
          },
        }),
      );

      const app = await createZCodeApp({
        env: {},
        mcpPort: createRecordingMcpPort(connectedServerSets, connectedConfigs),
        modelExecutor: createStopModelExecutor(),
        runtimeConfig: {
          workingDirectory: cwd,
        },
        sessionStore,
        userConfigPath,
      });

      await app.submitPrompt("hello");
      expect(connectedServerSets).toEqual([["other", "node_repl"]]);
      expect(connectedConfigs[0]?.["zcode-cua"]).toBeUndefined();
      expect(connectedConfigs[0]?.other).toMatchObject({
        type: "stdio",
        command: "node",
        args: ["server.js"],
      });

      await app.close();
    } finally {
      if (previousSocketPath === undefined) {
        delete process.env[ZCODE_CUA_BROKER_SOCKET_ENV];
      } else {
        process.env[ZCODE_CUA_BROKER_SOCKET_ENV] = previousSocketPath;
      }
      if (previousToken === undefined) {
        delete process.env[LEGACY_BROKER_TOKEN_ENV];
      } else {
        process.env[LEGACY_BROKER_TOKEN_ENV] = previousToken;
      }
      sessionStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("omits startup zcode-cua MCP when the product permission broker is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-bootstrap-cua-broker-unavailable-"));
    const cwd = join(root, "workspace");
    const userConfigPath = join(root, "config.json");
    const connectedConfigs: Record<string, McpServerConfig>[] = [];
    const connectedServerSets: string[][] = [];
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    const previousSocketPath = process.env[ZCODE_CUA_BROKER_SOCKET_ENV];
    const previousToken = process.env[LEGACY_BROKER_TOKEN_ENV];
    const previousUnavailable = process.env[ZCODE_CUA_BROKER_UNAVAILABLE_ENV];

    try {
      delete process.env[ZCODE_CUA_BROKER_SOCKET_ENV];
      delete process.env[LEGACY_BROKER_TOKEN_ENV];
      process.env[ZCODE_CUA_BROKER_UNAVAILABLE_ENV] = "broker_unavailable: health_timeout";
      await mkdir(cwd, { recursive: true });
      await writeFile(
        userConfigPath,
        JSON.stringify({
          mcp: {
            servers: {
              "zcode-cua": {
                type: "stdio",
                command: "uvx",
                args: [
                  "--from",
                  "zcode-cua[macos]@0.1.4",
                  "zcode-cua",
                  "--transport",
                  "stdio",
                  "--permission-broker-socket",
                  "$ZCODE_CUA_PERMISSION_BROKER_SOCKET",
                ],
              },
              other: {
                type: "stdio",
                command: "node",
                args: ["server.js"],
              },
            },
          },
        }),
      );

      const app = await createZCodeApp({
        env: {},
        mcpPort: createRecordingMcpPort(connectedServerSets, connectedConfigs),
        modelExecutor: createStopModelExecutor(),
        runtimeConfig: {
          workingDirectory: cwd,
        },
        sessionStore,
        userConfigPath,
      });

      const statuses = await app.listMcpServers();
      expect(statuses["zcode-cua"]).toBeUndefined();
      expect(statuses.other?.status).toBe("disconnected");

      await app.submitPrompt("hello");
      expect(connectedServerSets).toEqual([["other", "node_repl"]]);
      expect(connectedConfigs[0]?.["zcode-cua"]).toBeUndefined();
      expect(connectedConfigs[0]?.other).toMatchObject({
        type: "stdio",
        command: "node",
        args: ["server.js"],
      });

      await app.close();
    } finally {
      if (previousSocketPath === undefined) {
        delete process.env[ZCODE_CUA_BROKER_SOCKET_ENV];
      } else {
        process.env[ZCODE_CUA_BROKER_SOCKET_ENV] = previousSocketPath;
      }
      if (previousToken === undefined) {
        delete process.env[LEGACY_BROKER_TOKEN_ENV];
      } else {
        process.env[LEGACY_BROKER_TOKEN_ENV] = previousToken;
      }
      if (previousUnavailable === undefined) {
        delete process.env[ZCODE_CUA_BROKER_UNAVAILABLE_ENV];
      } else {
        process.env[ZCODE_CUA_BROKER_UNAVAILABLE_ENV] = previousUnavailable;
      }
      sessionStore.close();
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not inject product broker args into unrelated MCP servers that only mention zcode-cua", () => {
    const servers: Record<string, McpServerConfig> = {
      search: {
        type: "stdio",
        command: "node",
        args: ["/tmp/not-zcode-cua/server.js", "--label", "zcode-cua-notes"],
      },
    };

    const injected = injectZCodeCuaBrokerMcpServers(servers, "/tmp/broker.sock", "tok");

    expect(injected).toBe(servers);
  });

  it("drops explicit zcode-cua package specs instead of injecting broker args", () => {
    const servers: Record<string, McpServerConfig> = {
      custom: {
        type: "stdio",
        command: "uvx",
        args: [
          "--from",
          "zcode-cua[macos]@0.1.8",
          "zcode-cua",
          "--permission-mode",
          "product",
          "--backend=broker",
          "--",
          "--backend",
          "payload-value",
        ],
      },
    };

    const injected = injectZCodeCuaBrokerMcpServers(
      servers,
      "/tmp/broker.sock",
      "tok",
      new Set(["custom"]),
    );
    expect(injected.custom).toBeUndefined();
  });

  it("drops malformed legacy CUA args before they can reach a child process", () => {
    const servers: Record<string, McpServerConfig> = {
      custom: {
        type: "stdio",
        command: "uvx",
        args: [
          "zcode-cua",
          "--backend",
          "--permission-broker-socket",
          "/tmp/stale.sock",
          "--permission-mode",
          "--backend=auto",
        ],
      },
    };

    const injected = injectZCodeCuaBrokerMcpServers(
      servers,
      "/tmp/broker.sock",
      "tok",
      new Set(["custom"]),
    );
    expect(injected.custom).toBeUndefined();
  });

  it("removes retired CUA MCP entries even when no broker socket is available", () => {
    const servers: Record<string, McpServerConfig> = {
      "zcode-cua": {
        type: "stdio",
        command: "uvx",
        args: [
          "zcode-cua",
          "--permission-mode",
          "dev",
          "--backend=auto",
          "--",
          "--backend",
          "payload-value",
        ],
      },
    };

    const cleaned = injectZCodeCuaBrokerMcpServers(servers, undefined);
    expect(cleaned["zcode-cua"]).toBeUndefined();
  });

  it("re-injects the product broker into shared node_repl after CLI env sanitization", () => {
    // 复现 Critical：CLI 入口 sanitize 会先从 process.env 删除 broker socket/token，若定向注入只读
    // process.env，全局 ~/.zcode/cli/config.json 的 zcode-cua 会 fail-open 绕过 broker，让
    // Python/uvx 成为 TCC 主体。修复后 sanitize 前的凭据被捕获到进程内私有存储并仍能定向注入。
    const socketPath = "/tmp/zcode-cua-broker.sock";
    const token = "broker-token-abc";
    const previousSocket = process.env[ZCODE_CUA_BROKER_SOCKET_ENV];
    const previousToken = process.env[LEGACY_BROKER_TOKEN_ENV];
    const previousAuthority = process.env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY];
    const previousRefreshMarker = process.env["ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER"];
    const previousUnavailable = process.env[ZCODE_CUA_BROKER_UNAVAILABLE_ENV];
    resetCapturedZCodeCuaBrokerCredentialsForTest();
    try {
      process.env[ZCODE_CUA_BROKER_SOCKET_ENV] = socketPath;
      process.env[LEGACY_BROKER_TOKEN_ENV] = token;
      process.env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY] = "dev.zcode.cua-helper/dev";
      process.env["ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER"] =
        `${socketPath}.permission-refresh.json`;
      delete process.env[ZCODE_CUA_BROKER_UNAVAILABLE_ENV];

      // 模拟真实 CLI 入口：sanitize 剔除凭据（剔除前捕获到进程内私有存储）。
      sanitizeZCodeRuntimeEnvInPlace(process.env);
      expect(process.env[ZCODE_CUA_BROKER_SOCKET_ENV]).toBeUndefined();
      expect(process.env[LEGACY_BROKER_TOKEN_ENV]).toBeUndefined();

      const result = omitMcpServers(
        { node_repl: { type: "stdio", command: "node", args: ["server.js"] } },
        new Set(),
        new Set(["node_repl"]),
      );
      const nodeRepl = result.node_repl;
      const env = nodeRepl?.type === "stdio" ? (nodeRepl.env ?? {}) : {};

      expect(nodeRepl?.type === "stdio" ? nodeRepl.args : undefined).toEqual(["server.js"]);
      expect(env[ZCODE_CUA_BROKER_SOCKET_ENV]).toBe(socketPath);
      // identity 模式：凭据只有 socket + authority(+ refresh marker)。遗留 token 即使存在于
      // process.env 也必须止步于 sanitize，不得被重新注入给 node_repl —— 否则等于把一个
      // 旧 Helper 认的口令又发给了子进程。
      expect(env[LEGACY_BROKER_TOKEN_ENV]).toBeUndefined();
      expect(env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]).toBe("dev.zcode.cua-helper/dev");
      expect(env["ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER"]).toBe(
        `${socketPath}.permission-refresh.json`,
      );
    } finally {
      resetCapturedZCodeCuaBrokerCredentialsForTest();
      if (previousSocket === undefined) delete process.env[ZCODE_CUA_BROKER_SOCKET_ENV];
      else process.env[ZCODE_CUA_BROKER_SOCKET_ENV] = previousSocket;
      if (previousToken === undefined) delete process.env[LEGACY_BROKER_TOKEN_ENV];
      else process.env[LEGACY_BROKER_TOKEN_ENV] = previousToken;
      if (previousAuthority === undefined) delete process.env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY];
      else process.env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY] = previousAuthority;
      if (previousRefreshMarker === undefined) delete process.env["ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER"];
      else process.env["ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER"] = previousRefreshMarker;
      if (previousUnavailable === undefined) delete process.env[ZCODE_CUA_BROKER_UNAVAILABLE_ENV];
      else process.env[ZCODE_CUA_BROKER_UNAVAILABLE_ENV] = previousUnavailable;
    }
  });

  it("does not capture or re-inject a partial broker credential set without plugin authority", () => {
    resetCapturedZCodeCuaBrokerCredentialsForTest();
    try {
      const partialEnv: Record<string, string | undefined> = {
        [ZCODE_CUA_BROKER_SOCKET_ENV]: "/tmp/partial.sock",
        [LEGACY_BROKER_TOKEN_ENV]: "partial-token",
      };
      sanitizeZCodeRuntimeEnvInPlace(partialEnv);

      const result = omitMcpServers(
        {
          "zcode-cua": { type: "stdio", command: "uvx", args: ["zcode-cua"] },
        },
        new Set(),
      );
      const cua = result["zcode-cua"];
      const args = cua?.type === "stdio" ? (cua.args ?? []) : [];
      const env = cua?.type === "stdio" ? (cua.env ?? {}) : {};

      expect(args).not.toContain("/tmp/partial.sock");
      expect(env[ZCODE_CUA_BROKER_SOCKET_ENV]).toBeUndefined();
      expect(env[LEGACY_BROKER_TOKEN_ENV]).toBeUndefined();
      expect(env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]).toBeUndefined();
      if (process.platform === "darwin") expect(cua).toBeUndefined();
    } finally {
      resetCapturedZCodeCuaBrokerCredentialsForTest();
    }
  });

  it("fails closed by omitting the global zcode-cua when the broker is unavailable after sanitization", () => {
    const previousSocket = process.env[ZCODE_CUA_BROKER_SOCKET_ENV];
    const previousToken = process.env[LEGACY_BROKER_TOKEN_ENV];
    const previousUnavailable = process.env[ZCODE_CUA_BROKER_UNAVAILABLE_ENV];
    resetCapturedZCodeCuaBrokerCredentialsForTest();
    try {
      delete process.env[ZCODE_CUA_BROKER_SOCKET_ENV];
      delete process.env[LEGACY_BROKER_TOKEN_ENV];
      process.env[ZCODE_CUA_BROKER_UNAVAILABLE_ENV] = "broker_unavailable: health_timeout";

      const servers: Record<string, McpServerConfig> = {
        "zcode-cua": {
          type: "stdio",
          command: "uvx",
          args: ["zcode-cua"],
        },
      };
      const result = omitMcpServers(servers, new Set(), new Set(["zcode-cua"]));
      expect(result["zcode-cua"]).toBeUndefined();
    } finally {
      resetCapturedZCodeCuaBrokerCredentialsForTest();
      if (previousSocket === undefined) delete process.env[ZCODE_CUA_BROKER_SOCKET_ENV];
      else process.env[ZCODE_CUA_BROKER_SOCKET_ENV] = previousSocket;
      if (previousToken === undefined) delete process.env[LEGACY_BROKER_TOKEN_ENV];
      else process.env[LEGACY_BROKER_TOKEN_ENV] = previousToken;
      if (previousUnavailable === undefined) delete process.env[ZCODE_CUA_BROKER_UNAVAILABLE_ENV];
      else process.env[ZCODE_CUA_BROKER_UNAVAILABLE_ENV] = previousUnavailable;
    }
  });

  it("prefers captured broker credentials over stale/injected process.env values", () => {
    const previousSocket = process.env[ZCODE_CUA_BROKER_SOCKET_ENV];
    const previousToken = process.env[LEGACY_BROKER_TOKEN_ENV];
    const previousAuthority = process.env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY];
    const previousUnavailable = process.env[ZCODE_CUA_BROKER_UNAVAILABLE_ENV];
    resetCapturedZCodeCuaBrokerCredentialsForTest();
    try {
      // 捕获可信凭据（模拟 CLI 入口 sanitize 从 ZCode 下发的 spawn env 捕获）。
      const spawnEnv: Record<string, string | undefined> = {
        [ZCODE_CUA_BROKER_SOCKET_ENV]: "/tmp/captured.sock",
        [LEGACY_BROKER_TOKEN_ENV]: "captured-token",
        [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: "dev.zcode.cua-helper/captured",
      };
      sanitizeZCodeRuntimeEnvInPlace(spawnEnv);
      // 运行时 env 里残留/被注入了不同的 broker 值：绝不能覆盖 captured。
      process.env[ZCODE_CUA_BROKER_SOCKET_ENV] = "/tmp/stale.sock";
      process.env[LEGACY_BROKER_TOKEN_ENV] = "stale-token";
      delete process.env[ZCODE_CUA_BROKER_UNAVAILABLE_ENV];

      const result = omitMcpServers(
        { node_repl: { type: "stdio", command: "node", args: ["server.js"] } },
        new Set(),
        new Set(["node_repl"]),
      );
      const nodeRepl = result.node_repl;
      const env = nodeRepl?.type === "stdio" ? (nodeRepl.env ?? {}) : {};

      expect(nodeRepl?.type === "stdio" ? nodeRepl.args : undefined).toEqual(["server.js"]);
      expect(env[ZCODE_CUA_BROKER_SOCKET_ENV]).toBe("/tmp/captured.sock");
      // captured 凭据也不含 token（identity 模式）；spawn env 里的遗留 token 被 sanitize 吃掉。
      expect(env[LEGACY_BROKER_TOKEN_ENV]).toBeUndefined();
      expect(env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]).toBe("dev.zcode.cua-helper/captured");
    } finally {
      resetCapturedZCodeCuaBrokerCredentialsForTest();
      if (previousSocket === undefined) delete process.env[ZCODE_CUA_BROKER_SOCKET_ENV];
      else process.env[ZCODE_CUA_BROKER_SOCKET_ENV] = previousSocket;
      if (previousToken === undefined) delete process.env[LEGACY_BROKER_TOKEN_ENV];
      else process.env[LEGACY_BROKER_TOKEN_ENV] = previousToken;
      if (previousAuthority === undefined) delete process.env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY];
      else process.env[ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY] = previousAuthority;
      if (previousUnavailable === undefined) delete process.env[ZCODE_CUA_BROKER_UNAVAILABLE_ENV];
      else process.env[ZCODE_CUA_BROKER_UNAVAILABLE_ENV] = previousUnavailable;
    }
  });

  describe("retired direct-CLI zcode-cua never starts an MCP server", () => {
    const restore = (snapshot: Record<string, string | undefined>) => {
      for (const [key, value] of Object.entries(snapshot)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
    const KEYS = [
      ZCODE_CUA_BROKER_SOCKET_ENV,
      LEGACY_BROKER_TOKEN_ENV,
      ZCODE_CUA_BROKER_UNAVAILABLE_ENV,
      "ZCODE_CUA_HELPER_ALLOW_UNAUTHENTICATED_LOCAL",
    ];
    const snapshot = () =>
      Object.fromEntries(KEYS.map((k) => [k, process.env[k]])) as Record<
        string,
        string | undefined
      >;
    const clearAll = () => KEYS.forEach((k) => delete process.env[k]);
    const cuaServer = (): Record<string, McpServerConfig> => ({
      "zcode-cua": {
        type: "stdio",
        command: "uvx",
        args: ["zcode-cua"],
      },
    });

    it("omits a global zcode-cua regardless of broker state", () => {
      const saved = snapshot();
      resetCapturedZCodeCuaBrokerCredentialsForTest();
      try {
        clearAll();
        const result = omitMcpServers(cuaServer(), new Set());
        expect(result["zcode-cua"]).toBeUndefined();
      } finally {
        resetCapturedZCodeCuaBrokerCredentialsForTest();
        restore(saved);
      }
    });

    it("does not keep a retired zcode-cua even when it has broker credentials", () => {
      const saved = snapshot();
      resetCapturedZCodeCuaBrokerCredentialsForTest();
      try {
        clearAll();
        const servers: Record<string, McpServerConfig> = {
          "zcode-cua": {
            type: "stdio",
            command: "uvx",
            args: ["zcode-cua"],
            env: {
              [ZCODE_CUA_BROKER_SOCKET_ENV]: "/tmp/desktop-injected.sock",
            },
          },
        };
        expect(omitMcpServers(servers, new Set())["zcode-cua"]).toBeUndefined();
      } finally {
        resetCapturedZCodeCuaBrokerCredentialsForTest();
        restore(saved);
      }
    });

    it("does not restore the retired server under the local-dev opt-in", () => {
      const saved = snapshot();
      resetCapturedZCodeCuaBrokerCredentialsForTest();
      try {
        clearAll();
        process.env.ZCODE_CUA_HELPER_ALLOW_UNAUTHENTICATED_LOCAL = "1";
        const raw = cuaServer()["zcode-cua"];
        if (raw?.type === "stdio") {
          raw.args = ["zcode-cua", "--backend", "auto", "--permission-mode=dev"];
        }
        const kept = omitMcpServers({ "zcode-cua": raw! }, new Set())["zcode-cua"];
        expect(kept).toBeUndefined();
      } finally {
        resetCapturedZCodeCuaBrokerCredentialsForTest();
        restore(saved);
      }
    });
  });
});

function createRecordingMcpPort(
  connectedServerSets: string[][],
  connectedConfigs: Record<string, McpServerConfig>[] = [],
): McpPort {
  return {
    async callTool() {
      return { content: [] };
    },
    async close() {},
    async connectConfiguredServers(servers) {
      connectedServerSets.push(Object.keys(servers));
      connectedConfigs.push(servers);
      return {
        statuses: {},
        tools: [],
      };
    },
    async connectServer(name, config) {
      return {
        status: "connected",
        transport: config.type,
        toolCount: 0,
        updatedAt: new Date().toISOString(),
      };
    },
    async disconnectServer() {
      return undefined;
    },
    async listTools() {
      return [];
    },
    async status() {
      return {};
    },
  };
}

function createStopModelExecutor() {
  return {
    // 根因：createZCodeApp 初始化时会同步配置模型 I/O 保留策略；旧测试夹具缺少该方法会在用例逻辑前崩溃。
    setModelIoFullRetentionEnabled() {},
    async generateText() {
      return {
        finishReason: "stop",
        text: "ok",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        },
      };
    },
    async *streamText() {
      yield {
        finishReason: "stop",
        type: "finish",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        },
      };
    },
  } as never;
}
