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
    ).toMatchObject({ scope: "partial", view: "timeline", accessMode: "public_importable" });
  });

  it.each(["all", "partial", "configuration", "published", "error"])(
    "分享已打开时再次点击取消当前会话：%s",
    async (stage) => {
      const { ConversationShareMenu } = await import("@/ConversationShareMenu.js");
      const { getConversationShareDraft, useConversationShareSelectionStore } =
        await import("@/store/conversationShareSelectionStore.js");
      const store = useConversationShareSelectionStore.getState();
      store.setScope("task-42", "partial");
      store.syncAvailableRowIds("task-42", [11, 22]);
      if (stage === "partial") store.toggleRow("task-42", 22);
      if (stage !== "all" && stage !== "partial") store.goToConfiguration("task-42");
      store.updateDockState("task-42", {
        title: "分享标题",
        publishedShareUrl: stage === "published" ? "https://example.com/share/test" : null,
        error:
          stage === "error"
            ? { issues: [], issueCount: 0, messageId: "conversationShare.issue.unknown" }
            : null,
      });
      store.setScope("task-other", "partial");
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
      expect(getConversationShareDraft(state, "task-42").scope).toBe("all");
      expect(state.dockStates["task-42"]).toBeUndefined();
      expect(state.drafts["task-other"]).toBe(otherDraft);
      expect(state.dockStates["task-other"]).toBe(otherDock);
      expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(screen.getByRole("button"));
      expect(
        getConversationShareDraft(useConversationShareSelectionStore.getState(), "task-42"),
      ).toMatchObject({ scope: "partial", view: "timeline", excludedRowIds: [] });
    },
  );

  it("发布过程中禁止通过顶部入口取消", async () => {
    const { ConversationShareMenu } = await import("@/ConversationShareMenu.js");
    const { useConversationShareSelectionStore } =
      await import("@/store/conversationShareSelectionStore.js");
    const store = useConversationShareSelectionStore.getState();
    store.setScope("task-42", "partial");
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
    expect(useConversationShareSelectionStore.getState().drafts["task-42"]?.scope).toBe("partial");
  });

  it.each([false, true])(
    "与工具栏共用尺寸和图标，Windows caption=%s",
    async (useWindowsCaptionSpacing) => {
      const { ConversationShareMenu } = await import("@/ConversationShareMenu.js");
      render(
        createElement(
          TooltipProvider,
          { delayDuration: 0 },
          createElement(ConversationShareMenu, {
            taskId: "task-42",
            useWindowsCaptionSpacing,
          }),
        ),
      );
      const trigger = screen.getByRole("button", { name: "conversationShare.trigger" });
      expect(trigger.getAttribute("data-size")).toBe("icon-md");
      expect(trigger.className).toContain(useWindowsCaptionSpacing ? "ml-3" : "ml-2.5");
      expect(trigger.className.includes("h-full")).toBe(useWindowsCaptionSpacing);
      expect(trigger.querySelector("svg.size-4")).not.toBeNull();
      expect(trigger.querySelector("[style]")).toBeNull();
    },
  );
});
