// @vitest-environment jsdom

// `workflow-artifact` tab：一个用户面产物的全尺寸查看（docs/dynamic-workflow/authoring.md「How the user sees them」+
// 「正文渲染器」两行）。
//
// ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 交付给用户的产出，不是引擎内部那个
// 「脚本顶层返回值」的同名词（spec 的「术语」表是唯一消歧处）。
//
// 钉三件事：
//   1. 正文按 journal 记录上的 `contentType` 分派到既有叶子查看器（零新渲染依赖）；
//   2. 版本步进器按**已知版本的数组**翻，而不是凭最新版号编造 1..n；
//   3. 「在工作区显示」与 html 的「在浏览器中打开」的门（desktop-local ∧ sourcePath ∧ 最新版）。
//   4. 「作为文件打开」：宿主能落副本才出入口，落的是**正在看的那一版**的字节。
import { createElement, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TID_WORKFLOW_ARTIFACT_PANE, type IPlatformService } from "@zcode/shared";
import type {
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsResult,
  WorkflowRunArtifact,
} from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowArtifactSidePaneTab } from "@/lib/workspaceSidePane.js";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

const toast = vi.fn();
vi.mock("@/components/ui/toast.js", () => ({
  toast: (...args: unknown[]) => toast(...args),
}));

const workflowRunArtifacts = vi.fn<() => Promise<V4ConversationWorkflowRunArtifactsResult>>();
const workflowRunArtifactData = vi.fn<() => Promise<V4ConversationWorkflowRunArtifactDataResult>>();
const workflowRunArtifactRead =
  vi.fn<
    (params: {
      version: number;
      offset: number;
      limit: number;
    }) => Promise<V4ConversationWorkflowRunArtifactReadResult>
  >();
const release = vi.fn();
// layer 必须是稳定引用：租约 effect 以它为依赖（同 workflowRunSidePane.test.ts 的注记）。
const layer = { acquire: vi.fn(() => ({ release })) };

vi.mock("@/v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: ReactNode }) => children,
  useV4Conversation: () => ({
    layer,
    workflowRunArtifacts,
    workflowRunArtifactData,
    workflowRunArtifactRead,
  }),
}));

let snapshot: unknown = null;
vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => ({ snapshot }),
}));

// 三个重量级叶子查看器：真身各自要 pdf.js / docx-preview / xlsx wasm，在 jsdom 里既慢又与
// 本用例无关。桩把 props 原样挂到 DOM 上，好断言「正文交给了谁、喂的是什么」。
vi.mock("@/previewPanePdfContent.js", () => ({
  PdfPreviewContent: ({ source }: { source: Blob }) =>
    createElement("div", { "data-testid": "pdf-viewer", "data-size": String(source.size) }),
}));
vi.mock("@/previewPanePptxContent.js", () => ({
  PptxPreviewContent: ({ data, fileName }: { data: ArrayBuffer; fileName?: string }) =>
    createElement("div", {
      "data-testid": "pptx-viewer",
      "data-file-name": fileName ?? "",
      "data-size": String(data.byteLength),
    }),
}));
vi.mock("@/previewPaneOfficeContent.js", () => ({
  PreviewPaneOfficeContent: ({
    kind,
    preview,
    resolvedTheme,
  }: {
    kind: string;
    preview: { dataBase64: string; totalBytes: number } | null;
    resolvedTheme: string;
  }) =>
    createElement("div", {
      "data-testid": "office-viewer",
      "data-kind": kind,
      "data-resolved-theme": resolvedTheme,
      "data-total-bytes": String(preview?.totalBytes ?? 0),
    }),
}));
vi.mock("@/components/ai-elements/message.js", () => ({
  MessageResponse: ({ children, theme }: { children?: ReactNode; theme?: string }) =>
    createElement(
      "div",
      { "data-testid": "markdown-response", "data-theme": theme ?? "" },
      children,
    ),
}));
vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string }) =>
    createElement("pre", { "data-testid": "code-block", "data-language": language ?? "" }, code),
}));

// eslint-disable-next-line import/first -- 必须在全部 mock 之后再引入被测组件。
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import { WorkflowArtifactSidePane } from "@/app-shell/WorkflowArtifactSidePane.js";
// eslint-disable-next-line import/first
import { encodeBytesToBase64 } from "@/hooks/useWorkflowRunArtifactBytes.js";
// eslint-disable-next-line import/first
import { PlatformProvider } from "@/hooks/usePlatform.js";

const onOpenBrowserUrl = vi.fn();
const onRevealFileInTree = vi.fn();

function tabOf(overrides: Partial<WorkflowArtifactSidePaneTab> = {}): WorkflowArtifactSidePaneTab {
  return {
    id: "workflow-artifact:%2Fworkspace:parent-a:dwfrun-1:book",
    type: "workflow-artifact",
    workspaceKey: "/workspace",
    workspacePath: "/workspace",
    parentSessionId: "parent-a",
    runId: "dwfrun-1",
    artifactId: "book",
    ...overrides,
  };
}

function record(overrides: Partial<WorkflowRunArtifact> = {}): WorkflowRunArtifact {
  return {
    id: "book",
    kind: "file",
    title: "审计报告",
    contentType: "application/pdf",
    sourcePath: "out/book.pdf",
    version: 1,
    versions: [{ version: 1, publishedAt: 1, bytes: 8, sourcePath: "out/book.pdf" }],
    itemCount: 0,
    ...overrides,
  };
}

function textChunk(text: string, mediaType: string): V4ConversationWorkflowRunArtifactReadResult {
  const bytes = new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
  return {
    dataBase64: encodeBytesToBase64(bytes),
    mediaType,
    totalBytes: bytes.length,
    nextOffset: null,
  };
}

function renderPane(
  options: {
    tab?: WorkflowArtifactSidePaneTab;
    locale?: "en-US" | "zh-CN";
    withBrowser?: boolean;
    withReveal?: boolean;
    /** 缺席即不挂 PlatformProvider（与既有用例一致：没有宿主能力）。 */
    platform?: Partial<IPlatformService>;
  } = {},
) {
  const pane = createElement(WorkflowArtifactSidePane, {
    tab: options.tab ?? tabOf(),
    ...(options.withBrowser === false ? {} : { onOpenBrowserUrl }),
    ...(options.withReveal === false ? {} : { onRevealFileInTree }),
  });
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: options.locale ?? "zh-CN" },
      options.platform === undefined
        ? pane
        : createElement(PlatformProvider, {
            platform: options.platform as IPlatformService,
            children: pane,
          }),
    ),
  );
}

beforeEach(() => {
  cleanup();
  snapshot = null;
  toast.mockClear();
  onOpenBrowserUrl.mockClear();
  onRevealFileInTree.mockClear();
  layer.acquire.mockClear();
  workflowRunArtifacts.mockReset();
  workflowRunArtifactData.mockReset();
  workflowRunArtifactRead.mockReset();
  workflowRunArtifacts.mockResolvedValue({ artifacts: [record()] });
  workflowRunArtifactData.mockResolvedValue({ items: [], hasMore: false });
  workflowRunArtifactRead.mockResolvedValue(textChunk("bytes---", "application/pdf"));
  // resolveTheme("system") 会问 matchMedia；jsdom 不带它。
  (window as unknown as { matchMedia: (query: string) => unknown }).matchMedia = () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
});

describe("WorkflowArtifactSidePane 正文分派", () => {
  it("pdf 交给既有的 PdfViewer，喂的是 Blob（不落地成文件、不走 range transport）", async () => {
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId("pdf-viewer")).toBeTruthy());
    expect(view.getByTestId("pdf-viewer").getAttribute("data-size")).toBe("8");
    expect(view.getByTestId("workflow-artifact-title").textContent).toBe("审计报告");
  });

  it("markdown 走 MessageResponse 并**传 theme**（深底深字修过一次）", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        record({
          id: "notes",
          kind: "markdown",
          contentType: "text/markdown",
          sourcePath: undefined,
          versions: [{ version: 1, publishedAt: 1, bytes: 5 }],
        }),
      ],
    });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const view = renderPane({ tab: tabOf({ artifactId: "notes" }) });

    await waitFor(() => expect(view.getByTestId("markdown-response")).toBeTruthy());
    expect(view.getByTestId("markdown-response").textContent).toBe("# hi");
    expect(view.getByTestId("markdown-response").getAttribute("data-theme")).toBe("system");
  });

  it("图片走 blob object url 的 <img>", async () => {
    (URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = () =>
      "blob:artifact-img";
    (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = () => {};
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [record({ id: "shot", contentType: "image/png" })],
    });
    workflowRunArtifactRead.mockResolvedValue(textChunk("png-bytes", "image/png"));
    const view = renderPane({ tab: tabOf({ artifactId: "shot" }) });

    await waitFor(() => expect(view.getByTestId("workflow-artifact-image")).toBeTruthy());
    expect(view.getByTestId("workflow-artifact-image").getAttribute("src")).toBe(
      "blob:artifact-img",
    );
  });

  it("csv / json 走等宽 code viewer", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [record({ id: "rows", contentType: "text/csv" })],
    });
    workflowRunArtifactRead.mockResolvedValue(textChunk("a,b\n1,2", "text/csv"));
    const view = renderPane({ tab: tabOf({ artifactId: "rows" }) });

    await waitFor(() => expect(view.getByTestId("code-block")).toBeTruthy());
    expect(view.getByTestId("code-block").getAttribute("data-language")).toBe("csv");
  });

  it("docx 交给既有 office 查看器，喂的是字节（不是路径）", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        record({
          id: "doc",
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        }),
      ],
    });
    workflowRunArtifactRead.mockResolvedValue(
      textChunk("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    );
    const view = renderPane({ tab: tabOf({ artifactId: "doc" }) });

    await waitFor(() => expect(view.getByTestId("office-viewer")).toBeTruthy());
    expect(view.getByTestId("office-viewer").getAttribute("data-kind")).toBe("docx");
    expect(view.getByTestId("office-viewer").getAttribute("data-total-bytes")).toBe("4");
  });

  it("pptx 交给既有 pptx 查看器，喂的是 ArrayBuffer", async () => {
    const contentType = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [record({ id: "deck", contentType, sourcePath: "out/deck.pptx" })],
    });
    workflowRunArtifactRead.mockResolvedValue(textChunk("pptx-bytes", contentType));
    const view = renderPane({ tab: tabOf({ artifactId: "deck" }) });

    await waitFor(() => expect(view.getByTestId("pptx-viewer")).toBeTruthy());
    expect(view.getByTestId("pptx-viewer").getAttribute("data-size")).toBe("10");
    expect(view.getByTestId("pptx-viewer").getAttribute("data-file-name")).toBe("out/deck.pptx");
  });

  it("表外类型给一张元数据卡 + 「在工作区显示」，不假装能渲染", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        record({ id: "blob", contentType: "application/octet-stream", sourcePath: "out/x.bin" }),
      ],
    });
    workflowRunArtifactRead.mockResolvedValue(textChunk("bin", "application/octet-stream"));
    const view = renderPane({ tab: tabOf({ artifactId: "blob" }) });

    await waitFor(() => expect(view.getByTestId("workflow-artifact-unsupported")).toBeTruthy());
    const card = view.getByTestId("workflow-artifact-unsupported");
    expect(card.textContent).toContain("application/octet-stream");
    expect(card.textContent).toContain("out/x.bin");
    fireEvent.click(view.getByTestId("workflow-artifact-unsupported-reveal"));
    // 「在工作区显示」拿到的是 workspacePath 拼出来的本机绝对路径。
    expect(onRevealFileInTree).toHaveBeenCalledWith("/workspace/out/x.bin");
  });

  it("预置看板画在 tab 里，且**不读一个字节**", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        record({
          id: "rounds",
          kind: "table",
          contentType: undefined,
          sourcePath: undefined,
          versions: [{ version: 1, publishedAt: 1 }],
          spec: { columns: [{ field: "round" }] },
          itemCount: 1,
        }),
      ],
    });
    workflowRunArtifactData.mockResolvedValue({
      items: [{ sequence: 1, siteId: "report#1", ordinal: 1, item: { round: 7 } }],
      hasMore: false,
    });
    const view = renderPane({ tab: tabOf({ artifactId: "rounds" }) });

    await waitFor(() => expect(view.getByTestId("artifact-table")).toBeTruthy());
    expect(view.getByText("7")).toBeTruthy();
    expect(workflowRunArtifactRead).not.toHaveBeenCalled();
  });
});

describe("WorkflowArtifactSidePane html 卡", () => {
  const htmlRecord = (sourcePath: string | undefined, versionCount = 1) =>
    record({
      id: "site",
      contentType: "text/html",
      ...(sourcePath === undefined ? { sourcePath: undefined } : { sourcePath }),
      version: versionCount,
      versions: Array.from({ length: versionCount }, (_unused, index) => ({
        version: index + 1,
        publishedAt: index + 1,
        bytes: 4,
      })),
    });

  beforeEach(() => {
    workflowRunArtifactRead.mockResolvedValue(textChunk("<h1>", "text/html"));
  });

  it("本地工作区 + 最新版：给「在浏览器中打开」，打开的是工作区原件的 file:// URL", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [htmlRecord("out/site.html")] });
    const view = renderPane({ tab: tabOf({ artifactId: "site" }) });

    await waitFor(() => expect(view.getByTestId("workflow-artifact-html-card")).toBeTruthy());
    fireEvent.click(view.getByTestId("workflow-artifact-open-in-browser"));
    expect(onOpenBrowserUrl).toHaveBeenCalledWith("file:///workspace/out/site.html");
    // 卡上必须写明打开的是工作区那一份，而不是这一版被钉住的字节。
    expect(view.getByTestId("workflow-artifact-note").textContent).toContain("工作区");
  });

  it("远程 workspace（有 remoteSessionId）退成「仅本地工作区可预览」", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [htmlRecord("out/site.html")] });
    const view = renderPane({
      tab: tabOf({
        artifactId: "site",
        remoteSessionId: "remote-1",
        workspaceIdentity: "ssh://host/workspace",
      }),
    });

    await waitFor(() => expect(view.getByTestId("workflow-artifact-html-card")).toBeTruthy());
    expect(view.queryByTestId("workflow-artifact-open-in-browser")).toBeNull();
    expect(view.getByTestId("workflow-artifact-note").textContent).toContain("仅本地工作区");
    expect(view.queryByTestId("workflow-artifact-reveal")).toBeNull();
  });

  it("看的是旧版时不给「在浏览器中打开」——工作区原件早被同名覆盖了", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [htmlRecord("out/site.html", 2)] });
    const view = renderPane({ tab: tabOf({ artifactId: "site", version: 1 }) });

    await waitFor(() => expect(view.getByTestId("workflow-artifact-html-card")).toBeTruthy());
    expect(view.queryByTestId("workflow-artifact-open-in-browser")).toBeNull();
    expect(view.getByTestId("workflow-artifact-html-reveal")).toBeTruthy();
  });
});

describe("WorkflowArtifactSidePane 版本步进器", () => {
  it("只有一版时整块缺席，只留一个版本号", async () => {
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId("pdf-viewer")).toBeTruthy());
    expect(view.queryByTestId("workflow-artifact-version-stepper")).toBeNull();
    expect(view.getByTestId("workflow-artifact-version").textContent).toBe("第 1 版");
  });

  it("多版时按**已知版本的数组**翻，并按所选版本重读字节", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        record({
          version: 3,
          versions: [
            { version: 1, publishedAt: 1, bytes: 2 },
            { version: 2, publishedAt: 2, bytes: 4 },
            { version: 3, publishedAt: 3, bytes: 8 },
          ],
        }),
      ],
    });
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId("workflow-artifact-version-stepper")).toBeTruthy());
    // 缺省落点是最新版（chip 从不带版本号）。
    expect(view.getByTestId("workflow-artifact-version").textContent).toBe("第 3 版 / 共 3 版");
    expect(view.getByTestId("workflow-artifact-version-next").hasAttribute("disabled")).toBe(true);

    fireEvent.click(view.getByTestId("workflow-artifact-version-previous"));
    await waitFor(() =>
      expect(view.getByTestId("workflow-artifact-version").textContent).toBe("第 2 版 / 共 3 版"),
    );
    await waitFor(() => expect(workflowRunArtifactRead.mock.calls.at(-1)?.[0]?.version).toBe(2));
  });

  it("journal 读不到版本历史时不凭最新版号编造 1..n", async () => {
    // 只有摘要（活投影）在场：步进器必须消失，而不是给出一批取不到字节的版本号。
    workflowRunArtifacts.mockRejectedValue(new Error("fault.command.capabilityUnsupported"));
    snapshot = {
      workflowRuns: {
        revision: 1,
        runs: [
          {
            runId: "dwfrun-1",
            status: "completed",
            usage: { spentTokens: 0, nodesUsed: 0 },
            actors: [],
            nodes: [],
            lastEventSequence: 0,
            artifacts: [
              {
                id: "book",
                kind: "file",
                title: "审计报告",
                version: 4,
                contentType: "application/pdf",
                bytes: 8,
              },
            ],
          },
        ],
      },
    };
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId("pdf-viewer")).toBeTruthy());
    expect(view.queryByTestId("workflow-artifact-version-stepper")).toBeNull();
    expect(view.getByTestId("workflow-artifact-version").textContent).toBe("第 4 版");
  });
});

describe("WorkflowArtifactSidePane 元数据来源与空态", () => {
  it("run 在活投影里：source 标为 live，摘要先画出来", async () => {
    snapshot = {
      workflowRuns: {
        revision: 1,
        runs: [
          {
            runId: "dwfrun-1",
            status: "running",
            usage: { spentTokens: 0, nodesUsed: 0 },
            actors: [],
            nodes: [],
            lastEventSequence: 0,
            artifacts: [
              { id: "book", kind: "file", version: 1, contentType: "application/pdf", bytes: 8 },
            ],
          },
        ],
      },
    };
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId("pdf-viewer")).toBeTruthy());
    expect(view.getByTestId(TID_WORKFLOW_ARTIFACT_PANE).getAttribute("data-artifact-source")).toBe(
      "live",
    );
  });

  it("run 不在活投影里：source 标为 journal（冷恢复走 durable 读法）", async () => {
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId("pdf-viewer")).toBeTruthy());
    expect(view.getByTestId(TID_WORKFLOW_ARTIFACT_PANE).getAttribute("data-artifact-source")).toBe(
      "journal",
    );
  });

  it("读完了但这个 id 不在清单里：说「已经不在了」，不永远停在加载文案上", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [] });
    const view = renderPane();
    await waitFor(() =>
      expect(view.getByTestId("workflow-artifact-placeholder").textContent).toBe(
        "这个产物已经不在了。",
      ),
    );
  });

  it("会话不支持产物查询（老 CLI）时说的是「读不到详情」，不是「不在了」", async () => {
    workflowRunArtifacts.mockRejectedValue(new Error("fault.command.capabilityUnsupported"));
    const view = renderPane();
    await waitFor(() =>
      expect(view.getByTestId("workflow-artifact-placeholder").textContent).toBe(
        "当前会话读不到产物详情。",
      ),
    );
  });

  it("面板订阅的是**父会话**的投影（产物的新鲜元数据是它的一部分）", async () => {
    renderPane();
    await act(async () => {});
    expect(layer.acquire).toHaveBeenCalledWith("parent-a");
  });
});

describe("WorkflowArtifactSidePane 头部动作", () => {
  it("宿主不能落副本时，「在工作区显示」独立留在头部（desktop-local ∧ sourcePath 在场才出现）", async () => {
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId("workflow-artifact-reveal")).toBeTruthy());
    fireEvent.click(view.getByTestId("workflow-artifact-reveal"));
    expect(onRevealFileInTree).toHaveBeenCalledWith("/workspace/out/book.pdf");
  });

  it("markdown 没有工作区出处，因此没有「在工作区显示」，但有「复制」", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        record({
          id: "notes",
          kind: "markdown",
          contentType: "text/markdown",
          sourcePath: undefined,
          versions: [{ version: 1, publishedAt: 1, bytes: 4 }],
        }),
      ],
    });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const view = renderPane({ tab: tabOf({ artifactId: "notes" }) });

    await waitFor(() => expect(view.getByTestId("workflow-artifact-copy")).toBeTruthy());
    expect(view.queryByTestId("workflow-artifact-reveal")).toBeNull();
  });

  it("pdf 不给「复制」（二进制复制成文本是一句谎）", async () => {
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId("pdf-viewer")).toBeTruthy());
    expect(view.queryByTestId("workflow-artifact-copy")).toBeNull();
  });

  it("没有「下载」按钮——renderer 没有任何把字节存成用户文件的宿主能力", async () => {
    const view = renderPane();
    await waitFor(() => expect(view.getByTestId("pdf-viewer")).toBeTruthy());
    expect(view.queryByText("下载")).toBeNull();
  });
});

describe("WorkflowArtifactSidePane 作为文件打开", () => {
  const markdownRecord = () =>
    record({
      id: "notes",
      kind: "markdown",
      contentType: "text/markdown",
      sourcePath: undefined,
      versions: [{ version: 1, publishedAt: 1, bytes: 4 }],
    });

  function desktopPlatform(overrides: Partial<IPlatformService> = {}) {
    return {
      materializeWorkflowArtifactFile: vi.fn(async (payload: { fileName: string }) => ({
        localPath: `/copies/${payload.fileName}`,
      })),
      openExternalFile: vi.fn(async () => ({ success: true })),
      getInstalledEditors: vi.fn(async () => [
        { id: "vscode", name: "VS Code", iconDataUrl: "data:," },
        { id: "finder", name: "Finder", iconDataUrl: "data:," },
      ]),
      openInEditor: vi.fn(async () => ({ success: true })),
      ...overrides,
    };
  }

  function decode(bytes: unknown): string {
    return new TextDecoder().decode(bytes as Uint8Array);
  }

  it("宿主不能落副本时（手机远控 / web）不出入口", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [markdownRecord()] });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const view = renderPane({
      tab: tabOf({ artifactId: "notes" }),
      platform: { openExternalFile: vi.fn() },
    });

    await waitFor(() => expect(view.getByTestId("markdown-response")).toBeTruthy());
    expect(view.queryByTestId("workflow-artifact-open-as-file")).toBeNull();
  });

  it("预置看板没有字节，不出入口", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        record({
          id: "scores",
          kind: "table",
          contentType: undefined,
          sourcePath: undefined,
          versions: [{ version: 1, publishedAt: 1 }],
          spec: { columns: [{ field: "round" }] },
        }),
      ],
    });
    const view = renderPane({
      tab: tabOf({ artifactId: "scores" }),
      platform: desktopPlatform(),
    });

    await waitFor(() => expect(view.getByTestId("workflow-artifact-title")).toBeTruthy());
    expect(view.queryByTestId("workflow-artifact-open-as-file")).toBeNull();
  });

  it("markdown：把这一版的字节落成 <id>.md，用系统默认 App 打开", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [markdownRecord()] });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const platform = desktopPlatform();
    const view = renderPane({ tab: tabOf({ artifactId: "notes" }), platform });

    await waitFor(() => expect(view.getByTestId("markdown-response")).toBeTruthy());
    fireEvent.click(view.getByTestId("workflow-artifact-open-as-file"));

    await waitFor(() => expect(platform.openExternalFile).toHaveBeenCalledWith("/copies/notes.md"));
    const payload = platform.materializeWorkflowArtifactFile.mock.calls[0]?.[0] as unknown as {
      runId: string;
      artifactId: string;
      version: number;
      fileName: string;
      bytes: Uint8Array;
    };
    expect(payload).toMatchObject({
      runId: "dwfrun-1",
      artifactId: "notes",
      version: 1,
      fileName: "notes.md",
    });
    expect(decode(payload.bytes)).toBe("# hi");
  });

  it("file：文件名取所选版本的 sourcePath 基名，翻到旧版就落旧版的字节", async () => {
    workflowRunArtifacts.mockResolvedValue({
      artifacts: [
        record({
          version: 2,
          sourcePath: "out/book.pdf",
          versions: [
            { version: 1, publishedAt: 1, bytes: 5, sourcePath: "out/draft.pdf" },
            { version: 2, publishedAt: 2, bytes: 5, sourcePath: "out/book.pdf" },
          ],
        }),
      ],
    });
    workflowRunArtifactRead.mockImplementation(async (params) =>
      textChunk(`pdf-v${params.version}`, "application/pdf"),
    );
    const platform = desktopPlatform();
    const view = renderPane({ platform });

    await waitFor(() => expect(view.getByTestId("pdf-viewer")).toBeTruthy());
    fireEvent.click(view.getByTestId("workflow-artifact-open-as-file"));
    await waitFor(() => expect(platform.openExternalFile).toHaveBeenCalledWith("/copies/book.pdf"));
    expect(platform.materializeWorkflowArtifactFile.mock.calls[0]?.[0]).toMatchObject({
      version: 2,
      fileName: "book.pdf",
    });

    fireEvent.click(view.getByTestId("workflow-artifact-version-previous"));
    await waitFor(() =>
      expect(view.getByTestId("workflow-artifact-version").textContent).toBe("第 1 版 / 共 2 版"),
    );
    await waitFor(() =>
      expect(view.getByTestId("pdf-viewer").getAttribute("data-size")).toBe(
        String("pdf-v1".length),
      ),
    );
    fireEvent.click(view.getByTestId("workflow-artifact-open-as-file"));
    await waitFor(() =>
      expect(platform.openExternalFile).toHaveBeenLastCalledWith("/copies/draft.pdf"),
    );
    const second = platform.materializeWorkflowArtifactFile.mock.calls[1]?.[0] as unknown as {
      version: number;
      fileName: string;
      bytes: Uint8Array;
    };
    expect(second).toMatchObject({ version: 1, fileName: "draft.pdf" });
    expect(decode(second.bytes)).toBe("pdf-v1");
  });

  it("同一版再打开不再重传字节，直接开同一个副本", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [markdownRecord()] });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const platform = desktopPlatform();
    const view = renderPane({ tab: tabOf({ artifactId: "notes" }), platform });

    await waitFor(() => expect(view.getByTestId("markdown-response")).toBeTruthy());
    fireEvent.click(view.getByTestId("workflow-artifact-open-as-file"));
    await waitFor(() => expect(platform.openExternalFile).toHaveBeenCalledTimes(1));
    fireEvent.click(view.getByTestId("workflow-artifact-open-as-file"));
    await waitFor(() => expect(platform.openExternalFile).toHaveBeenCalledTimes(2));
    expect(platform.materializeWorkflowArtifactFile).toHaveBeenCalledTimes(1);
  });

  it("系统 App 打不开时给 toast，不静默", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [markdownRecord()] });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const platform = desktopPlatform({
      openExternalFile: vi.fn(async () => ({ success: false, error: "no app" })),
    });
    const view = renderPane({ tab: tabOf({ artifactId: "notes" }), platform });

    await waitFor(() => expect(view.getByTestId("markdown-response")).toBeTruthy());
    fireEvent.click(view.getByTestId("workflow-artifact-open-as-file"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("无法作为文件打开此产物"));
  });

  it("副本写失败时同样给 toast", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [markdownRecord()] });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const platform = desktopPlatform({
      materializeWorkflowArtifactFile: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const view = renderPane({ tab: tabOf({ artifactId: "notes" }), platform });

    await waitFor(() => expect(view.getByTestId("markdown-response")).toBeTruthy());
    fireEvent.click(view.getByTestId("workflow-artifact-open-as-file"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("无法作为文件打开此产物"));
    expect(platform.openExternalFile).not.toHaveBeenCalled();
  });

  it("选择打开方式：列出已装 App（文件管理器在前），选中即用它打开副本", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [markdownRecord()] });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const platform = desktopPlatform();
    const view = renderPane({ tab: tabOf({ artifactId: "notes" }), platform });

    await waitFor(() => expect(view.getByTestId("markdown-response")).toBeTruthy());
    fireEvent.pointerDown(view.getByTestId("workflow-artifact-open-as-file-menu"), {
      button: 0,
      ctrlKey: false,
    });
    await waitFor(() => expect(view.getByText("VS Code")).toBeTruthy());
    const names = view.getAllByRole("menuitem").map((item) => item.textContent);
    expect(names.slice(0, 2)).toEqual(["Finder", "VS Code"]);

    fireEvent.click(view.getByText("VS Code"));
    await waitFor(() =>
      expect(platform.openInEditor).toHaveBeenCalledWith("vscode", "/copies/notes.md", {
        pathKind: "file",
      }),
    );
    expect(platform.openExternalFile).not.toHaveBeenCalled();
  });

  it("有工作区出处时，「在工作区显示」收进菜单，头部只剩一个文件控件", async () => {
    const platform = desktopPlatform();
    const view = renderPane({ platform });

    await waitFor(() => expect(view.getByTestId("pdf-viewer")).toBeTruthy());
    expect(view.getByTestId("workflow-artifact-open-as-file")).toBeTruthy();
    expect(view.queryByTestId("workflow-artifact-reveal")).toBeNull();

    fireEvent.pointerDown(view.getByTestId("workflow-artifact-open-as-file-menu"), {
      button: 0,
      ctrlKey: false,
    });
    await waitFor(() =>
      expect(view.getByTestId("workflow-artifact-open-as-file-reveal")).toBeTruthy(),
    );
    const names = view.getAllByRole("menuitem").map((item) => item.textContent);
    // 位置类动作排在 App 之后：先「在工作区显示」，再「复制绝对路径」。
    expect(names.slice(-2)).toEqual(["在工作区显示", "复制绝对路径"]);

    fireEvent.click(view.getByTestId("workflow-artifact-open-as-file-reveal"));
    expect(onRevealFileInTree).toHaveBeenCalledWith("/workspace/out/book.pdf");
    // 显示位置不落副本。
    expect(platform.materializeWorkflowArtifactFile).not.toHaveBeenCalled();
  });

  it("没有工作区出处（markdown）或远程工作区时，菜单里没有「在工作区显示」", async () => {
    workflowRunArtifacts.mockResolvedValue({ artifacts: [markdownRecord()] });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const markdownView = renderPane({
      tab: tabOf({ artifactId: "notes" }),
      platform: desktopPlatform(),
    });
    await waitFor(() => expect(markdownView.getByTestId("markdown-response")).toBeTruthy());
    fireEvent.pointerDown(markdownView.getByTestId("workflow-artifact-open-as-file-menu"), {
      button: 0,
      ctrlKey: false,
    });
    await waitFor(() => expect(markdownView.getByText("复制绝对路径")).toBeTruthy());
    expect(markdownView.queryByTestId("workflow-artifact-open-as-file-reveal")).toBeNull();
    cleanup();

    workflowRunArtifacts.mockResolvedValue({ artifacts: [record()] });
    const remoteView = renderPane({
      tab: tabOf({ remoteSessionId: "remote-1", workspaceIdentity: "ssh://host/workspace" }),
      platform: desktopPlatform(),
    });
    await waitFor(() => expect(remoteView.getByTestId("pdf-viewer")).toBeTruthy());
    expect(remoteView.queryByTestId("workflow-artifact-reveal")).toBeNull();
    fireEvent.pointerDown(remoteView.getByTestId("workflow-artifact-open-as-file-menu"), {
      button: 0,
      ctrlKey: false,
    });
    await waitFor(() => expect(remoteView.getByText("复制绝对路径")).toBeTruthy());
    expect(remoteView.queryByTestId("workflow-artifact-open-as-file-reveal")).toBeNull();
  });

  it("「复制路径」复制的是副本的绝对路径", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    workflowRunArtifacts.mockResolvedValue({ artifacts: [markdownRecord()] });
    workflowRunArtifactRead.mockResolvedValue(textChunk("# hi", "text/markdown"));
    const platform = desktopPlatform();
    const view = renderPane({ tab: tabOf({ artifactId: "notes" }), platform });

    await waitFor(() => expect(view.getByTestId("markdown-response")).toBeTruthy());
    fireEvent.pointerDown(view.getByTestId("workflow-artifact-open-as-file-menu"), {
      button: 0,
      ctrlKey: false,
    });
    await waitFor(() => expect(view.getByText("复制绝对路径")).toBeTruthy());
    fireEvent.click(view.getByText("复制绝对路径"));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/copies/notes.md"));
  });
});
