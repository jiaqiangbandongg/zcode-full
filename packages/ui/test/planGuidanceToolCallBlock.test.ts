import type { IBroadcastService, IServiceAccessor } from "@zcode/services";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { PlanGuidanceToolCallBlock } from "../src/ToolCallBlocks/renderers/plan-guidance.js";

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

function renderPlanGuidanceBlock(
  toolCall: Parameters<typeof PlanGuidanceToolCallBlock>[0]["toolCallNode"]["toolCall"],
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
          createElement(PlanGuidanceToolCallBlock, {
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
          }),
        ),
      ),
    ),
  );
}

describe("PlanGuidanceToolCallBlock", () => {
  it("renders EnterPlanMode guidance as markdown inside a tool card", () => {
    const html = renderPlanGuidanceBlock({
      toolId: "tool-enter-plan-guidance",
      kind: "other",
      title: "EnterPlanMode",
      input: {},
      output:
        "Entered plan mode.\n\n1. Thoroughly explore the codebase\n2. Consider trade-offs",
      status: "completed",
      raw: {
        _meta: {
          claudeCode: {
            toolName: "EnterPlanMode",
          },
        },
      },
    });

    expect(html).toContain("已开启 Plan Mode");
    expect(html).toContain("EnterPlanMode");
    expect(html).toContain("Entered plan mode.");
    expect(html).toContain("Thoroughly explore the codebase");
    expect(html).not.toContain("&quot;rawOutput&quot;");
  });
});
