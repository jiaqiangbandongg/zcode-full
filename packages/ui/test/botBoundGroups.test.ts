import { describe, expect, it } from "vitest";
import type { BotState } from "@zcode/shared";
import { projectBoundGroups } from "@/hooks/useBotBoundGroups.js";

const state = (chatId: string, threadId?: string, extra: Partial<BotState> = {}): BotState => ({
  botId: "bot",
  workspacePath: "/workspace",
  mode: "task",
  activeTaskId: "task",
  updatedAt: 1,
  group: {
    chatId,
    threadId,
    name: chatId,
    ownerId: "owner",
    enabled: true,
    taskIds: ["task"],
    currentOptions: {},
  },
  ...extra,
});
describe("bound group list", () => {
  it("counts unique recorded topics without mixing bots, groups or owners", () => {
    const otherOwner = state("a", "foreign");
    otherOwner.group!.ownerId = "other";
    const rows = projectBoundGroups(
      [
        state("a"),
        state("a", "t1"),
        state("a", "t1"),
        state("a", "t2"),
        state("b"),
        state("b", "t1"),
        state("a", "other", { botId: "other" }),
        otherOwner,
        state("orphan", "t"),
        state("private", undefined, { group: undefined }),
      ],
      "bot",
      "owner",
    );
    expect(rows).toEqual([
      { chatId: "a", name: "a", enabled: true, topicCount: 2 },
      { chatId: "b", name: "b", enabled: true, topicCount: 1 },
    ]);
    expect(projectBoundGroups([state("a")], "bot", undefined)).toEqual([]);
  });
  it("uses the group switch even when topic records retain old enabled values", () => {
    const group = state("a");
    group.group!.enabled = false;
    expect(projectBoundGroups([group, state("a", "t")], "bot", "owner")[0]).toMatchObject({
      enabled: false,
      topicCount: 1,
    });
  });
});
