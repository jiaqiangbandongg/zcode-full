import { describe, expect, it, vi } from "vitest";
import { readTopicHistory } from "../src/bots/topicHistory.js";

const row = (id: string, overrides = {}) => ({
  id,
  chatId: "chat",
  threadId: "thread",
  senderId: "user",
  senderType: "user" as const,
  text: id,
  createdAt: 1,
  kind: "text",
  ...overrides,
});
const request = { chatId: "chat", threadId: "thread", messageId: "current", rootMessageId: "root" };

describe("bounded topic history", () => {
  it("excludes bot cards and their bot confirmations without changing history boundaries", async () => {
    const result = await readTopicHistory(request, {
      list: async () => ({
        messages: [
          row("current"),
          row("confirmation", { senderType: "app", parentId: "card" }),
          row("human-quote", { parentId: "card" }),
          row("bot-text", { senderType: "app", kind: "interactive" }),
          row("card", { senderType: "app", kind: "interactive", controlCard: true }),
          row("root"),
        ],
      }),
      get: async () => row("root"),
    });
    expect(result.messages.map((message) => message.id)).toEqual([
      "root",
      "bot-text",
      "human-quote",
    ]);
    expect(result.checkpoint).toBe("current");
    expect(result.hasGap).toBe(false);
  });
  it("checks history access even when the root first invokes the bot", async () => {
    const list = vi.fn(async () => ({ messages: [] }));
    const result = await readTopicHistory(
      { ...request, messageId: "root" },
      { list, get: async () => row("root") },
    );
    expect(result).toEqual({ messages: [], checkpoint: "root", hasGap: false });
    expect(list).toHaveBeenCalledOnce();
  });
  it("freezes at the invoking message, removes overlapping pages and stops at the checkpoint", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [row("future"), row("current"), row("new")],
        next: "page2",
      })
      .mockResolvedValueOnce({
        messages: [row("new"), row("older"), row("checkpoint"), row("past")],
      });
    const result = await readTopicHistory(
      { ...request, checkpoint: "checkpoint" },
      {
        list,
        get: vi.fn(async () => row("root")),
      },
    );
    expect(result.messages.map((m) => m.id)).toEqual(["older", "new"]);
    expect(result.hasGap).toBe(false);
    expect(result.checkpoint).toBe("current");
  });
  it("keeps the root once on first invocation and includes bots but excludes deleted content", async () => {
    const result = await readTopicHistory(request, {
      list: async () => ({
        messages: [
          row("current"),
          row("bot", { senderType: "app" }),
          row("gone", { deleted: true }),
          row("old"),
          row("root"),
        ],
      }),
      get: async () => row("root"),
    });
    expect(result.messages.map((m) => m.id)).toEqual(["root", "old", "bot"]);
    expect(result.hasGap).toBe(true);
  });
  it("preserves an app-authored root once and keeps its sender type", async () => {
    const result = await readTopicHistory(request, {
      list: async () => ({ messages: [row("current"), row("root", { senderType: "app" })] }),
      get: async () => row("root", { senderType: "app" }),
    });
    expect(result.messages).toEqual([row("root", { senderType: "app" })]);
  });
  it("bounds large history and records the uncovered range", async () => {
    const result = await readTopicHistory(request, {
      list: async () => ({
        messages: [row("current"), ...Array.from({ length: 220 }, (_, i) => row(String(i)))],
        next: "more",
      }),
      get: async () => row("root"),
    });
    expect(result.messages).toHaveLength(201);
    expect(result.messages[0]?.id).toBe("root");
    expect(result.hasGap).toBe(true);
  });
  it("fails closed for cross-topic history and missing invocation boundary", async () => {
    await expect(
      readTopicHistory(request, {
        list: async () => ({ messages: [row("current"), row("secret", { threadId: "other" })] }),
        get: async () => row("root"),
      }),
    ).rejects.toThrow(/scope/);
    await expect(
      readTopicHistory(request, {
        list: async () => ({ messages: [row("future")] }),
        get: async () => row("root"),
      }),
    ).rejects.toThrow(/boundary/);
  });
  it("does not treat a missing checkpoint as complete incremental history", async () => {
    const result = await readTopicHistory(
      { ...request, checkpoint: "missing" },
      {
        list: async () => ({ messages: [row("current"), row("old")] }),
        get: async () => row("root"),
      },
    );
    expect(result.hasGap).toBe(true);
  });
});
