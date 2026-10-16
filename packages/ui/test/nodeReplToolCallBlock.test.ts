import type { IBroadcastService } from "@zcode/services";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { buildNodeReplDisplayModel } from "@/lib/nodeReplToolDisplay.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { ToolCallBlock } from "@/ToolCallBlocks.js";
import { NodeReplToolCallBlock } from "@/ToolCallBlocks/renderers/node-repl.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

const localStorageState = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    clear: () => localStorageState.clear(),
    getItem: (key: string) => localStorageState.get(key) ?? null,
    removeItem: (key: string) => localStorageState.delete(key),
    setItem: (key: string, value: string) => localStorageState.set(key, value),
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
  showOutput: false,
  showKind: false,
};

function renderWithProviders(element: ReactElement) {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        StoreProvider,
        { broadcastService: mockBroadcastService },
        createElement(TooltipProvider, null, element),
      ),
    ),
  );
}

describe("node repl tool display", () => {
  it("normalizes user title, code and projected text output", () => {
    expect(
      buildNodeReplDisplayModel({
        toolId: "tool-node-repl-model",
        toolName: "js",
        kind: "js",
        title: "js",
        input: {
          code: "globalThis.browser = await agent.browsers.getDefault();",
          title: "选择浏览器并读取操作说明",
        },
        output: {
          type: "text",
          value: "# Selected Browser\n- Name: ZCode In-app Browser",
        },
        status: "completed",
      }),
    ).toMatchObject({
      operation: "run",
      userTitle: "选择浏览器并读取操作说明",
      code: "globalThis.browser = await agent.browsers.getDefault();",
      resultText: "# Selected Browser\n- Name: ZCode In-app Browser",
    });
  });

  it("removes leading blank code lines without changing the first line indentation", () => {
    const model = buildNodeReplDisplayModel({
      toolId: "tool-node-repl-leading-code-lines",
      toolName: "js",
      kind: "js",
      title: "检查页面",
      input: { code: "\n \t\r\n  const title = await tab.title();\n  return title;\n" },
      output: { type: "text", value: "Example" },
      status: "completed",
    });

    expect(model.code).toBe("  const title = await tab.title();\n  return title;\n");
  });

  it("extracts text and image blocks from the real MCP CallToolResult shape", () => {
    const model = buildNodeReplDisplayModel({
      toolId: "tool-node-repl-mcp-content",
      toolName: "mcp__node_repl__js",
      kind: "mcp__node_repl__js",
      title: "检查页面截图",
      input: { code: "await nodeRepl.emitImage(await tab.screenshot());" },
      output: {
        content: [
          { type: "text", text: "=> ready" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      },
      status: "completed",
    });

    expect(model.resultText).toBe("ready");
    expect(model.images).toEqual([{ base64: "AAAA", mimeType: "image/png" }]);
  });

  it("keeps snapshot display images without the model-facing attachment placeholder", () => {
    const toolCall = {
      toolId: "tool-node-repl-display-image",
      toolName: "mcp__node_repl__js",
      kind: "mcp__node_repl__js",
      title: "截图查看",
      input: { code: "nodeRepl.emitImage(await tab.screenshot());" },
      output: "(no output)\n[Attached image/png: MCP image]",
      raw: {
        schemaVersion: 1,
        display: {
          kind: "node_repl_images",
          images: [{ base64: "AAAA", mimeType: "image/png" }],
        },
      },
      status: "completed",
    } as const;
    const model = buildNodeReplDisplayModel(toolCall);
    const html = renderWithProviders(
      createElement(NodeReplToolCallBlock, {
        toolCallNode: { toolCall, childToolCalls: [] },
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

    expect(model.resultText).toBeUndefined();
    expect(model.images).toEqual([{ base64: "AAAA", mimeType: "image/png" }]);
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain("w-fit max-w-1/2 cursor-zoom-in overflow-hidden rounded-xl");
    expect(html).toContain("h-auto max-h-90 max-w-full rounded-xl border border-border");
    expect(html).not.toContain("Attached image");
  });

  it("投影 CUA App 身份，并把工具卡 leading icon 换成该 App 的图标", () => {
    const toolCall = {
      toolId: "tool-node-repl-cua-app",
      toolName: "mcp__node_repl__js",
      kind: "mcp__node_repl__js",
      title: "在备忘录里新建一条笔记",
      input: { code: "await app.elements(); await el.click();", title: "在备忘录里新建一条笔记" },
      output: "clicked",
      raw: {
        schemaVersion: 1,
        display: {
          kind: "node_repl_images",
          app: { appKey: "darwin:com.apple.notes", displayName: "Notes" },
        },
      },
      status: "completed",
    } as const;

    const model = buildNodeReplDisplayModel(toolCall);
    expect(model.app).toEqual({ appKey: "darwin:com.apple.notes", displayName: "Notes" });

    const html = renderWithProviders(
      createElement(NodeReplToolCallBlock, {
        toolCallNode: { toolCall, childToolCalls: [] },
        workspacePath: "/workspace",
        displayModel,
        viewerSource: null,
        rawFileSummaries: [],
        isRunning: false,
        statusLabel: "已执行",
        childToolList: null,
        forceOpen: false,
        canToggle: true,
        showIcon: true,
      }),
    );

    // 注意：SSR 不跑 effect，图标解析拿不到 data URL，因此下面两条只能证明「没退化成 CUA 的
    // 指针图标」，**不能**证明 App 图标链路接上了 —— 那部分由 nodeReplCuaAppIcon.test.ts 在
    // jsdom 下用真实 platform mock 覆盖（含去掉接线即变红的阴性对照）。
    expect(html).toContain("lucide-square-mouse-pointer");
    expect(html).not.toContain("lucide-mouse-pointer-click");
    // 摘要行仍只显示模型给的 title，不额外拼 App 名（否则和 title 重复）。
    expect(html).toContain("在备忘录里新建一条笔记");
    expect(html).not.toContain("Notes");
  });

  it("没有 App 身份时保持原有的 node_repl 图标路径", () => {
    const model = buildNodeReplDisplayModel({
      toolId: "tool-node-repl-no-app",
      toolName: "mcp__node_repl__js",
      kind: "mcp__node_repl__js",
      title: "算一下",
      input: { code: "1 + 1" },
      output: "=> 2",
      status: "completed",
    });

    expect(model.app).toBeUndefined();
  });

  it("renders a browser turn-end screenshot as a standalone image", () => {
    const toolCall = {
      toolId: "tool-browser-turn-screenshot",
      toolName: "mcp__node_repl__js",
      kind: "mcp__node_repl__js",
      input: { source: "browser_turn_end" },
      output: "",
      raw: {
        schemaVersion: 1,
        display: {
          kind: "node_repl_images",
          source: "browser_turn_end",
          images: [{ base64: "AAAA", mimeType: "image/png" }],
        },
      },
      status: "completed",
    } as const;
    const model = buildNodeReplDisplayModel(toolCall);
    const html = renderWithProviders(
      createElement(NodeReplToolCallBlock, {
        toolCallNode: { toolCall, childToolCalls: [] },
        workspacePath: "/workspace",
        displayModel,
        viewerSource: null,
        rawFileSummaries: [],
        isRunning: false,
        statusLabel: "已执行",
        childToolList: null,
        showIcon: true,
      }),
    );

    expect(model.displaySource).toBe("browser_turn_end");
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain("w-fit max-w-1/2 cursor-zoom-in overflow-hidden rounded-xl");
    expect(html).toContain("h-auto max-h-90 max-w-full rounded-xl");
    expect(html).not.toContain("查看执行详情");
    expect(html).not.toContain("执行 JavaScript");
  });

  it("removes internal completion markers from projected results", () => {
    const createModel = (value: string) =>
      buildNodeReplDisplayModel({
        toolId: "tool-node-repl-completion-marker",
        toolName: "js",
        kind: "js",
        title: "打开目标页面",
        input: { code: "await tab.goto('https://example.com');" },
        output: { type: "text", value },
        status: "completed",
      });

    expect(createModel("=> 已打开目标页面").resultText).toBe("已打开目标页面");
    expect(createModel("页面加载完成\n=> 已打开目标页面").resultText).toBe(
      "页面加载完成\n已打开目标页面",
    );
  });

  it("removes the persisted-output envelope while preserving the full result reference", () => {
    const model = buildNodeReplDisplayModel({
      toolId: "tool-node-repl-artifact",
      toolName: "js",
      kind: "js",
      title: "js",
      input: { code: "nodeRepl.write(largeResult);" },
      output: {
        type: "text",
        value:
          "<persisted-output>\nOutput too large (31 KB). Full output saved to: /tmp/full-result.json\n\nPreview (first 2 KB):\npreview text\n</persisted-output>",
      },
      status: "completed",
    });

    expect(model.resultText).toBe("preview text");
    expect(model.persistedResult).toEqual({
      artifactPath: "/tmp/full-result.json",
      sizeLabel: "31 KB",
    });
  });

  it("rejects implementation-only titles and extracts structured failures", () => {
    const model = buildNodeReplDisplayModel({
      toolId: "tool-node-repl-error",
      toolName: "js",
      kind: "js",
      title: "js",
      input: {
        code: "throw new Error('boom');",
        title: "Run JavaScript",
      },
      output: {
        logs: "",
        error: {
          name: "Error",
          message: "boom",
          stack: "Error: boom\n    at cell:1:1",
        },
      },
      status: "failed",
    });

    expect(model.userTitle).toBeUndefined();
    expect(model.error).toEqual({
      summary: "Error: boom",
      stack: "Error: boom\n    at cell:1:1",
    });
  });

  it("routes runs to a user-friendly result-first renderer without raw payloads", () => {
    const toolCall = {
      toolId: "tool-node-repl-render",
      toolName: "js",
      kind: "js",
      title: "js",
      input: {
        code: "globalThis.browser = await agent.browsers.getDefault();",
        title: "选择浏览器并读取操作说明",
      },
      output: {
        type: "text",
        value: "已选择应用内浏览器，并读取操作说明。",
      },
      status: "completed" as const,
      raw: {
        toolId: "raw-tool-id-should-not-render",
        toolName: "js",
        rawInput: { secretDebugField: "hidden" },
      },
    };
    const html = renderWithProviders(
      createElement(NodeReplToolCallBlock, {
        toolCallNode: { toolCall, childToolCalls: [] },
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

    expect(html).toContain("选择浏览器并读取操作说明");
    expect(html).toContain("已完成");
    expect(html).not.toContain("操作已完成");
    expect(html).toContain("已选择应用内浏览器，并读取操作说明。");
    expect(html).not.toContain(">结果</span>");
    expect(html).not.toContain('aria-label="复制结果"');
    expect(html).toContain("查看执行细节");
    expect(html).toContain("text-foreground-subtlest");
    expect(html).toContain("hover:bg-transparent");
    expect(html).toContain("hover:text-foreground");
    expect(html).toContain(
      "rounded-xl border border-border bg-card px-3 py-2 text-ui-base text-foreground-subtle",
    );
    expect(html).toContain("lucide-square-mouse-pointer");
    expect(html).not.toContain("font-medium whitespace-nowrap shrink-0");
    expect(html).not.toContain("Parameters");
    expect(html).not.toContain("raw-tool-id-should-not-render");
    expect(html).not.toContain("secretDebugField");
  });

  it("recovers the user title from serialized input when the projected input only has code", () => {
    const model = buildNodeReplDisplayModel({
      toolId: "tool-node-repl-serialized-title",
      toolName: "js",
      kind: "js",
      title: "js",
      input: { code: "return await tab.title();" },
      output: { type: "text", value: "Example" },
      status: "completed",
      raw: {
        rawInput: JSON.stringify({
          code: "return await tab.title();",
          title: "读取当前页面标题",
        }),
      },
    });

    expect(model.userTitle).toBe("读取当前页面标题");
  });

  it("uses friendly summaries for reset and working-directory configuration", () => {
    const resetHtml = renderWithProviders(
      createElement(ToolCallBlock, {
        toolCallNode: {
          toolCall: {
            toolId: "tool-node-repl-reset",
            toolName: "js_reset",
            kind: "js_reset",
            title: "js_reset",
            input: {},
            output: { ok: true },
            status: "completed",
          },
          childToolCalls: [],
        },
        workspacePath: "/workspace",
      }),
    );
    const configureHtml = renderWithProviders(
      createElement(ToolCallBlock, {
        toolCallNode: {
          toolCall: {
            toolId: "tool-node-repl-configure",
            toolName: "js_add_node_module_dir",
            kind: "js_add_node_module_dir",
            title: "js_add_node_module_dir",
            input: { dir: "/workspace/node_modules" },
            output: { ok: true, dirs: ["/workspace/node_modules"] },
            status: "completed",
          },
          childToolCalls: [],
        },
        workspacePath: "/workspace",
      }),
    );

    expect(resetHtml).toContain("已重置操作环境");
    expect(resetHtml).not.toContain("&quot;ok&quot;");
    expect(configureHtml).toContain("已配置运行目录");
    expect(configureHtml).toContain("/workspace/node_modules");
    expect(configureHtml).not.toContain("&quot;dirs&quot;");
  });

  it("recognizes the Codex-compatible MCP node_repl tool names", () => {
    const resetHtml = renderWithProviders(
      createElement(ToolCallBlock, {
        toolCallNode: {
          toolCall: {
            toolId: "tool-node-repl-mcp-reset",
            toolName: "mcp__node_repl__js_reset",
            kind: "mcp__node_repl__js_reset",
            title: "mcp__node_repl__js_reset",
            input: {},
            output: { ok: true },
            status: "completed",
          },
          childToolCalls: [],
        },
        workspacePath: "/workspace",
      }),
    );
    const configureHtml = renderWithProviders(
      createElement(ToolCallBlock, {
        toolCallNode: {
          toolCall: {
            toolId: "tool-node-repl-mcp-configure",
            toolName: "mcp__node_repl__js_add_node_module_dir",
            kind: "mcp__node_repl__js_add_node_module_dir",
            title: "mcp__node_repl__js_add_node_module_dir",
            input: { path: "/workspace/node_modules" },
            output: { ok: true },
            status: "completed",
          },
          childToolCalls: [],
        },
        workspacePath: "/workspace",
      }),
    );

    expect(resetHtml).toContain("已重置操作环境");
    expect(configureHtml).toContain("已配置运行目录");
    expect(configureHtml).toContain("/workspace/node_modules");
  });

  it("keeps the Node REPL renderer when MCP presentation metadata is present", () => {
    const html = renderWithProviders(
      createElement(ToolCallBlock, {
        toolCallNode: {
          toolCall: {
            toolId: "tool-node-repl-mcp-presentation",
            toolName: "mcp__node_repl__js",
            kind: "mcp__node_repl__js",
            input: {
              code: "return await tab.title();",
              title: "读取当前页面标题",
            },
            output: {
              content: [{ type: "text", text: "=> Example" }],
            },
            raw: {
              display: {
                kind: "mcp_tool",
                serverName: "node_repl",
                toolName: "js",
                description: "Run JavaScript in the persistent Node kernel.",
              },
            },
            status: "completed",
          },
          childToolCalls: [],
        },
        workspacePath: "/workspace",
      }),
    );

    expect(html).toContain("读取当前页面标题");
    expect(html).toContain("lucide-square-mouse-pointer");
    expect(html).not.toContain(">Node repl<");
  });
});
