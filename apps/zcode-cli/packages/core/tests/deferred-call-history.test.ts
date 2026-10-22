import { expect, it } from "vitest";
import {
  MessageHistoryImpl,
  createRuntimeAssistantEntry,
  createRuntimeToolResultEntry,
} from "../src/agent/message-history.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";
import {
  buildPostCompactRuntimeEntries,
  maybeLocalMicrocompactRuntimeEntries,
} from "../src/runtime/helpers/compact.js";
import { getTodoReminderTurnCounts } from "../src/runtime/helpers/runtime-reminders.js";

const wrapper = "DeferredToolCall" as const;

it("preserves target identity through history copies and projects only protocol calls", () => {
  const history = new MessageHistoryImpl();
  const call = { id: "todo", name: "TodoWrite", input: { todos: [] }, modelCallWrapper: wrapper };
  history.addAssistant("", [call]);
  history.addToolResult(call.id, call.name, "saved", true, false, wrapper);
  history.replaceMessages(history.toRuntimeEntries());
  const entries = history.toRuntimeEntries();
  expect(entries[0]?.message.toolCalls).toEqual([call]);
  expect(entries[1]?.message).toMatchObject({ toolName: "TodoWrite", modelCallWrapper: wrapper });
  expect(getTodoReminderTurnCounts(entries).turnsSinceLastTodoWrite).toBe(0);
  const projected = buildProviderRequestMessages({ entries });
  expect(projected.messages[0]?.toolCalls).toEqual([
    { id: "todo", name: wrapper, input: { name: "TodoWrite", input: { todos: [] } } },
  ]);
  expect(projected.messages[1]?.toolName).toBe(wrapper);
  expect(JSON.stringify(projected.messages)).not.toContain("modelCallWrapper");
  expect(history.toRuntimeEntries()).toEqual(entries);
  const compacted = buildPostCompactRuntimeEntries(
    [],
    { message: { role: "user", content: "summary" } },
    { preservedEntries: entries },
  );
  expect(compacted.slice(1)).toEqual(entries);
  expect(buildProviderRequestMessages({ entries: compacted }).messages.slice(1)).toEqual(
    projected.messages,
  );
});

it("microcompact classifies target results while estimating protocol messages", () => {
  const entries = Array.from({ length: 7 }, (_, index) => [
    createRuntimeAssistantEntry("", [
      {
        id: `fetch-${index}`,
        name: "WebFetch",
        input: { url: `https://example.com/${index}` },
        modelCallWrapper: wrapper,
      },
    ]),
    createRuntimeToolResultEntry(
      `fetch-${index}`,
      "WebFetch",
      "fetch content ".repeat(1000),
      false,
      wrapper,
    ),
  ]).flat();
  const before = structuredClone(entries);
  const result = maybeLocalMicrocompactRuntimeEntries({
    entries,
    config: { enabled: true, thresholdTokens: 1, keepRecentToolResults: 1, minTokenSavings: 1 },
  });
  expect(result.decision.reason).toBe("applied");
  expect(result.payload?.clearedToolCallIds).toEqual(
    Array.from({ length: 6 }, (_, i) => `fetch-${i}`),
  );
  expect(entries).toEqual(before);
  expect(result.entries.at(-1)).toBe(entries.at(-1));
  const messages = buildProviderRequestMessages({ entries: result.entries }).messages;
  expect(
    messages
      .filter((message) => message.role === "tool")
      .every((message) => message.toolName === wrapper),
  ).toBe(true);
  expect(JSON.stringify(messages)).not.toContain("modelCallWrapper");
});
