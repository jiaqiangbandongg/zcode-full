import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSessionId, createProjectId } from "@zcode/contracts";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { getTodoReminderTurnCounts } from "../src/runtime/helpers/runtime-reminders.js";
import { expect, it } from "vitest";
import type { ModelRequest, ModelResult } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
it.each(["off", "on"] as const)(
  "keeps TodoWrite reminders equivalent for direct/wrapped runtime calls (stream=%s)",
  async (modelStreaming) => {
    const root = await mkdtemp(join(tmpdir(), "deferred-todo-"));
    try {
      for (const wrapped of [false, true]) {
        const sessionId = createSessionId(`todo-${modelStreaming}-${wrapped}`);
        const store = await createSqliteSessionStore({
          dbPath: join(root, `${modelStreaming}-${wrapped}.sqlite`),
        });
        await store.createSession({
          id: sessionId,
          projectID: createProjectId("todo-review"),
          slug: "review",
          title: "Review",
          directory: root,
          version: "test",
          time: { created: 1, updated: 1 },
        });
        const requests: ModelRequest[] = [];
        const respond = async (request: ModelRequest): Promise<ModelResult> => {
          requests.push(request);
          const step = requests.length;
          const input = {
            todos: [{ content: `Step ${step}`, status: "in_progress", priority: "high" }],
          };
          return step <= 10
            ? {
                text: "",
                finishReason: "tool-calls",
                usage: {},
                toolCalls: [
                  {
                    id: `call-${step}`,
                    name: wrapped ? "DeferredToolCall" : "TodoWrite",
                    input: wrapped ? { name: "TodoWrite", input } : input,
                  },
                ],
              }
            : { text: "Done", finishReason: "stop", usage: {} };
        };
        const runtime = createTestAgentRuntime(
          sessionId,
          {
            mode: "yolo",
            toolSearch: { mode: "local" },
            modelStreaming,
            titleGeneration: { enabled: false },
            workspacePath: root,
            toolAllowlist: ["ToolSearch", "DeferredToolCall", "TodoWrite"],
          },
          {
            sessionStore: store,
            eventStore: createTestSessionEventStore(),
            modelFactory: createTestModelFactory({
              generateText: respond,
              async *streamText(request) {
                const r = await respond(request);
                for (const toolCall of r.toolCalls ?? []) yield { type: "tool_call", toolCall };
                if (r.text) {
                  yield { type: "text_start", id: "txt" };
                  yield { type: "text_delta", id: "txt", text: r.text };
                  yield { type: "text_end", id: "txt" };
                }
                yield { type: "finish", finishReason: r.finishReason, usage: r.usage };
              },
            }),
          },
        );
        try {
          await runtime.executeTurn("Update the todo for each step.");
          const parts = (await store.messages({ sessionID: sessionId })).flatMap((m) => m.parts);
          expect(requests).toHaveLength(11);
          expect(
            parts.filter(
              (p) => p.type === "tool" && p.tool === "TodoWrite" && p.state.status === "completed",
            ),
          ).toHaveLength(10);
          expect(
            requests.filter((r) =>
              JSON.stringify(r.messages).includes("The TodoWrite tool hasn't been used recently."),
            ),
          ).toEqual([]);
          expect(
            getTodoReminderTurnCounts(
              (
                runtime as unknown as AgentRuntimeInternal
              ).messageHistory.borrowReadOnlyRuntimeEntries(),
            ).turnsSinceLastTodoWrite,
          ).toBe(1);
        } finally {
          await runtime.closeBrowserSession();
          store.close();
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
