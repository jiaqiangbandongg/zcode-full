import { describe, expect, it } from "vitest";

import {
  parseConversationShareContext,
  resolveAttachableShareContext,
} from "@/lib/conversationShareContext.js";

/** 历史消息里可能残留的 share URL 尾块；写入端已删除，这里只验证读取端能剥干净。 */
function withShareContextBlock(text: string, payload: Record<string, unknown>): string {
  const block = [
    "# zcode-share-context:",
    "```zcode-share-context",
    JSON.stringify(payload),
    "```",
  ].join("\n");
  return text ? `${text}\n\n${block}` : block;
}

describe("conversation share context reference", () => {
  it("把历史消息里的 share URL 尾块从可见正文剥掉", () => {
    const encoded = withShareContextBlock("继续分析", {
      contextId: "context-1",
      shareUrl: "https://zcode.z.ai/cn/share/share-1",
    });
    expect(parseConversationShareContext(encoded)).toEqual({
      visibleContent: "继续分析",
      reference: {
        contextId: "context-1",
        shareUrl: "https://zcode.z.ai/cn/share/share-1",
      },
    });
  });

  it("rejects signed/download URLs and unknown fields", () => {
    const parsed = parseConversationShareContext(
      [
        "继续分析",
        "",
        "# zcode-share-context:",
        "```zcode-share-context",
        JSON.stringify({
          contextId: "context-1",
          shareUrl: "https://signed.example/download?token=secret",
          markdown: "must-not-cross-ui",
        }),
        "```",
      ].join("\n"),
    );
    expect(parsed.reference).toBeNull();
    expect(parsed.visibleContent).toContain("# zcode-share-context:");
  });
});

/**
 * 线上故障回归：composer 原本从一个平行的 sharedContextImport prop 读 handover context，
 * 而 SessionPane 从没传过它。结果首条消息永远不带 sharedContextRefs，CLI 侧
 * pending→reserved→attached 一步都走不了，shared_context 消息被 hydrator 永久跳过——
 * 会话顶部的只读块照常显示，模型却全程没拿到分享内容，肉眼完全看不出来。
 *
 * 现在改成从 snapshot 推导。这组用例钉住「什么情况下应该带 refs」这个判定本身。
 */
describe("resolveAttachableShareContext", () => {
  const pending = {
    contextId: "context-1",
    title: "来自分享：X",
    shareUrl: "https://zcode.z.ai/cn/share/share-1",
    status: "pending",
  };

  it("pending 必须可 attach —— 否则模型永远拿不到分享内容", () => {
    expect(resolveAttachableShareContext(pending)).toEqual(pending);
  });

  it("reserved（已进队列但还没消费）仍然可 attach", () => {
    expect(resolveAttachableShareContext({ ...pending, status: "reserved" })?.status).toBe(
      "reserved",
    );
  });

  it("discarded 不再 attach", () => {
    expect(resolveAttachableShareContext({ ...pending, status: "discarded" })).toBeNull();
  });

  it("legacy 形状（只有 title、没有 contextId）不 attach：构不出 refs", () => {
    expect(resolveAttachableShareContext({ title: "来自分享：X" })).toBeNull();
  });

  it("没有 handover context 时返回 null", () => {
    expect(resolveAttachableShareContext(null)).toBeNull();
    expect(resolveAttachableShareContext(undefined)).toBeNull();
  });
});
