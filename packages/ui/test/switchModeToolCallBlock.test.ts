import type { IBroadcastService, IServiceAccessor } from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SwitchModeToolCallBlock } from "../src/ToolCallBlocks/renderers/switch-mode.js";

const localStorageState = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localStorageState.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageState.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageState.delete(key);
    },
    clear: () => {
      localStorageState.clear();
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

const mockServices = {
  fileService: {
    readMediaPreview: async () => ({
      path: "/workspace/assets/logo.png",
      mediaType: "image/png",
      dataBase64: "",
      totalBytes: 0,
    }),
  },
} as IServiceAccessor;

function renderSwitchModeBlock(
  toolCall: Parameters<typeof SwitchModeToolCallBlock>[0]["toolCallNode"]["toolCall"],
) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        ServiceProvider,
        { services: mockServices },
        createElement(
          StoreProvider,
          { broadcastService: mockBroadcastService },
          createElement(SwitchModeToolCallBlock, {
            toolCallNode: {
              toolCall,
              childToolCalls: [],
            },
            workspacePath: "/workspace",
            displayModel: {
              inlinePreview: { type: "none" },
              planResult: null,
              viewerSource: null,
              viewerLabelId: "codeViewer.viewCode",
              showSummaryFileLink: false,
              showInput: false,
              showOutput: false,
              showKind: false,
            },
            viewerSource: null,
            rawFileSummaries: [],
            isRunning: false,
            statusLabel: "Completed",
            errorText: undefined,
            childToolList: null,
            forceOpen: true,
            canToggle: true,
            showIcon: true,
            onOpenCodeViewer: () => {},
            onOpenBrowserUrl: () => {},
            onOpenPlanDetail: () => {},
          }),
        ),
      ),
    ),
  );
}

describe("SwitchModeToolCallBlock", () => {
  it("renders markdown from input.plan instead of raw json", () => {
    const html = renderSwitchModeBlock({
      toolId: "tool-switch-mode",
      kind: "switch_mode",
      title: "Exited Plan Mode",
      input: {
        plan: "# 输出计划\n\n- 渲染 markdown",
        planFilePath: "plans/rosy-orbiting-backus.md",
      },
      output: "...",
      status: "completed",
      raw: {
        rawOutput: "...",
      },
    });

    expect(html).toContain("输出计划");
    expect(html).toContain("渲染 markdown");
    expect(html).toContain("rosy-orbiting-backus.md");
    expect(html).toContain("计划");
    expect(html).not.toContain("3 行");
    expect(html).toContain("复制计划");
    expect(html).toContain("在侧边栏查看计划");
    expect(html).toContain("查看完整计划");
    expect(html.match(/在侧边栏查看计划/g)).toHaveLength(1);
    expect(html).not.toContain("展开计划");
    expect(html).not.toContain("收起计划");
    expect(html).not.toContain("&quot;plan&quot;");
  });
});
