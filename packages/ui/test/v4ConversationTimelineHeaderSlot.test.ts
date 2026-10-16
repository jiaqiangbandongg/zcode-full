import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("packages/ui/src/v4/ConversationTimeline.tsx", "utf8");

describe("ConversationTimeline header slot", () => {
  it("headerSlot 落在被 mask 的消息层内，不会从 sticky composer 下方透出", () => {
    // Bug 根因：headerSlot 起初渲染在消息层之外，而淡出 mask 只作用于消息层，
    // 于是分享导入的只读内容会一直显示在输入框下方。
    const messageLayerIndex = source.indexOf('data-v4-timeline-message-layer="true"');
    const headerSlotIndex = source.indexOf('data-v4-timeline-header-slot="true"');
    const virtualHistoryIndex = source.indexOf('data-v4-timeline-virtual-history="true"');
    expect(messageLayerIndex).toBeGreaterThan(-1);
    expect(headerSlotIndex).toBeGreaterThan(messageLayerIndex);
    expect(headerSlotIndex).toBeLessThan(virtualHistoryIndex);
  });

  it("headerSlot 套用与实时消息列相同的宽度类", () => {
    // 桌面端外层没有 rail 限宽，不套用列宽会整条铺满，比正常对话明显更宽。
    const headerSlotIndex = source.indexOf('data-v4-timeline-header-slot="true"');
    const headerSlotBlock = source.slice(headerSlotIndex, headerSlotIndex + 400);
    expect(headerSlotBlock).toContain("contentWidthClassName");
    expect(headerSlotBlock).toContain("summaryPanelInlineOffsetClassName");
  });

  it("虚拟窗口按 headerSlot 高度做 scrollMargin 换算", () => {
    // 不告知这段偏移，虚拟窗口会整体错位一个 header 高度，滚到的位置是空白。
    expect(source).toContain("scrollMargin: headerSlotHeight");
    expect(source).toContain("translateY(${virtualRow.start - headerSlotHeight}px)");
  });

  it("rows 为空但有 headerSlot 时仍渲染消息层", () => {
    // 刚导入的会话没有任何实时 row，只读块必须照样出现。
    expect(source).toContain("renderUnits.length === 0 && !headerSlot ?");
  });

  it("headerSlot 异步增高时继续保持时间线吸底", () => {
    // 导入请求首次吸底时只读块可能尚未完成测高；高度变化必须重新执行底部锚定。
    const anchorStart = source.indexOf("// 底部锚定：内容变化");
    const anchorEffectStart = source.indexOf("useLayoutEffect(() => {", anchorStart);
    const anchorEnd = source.indexOf("useLayoutEffect(() => {", anchorEffectStart + 1);
    expect(anchorStart).toBeGreaterThan(-1);
    expect(source.slice(anchorStart, anchorEnd)).toContain("headerSlotHeight");
  });
});
