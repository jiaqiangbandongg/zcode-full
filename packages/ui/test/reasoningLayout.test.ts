import type { IBroadcastService, IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { createElement } from "react";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import {
  getReasoningBottomDistance,
  getReasoningSummaryMaskStyle,
  isReasoningScrollAtBottom,
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
  isReasoningSummaryOverflowing,
  resolveReasoningStreamingSummary,
  shouldAutoCollapseReasoning,
} from "../src/components/ai-elements/reasoning.js";

const mockServices = {} as IServiceAccessor;
const mockPlatform = {
  reportTelemetryEvent: async () => {},
} as unknown as IPlatformService;
const mockBroadcastService: IBroadcastService = {
  send: async () => {},
  onMessage: () => ({ dispose: () => {} }),
};

const localStorageState = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    clear: () => localStorageState.clear(),
    getItem: (key: string) => localStorageState.get(key) ?? null,
    removeItem: (key: string) => {
      localStorageState.delete(key);
    },
    setItem: (key: string, value: string) => {
      localStorageState.set(key, value);
    },
  },
});

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    documentElement: {
      classList: {
        contains: () => false,
        toggle: () => {},
      },
    },
  },
});

function renderReasoningContent(
  content: string,
  reasoningProps: Partial<ComponentProps<typeof Reasoning>> = {},
  contentProps: Partial<ComponentProps<typeof ReasoningContent>> = {},
  locale: "zh-CN" | "en-US" = "zh-CN",
) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(
        ServiceProvider,
        { services: mockServices },
        createElement(
          PlatformProvider,
          { platform: mockPlatform },
          createElement(
            StoreProvider,
            { broadcastService: mockBroadcastService },
            createElement(
              Reasoning,
              { className: "w-full", defaultOpen: true, ...reasoningProps },
              createElement(ReasoningTrigger, { streamingText: content }),
              createElement(ReasoningContent, contentProps, content),
            ),
          ),
        ),
      ),
    ),
  );
}

describe("Reasoning layout", () => {
  it("renders expanded thought content as plain text instead of Markdown", () => {
    const html = renderReasoningContent("**阶段一**\n\n# 计划\n`命令`");

    expect(html).toContain("**阶段一**");
    expect(html).toContain("# 计划");
    expect(html).toContain("`命令`");
    expect(html).not.toContain("<strong>");
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("<code>");
  });

  it("auto collapses only for a new output boundary without user interaction", () => {
    expect(
      shouldAutoCollapseReasoning({
        autoCollapseKey: "content:1",
        previousAutoCollapseKey: null,
        userInteracted: false,
      }),
    ).toBe(true);
    expect(
      shouldAutoCollapseReasoning({
        autoCollapseKey: "content:1",
        previousAutoCollapseKey: "content:1",
        userInteracted: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoCollapseReasoning({
        autoCollapseKey: "content:1",
        previousAutoCollapseKey: null,
        userInteracted: true,
      }),
    ).toBe(false);
    expect(
      shouldAutoCollapseReasoning({
        autoCollapseKey: null,
        previousAutoCollapseKey: null,
        userInteracted: false,
      }),
    ).toBe(false);
  });

  it("removes the left guide and indentation for nested reasoning content", () => {
    const html = renderReasoningContent("CUA 子思考。", {}, { variant: "nested" });

    expect(html).toContain('data-reasoning-content-variant="nested"');
    expect(html).not.toContain("border-l");
    expect(html).not.toContain("ml-2");
    expect(html).not.toContain("pl-3.5");
  });

  it("renders only the latest reasoning line without converting it to a break", () => {
    const html = renderReasoningContent("正在分析输入。\n继续检查实现。", {
      defaultOpen: false,
      isStreaming: true,
    });

    expect(html).toContain("正在思考");
    expect(html).not.toContain("思考过程");
    expect(html).toContain("animated-gradient-text");
    expect(html).not.toContain("正在分析输入。");
    expect(html).toContain("继续检查实现。");
    expect(html).not.toContain("<br");
    expect(html).toContain('data-state="closed"');
    expect(html).toContain('data-reasoning-label="true"');
    expect(html).toContain('data-reasoning-streaming-text="true"');
    expect(html).toContain('data-reasoning-streaming-roll="true"');
  });

  it("derives a stable rolling key per non-empty reasoning line", () => {
    expect(resolveReasoningStreamingSummary("第一行正在生成")).toEqual({
      key: "0",
      text: "第一行正在生成",
    });
    expect(resolveReasoningStreamingSummary("第一行完成\n\n第二行正在生成")).toEqual({
      key: "2",
      text: "第二行正在生成",
    });
    expect(resolveReasoningStreamingSummary(" \n\t ")).toBeNull();
  });

  it("shows elapsed duration instead of the inline summary while streaming is expanded", () => {
    const html = renderReasoningContent("正在分析输入。", {
      defaultOpen: true,
      duration: 7,
      isStreaming: true,
    });

    expect(html).toContain("思考");
    expect(html).not.toContain("思考过程");
    expect(html).toContain("持续了 7 秒");
    expect(html).toContain('data-state="open"');
    expect(html).not.toContain("animated-gradient-text");
    expect(html).not.toContain('data-reasoning-streaming-line="true"');
  });

  it("renders the English duration directly without a leading preposition", () => {
    const html = renderReasoningContent(
      "Checking the implementation.",
      { defaultOpen: false, duration: 2, isStreaming: false },
      {},
      "en-US",
    );

    expect(html).toContain("Thought");
    expect(html).toContain("2 seconds");
    expect(html).not.toContain("for 2 seconds");
  });

  it("adds a two-sided fade mask only while the streaming summary overflows", () => {
    expect(isReasoningSummaryOverflowing({ clientWidth: 240, scrollWidth: 240 })).toBe(false);
    expect(isReasoningSummaryOverflowing({ clientWidth: 240, scrollWidth: 420 })).toBe(true);
    expect(getReasoningSummaryMaskStyle(false)).toBeUndefined();
    expect(getReasoningSummaryMaskStyle(true)).toMatchObject({
      WebkitMaskImage:
        "linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)",
      maskImage:
        "linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)",
    });
  });

  it("keeps completed reasoning closed when defaultOpen is false", () => {
    const html = renderReasoningContent("已经完成的思考。", {
      defaultOpen: false,
      isStreaming: false,
    });

    expect(html).toContain("思考");
    expect(html).not.toContain("思考过程");
    expect(html).toContain("持续了");
    expect(html).not.toContain("animated-gradient-text");
    expect(html).not.toContain("已经完成的思考。");
    expect(html).toContain('data-state="closed"');
  });

  it("treats only the bottom lock zone as auto-followable", () => {
    expect(
      getReasoningBottomDistance({
        clientHeight: 100,
        scrollHeight: 260,
        scrollTop: 120,
      }),
    ).toBe(40);
    expect(
      isReasoningScrollAtBottom({
        clientHeight: 100,
        scrollHeight: 260,
        scrollTop: 120,
      }),
    ).toBe(false);
    expect(
      isReasoningScrollAtBottom({
        clientHeight: 100,
        scrollHeight: 260,
        scrollTop: 159,
      }),
    ).toBe(true);
    expect(
      isReasoningScrollAtBottom({
        clientHeight: 100,
        scrollHeight: 260,
        scrollTop: 160,
      }),
    ).toBe(true);
  });
});
