import { describe, expect, it } from "vitest";
import { createSessionId } from "@zcode/contracts";
import {
  RUNTIME_MODE_REMINDER_CONFIG,
  TODO_REMINDER_CONFIG,
  buildDateChangeReminderBody,
  buildPlanModeExitReminderBody,
  buildRuntimeModeReminderBody,
  buildRuntimeOutputStyleReminderBody,
  buildTodoReminderBody,
  buildProviderRequestMessages,
  buildRepeatedToolCallReminderBody,
  buildToolCallBudgetReminderBody,
  formatConversationForkNoticeBody,
  getTodoReminderTurnCounts,
  runtimeMetadataForSyntheticUserMessageSource,
  shouldBuildTodoReminder,
} from "../src/runtime/helpers/index.js";
import {
  legacySyntheticRuntimeMetadata,
  realUserRuntimeMetadata,
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../src/agent/message-history.js";
import { buildCompactSummaryRequestMessages } from "../src/runtime/methods/compact-active-helpers.js";

describe("runtime request reminders", () => {
  it("maps a subagent message to direct user-like runtime metadata", () => {
    expect(runtimeMetadataForSyntheticUserMessageSource("subagent_message")).toEqual(
      legacySyntheticRuntimeMetadata(),
    );
  });

  it("maps a persisted plugin reference back to its attachment source", () => {
    expect(runtimeMetadataForSyntheticUserMessageSource("plugin_reference")).toEqual({
      source: "plugin_reference",
    });
  });

  it("builds a one-time plan mode exit reminder", () => {
    const body = buildPlanModeExitReminderBody();

    expect(body).toContain("## Exited Plan Mode");
    expect(body).toContain("You can now make edits");
    expect(body).not.toContain("<system-reminder>");
    expect(body).not.toContain("source=");
  });

  it("counts assistant turns since the latest TodoWrite and todo reminder markers", () => {
    const entries = [
      { message: { role: "user" as const, content: "start" }, metadata: realUserRuntimeMetadata() },
      {
        message: {
          role: "assistant" as const,
          content: "",
          toolCalls: [{ id: "todo-write-1", name: "TodoWrite", input: {} }],
        },
      },
      { message: { role: "tool" as const, content: "ok", toolCallId: "todo-write-1", toolName: "TodoWrite" } },
      { message: { role: "assistant" as const, content: "after write 1" } },
      {
        message: { role: "user" as const, content: "todo reminder" },
        metadata: { source: "todo_reminder" as const },
      },
      { message: { role: "assistant" as const, content: "after reminder 1" } },
      { message: { role: "assistant" as const, content: "after reminder 2" } },
    ];

    expect(getTodoReminderTurnCounts(entries)).toEqual({
      turnsSinceLastReminder: 2,
      turnsSinceLastTodoWrite: 3,
    });
  });

  it("stops scanning todo cadence history once both latest markers are found", () => {
    const entries: RuntimeMessageEntry[] = [
      { message: { role: "assistant", content: "old assistant turn" } },
      { message: { role: "assistant", content: "older assistant turn" } },
      {
        message: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "todo-write-latest", name: "TodoWrite", input: {} }],
        },
      },
      {
        message: { role: "user", content: "latest todo reminder" },
        metadata: { source: "todo_reminder" },
      },
      { message: { role: "assistant", content: "newer assistant turn" } },
    ];
    const guardedEntries = new Proxy(entries, {
      get(target, property, receiver) {
        if (property === "0" || property === "1") {
          throw new Error("older history should not be read after both todo markers are found");
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(getTodoReminderTurnCounts(guardedEntries)).toEqual({
      turnsSinceLastReminder: 1,
      turnsSinceLastTodoWrite: 1,
    });
  });

  it("treats sessions without TodoWrite or prior todo reminders as counting from the start", () => {
    const entries = Array.from({ length: TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE }, (_, index) => ({
      message: { role: "assistant" as const, content: `assistant turn ${index}` },
    }));

    expect(getTodoReminderTurnCounts(entries)).toEqual({
      turnsSinceLastReminder: TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS,
      turnsSinceLastTodoWrite: TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE,
    });
  });

  it("resets todo cadence when TodoWrite appears in a recent assistant turn", () => {
    const entries = [
      { message: { role: "assistant" as const, content: "old assistant 1" } },
      {
        message: {
          role: "assistant" as const,
          content: "",
          toolCalls: [{ id: "todo-write-recent", name: "TodoWrite", input: {} }],
        },
      },
      { message: { role: "tool" as const, content: "ok", toolCallId: "todo-write-recent", toolName: "TodoWrite" } },
      { message: { role: "assistant" as const, content: "recent assistant" } },
    ];

    expect(getTodoReminderTurnCounts(entries)).toMatchObject({
      turnsSinceLastTodoWrite: 1,
    });
  });

  it("allows another todo reminder when the previous marker is old enough", () => {
    const entries = [
      {
        message: { role: "user" as const, content: "old todo reminder" },
        metadata: { source: "todo_reminder" as const },
      },
      ...Array.from({ length: TODO_REMINDER_CONFIG.TURNS_BETWEEN_REMINDERS }, (_, index) => ({
        message: { role: "assistant" as const, content: `assistant turn ${index}` },
      })),
    ];

    expect(shouldBuildTodoReminder(entries)).toBe(true);
  });

  it("omits todo list details when a due reminder has no current todos", () => {
    const body = buildTodoReminderBody([]);
    expect(body).toContain("The TodoWrite tool hasn't been used recently.");
    expect(body).not.toContain("<system-reminder>");
    expect(body).toContain("Only use it if it's relevant to the current work.");
    expect(body).toContain("ignore if not applicable");
    expect(body).not.toContain("Here are the existing contents of your todo list:");
    expect(body).not.toContain("[pending]");
  });

  it("builds an aligned todo reminder without the old authoritative todo_state wording", () => {
    const body = buildTodoReminderBody([
      {
        content: "Review prompt trajectory output",
        priority: "high",
        status: "in_progress",
      },
    ]);
    expect(body).toContain("1. [in_progress] Review prompt trajectory output");
    expect(body).not.toContain("<system-reminder>");
    expect(body).toContain("The TodoWrite tool hasn't been used recently.");
    expect(body).toContain("Only use it if it's relevant to the current work.");
    expect(body).toContain("ignore if not applicable");
    expect(body).toContain("Here are the existing contents of your todo list:");
    expect(body).not.toContain("Current session todo state (authoritative):");
    expect(body).not.toContain("source=");
  });

  it("builds date change reminder with no-user-mention wording", () => {
    const body = buildDateChangeReminderBody("2026-06-03", "2026-06-04");
    expect(body).toContain("The date has changed. Today's date is now 2026-06-04.");
    expect(body).not.toContain("<system-reminder>");
    expect(body).toContain("DO NOT mention this to the user explicitly");
    expect(body).not.toContain("from 2026-06-03 to 2026-06-04");
  });

  it("escapes nested system reminder-like text in conversation fork notices", () => {
    const body = formatConversationForkNoticeBody({
      parentSessionId: createSessionId("parent-<system-reminder>") as never,
      targetMessageId: "message-</system-reminder>" as never,
    });
    expect(body).not.toContain("<system-reminder>");
    expect(body).not.toContain("</system-reminder>");

    expect(body).toContain("parentSessionId: sess_parent-&lt;system-reminder>");
    expect(body).toContain("targetMessageId: message-&lt;/system-reminder>");
  });

  it("builds output style reminder only for non-empty active style", () => {
    expect(buildRuntimeOutputStyleReminderBody(undefined)).toBeNull();
    expect(
      buildRuntimeOutputStyleReminderBody({
        name: "Default",
        prompt: "   ",
      }),
    ).toBeNull();

    const body = buildRuntimeOutputStyleReminderBody({
      name: "Learning",
      prompt: "Explain tradeoffs while solving the task.",
    });

    expect(body).toBe("Learning output style is active. Remember to follow the specific guidelines for this style.");
    expect(body).toContain("Learning output style is active");
    expect(body).not.toContain("Explain tradeoffs while solving the task.");
    expect(body).not.toContain("<system-reminder>");
    expect(body).not.toContain("source=");
  });

  it("builds plan mode reminders with human-turn cadence and full/sparse cycle", () => {
    const firstBody = buildRuntimeModeReminderBody(
      [{ message: { role: "user", content: "make a plan" }, metadata: realUserRuntimeMetadata() }],
      "plan",
    );
    expect(firstBody).toContain("Plan mode is active");
    expect(firstBody).not.toContain("<system-reminder>");

    expect(firstBody).toContain("MUST NOT make any edits");
    expect(firstBody).toContain("## Plan Workflow");
    expect(firstBody).not.toContain("ExitPlanModeV2");

    const recent = buildRuntimeModeReminderBody(
      [
        {
          message: { role: "user", content: "old full plan reminder" },
          metadata: { source: "runtime_mode" },
        },
        ...Array.from(
          { length: RUNTIME_MODE_REMINDER_CONFIG.TURNS_BETWEEN_ATTACHMENTS - 1 },
          (_, index) => ({
            message: { role: "user" as const, content: `follow up ${index}` },
            metadata: realUserRuntimeMetadata(),
          }),
        ),
      ],
      "plan",
    );
    expect(recent).toBeNull();

    const sparse = buildRuntimeModeReminderBody(
      [
        {
          message: { role: "user", content: "old full plan reminder" },
          metadata: { source: "runtime_mode" },
        },
        ...Array.from(
          { length: RUNTIME_MODE_REMINDER_CONFIG.TURNS_BETWEEN_ATTACHMENTS },
          (_, index) => ({
            message: { role: "user" as const, content: `follow up ${index}` },
            metadata: realUserRuntimeMetadata(),
          }),
        ),
      ],
      "plan",
    );
    expect(sparse).toContain("Plan mode still active");
    expect(sparse).toContain("Read-only.");
    expect(sparse).not.toContain("## Plan Workflow");
    expect(sparse).not.toContain("<system-reminder>");

    const nextFull = buildRuntimeModeReminderBody(
      [
        ...Array.from(
          { length: RUNTIME_MODE_REMINDER_CONFIG.FULL_REMINDER_EVERY_N_ATTACHMENTS },
          (_, index) => ({
            message: { role: "user" as const, content: `prior runtime reminder ${index}` },
            metadata: { source: "runtime_mode" as const },
          }),
        ),
        ...Array.from(
          { length: RUNTIME_MODE_REMINDER_CONFIG.TURNS_BETWEEN_ATTACHMENTS },
          (_, index) => ({
            message: { role: "user" as const, content: `later follow up ${index}` },
            metadata: realUserRuntimeMetadata(),
          }),
        ),
      ],
      "plan",
    );
    expect(nextFull).toContain("Plan mode is active");

    expect(buildRuntimeModeReminderBody([], "build")).toBeNull();
  });

  it("builds model anomaly reminder bodies without wrapping", () => {
    const budgetBody = buildToolCallBudgetReminderBody(42);
    const repeatedBody = buildRepeatedToolCallReminderBody("Read", 3);

    expect(budgetBody).toContain("This turn has already made 42 tool calls.");
    expect(repeatedBody).toContain("You have called Read with the same input 3 times in a row.");
    expect(budgetBody).not.toContain("<system-reminder>");
    expect(repeatedBody).not.toContain("<system-reminder>");
  });

  it("uses metadata instead of system-reminder text to find the latest real user", () => {
    const entries: RuntimeMessageEntry[] = [
      { message: { role: "system", content: "system prompt" } },
      {
        message: {
          role: "user",
          content: "<system-reminder>\nuser typed this literal tag\n</system-reminder>",
        },
        metadata: realUserRuntimeMetadata(),
      },
    ];

    const { messages } = buildProviderRequestMessages({ entries, applyCacheControl: true });
    expect(messages.at(-1)).toMatchObject({
      role: "user",
      cacheControl: { type: "ephemeral" },
    });
  });

  it("bubbles legacy synthetic system-reminder text before latest non-system cache-control finalization", () => {
    const entries: RuntimeMessageEntry[] = [
      {
        message: {
          role: "user",
          content: "<system-reminder>\nuser typed this literal tag\n</system-reminder>",
        },
        metadata: realUserRuntimeMetadata(),
      },
      {
        message: {
          role: "user",
          content: "<system-reminder>\nlegacy synthetic reminder\n</system-reminder>",
        },
        metadata: legacySyntheticRuntimeMetadata(),
      },
    ];

    const { messages } = buildProviderRequestMessages({ entries, applyCacheControl: true });

    expect(messages).toEqual([
      {
        role: "user",
        content: "<system-reminder>\nlegacy synthetic reminder\n</system-reminder>",
      },
      {
        role: "user",
        content: "<system-reminder>\nuser typed this literal tag\n</system-reminder>",
        cacheControl: { type: "ephemeral" },
      },
    ]);
  });

  it("does not append runtime target reminders to provider request entries", () => {
    const entries: RuntimeMessageEntry[] = [
      { message: { role: "system", content: "system prompt" } },
      {
        message: { role: "user", content: "compare prompts" },
        metadata: realUserRuntimeMetadata(),
      },
      {
        message: {
          role: "user",
          content: "<system-reminder>\nPlan mode is active\n</system-reminder>",
        },
        metadata: { source: "runtime_mode" },
      },
    ];

    expect(entries).toHaveLength(3);
    expect(entries[1]).toMatchObject({
      message: {
        role: "user",
        content: "compare prompts",
      },
    });
    expect(entries[1]?.message).not.toHaveProperty("cacheControl");

    const { messages } = buildProviderRequestMessages({ entries, applyCacheControl: true });
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({
      role: "user",
      content: "compare prompts",
    });
    expect(messages[2]).toMatchObject({
      role: "user",
      cacheControl: { type: "ephemeral" },
    });

    expect(JSON.stringify(messages[2]?.content)).toContain("Plan mode is active");
    const reminderTexts = String(JSON.stringify(messages));
    expect(reminderTexts).toContain("compare prompts");
    expect(reminderTexts).not.toContain("Current session goal state");
    expect(reminderTexts).not.toContain("Review prompt trajectory output");
    expect(JSON.stringify(messages)).not.toContain("projectionPolicy");
  });

  it("projects compact summary requests with attachment ordering and skipped cache write", () => {
    const messages = buildCompactSummaryRequestMessages(
      [
        { message: { role: "system", content: "system prompt" } },
        {
          message: { role: "user", content: "<system-reminder>\nprefix\n</system-reminder>" },
          metadata: { source: "context_prefix" },
        },
        {
          message: { role: "user", content: "summarize this history" },
          metadata: realUserRuntimeMetadata(),
        },
        systemReminderAttachmentEntry("output_style", "Use concise output for this turn."),
      ],
      "Create compact summary.",
    );

    expect(messages).toHaveLength(5);
    expect(messages[1]).toEqual({
      role: "user",
      content: "<system-reminder>\nprefix\n</system-reminder>",
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: "summarize this history",
      cacheControl: { type: "ephemeral" },
    });
    expect(messages[3]).toMatchObject({
      role: "user",
    });
    expect(messages[3]).not.toHaveProperty("cacheControl");
    expect(messages[4]).toEqual({
      role: "system",
      content: "Use concise output for this turn.",
    });
    expect(JSON.stringify(messages[3]?.content)).toContain("Create compact summary.");
    expect(JSON.stringify(messages)).not.toContain("output_style");
  });

  it("keeps a trailing newline after the request user context system-reminder close tag", () => {
    const { messages } = buildProviderRequestMessages({
      entries: [
        { message: { role: "system", content: "system prompt" } },
        systemReminderAttachmentEntry(
          "context_prefix",
          "As you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is 2026-06-28.",
        ),
        { message: { role: "user", content: "hello" }, metadata: realUserRuntimeMetadata() },
      ],
    });

    expect(messages[1]).toEqual({
      role: "user",
      content:
        "<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# currentDate\nToday's date is 2026-06-28.\n</system-reminder>\n",
    });
  });
});
