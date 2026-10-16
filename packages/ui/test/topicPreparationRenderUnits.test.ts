import { describe, expect, it } from "vitest";
import type { UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { withTopicPreparationMessages } from "@/v4/topicPreparationRenderUnits.js";
import { splitConversationTimelineLiveTail } from "@/v4/conversationTimelineLiveTail.js";
const pending = [
  { messageId: "a", senderName: "Alice", text: "hello", status: "preparing" as const },
];
describe("topic messages in conversation flow", () => {
  it("renders before any CLI row without manufacturing accepted input or a running task", () => {
    const units = withTopicPreparationMessages([], [], pending);
    expect(units).toHaveLength(1);
    expect(units[0]?.topicPreparations).toEqual(pending);
    expect(units[0]?.renderRows).toEqual([]);
    expect(units[0]?.visibleUserInputs).toEqual([]);
    expect(units[0]?.isRunning).toBe(false);
  });
  it("keeps the running tail in normal flow when preparation arrives", () => {
    const base = withTopicPreparationMessages([], [], pending)[0]!;
    const running = { ...base, key: "running", isRunning: true, topicPreparations: undefined };
    const units = withTopicPreparationMessages([running], [], pending);
    expect(units).toHaveLength(1);
    expect(units[0]?.key).toBe("running");
    expect(splitConversationTimelineLiveTail(units).liveUnit?.topicPreparations).toEqual(pending);
    expect(running.topicPreparations).toBeUndefined();
  });
  it("formal original ID replaces preparation while preserving canonical units", () => {
    const row = {
      kind: "userInput",
      botGroupSource: { messageId: "b", messages: [{ messageId: "a" }] },
    } as UserInputRow;
    const units = withTopicPreparationMessages([], [], []);
    expect(withTopicPreparationMessages(units, [row], pending)).toBe(units);
  });
  it("does not leave a blank render unit after preparation fails", () => {
    expect(
      withTopicPreparationMessages([], [], [{ ...pending[0]!, status: "failed", error: "failed" }]),
    ).toEqual([]);
  });
});
