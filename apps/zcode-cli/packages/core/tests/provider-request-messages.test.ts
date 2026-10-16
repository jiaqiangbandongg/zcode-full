import { describe, expect, it } from "vitest";
import type { ModelInputMessage, RuntimeMessageEntry } from "../src/agent/message-history.js";
import {
  realUserRuntimeMetadata,
  systemReminderRuntimeMetadata,
} from "../src/agent/message-history.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";

function entry(
  message: ModelInputMessage,
  source?: RuntimeMessageEntry["metadata"]["source"],
): RuntimeMessageEntry {
  return {
    message,
    metadata: source ? { source } : undefined,
  };
}

function attachment(
  source: RuntimeMessageEntry["metadata"]["source"],
  content: string,
): RuntimeMessageEntry {
  return {
    kind: "attachment",
    content,
    metadata: { source },
  };
}

function user(content: ModelInputMessage["content"]): ModelInputMessage {
  return { role: "user", content };
}

function assistant(content = "assistant"): ModelInputMessage {
  return { role: "assistant", content };
}

function toolResultUser(content = "tool result"): ModelInputMessage {
  return {
    role: "user",
    content: [{ type: "text", text: content }],
    toolCallId: "tool-1",
    toolName: "Read",
  };
}

function toolResult(
  content = "tool result",
  toolCallId = "tool-1",
  toolName = "Read",
): ModelInputMessage {
  return {
    role: "tool",
    content,
    toolCallId,
    toolName,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}

describe("buildProviderRequestMessages", () => {
  it("keeps committed assistant entry ownership separate from provider messages", () => {
    const assistant = {
      message: { role: "assistant" as const, content: "answer" },
      tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 }, total: 120 },
    } satisfies RuntimeMessageEntry;
    const entries = [entry(user("prompt"), "real_user"), assistant] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      { role: "user", content: "prompt" },
      { role: "assistant", content: "answer" },
    ]);
    expect(result.sourceEntries).toEqual([entries[0], assistant]);
    expect(JSON.stringify(result.messages)).not.toContain("tokens");
  });

  it("keeps a query-only Continue provider-visible without moving the latest real user", () => {
    const entries = [
      entry(user("real prompt"), "real_user"),
      entry(assistant("partial")),
      {
        message: user("continue locally"),
        queryScope: "output_token_continuation",
      },
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      user("real prompt"),
      assistant("partial"),
      user("continue locally"),
    ]);
    expect(result.diagnostics.latestRealUserMessageIndex).toBe(0);
  });

  it("projects structured system reminder attachments using raw body content", () => {
    const entries = [
      entry(user("real prompt"), "real_user"),
      attachment("output_style", "style body"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "user", content: "real prompt", cacheControl: { type: "ephemeral" } },
      { role: "system", content: "style body" },
    ]);
    expect(JSON.stringify(result.messages)).not.toContain("<system-reminder>");
    expect(JSON.stringify(result.messages)).not.toContain("output_style");
  });

  it("projects structured prompt attachments as mid-conversation system messages", () => {
    const entries = [
      entry(user("Summarize notes."), "real_user"),
      attachment(
        "prompt_attachment",
        'Called the Read tool with the following input: {"file_path":"notes.md"}',
      ),
      attachment("prompt_attachment", "Result of calling the Read tool:\n1\t# Notes"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      { role: "user", content: "Summarize notes." },
      {
        role: "system",
        content:
          'Called the Read tool with the following input: {"file_path":"notes.md"}\n\nResult of calling the Read tool:\n1\t# Notes',
      },
    ]);
  });

  it("projects MCS-capable attachments as system messages when MCS is explicitly enabled", () => {
    const entries = [
      entry(user("Summarize notes."), "real_user"),
      attachment("prompt_attachment", "Called the Read tool with the following input: {}"),
      attachment("output_style", "Terse output style is active."),
    ] satisfies RuntimeMessageEntry[];

    expect(
      buildProviderRequestMessages({
        entries,
        useMidConversationSystem: true,
      }).messages,
    ).toEqual([
      { role: "user", content: "Summarize notes." },
      {
        role: "system",
        content:
          "Called the Read tool with the following input: {}\n\nTerse output style is active.",
      },
    ]);
  });

  it("projects goal state changes as mid-conversation system messages when MCS is enabled", () => {
    const entries = [
      entry(user("Continue"), "real_user"),
      attachment(
        "goal_state_change",
        "The active session goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.",
      ),
    ] satisfies RuntimeMessageEntry[];

    expect(
      buildProviderRequestMessages({
        entries,
        useMidConversationSystem: true,
      }).messages,
    ).toEqual([
      { role: "user", content: "Continue" },
      {
        role: "system",
        content:
          "The active session goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.",
      },
    ]);
  });

  it("falls back goal state changes to user system reminders when MCS is disabled", () => {
    const entries = [
      entry(user("Continue"), "real_user"),
      attachment(
        "goal_state_change",
        "The session goal has been cleared. Do not continue pursuing any previous goal unless the user sets a new goal.",
      ),
    ] satisfies RuntimeMessageEntry[];

    expect(
      buildProviderRequestMessages({
        entries,
        useMidConversationSystem: false,
      }).messages,
    ).toEqual([
      { role: "user", content: "Continue" },
      {
        role: "user",
        content:
          "<system-reminder>\nThe session goal has been cleared. Do not continue pursuing any previous goal unless the user sets a new goal.\n</system-reminder>",
      },
    ]);
  });

  it("does not bubble a goal state change before an older target continuation", () => {
    const pauseReminder =
      "The active session goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.";
    const entries = [
      entry(user("Original goal"), "real_user"),
      entry(user("Continue working toward the active session goal."), "target_continuation"),
      attachment("goal_state_change", pauseReminder),
      entry(user("Follow-up after Stop"), "real_user"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({
      entries,
      useMidConversationSystem: false,
    });

    expect(result.messages).toEqual([
      { role: "user", content: "Original goal" },
      { role: "user", content: "Continue working toward the active session goal." },
      {
        role: "user",
        content: `<system-reminder>\n${pauseReminder}\n</system-reminder>`,
      },
      { role: "user", content: "Follow-up after Stop" },
    ]);
    expect(result.diagnostics.bubbledAttachmentEntryCount).toBe(0);
  });

  it("renders MCS-capable attachments as legacy user system reminders when MCS is disabled", () => {
    const entries = [
      entry(user("Summarize notes."), "real_user"),
      attachment("prompt_attachment", "Called the Read tool with the following input: {}"),
    ] satisfies RuntimeMessageEntry[];

    expect(
      buildProviderRequestMessages({
        entries,
        useMidConversationSystem: false,
      }).messages,
    ).toEqual([
      {
        role: "user",
        content:
          "<system-reminder>\nCalled the Read tool with the following input: {}\n</system-reminder>",
      },
      { role: "user", content: "Summarize notes." },
    ]);
  });

  it("applies attachment bubble ordering before MCS projection", () => {
    const entries = [
      entry(user("Real query"), "real_user"),
      attachment("output_style", "Style body"),
      entry(assistant("Answer")),
    ] satisfies RuntimeMessageEntry[];

    const legacy = buildProviderRequestMessages({
      entries,
      useMidConversationSystem: false,
    }).messages;
    expect(legacy.map((message) => message.role)).toEqual(["user", "user", "assistant"]);
    expect(String(legacy[0]?.content)).toContain("Style body");
    expect(legacy[1]?.content).toBe("Real query");

    const mcs = buildProviderRequestMessages({
      entries,
      useMidConversationSystem: true,
    });
    expect(mcs.messages.map((message) => message.role)).toEqual(["user", "system", "assistant"]);
    expect(mcs.messages[0]?.content).toBe("Real query");
    expect(mcs.messages[1]?.content).toBe("Style body");
    expect(mcs.diagnostics.bubbledAttachmentEntryCount).toBe(1);
  });

  it("keeps target verifier prompts as plain user messages while projecting history attachments", () => {
    const entries = [
      entry(user("original goal turn"), "real_user"),
      attachment("output_style", "Use verifier style."),
      entry(user("Verify whether the active goal is complete.")),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "user", content: "original goal turn" },
      {
        role: "user",
        content: "Verify whether the active goal is complete.",
        cacheControl: { type: "ephemeral" },
      },
      {
        role: "system",
        content: "Use verifier style.",
      },
    ]);
    expect(JSON.stringify(result.messages)).not.toContain("output_style");
    expect(JSON.stringify(result.messages)).not.toContain("goal_completion_verification");
  });

  it("does not project legacy message entries just because their source is eligible", () => {
    const entries = [
      entry(user("real prompt"), "real_user"),
      entry(user("style body"), "output_style"),
      entry(user("<system-reminder>\ntodo\n</system-reminder>"), "todo_reminder"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      { role: "user", content: "real prompt" },
      { role: "user", content: "style body" },
      { role: "user", content: "<system-reminder>\ntodo\n</system-reminder>" },
    ]);
  });

  it("moves skills listing after the first real user as a system message", () => {
    const entries = [
      entry({ role: "system", content: "prefix" }),
      attachment("skills_listing", "skills"),
      attachment("context_prefix", "# currentDate\nToday"),
      entry(user("real prompt"), "real_user"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "system", content: "prefix" },
      {
        role: "user",
        content: "<system-reminder>\n# currentDate\nToday\n</system-reminder>\n",
      },
      {
        role: "user",
        content: "real prompt",
        cacheControl: { type: "ephemeral" },
      },
      { role: "system", content: "skills" },
    ]);
    expect(result.diagnostics.cacheControlIndex).toBe(2);
    expect(result.diagnostics.latestRealUserMessageIndex).toBe(2);
  });

  it("projects non-context meta reminders to system without moving context prefix", () => {
    const entries = [
      entry(user("follow up"), "real_user"),
      attachment("runtime_mode", "mode"),
      attachment("todo_reminder", "todo"),
      attachment("output_style", "style"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "user", content: "follow up", cacheControl: { type: "ephemeral" } },
      { role: "system", content: "mode\n\ntodo\n\nstyle" },
    ]);
    expect(result.diagnostics.bubbledAttachmentEntryCount).toBe(3);
    expect(result.diagnostics.cacheControlIndex).toBe(0);
    expect(result.diagnostics.latestRealUserMessageIndex).toBe(0);
  });

  it("keeps the same real user anchor open for prefix and current-turn system projections", () => {
    const entries = [
      attachment("skills_listing", "skills"),
      entry(user("real prompt"), "real_user"),
      attachment("output_style", "style"),
      entry(assistant("assistant response")),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      { role: "user", content: "real prompt" },
      { role: "system", content: "skills\n\nstyle" },
      { role: "assistant", content: "assistant response" },
    ]);
  });

  it("projects current-turn attachment reminders to system without crossing assistant boundaries", () => {
    const entries = [
      entry(assistant("previous response")),
      entry(user("follow-up prompt"), "real_user"),
      attachment("relevant_memory", "memory reminder"),
      attachment("runtime_mode", "runtime mode reminder"),
      entry(assistant("next response")),
      entry(user("later prompt"), "real_user"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      { role: "assistant", content: "previous response" },
      { role: "user", content: "follow-up prompt" },
      { role: "system", content: "memory reminder\n\nruntime mode reminder" },
      { role: "assistant", content: "next response" },
      { role: "user", content: "later prompt" },
    ]);
    expect(result.diagnostics.bubbledAttachmentEntryCount).toBe(2);
  });

  it("places cache-control on the latest non-system message after projection", () => {
    const entries = [
      entry(user("inspect the repo"), "real_user"),
      entry(assistant("used Read")),
      entry(toolResult("read result")),
      entry(user("output style reminder"), "output_style"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "user", content: "inspect the repo" },
      { role: "assistant", content: "used Read" },
      {
        role: "tool",
        content: "read result",
        toolCallId: "tool-1",
        toolName: "Read",
      },
      {
        role: "user",
        content: "output style reminder",
        cacheControl: { type: "ephemeral" },
      },
    ]);
    expect(result.diagnostics.cacheControlIndex).toBe(3);
    expect(result.diagnostics.latestRealUserMessageIndex).toBe(0);
  });

  it("keeps plugin reference after the user while placing cache-control on that user", () => {
    const entries = [
      entry(user("use the plugin"), "real_user"),
      attachment("plugin_reference", "<plugin_reference>demo</plugin_reference>"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      {
        role: "user",
        content: "use the plugin",
        cacheControl: { type: "ephemeral" },
      },
      {
        role: "system",
        content: "<plugin_reference>demo</plugin_reference>",
      },
    ]);
    expect(result.diagnostics.cacheControlIndex).toBe(0);
    expect(result.diagnostics.latestRealUserMessageIndex).toBe(0);
  });

  it("moves cache-control before the latest message when cache write is skipped", () => {
    const entries = [
      entry(user("inspect the repo"), "real_user"),
      entry(assistant("summarizable response")),
      entry(user("compact prompt")),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({
      entries,
      applyCacheControl: true,
      skipCacheWrite: true,
    });

    expect(result.messages).toEqual([
      { role: "user", content: "inspect the repo" },
      {
        role: "assistant",
        content: "summarizable response",
        cacheControl: { type: "ephemeral" },
      },
      { role: "user", content: "compact prompt" },
    ]);
    expect(result.diagnostics.cacheControlIndex).toBe(1);
  });

  it("places cache-control on a tool message when it is the latest non-system message", () => {
    const entries = [
      entry(user("inspect the repo"), "real_user"),
      entry(assistant("used Read")),
      entry(toolResult("read result")),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "user", content: "inspect the repo" },
      { role: "assistant", content: "used Read" },
      {
        role: "tool",
        content: "read result",
        toolCallId: "tool-1",
        toolName: "Read",
        cacheControl: { type: "ephemeral" },
      },
    ]);
    expect(result.diagnostics.cacheControlIndex).toBe(2);
  });

  it("projects a todo reminder after a tool result as mid-conversation system", () => {
    const entries = [
      entry(user("inspect the repo"), "real_user"),
      entry(assistant("used Read")),
      entry(toolResult("read result")),
      attachment("todo_reminder", "todo body"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "user", content: "inspect the repo" },
      { role: "assistant", content: "used Read" },
      {
        role: "tool",
        content: "read result",
        toolCallId: "tool-1",
        toolName: "Read",
        cacheControl: { type: "ephemeral" },
      },
      { role: "system", content: "todo body" },
    ]);
    expect(JSON.stringify(result.messages)).not.toContain("<system-reminder>");
    expect(result.diagnostics.cacheControlIndex).toBe(2);
  });

  it("delays a pending mid-conversation system reminder until sibling tool results complete", () => {
    const entries = [
      entry(user("inspect the repo"), "real_user"),
      entry(assistant("issued parallel tools")),
      entry(toolResult("read result", "tool-1", "Read")),
      attachment("todo_reminder", "todo body"),
      entry(toolResult("grep result", "tool-2", "Grep")),
      entry(toolResult("glob result", "tool-3", "Glob")),
      entry(assistant("next answer")),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      { role: "user", content: "inspect the repo" },
      { role: "assistant", content: "issued parallel tools" },
      {
        role: "tool",
        content: "read result",
        toolCallId: "tool-1",
        toolName: "Read",
      },
      {
        role: "tool",
        content: "grep result",
        toolCallId: "tool-2",
        toolName: "Grep",
      },
      {
        role: "tool",
        content: "glob result",
        toolCallId: "tool-3",
        toolName: "Glob",
      },
      { role: "system", content: "todo body" },
      { role: "assistant", content: "next answer" },
    ]);
    expect(JSON.stringify(result.messages)).not.toContain("<system-reminder>");
  });

  it("keeps legacy reminder text after sibling tool results when MCS is disabled", () => {
    const entries = [
      entry(user("inspect the repo"), "real_user"),
      entry(assistant("issued parallel tools")),
      entry(toolResult("read result", "tool-1", "Read")),
      attachment("todo_reminder", "todo body"),
      entry(toolResult("grep result", "tool-2", "Grep")),
      entry(toolResult("glob result", "tool-3", "Glob")),
      entry(assistant("next answer")),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({
      entries,
      useMidConversationSystem: false,
    });

    expect(result.messages).toEqual([
      { role: "user", content: "inspect the repo" },
      { role: "assistant", content: "issued parallel tools" },
      {
        role: "tool",
        content: "read result",
        toolCallId: "tool-1",
        toolName: "Read",
      },
      {
        role: "tool",
        content: "grep result",
        toolCallId: "tool-2",
        toolName: "Grep",
      },
      {
        role: "tool",
        content: "glob result",
        toolCallId: "tool-3",
        toolName: "Glob",
      },
      {
        role: "user",
        content: "<system-reminder>\ntodo body\n</system-reminder>",
      },
      { role: "assistant", content: "next answer" },
    ]);
  });

  it("keeps a todo reminder anchored after its tool result when later tool exchanges are appended", () => {
    const entries = [
      entry(user("inspect the repo"), "real_user"),
      entry(assistant("used Read")),
      entry(toolResult("read result")),
      attachment("todo_reminder", "todo body"),
      entry(assistant("used Grep")),
      {
        message: {
          role: "tool",
          content: "grep result",
          toolCallId: "tool-2",
          toolName: "Grep",
        },
      },
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "user", content: "inspect the repo" },
      { role: "assistant", content: "used Read" },
      {
        role: "tool",
        content: "read result",
        toolCallId: "tool-1",
        toolName: "Read",
      },
      { role: "system", content: "todo body" },
      { role: "assistant", content: "used Grep" },
      {
        role: "tool",
        content: "grep result",
        toolCallId: "tool-2",
        toolName: "Grep",
        cacheControl: { type: "ephemeral" },
      },
    ]);
  });

  it("projects a todo reminder after an Anthropic-style tool-result user message", () => {
    const entries = [
      entry(user("inspect the repo"), "real_user"),
      entry(assistant("used Read")),
      entry(toolResultUser("read result")),
      attachment("todo_reminder", "todo body"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "user", content: "inspect the repo" },
      { role: "assistant", content: "used Read" },
      {
        role: "user",
        content: [{ type: "text", text: "read result" }],
        toolCallId: "tool-1",
        toolName: "Read",
        cacheControl: { type: "ephemeral" },
      },
      { role: "system", content: "todo body" },
    ]);
  });

  it("keeps a pending mid-conversation system reminder after a following user message", () => {
    const entries = [
      entry(user("first prompt"), "real_user"),
      attachment("output_style", "style body"),
      entry(user("second prompt"), "target_continuation"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      { role: "user", content: "first prompt" },
      { role: "user", content: "second prompt" },
      { role: "system", content: "style body" },
    ]);
  });

  it("does not treat a mid-conversation system fallback as latest real user", () => {
    const entries = [
      entry(assistant("used Read")),
      entry(toolResult("read result")),
      attachment("output_style", "style body"),
      entry({ role: "system", content: "stable system" }),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "assistant", content: "used Read" },
      {
        role: "tool",
        content: "read result",
        toolCallId: "tool-1",
        toolName: "Read",
      },
      {
        role: "user",
        content: "<system-reminder>\nstyle body\n</system-reminder>",
        cacheControl: { type: "ephemeral" },
      },
      { role: "system", content: "stable system" },
    ]);
    expect(result.diagnostics.latestRealUserMessageIndex).toBeUndefined();
  });

  it("places cache-control on an assistant message when it is the latest non-system message", () => {
    const entries = [
      entry(user("first prompt"), "real_user"),
      entry(assistant("assistant answer")),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      { role: "user", content: "first prompt" },
      {
        role: "assistant",
        content: "assistant answer",
        cacheControl: { type: "ephemeral" },
      },
    ]);
    expect(result.diagnostics.cacheControlIndex).toBe(1);
  });

  it("preserves system cache-control and clears stale non-system cache-control", () => {
    const entries = [
      {
        message: {
          role: "system",
          content: "stable system",
          cacheControl: { type: "ephemeral" },
        },
      },
      entry({ ...user("first prompt"), cacheControl: { type: "ephemeral" } }, "real_user"),
      entry({ ...assistant("assistant answer"), cacheControl: { type: "ephemeral" } }),
      entry(toolResult("read result")),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(result.messages).toEqual([
      {
        role: "system",
        content: "stable system",
        cacheControl: { type: "ephemeral" },
      },
      { role: "user", content: "first prompt" },
      { role: "assistant", content: "assistant answer" },
      {
        role: "tool",
        content: "read result",
        toolCallId: "tool-1",
        toolName: "Read",
        cacheControl: { type: "ephemeral" },
      },
    ]);
    expect(result.diagnostics.cacheControlIndex).toBe(3);
  });

  it("does not bubble attachment-like reminders across tool-result user boundaries", () => {
    const entries = [
      entry(assistant("assistant used a tool")),
      entry(toolResultUser()),
      entry(user("memory reminder"), "relevant_memory"),
      entry(user("next real prompt"), "real_user"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      { role: "assistant", content: "assistant used a tool" },
      {
        role: "user",
        content: [{ type: "text", text: "tool result" }],
        toolCallId: "tool-1",
        toolName: "Read",
      },
      { role: "user", content: "memory reminder" },
      { role: "user", content: "next real prompt" },
    ]);
  });

  it("treats literal system-reminder user text as real input when metadata says real_user", () => {
    const entries = [
      entry(user("<system-reminder>\nthis is user-provided text\n</system-reminder>"), "real_user"),
      entry(user("mode reminder"), "runtime_mode"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      {
        role: "user",
        content: "<system-reminder>\nthis is user-provided text\n</system-reminder>",
      },
      { role: "user", content: "mode reminder" },
    ]);
  });

  it("keeps direct pasted image blocks in their original real-user content order", () => {
    const entries = [
      entry(
        user([
          { type: "text", text: "Please inspect this screenshot." },
          { type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,paste" },
        ]),
        "real_user",
      ),
      entry(user("output style reminder"), "output_style"),
    ] satisfies RuntimeMessageEntry[];

    const result = buildProviderRequestMessages({ entries });

    expect(result.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Please inspect this screenshot." },
          { type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,paste" },
        ],
      },
      { role: "user", content: "output style reminder" },
    ]);
  });

  it("is deterministic, idempotent, and does not mutate frozen runtime entries", () => {
    const entries = deepFreeze([
      {
        message: {
          role: "user",
          content: [
            { type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,abc" },
            { type: "text", text: "image context" },
          ],
        },
        metadata: systemReminderRuntimeMetadata("prompt_attachment"),
      },
      {
        message: {
          role: "user",
          content: "real prompt",
          cacheControl: { type: "ephemeral" },
        },
        metadata: realUserRuntimeMetadata(),
      },
    ] satisfies RuntimeMessageEntry[]);

    const first = buildProviderRequestMessages({ entries, applyCacheControl: true });
    const second = buildProviderRequestMessages({ entries, applyCacheControl: true });
    const projectedAgain = buildProviderRequestMessages({
      entries: first.messages.map((message) => ({ message })),
      applyCacheControl: true,
    });

    expect(first).toEqual(second);
    expect(projectedAgain.messages).toEqual(first.messages);
    expect(first.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,abc" },
          { type: "text", text: "image context" },
        ],
      },
      {
        role: "user",
        content: "real prompt",
        cacheControl: { type: "ephemeral" },
      },
    ]);
  });

  it("returns request messages detached from runtime message objects", () => {
    const inputMessage: ModelInputMessage = {
      role: "assistant",
      content: [{ type: "text", text: "original answer" }],
      cacheControl: { type: "ephemeral" },
      toolCalls: [{ id: "tool-1", name: "Read", input: { file_path: "notes.md" } }],
    };
    const entries = [{ message: inputMessage }] satisfies RuntimeMessageEntry[];

    const projectedMessage = buildProviderRequestMessages({ entries }).messages[0]!;

    expect(projectedMessage).not.toBe(inputMessage);
    expect(projectedMessage.content).not.toBe(inputMessage.content);
    expect(projectedMessage.cacheControl).not.toBe(inputMessage.cacheControl);
    expect(projectedMessage.toolCalls).not.toBe(inputMessage.toolCalls);

    if (typeof projectedMessage.content !== "string") {
      const textBlock = projectedMessage.content[0];
      if (textBlock?.type === "text") textBlock.text = "mutated answer";
    }
    projectedMessage.toolCalls![0]!.name = "Write";
    projectedMessage.cacheControl = undefined;

    expect(inputMessage).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "original answer" }],
      cacheControl: { type: "ephemeral" },
      toolCalls: [{ id: "tool-1", name: "Read", input: { file_path: "notes.md" } }],
    });
  });
});
