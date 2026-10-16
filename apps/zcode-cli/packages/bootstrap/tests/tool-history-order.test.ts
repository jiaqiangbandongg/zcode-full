import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  InMemorySessionEventStore,
  createRootTraceContext,
  createSessionId,
  type ModelRequest,
  type ToolPart,
} from "@zcode/contracts";
import { AgentRuntime, createToolRegistry } from "@zcode/core";
import { createTestModelFactory } from "../../core/tests/test-runtime-model.js";

const scenarios = [
  "success",
  "tool-error",
  "stream-failure",
  "slow-pending",
  "failed-pending",
  "stop",
] as const;

describe("tool order through runtime and SQLite", () => {
  it.each(scenarios)(
    "preserves history and streaming behavior: %s",
    async (scenario) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-tool-order-"));
      const dbPath = join(root, "session.sqlite");
      const sessionId = createSessionId("tool-order");
      let store = createSqliteSessionStore({ dbPath });
      const writes: ToolPart[] = [];
      const pendingStarted = Promise.withResolvers<void>();
      const pendingRelease = Promise.withResolvers<void>();
      const readStarted = Promise.withResolvers<void>();
      const executionOrder: string[] = [];
      const requests: ModelRequest[] = [];
      let pendingAttempts = 0;
      let firstStreamFinished = false;
      let readStartedBeforeFinish = false;
      let laterStreamEventConsumed = false;
      const originalSavePart = store.savePart.bind(store);
      store.savePart = async (part) => {
        if (part.type === "tool") {
          if (
            part.callID === "read" &&
            part.state.status === "pending" &&
            pendingAttempts++ === 0
          ) {
            pendingStarted.resolve();
            if (scenario === "slow-pending" || scenario === "stop") await pendingRelease.promise;
            if (scenario === "failed-pending") throw new Error("injected pending write failure");
          }
          writes.push(structuredClone(part));
        }
        await originalSavePart(part);
      };
      const createRegistry = () => {
        const registry = createToolRegistry();
        for (const name of ["DeferredWrite", "EarlyRead"]) {
          registry.register({
            capability: "Return a fixed result for tool-history regression",
            inputSchema: {},
            outputSchema: { type: "string" },
            permission: {
              permission: "test",
              reason: "In-process fixture",
              riskLevel: "low",
              sideEffectScope: name === "EarlyRead" ? "none" : "workspace",
              needsApproval: false,
              patternSources: ["none"],
              denyPriority: "beforeAsk",
            },
            resultBudget: { strategy: "inline", maxInlineBytes: 1024, maxModelBytes: 1024 },
            timeout: { kind: "none" },
            cancellation: { supported: true, cleanup: "none", userVisibleMessage: "Cancelled" },
            trace: {
              required: true,
              propagateToAdapters: false,
              recordInput: "none",
              recordOutput: "none",
            },
            metadata: {
              name,
              concurrentSafe: true,
              destructive: false,
              needsApproval: false,
              readOnly: name === "EarlyRead",
              riskLevel: "low",
              sideEffectScope: name === "EarlyRead" ? "none" : "workspace",
            },
            handler: async () => {
              executionOrder.push(name);
              if (name === "EarlyRead") {
                readStartedBeforeFinish = !firstStreamFinished;
                readStarted.resolve();
              }
              if (name === "DeferredWrite" && scenario === "tool-error")
                throw new Error("tool error");
              return `${name} result`;
            },
          });
        }
        return registry;
      };
      const abort = new AbortController();
      const modelFactory = createTestModelFactory({
        async *streamText(request) {
          requests.push(structuredClone(request));
          if (requests.length === 1) {
            yield {
              type: "tool_call",
              toolCall: { id: "write", name: "DeferredWrite", input: {} },
            };
            yield {
              type: "tool_call",
              toolCall: { id: "native", name: "NativeSearch", input: {}, providerExecuted: true },
            };
            yield { type: "tool_call", toolCall: { id: "read", name: "EarlyRead", input: {} } };
            // 同一声明重复到达不应占用第二个位置，provider 执行的调用也不占本地序号。
            yield { type: "tool_call", toolCall: { id: "read", name: "EarlyRead", input: {} } };
            if (scenario === "slow-pending" || scenario === "stop") {
              await pendingStarted.promise;
              yield { type: "text_delta", text: "tail while pending is blocked" };
              laterStreamEventConsumed = true;
              if (scenario === "stop") abort.abort();
              pendingRelease.resolve();
            } else if (scenario !== "failed-pending") {
              await readStarted.promise;
            }
            firstStreamFinished = true;
            if (scenario === "stream-failure") throw new Error("Model request timed out.");
            yield { type: "finish", finishReason: "tool-calls", usage: {} };
            return;
          }
          yield { type: "text_delta", text: "done" };
          yield { type: "finish", finishReason: "stop", usage: {} };
        },
      });
      const createRuntime = () =>
        new AgentRuntime(
          sessionId,
          {
            mode: "yolo",
            modelStreaming: "on",
            workingDirectory: root,
            modelSelection: { providerId: "test", modelId: "tool-order" },
          },
          {
            modelFactory,
            sessionStore: store,
            toolRegistry: createRegistry(),
            eventStore: new InMemorySessionEventStore({ retention: "unbounded" }),
          },
        );
      let runtime = createRuntime();
      try {
        const turn = runtime.executeTurn("declare write then read", [], {
          abortSignal: abort.signal,
        });
        if (scenario === "stop") {
          await expect(turn).rejects.toThrow("Turn was cancelled");
          expect(laterStreamEventConsumed).toBe(true);
          expect(executionOrder).toEqual([]);
          // 原 streaming 路径先写 running 再由 executor 检查取消；本修复保持这一记录集合。
          expect(writes.map((part) => [part.callID, part.state.status])).toEqual([
            ["read", "pending"],
            ["read", "running"],
          ]);
          expect(writes.every((part) => part.declarationIndex === 1)).toBe(true);
          return;
        }
        await turn;
        expect(requests).toHaveLength(2);
        expect(pendingAttempts).toBe(scenario === "failed-pending" ? 2 : 1);
        const live = toolHistory(requests[1]!);
        expect(live.calls.map((call) => call.id)).toEqual(["write", "read"]);
        expect(live.results.map((result) => result.toolCallId)).toEqual(["write", "read"]);
        expect(executionOrder.filter((name) => name === "EarlyRead")).toHaveLength(1);
        expect(executionOrder.filter((name) => name === "DeferredWrite")).toHaveLength(
          scenario === "stream-failure" ? 0 : 1,
        );
        if (scenario === "slow-pending") expect(laterStreamEventConsumed).toBe(true);
        if (["success", "tool-error", "stream-failure"].includes(scenario)) {
          expect(readStartedBeforeFinish).toBe(true);
          const parts = (await store.messages({ sessionID: sessionId }))
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "tool");
          expect(parts.map((part) => part.callID)).toEqual(["read", "write"]);
        }
        expect(writes.length).toBeGreaterThan(0);

        // 冷恢复确实关闭并重开数据库，再观察新的 ModelFactory 请求。
        runtime.beginShutdown();
        store.close();
        store = createSqliteSessionStore({ dbPath });
        runtime = createRuntime();
        await runtime.resumeFromStore();
        await runtime.executeTurn("later user query");
        expect(toolHistory(requests.at(-1)!)).toEqual(live);
        const laterUser = (await store.messages({ sessionID: sessionId })).findLast(
          (message) => message.info.role === "user",
        );
        expect(laterUser).toBeDefined();
        await runtime.rewindConversationToMessage({
          events: [],
          targetMessageId: laterUser!.info.id,
          traceContext: createRootTraceContext({ sessionId }),
        });
        await runtime.executeTurn("edited later user query");
        expect(toolHistory(requests.at(-1)!)).toEqual(live);
        expect(
          writes.every((part) => part.declarationIndex === (part.callID === "write" ? 0 : 1)),
        ).toBe(true);
      } finally {
        pendingRelease.resolve();
        runtime.beginShutdown();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});

function toolHistory(request: ModelRequest) {
  return {
    calls: request.messages
      .flatMap((message) => message.toolCalls ?? [])
      .filter((call) => call.id === "write" || call.id === "read"),
    results: request.messages
      .filter((message) => message.role === "tool")
      .map(({ toolCallId, content, isError }) => ({ toolCallId, content, isError })),
  };
}
