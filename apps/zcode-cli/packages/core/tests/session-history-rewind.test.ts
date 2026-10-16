import { describe, expect, it } from "vitest";
import {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  createMessageId,
  createModelId,
  createModelProviderId,
  createPartId,
  createSessionId,
  type CompactBoundaryPayload,
  type MessageWithParts,
  type TokenUsageInfo,
  type TraceId,
} from "@zcode/contracts";
import { MessageHistoryImpl } from "../src/agent/message-history.js";
import {
  activeSessionMessages,
  hydrateMessageHistoryFromSession,
} from "../src/agent/session-history-hydrator.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";
import { mainTurnCacheHitAggregateFromMessages } from "../src/runtime/methods/turn-model-step-usage.js";

const modelID = createModelId("gpt-test");
const providerID = createModelProviderId("openai");

describe("session history rewind hydration", () => {
  it("hydrates only the branch before a persisted rewind target", async () => {
    const sessionID = createSessionId("hydrate-rewind");
    const firstUserID = createMessageId("first-user");
    const firstAssistantID = createMessageId("first-assistant");
    const rewindTargetID = createMessageId("rewind-target");
    const afterAssistantID = createMessageId("after-assistant");
    const history = new MessageHistoryImpl();
    history.init("system prompt");

    await hydrateMessageHistoryFromSession({
      history,
      messages: [
        userMessage(sessionID, firstUserID, "keep this", 1),
        assistantMessage(sessionID, firstAssistantID, firstUserID, "kept reply", 2, {
          input: 100,
          output: 20,
          reasoning: 0,
          cache: { read: 0, write: 0 },
          total: 120,
        }),
        userMessage(sessionID, rewindTargetID, "remove this", 3),
        assistantMessage(sessionID, afterAssistantID, rewindTargetID, "removed reply", 4, {
          input: 200,
          output: 20,
          reasoning: 0,
          cache: { read: 0, write: 0 },
          total: 220,
        }),
      ],
      rewindTargetMessageId: rewindTargetID,
    });

    expect(providerMessages(history)).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "keep this" },
      {
        role: "assistant",
        content: "kept reply",
        toolCalls: [],
      },
    ]);
    expect(
      history.toRuntimeEntries().find((entry) => "tokens" in entry && entry.tokens?.input === 100),
    ).toBeDefined();
    expect(
      history.toRuntimeEntries().some((entry) => "tokens" in entry && entry.tokens?.input === 200),
    ).toBe(false);
  });

  it("neutralizes preserved assistant tokens without changing later messages", async () => {
    const sessionID = createSessionId("hydrate-rewind-preserved-assistant-tokens");
    const oldUserID = createMessageId("old-preserved-user");
    const oldAssistantID = createMessageId("old-preserved-assistant");
    const compactID = createMessageId("compact-preserved-assistant");
    const newUserID = createMessageId("new-after-compact-user");
    const newAssistantID = createMessageId("new-after-compact-assistant");
    const history = new MessageHistoryImpl();
    history.init("system prompt");
    const sessionMessages = [
      userMessage(sessionID, oldUserID, "old prompt", 1),
      assistantMessage(sessionID, oldAssistantID, oldUserID, "old reply", 2, {
        input: 100,
        output: 20,
        reasoning: 0,
        cache: { read: 0, write: 0 },
        total: 120,
      }),
      compactMessageWithPreservedSegment({
        messageID: compactID,
        preservedMessageID: oldAssistantID,
        sessionID,
        text: "Summary after compact",
      }),
      userMessage(sessionID, newUserID, "new prompt", 3),
      assistantMessage(sessionID, newAssistantID, newUserID, "new reply", 4, {
        input: 200,
        output: 20,
        reasoning: 0,
        cache: { read: 0, write: 0 },
        total: 220,
      }),
    ];

    await hydrateMessageHistoryFromSession({
      history,
      messages: sessionMessages,
    });

    const assistantEntries = history
      .toRuntimeEntries()
      .filter((entry) => "message" in entry && entry.message.role === "assistant");
    expect(assistantEntries).toHaveLength(2);
    expect(
      assistantEntries[0] && "tokens" in assistantEntries[0]
        ? assistantEntries[0].tokens
        : undefined,
    ).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
      total: 0,
    });
    expect(
      assistantEntries[1] && "tokens" in assistantEntries[1]
        ? assistantEntries[1].tokens
        : undefined,
    ).toEqual({
      input: 200,
      output: 20,
      reasoning: 0,
      cache: { read: 0, write: 0 },
      total: 220,
    });
    expect(
      sessionMessages[1]?.info.role === "assistant" ? sessionMessages[1].info.tokens : undefined,
    ).toEqual({
      input: 100,
      output: 20,
      reasoning: 0,
      cache: { read: 0, write: 0 },
      total: 120,
    });
  });

  it("rebuilds a cold-resume cache aggregate from raw compact-preserved usage", () => {
    const sessionID = createSessionId("cache-aggregate-cold-compact");
    const oldUserID = createMessageId("cache-aggregate-old-user");
    const oldAssistantID = createMessageId("cache-aggregate-old-assistant");
    const compactID = createMessageId("cache-aggregate-compact");
    const persistedMessages = [
      userMessage(sessionID, oldUserID, "old prompt", 1),
      assistantMessage(sessionID, oldAssistantID, oldUserID, "old reply", 2, {
        input: 100,
        output: 20,
        reasoning: 0,
        cache: { read: 80, write: 10 },
        total: 120,
      }),
      compactMessageWithPreservedSegment({
        messageID: compactID,
        preservedMessageID: oldAssistantID,
        sessionID,
        text: "Summary after compact",
      }),
    ];
    const activeMessages = activeSessionMessages(persistedMessages);
    const preservedAssistant = activeMessages.find((message) => message.info.id === oldAssistantID);

    expect(
      preservedAssistant?.info.role === "assistant" ? preservedAssistant.info.tokens : undefined,
    ).toEqual({ ...emptyTokens(), total: 0 });
    expect(mainTurnCacheHitAggregateFromMessages({ activeMessages, persistedMessages })).toEqual({
      requestCount: 1,
      totalInputTokens: 100,
      totalCacheReadTokens: 80,
      totalCacheWriteTokens: 10,
    });
  });

  it("excludes the discarded post-compact rewind branch from the cache aggregate", () => {
    const sessionID = createSessionId("cache-aggregate-rewind-compact");
    const oldUserID = createMessageId("cache-rewind-old-user");
    const oldAssistantID = createMessageId("cache-rewind-old-assistant");
    const compactID = createMessageId("cache-rewind-compact");
    const keptUserID = createMessageId("cache-rewind-kept-user");
    const keptAssistantID = createMessageId("cache-rewind-kept-assistant");
    const discardedUserID = createMessageId("cache-rewind-discarded-user");
    const discardedAssistantID = createMessageId("cache-rewind-discarded-assistant");
    const persistedMessages = [
      userMessage(sessionID, oldUserID, "old prompt", 1),
      assistantMessage(sessionID, oldAssistantID, oldUserID, "old reply", 2, {
        input: 100,
        output: 20,
        reasoning: 0,
        cache: { read: 80, write: 10 },
        total: 120,
      }),
      compactMessageWithPreservedSegment({
        messageID: compactID,
        preservedMessageID: oldAssistantID,
        sessionID,
        text: "Summary after compact",
      }),
      userMessage(sessionID, keptUserID, "kept prompt", 3),
      assistantMessage(sessionID, keptAssistantID, keptUserID, "kept reply", 4, {
        input: 200,
        output: 20,
        reasoning: 0,
        cache: { read: 100, write: 20 },
        total: 220,
      }),
      userMessage(sessionID, discardedUserID, "discarded prompt", 5),
      assistantMessage(sessionID, discardedAssistantID, discardedUserID, "discarded reply", 6, {
        input: 300,
        output: 20,
        reasoning: 0,
        cache: { read: 240, write: 30 },
        total: 320,
      }),
    ];
    const activeMessages = activeSessionMessages(persistedMessages, {
      rewindTargetMessageId: discardedUserID,
    });

    expect(activeMessages.some((message) => message.info.id === discardedAssistantID)).toBe(false);
    expect(mainTurnCacheHitAggregateFromMessages({ activeMessages, persistedMessages })).toEqual({
      requestCount: 2,
      totalInputTokens: 300,
      totalCacheReadTokens: 180,
      totalCacheWriteTokens: 30,
    });
  });

  it("hydrates the created branch after editing the first user message", async () => {
    const sessionID = createSessionId("hydrate-rewind-created");
    const originalUserID = createMessageId("original-user");
    const originalAssistantID = createMessageId("original-assistant");
    const rewindNoticeID = createMessageId("rewind-notice");
    const editedUserID = createMessageId("edited-user");
    const editedAssistantID = createMessageId("edited-assistant");
    const history = new MessageHistoryImpl();
    history.init("system prompt");

    await hydrateMessageHistoryFromSession({
      history,
      messages: [
        userMessage(sessionID, originalUserID, "old prompt", 1),
        assistantMessage(sessionID, originalAssistantID, originalUserID, "old reply", 2),
        userMessage(sessionID, rewindNoticeID, "Conversation rewind applied.", 3),
        userMessage(sessionID, editedUserID, "edited prompt", 4),
        assistantMessage(sessionID, editedAssistantID, editedUserID, "edited reply", 5),
      ],
      rewindCreatedMessageId: rewindNoticeID,
      rewindTargetMessageId: originalUserID,
    });

    expect(providerMessages(history)).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "Conversation rewind applied." },
      { role: "user", content: "edited prompt" },
      {
        role: "assistant",
        content: "edited reply",
        toolCalls: [],
      },
    ]);
  });

  it("uses the saved active prefix when a rewritten first turn is edited again", () => {
    const sessionID = createSessionId("hydrate-rewind-kept-prefix");
    const originalUserID = createMessageId("original-user-kept");
    const originalAssistantID = createMessageId("original-assistant-kept");
    const firstNoticeID = createMessageId("first-rewind-notice");
    const editedUserID = createMessageId("edited-user-kept");
    const editedAssistantID = createMessageId("edited-assistant-kept");
    const secondNoticeID = createMessageId("second-rewind-notice");
    const finalUserID = createMessageId("final-user-kept");
    const finalAssistantID = createMessageId("final-assistant-kept");

    const active = activeSessionMessages(
      [
        userMessage(sessionID, originalUserID, "old prompt", 1),
        assistantMessage(sessionID, originalAssistantID, originalUserID, "old reply", 2),
        userMessage(sessionID, firstNoticeID, "first rewind", 3),
        userMessage(sessionID, editedUserID, "edited prompt", 4),
        assistantMessage(sessionID, editedAssistantID, editedUserID, "edited reply", 5),
        userMessage(sessionID, secondNoticeID, "second rewind", 6),
        userMessage(sessionID, finalUserID, "final prompt", 7),
        assistantMessage(sessionID, finalAssistantID, finalUserID, "final reply", 8),
      ],
      {
        rewindCreatedMessageId: secondNoticeID,
        rewindKeptMessageIds: [firstNoticeID],
        rewindTargetMessageId: editedUserID,
      },
    );

    expect(active.map((message) => message.info.id)).toEqual([
      firstNoticeID,
      secondNoticeID,
      finalUserID,
      finalAssistantID,
    ]);
  });

  it("does not let rewind targets before compact bypass the compact boundary", async () => {
    const sessionID = createSessionId("hydrate-rewind-compact");
    const oldUserID = createMessageId("old-before-compact");
    const compactID = createMessageId("compact-after-old");
    const history = new MessageHistoryImpl();
    history.init("system prompt");

    await hydrateMessageHistoryFromSession({
      history,
      messages: [
        userMessage(sessionID, oldUserID, "old prompt", 1),
        {
          info: {
            id: compactID,
            sessionID,
            role: "user",
            time: { created: 2 },
            summary: { body: "summary", diffs: [], title: "Compact summary" },
            agent: "zcode-agent",
            model: { providerID, modelID },
          },
          parts: [
            {
              id: createPartId("compact-text-rewind"),
              messageID: compactID,
              sessionID,
              synthetic: true,
              text: "Summary after compact",
              type: "text",
            },
            {
              id: createPartId("compact-part-rewind"),
              auto: false,
              messageID: compactID,
              sessionID,
              type: "compaction",
            },
          ],
        },
      ],
      rewindTargetMessageId: oldUserID,
    });

    expect(providerMessages(history)).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "Summary after compact" },
    ]);
  });

  it("applies a new branch cut before compact scoping so compact-covered edits replace the summary", async () => {
    const sessionID = createSessionId("hydrate-branch-cut-before-compact");
    const oldUserID = createMessageId("old-user-before-cut");
    const oldAssistantID = createMessageId("old-assistant-before-cut");
    const compactID = createMessageId("compact-before-cut");
    const editedUserID = createMessageId("edited-user-after-cut");
    const editedAssistantID = createMessageId("edited-assistant-after-cut");
    const history = new MessageHistoryImpl();
    history.init("system prompt");

    await hydrateMessageHistoryFromSession({
      branchCutAfterMessageId: compactID,
      history,
      messages: [
        userMessage(sessionID, oldUserID, "old compact-covered prompt", 1),
        assistantMessage(sessionID, oldAssistantID, oldUserID, "old compact-covered reply", 2),
        compactMessageWithPreservedSegment({
          messageID: compactID,
          preservedMessageID: oldAssistantID,
          sessionID,
          text: "stale compact summary",
        }),
        userMessage(sessionID, editedUserID, "edited prompt", 4),
        assistantMessage(sessionID, editedAssistantID, editedUserID, "edited reply", 5),
      ],
      rewindKeptMessageIds: [],
      rewindTargetMessageId: oldUserID,
    });

    expect(providerMessages(history)).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "edited prompt" },
      {
        role: "assistant",
        content: "edited reply",
        toolCalls: [],
      },
    ]);
  });

  it("does not treat compact preserved segment messages as valid rewind kept ids", async () => {
    const sessionID = createSessionId("hydrate-rewind-preserved-compact");
    const oldUserID = createMessageId("old-preserved-before-compact");
    const compactID = createMessageId("compact-after-preserved");
    const history = new MessageHistoryImpl();
    history.init("system prompt");

    await hydrateMessageHistoryFromSession({
      history,
      messages: [
        userMessage(sessionID, oldUserID, "old prompt preserved before compact", 1),
        compactMessageWithPreservedSegment({
          messageID: compactID,
          preservedMessageID: oldUserID,
          sessionID,
          text: "Summary after compact with preserved segment",
        }),
      ],
      rewindKeptMessageIds: [oldUserID],
      rewindTargetMessageId: oldUserID,
    });

    const messages = providerMessages(history);
    expect(messages).toEqual([
      { role: "system", content: "system prompt" },
      { role: "user", content: "Summary after compact with preserved segment" },
      { role: "user", content: "old prompt preserved before compact" },
    ]);
  });
});

function userMessage(
  sessionID: ReturnType<typeof createSessionId>,
  messageID: ReturnType<typeof createMessageId>,
  text: string,
  created: number,
): MessageWithParts {
  return {
    info: {
      id: messageID,
      sessionID,
      role: "user",
      time: { created },
      agent: "zcode-agent",
      model: { providerID, modelID },
    },
    parts: [
      {
        id: createPartId(`${messageID}-text`),
        messageID,
        sessionID,
        text,
        type: "text",
      },
    ],
  };
}

function assistantMessage(
  sessionID: ReturnType<typeof createSessionId>,
  messageID: ReturnType<typeof createMessageId>,
  parentID: ReturnType<typeof createMessageId>,
  text: string,
  created: number,
  tokens: TokenUsageInfo = emptyTokens(),
): MessageWithParts {
  return {
    info: {
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created },
      parentID,
      modelID,
      providerID,
      mode: "build",
      agent: "zcode-agent",
      path: { cwd: "/tmp/project", root: "/tmp/project" },
      cost: 0,
      tokens,
    },
    parts: [
      {
        id: createPartId(`${messageID}-text`),
        messageID,
        sessionID,
        text,
        type: "text",
      },
    ],
  };
}

function compactMessageWithPreservedSegment(input: {
  messageID: ReturnType<typeof createMessageId>;
  preservedMessageID: ReturnType<typeof createMessageId>;
  sessionID: ReturnType<typeof createSessionId>;
  text: string;
}): MessageWithParts {
  const compactBoundary: CompactBoundaryPayload = {
    boundaryId: "compact_preserved_rewind",
    compactReason: CompactReason.ContextLimit,
    keptMessageCount: 1,
    phase: CompactPhase.PreRequest,
    preservedSegment: {
      anchorMessageId: input.messageID,
      headMessageId: input.preservedMessageID,
      tailMessageId: input.preservedMessageID,
    },
    preCompactTokenCount: 100,
    postCompactTokenCount: 20,
    summarizedMessageCount: 1,
    summaryMessageIds: [input.messageID],
    summarySource: "model",
    traceId: "trace_preserved_rewind" as TraceId,
    trigger: CompactTrigger.Auto,
  };
  return {
    info: {
      id: input.messageID,
      sessionID: input.sessionID,
      role: "user",
      time: { created: 2 },
      summary: { body: "summary", diffs: [], title: "Compact summary" },
      agent: "zcode-agent",
      model: { providerID, modelID },
    },
    parts: [
      {
        id: createPartId(`${input.messageID}-text`),
        messageID: input.messageID,
        sessionID: input.sessionID,
        synthetic: true,
        text: input.text,
        type: "text",
      },
      {
        id: createPartId(`${input.messageID}-compact`),
        auto: false,
        compactBoundary,
        messageID: input.messageID,
        sessionID: input.sessionID,
        type: "compaction",
      },
    ],
  };
}

function emptyTokens() {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: {
      read: 0,
      write: 0,
    },
  };
}

function providerMessages(history: MessageHistoryImpl) {
  return buildProviderRequestMessages({ entries: history.toRuntimeEntries() }).messages;
}
