import { expect, it } from "vitest";
import { replyToChannelToolEntry } from "../../src/tool/handlers/reply-to-channel.js";
import {
  channelReplyPartsSchema,
  type ChannelReplyTool,
} from "../../src/tool/channel-reply/contract.js";

const entry: ChannelReplyTool = replyToChannelToolEntry;

it("渠道回复仍按严格的逐项参数契约校验", () => {
  const parts = [{ type: "text", text: "请确认" }];
  expect(channelReplyPartsSchema.parse(parts)).toEqual(parts);
  expect(entry.runtimeInputSchema?.safeParse({ parts }).success).toBe(true);
  expect(entry.runtimeInputSchema?.safeParse({ parts, extra: true }).success).toBe(false);
  expect(channelReplyPartsSchema.safeParse([{ type: "mention" }]).success).toBe(false);
});

it("保留延迟曝光及网络写入的调度属性", () => {
  expect(entry.metadata).toMatchObject({
    shouldDefer: true,
    readOnly: false,
    concurrentSafe: false,
    sideEffectScope: "network",
  });
});
