// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

afterEach(async () => {
  cleanup();
  const { useConversationShareSelectionStore } =
    await import("@/store/conversationShareSelectionStore.js");
  useConversationShareSelectionStore.getState().resetForTests();
});

describe("ConversationShareMenu", () => {
  it("点击入口创建默认全选的分享草稿并收起选择面板", async () => {
    const { ConversationShareMenu } = await import("@/ConversationShareMenu.js");
    const { getConversationShareDraft, useConversationShareSelectionStore } =
      await import("@/store/conversationShareSelectionStore.js");
    render(
      createElement(
        TooltipProvider,
        { delayDuration: 0 },
        createElement(ConversationShareMenu, { taskId: "task-42" }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "conversationShare.trigger" }));
    expect(
      getConversationShareDraft(useConversationShareSelectionStore.getState(), "task-42"),
    ).toMatchObject({ open: true, pendingExcludedRowIds: null, accessMode: "public_importable" });
  });

  it.each(["all", "partial", "published", "error"])(
    "分享已打开时再次点击收起并保留当前会话：%s",
    async (stage) => {
      const { ConversationShareMenu } = await import("@/ConversationShareMenu.js");
      const { getConversationShareDraft, useConversationShareSelectionStore } =
        await import("@/store/conversationShareSelectionStore.js");
      const store = useConversationShareSelectionStore.getState();
      store.openShare("task-42");
      store.syncAvailableTurns(
        "task-42",
        [11, 22].map((rowId) => ({ rowId, productTurnId: String(rowId) })),
      );
      if (stage === "partial") {
        store.beginSelectionEdit("task-42");
        store.togglePendingRow("task-42", 22);
        store.confirmSelectionEdit("task-42");
      }
      store.updateDockState("task-42", {
        title: "分享标题",
        publishedShareUrl: stage === "published" ? "https://example.com/share/test" : null,
        error:
          stage === "error"
            ? { issues: [], issueCount: 0, messageId: "conversationShare.issue.unknown" }
            : null,
      });
      store.openShare("task-other");
      store.updateDockState("task-other", { title: "另一会话" });
      const otherDraft = useConversationShareSelectionStore.getState().drafts["task-other"];
      const otherDock = useConversationShareSelectionStore.getState().dockStates["task-other"];
      render(
        createElement(
          TooltipProvider,
          { delayDuration: 0 },
          createElement(ConversationShareMenu, { taskId: "task-42" }),
        ),
      );

      fireEvent.click(screen.getByRole("button", { name: "conversationShare.trigger" }));
      const state = useConversationShareSelectionStore.getState();
      expect(getConversationShareDraft(state, "task-42").open).toBe(false);
      expect(state.dockStates["task-42"].title).toBe("分享标题");
      expect(state.drafts["task-other"]).toBe(otherDraft);
      expect(state.dockStates["task-other"]).toBe(otherDock);
      expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(screen.getByRole("button"));
      expect(
        getConversationShareDraft(useConversationShareSelectionStore.getState(), "task-42"),
      ).toMatchObject({
        open: true,
        pendingExcludedRowIds: null,
        excludedRowIds: stage === "partial" ? [22] : [],
      });
    },
  );

  it("发布过程中禁止通过顶部入口取消", async () => {
    const { ConversationShareMenu } = await import("@/ConversationShareMenu.js");
    const { useConversationShareSelectionStore } =
      await import("@/store/conversationShareSelectionStore.js");
    const store = useConversationShareSelectionStore.getState();
    store.openShare("task-42");
    store.updateDockState("task-42", { publishing: true });
    render(
      createElement(
        TooltipProvider,
        { delayDuration: 0 },
        createElement(ConversationShareMenu, { taskId: "task-42" }),
      ),
    );
    const button = screen.getByRole("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(useConversationShareSelectionStore.getState().drafts["task-42"]?.open).toBe(true);
  });
});
