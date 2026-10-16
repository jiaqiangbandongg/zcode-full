import type { IBroadcastService } from "@zcode/services";
import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { ToolCallBlock } from "../src/ToolCallBlocks.js";
import { ReadSessionContextToolCallBlock } from "../src/ToolCallBlocks/renderers/read-session-context.js";

const localStorageState = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    clear: () => {
      localStorageState.clear();
    },
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

const mockBroadcastService: IBroadcastService = {
  send: async () => {},
  onMessage: () => ({ dispose: () => {} }),
};

const displayModel = {
  inlinePreview: { type: "none" as const },
  planResult: null,
  viewerSource: null,
  viewerLabelId: "codeViewer.viewCode" as const,
  showSummaryFileLink: false,
  showInput: false,
  showOutput: true,
  showKind: false,
};

function renderWithProviders(element: ReactElement) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(StoreProvider, { broadcastService: mockBroadcastService }, element),
    ),
  );
}

describe("ReadSessionContextToolCallBlock", () => {
  it("renders query and returned context instead of raw parameters", () => {
    const html = renderWithProviders(
      createElement(ReadSessionContextToolCallBlock, {
        toolCallNode: {
          toolCall: {
            toolId: "tool-read-session-context",
            toolName: "ReadSessionContext",
            kind: "ReadSessionContext",
            title: "ReadSessionContext",
            input: {
              sessionId: "sess_alpha",
              query: "能否操作浏览器 browser automation 结果 result",
            },
            output: {
              status: "success",
              sessionId: "sess_alpha",
              query: "能否操作浏览器 browser automation 结果 result",
              strategy: "relevant",
              source: "lite",
              content: "- **结论**：不能直接操作浏览器。\n- 可读取截图和 URL 内容。",
              messageCount: 2,
              selectedMessageCount: 2,
              truncated: false,
            },
            status: "completed",
            raw: {
              rawInput: {
                sessionId: "sess_alpha",
                query: "能否操作浏览器 browser automation 结果 result",
              },
              rawOutput: {
                content: "raw content should not be used first",
              },
            },
          },
          childToolCalls: [],
        },
        workspacePath: "/workspace",
        displayModel,
        viewerSource: null,
        rawFileSummaries: [],
        isRunning: false,
        statusLabel: "已执行",
        childToolList: null,
        forceOpen: true,
        canToggle: true,
        showIcon: true,
      }),
    );

    expect(html).toContain("会话上下文");
    expect(html).toContain("查询");
    expect(html).toContain("能否操作浏览器 browser automation 结果 result");
    expect(html).toContain("结果");
    expect(html).toContain("不能直接操作浏览器");
    expect(html).toContain("可读取截图和 URL 内容");
    expect(html).not.toContain("Parameters");
    expect(html).not.toContain("&quot;sessionId&quot;");
    expect(html).not.toContain("&quot;messageCount&quot;");
    expect(html).not.toContain("raw content should not be used first");
  });

  it("routes ReadSessionContext through the dedicated renderer", () => {
    const html = renderWithProviders(
      createElement(ToolCallBlock, {
        toolCallNode: {
          toolCall: {
            toolId: "tool-read-session-context-route",
            toolName: "ReadSessionContext",
            kind: "ReadSessionContext",
            title: "ReadSessionContext",
            input: {
              sessionId: "sess_route",
              query: "总结迁移任务状态",
            },
            output: "ReadSessionContext returned lite context for sess_route.",
            status: "completed",
            raw: {},
          },
          childToolCalls: [],
        },
        workspacePath: "/workspace",
      }),
    );

    expect(html).toContain("会话上下文");
    expect(html).toContain("总结迁移任务状态");
    expect(html).not.toContain("工具调用");
  });
});
