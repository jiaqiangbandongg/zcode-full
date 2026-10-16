// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

const stylesSource = readFileSync(resolve(process.cwd(), "packages/ui/src/styles.css"), "utf8");
const componentSource = readFileSync(
  resolve(process.cwd(), "packages/ui/src/v4/ConversationDraftSuggestedPrompts.tsx"),
  "utf8",
);

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

  it("reuses shared outline buttons with the 32px Figma button-group geometry", () => {
    render(createElement(ConversationDraftSuggestedPrompts, { items }));

    for (const row of screen.getAllByRole("button")) {
      expect(row.getAttribute("data-slot")).toBe("button");
      expect(row.getAttribute("data-variant")).toBe("outline");
      expect(row.getAttribute("data-size")).toBe("lg");
      expect(row.classList.contains("h-8")).toBe(true);
      expect(row.classList.contains("w-full")).toBe(false);
      expect(row.classList.contains("justify-start")).toBe(true);
      expect(row.classList.contains("gap-1.5")).toBe(true);
      expect(row.classList.contains("rounded-lg")).toBe(true);
      expect(row.classList.contains("rounded-md")).toBe(false);
      expect(row.classList.contains("px-3")).toBe(true);
      const iconSlot = row.querySelector("[data-draft-suggested-prompt-icon]");
      // 0980f9c7bd 样式微调整把图标从 size-5 缩到 size-4，断言需与组件保持同步
      expect(iconSlot?.classList.contains("size-4")).toBe(true);
      expect(iconSlot?.classList.contains("text-foreground")).toBe(true);
      expect(iconSlot?.classList.contains("opacity-70")).toBe(true);
      expect(iconSlot?.classList.contains("transition-opacity")).toBe(true);
      expect(iconSlot?.classList.contains("group-hover/button:opacity-100")).toBe(true);
      const icon = iconSlot?.querySelector("svg, img");
      expect(icon).not.toBeNull();
      expect(icon?.classList.contains("size-4")).toBe(true);
    }
  });

  it("keeps prompts in one centered horizontal group with narrow-screen scrolling", () => {
    const view = render(
      createElement(ConversationDraftSuggestedPrompts, {
        className: "mt-3",
        items,
      }),
    );
    const scroller = view.container.querySelector<HTMLElement>("[data-v4-draft-suggested-prompts]");
    const group = view.container.querySelector<HTMLElement>(
      "[data-v4-draft-suggested-prompts-group]",
    );

    expect(scroller).not.toBeNull();
    expect(scroller?.classList.contains("w-full")).toBe(true);
    expect(scroller?.classList.contains("overflow-x-auto")).toBe(true);
    expect(scroller?.classList.contains("mt-3")).toBe(true);
    expect(group?.classList.contains("flex")).toBe(true);
    expect(group?.classList.contains("w-max")).toBe(true);
    expect(group?.classList.contains("items-center")).toBe(true);
    expect(group?.classList.contains("gap-4")).toBe(true);
    expect(group?.classList.contains("mx-auto")).toBe(true);

    for (const prompt of view.container.querySelectorAll("[data-draft-suggested-prompt-text]")) {
      expect(prompt.classList.contains("min-w-0")).toBe(true);
      expect(prompt.classList.contains("truncate")).toBe(true);
      // 0980f9c7bd 样式微调整把提示词文本从 text-ui-caption 提到 text-ui-base
      expect(prompt.classList.contains("text-ui-base")).toBe(true);
      expect(prompt.classList.contains("text-foreground")).toBe(true);
      expect(prompt.classList.contains("opacity-70")).toBe(true);
      expect(prompt.classList.contains("transition-opacity")).toBe(true);
      expect(prompt.classList.contains("group-hover/button:opacity-100")).toBe(true);
      expect(prompt.classList.contains("text-foreground-subtlest")).toBe(false);
    }
  });

  it("reveals buttons in left-to-right DOM order and disables reduced motion", () => {
    render(createElement(ConversationDraftSuggestedPrompts, { items }));
    const rows = screen.getAllByRole("button");

    expect(rows[0]?.classList.contains("zcode-draft-prompt-waterfall")).toBe(true);
    expect(rows[1]?.classList.contains("zcode-draft-prompt-waterfall")).toBe(true);
    expect(rows[0]?.style.getPropertyValue("--zcode-draft-prompt-waterfall-delay")).toBe("0ms");
    expect(rows[1]?.style.getPropertyValue("--zcode-draft-prompt-waterfall-delay")).toBe("65ms");
    expect(stylesSource).toContain("@keyframes zcode-draft-prompt-waterfall");
    expect(stylesSource).toContain("clip-path: inset(0 0 100% 0)");
    expect(stylesSource).toContain("transform: translateY(-12px)");
    expect(stylesSource).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.zcode-draft-prompt-waterfall[\s\S]*?animation: none/u,
    );
  });

  it("keeps the missing-img placeholder icon on the button foreground", () => {
    render(createElement(ConversationDraftSuggestedPrompts, { items }));

    const placeholder = screen.getAllByRole("button")[0]?.querySelector("svg");
    expect(placeholder?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(placeholder?.classList.contains("text-foreground-subtle")).toBe(false);
    expect(
      placeholder
        ?.closest("[data-draft-suggested-prompt-icon]")
        ?.classList.contains("text-foreground"),
    ).toBe(true);
  });

  it("renders the img field as a Lucide icon name and inherits the slot color", async () => {
    const view = render(createElement(ConversationDraftSuggestedPrompts, { items }));
    const iconSlot = view.container.querySelectorAll("[data-draft-suggested-prompt-icon]")[1];
    await waitFor(() => {
      expect(iconSlot?.querySelector('[data-client-scene-lucide-icon="file-text"]')).not.toBeNull();
    });
    const icon = iconSlot?.querySelector("svg");
    expect(icon?.getAttribute("stroke")).toBe("currentColor");
    expect(icon?.classList.contains("text-foreground")).toBe(false);
    expect(iconSlot?.classList.contains("text-foreground")).toBe(true);
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
    expect(popover.classList.contains("w-60")).toBe(true);
    expect(popover.classList.contains("h-auto")).toBe(true);
    expect(popover.classList.contains("h-20")).toBe(false);
    expect(popover.classList.contains("h-11")).toBe(false);
    expect(popover.classList.contains("gap-3")).toBe(true);
    expect(popover.classList.contains("p-3")).toBe(true);
    expect(popover.classList.contains("shadow-md")).toBe(true);
    expect(popover.classList.contains("max-w-[calc(100vw-2rem)]")).toBe(true);
    const confirmationMessage = popover.querySelector(
      '[data-draft-suggested-plugin-popover-message="true"]',
    );
    expect(confirmationMessage?.textContent).toBe("Enable Document Skills Plugin");
    expect(confirmationMessage?.classList.contains("leading-4.5")).toBe(true);

    const confirmButton = screen.getByRole("button", { name: "确认" });
    expect(confirmButton.classList.contains("self-end")).toBe(true);
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
    expect(resultPopover.classList.contains("w-60")).toBe(true);
    expect(resultPopover.classList.contains("h-auto")).toBe(true);
    expect(resultPopover.classList.contains("h-20")).toBe(false);
    expect(resultPopover.classList.contains("h-11")).toBe(false);
    expect(resultPopover.classList.contains("gap-0")).toBe(true);
    const successContent = resultPopover.querySelector<HTMLElement>(
      '[data-draft-suggested-plugin-success-content="true"]',
    );
    const successIcon = resultPopover.querySelector<SVGElement>(
      '[data-draft-suggested-plugin-success-icon="true"]',
    );
    expect(successContent?.textContent).toBe("安装成功");
    expect(successIcon?.classList.contains("size-4")).toBe(true);
    expect(componentSource).toContain('<AnimatePresence initial={false} mode="popLayout">');
    expect(componentSource).toContain('key={state.phase === "success" ? "success" : "steady"}');
    expect(componentSource).toContain('initial={{ y: "0.75em", opacity: 0 }}');
    expect(componentSource).toContain('exit={{ y: "-0.75em", opacity: 0 }}');
    expect(componentSource).toContain("duration: 0.2");
    expect(componentSource).toContain("ease: [0.4, 0, 0.2, 1]");
    expect(componentSource).toContain("useReducedMotion");
    expect(stylesSource).not.toContain("zcode-draft-plugin-success-flip");
    expect(screen.queryByRole("button", { name: "确认" })).toBeNull();
  });

  it("renders nothing when the recommendation list is empty", () => {
    const view = render(createElement(ConversationDraftSuggestedPrompts, { items: [] }));

    expect(view.container.firstChild).toBeNull();
  });
});
