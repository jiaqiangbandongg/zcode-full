import { describe, expect, it } from "vitest";
import { botsStateFileSchema, botGroupInputSourceSchema, type BotActor } from "@zcode/shared";
import {
  getBotConversationKey,
  getBotStateKey,
  isGroupOwnerCommand,
  canAnswerGroupQuestion,
} from "../src/bots/groupSessions.js";

const actor: BotActor = {
  botId: "bot",
  provider: "feishu",
  chatType: "group",
  chatId: "oc_a",
  providerUserId: "ou_a",
};

describe("group conversation authority", () => {
  it("preserves a bounded input background snapshot and rejects cross-topic content", () => {
    const source = {
      botId: "bot",
      provider: "feishu",
      chatId: "chat",
      threadId: "thread",
      senderId: "user",
      senderName: "User",
      messageId: "current",
      topicContext: {
        checkpoint: "current",
        hasGap: false,
        messages: [
          {
            id: "old",
            chatId: "chat",
            threadId: "thread",
            senderId: "other",
            senderType: "user",
            text: "background",
            createdAt: 1,
            kind: "text",
          },
        ],
      },
    };
    expect(botGroupInputSourceSchema.parse(source)).toEqual(source);
    source.topicContext.messages[0]!.threadId = "another";
    expect(botGroupInputSourceSchema.safeParse(source).success).toBe(false);
  });
  it("isolates topics while preserving the existing default/private keys", () => {
    const topic = { ...actor, threadId: "omt_a" };
    expect(getBotConversationKey(topic)).toBe(JSON.stringify(["bot", "oc_a", "omt_a"]));
    expect(getBotConversationKey(topic)).not.toBe(getBotConversationKey(actor));
    expect(getBotConversationKey(topic)).not.toBe(
      getBotConversationKey({ ...topic, threadId: "omt_b" }),
    );
    expect(getBotConversationKey({ ...topic, providerUserId: "other" })).toBe(
      getBotConversationKey(topic),
    );
    expect(getBotConversationKey(actor)).toBe(JSON.stringify(["bot", "oc_a"]));
    expect(getBotConversationKey({ ...topic, chatType: "private" })).toBe("bot");
  });

  it("round trips native topic identity and keys persisted state by topic", () => {
    const state = {
      botId: "bot",
      workspacePath: "/work",
      mode: "draft",
      activeTaskId: null,
      updatedAt: 1,
      group: {
        chatId: "oc_a",
        threadId: "omt_a",
        rootMessageId: "om_root",
        topicTitle: "Design",
        name: "研发",
        ownerId: "owner",
        enabled: true,
        taskIds: [],
        currentOptions: {},
        historyEnabled: false,
      },
    };
    const parsed = botsStateFileSchema.parse({ version: 3, bots: { topic: state } }).bots.topic!;
    expect(parsed).toEqual(state);
    expect(getBotStateKey(parsed)).toBe(JSON.stringify(["bot", "oc_a", "omt_a"]));
  });
  it("shares a context between members, not between chats or bots", () => {
    expect(getBotConversationKey(actor)).toBe(
      getBotConversationKey({ ...actor, providerUserId: "ou_b" }),
    );
    expect(getBotConversationKey(actor)).not.toBe(
      getBotConversationKey({ ...actor, chatId: "oc_b" }),
    );
    expect(getBotConversationKey(actor)).not.toBe(
      getBotConversationKey({ ...actor, botId: "other" }),
    );
    expect(getBotConversationKey({ ...actor, chatType: "private", chatId: undefined })).toBe("bot");
    expect(() => getBotConversationKey({ ...actor, chatId: undefined })).toThrow();
  });

  it("requires owner for configuration and approvals, not prompts/status", () => {
    for (const command of ["new", "workspace", "mode", "approve", "stop", "task", "reply"])
      expect(isGroupOwnerCommand(command)).toBe(true);
    for (const command of ["help", "status", "message", "answer"])
      expect(isGroupOwnerCommand(command)).toBe(false);
    expect(canAnswerGroupQuestion("ou_a", "owner", "ou_a", false)).toBe(true);
    expect(canAnswerGroupQuestion("stranger", "owner", "ou_a", false)).toBe(false);
    expect(canAnswerGroupQuestion("ou_a", "owner", "ou_a", true)).toBe(false);
    expect(canAnswerGroupQuestion("owner", "owner", "ou_a", true)).toBe(true);
  });

  it("persists group identity without changing private v3 records", () => {
    const state = {
      botId: "bot",
      workspacePath: "/work",
      mode: "draft",
      activeTaskId: null,
      updatedAt: 1,
    };
    expect(botsStateFileSchema.parse({ version: 3, bots: { bot: state } }).bots.bot).toEqual(state);
    const group = {
      ...state,
      group: {
        chatId: "oc_a",
        name: "研发",
        ownerId: "owner",
        enabled: true,
        taskIds: [],
        currentOptions: {},
      },
    };
    expect(botsStateFileSchema.parse({ version: 3, bots: { group } }).bots.group).toEqual(group);
  });
});
