import { describe, expect, it } from "vitest";
import { createAgentDefinitionsReader } from "../src/subagent/definitions.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { collectAgentListingAttachment } from "../src/subagent/listing.js";
import { parseAgentListingDelta } from "../src/agent/agent-listing-metadata.js";
import { MessageHistoryImpl, type RuntimeMessageEntry } from "../src/agent/message-history.js";
import type { AgentProfile } from "../src/subagent/profile.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";

const profile = (name: string, description = `Description ${name}`): AgentProfile => ({
  name,
  description,
  source: "user",
  systemPrompt: "private instructions",
  tools: ["Read"],
});
const collect = (
  names: string[],
  history: readonly RuntimeMessageEntry[] = [],
  tools = [{ name: "Agent" }],
) =>
  collectAgentListingAttachment({
    definitions: { activeAgents: names.map((name) => profile(name)) },
    entries: history,
    tools,
  });

describe("agent listing attachments", () => {
  it("reads the normalized startup snapshot through the default definitions entry", () => {
    const profiles = [profile("A")];
    const read = createAgentDefinitionsReader(profiles);
    expect(read().activeAgents.map((agent) => agent.name)).toEqual(
      expect.arrayContaining(["A", "Explore", "general-purpose"]),
    );
    profiles.push(profile("B"));
    expect(read()).toBe(read());
    expect(read().activeAgents.some((agent) => agent.name === "B")).toBe(false);
  });
  it("announces the exact supplied directory once, without adding built-ins", () => {
    const entry = collect(["B", "A"])!;
    expect(entry.metadata.agentListingDelta).toEqual({
      addedTypes: ["A", "B"],
      addedLines: ["- A: Description A (Tools: Read)", "- B: Description B (Tools: Read)"],
      removedTypes: [],
      isInitial: true,
      showConcurrencyNote: true,
    });
    expect(entry.content).toContain("Available agent types for the Agent tool:");
    expect(entry.content).not.toContain("private instructions");
    expect(collect(["A", "B"], [entry])).toBeUndefined();
    expect(collect([])).toBeUndefined();
  });

  it("announces additions, removals and renames, and restarts after removing all", () => {
    const initial = collect(["A", "B"])!;
    const delta = collect(["B", "C"], [initial])!;
    expect(delta.metadata.agentListingDelta).toMatchObject({
      addedTypes: ["C"],
      removedTypes: ["A"],
      isInitial: false,
    });
    expect(delta.content).toContain("The following agent types are no longer available:");
    expect(delta.content).toContain("New agent types are now available for the Agent tool:");
    expect(delta.content).toContain("This is ambient context");
    expect(delta.content).not.toContain("When you launch multiple agents");
    const renamed = collect(["a", "B"], [initial])!;
    expect(renamed.metadata.agentListingDelta).toMatchObject({
      addedTypes: ["a"],
      removedTypes: ["A"],
    });
    const removed = collect([], [initial, delta])!;
    expect(removed.metadata.agentListingDelta?.removedTypes).toEqual(["B", "C"]);
    expect(collect(["D"], [initial, delta, removed])?.metadata.agentListingDelta?.isInitial).toBe(
      true,
    );
    expect(collect([], [initial], [])).toBeUndefined();
    expect(collect(["d", "C"], [collect(["a", "B"])!])?.metadata.agentListingDelta).toMatchObject({
      addedTypes: ["C", "d"],
      addedLines: ["- C: Description C (Tools: Read)", "- d: Description d (Tools: Read)"],
      removedTypes: ["B", "a"],
    });
  });

  it("ignores same-name material changes and preserves the original text", () => {
    const initial = collect(["A"])!;
    expect(
      collectAgentListingAttachment({
        definitions: {
          activeAgents: [
            {
              ...profile("A", "changed"),
              tools: ["Bash"],
              modelSelection: createTestModelSelection("test/other"),
            },
          ],
        },
        entries: [initial],
        tools: [{ name: "Agent" }],
      }),
    ).toBeUndefined();
    expect(initial.content).toContain("Description A");
  });

  it("reconstructs only retained history after compact, fork or rewind", () => {
    const initial = collect(["A", "B"])!;
    const added = collect(["A", "B", "C"], [initial])!;
    const repaired = collect(["A", "B", "C"], [added])!;
    expect(repaired.metadata.agentListingDelta?.addedTypes).toEqual(["A", "B"]);
    expect(collect(["A", "B", "C"], [added, repaired])).toBeUndefined();
    expect(collect(["A", "B", "C"], [])?.metadata.agentListingDelta?.addedTypes).toEqual([
      "A",
      "B",
      "C",
    ]);
    expect(collect(["A", "B", "C"], [initial])?.metadata.agentListingDelta?.addedTypes).toEqual([
      "C",
    ]);
  });

  it("does not infer announcements from text or malformed metadata", () => {
    const initial = collect(["A"])!;
    const legacy = { ...initial, metadata: { source: "agent_listing_delta" as const } };
    expect(collect(["A"], [legacy])?.metadata.agentListingDelta?.isInitial).toBe(true);
    for (const value of [
      null,
      [],
      {},
      { ...initial.metadata.agentListingDelta, addedTypes: [1] },
      { ...initial.metadata.agentListingDelta, addedLines: [] },
      { ...initial.metadata.agentListingDelta, addedLines: [1] },
      { ...initial.metadata.agentListingDelta, removedTypes: [1] },
      { ...initial.metadata.agentListingDelta, isInitial: "yes" },
      { ...initial.metadata.agentListingDelta, showConcurrencyNote: "yes" },
      { ...initial.metadata.agentListingDelta, addedTypes: ["A", "A"], addedLines: ["a", "a"] },
      { ...initial.metadata.agentListingDelta, removedTypes: ["B", "B"] },
      { ...initial.metadata.agentListingDelta, removedTypes: ["A"] },
    ]) {
      expect(parseAgentListingDelta(value)).toBeUndefined();
      for (const write of ["addEntries", "replaceMessages"] as const) {
        const history = new MessageHistoryImpl();
        history[write]([
          {
            ...initial,
            metadata: { ...initial.metadata, agentListingDelta: value },
          } as unknown as RuntimeMessageEntry,
        ]);
        expect(
          collect(["A"], history.borrowReadOnlyRuntimeEntries())?.metadata.agentListingDelta
            ?.isInitial,
        ).toBe(true);
      }
    }
  });

  it("defensively clones structured history", () => {
    const history = new MessageHistoryImpl();
    const initial = collect(["A"])!;
    history.addEntries([initial]);
    initial.metadata.agentListingDelta!.addedTypes.push("B");
    initial.metadata.agentListingDelta!.addedLines.push("changed");
    initial.metadata.agentListingDelta!.removedTypes.push("A");
    const copy = history.toRuntimeEntries();
    copy[0]!.metadata!.agentListingDelta!.addedTypes.push("C");
    expect(history.toRuntimeEntries()[0]!.metadata!.agentListingDelta).toEqual(
      collect(["A"])!.metadata.agentListingDelta,
    );
  });

  it("combines listing with other ordinary MCS attachments", () => {
    const entries: RuntimeMessageEntry[] = [
      { message: { role: "user", content: "question" }, metadata: { source: "real_user" } },
      { kind: "attachment", content: "plugin reference", metadata: { source: "plugin_reference" } },
      collect(["A"])!,
    ];
    const { messages } = buildProviderRequestMessages({ entries, useMidConversationSystem: true });
    expect(messages.at(-1)).toEqual({
      role: "system",
      content: `plugin reference\n\n${collect(["A"])!.content}`,
    });
    expect(messages.at(-2)?.role).toBe("user");
  });
  it("uses the existing fallback when no user can anchor the listing", () => {
    const listing = collect(["A"])!;
    const { messages } = buildProviderRequestMessages({
      entries: [{ message: { role: "assistant", content: "previous response" } }, listing],
      useMidConversationSystem: true,
    });
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: `<system-reminder>\n${listing.content}\n</system-reminder>`,
    });
  });
  it.each([
    "plan_file_reference",
    "resume_referenced_session_context",
    "conversation_fork",
  ] as const)("preserves the existing MCS anchor after %s without listing", (source) => {
    const { messages } = buildProviderRequestMessages({
      entries: [
        { message: { role: "user", content: "question" } },
        { kind: "attachment", content: "continuity", metadata: { source } },
        { kind: "attachment", content: "mode", metadata: { source: "runtime_mode" } },
      ],
      useMidConversationSystem: true,
    });
    expect(messages.find((m) => String(m.content).includes("mode"))).toEqual({
      role: "user",
      content: "<system-reminder>\nmode\n</system-reminder>",
    });
  });
});
