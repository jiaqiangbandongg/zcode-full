import { createConnection } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createComputerUseBridgeGlobals, NODE_REPL_CUA_BRIDGE_SYMBOL } from "../src/cua-bridge.js";
import { createNodeReplCuaBroker, type NodeReplCuaBroker } from "../src/cua-broker.js";
import { CUA_APP_ASSOCIATIONS_META_KEY } from "@zcode/zcode-cua/host-display-contract";

describe("node_repl CUA bridge", () => {
  let broker: NodeReplCuaBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  it("forwards the complete trusted request context to the shared runtime", async () => {
    const calls: unknown[] = [];
    broker = createNodeReplCuaBroker({
      runtime: {
        execute: async (input) => {
          calls.push(input);
          return {
            content: [{ type: "text", text: "ok" }],
            structuredContent: { state_id: "state-1" },
          } satisfies CallToolResult;
        },
        closeSession: async () => undefined,
        dispose: async () => undefined,
      },
      // 不传 platform 时 createNodeReplCuaBroker 会走 POSIX 分支，在 tmpdir 里建
      // `znrc-*.sock`；Windows 的 net.Server.listen 只接受命名管道，给文件路径直接
      // EACCES，于是这条用例在 Windows 上从来没跑过。产品代码本身是对的（它按
      // platform 分支选管道或 unix socket），所以测试必须跑在真实平台上，而不是
      // 默默假设 POSIX。
      platform: process.platform,
    });
    await broker.ready;

    const active = {
      generation: 3,
      requestMeta: {
        runtime_scope: "main" as const,
        session_id: "session-1",
        workspace_path: "/workspace",
        workspace_identity: "ssh://host/workspace",
        workspace_key: "ssh://host/workspace",
        remote_session_id: "remote-1",
        turn_id: "turn-1",
        client_mode: "web-remote-replayable",
        delivery_kind: "web-remote-replayable",
        trace_id: "trace-1",
        span_id: "span-1",
      },
      signal: new AbortController().signal,
    };
    const session = { mergeResponseMeta: () => undefined } as never;
    const globals = createComputerUseBridgeGlobals({
      broker: broker.connection,
      documentationRoot: "/tmp/docs",
      generation: active.generation,
      getActiveCall: () => active,
      session: () => session,
    });

    const bridge = globals[NODE_REPL_CUA_BRIDGE_SYMBOL] as {
      call(method: string, input: unknown): Promise<CallToolResult>;
    };
    await expect(bridge.call("screenshot", { display_id: 1 })).resolves.toMatchObject({
      structuredContent: { state_id: "state-1" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      toolName: "screenshot",
      arguments: { display_id: 1 },
      context: {
        sessionId: "session-1",
        workspacePath: "/workspace",
        workspaceIdentity: "ssh://host/workspace",
        workspaceKey: "ssh://host/workspace",
        remoteSessionId: "remote-1",
        clientMode: "web-remote-replayable",
        deliveryKind: "web-remote-replayable",
        trace: { traceId: "trace-1", spanId: "span-1" },
      },
    });
  });

  it("records the target app identity from the broker response, not from sandbox code", async () => {
    // 工具卡的 App 图标只能来自 broker 响应：这一跳沙箱看不见，也改不了。producer 自带的
    // 内联 icon PNG 不进 run 结果（会话协议不承载 data URL），只保留 appKey/displayName。
    broker = createNodeReplCuaBroker({
      runtime: {
        execute: async () =>
          ({
            content: [{ type: "text", text: "clicked" }],
            _meta: {
              [CUA_APP_ASSOCIATIONS_META_KEY]: {
                schemaVersion: 1,
                primary: {
                  appKey: "darwin:com.apple.notes",
                  displayName: "Notes",
                  icon: { mimeType: "image/png", data: "iVBORw0KGgo=" },
                },
              },
            },
          }) satisfies CallToolResult,
        closeSession: async () => undefined,
        dispose: async () => undefined,
      },
      platform: process.platform,
    });
    await broker.ready;

    const active = {
      generation: 1,
      requestMeta: { runtime_scope: "main" as const, session_id: "session-1", workspace_key: "ws" },
      signal: new AbortController().signal,
    };
    const recorded: unknown[] = [];
    const session = {
      mergeResponseMeta: () => undefined,
      recordCuaAppIdentity: (app: unknown) => recorded.push(app),
    } as never;
    const globals = createComputerUseBridgeGlobals({
      broker: broker.connection,
      documentationRoot: "/tmp/docs",
      generation: 1,
      getActiveCall: () => active,
      session: () => session,
    });
    const bridge = globals[NODE_REPL_CUA_BRIDGE_SYMBOL] as {
      call(method: string, input: unknown): Promise<CallToolResult>;
    };

    await bridge.call("left_click", { app_ref: { pid: 1 } });

    expect(recorded).toEqual([{ appKey: "darwin:com.apple.notes", displayName: "Notes" }]);
  });

  it("ignores app associations that carry no primary identity", async () => {
    // list_apps 声明的是 items 模式，没有 primary；request_access / stop 声明 none。
    // 这些调用不能覆盖同一 cell 里前面动作已经确立的身份。
    broker = createNodeReplCuaBroker({
      runtime: {
        execute: async () =>
          ({
            content: [{ type: "text", text: "[]" }],
            _meta: {
              [CUA_APP_ASSOCIATIONS_META_KEY]: {
                schemaVersion: 1,
                items: [{ resultIndex: 0, application: { appKey: "darwin:com.apple.finder" } }],
              },
            },
          }) satisfies CallToolResult,
        closeSession: async () => undefined,
        dispose: async () => undefined,
      },
      platform: process.platform,
    });
    await broker.ready;

    const active = {
      generation: 1,
      requestMeta: { runtime_scope: "main" as const, session_id: "session-1", workspace_key: "ws" },
      signal: new AbortController().signal,
    };
    const recorded: unknown[] = [];
    const globals = createComputerUseBridgeGlobals({
      broker: broker.connection,
      documentationRoot: "/tmp/docs",
      generation: 1,
      getActiveCall: () => active,
      session: () =>
        ({
          mergeResponseMeta: () => undefined,
          recordCuaAppIdentity: (app: unknown) => recorded.push(app),
        }) as never,
    });
    const bridge = globals[NODE_REPL_CUA_BRIDGE_SYMBOL] as {
      call(method: string, input: unknown): Promise<CallToolResult>;
    };

    await bridge.call("list_apps", {});

    expect(recorded).toEqual([]);
  });

  it("rejects subagents before opening the broker", async () => {
    const active = {
      generation: 1,
      requestMeta: { runtime_scope: "subagent" as const, session_id: "subagent-1" },
      signal: new AbortController().signal,
    };
    const globals = createComputerUseBridgeGlobals({
      documentationRoot: "/tmp/docs",
      generation: 1,
      getActiveCall: () => active,
      session: () => ({ mergeResponseMeta: () => undefined }) as never,
    });
    const bridge = globals[NODE_REPL_CUA_BRIDGE_SYMBOL] as {
      call(method: string, input: unknown): Promise<CallToolResult>;
    };

    await expect(bridge.call("screenshot", {})).rejects.toThrow(
      "Computer Use is not available in subagent",
    );
  });

  it("fails closed after a worker generation changes", async () => {
    const active = {
      generation: 1,
      requestMeta: { runtime_scope: "main" as const, session_id: "session-1" },
      signal: new AbortController().signal,
    };
    const globals = createComputerUseBridgeGlobals({
      broker: { socketPath: "/tmp/does-not-exist.sock", token: "token" },
      documentationRoot: "/tmp/docs",
      generation: 2,
      getActiveCall: () => active,
      session: () => ({ mergeResponseMeta: () => undefined }) as never,
    });
    const bridge = globals[NODE_REPL_CUA_BRIDGE_SYMBOL] as {
      assertAvailable(): void;
    };
    expect(() => bridge.assertAvailable()).toThrow("runtime binding is stale");
  });

  it("rejects a forged broker token", async () => {
    broker = createNodeReplCuaBroker({
      runtime: {
        execute: async () => ({ content: [{ type: "text", text: "should not run" }] }),
        closeSession: async () => undefined,
        dispose: async () => undefined,
      },
      platform: process.platform,
    });
    await broker.ready;
    const result = await new Promise<string>((resolve) => {
      const socket = createConnection(broker!.connection.socketPath);
      let buffer = "";
      socket.once("connect", () => {
        socket.end(
          `${JSON.stringify({
            id: "forged",
            token: "wrong-token",
            method: "screenshot",
            input: {},
            context: { sessionId: "session-1", workspaceKey: "/workspace" },
          })}\n`,
        );
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("\n")) resolve(buffer.trim());
      });
      socket.once("error", () => resolve(buffer.trim()));
    });
    expect(result).toContain("not authorized");
  });
});
