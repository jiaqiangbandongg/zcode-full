import { describe, expect, it } from "vitest";
import { buildGitCommitMessageConversationContext } from "@/git-action-menu/commitConversationContext.js";

describe("buildGitCommitMessageConversationContext", () => {
  it("keeps recent visible user and assistant messages for commit generation", () => {
    const context = buildGitCommitMessageConversationContext({
      sessionId: "session-1",
      messages: [
        {
          role: "user",
          content: "把自动生成内容和自动提交分开",
        },
        {
          role: "assistant",
          content: "已经拆开生成和提交动作。",
        },
        {
          role: "assistant",
          content: "上下文压缩完成",
          syntheticTimeline: { type: "context_compaction" },
        },
        {
          role: "assistant",
          content: "",
          parts: [{ type: "content", content: "提交弹窗改成手动提交。" }],
        },
      ],
    });

    expect(context).toEqual({
      sessionId: "session-1",
      omittedMessageCount: 0,
      messages: [
        {
          role: "user",
          content: "把自动生成内容和自动提交分开",
        },
        {
          role: "assistant",
          content: "已经拆开生成和提交动作。",
        },
        {
          role: "assistant",
          content: "提交弹窗改成手动提交。",
        },
      ],
    });
  });

  it("clips long conversation context before sending it to the git service", () => {
    const context = buildGitCommitMessageConversationContext({
      messages: Array.from({ length: 14 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message-${index} ${"x".repeat(800)}`,
      })),
    });

    expect(context?.messages).toHaveLength(6);
    expect(context?.omittedMessageCount).toBe(8);
    expect(context?.messages[0]?.content).toContain("message-8");
    expect(context?.messages[0]?.content).toContain("...message truncated...");
  });
});
