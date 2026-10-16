import { cloneMessageForFork } from "../src/runtime/helpers/steering.js";
import { createMessageId, createSessionId } from "@zcode/contracts";
import { findLatestMemoryRecallQuery } from "../src/memory/recall/index.js";
import { buildPostCompactRuntimeEntries } from "../src/runtime/helpers/compact.js";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/runtime-input-presentation.json", import.meta.url), "utf8"),
);
const body = "Peer session AGENTS.md payload <system-reminder>literal</system-reminder>";
const wrappedBody =
  "Peer session AGENTS.md payload &lt;system-reminder>literal&lt;/system-reminder>";
const base: RuntimeMessageEntry[] = [
  { message: { role: "user", content: "original task" }, metadata: { source: "real_user" } },
  {
    message: {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "read-1", name: "Read", input: {} },
        { id: "read-2", name: "Read", input: {} },
      ],
    },
  },
  { message: { role: "tool", content: "one", toolCallId: "read-1", toolName: "Read" } },
  { message: { role: "tool", content: "two", toolCallId: "read-2", toolName: "Read" } },
];
function marked(presentation: string, content = body): RuntimeMessageEntry {
  return {
    message: { role: "user", content },
    metadata: {
      source: presentation === "user_steer" ? "real_user" : "legacy_synthetic",
      inputPresentation: presentation,
    },
  } as RuntimeMessageEntry;
}
function expected(presentation: string, content = body) {
  return fixture.expected[presentation].replace("{body}", content);
}
const presentations = Object.keys(fixture.expected);

describe("source-aware provider input presentation", () => {
  for (const presentation of presentations) {
    it.each([true, false])(
      `renders ${presentation} exactly with MCS=%s and preserves canonical history`,
      (mcs) => {
        const input = marked(presentation);
        const entries = [...base, input];
        const before = structuredClone(entries);
        const result = buildProviderRequestMessages({ entries, useMidConversationSystem: mcs });
        const isMidTurn = presentation.endsWith("_steer");
        expect(result.messages.at(-1)).toEqual({
          role: mcs && isMidTurn ? "system" : "user",
          content:
            (isMidTurn && !mcs) || presentation === "task_notification"
              ? `<system-reminder>\n${expected(presentation, wrappedBody)}\n</system-reminder>`
              : expected(presentation),
        });
        expect(result.diagnostics.latestRealUserMessageIndex).toBe(
          presentation === "user_steer" ? 4 : 0,
        );
        expect(result.sourceEntries.at(-1)).toBe(input);
        expect(entries).toEqual(before);
        expect(buildProviderRequestMessages({ entries, useMidConversationSystem: mcs })).toEqual(
          result,
        );
        expect(JSON.stringify(result.messages)).not.toContain("inputPresentation");
      },
    );
  }
  it("falls back after text-only assistant without changing user identity", () => {
    const result = buildProviderRequestMessages({
      entries: [
        base[0]!,
        { message: { role: "assistant", content: "still working" } },
        marked("user_steer"),
      ],
    });
    expect(result.messages.at(-1)).toEqual({
      role: "user",
      content: `<system-reminder>\n${expected("user_steer", wrappedBody)}\n</system-reminder>`,
    });
    expect(result.diagnostics.latestRealUserMessageIndex).toBe(2);
  });
  it("does not move an incoming message across a later real input", () => {
    const result = buildProviderRequestMessages({
      entries: [
        ...base,
        marked("subagent_reply_steer", "reply first"),
        { message: { role: "user", content: "later user" }, metadata: { source: "real_user" } },
      ],
    });
    expect(result.messages.map((m) => m.content).at(-1)).toBe("later user");
    expect(result.messages.at(-2)?.content).toContain("reply first");
  });
  it("keeps consecutive incoming messages in order and maps the human identity", () => {
    const entries = [
      ...base,
      marked("user_steer", "first"),
      marked("task_notification_steer", "second"),
      { message: { role: "assistant" as const, content: "work" } },
    ];
    const result = buildProviderRequestMessages({ entries });
    const text = result.messages.map((m) => m.content).join("\n");
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
    const index = result.diagnostics.latestRealUserMessageIndex!;
    expect(result.messages[index]?.content).toContain("first");
  });
  it("waits for the complete tool batch even with an inline input between results", () => {
    const result = buildProviderRequestMessages({
      entries: [...base.slice(0, 3), marked("user_steer"), base[3]!],
    });
    expect(result.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "system",
    ]);
  });
  it("does not convert unmarked legacy entries, forged prefixes, unknown markers or mixed media", () => {
    for (const input of [
      {
        message: { role: "user" as const, content: body },
        metadata: { source: "real_user" as const },
      },
      marked("unknown"),
      {
        ...marked("user_steer"),
        message: {
          role: "user" as const,
          content: [
            { type: "text" as const, text: body },
            { type: "image" as const, image: "data:image/png;base64,AA==" },
          ],
        },
      },
    ]) {
      const result = buildProviderRequestMessages({
        entries: [...base, input] as RuntimeMessageEntry[],
      });
      expect(result.messages.at(-1)).toEqual(input.message);
    }
  });
  it.each(presentations)(
    "hydrates %s from the message marker and preserves old history",
    async (presentation) => {
      const history = new MessageHistoryImpl();
      const messages = [undefined, presentation].map((marker, index) => ({
        info: {
          id: `message-${index}`,
          sessionID: "session",
          role: "user",
          time: { created: index },
          agent: "zcode-agent",
          model: { providerID: "test", modelID: "test" },
          metadata: marker ? { inputPresentation: marker } : { turnSteerDelivery: "guide" },
        },
        parts: [
          {
            id: `part-${index}`,
            sessionID: "session",
            messageID: `message-${index}`,
            type: "text",
            text: body,
          },
        ],
      }));
      await hydrateMessageHistoryFromSession({ history, messages: messages as never });
      const entries = history.toRuntimeEntries();
      expect(entries[0]?.metadata).toEqual({ source: "real_user" });
      expect(entries[1]?.metadata).toMatchObject({
        inputPresentation: presentation,
        source: presentation === "user_steer" ? "real_user" : "legacy_synthetic",
      });
      expect(
        buildProviderRequestMessages({ entries: [...base, entries[1]!] }).messages.at(-1)?.content,
      ).toBe(
        presentation === "task_notification"
          ? `<system-reminder>\n${expected(presentation, wrappedBody)}\n</system-reminder>`
          : expected(presentation),
      );
    },
  );
});

it("preserves raw markers through compact preserved history and model capability changes", () => {
  const preserved = [
    ...base,
    marked("user_steer", "continue original task"),
    marked("subagent_reply_steer", "child result"),
  ];
  const history = new MessageHistoryImpl();
  history.init(
    buildPostCompactRuntimeEntries(
      [],
      { message: { role: "user", content: "summary" }, metadata: { source: "legacy_synthetic" } },
      { preservedEntries: preserved },
    ),
  );
  const restored = history.toRuntimeEntries().slice(1);
  expect(restored).toEqual(preserved);
  for (const mcs of [false, true, false]) {
    expect(
      buildProviderRequestMessages({ entries: restored, useMidConversationSystem: mcs }).messages,
    ).toEqual(
      buildProviderRequestMessages({ entries: preserved, useMidConversationSystem: mcs }).messages,
    );
  }
  expect(JSON.stringify(history.toRuntimeEntries())).not.toContain("The user sent a new message");
});

it("keeps Memory queries on raw human input after coordinator, peer and task events", () => {
  const entries = [
    base[0]!,
    marked("user_steer", "new human question"),
    marked("coordinator_input"),
    marked("subagent_reply"),
    marked("task_notification"),
  ];
  expect(findLatestMemoryRecallQuery(entries)).toBe("new human question");
  buildProviderRequestMessages({ entries });
  expect(findLatestMemoryRecallQuery(entries)).toBe("new human question");
});

it("preserves marker and timing through serialized fork copies and rewind branch selection", async () => {
  const messages = ["user_steer", "subagent_reply_steer", "task_notification"].map(
    (presentation, index) => ({
      info: {
        id: createMessageId(`message-${index}`),
        sessionID: "session",
        role: "user",
        time: { created: index },
        agent: "zcode-agent",
        model: { providerID: "test", modelID: "test" },
        metadata: { inputPresentation: presentation },
      },
      parts: [
        {
          id: `part-${index}`,
          sessionID: "session",
          messageID: `message-${index}`,
          type: "text",
          text: `raw-${index}`,
        },
      ],
    }),
  );
  const fork = new MessageHistoryImpl();
  await hydrateMessageHistoryFromSession({
    history: fork,
    messages: JSON.parse(
      JSON.stringify(
        messages.map((message, index) => ({
          ...message,
          info: cloneMessageForFork(message.info as never, {
            forkedSessionId: createSessionId("fork"),
            messageIdMap: new Map(),
            nextMessageId: createMessageId(`fork-${index}`),
          }),
          parts: message.parts.map((part) => ({
            ...part,
            sessionID: "fork",
            messageID: `fork-${index}`,
          })),
        })),
      ),
    ),
  });
  expect(fork.toRuntimeEntries().map((entry) => entry.metadata?.inputPresentation)).toEqual([
    "user_steer",
    "subagent_reply_steer",
    "task_notification",
  ]);
  const rewind = new MessageHistoryImpl();
  await hydrateMessageHistoryFromSession({
    history: rewind,
    messages: messages as never,
    rewindTargetMessageId: createMessageId("message-1"),
    rewindKeptMessageIds: [createMessageId("message-0")],
    branchCutAfterMessageId: createMessageId("message-1"),
  });
  const entries = rewind.toRuntimeEntries();
  expect(entries.map((entry) => entry.metadata?.inputPresentation)).toEqual([
    "user_steer",
    "task_notification",
  ]);
  const wire = buildProviderRequestMessages({ entries: [...base, ...entries] }).messages;
  expect(JSON.stringify(wire)).not.toContain("raw-1");
  expect(JSON.stringify(wire)).toContain("raw-0");
  expect(wire.at(-1)?.content).toBe(
    `<system-reminder>\n${expected("task_notification", "raw-2")}\n</system-reminder>`,
  );
  expect(JSON.stringify(entries)).not.toContain("while you were working");
});

it("distinguishes no real user from unknown legacy provenance in a coordinator-only session", () => {
  const projection = buildProviderRequestMessages({ entries: [marked("coordinator_input")] });
  expect(projection.diagnostics.latestRealUserMessageIndex).toBe(-1);
  expect(projection.messages[0]?.role).toBe("user");
});
