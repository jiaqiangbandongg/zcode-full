import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TurnHeaderRow,
  V4ConversationFileChangesResult,
} from "@zcode/shared/zcode-protocol-v4";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationFileSummaryPanel } from "@/v4/ConversationFileSummaryPanel.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

const { collapsibleOpenChanges, openSplitButtonProps } = vi.hoisted(() => ({
  collapsibleOpenChanges: [] as Array<(open: boolean) => void>,
  openSplitButtonProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/components/ui/collapsible.js", async () => {
  const React = await import("react");
  return {
    Collapsible: ({
      children,
      className,
      onOpenChange,
    }: {
      children?: React.ReactNode;
      className?: string;
      onOpenChange?: (open: boolean) => void;
    }) => {
      if (onOpenChange) collapsibleOpenChanges.push(onOpenChange);
      return React.createElement("div", { className, "data-slot": "collapsible" }, children);
    },
    CollapsibleContent: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", { "data-slot": "collapsible-content" }, children),
    CollapsibleTrigger: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

vi.mock("@/OpenSplitButton.js", async () => {
  const React = await import("react");
  return {
    OpenSplitButton: (props: Record<string, unknown>) => {
      openSplitButtonProps.push(props);
      return React.createElement("button", { type: "button" }, "打开");
    },
  };
});

function header(overrides: Partial<TurnHeaderRow> = {}): TurnHeaderRow {
  return {
    rowId: 1,
    entityId: "turn-header-1",
    turnId: "turn-1",
    createdAt: 1_700_000_000_000,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1_700_000_000_000,
    actions: { canRewindFiles: true },
    fileChanges: {
      files: 1,
      additions: 11,
      deletions: 0,
      state: "active",
    },
    ...overrides,
  };
}

function renderPanel(contextOverrides: Partial<ConversationRowRenderContext> = {}) {
  const context: ConversationRowRenderContext = {
    workspacePath: "/workspace",
    theme: "system",
    codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
    fetchFileChanges: async () => ({
      files: 1,
      additions: 11,
      deletions: 0,
      items: [
        {
          path: "/workspace/input.html",
          additions: 11,
          deletions: 0,
          writeCount: 1,
          toolNames: ["Write"],
          patches: [
            {
              oldStart: 1,
              oldLines: 0,
              newStart: 1,
              newLines: 11,
              lines: ["+<html>"],
            },
          ],
        },
      ],
    }),
    ...contextOverrides,
  };
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ConversationFileSummaryPanel, {
        header: header(),
        context,
      }),
    ),
  );
}

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: Node) => {
      Object.assign(child, { parentNode: element });
      element.childNodes.push(child);
      return child;
    },
    childNodes: [] as Node[],
    getAttribute: (name: string) => element.attributes.get(name) ?? null,
    insertBefore: (child: Node, beforeChild?: Node | null) => {
      Object.assign(child, { parentNode: element });
      const beforeIndex = beforeChild ? element.childNodes.indexOf(beforeChild) : -1;
      if (beforeIndex >= 0) {
        element.childNodes.splice(beforeIndex, 0, child);
      } else {
        element.childNodes.push(child);
      }
      return child;
    },
    attributes: new Map<string, string>(),
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as Node | null,
    removeAttribute: (name: string) => {
      element.attributes.delete(name);
    },
    removeChild: (child: Node) => {
      element.childNodes = element.childNodes.filter((item) => item !== child);
      Object.assign(child, { parentNode: null });
      return child;
    },
    removeEventListener: () => {},
    setAttribute: (name: string, value: string) => {
      element.attributes.set(name, String(value));
    },
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createComment: (nodeValue: string) => ({
      nodeType: 8,
      nodeValue,
      parentNode: null,
    }),
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document & { defaultView?: unknown };
  const windowMock = {
    addEventListener: () => {},
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
  };
  documentMock.defaultView = windowMock;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock, "div");
}

function collectText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const candidate = node as {
    childNodes?: unknown[];
    nodeValue?: string;
    textContent?: string;
  };
  if (typeof candidate.nodeValue === "string") return candidate.nodeValue;
  if (candidate.childNodes && candidate.childNodes.length > 0) {
    return candidate.childNodes.map((child) => collectText(child)).join("");
  }
  return typeof candidate.textContent === "string" ? candidate.textContent : "";
}

function collectClassNames(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const candidate = node as {
    attributes?: Map<string, string>;
    childNodes?: unknown[];
  };
  const ownClassName = candidate.attributes?.get("class");
  return [
    ...(ownClassName ? [ownClassName] : []),
    ...(candidate.childNodes?.flatMap((child) => collectClassNames(child)) ?? []),
  ];
}

afterEach(() => {
  collapsibleOpenChanges.length = 0;
  openSplitButtonProps.length = 0;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
});

describe("ConversationFileSummaryPanel", () => {
  it.each([false, true])(
    "visualize 混合摘要只统计普通文件，compact=%s",
    async (compactForRemoteControl) => {
      const container = installMinimalDom();
      const root = createRoot(container);
      const path = "/workspace/visualizations/calendar.html";
      const fetchFileChanges = vi.fn(async () => ({
        files: 2,
        additions: 77,
        deletions: 3,
        items: [
          { path, additions: 70, deletions: 1, patches: [] },
          { path: "/workspace/app.ts", additions: 7, deletions: 2, patches: [] },
        ],
      }));
      await act(async () => {
        root.render(
          createElement(
            ZCodeIntlProvider,
            { initialLocale: "zh-CN" },
            createElement(ConversationFileSummaryPanel, {
              header: header({
                fileChanges: { files: 2, additions: 77, deletions: 3, state: "active" },
              }),
              assistantText: `::visualize${JSON.stringify({ path })}`,
              context: {
                workspacePath: "/workspace",
                theme: "system",
                codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
                compactForRemoteControl,
                fetchFileChanges,
              },
            }),
          ),
        );
      });
      expect(fetchFileChanges).toHaveBeenCalledTimes(1);
      expect(collectText(container)).toContain("1 个文件已更改");
      expect(collectText(container)).toContain("+7");
      expect(collectText(container)).toContain("-2");
      expect(collectText(container)).not.toContain("+77");
      await act(async () => collapsibleOpenChanges.at(-1)?.(true));
      expect(collectText(container)).toContain("app.ts");
      expect(collectText(container)).not.toContain("calendar.html");
      await act(async () => root.unmount());
    },
  );

  it("仅有 visualize 时，详情到达前后都不显示摘要", async () => {
    const container = installMinimalDom();
    const root = createRoot(container);
    const path = "/workspace/calendar.html";
    const pending = Promise.withResolvers<V4ConversationFileChangesResult>();
    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationFileSummaryPanel, {
            header: header(),
            assistantText: `::visualize${JSON.stringify({ path })}`,
            context: {
              workspacePath: "/workspace",
              theme: "system",
              codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
              fetchFileChanges: () => pending.promise,
            },
          }),
        ),
      );
    });
    expect(collectText(container)).toBe("");
    await act(async () =>
      pending.resolve({
        items: [{ path, additions: 11, deletions: 0, patches: [] }],
      }),
    );
    expect(collectText(container)).toBe("");
    await act(async () => root.unmount());
  });

  it("切换轮次后不接受旧请求晚到的详情", async () => {
    const container = installMinimalDom();
    const root = createRoot(container);
    const path = "/workspace/calendar.html";
    const first = Promise.withResolvers<V4ConversationFileChangesResult>();
    const second = Promise.withResolvers<V4ConversationFileChangesResult>();
    const fetchFileChanges = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const context: ConversationRowRenderContext = {
      workspacePath: "/workspace",
      theme: "system",
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
      fetchFileChanges,
    };
    const render = (rowId: number) =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationFileSummaryPanel, {
          header: header({ rowId, entityId: `header-${rowId}` }),
          context,
          assistantText: `::visualize${JSON.stringify({ path })}`,
        }),
      );
    await act(async () => root.render(render(1)));
    await act(async () => root.render(render(2)));
    await act(async () =>
      first.resolve({ items: [{ path: "/workspace/old.ts", additions: 999, patches: [] }] }),
    );
    expect(collectText(container)).toBe("");
    await act(async () =>
      second.resolve({
        items: [
          { path, additions: 70, patches: [] },
          { path: "/workspace/new.ts", additions: 7, deletions: 2, patches: [] },
        ],
      }),
    );
    expect(collectText(container)).toContain("+7");
    expect(collectText(container)).not.toContain("999");
    await act(async () => root.unmount());
  });

  it("详情失败时保留原摘要，展开可重试过滤", async () => {
    const container = installMinimalDom();
    const root = createRoot(container);
    const path = "/workspace/calendar.html";
    const fetchFileChanges = vi
      .fn()
      .mockRejectedValueOnce(new Error("fixture read failure"))
      .mockResolvedValueOnce({ items: [{ path, additions: 11, deletions: 0, patches: [] }] });
    await act(async () =>
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationFileSummaryPanel, {
            header: header(),
            assistantText: `::visualize${JSON.stringify({ path })}`,
            context: {
              workspacePath: "/workspace",
              theme: "system",
              codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
              fetchFileChanges,
            },
          }),
        ),
      ),
    );
    expect(collectText(container)).toContain("1 个文件已更改");
    await act(async () => collapsibleOpenChanges.at(-1)?.(true));
    expect(fetchFileChanges).toHaveBeenCalledTimes(2);
    expect(collectText(container)).toBe("");
    await act(async () => root.unmount());
  });

  it("matches z-code-2 summary card visual shell", () => {
    const html = renderPanel();

    expect(html).toContain("rounded-xl border border-border bg-card shadow-none");
    expect(html).toContain("h-10 items-center justify-between");
    expect(html).toContain("transition-colors hover:bg-hover");
    expect(html).toContain("grid w-full border-t border-border");
    expect(html).not.toContain("FileText");
  });

  it("renders file rows and Open action after details are loaded", async () => {
    const container = installMinimalDom();
    const root: Root = createRoot(container);
    const context: ConversationRowRenderContext = {
      workspacePath: "/workspace",
      workspaceIdentity: "remote:ssh:host-a:/workspace",
      workspaceRemoteSessionId: "session-a",
      theme: "system",
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
      fetchFileChanges: async () => ({
        files: 1,
        additions: 11,
        deletions: 0,
        items: [
          {
            path: "/workspace/input.html",
            additions: 11,
            deletions: 0,
            writeCount: 2,
            toolNames: ["Write"],
            patches: [
              {
                oldStart: 1,
                oldLines: 0,
                newStart: 1,
                newLines: 11,
                lines: ["+<html>"],
              },
            ],
          },
        ],
      }),
    };

    await act(async () => {
      root.render(
        createElement(
          ZCodeIntlProvider,
          { initialLocale: "zh-CN" },
          createElement(ConversationFileSummaryPanel, {
            header: header(),
            context,
          }),
        ),
      );
    });
    expect(collectText(container)).toContain("1 个文件已更改");

    await act(async () => {
      collapsibleOpenChanges.at(-1)?.(true);
      await Promise.resolve();
    });

    const text = collectText(container);
    expect(text).toContain("input.html");
    expect(text).toContain("+11");
    expect(text).not.toContain("2 次修改");
    expect(text).toContain("审查");
    expect(text).toContain("打开");
    expect(collectClassNames(container)).toContain("w-full bg-background/50 overflow-hidden");
    expect(text).not.toContain("暂时无法预览这份 Diff。");
    expect(openSplitButtonProps.at(-1)).toMatchObject({
      hideOpenWithMenu: false,
      target: {
        previewSource: {
          workspacePath: "/workspace",
          workspaceIdentity: "remote:ssh:host-a:/workspace",
          workspaceRemoteSessionId: "session-a",
        },
      },
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("运行中详情进入终态后丢弃旧 revision 结果并重新读取", async () => {
    const container = installMinimalDom();
    const root: Root = createRoot(container);
    const partialResult = {
      files: 1,
      additions: 1,
      deletions: 0,
      items: [
        {
          path: "/workspace/README.md",
          additions: 1,
          deletions: 0,
          writeCount: 1,
          toolNames: ["Write"],
          patches: [],
        },
      ],
    };
    const finalResult = {
      files: 2,
      additions: 2,
      deletions: 0,
      items: [
        ...partialResult.items,
        {
          path: "/workspace/index.html",
          additions: 1,
          deletions: 0,
          writeCount: 1,
          toolNames: ["Write"],
          patches: [],
        },
      ],
    };
    const fetchFileChanges = vi
      .fn()
      .mockResolvedValueOnce(partialResult)
      .mockResolvedValueOnce(finalResult);
    const context: ConversationRowRenderContext = {
      workspacePath: "/workspace",
      theme: "system",
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
      fetchFileChanges,
    };
    const renderPanelForState = (state: TurnHeaderRow["state"]) =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationFileSummaryPanel, {
          header: header({ state }),
          context,
        }),
      );

    await act(async () => {
      root.render(renderPanelForState("running"));
    });
    await act(async () => {
      collapsibleOpenChanges.at(-1)?.(true);
      await Promise.resolve();
    });
    expect(collectText(container)).toContain("README.md");

    await act(async () => {
      root.render(renderPanelForState("completedSuccess"));
      await Promise.resolve();
    });

    expect(fetchFileChanges).toHaveBeenNthCalledWith(
      1,
      { rowId: 1, entityId: "turn-header-1" },
      { cachePolicy: "in-flight", fileChangesState: "active" },
    );
    expect(fetchFileChanges).toHaveBeenNthCalledWith(
      2,
      { rowId: 1, entityId: "turn-header-1" },
      { cachePolicy: "terminal", fileChangesState: "active" },
    );
    expect(collectText(container)).toContain("index.html");

    await act(async () => root.unmount());
  });

  it("fileChanges 进入 reverted 后清空撤销前详情并按新状态重查", async () => {
    const container = installMinimalDom();
    const root: Root = createRoot(container);
    const activeResult: V4ConversationFileChangesResult = {
      files: 1,
      additions: 1,
      deletions: 0,
      state: "active",
      items: [{ path: "/workspace/README.md", patches: [] }],
    };
    let resolveReverted: ((value: V4ConversationFileChangesResult) => void) | undefined;
    const revertedResult = new Promise<V4ConversationFileChangesResult>((resolve) => {
      resolveReverted = resolve;
    });
    const fetchFileChanges = vi
      .fn()
      .mockResolvedValueOnce(activeResult)
      .mockReturnValueOnce(revertedResult);
    const context: ConversationRowRenderContext = {
      workspacePath: "/workspace",
      theme: "system",
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
      fetchFileChanges,
    };
    const renderPanelForFileState = (state: "active" | "reverted") =>
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationFileSummaryPanel, {
          header: header({
            fileChanges: {
              files: 1,
              additions: 1,
              deletions: 0,
              state,
            },
          }),
          context,
        }),
      );

    await act(async () => {
      root.render(renderPanelForFileState("active"));
    });
    await act(async () => {
      collapsibleOpenChanges.at(-1)?.(true);
      await Promise.resolve();
    });
    expect(collectText(container)).toContain("README.md");

    await act(async () => {
      root.render(renderPanelForFileState("reverted"));
      await Promise.resolve();
    });

    expect(collectText(container)).not.toContain("README.md");
    expect(fetchFileChanges).toHaveBeenNthCalledWith(
      2,
      { rowId: 1, entityId: "turn-header-1" },
      { cachePolicy: "terminal", fileChangesState: "reverted" },
    );

    resolveReverted?.({ ...activeResult, state: "reverted", items: [] });
    await act(async () => {
      await revertedResult;
    });
    await act(async () => root.unmount());
  });
});
