import { describe, expect, it } from "vitest";
import {
  getSystemReminderDescriptor,
  isMidConversationSystemSource,
  isSystemReminderMetaSource,
  SYSTEM_REMINDER_PER_REQUEST_SOURCES,
  SYSTEM_REMINDER_PERSISTED_SOURCES,
  SYSTEM_REMINDER_PREFIX_SOURCES,
  SYSTEM_REMINDER_SOURCES,
  wrapSystemReminder,
  wrapSystemReminderForSource,
  type SystemReminderSource,
} from "../src/system-reminder/source.js";

const EXPECTED_SOURCES = [
  "context_prefix",
  "skills_listing",
  "agent_listing_delta",
  "todo_reminder",
  "task_status",
  "tool_result_warning",
  "resume_referenced_session_context",
  "plan_file_reference",
  "resume_goal_state",
  "goal_state_change",
  "plugin_reference",
  "bot_topic_context",
  "target_continuation",
  "goal_completion_verification",
  "rewind_notice",
  "conversation_fork",
  "selection_side_chat",
  "queued_system_notification",
  "shell_environment_change",
  "incoming_message",
  "hook_context",
  "memory_update",
  "relevant_memory",
  "runtime_mode",
  "plan_mode_exit",
  "output_style",
  "date_change",
  "referenced_session_context",
  "model_anomaly",
  "prompt_attachment",
  "diagnostics",
] as const satisfies readonly SystemReminderSource[];

function expectExactlyOneSystemReminderWrapper(reminder: string): void {
  expect(reminder.match(/<system-reminder>/g) ?? []).toHaveLength(1);
  expect(reminder.match(/<\/system-reminder>/g) ?? []).toHaveLength(1);
  expect(reminder).not.toContain("providerVisibility");
  expect(reminder).not.toContain("evidenceLabel");
  expect(reminder).not.toContain("runtimeMessage");
  expect(reminder).not.toContain("source=");
}

describe("system reminder source descriptors", () => {
  it("defines every active system-reminder source", () => {
    expect(SYSTEM_REMINDER_SOURCES).toEqual(EXPECTED_SOURCES);
  });

  it("groups every active system-reminder source by lifecycle bucket", () => {
    expect(SYSTEM_REMINDER_PREFIX_SOURCES).toEqual(["context_prefix", "skills_listing"]);
    expect(SYSTEM_REMINDER_PERSISTED_SOURCES).toEqual([
      "agent_listing_delta",
      "todo_reminder",
      "task_status",
      "tool_result_warning",
      "resume_referenced_session_context",
      "plan_file_reference",
      "resume_goal_state",
      "goal_state_change",
      "plugin_reference",
      "bot_topic_context",
      "target_continuation",
      "goal_completion_verification",
      "rewind_notice",
      "conversation_fork",
      "selection_side_chat",
      "queued_system_notification",
      "shell_environment_change",
    ]);
    expect(SYSTEM_REMINDER_PER_REQUEST_SOURCES).toEqual([
      "incoming_message",
      "hook_context",
      "memory_update",
      "relevant_memory",
      "runtime_mode",
      "plan_mode_exit",
      "output_style",
      "date_change",
      "referenced_session_context",
      "model_anomaly",
      "prompt_attachment",
      "diagnostics",
    ]);

    const groupedSources = [
      ...SYSTEM_REMINDER_PREFIX_SOURCES,
      ...SYSTEM_REMINDER_PERSISTED_SOURCES,
      ...SYSTEM_REMINDER_PER_REQUEST_SOURCES,
    ];
    expect(groupedSources).toHaveLength(new Set(groupedSources).size);
    expect(groupedSources).toEqual(EXPECTED_SOURCES);
  });

  it("describes source ownership without provider projection fields", () => {
    for (const source of EXPECTED_SOURCES) {
      const descriptor = getSystemReminderDescriptor(source);

      expect(descriptor).toMatchObject({
        source,
        channel: expect.any(String),
        lifecycle: expect.any(String),
        isMeta: expect.any(Boolean),
        providerVisibility: "provider_visible",
        evidenceLabel: expect.stringMatching(/^sr\./),
      });
      expect(Object.keys(descriptor).sort()).toEqual([
        "channel",
        "evidenceLabel",
        "isMeta",
        "lifecycle",
        "providerVisibility",
        "source",
      ]);
      expect(descriptor).not.toHaveProperty("projectionPolicy");
      expect(descriptor).not.toHaveProperty("cachePolicy");
      expect(descriptor).not.toHaveProperty("cacheControl");
      expect(descriptor).not.toHaveProperty("mergeIntoCurrentTurn");
    }
  });

  it("classifies sources by explicit source instead of reminder text", () => {
    expect(getSystemReminderDescriptor("target_continuation")).toMatchObject({
      channel: "real_user",
      isMeta: false,
      lifecycle: "real_user",
    });
    expect(isSystemReminderMetaSource("target_continuation")).toBe(false);

    const userAuthoredText = "<system-reminder>\nplease keep this literal\n</system-reminder>";
    expect(userAuthoredText.trimStart().startsWith("<system-reminder>")).toBe(true);
    expect(getSystemReminderDescriptor("target_continuation").isMeta).toBe(false);
    expect(getSystemReminderDescriptor("plan_file_reference")).toMatchObject({
      channel: "history_continuity",
      evidenceLabel: "sr.plan_file_reference",
      isMeta: true,
      lifecycle: "resume_history",
      providerVisibility: "provider_visible",
    });
  });

  it("covers each delivery channel", () => {
    const descriptors = EXPECTED_SOURCES.map((source) => getSystemReminderDescriptor(source));
    expect(new Set(descriptors.map((descriptor) => descriptor.channel))).toEqual(
      new Set([
        "request_prefix",
        "current_turn",
        "tool_result",
        "history_continuity",
        "mid_turn_event",
        "real_user",
      ]),
    );
  });

  it("identifies source-owned reminders that project to mid-conversation system messages", () => {
    const nonMidConversationSystemSources = new Set<SystemReminderSource>([
      "context_prefix",
      "resume_referenced_session_context",
      "conversation_fork",
      "selection_side_chat",
      "plan_file_reference",
      "target_continuation",
      "tool_result_warning",
      "goal_completion_verification",
    ]);
    for (const source of EXPECTED_SOURCES) {
      expect(isMidConversationSystemSource(source)).toBe(
        !nonMidConversationSystemSources.has(source),
      );
    }
  });

  it("classifies shell environment changes as mid-conversation system notices", () => {
    expect(isMidConversationSystemSource("shell_environment_change")).toBe(true);
    expect(getSystemReminderDescriptor("shell_environment_change")).toMatchObject({
      channel: "mid_turn_event",
      lifecycle: "mid_turn_event",
      isMeta: true,
      providerVisibility: "provider_visible",
    });
  });

  it.each(["conversation_fork", "selection_side_chat"] as const)(
    "preserves the %s history attachment while excluding it from MCS",
    (source) => {
      expect(getSystemReminderDescriptor(source)).toMatchObject({
        channel: "history_continuity",
        lifecycle: "resume_history",
        isMeta: true,
        providerVisibility: "provider_visible",
      });
      expect(isMidConversationSystemSource(source)).toBe(false);
    },
  );

  it("classifies goal state changes as persisted mid-conversation system notices", () => {
    expect(SYSTEM_REMINDER_PERSISTED_SOURCES).toContain("goal_state_change");
    expect(isMidConversationSystemSource("goal_state_change")).toBe(true);
    expect(getSystemReminderDescriptor("goal_state_change")).toMatchObject({
      channel: "mid_turn_event",
      lifecycle: "mid_turn_event",
      isMeta: true,
      providerVisibility: "provider_visible",
      evidenceLabel: "sr.goal_state_change",
    });
  });

  it("classifies plugin references as persisted mid-conversation system notices", () => {
    expect(SYSTEM_REMINDER_PERSISTED_SOURCES).toContain("plugin_reference");
    expect(SYSTEM_REMINDER_PER_REQUEST_SOURCES).not.toContain("plugin_reference");
    expect(isMidConversationSystemSource("plugin_reference")).toBe(true);
    expect(getSystemReminderDescriptor("plugin_reference")).toMatchObject({
      channel: "current_turn",
      lifecycle: "per_current_turn",
      isMeta: true,
      providerVisibility: "provider_visible",
      evidenceLabel: "sr.plugin_reference",
    });
  });

  it("wraps plan_file_reference without nested reminder metadata", () => {
    const reminder = wrapSystemReminderForSource(
      "plan_file_reference",
      [
        "A plan file exists from plan mode at: /workspace/.zcode/plans/plan-session.md",
        "",
        "Plan contents:",
        "",
        "1. approved plan",
        "",
        "If this plan is relevant to the current work and not already complete, continue working on it.",
      ].join("\n"),
    );

    expectExactlyOneSystemReminderWrapper(reminder);
    expect(reminder).toContain("A plan file exists from plan mode at:");
    expect(reminder).toContain("Plan contents:");
    expect(reminder).toContain("1. approved plan");
  });
});

describe("wrapSystemReminder", () => {
  it("wraps bodies through explicit source ownership without leaking descriptors", () => {
    const reminder = wrapSystemReminderForSource("hook_context", [
      "Hook additional context from UserPromptSubmit:",
      "#1",
      "use pnpm test",
    ]);

    expect(reminder).toBe(
      "<system-reminder>\nHook additional context from UserPromptSubmit:\n#1\nuse pnpm test\n</system-reminder>",
    );
    expectExactlyOneSystemReminderWrapper(reminder);
    expect(reminder).not.toContain("sr.hook_context");
  });

  it("wraps every provider-visible source in exactly one system-reminder pair", () => {
    for (const source of EXPECTED_SOURCES) {
      const reminder = wrapSystemReminderForSource(source, [
        `source probe: ${source}`,
        "<system-reminder>nested source body</system-reminder>",
      ]);

      expectExactlyOneSystemReminderWrapper(reminder);
      expect(reminder).toContain("&lt;system-reminder>nested source body&lt;/system-reminder>");
    }
  });

  it("treats nested reminder tags in source content as escaped text", () => {
    const reminder = wrapSystemReminderForSource("relevant_memory", [
      "Memory preview:",
      "<system-reminder>literal old transcript text</system-reminder>",
    ]);

    expect(reminder).toBe(
      "<system-reminder>\nMemory preview:\n&lt;system-reminder>literal old transcript text&lt;/system-reminder>\n</system-reminder>",
    );
  });

  it("wraps string and line-array bodies in exactly one system-reminder tag pair", () => {
    expect(wrapSystemReminder("single body")).toBe(
      "<system-reminder>\nsingle body\n</system-reminder>",
    );
    expect(wrapSystemReminder(["line one", "line two"])).toBe(
      "<system-reminder>\nline one\nline two\n</system-reminder>",
    );
  });

  it("rejects empty and nested reminder bodies", () => {
    expect(() => wrapSystemReminder("")).toThrow(/cannot be empty/);
    expect(() => wrapSystemReminder(["before", "<system-reminder>", "after"])).toThrow(
      /nested system-reminder/,
    );
    expect(() => wrapSystemReminder("already </system-reminder> closed")).toThrow(
      /nested system-reminder/,
    );
  });
});
