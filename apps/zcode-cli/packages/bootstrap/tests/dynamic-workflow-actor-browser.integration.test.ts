// ============================================================
// dwf 子代理的 Browser Use：真 createZCodeApp + 真 run service 的端到端一格
// ============================================================
// 契约见 apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Subagent sessions」与
// docs/zcode-protocol-model-backed-control-requests.md 契约 4。
//
// Bug 根因（2026-09-30，run dwfrun-becabf58）：actor 的 `mcp__node_repl__js` 带着自己的
// `sess_dwf-…` 到达协议 broker，`requireSession` 只认客户端会话，每个 `agent.browsers.*` 都以
// `Session is not active` 失败。单测钉住了各个接缝；这一格钉住装配：create-app 把父会话的端口交给
// actor 工厂、run dispose 真的关掉 actor 的 Browser session。
//
// 生产里 node_repl MCP 进程经 broker socket 把 actor 的 session_id 原样交给进程级 broker 实例
// （zcode-protocol-entrypoint.ts 的 `server.browserControlPort`）；这里由 actor 的罐头模型直接调用
// 同一 context 上的第二个 broker 实例来代替那一跳——socket 只做 token 校验与转发，不碰 session。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { ESCALATE_TOOL_NAME, type ModelRequest, type ModelResult } from "@zcode/contracts";
import { saveSavedWorkflow } from "@zcode/core";
import { createProtocolBrowserControlBroker } from "../src/zcode-protocol/browser-control-broker.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { createRegistryBackedTestApp as createZCodeApp } from "./helpers/registry-backed-test-app.js";

const WORKFLOW_NAME = "browse";
const ACTOR_SESSION_PREFIX = "sess_dwf-";
const IAB_BROWSER_ID = "iab:test";
const IAB_GENERATION = 7;
const SETTLE_TIMEOUT_MS = 20_000;

interface DesktopCall {
  method: string;
  sessionId: string;
  workspaceKey: string;
  workspacePath: string;
  command?: Record<string, unknown>;
}

function textResult(text: string): ModelResult {
  return {
    finishReason: "stop",
    text,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  } as unknown as ModelResult;
}

function isActorRequest(request: ModelRequest): boolean {
  // 每个 dwf 子代理都注册 escalate（端口恒注入）；主会话没有。
  return (request.tools ?? []).some((tool) => tool.name === ESCALATE_TOOL_NAME);
}

describe("dwf 子代理的 Browser Use（真 app 装配）", () => {
  let root: string;
  let sessionStore: ReturnType<typeof createSqliteSessionStore>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-dwf-actor-browser-"));
    sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
  });

  afterEach(async () => {
    sessionStore.close();
    await rm(root, { force: true, recursive: true });
  });

  it("actor 的浏览器请求以自己的 sessionId、父会话的 workspace 到达桌面；run 结束连 tab 一起关", async () => {
    const desktopCalls: DesktopCall[] = [];
    // 假桌面：只记录 interaction/browserList / browserExecute 的 params 并回成功。
    const requestClient = vi.fn(async (method: string, params: unknown) => {
      const p = params as Omit<DesktopCall, "method">;
      desktopCalls.push({
        method,
        sessionId: p.sessionId,
        workspaceKey: p.workspaceKey,
        workspacePath: p.workspacePath,
        ...(p.command === undefined ? {} : { command: p.command }),
      });
      return method.endsWith("browserList") ? { browsers: [] } : { ok: true, elapsedMs: 0 };
    });
    const sessions = new Map<string, unknown>();
    const context = {
      requestClient,
      sessions,
    } as unknown as ZCodeProtocolAgentServerContext;
    // 同一 context 两个实例：app 的 runtime 端口（交给 createZCodeApp），与进程级 node_repl broker 的那个。
    const appPort = createProtocolBrowserControlBroker(context);
    const nodeReplPort = createProtocolBrowserControlBroker(context);

    let actorSessionId: string | undefined;
    let actorBrowserResult: unknown;
    saveSavedWorkflow({
      cwd: root,
      name: WORKFLOW_NAME,
      scope: "project",
      script: 'await agent("browser-user").ask("Open example.com in the browser.");\nreturn 1;',
      meta: { description: "open a page" },
    });

    const app = await createZCodeApp({
      env: {},
      browserControlPort: appPort,
      modelExecutor: {
        async generateText(request) {
          if (!isActorRequest(request)) return textResult("ok");
          if (actorSessionId === undefined) {
            const listed = await sessionStore.listSessions();
            actorSessionId = listed.find((session) =>
              String(session.id).startsWith(ACTOR_SESSION_PREFIX),
            )?.id;
            // node_repl 的那一跳：actor 自己的 session_id 进进程级实例。
            actorBrowserResult = await nodeReplPort.execute({
              browserId: IAB_BROWSER_ID,
              browserGeneration: IAB_GENERATION,
              sessionId: String(actorSessionId),
              command: { method: "newTab" },
            });
          }
          return textResult("opened example.com");
        },
      },
      runtimeConfig: { workingDirectory: root, dynamicWorkflowEnabled: true },
      sessionStore,
      skipUserConfig: true,
    });
    try {
      // 协议 server 只认识这一个会话（桌面创建的那个）。
      sessions.set(app.sessionId, {
        deliveryKind: "desktop-continuous",
        workspace: { workspaceKey: root, workspacePath: root },
      });

      const started = await app.startSavedWorkflow?.({ name: WORKFLOW_NAME, scope: "project" });
      expect(started).toMatchObject({ ok: true });

      await vi.waitFor(
        () => {
          expect(desktopCalls.some((call) => call.command?.method === "closeSession")).toBe(true);
        },
        { timeout: SETTLE_TIMEOUT_MS, interval: 50 },
      );

      expect(actorSessionId).toMatch(new RegExp(`^${ACTOR_SESSION_PREFIX}`));
      expect(actorBrowserResult).toMatchObject({ ok: true });
      expect(
        desktopCalls.map((call) => ({ method: call.command?.method, sessionId: call.sessionId })),
      ).toEqual([
        { method: "newTab", sessionId: actorSessionId },
        { method: "turnEnded", sessionId: actorSessionId },
        { method: "closeSession", sessionId: actorSessionId },
      ]);
      // tab 归属是 actor 自己的会话；workspace 是父会话的。
      expect(desktopCalls.every((call) => call.workspaceKey === root)).toBe(true);
      expect(desktopCalls.every((call) => call.workspacePath === root)).toBe(true);
      expect(desktopCalls.at(-1)?.command).toEqual({ method: "closeSession", closeTabs: true });
      // dispose 之后登记已撤销：迟到的 actor 请求与从未登记的一样被拒。
      await expect(nodeReplPort.list({ sessionId: String(actorSessionId) })).rejects.toThrow(
        `Session is not active: ${actorSessionId}`,
      );
    } finally {
      await app.close();
    }
  }, 30_000);
});
