// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
  }),
}));

import { ConversationDraftSuggestedPrompts } from "@/v4/ConversationDraftSuggestedPrompts.js";
import type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";

const items: DraftSuggestedPromptItem[] = [
  {
    id: "recent-commits",
    label: { cn: "检查 commit", en: "Check commits" },
    prompt: { cn: "检查当前工作区的 commit。", en: "Check workspace commits." },
  },
  {
    id: "create-pdf",
    iconName: "file-text",
    label: { cn: "制作 PDF", en: "Create PDF" },
    prompt: {
      cn: "根据当前工作区制作 PDF。",
      en: "Create a PDF from the workspace.",
    },
    plugin: {
      stableId: "document-skills@zcode-plugins-official",
      label: { cn: "文档技能", en: "Document skills" },
    },
  },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ConversationDraftSuggestedPrompts", () => {
  it("renders localized labels while preserving prompts for selection", () => {
    const view = render(createElement(ConversationDraftSuggestedPrompts, { items }));
    const rows = screen.getAllByRole("button");

    expect(rows).toHaveLength(items.length);
    for (const [index, item] of items.entries()) {
      expect(rows[index]?.textContent).toBe(item.label.cn);
      expect(rows[index]?.getAttribute("aria-label")).toBe(item.label.cn);
      expect(rows[index]?.getAttribute("title")).toBe(item.label.cn);
      expect(rows[index]?.textContent).not.toBe(item.prompt.cn);
      expect(rows[index]?.getAttribute("data-draft-suggested-prompt")).toBe(item.id);
    }
    expect(view.container.textContent).not.toContain(items[1]?.plugin?.label.cn);
  });

  it("assigns stagger delays in recommendation order", () => {
    render(createElement(ConversationDraftSuggestedPrompts, { items }));
    const rows = screen.getAllByRole("button");

    expect(rows[0]?.style.getPropertyValue("--zcode-draft-prompt-waterfall-delay")).toBe("0ms");
    expect(rows[1]?.style.getPropertyValue("--zcode-draft-prompt-waterfall-delay")).toBe("65ms");
  });

  it("loads the configured Lucide name without rendering an image URL", async () => {
    const view = render(createElement(ConversationDraftSuggestedPrompts, { items }));
    const iconSlot = view.container.querySelectorAll("[data-draft-suggested-prompt-icon]")[1];
    await waitFor(() => {
      expect(iconSlot?.querySelector('[data-client-scene-lucide-icon="file-text"]')).not.toBeNull();
    });
    expect(iconSlot?.querySelector("img")).toBeNull();
  });

  it("falls back without loading a URL when img is not a known Lucide name", () => {
    const view = render(
      createElement(ConversationDraftSuggestedPrompts, {
        items: [{ ...items[0]!, iconName: "https://cdn.example.com/icon.svg" }],
      }),
    );
    const iconSlot = view.container.querySelector("[data-draft-suggested-prompt-icon]");

    expect(iconSlot?.querySelector("img")).toBeNull();
    expect(iconSlot?.querySelector("svg.lucide-square-code")).not.toBeNull();
    expect(iconSlot?.querySelector("[data-client-scene-lucide-icon]")).toBeNull();
  });

  it("forwards the complete clicked recommendation config, and stays inert without a handler", () => {
    const onSelect = vi.fn();
    const view = render(createElement(ConversationDraftSuggestedPrompts, { items, onSelect }));
    fireEvent.click(screen.getAllByRole("button")[1]!);

    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(items[1]);
    expect(items[0]?.plugin).toBeUndefined();
    expect(items[1]?.plugin?.stableId).toBe("document-skills@zcode-plugins-official");

    view.rerender(createElement(ConversationDraftSuggestedPrompts, { items }));
    expect(() => fireEvent.click(screen.getAllByRole("button")[0]!)).not.toThrow();
  });

  it("anchors the Plugin action Popover to the selected recommendation", async () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    const view = render(
      createElement(ConversationDraftSuggestedPrompts, {
        items,
        onSelect: vi.fn(),
      }),
    );
    const originalPluginButton = screen.getByRole("button", { name: "制作 PDF" });

    view.rerender(
      createElement(ConversationDraftSuggestedPrompts, {
        items,
        onSelect: vi.fn(),
        pluginActionPopover: {
          anchorItemId: "create-pdf",
          operationId: "install-document-skills",
          phase: "confirmation",
          message: "Enable Document Skills Plugin",
          actionLabel: "确认",
          onAction,
          onDismiss,
        },
      }),
    );

    const plainButton = screen.getByRole("button", { name: "检查 commit" });
    const pluginButton = screen.getByRole("button", { name: "制作 PDF" });
    expect(pluginButton).toBe(originalPluginButton);
    expect(plainButton.hasAttribute("data-draft-suggested-plugin-popover-anchor")).toBe(false);
    expect(pluginButton.getAttribute("data-draft-suggested-plugin-popover-anchor")).toBe("true");

    const popover = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-draft-suggested-plugin-popover="confirmation"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    expect(popover.getAttribute("data-anchor-item-id")).toBe("create-pdf");
    expect(popover.getAttribute("data-side")).toBe("bottom");
    expect(popover.getAttribute("data-draft-suggested-plugin-popover-offset")).toBe("9");
    expect(popover.classList.contains("gap-3")).toBe(true);
    const confirmationMessage = popover.querySelector(
      '[data-draft-suggested-plugin-popover-message="true"]',
    );
    expect(confirmationMessage?.textContent).toBe("Enable Document Skills Plugin");

    const confirmButton = screen.getByRole("button", { name: "确认" });
    fireEvent.click(confirmButton);
    expect(onAction).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.pointerDown(document.body);
    expect(onDismiss).toHaveBeenCalledOnce();

    view.rerender(
      createElement(ConversationDraftSuggestedPrompts, {
        items,
        onSelect: vi.fn(),
        pluginActionPopover: {
          anchorItemId: "create-pdf",
          operationId: "install-document-skills",
          phase: "success",
          message: "安装成功",
        },
      }),
    );
    const resultPopover = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        '[data-draft-suggested-plugin-popover="success"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    // 确认、进度和结果阶段必须复用同一个 PopoverContent；只复用 anchor 仍会让浮窗闪断重挂。
    expect(resultPopover).toBe(popover);
    expect(resultPopover.classList.contains("gap-0")).toBe(true);
    const successContent = resultPopover.querySelector<HTMLElement>(
      '[data-draft-suggested-plugin-success-content="true"]',
    );
    const successIcon = resultPopover.querySelector<SVGElement>(
      '[data-draft-suggested-plugin-success-icon="true"]',
    );
    expect(successContent?.textContent).toBe("安装成功");
    expect(successIcon).not.toBeNull();
    expect(screen.queryByRole("button", { name: "确认" })).toBeNull();
  });

  it("renders nothing when the recommendation list is empty", () => {
    const view = render(createElement(ConversationDraftSuggestedPrompts, { items: [] }));

    expect(view.container.firstChild).toBeNull();
  });
});
