// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        values ? `${id}:${JSON.stringify(values)}` : id,
    },
  }),
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("conversation partial share selection store", () => {
  beforeEach(async () => {
    const { useConversationShareSelectionStore } =
      await import("@/store/conversationShareSelectionStore.js");
    useConversationShareSelectionStore.getState().resetForTests();
  });

  it("首次进入默认全选，补齐历史时新候选仍默认选中", async () => {
    const {
      getConversationShareDraft,
      getConversationShareSelectedRowIds,
      useConversationShareSelectionStore,
    } = await import("@/store/conversationShareSelectionStore.js");
    const store = useConversationShareSelectionStore.getState();

    store.setScope("task-a", "partial");
    expect(
      getConversationShareDraft(useConversationShareSelectionStore.getState(), "task-a").stage,
    ).toBe("selection");
    expect(
      getConversationShareDraft(useConversationShareSelectionStore.getState(), "task-a").accessMode,
    ).toBe("public_importable");
    store.syncAvailableRowIds("task-a", [11, 22]);
    store.toggleRow("task-a", 22);
    store.syncAvailableRowIds("task-a", [5, 11, 22]);

    expect(
      getConversationShareSelectedRowIds(useConversationShareSelectionStore.getState(), "task-a"),
    ).toEqual([5, 11]);
  });

  it("按 productTurnId 整轮取消：同一轮的多条 query 一起移除，其他轮不受影响", async () => {
    const {
      getConversationShareSelectedProductTurnIds,
      getConversationShareSelectedRowIds,
      useConversationShareSelectionStore,
    } = await import("@/store/conversationShareSelectionStore.js");
    const store = useConversationShareSelectionStore.getState();

    store.setScope("task-a", "partial");
    // product-turn-1 含两条 steer query，UI 目录里是两项，但「取消该轮」必须整轮生效。
    store.syncAvailableTurns("task-a", [
      { rowId: 11, productTurnId: "product-turn-1" },
      { rowId: 12, productTurnId: "product-turn-1" },
      { rowId: 21, productTurnId: "product-turn-2" },
    ]);

    store.deselectProductTurn("task-a", "product-turn-1");

    let state = useConversationShareSelectionStore.getState();
    expect(getConversationShareSelectedRowIds(state, "task-a")).toEqual([21]);
    expect(getConversationShareSelectedProductTurnIds(state, "task-a")).toEqual(["product-turn-2"]);

    // 幂等：重复取消不改变状态，也不会把已排除的行再翻回来（toggle 语义的老 bug）。
    store.deselectProductTurn("task-a", "product-turn-1");
    state = useConversationShareSelectionStore.getState();
    expect(getConversationShareSelectedRowIds(state, "task-a")).toEqual([21]);
  });

  it("进入局部选择时保留用户选择的分享权限", async () => {
    const { getConversationShareDraft, useConversationShareSelectionStore } =
      await import("@/store/conversationShareSelectionStore.js");
    const store = useConversationShareSelectionStore.getState();

    store.setAccessMode("task-a", "public_importable");
    store.setScope("task-a", "partial");

    expect(
      getConversationShareDraft(useConversationShareSelectionStore.getState(), "task-a").accessMode,
    ).toBe("public_importable");
  });

  it("下一步进入配置阶段，返回选择阶段时保留所有草稿", async () => {
    const {
      getConversationShareDraft,
      getConversationShareSelectedRowIds,
      useConversationShareSelectionStore,
    } = await import("@/store/conversationShareSelectionStore.js");
    const store = useConversationShareSelectionStore.getState();

    store.setScope("task-a", "partial");
    store.syncAvailableRowIds("task-a", [11, 22]);
    store.toggleRow("task-a", 22);
    store.setAccessMode("task-a", "public_importable");
    store.goToConfiguration("task-a");

    let state = useConversationShareSelectionStore.getState();
    expect(getConversationShareDraft(state, "task-a").stage).toBe("configuration");
    expect(getConversationShareSelectedRowIds(state, "task-a")).toEqual([11]);
    expect(getConversationShareDraft(state, "task-a").accessMode).toBe("public_importable");

    store.goToSelection("task-a");
    state = useConversationShareSelectionStore.getState();
    expect(getConversationShareDraft(state, "task-a").stage).toBe("selection");
    expect(getConversationShareDraft(state, "task-a").view).toBe("selection");
    expect(getConversationShareSelectedRowIds(state, "task-a")).toEqual([11]);
    expect(getConversationShareDraft(state, "task-a").accessMode).toBe("public_importable");
  });

  it("没有选中轮次时不能进入配置阶段", async () => {
    const { getConversationShareDraft, useConversationShareSelectionStore } =
      await import("@/store/conversationShareSelectionStore.js");
    const store = useConversationShareSelectionStore.getState();
    store.setScope("task-a", "partial");
    store.syncAvailableRowIds("task-a", [11]);
    store.setAllRowsSelected("task-a", false);
    store.goToConfiguration("task-a");
    expect(
      getConversationShareDraft(useConversationShareSelectionStore.getState(), "task-a").stage,
    ).toBe("selection");
  });

  it("定位与返回面板不丢勾选草稿，且不同 session 隔离", async () => {
    const {
      getConversationShareDraft,
      getConversationShareSelectedRowIds,
      useConversationShareSelectionStore,
    } = await import("@/store/conversationShareSelectionStore.js");
    const store = useConversationShareSelectionStore.getState();

    store.setScope("task-a", "partial");
    store.syncAvailableRowIds("task-a", [11, 22]);
    store.toggleRow("task-a", 22);
    store.showTimeline("task-a");
    expect(
      getConversationShareDraft(useConversationShareSelectionStore.getState(), "task-a").view,
    ).toBe("timeline");

    store.showSelectionPanel("task-a");
    store.setScope("task-b", "partial");
    store.syncAvailableRowIds("task-b", [22]);

    const state = useConversationShareSelectionStore.getState();
    expect(getConversationShareSelectedRowIds(state, "task-a")).toEqual([11]);
    expect(getConversationShareSelectedRowIds(state, "task-b")).toEqual([22]);
    expect(getConversationShareDraft(state, "task-a").view).toBe("selection");
  });

  it("不同 session 的分享 dock 状态互不覆盖，结束一个 session 不影响另一个", async () => {
    const { getConversationShareDockState, useConversationShareSelectionStore } =
      await import("@/store/conversationShareSelectionStore.js");
    const store = useConversationShareSelectionStore.getState();

    store.setScope("task-a", "partial");
    const shareAttempt = {
      key: "attempt-a",
      clientRequestId: "share-request-a",
      disclosureAcceptedAt: 1_000,
    };
    store.updateDockState("task-a", {
      title: "分享 A",
      publishing: true,
      progress: "uploading",
      completedArtifacts: 2,
      totalArtifacts: 4,
      publishedShareUrl: "https://share.example/a",
      attempt: shareAttempt,
    });
    store.setScope("task-b", "partial");
    store.updateDockState("task-b", { title: "分享 B" });

    let state = useConversationShareSelectionStore.getState();
    expect(getConversationShareDockState(state, "task-a")).toMatchObject({
      title: "分享 A",
      publishing: true,
      progress: "uploading",
      completedArtifacts: 2,
      totalArtifacts: 4,
      publishedShareUrl: "https://share.example/a",
    });
    expect(getConversationShareDockState(state, "task-b")).toMatchObject({
      title: "分享 B",
      publishing: false,
      progress: "collecting",
      publishedShareUrl: null,
    });

    store.finishSelection("task-b");
    state = useConversationShareSelectionStore.getState();
    expect(getConversationShareDockState(state, "task-a").publishedShareUrl).toBe(
      "https://share.example/a",
    );
    expect(getConversationShareDockState(state, "task-b").publishedShareUrl).toBeNull();

    store.finishSelection("task-a");
    state = useConversationShareSelectionStore.getState();
    expect(getConversationShareDockState(state, "task-a")).toMatchObject({
      publishedShareUrl: null,
      attempt: shareAttempt,
    });
    store.setScope("task-a", "partial");
    expect(
      getConversationShareDockState(useConversationShareSelectionStore.getState(), "task-a"),
    ).toMatchObject({ attempt: shareAttempt });
  });

  it("左侧面板收起后可从全局 message 更新同一份勾选草稿", async () => {
    const {
      getConversationShareDraft,
      getConversationShareSelectedRowIds,
      useConversationShareSelectionStore,
    } = await import("@/store/conversationShareSelectionStore.js");
    const store = useConversationShareSelectionStore.getState();

    store.setScope("task-a", "partial");
    store.syncAvailableRowIds("task-a", [11, 22]);
    store.showTimeline("task-a");
    store.toggleRow("task-a", 11);

    let state = useConversationShareSelectionStore.getState();
    expect(getConversationShareDraft(state, "task-a").view).toBe("timeline");
    expect(getConversationShareSelectedRowIds(state, "task-a")).toEqual([22]);

    store.showSelectionPanel("task-a");
    state = useConversationShareSelectionStore.getState();
    expect(getConversationShareDraft(state, "task-a").view).toBe("selection");
    expect(getConversationShareSelectedRowIds(state, "task-a")).toEqual([22]);
  });

  it("底部批量操作复用同一份草稿完成取消全选与全选", async () => {
    const { getConversationShareSelectedRowIds, useConversationShareSelectionStore } =
      await import("@/store/conversationShareSelectionStore.js");
    const store = useConversationShareSelectionStore.getState();

    store.setScope("task-a", "partial");
    store.syncAvailableRowIds("task-a", [11, 22, 33]);
    store.setAllRowsSelected("task-a", false);
    expect(
      getConversationShareSelectedRowIds(useConversationShareSelectionStore.getState(), "task-a"),
    ).toEqual([]);

    useConversationShareSelectionStore.getState().setAllRowsSelected("task-a", true);
    expect(
      getConversationShareSelectedRowIds(useConversationShareSelectionStore.getState(), "task-a"),
    ).toEqual([11, 22, 33]);
  });

  it("进入局部范围或从 timeline 返回选择面板时关闭右上角浮层", async () => {
    const { useConversationShareSelectionStore } =
      await import("@/store/conversationShareSelectionStore.js");
    const store = useConversationShareSelectionStore.getState();

    store.setPopoverOpen(true);
    store.setScope("task-a", "partial");
    expect(useConversationShareSelectionStore.getState().popoverOpen).toBe(false);

    useConversationShareSelectionStore.getState().setPopoverOpen(true);
    useConversationShareSelectionStore.getState().showSelectionPanel("task-a");
    expect(useConversationShareSelectionStore.getState().popoverOpen).toBe(false);
  });

  it("configuration 阶段顶部入口不会重新打开选择面板", async () => {
    const { getConversationShareDraft, useConversationShareSelectionStore } =
      await import("@/store/conversationShareSelectionStore.js");
    const store = useConversationShareSelectionStore.getState();

    store.setScope("task-a", "partial");
    store.syncAvailableRowIds("task-a", [11]);
    store.goToConfiguration("task-a");
    store.showTimeline("task-a");
    store.showSelectionPanel("task-a");

    expect(
      getConversationShareDraft(useConversationShareSelectionStore.getState(), "task-a"),
    ).toMatchObject({
      stage: "configuration",
      view: "timeline",
    });
  });
});

describe("ConversationShareSelectionPanel", () => {
  it("按会话容器和底部 dock 的实时位置计算面板最大高度", async () => {
    const {
      CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY,
      CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY,
      resolveConversationShareSelectionPanelLayout,
      syncConversationShareSelectionPanelLayout,
    } = await import("@/v4/conversationShareSelectionPanelLayout.js");

    expect(
      resolveConversationShareSelectionPanelLayout({
        containerHeightPx: 891,
        dockStartPx: 647,
      }),
    ).toEqual({
      centerYPx: 327.5,
      maxHeightPx: 607,
      topPx: 24,
      bottomPx: 631,
    });
    expect(
      resolveConversationShareSelectionPanelLayout({
        containerHeightPx: 1200,
        dockStartPx: 1000,
      }),
    ).toEqual({
      centerYPx: 504,
      maxHeightPx: 960,
      topPx: 24,
      bottomPx: 984,
    });
    const expanded = resolveConversationShareSelectionPanelLayout({
      containerHeightPx: 1200,
      dockStartPx: 1000,
    });
    const shrunk = resolveConversationShareSelectionPanelLayout({
      containerHeightPx: 700,
      dockStartPx: 500,
    });
    expect(expanded.maxHeightPx).toBeGreaterThan(shrunk.maxHeightPx);
    expect(shrunk.bottomPx).toBeLessThanOrEqual(484);

    // 短视口/高 dock 下先回收顶部安全距，再保底最小高度，不允许压成零高度薄片。
    const collided = resolveConversationShareSelectionPanelLayout({
      containerHeightPx: 400,
      dockStartPx: 100,
    });
    expect(collided.topPx).toBe(0);
    expect(collided.maxHeightPx).toBe(120);

    // 容器本身比最小高度还矮时，面板仍必须留在容器内。
    const tiny = resolveConversationShareSelectionPanelLayout({
      containerHeightPx: 100,
      dockStartPx: 60,
    });
    expect(tiny.maxHeightPx).toBe(52);
    expect(tiny.bottomPx).toBeLessThanOrEqual(100);

    const container = document.createElement("div");
    const dock = document.createElement("div");
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 53,
      left: 0,
      top: 53,
      right: 1241,
      bottom: 944,
      width: 1241,
      height: 891,
      toJSON: () => ({}),
    });
    vi.spyOn(dock, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 700,
      left: 0,
      top: 700,
      right: 1241,
      bottom: 944,
      width: 1241,
      height: 244,
      toJSON: () => ({}),
    });

    syncConversationShareSelectionPanelLayout(container, dock);

    expect(
      container.style.getPropertyValue(CONVERSATION_SHARE_SELECTION_PANEL_MAX_HEIGHT_PROPERTY),
    ).toBe("607px");
    expect(
      container.style.getPropertyValue(CONVERSATION_SHARE_SELECTION_PANEL_CENTER_Y_PROPERTY),
    ).toBe("327.5px");
  });

  it("把减半后的可见 thumb 映射到完整轨道", async () => {
    const { resolveConversationShareScrollbarIndicatorMetrics } =
      await import("@/v4/conversationShareScrollbarMetrics.js");
    const input = {
      trackSize: 400,
      viewportSize: 400,
      contentSize: 800,
    };

    expect(
      resolveConversationShareScrollbarIndicatorMetrics({ ...input, scrollOffset: 0 }),
    ).toEqual({ visible: true, size: 100, offset: 0 });
    expect(
      resolveConversationShareScrollbarIndicatorMetrics({ ...input, scrollOffset: 200 }),
    ).toEqual({ visible: true, size: 100, offset: 150 });
    expect(
      resolveConversationShareScrollbarIndicatorMetrics({ ...input, scrollOffset: 400 }),
    ).toEqual({ visible: true, size: 100, offset: 300 });
  });

  it("复选框只更新选择，点击摘要才请求定位", async () => {
    const { ConversationShareSelectionPanel } =
      await import("@/v4/ConversationShareSelectionPanel.js");
    const onToggle = vi.fn();
    const onInspect = vi.fn();
    const items = [
      {
        key: "turn-1:query:11",
        turnId: "turn-1",
        unitIndex: 0,
        rowId: 11,
        userPreview: "第一条用户问题",
        assistantPreview: "第一条回答摘要",
        assistantPreviewKind: "text" as const,
        isRunning: false,
      },
      {
        key: "turn-2:query:22",
        turnId: "turn-2",
        unitIndex: 1,
        rowId: 22,
        userPreview: "第二条用户问题",
        assistantPreview: "第二条回答摘要",
        assistantPreviewKind: "text" as const,
        isRunning: false,
      },
    ];

    render(
      createElement(ConversationShareSelectionPanel, {
        visible: true,
        items,
        selectedRowIds: new Set([11]),
        onToggle,
        onInspect,
      }),
    );

    const panel = screen.getByTestId("conversation-share-selection-panel");
    expect(screen.queryByRole("button", { name: "conversationShare.selection.close" })).toBeNull();
    expect(panel.className).toContain("w-[14.375rem]");
    expect(panel.className).toContain("h-auto");
    expect(panel.style.height).toBe("auto");
    expect(panel.style.maxHeight).toBe(
      "var(--conversation-share-selection-panel-max-height, calc(100% - 3rem))",
    );
    expect(panel.style.top).toBe("var(--conversation-share-selection-panel-center-y, 50%)");
    expect(panel.className).toContain("left-4");
    expect(panel.className).not.toContain("left-6");
    expect(panel.className).toContain("max-md:left-2");
    expect(panel.className).toContain("ring-1");
    expect(panel.className).toContain("ring-inset");
    expect(panel.className).toContain("group/share-selection-panel");
    expect(panel.className).not.toContain("h-[min(36.75rem,calc(100%-3rem))]");
    expect(panel.className).not.toContain("-translate-y-1/2");
    expect(panel.getAttribute("data-conversation-share-keep-open")).toBeNull();
    const scrollArea = screen.getByTestId("conversation-share-selection-scroll-area");
    expect(scrollArea.className).toContain("min-h-0");
    expect(scrollArea.className).toContain("flex-1");
    expect(scrollArea.className).toContain("[&_[data-radix-scroll-area-viewport]>div]:!block");
    expect(scrollArea.className).toContain("[&_[data-radix-scroll-area-viewport]>div]:!w-full");
    expect(scrollArea.getAttribute("data-slot")).toBe("scroll-area");
    expect(scrollArea.querySelector('[data-slot="scroll-area-viewport"]')).not.toBeNull();
    const scrollBar = scrollArea.querySelector('[data-slot="scroll-area-scrollbar"]');
    expect(scrollBar?.className).toContain("opacity-0");
    expect(scrollBar?.className).toContain("group-hover/share-selection-panel:opacity-100");
    expect(scrollBar?.className).toContain("group-focus-within/share-selection-panel:opacity-100");
    expect(scrollBar?.className).toContain("data-vertical:!w-2.5");
    expect(scrollBar?.className).toContain("data-vertical:!pr-1");
    expect(scrollBar?.className).toContain("data-vertical:!pl-0");
    expect(scrollBar?.className).toContain("[&_[data-slot=scroll-area-thumb]]:!min-w-1.5");
    expect(scrollBar?.className).toContain("[&_[data-slot=scroll-area-thumb]]:!bg-transparent");
    expect(scrollBar?.className).not.toContain("scale-y-50");
    const visualThumb = screen.getByTestId("conversation-share-selection-scroll-thumb");
    expect(visualThumb.className).toContain("right-1");
    expect(visualThumb.className).toContain("w-1.5");
    const scrollShell = scrollArea.parentElement;
    expect(scrollShell?.className).toContain("flex-1");

    const summaryButton = screen.getByRole("button", { name: "第一条用户问题" });
    const firstItem = summaryButton.parentElement;
    expect(firstItem?.getAttribute("data-conversation-share-selection-state")).toBe("selected");
    expect(firstItem?.className).not.toContain("min-h-16");
    expect(firstItem?.className).toContain("items-center");
    expect(firstItem?.className).toContain("gap-3");
    expect(summaryButton.className).toContain("gap-1");
    const selectedPreviewLines = summaryButton.querySelectorAll("span");
    expect(selectedPreviewLines[0]?.className).toContain("text-foreground");
    expect(selectedPreviewLines[1]?.className).toContain("text-foreground-subtle");

    const secondSummaryButton = screen.getByRole("button", {
      name: "第二条用户问题",
    });
    const secondItem = secondSummaryButton.parentElement;
    expect(secondItem?.getAttribute("data-conversation-share-selection-state")).toBe("unselected");
    expect(secondItem?.className).toContain("items-center");
    expect(secondItem?.className).toContain("gap-2");
    expect(secondSummaryButton.className).toContain("gap-1.5");
    const unselectedPreviewLines = secondSummaryButton.querySelectorAll("span");
    expect(unselectedPreviewLines[0]?.className).toContain("text-foreground-subtlest");
    expect(unselectedPreviewLines[1]?.className).toContain("text-foreground-subtlest");

    const selectedCheckbox = screen.getByRole("checkbox", { name: "第一条用户问题" });
    const selectedCheckIcon = selectedCheckbox.querySelector('[data-slot="checkbox-checked-icon"]');
    expect(selectedCheckIcon?.getAttribute("stroke-width")).toBe("1.33");
    expect(selectedCheckIcon?.getAttribute("class")).toContain(
      "[&_path]:[vector-effect:non-scaling-stroke]",
    );
    const unselectedCheckbox = screen.getByRole("checkbox", { name: "第二条用户问题" });
    expect(unselectedCheckbox.className.split(/\s+/u)).toContain("border-foreground");
    expect(unselectedCheckbox.className.split(/\s+/u)).not.toContain("border-foreground-subtle");
    const checkboxHitAreas = panel.querySelectorAll(
      '[data-conversation-share-checkbox-hit-area="true"]',
    );
    expect(checkboxHitAreas).toHaveLength(2);
    expect(checkboxHitAreas[0]?.className).toContain("size-8");

    fireEvent.click(checkboxHitAreas[0]!);
    expect(onToggle).toHaveBeenCalledWith(11);
    expect(onInspect).not.toHaveBeenCalled();

    fireEvent.click(summaryButton);
    expect(onInspect).toHaveBeenCalledWith({ unitIndex: 0, rowId: 11 });
  });
});

describe("ConversationShareConfirmationDock", () => {
  it("配置阶段只呈现标题、权限、计数和确认操作", async () => {
    const { ConversationShareConfirmationDock } =
      await import("@/v4/ConversationShareConfirmationDock.js");
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const onBack = vi.fn();

    const { rerender } = render(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 3,
        totalCount: 5,
        onCancel,
        onConfirm,
        onBack,
        disclosureAccepted: true,
      }),
    );

    const dock = screen.getByTestId("conversation-share-confirmation-dock");
    expect(dock.className).toContain("w-full");
    expect(dock.className).not.toContain("max-w-[43.75rem]");
    expect(dock.className).toContain("rounded-2xl");
    expect(dock.className).toContain("border-input-border");
    expect(dock.className).toContain("bg-input");
    expect(dock.className).toContain("text-foreground");
    expect(dock.className).not.toContain("bg-popover");
    expect(dock.className).not.toContain("text-popover-foreground");
    expect(dock.className).not.toContain("shadow-lg");
    expect(dock.className).not.toContain("ring-1");
    expect(dock.className).not.toContain("ring-inset");
    expect(dock.className).not.toContain("rounded-t-2xl");

    const header = screen.getByTestId("conversation-share-confirmation-header");
    expect(header.textContent).toContain("conversationShare.partial.confirmationTitle");
    expect(header.textContent).toContain("conversationShare.partial.selectionHint");
    const status = screen.getByRole("status");
    expect(status.textContent).toBe(
      'conversationShare.partial.selectionCount:{"selected":3,"total":5}',
    );
    const actionRow = screen.getByTestId("conversation-share-confirmation-actions");
    expect(actionRow.className).toContain("justify-between");
    expect(actionRow.className).toContain("flex-wrap");
    expect(screen.queryByTestId("conversation-share-bulk-actions")).toBeNull();
    expect(status.className).toContain("text-ui-sm");
    expect(status.className).toContain("leading-4");
    expect(status.className).toContain("min-w-0");
    expect(status.className).not.toContain("text-foreground-subtle");
    const backButton = screen.getByRole("button", {
      name: "conversationShare.partial.back",
    });
    const cancelButton = screen.getByRole("button", { name: "conversationShare.partial.cancel" });
    const confirmButton = screen.getByRole("button", {
      name: "conversationShare.partial.confirm",
    });
    expect(cancelButton.getAttribute("data-size")).toBe("lg");
    expect(confirmButton.getAttribute("data-size")).toBe("lg");
    expect(cancelButton.className).toContain("px-3");
    expect(confirmButton.className).toContain("px-3");

    fireEvent.click(backButton);
    fireEvent.click(cancelButton);
    fireEvent.click(confirmButton);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    rerender(
      createElement(ConversationShareConfirmationDock, {
        selectedCount: 5,
        totalCount: 5,
        onCancel,
        onConfirm,
        onBack,
        disclosureAccepted: true,
      }),
    );
    expect(screen.getByRole("button", { name: "conversationShare.partial.back" })).toBeTruthy();
  });
});

describe("ConversationShareSelectionDock", () => {
  it("选择阶段提供批量操作和下一步，空选择时禁用下一步", async () => {
    const { ConversationShareSelectionDock } =
      await import("@/v4/ConversationShareSelectionDock.js");
    const onCancel = vi.fn();
    const onNext = vi.fn();
    const onSelectAll = vi.fn();
    const onDeselectAll = vi.fn();

    const { rerender } = render(
      createElement(ConversationShareSelectionDock, {
        selectedCount: 0,
        totalCount: 3,
        onCancel,
        onNext,
        onSelectAll,
        onDeselectAll,
      }),
    );

    const dock = screen.getByTestId("conversation-share-selection-dock");
    expect(dock).toBeTruthy();
    expect(dock.className).toContain("w-full");
    expect(dock.className).not.toContain("max-w-[43.75rem]");
    expect(dock.className).toContain("border-input-border");
    expect(dock.className).toContain("bg-input");
    expect(dock.className).toContain("text-foreground");
    expect(dock.className).not.toContain("bg-popover");
    expect(dock.className).not.toContain("text-popover-foreground");
    expect(dock.className).not.toContain("shadow-lg");
    expect(dock.className).not.toContain("ring-1");
    const nextButton = screen.getByRole("button", { name: "conversationShare.partial.next" });
    expect(nextButton).toHaveProperty("disabled", true);
    expect(nextButton.getAttribute("data-size")).toBe("lg");
    expect(
      screen
        .getByRole("button", { name: "conversationShare.partial.cancel" })
        .getAttribute("data-size"),
    ).toBe("lg");
    fireEvent.click(screen.getByRole("checkbox", { name: "conversationShare.partial.selectAll" }));
    expect(onSelectAll).toHaveBeenCalledTimes(1);

    rerender(
      createElement(ConversationShareSelectionDock, {
        selectedCount: 2,
        totalCount: 3,
        onCancel,
        onNext,
        onSelectAll,
        onDeselectAll,
        preflight: {
          status: "ready",
          revision: 1,
          logEpoch: "epoch-1",
          capabilitiesFingerprint: "fingerprint",
          blockingIssues: [],
          skippableWarnings: [],
          deferredIssues: [],
          supportedArtifactTypes: [],
          turnResults: [],
        },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "conversationShare.partial.next" }));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("选择阶段展示预检阻断与可跳过文件，并在检查期间禁用下一步", async () => {
    const { ConversationShareSelectionDock } =
      await import("@/v4/ConversationShareSelectionDock.js");
    const common = {
      selectedCount: 2,
      totalCount: 2,
      onCancel: vi.fn(),
      onNext: vi.fn(),
      onSelectAll: vi.fn(),
      onDeselectAll: vi.fn(),
      onDeselectTurn: vi.fn(),
    };
    const { rerender } = render(
      createElement(ConversationShareSelectionDock, {
        ...common,
        preflight: { status: "checking" },
      }),
    );
    expect(screen.queryByTestId("conversation-share-selection-preflight-checking")).toBeNull();
    expect(screen.getByTestId("conversation-share-selection-preflight-status")).toBeTruthy();
    expect(screen.getByTestId("conversation-share-next")).toHaveProperty("disabled", true);
    const nextButton = screen.getByTestId("conversation-share-next");
    expect(nextButton.textContent).toBe("conversationShare.partial.next");
    expect(nextButton.childElementCount).toBe(0);
    fireEvent.click(nextButton);
    expect(common.onNext).not.toHaveBeenCalled();

    rerender(
      createElement(ConversationShareSelectionDock, {
        ...common,
        preflight: {
          status: "ready",
          revision: 7,
          logEpoch: "epoch-1",
          capabilitiesFingerprint: "fingerprint",
          blockingIssues: [
            // turnOrdinal 只用于文案；「取消该轮」按 productTurnId 定位。
            {
              code: "running_turn",
              scope: "turn",
              turnOrdinal: 2,
              productTurnId: "product-turn-2",
            },
          ],
          skippableWarnings: [],
          deferredIssues: [],
          supportedArtifactTypes: [],
          turnResults: [],
        },
      }),
    );
    fireEvent.click(screen.getByTestId("conversation-share-selection-preflight-status"));
    expect(
      await screen.findByTestId("conversation-share-selection-preflight-popover"),
    ).toBeTruthy();
    expect(screen.getByTestId("conversation-share-next")).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "conversationShare.issue.deselectTurn" }));
    expect(common.onDeselectTurn).toHaveBeenCalledWith("product-turn-2");

    rerender(
      createElement(ConversationShareSelectionDock, {
        ...common,
        preflight: {
          status: "ready",
          revision: 7,
          logEpoch: "epoch-1",
          capabilitiesFingerprint: "fingerprint",
          blockingIssues: [],
          skippableWarnings: [
            {
              code: "artifact_type_not_allowed",
              scope: "artifact",
              turnOrdinal: 1,
              artifactDisplayName: "video.mp4",
              artifactType: "mp4",
            },
          ],
          deferredIssues: [],
          supportedArtifactTypes: [],
          turnResults: [],
        },
      }),
    );
    expect(screen.getByTestId("conversation-share-selection-preflight-status")).toBeTruthy();
    expect(screen.getByTestId("conversation-share-next")).toHaveProperty("disabled", false);
  });

  it("批量标签按内容宽度单行展示，操作按钮组整组换行不拆开", async () => {
    const { ConversationShareSelectionDock } =
      await import("@/v4/ConversationShareSelectionDock.js");
    render(
      createElement(ConversationShareSelectionDock, {
        selectedCount: 2,
        totalCount: 3,
        onCancel: vi.fn(),
        onNext: vi.fn(),
        onSelectAll: vi.fn(),
        onDeselectAll: vi.fn(),
      }),
    );

    // 固定宽度（w-12）会把英文标签拆开；改为按内容宽度保持单行。
    const label = screen.getByTestId("conversation-share-bulk-label");
    expect(label.className).toContain("whitespace-nowrap");
    expect(label.className).not.toContain("w-12");
    const bulk = screen.getByTestId("conversation-share-bulk-actions");
    expect(bulk.className).toContain("shrink-0");
    // 空间不足时取消/下一步整组换行并右对齐，而不是被挤压裁切。
    const actionRow = bulk.nextElementSibling!;
    expect(actionRow.className).toContain("ml-auto");
    expect(actionRow.className).toContain("shrink-0");
  });

  it("传输类阻断提供重新检查入口，轮次级阻断仍只给取消勾选", async () => {
    const { ConversationShareSelectionDock } =
      await import("@/v4/ConversationShareSelectionDock.js");
    const common = {
      selectedCount: 2,
      totalCount: 2,
      onCancel: vi.fn(),
      onNext: vi.fn(),
      onSelectAll: vi.fn(),
      onDeselectAll: vi.fn(),
      onDeselectTurn: vi.fn(),
      onRetryPreflight: vi.fn(),
    };
    const readyPreflight = {
      status: "ready" as const,
      revision: 7,
      logEpoch: "epoch-1",
      capabilitiesFingerprint: "fingerprint",
      skippableWarnings: [],
      deferredIssues: [],
      supportedArtifactTypes: [],
      turnResults: [],
    };
    const { rerender } = render(
      createElement(ConversationShareSelectionDock, {
        ...common,
        preflight: {
          ...readyPreflight,
          blockingIssues: [{ code: "unknown" as const, scope: "transport" as const }],
        },
      }),
    );
    fireEvent.click(screen.getByTestId("conversation-share-selection-preflight-status"));
    expect(
      await screen.findByTestId("conversation-share-selection-preflight-popover"),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId("conversation-share-preflight-retry"));
    expect(common.onRetryPreflight).toHaveBeenCalledTimes(1);

    rerender(
      createElement(ConversationShareSelectionDock, {
        ...common,
        preflight: {
          ...readyPreflight,
          blockingIssues: [
            {
              code: "running_turn" as const,
              scope: "turn" as const,
              turnOrdinal: 2,
            },
          ],
        },
      }),
    );
    expect(screen.queryByTestId("conversation-share-preflight-retry")).toBeNull();
  });
});

describe("conversation share selection mode motion", () => {
  it("面板与遮罩复用 200ms 缓入缓出节奏，并为减弱动效立即切换", async () => {
    const {
      CONVERSATION_SHARE_MODE_EASING,
      CONVERSATION_SHARE_MODE_PANEL_OFFSET_PX,
      CONVERSATION_SHARE_MODE_TRANSITION_DURATION_SECONDS,
      resolveConversationShareSelectionPanelMotion,
      resolveConversationShareSelectionScrimMotion,
    } = await import("@/v4/conversationShareModeMotion.js");

    expect(CONVERSATION_SHARE_MODE_PANEL_OFFSET_PX).toBe(8);
    expect(CONVERSATION_SHARE_MODE_TRANSITION_DURATION_SECONDS).toBe(0.2);
    expect(CONVERSATION_SHARE_MODE_EASING).toEqual([0.4, 0, 0.2, 1]);
    expect(resolveConversationShareSelectionPanelMotion(false)).toEqual({
      initial: { opacity: 0, transform: "translate3d(-8px, -50%, 0)" },
      animate: { opacity: 1, transform: "translate3d(0, -50%, 0)" },
      exit: { opacity: 0, transform: "translate3d(-8px, -50%, 0)" },
      transition: { duration: 0.2, ease: [0.4, 0, 0.2, 1] },
    });
    expect(resolveConversationShareSelectionScrimMotion(false)).toEqual({
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: { duration: 0.2, ease: [0.4, 0, 0.2, 1] },
    });
    expect(resolveConversationShareSelectionPanelMotion(true)).toEqual({
      initial: false,
      animate: { opacity: 1, transform: "translate3d(0, -50%, 0)" },
      exit: { opacity: 1, transform: "translate3d(0, -50%, 0)" },
      transition: { duration: 0 },
    });
    expect(resolveConversationShareSelectionScrimMotion(true)).toEqual({
      initial: false,
      animate: { opacity: 1 },
      exit: { opacity: 1 },
      transition: { duration: 0 },
    });

    const { ConversationShareSelectionScrim } =
      await import("@/v4/ConversationShareSelectionScrim.js");
    render(createElement(ConversationShareSelectionScrim, { visible: true }));
    const scrim = screen.getByTestId("conversation-share-selection-scrim");
    expect(scrim.className).toContain("bg-background/60");
    expect(scrim.className).toContain("z-10");
  });

  it("选择面板展开时背景遮罩可切换 timeline，非交互态不响应", async () => {
    const { ConversationShareSelectionScrim } =
      await import("@/v4/ConversationShareSelectionScrim.js");
    const onBackdropClick = vi.fn();
    const { rerender } = render(
      createElement(ConversationShareSelectionScrim, {
        visible: true,
        interactive: true,
        onBackdropClick,
      }),
    );

    const scrim = screen.getByTestId("conversation-share-selection-scrim");
    expect(scrim.className).toContain("pointer-events-auto");
    fireEvent.click(scrim);
    expect(onBackdropClick).toHaveBeenCalledTimes(1);

    rerender(
      createElement(ConversationShareSelectionScrim, {
        visible: true,
        interactive: false,
        onBackdropClick,
      }),
    );
    expect(scrim.className).toContain("pointer-events-none");
    fireEvent.click(scrim);
    expect(onBackdropClick).toHaveBeenCalledTimes(1);
  });
});

describe("conversation partial share visual policy", () => {
  it("只在左侧选择面板展开时锁定并置灰背景，收起到 timeline 后同时恢复", async () => {
    const {
      resolveConversationShareBackgroundScrollLocked,
      resolveConversationShareSelectionPanelVisible,
    } = await import("@/v4/conversationShareModePolicy.js");

    expect(
      resolveConversationShareBackgroundScrollLocked({
        partialShareActive: true,
        view: "selection",
      }),
    ).toBe(true);
    expect(
      resolveConversationShareSelectionPanelVisible({
        partialShareActive: true,
        view: "selection",
      }),
    ).toBe(true);
    expect(
      resolveConversationShareBackgroundScrollLocked({
        partialShareActive: true,
        stage: "configuration",
        view: "selection",
      }),
    ).toBe(false);
    expect(
      resolveConversationShareSelectionPanelVisible({
        partialShareActive: true,
        stage: "configuration",
        view: "selection",
      }),
    ).toBe(false);
    expect(
      resolveConversationShareBackgroundScrollLocked({
        partialShareActive: true,
        view: "timeline",
      }),
    ).toBe(false);
    expect(
      resolveConversationShareBackgroundScrollLocked({
        partialShareActive: false,
        view: "selection",
      }),
    ).toBe(false);
    expect(
      resolveConversationShareSelectionPanelVisible({
        partialShareActive: true,
        view: "selection",
      }),
    ).toBe(true);
    expect(
      resolveConversationShareSelectionPanelVisible({
        partialShareActive: true,
        view: "timeline",
      }),
    ).toBe(false);
  });
});

describe("conversation share selection interaction policy", () => {
  it("局部勾选期间禁用全局 message 框选，退出后恢复", async () => {
    const { resolveConversationSelectionTooltipEnabled } =
      await import("@/v4/conversationShareModePolicy.js");

    expect(
      resolveConversationSelectionTooltipEnabled({
        selectionActionsEnabled: true,
        partialShareActive: false,
      }),
    ).toBe(true);
    expect(
      resolveConversationSelectionTooltipEnabled({
        selectionActionsEnabled: true,
        partialShareActive: true,
      }),
    ).toBe(false);
    expect(
      resolveConversationSelectionTooltipEnabled({
        selectionActionsEnabled: false,
        partialShareActive: false,
      }),
    ).toBe(false);
  });
});

describe("ConversationBottomDockTransition", () => {
  it("chat 下移退出，确认面板从下方上移进入，并为减弱动效立即切换", async () => {
    const {
      CONVERSATION_BOTTOM_DOCK_ENTER_DURATION_SECONDS,
      CONVERSATION_BOTTOM_DOCK_ENTER_SCALE,
      CONVERSATION_BOTTOM_DOCK_EXIT_DURATION_SECONDS,
      CONVERSATION_BOTTOM_DOCK_EXIT_SCALE,
      CONVERSATION_BOTTOM_DOCK_TRANSITION_OFFSET_PX,
      CONVERSATION_BOTTOM_DOCK_TRANSITION_EASING,
      ConversationBottomDockTransition,
      resolveConversationBottomDockMotion,
    } = await import("@/v4/ConversationBottomDockTransition.js");

    expect(CONVERSATION_BOTTOM_DOCK_TRANSITION_OFFSET_PX).toBe(32);
    expect(CONVERSATION_BOTTOM_DOCK_ENTER_SCALE).toBe(0.96);
    expect(CONVERSATION_BOTTOM_DOCK_EXIT_SCALE).toBe(0.97);
    expect(CONVERSATION_BOTTOM_DOCK_ENTER_DURATION_SECONDS).toBe(0.26);
    expect(CONVERSATION_BOTTOM_DOCK_EXIT_DURATION_SECONDS).toBe(0.18);
    expect(CONVERSATION_BOTTOM_DOCK_TRANSITION_EASING).toEqual([0.23, 1, 0.32, 1]);
    expect(resolveConversationBottomDockMotion(false)).toEqual({
      initial: { opacity: 0, transform: "translate3d(0, 32px, 0) scale(0.96)" },
      animate: {
        opacity: 1,
        transform: "translate3d(0, 0, 0) scale(1)",
        transition: { duration: 0.26, ease: [0.23, 1, 0.32, 1] },
      },
      exit: {
        opacity: 0,
        transform: "translate3d(0, 32px, 0) scale(0.97)",
        transition: { duration: 0.18, ease: [0.23, 1, 0.32, 1] },
      },
    });
    expect(resolveConversationBottomDockMotion(true)).toEqual({
      initial: false,
      animate: {
        opacity: 1,
        transform: "translate3d(0, 0, 0) scale(1)",
        transition: { duration: 0 },
      },
      exit: {
        opacity: 1,
        transform: "translate3d(0, 0, 0) scale(1)",
        transition: { duration: 0 },
      },
    });

    render(
      createElement(
        ConversationBottomDockTransition,
        { mode: "chat" },
        createElement("div", null, "Chat dock"),
      ),
    );
    expect(screen.getByTestId("conversation-bottom-dock-transition").className).toContain("grid");
    const layer = screen.getByTestId("conversation-bottom-dock-transition-layer");
    expect(layer.className).toContain("col-start-1");
    expect(layer.className).toContain("row-start-1");
    expect(layer.className).toContain("self-end");
    expect(layer.className).toContain("origin-bottom");
    expect(layer.className).toContain("will-change-transform");
    // 回归护栏：grid 子项默认 min-width:auto 会把隐式列轨道顶在 composer 的
    // min-content 宽度上，面板收窄时右侧被裁掉。min-w-0 是可收缩的前提。
    expect(layer.className).toContain("min-w-0");
  });
});
