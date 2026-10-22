import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
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

  it("renders update toast content and an action", () => {
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
  });

  it("renders Source Server update copy and an accessible dismiss action", () => {
    const html = renderToStaticMarkup(
      createElement(ToastMessageView, {
        item: {
          id: 6,
          message: "linux-amd64-dev 必须更新后才能连接\n当前 3.8.1，需要 3.9.0。",
          durationMs: 8000,
          position: "top-center",
          variant: "source-server-update",
          actionLabel: "立即更新",
          onAction: vi.fn(),
          dismissible: true,
          dismissLabel: "关闭",
        },
        visible: true,
        onDismiss: vi.fn(),
      }),
    );

    expect(html).toContain("linux-amd64-dev 必须更新后才能连接");
    expect(html).toContain("当前 3.8.1，需要 3.9.0。");
    expect(html).toContain("立即更新");
    expect(html).toContain('aria-label="关闭"');
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
  });

  it("renders multiline notice copy with its action", () => {
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
