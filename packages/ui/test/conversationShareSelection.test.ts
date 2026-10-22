// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render as rtlRender, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip.js";
const render = (ui: Parameters<typeof rtlRender>[0]) => rtlRender(ui, { wrapper: TooltipProvider });
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

    store.openShare("task-a");
    expect(
      getConversationShareDraft(useConversationShareSelectionStore.getState(), "task-a").open,
    ).toBe(true);
    expect(
      getConversationShareDraft(useConversationShareSelectionStore.getState(), "task-a").accessMode,
    ).toBe("public_importable");
    store.syncAvailableTurns(
      "task-a",
      [11, 22].map((rowId) => ({ rowId, productTurnId: String(rowId) })),
    );
    store.beginSelectionEdit("task-a");
    store.togglePendingRow("task-a", 22);
    store.confirmSelectionEdit("task-a");
    store.syncAvailableTurns(
      "task-a",
      [5, 11, 22].map((rowId) => ({ rowId, productTurnId: String(rowId) })),
    );

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

    store.openShare("task-a");
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
    store.openShare("task-a");

    expect(
      getConversationShareDraft(useConversationShareSelectionStore.getState(), "task-a").accessMode,
    ).toBe("public_importable");
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

  it("toggles through checkbox, summary and row while the locate action only inspects", async () => {
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
    expect(panel.getAttribute("data-conversation-share-keep-open")).toBeNull();

    const summaryButton = screen.getByRole("button", { name: "第一条用户问题" });
    const firstItem = summaryButton.parentElement;
    expect(firstItem?.getAttribute("data-conversation-share-selection-state")).toBe("selected");

    const secondSummaryButton = screen.getByRole("button", {
      name: "第二条用户问题",
    });
    const secondItem = secondSummaryButton.parentElement;
    expect(secondItem?.getAttribute("data-conversation-share-selection-state")).toBe("unselected");

    const checkboxHitAreas = panel.querySelectorAll(
      '[data-conversation-share-checkbox-hit-area="true"]',
    );
    expect(checkboxHitAreas).toHaveLength(2);

    fireEvent.click(checkboxHitAreas[0]!);
    expect(onToggle).toHaveBeenCalledWith(11);
    expect(onInspect).not.toHaveBeenCalled();

    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.click(summaryButton);
    expect(onToggle).toHaveBeenCalledTimes(2);
    expect(onInspect).not.toHaveBeenCalled();
    fireEvent.click(firstItem!);
    expect(onToggle).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getAllByTestId("conversation-share-selection-locate")[0]!);
    expect(onToggle).toHaveBeenCalledTimes(3);
    expect(onInspect).toHaveBeenCalledWith({ unitIndex: 0, rowId: 11 });
  });
});

describe("ConversationShareConfirmationDock", () => {
  it("浮窗配置使用范围按钮调整内容，关闭和生成各自触发回调", async () => {
    const { ConversationShareConfirmationDock } =
      await import("@/v4/ConversationShareConfirmationDock.js");
    const onCancel = vi.fn(),
      onEditSelection = vi.fn(),
      onConfirm = vi.fn();
    render(
      createElement(ConversationShareConfirmationDock, {
        title: "分享标题",
        selectedCount: 3,
        totalCount: 5,
        disclosureAccepted: true,
        onCancel,
        onEditSelection,
        onConfirm,
      }),
    );
    expect(screen.getByTestId("conversation-share-confirmation-header").textContent).toContain(
      "conversationShare.popover.title",
    );
    fireEvent.click(screen.getByTestId("conversation-share-range-summary"));
    fireEvent.click(screen.getByRole("button", { name: "conversationShare.result.dismiss" }));
    fireEvent.click(screen.getByTestId("conversation-share-confirm"));
    expect(onEditSelection).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("conversation-share-back")).toBeNull();
  });
});

describe("ConversationSharePreflightStatus", () => {
  it("只展示预检诊断与问题操作，检查态由范围按钮承载", async () => {
    const { ConversationSharePreflightStatus } =
      await import("@/conversation-share-interaction/ConversationSharePreflightStatus.js");
    const common = {
      onDeselectTurn: vi.fn(),
    };
    const { rerender } = render(
      createElement(ConversationSharePreflightStatus, {
        ...common,
        preflight: { status: "checking" },
      }),
    );
    expect(screen.queryByTestId("conversation-share-selection-preflight-status")).toBeNull();
    expect(screen.queryByTestId("conversation-share-next")).toBeNull();

    rerender(
      createElement(ConversationSharePreflightStatus, {
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
    fireEvent.click(screen.getByRole("button", { name: "conversationShare.issue.deselectTurn" }));
    expect(common.onDeselectTurn).toHaveBeenCalledWith("product-turn-2");

    rerender(
      createElement(ConversationSharePreflightStatus, {
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
  });

  it("传输类阻断提供重新检查入口，轮次级阻断仍只给取消勾选", async () => {
    const { ConversationSharePreflightStatus } =
      await import("@/conversation-share-interaction/ConversationSharePreflightStatus.js");
    const common = {
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
      createElement(ConversationSharePreflightStatus, {
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
      createElement(ConversationSharePreflightStatus, {
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
  it("面板保持 200ms 动效，减弱动效时立即切换", async () => {
    const { resolveConversationShareSelectionPanelMotion } =
      await import("@/v4/conversationShareModeMotion.js");
    expect(resolveConversationShareSelectionPanelMotion(false)).toEqual({
      initial: { opacity: 0, transform: "translate3d(-8px, -50%, 0)" },
      animate: { opacity: 1, transform: "translate3d(0, -50%, 0)" },
      exit: { opacity: 0, transform: "translate3d(-8px, -50%, 0)" },
      transition: { duration: 0.2, ease: [0.4, 0, 0.2, 1] },
    });
    expect(resolveConversationShareSelectionPanelMotion(true)).toEqual({
      initial: false,
      animate: { opacity: 1, transform: "translate3d(0, -50%, 0)" },
      exit: { opacity: 1, transform: "translate3d(0, -50%, 0)" },
      transition: { duration: 0 },
    });
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
  it("returns animated and reduced-motion configurations for the bottom dock", async () => {
    const { resolveConversationBottomDockMotion } =
      await import("@/v4/ConversationBottomDockTransition.js");

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
  });
});

it.each(["idle", "stale", "checking"] as const)("有选择但预检 %s 时不能确认", async (status) => {
  const { ConversationShareSelectionPanel } =
    await import("@/v4/ConversationShareSelectionPanel.js");
  const confirm = vi.fn();
  render(
    createElement(ConversationShareSelectionPanel, {
      visible: true,
      items: [
        {
          key: "1",
          rowId: 1,
          unitIndex: 0,
          userPreview: "hello",
          assistantPreview: "world",
          isRunning: false,
        },
      ],
      selectedRowIds: new Set([1]),
      preflight: { status },
      onToggle: vi.fn(),
      onInspect: vi.fn(),
      onCancel: vi.fn(),
      onConfirm: confirm,
    }),
  );
  const apply = screen.getByTestId("conversation-share-selection-apply") as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  fireEvent.click(apply);
  expect(confirm).not.toHaveBeenCalled();
});
