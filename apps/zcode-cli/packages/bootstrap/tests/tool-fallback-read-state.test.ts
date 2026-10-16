import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  InMemorySessionEventStore,
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  type ModelRequest,
  type ToolCallResultPayload,
  type ToolCallStartedPayload,
} from "@zcode/contracts";
import { AgentRuntime, createToolRegistry } from "@zcode/core";
import { createTestModelFactory } from "../../core/tests/test-runtime-model.js";

describe("fallback Read snapshots through SQLite", () => {
  it.each(["resume", "rewind"] as const)(
    "keeps model history and allows Edit after %s",
    async (restore) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-fallback-read-"));
      const file = join(root, "target.txt");
      const dbPath = join(root, "session.sqlite");
      const sessionId = createSessionId("fallback-read-state");
      await writeFile(file, "old\n");
      let store = createSqliteSessionStore({ dbPath });
      const failed = Promise.withResolvers<void>();
      const secondRead = Promise.withResolvers<void>();
      const calls: string[] = [];
      const requests: ModelRequest[] = [];
      let failedOnce = false;
      let editRequested = false;
      const savePart = store.savePart.bind(store);
      store.savePart = async (part) => {
        if (
          !failedOnce &&
          part.type === "tool" &&
          part.callID === "read-a" &&
          part.state.status === "running"
        ) {
          failedOnce = true;
          failed.resolve();
          throw new Error("injected transient running write failure");
        }
        await savePart(part);
      };

      const modelFactory = createTestModelFactory({
        async *streamText(request) {
          requests.push(structuredClone(request));
          if (requests.length === 1) {
            yield { type: "tool_call", toolCall: { id: "bash", name: "DeferredWrite", input: {} } };
            yield {
              type: "tool_call",
              toolCall: { id: "read-a", name: "Read", input: { file_path: file } },
            };
            await failed.promise;
            yield {
              type: "tool_call",
              toolCall: { id: "read-b", name: "Read", input: { file_path: file } },
            };
            await secondRead.promise;
            yield { type: "finish", finishReason: "tool-calls", usage: {} };
            return;
          }
          if (editRequested) {
            editRequested = false;
            yield {
              type: "tool_call",
              toolCall: {
                id: "edit",
                name: "Edit",
                input: { file_path: file, old_string: "new content", new_string: "edited content" },
              },
            };
            yield { type: "finish", finishReason: "tool-calls", usage: {} };
            return;
          }
          yield { type: "text_delta", text: "done" };
          yield { type: "finish", finishReason: "stop", usage: {} };
        },
      });

      const createRuntime = () => {
        const registry = createToolRegistry();
        registry.register({
          capability: "Model a deferred Bash command updating the test file",
          inputSchema: {},
          outputSchema: { type: "string" },
          timeout: { kind: "none" },
          cancellation: { supported: true, cleanup: "none", userVisibleMessage: "Cancelled" },
          permission: {
            permission: "test",
            reason: "fixture",
            riskLevel: "low",
            sideEffectScope: "workspace",
            needsApproval: false,
            patternSources: ["none"],
            denyPriority: "beforeAsk",
          },
          resultBudget: { strategy: "inline", maxInlineBytes: 1024, maxModelBytes: 1024 },
          trace: {
            required: true,
            propagateToAdapters: false,
            recordInput: "none",
            recordOutput: "none",
          },
          metadata: {
            name: "DeferredWrite",
            concurrentSafe: false,
            destructive: false,
            needsApproval: false,
            readOnly: false,
            riskLevel: "low",
            sideEffectScope: "workspace",
          },
          handler: async () => {
            await writeFile(file, "new content\n");
            return "file updated";
          },
        });
        const eventStore = new InMemorySessionEventStore({ retention: "unbounded" });
        const append = eventStore.append.bind(eventStore);
        eventStore.append = async (event) => {
          if (event.type === SessionEventType.ToolCallStarted) {
            calls.push((event.payload as ToolCallStartedPayload).toolCallId);
          }
          if (
            event.type === SessionEventType.ToolCallResult &&
            (event.payload as ToolCallResultPayload).toolCallId === "read-b"
          )
            secondRead.resolve();
          return append(event);
        };
        return new AgentRuntime(
          sessionId,
          {
            mode: "yolo",
            modelStreaming: "on",
            workingDirectory: root,
            titleGeneration: { enabled: false },
            modelSelection: { providerId: "test", modelId: "fallback-read-state" },
          },
          {
            modelFactory,
            sessionStore: store,
            toolRegistry: registry,
            eventStore,
            fileSystemPort: createNodeFileSystemAdapter(),
          },
        );
      };
      let runtime = createRuntime();
      try {
        expect((await runtime.executeTurn("update and read file")).response).toBe("done");
        expect(calls).toEqual(["read-b", "bash", "read-a"]);
        const live = toolHistory(requests[1]!);
        expect(live.calls.map((call) => call.id)).toEqual(["bash", "read-a", "read-b"]);
        expect(live.results.map((result) => result.toolCallId)).toEqual([
          "bash",
          "read-a",
          "read-b",
        ]);

        if (restore === "resume") {
          runtime.beginShutdown();
          store.close();
          store = createSqliteSessionStore({ dbPath });
          runtime = createRuntime();
          await runtime.resumeFromStore();
        } else {
          // 保留含回退 Read 的上一轮，只撤回后续用户输入，触发同一份文件状态重建。
          await runtime.executeTurn("later question to edit");
          const later = (await store.messages({ sessionID: sessionId })).findLast(
            (message) => message.info.role === "user",
          );
          expect(later).toBeDefined();
          await runtime.rewindConversationToMessage({
            events: [],
            targetMessageId: later!.info.id,
            traceContext: createRootTraceContext({ sessionId }),
          });
        }

        const editRequestIndex = requests.length;
        editRequested = true;
        await runtime.executeTurn("edit the new content");
        expect(toolHistory(requests[editRequestIndex]!)).toEqual(live);
        // 真实 Edit 的 stale guard 必须认可回退 Read 已读到的最新内容。
        expect(
          requests
            .at(-1)!
            .messages.find((message) => message.role === "tool" && message.toolCallId === "edit"),
        ).toMatchObject({ isError: false });
        expect(await readFile(file, "utf8")).toBe("edited content\n");
      } finally {
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
    calls: request.messages.flatMap((message) => message.toolCalls ?? []),
    results: request.messages
      .filter((message) => message.role === "tool")
      .map(({ toolCallId, content, isError }) => ({ toolCallId, content, isError })),
  };
}
