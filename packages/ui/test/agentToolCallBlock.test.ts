import type { IBroadcastService, IServiceAccessor } from "@zcode/services";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { testId, TID_TOOL_SUMMARY_TRIGGER } from "@zcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { useSubagentsStore } from "@/store/subagentsStore.js";
import { AgentToolCallBlock } from "../src/ToolCallBlocks/renderers/agent.js";

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

describe("AgentToolCallBlock", () => {
  afterEach(() => {
    useSubagentsStore.setState({ agents: [] });
  });

  it("keeps an Agent without a persisted child as a static one-line summary", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ServiceProvider,
          { services: mockServices },
          createElement(
            StoreProvider,
            { broadcastService: mockBroadcastService },
            createElement(AgentToolCallBlock, {
              toolCallNode: {
                toolCall: {
                  toolId: "tool-agent-running",
                  kind: "think",
                  title: "Inspect workspace",
                  input: {
                    prompt: "分析当前工作区并继续拆分任务",
                    subagent_type: "Explore",
                  },
                  output: [],
                  status: "running",
                  raw: {
                    _meta: {
                      zcode: {
                        toolName: "Agent",
                      },
                    },
                  },
                },
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
              isRunning: true,
              statusLabel: "执行中",
              errorText: undefined,
              childToolList: null,
              showIcon: true,
              forceOpen: false,
              onOpenCodeViewer: undefined,
              onOpenBrowserUrl: undefined,
            }),
          ),
        ),
      ),
    );
    expect(html).toContain(testId(TID_TOOL_SUMMARY_TRIGGER, "tool-agent-running"));
    expect(html).toContain("Inspect workspace");
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain("lucide-chevron-right");
    expect(html).not.toMatch(/提示词|Prompt/);
    expect(html).not.toContain("分析当前工作区并继续拆分任务");
  });

  it("uses a side-pane summary action instead of expandable details", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ServiceProvider,
          { services: mockServices },
          createElement(
            StoreProvider,
            { broadcastService: mockBroadcastService },
            createElement(AgentToolCallBlock, {
              toolCallNode: {
                toolCall: {
                  toolId: "tool-agent-summary-action",
                  kind: "think",
                  title: "Inspect workspace",
                  input: {
                    prompt: "分析当前工作区并继续拆分任务",
                    subagent_type: "Explore",
                  },
                  output: [],
                  status: "running",
                  raw: {
                    _meta: {
                      zcode: {
                        toolName: "Agent",
                      },
                    },
                  },
                },
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
              isRunning: true,
              statusLabel: "执行中",
              errorText: undefined,
              childToolList: null,
              showIcon: true,
              agentSummaryAction: {
                onActivate: vi.fn(),
                testId: "v4-subagent-open-side-pane-child-session",
              },
              onOpenCodeViewer: undefined,
              onOpenBrowserUrl: undefined,
            }),
          ),
        ),
      ),
    );

    expect(html).toContain('data-testid="v4-subagent-open-side-pane-child-session"');
    expect(html).toContain('aria-label="在右侧打开"');
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain("lucide-chevron-right");
    expect(html).not.toContain("subagent-output-preview");
    expect(html).not.toContain("分析当前工作区并继续拆分任务");
  });

  it("never falls back to inline prompt or child output", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ServiceProvider,
          { services: mockServices },
          createElement(
            StoreProvider,
            { broadcastService: mockBroadcastService },
            createElement(AgentToolCallBlock, {
              toolCallNode: {
                toolCall: {
                  toolId: "tool-agent-drilldown-slot",
                  kind: "think",
                  title: "Inspect workspace",
                  input: {
                    prompt: "分析当前工作区并继续拆分任务",
                    subagent_type: "Explore",
                  },
                  output: [],
                  status: "running",
                  raw: {
                    _meta: {
                      zcode: {
                        toolName: "Agent",
                      },
                    },
                  },
                },
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
              isRunning: true,
              statusLabel: "执行中",
              errorText: undefined,
              childToolList: null,
              showIcon: true,
              forceOpen: true,
              onOpenCodeViewer: undefined,
              onOpenBrowserUrl: undefined,
            }),
          ),
        ),
      ),
    );

    expect(html).not.toMatch(/提示词|Prompt/);

    expect(html).not.toContain("分析当前工作区并继续拆分任务");
    expect(html).not.toContain("subagent-output-preview");
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain("lucide-chevron-right");
    expect(html).not.toContain("在右侧打开");
    expect(html).not.toContain("子会话");
  });

  it("colors the subagent name from the configured agent color", () => {
    useSubagentsStore.setState({
      agents: [
        {
          id: "agent-explore",
          name: "Explore",
          description: "Explore workspace",
          systemPrompt: "Explore",
          color: "red",
          path: "/workspace/.zcode/agents/explore.md",
          scope: "user",
          source: "user",
          enabled: true,
        },
      ],
    });

    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ServiceProvider,
          { services: mockServices },
          createElement(
            StoreProvider,
            { broadcastService: mockBroadcastService },
            createElement(AgentToolCallBlock, {
              toolCallNode: {
                toolCall: {
                  toolId: "tool-agent-configured-color",
                  kind: "think",
                  title: "Agent",
                  input: {
                    prompt: "检查工作区",
                    subagent_type: "Explore",
                  },
                  output: [],
                  status: "completed",
                  raw: {},
                },
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
              statusLabel: "完成",
              errorText: undefined,
              childToolList: null,
              showIcon: true,
              forceOpen: false,
              onOpenCodeViewer: undefined,
              onOpenBrowserUrl: undefined,
            }),
          ),
        ),
      ),
    );

    expect(html).toContain("Explore");
    expect(html).toContain("text-rose-700");
    expect(html).toContain("inline-flex max-w-36 items-center");
    expect(html).toContain("leading-[1.5]");
    expect(html).not.toContain("leading-none");
  });

  it("keeps the agent type blank while subagent_type may still be streaming", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ServiceProvider,
          { services: mockServices },
          createElement(
            StoreProvider,
            { broadcastService: mockBroadcastService },
            createElement(AgentToolCallBlock, {
              toolCallNode: {
                toolCall: {
                  toolId: "tool-agent-streaming-type",
                  kind: "Agent",
                  title: "Agent",
                  input: {
                    description: "检查流式参数",
                    prompt: "等待完整输入",
                  },
                  output: "",
                  status: "pending",
                  raw: {
                    toolName: "Agent",
                    inputPreviewComplete: false,
                  },
                },
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
              isRunning: true,
              statusLabel: "等待中",
              errorText: undefined,
              childToolList: null,
              showIcon: true,
              forceOpen: false,
              onOpenCodeViewer: undefined,
              onOpenBrowserUrl: undefined,
            }),
          ),
        ),
      ),
    );

    expect(html).toContain("检查流式参数");
    expect(html).not.toContain("general-purpose");
  });

  it("falls back to the default general-purpose agent type only after complete input omits subagent_type", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ServiceProvider,
          { services: mockServices },
          createElement(
            StoreProvider,
            { broadcastService: mockBroadcastService },
            createElement(AgentToolCallBlock, {
              toolCallNode: {
                toolCall: {
                  toolId: "tool-agent-default-type",
                  kind: "Agent",
                  title: "Agent",
                  input: {
                    description: "抓取 bettingexpert 赔率",
                    prompt: "获取赔率信息",
                    run_in_background: true,
                  },
                  output: "Async agent launched successfully.",
                  status: "running",
                  raw: {
                    inputPreviewComplete: true,
                    _meta: {
                      zcode: {
                        toolName: "Agent",
                      },
                    },
                  },
                },
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
              isRunning: true,
              statusLabel: "执行中",
              errorText: undefined,
              childToolList: null,
              showIcon: true,
              forceOpen: false,
              onOpenCodeViewer: undefined,
              onOpenBrowserUrl: undefined,
            }),
          ),
        ),
      ),
    );

    expect(html).toContain("general-purpose");
  });

  it("uses the latest child tool summary for a collapsed running subagent", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ServiceProvider,
          { services: mockServices },
          createElement(
            StoreProvider,
            { broadcastService: mockBroadcastService },
            createElement(AgentToolCallBlock, {
              toolCallNode: {
                toolCall: {
                  toolId: "tool-agent-child-summary",
                  kind: "Agent",
                  title: "Agent",
                  input: {
                    prompt: "读取核心入口文件",
                    subagent_type: "Explore",
                  },
                  output: "",
                  status: "running",
                  raw: {
                    _meta: {
                      zcode: {
                        toolName: "Agent",
                      },
                    },
                  },
                },
                childToolCalls: [
                  {
                    toolCall: {
                      toolId: "tool-agent-child-read",
                      kind: "read",
                      title: "Read",
                      input: {
                        path: "/workspace/src/App.tsx",
                      },
                      output: "",
                      status: "running",
                      raw: {},
                    },
                    childToolCalls: [],
                  },
                ],
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
              isRunning: true,
              statusLabel: "执行中",
              errorText: undefined,
              childToolList: null,
              showIcon: true,
              forceOpen: false,
              onOpenCodeViewer: undefined,
              onOpenBrowserUrl: undefined,
            }),
          ),
        ),
      ),
    );

    // Bugfix: Agent 收起态参考普通 active Explore 聚合，使用最新子工具摘要，
    // 同时外层仍展示子智能体，而不是把子智能体类型 Explore 当 kind label。
    expect(html).toContain("lucide-bot");
    expect(html).toMatch(/>(SubAgent|子智能体)</);
    expect(html).toContain("·");
    expect(html).toContain("正在读取");
    expect(html).toContain("App.tsx");
    expect(html).toContain("/workspace/src");
    expect(html).not.toContain("读取核心入口文件");
  });

  it("does not keep a completed subagent visually running while a child tool is running", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ServiceProvider,
          { services: mockServices },
          createElement(
            StoreProvider,
            { broadcastService: mockBroadcastService },
            createElement(AgentToolCallBlock, {
              toolCallNode: {
                toolCall: {
                  toolId: "tool-agent-completed-child-running",
                  kind: "Agent",
                  title: "Agent",
                  input: {
                    prompt: "读取核心入口文件",
                    subagent_type: "Explore",
                  },
                  output: "",
                  status: "completed",
                  raw: {
                    _meta: {
                      zcode: {
                        toolName: "Agent",
                      },
                    },
                  },
                },
                childToolCalls: [
                  {
                    toolCall: {
                      toolId: "tool-agent-child-read-still-running",
                      kind: "read",
                      title: "Read",
                      input: {
                        path: "/workspace/src/App.tsx",
                      },
                      output: "",
                      status: "in_progress",
                      raw: {},
                    },
                    childToolCalls: [],
                  },
                ],
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
              statusLabel: "已执行",
              errorText: undefined,
              childToolList: null,
              showIcon: true,
              forceOpen: false,
              onOpenCodeViewer: undefined,
              onOpenBrowserUrl: undefined,
            }),
          ),
        ),
      ),
    );

    // Bugfix: 父 Agent 的完成态只看父 tool 生命周期；
    // 子工具属于展开区明细，不能让 completed 父块继续显示 running 渐变。
    expect(html).toMatch(/>(SubAgent|子智能体)</);
    expect(html).toContain("Explore");
    expect(html).not.toContain("正在读取");
    expect(html).not.toContain("App.tsx");
    expect(html).not.toContain("animated-gradient-text");
    expect(html).not.toContain("读取核心入口文件");
  });

  it("allows disabling subagent summary roll animation", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ServiceProvider,
          { services: mockServices },
          createElement(
            StoreProvider,
            { broadcastService: mockBroadcastService },
            createElement(AgentToolCallBlock, {
              toolCallNode: {
                toolCall: {
                  toolId: "tool-agent-animation-disabled",
                  kind: "Agent",
                  title: "Agent",
                  input: {
                    prompt: "读取核心入口文件",
                    subagent_type: "Explore",
                  },
                  output: "",
                  status: "running",
                  raw: {
                    _meta: {
                      zcode: {
                        toolName: "Agent",
                      },
                    },
                  },
                },
                childToolCalls: [
                  {
                    toolCall: {
                      toolId: "tool-agent-animation-disabled-child",
                      kind: "read",
                      title: "Read",
                      input: {
                        path: "/workspace/src/App.tsx",
                      },
                      output: "",
                      status: "in_progress",
                      raw: {},
                    },
                    childToolCalls: [],
                  },
                ],
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
              isRunning: true,
              statusLabel: "执行中",
              errorText: undefined,
              childToolList: null,
              showIcon: true,
              forceOpen: false,
              disableSummaryContentAnimation: true,
              onOpenCodeViewer: undefined,
              onOpenBrowserUrl: undefined,
            }),
          ),
        ),
      ),
    );

    expect(html).toContain("正在读取");
    expect(html).toContain("App.tsx");
    expect(html).not.toContain("overflow-hidden align-middle");
  });

  it("keeps the child action label for completed subagent child summaries", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ServiceProvider,
          { services: mockServices },
          createElement(
            StoreProvider,
            { broadcastService: mockBroadcastService },
            createElement(AgentToolCallBlock, {
              toolCallNode: {
                toolCall: {
                  toolId: "tool-agent-completed-child-summary",
                  kind: "Agent",
                  title: "Agent",
                  input: {
                    prompt: "读取核心入口文件",
                    subagent_type: "Explore",
                  },
                  output: "",
                  status: "running",
                  raw: {
                    _meta: {
                      zcode: {
                        toolName: "Agent",
                      },
                    },
                  },
                },
                childToolCalls: [
                  {
                    toolCall: {
                      toolId: "tool-agent-completed-child-read",
                      kind: "read",
                      title: "Read",
                      input: {
                        path: "/workspace/src/App.tsx",
                      },
                      output: "",
                      status: "completed",
                      raw: {},
                    },
                    childToolCalls: [],
                  },
                ],
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
              isRunning: true,
              statusLabel: "执行中",
              errorText: undefined,
              childToolList: null,
              showIcon: true,
              forceOpen: false,
              onOpenCodeViewer: undefined,
              onOpenBrowserUrl: undefined,
            }),
          ),
        ),
      ),
    );

    expect(html).toContain("·");
    expect(html).toContain("App.tsx");
    expect(html).toContain("正在读取");
  });

  it("summarizes TodoWrite child tools with todo progress and active content", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ServiceProvider,
          { services: mockServices },
          createElement(
            StoreProvider,
            { broadcastService: mockBroadcastService },
            createElement(AgentToolCallBlock, {
              toolCallNode: {
                toolCall: {
                  toolId: "tool-agent-todo-child-summary",
                  kind: "Agent",
                  title: "Agent",
                  input: {
                    prompt: "实现 toolcall 摘要优化",
                    subagent_type: "Explore",
                  },
                  output: "",
                  status: "running",
                  raw: {
                    _meta: {
                      zcode: {
                        toolName: "Agent",
                      },
                    },
                  },
                },
                childToolCalls: [
                  {
                    toolCall: {
                      toolId: "tool-agent-child-todo",
                      toolName: "TodoWrite",
                      kind: "TodoWrite",
                      title: "TodoWrite",
                      input: {
                        todos: [
                          {
                            content: "确认现有 Agent 摘要行为",
                            status: "completed",
                          },
                          {
                            content: "补齐待办子工具摘要",
                            status: "in_progress",
                          },
                          {
                            content: "跑回归测试",
                            status: "pending",
                          },
                        ],
                      },
                      output: "",
                      status: "running",
                      raw: {},
                    },
                    childToolCalls: [],
                  },
                ],
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
              isRunning: true,
              statusLabel: "执行中",
              errorText: undefined,
              childToolList: null,
              showIcon: true,
              forceOpen: false,
              onOpenCodeViewer: undefined,
              onOpenBrowserUrl: undefined,
            }),
          ),
        ),
      ),
    );

    expect(html).toContain("·");
    expect(html).toContain("更新待办");
    expect(html).toContain("1/3");
    expect(html).toContain("补齐待办子工具摘要");
    expect(html).not.toContain("Running TodoWrite");
  });

  it("uses SubAgent as the outer kind instead of the resolved agent type", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ServiceProvider,
          { services: mockServices },
          createElement(
            StoreProvider,
            { broadcastService: mockBroadcastService },
            createElement(AgentToolCallBlock, {
              toolCallNode: {
                toolCall: {
                  toolId: "tool-agent-numbered",
                  kind: "think",
                  title: "Agent",
                  input: {
                    description: "Explore project structure",
                    prompt: "搜索国际与商业新闻",
                  },
                  output: JSON.stringify({
                    status: "completed",
                    agentId: "agent_6e358228-a52f-427a-b1ae-d30b5cd9899e",
                    agentType: "Explore",
                    description: "Explore project structure",
                  }),
                  status: "completed",
                  raw: {
                    _meta: {
                      zcode: {
                        toolName: "Agent",
                      },
                    },
                  },
                },
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
              statusLabel: "已执行",
              errorText: undefined,
              childToolList: null,
              showIcon: true,
              forceOpen: false,
              sourceLabel: "SubAgent",
              onOpenCodeViewer: undefined,
              onOpenBrowserUrl: undefined,
            }),
          ),
        ),
      ),
    );

    // 外层 kind 固定显示 SubAgent；真实子智能体类型作为彩色名称展示。
    expect(html).toMatch(/>(SubAgent|子智能体)</);
    expect(html).toContain("·");
    expect(html).toContain("Explore project structure");
    expect(html).not.toContain("子智能体 2");
    expect(html).not.toMatch(/>Agent</);
    expect(html).toMatch(/>Explore</);
  });

  it("uses spawn_agent subagent nickname as the summary primary text", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ServiceProvider,
          { services: mockServices },
          createElement(
            StoreProvider,
            { broadcastService: mockBroadcastService },
            createElement(AgentToolCallBlock, {
              toolCallNode: {
                toolCall: {
                  toolId: "tool-spawn-agent-locke",
                  kind: "spawn_agent",
                  title: "spawn_agent",
                  input: {
                    agent_type: "explorer",
                    message: "在当前项目里做只读结构检查",
                  },
                  output: "",
                  status: "completed",
                  raw: {
                    name: "spawn_agent",
                    _meta: {
                      zcode: {
                        toolName: "spawn_agent",
                        nickname: "Locke",
                      },
                    },
                  },
                },
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
              statusLabel: "已执行",
              errorText: undefined,
              childToolList: null,
              showIcon: true,
              forceOpen: false,
              onOpenCodeViewer: undefined,
              onOpenBrowserUrl: undefined,
            }),
          ),
        ),
      ),
    );

    // Bugfix: provider 原生子 agent 工具名 spawn_agent 直接展示会暴露实现细节；
    // 外层 kind 固定为 SubAgent，nickname 作为彩色名称和摘要正文展示。
    expect(html).not.toMatch(/>explorer</);
    expect(html).toMatch(/>(SubAgent|子智能体)</);
    expect(html).toContain("Locke");
    expect(html).not.toContain("子智能体 1");
    expect(html).not.toContain("spawn_agent");
    expect(html).not.toContain("在当前项目里做只读结构检查");
  });

  it("falls back to spawn_agent agent_type when nickname is not available", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ServiceProvider,
          { services: mockServices },
          createElement(
            StoreProvider,
            { broadcastService: mockBroadcastService },
            createElement(AgentToolCallBlock, {
              toolCallNode: {
                toolCall: {
                  toolId: "tool-spawn-agent-explorer",
                  kind: "spawn_agent",
                  title: "spawn_agent",
                  input: {
                    agent_type: "explorer",
                    message: "在当前项目里做只读结构检查",
                  },
                  output: "",
                  status: "pending",
                  raw: {
                    name: "spawn_agent",
                  },
                },
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
              isRunning: true,
              statusLabel: "执行中",
              errorText: undefined,
              childToolList: null,
              showIcon: true,
              forceOpen: false,
              onOpenCodeViewer: undefined,
              onOpenBrowserUrl: undefined,
            }),
          ),
        ),
      ),
    );

    expect(html).toContain("explorer");
    expect(html).toMatch(/>(SubAgent|子智能体)</);
    expect(html).not.toContain("子智能体 1");
    expect(html).not.toContain("spawn_agent");
  });

  it("renders prompt and child tool calls without result content", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ServiceProvider,
          { services: mockServices },
          createElement(
            StoreProvider,
            { broadcastService: mockBroadcastService },
            createElement(AgentToolCallBlock, {
              toolCallNode: {
                toolCall: {
                  toolId: "tool-agent-render",
                  kind: "think",
                  title: "Explore project structure",
                  input: {
                    prompt: "请分析项目结构并列出入口点",
                    subagent_type: "Explore",
                  },
                  output: [
                    {
                      type: "text",
                      text: "这段结果不应该直接展示在 Agent 展开区",
                    },
                  ],
                  status: "completed",
                  raw: {
                    _meta: {
                      zcode: {
                        toolName: "Agent",
                      },
                    },
                  },
                },
                childToolCalls: [
                  {
                    toolCall: {
                      toolId: "tool-agent-child",
                      kind: "search",
                      title: "Find package.json",
                      input: {
                        query: "package.json",
                      },
                      output: "...",
                      status: "completed",
                      raw: {},
                    },
                    childToolCalls: [],
                  },
                ],
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
              statusLabel: "已执行",
              errorText: undefined,
              childToolList: null,
              showIcon: true,
              forceOpen: true,
              onOpenCodeViewer: undefined,
              onOpenBrowserUrl: undefined,
            }),
          ),
        ),
      ),
    );

    // Agent/Task 在消息流中固定为单行；详情只通过持久化 child session 打开。
    expect(html).toMatch(/>(SubAgent|子智能体)</);
    expect(html).toMatch(/>Explore</);
    expect(html).toContain("Explore project structure");
    expect(html).not.toMatch(/提示词|Prompt/);
    expect(html).not.toContain("请分析项目结构并列出入口点");
    expect(html).not.toContain("Find package.json");
    expect(html).not.toContain("aria-expanded");
    expect(html).not.toContain("这段结果不应该直接展示在 Agent 展开区");
  });

  it("keeps background agent internals out of the static summary", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ServiceProvider,
          { services: mockServices },
          createElement(
            StoreProvider,
            { broadcastService: mockBroadcastService },
            createElement(AgentToolCallBlock, {
              toolCallNode: {
                toolCall: {
                  toolId: "tool-background-agent",
                  kind: "think",
                  title: "Task",
                  input: {
                    prompt: "搜索今日新闻",
                    run_in_background: true,
                  },
                  output: [
                    {
                      type: "text",
                      text: "Async agent launched successfully.\nagentId: internal-agent-id (internal ID - do not mention to user.)\noutput_file: /tmp/background-agent.output\n",
                    },
                  ],
                  status: "completed",
                  raw: {
                    _meta: {
                      zcode: {
                        toolName: "Agent",
                        backgroundAgent: {
                          runInBackground: true,
                          agentId: "internal-agent-id",
                          outputFile: "/tmp/background-agent.output",
                        },
                      },
                    },
                  },
                },
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
              statusLabel: "已执行",
              errorText: undefined,
              childToolList: null,
              showIcon: true,
              forceOpen: true,
              onOpenCodeViewer: undefined,
              onOpenBrowserUrl: undefined,
            }),
          ),
        ),
      ),
    );

    expect(html).toMatch(/子智能体|SubAgent/);
    expect(html).not.toContain("/tmp/background-agent.output");
    expect(html).not.toContain("internal-agent-id");
  });

  it("does not inline background child activity", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ServiceProvider,
          { services: mockServices },
          createElement(
            StoreProvider,
            { broadcastService: mockBroadcastService },
            createElement(AgentToolCallBlock, {
              toolCallNode: {
                toolCall: {
                  toolId: "tool-background-agent-activity",
                  kind: "think",
                  title: "Task",
                  input: {
                    prompt: "后台调研项目结构",
                    run_in_background: true,
                  },
                  output: "",
                  content: "已读取 package.json，继续分析入口文件。",
                  thought: "先确认项目结构。",
                  status: "completed",
                  raw: {
                    _meta: {
                      zcode: {
                        toolName: "Agent",
                        backgroundAgent: {
                          runInBackground: true,
                        },
                      },
                    },
                  },
                },
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
              statusLabel: "已执行",
              errorText: undefined,
              childToolList: null,
              showIcon: true,
              forceOpen: true,
              onOpenCodeViewer: undefined,
              onOpenBrowserUrl: undefined,
            }),
          ),
        ),
      ),
    );

    expect(html).not.toContain("先确认项目结构。");
    expect(html).not.toContain("已读取 package.json");
    expect(html).not.toContain("data-markdown-table-sticky-scrollbar");
  });

  it("does not inline either task notification or raw background transcript", () => {
    const html = renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          ServiceProvider,
          { services: mockServices },
          createElement(
            StoreProvider,
            { broadcastService: mockBroadcastService },
            createElement(AgentToolCallBlock, {
              toolCallNode: {
                toolCall: {
                  toolId: "tool-background-agent-summary",
                  kind: "think",
                  title: "Implement Todo types and components",
                  input: {
                    prompt: "实现 Todo 类型和组件",
                    run_in_background: true,
                  },
                  output: "",
                  content: '{"isSidechain":true,"message":"raw transcript"}',
                  status: "completed",
                  raw: {
                    _meta: {
                      zcode: {
                        toolName: "Agent",
                        backgroundAgent: {
                          runInBackground: true,
                        },
                        taskNotification: {
                          outputFile: "/tmp/background-agent.output",
                          result: "All files are created and the project builds successfully.",
                        },
                      },
                    },
                  },
                },
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
              statusLabel: "已执行",
              errorText: undefined,
              childToolList: null,
              showIcon: true,
              forceOpen: true,
              onOpenCodeViewer: undefined,
              onOpenBrowserUrl: undefined,
            }),
          ),
        ),
      ),
    );

    expect(html).not.toContain("All files are created and the project builds successfully.");
    expect(html).not.toContain("raw transcript");
  });
});
