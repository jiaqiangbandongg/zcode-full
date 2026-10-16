import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  resolveToastStackClassName,
  upsertToastItem,
  resolveToastAnchorLeft,
  ToastMessageView,
} from "@/components/ui/toast.js";

describe("toast", () => {
  it("同一目标与动作替换旧消息，不同消息保持最新在底部", () => {
    const first = {
      id: 1,
      message: "Provider A 保存成功",
      durationMs: 3000,
      position: "bottom-left" as const,
      dedupeKey: "provider-save:provider-a",
    };
    const second = {
      id: 2,
      message: "model-a 连接成功",
      durationMs: 3000,
      position: "bottom-left" as const,
      dedupeKey: "model-test:provider-a:model-a",
    };
    const replacement = { ...first, id: 3, message: "Provider A 再次保存成功" };

    expect(upsertToastItem(upsertToastItem([], first), second)).toEqual([first, second]);
    expect(upsertToastItem([first, second], replacement)).toEqual([second, replacement]);
  });

  it("centers an anchored toast within its region", () => {
    expect(resolveToastAnchorLeft({ left: 280, width: 960 })).toBe(760);
  });

  it("uses real viewport insets for every stack and never translates a bottom stack outside", () => {
    expect(resolveToastStackClassName("top-center")).toContain("top-16");
    expect(resolveToastStackClassName("top-right")).toContain("top-16");
    expect(resolveToastStackClassName("bottom-left")).toContain("bottom-");
    expect(resolveToastStackClassName("bottom-center")).toContain("bottom-");
    expect(resolveToastStackClassName("bottom-left")).not.toContain("translate-y");
    expect(resolveToastStackClassName("bottom-center")).not.toContain("translate-y");
    expect(resolveToastStackClassName("bottom-center")).toContain("left-1/2");
    expect(resolveToastStackClassName("bottom-center")).toContain("-translate-x-1/2");
  });

  it("renders update toasts as a softer actionable notice", () => {
    const html = renderToStaticMarkup(
      createElement(ToastMessageView, {
        item: {
          id: 1,
          message: "反馈有新回复\n模型切换报错有新的处理回复，可查看详情。",
          durationMs: 7000,
          position: "bottom-left",
          variant: "update",
          actionLabel: "查看",
          onAction: vi.fn(),
        },
        visible: true,
        isBottom: true,
      }),
    );

    expect(html).toContain("反馈有新回复");
    expect(html).toContain("查看");
    expect(html).toContain("border-popover-border");
    expect(html).toContain("bg-toast/60");
    expect(html).toContain("backdrop-blur-xl");
    expect(html).toContain("rounded-2xl");
    expect(html).not.toContain("rounded-full border");
    expect(html).not.toContain("bg-popover");
    expect(html).toContain("origin-bottom-left");
  });

  it("keeps update toasts compact when title and action are present", () => {
    const html = renderToStaticMarkup(
      createElement(ToastMessageView, {
        item: {
          id: 2,
          message: "Update ready\nRestart the app to use the latest version.",
          durationMs: 7000,
          position: "bottom-left",
          variant: "update",
          actionLabel: "Restart",
          onAction: vi.fn(),
        },
        visible: true,
        isBottom: true,
      }),
    );

    expect(html).toContain("max-w-[min(300px,calc(100vw-1rem))]");
    expect(html).toContain("w-[min(300px,calc(100vw-1rem))]");
    expect(html).toContain("grid-cols-[auto_minmax(0,1fr)_auto]");
    expect(html).toContain("max-w-14");
  });

  it("renders a dismissible actionable info toast for subscription guidance", () => {
    const html = renderToStaticMarkup(
      createElement(ToastMessageView, {
        item: {
          id: 3,
          message: "Idle-time tasks are available for Coding Plan subscribers only.",
          durationMs: 8000,
          position: "top-right",
          variant: "info",
          actionLabel: "Upgrade",
          onAction: vi.fn(),
          dismissible: true,
        },
        visible: true,
        onDismiss: vi.fn(),
      }),
    );

    expect(html).toContain("Coding Plan subscribers only");
    expect(html).toContain("Upgrade");
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain("w-[min(536px,calc(100vw-2rem))]");
    expect(html).toContain("gap-4");
    expect(html).toContain("flex-[1_0_0]");
    expect(html).toContain("py-3");
    expect(html).not.toContain("min-h-15");
    expect(html).toContain("whitespace-normal");
    expect(html).toContain("max-w-1/2");
    expect(html).toContain("underline");
    expect(html).toContain("bg-toast/60");
    expect(html).toContain("backdrop-blur-xl");
    expect(html).toContain("rounded-2xl");
    expect(html).not.toContain("rounded-full border");
  });

  it("centers a notice action vertically beside multiline content", () => {
    const html = renderToStaticMarkup(
      createElement(ToastMessageView, {
        item: {
          id: 4,
          message: "文档技能\n插件未安装",
          durationMs: 5000,
          position: "top-right",
          variant: "info",
          actionLabel: "一键安装",
          onAction: vi.fn(),
        },
        visible: true,
      }),
    );

    expect(html).toContain("文档技能");
    expect(html).toContain("插件未安装");
    expect(html).toContain("一键安装");
    expect(html).toContain("self-center");
  });

  it("moves top-right toasts from right to left with reduced-motion fallback", () => {
    const item = {
      id: 5,
      message: "Idle-time tasks are available for Coding Plan subscribers only.",
      durationMs: 8000,
      position: "top-right" as const,
      variant: "info" as const,
    };
    const hiddenHtml = renderToStaticMarkup(
      createElement(ToastMessageView, {
        item,
        visible: false,
      }),
    );
    const visibleHtml = renderToStaticMarkup(
      createElement(ToastMessageView, {
        item,
        visible: true,
      }),
    );

    expect(hiddenHtml).toContain("transition-[transform,opacity]");
    expect(hiddenHtml).toContain("duration-200");
    expect(hiddenHtml).toContain("ease-[cubic-bezier(0.77,0,0.175,1)]");
    expect(hiddenHtml).toContain("translate-x-[calc(100%+1rem)]");
    expect(hiddenHtml).toContain("opacity-0");
    expect(hiddenHtml).toContain("motion-reduce:transform-none");
    expect(visibleHtml).toContain("translate-x-0");
    expect(visibleHtml).toContain("opacity-100");
    expect(visibleHtml).not.toContain("-translate-y-1");
  });
});
