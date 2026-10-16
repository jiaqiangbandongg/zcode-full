// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PresentationPageElement,
  PresentationPreviewDocument,
  PresentationRenderHandle,
} from "@/presentation/types.js";

const h = vi.hoisted(() => ({
  open: vi.fn(),
  loggerError: vi.fn(),
  toast: vi.fn(),
  sha256Fingerprint: vi.fn(),
  createReference: vi.fn(),
  dispatchReference: vi.fn(),
  readSelectedText: vi.fn(),
}));

vi.mock("@/presentation/pptxRendererPreviewEngine.js", () => ({
  pptxRendererPreviewEngine: { open: h.open },
}));

vi.mock("@/logger.js", () => ({
  logger: { error: h.loggerError },
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: h.toast,
}));

vi.mock("@/lib/pptxElementReference.js", () => ({
  sha256Fingerprint: h.sha256Fingerprint,
  createPptxElementReference: h.createReference,
  dispatchPptxElementReferenceAddToChat: h.dispatchReference,
}));

vi.mock("@/presentation/presentationTextSelection.js", () => ({
  getPresentationElementSelectedText: h.readSelectedText,
}));

import {
  PptxPreviewViewer,
  type PptxPreviewViewerLabels,
} from "@/components/ui/pptx-preview-viewer.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createDocument(
  label: string,
  ready: Promise<void>,
  elements: readonly PresentationPageElement[] = [],
  pageCount = 1,
): PresentationPreviewDocument & {
  dispose: ReturnType<typeof vi.fn>;
  renderPage: ReturnType<typeof vi.fn>;
} {
  const handle: PresentationRenderHandle = {
    ready,
    dispose: vi.fn(),
  };
  return {
    pageCount,
    pageSize: { width: 1280, height: 720 },
    getPageElements: () => elements,
    dispose: vi.fn(),
    renderPage: vi.fn((_pageIndex: number, container: HTMLElement) => {
      const page = document.createElement("div");
      page.textContent = label;
      container.append(page);
      return handle;
    }),
  };
}

const labels: PptxPreviewViewerLabels = {
  loading: "loading",
  loadError: "load-error",
  noSlides: "no-slides",
  previousPage: "previous-page",
  nextPage: "next-page",
  pageInput: "page-input",
  zoomIn: "zoom-in",
  zoomOut: "zoom-out",
  thumbnails: "thumbnails",
  thumbnail: (pageNumber) => `thumbnail-${pageNumber}`,
  exportPdf: "export-pdf",
  exportingPdf: "exporting-pdf",
  exportPdfSuccess: (path) => `export-pdf-success-${path}`,
  exportPdfFailed: "export-pdf-failed",
  selectElement: "select-element",
  exitElementSelection: "exit-selection",
  aiEdit: "ai-edit",
  commentPlaceholder: "comment-placeholder",
  cancelAiEdit: "cancel-ai-edit",
  addToConversation: "add-to-conversation",
  referencedPageMissing: (pageNumber) => `missing-page-${pageNumber}`,
  referencedSourceChanged: (pageNumber) => `changed-source-${pageNumber}`,
};

beforeEach(() => {
  h.open.mockReset();
  h.loggerError.mockReset();
  h.toast.mockReset();
  h.sha256Fingerprint.mockReset();
  h.sha256Fingerprint.mockResolvedValue(`sha256:${"a".repeat(64)}`);
  h.createReference.mockReset();
  h.dispatchReference.mockReset();
  h.readSelectedText.mockReset();
  h.readSelectedText.mockReturnValue(null);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => cleanup());

describe("PptxPreviewViewer lifecycle", () => {
  it("只把独立 leaf mount 交给 renderer，切换和退出元素选择不会破坏 React 节点", async () => {
    const firstElement: PresentationPageElement = {
      slideIndex: 0,
      slidePart: "ppt/slides/slide1.xml",
      nodeId: "7",
      nodeName: "Title",
      nodeType: "shape",
      text: "Quarterly plan",
      bounds: { x: 100, y: 80, width: 400, height: 120 },
      zIndex: 1,
    };
    const secondElement: PresentationPageElement = {
      ...firstElement,
      nodeId: "8",
      nodeName: "Subtitle",
      text: "Next steps",
      bounds: { x: 100, y: 240, width: 400, height: 80 },
      zIndex: 2,
    };
    const previewDocument = createDocument(
      "Quarterly plan",
      Promise.resolve(),
      [firstElement, secondElement],
    );
    h.open.mockResolvedValue(previewDocument);

    const view = render(
      createElement(PptxPreviewViewer, {
        data: new ArrayBuffer(1),
        labels,
        referenceSource: {
          workspacePath: "/workspace",
          sourcePath: "/workspace/deck.pptx",
          sourceTitle: "deck.pptx",
        },
      }),
    );

    expect(await screen.findByText("Quarterly plan")).toBeTruthy();
    const rendererMount = previewDocument.renderPage.mock.calls[0]?.[1] as
      | HTMLElement
      | undefined;
    expect(rendererMount?.dataset.zcodePptxRenderSurface).toBe("true");
    expect(rendererMount?.childElementCount).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: labels.selectElement }));
    fireEvent.click(screen.getByRole("button", { name: firstElement.text }));
    fireEvent.click(screen.getByRole("button", { name: secondElement.text }));
    expect(
      screen
        .getByRole("button", { name: secondElement.text })
        .getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(
      screen.getByRole("button", { name: labels.exitElementSelection }),
    );
    expect(
      document.querySelector('[data-pptx-element-selection-overlay="true"]'),
    ).toBeNull();
    expect(rendererMount?.isConnected).toBe(true);

    expect(() => view.unmount()).not.toThrow();
  });

  it("释放切换后才完成的旧文档，并且不渲染旧内容", async () => {
    const firstOpen = createDeferred<PresentationPreviewDocument>();
    const secondOpen = createDeferred<PresentationPreviewDocument>();
    const firstDocument = createDocument("document-1", Promise.resolve());
    const secondDocument = createDocument("document-2", Promise.resolve());
    h.open.mockReturnValueOnce(firstOpen.promise).mockReturnValueOnce(secondOpen.promise);

    const view = render(createElement(PptxPreviewViewer, { data: new ArrayBuffer(1), labels }));
    await waitFor(() => expect(h.open).toHaveBeenCalledTimes(1));

    view.rerender(createElement(PptxPreviewViewer, { data: new ArrayBuffer(2), labels }));
    await waitFor(() => expect(h.open).toHaveBeenCalledTimes(2));

    await act(async () => firstOpen.resolve(firstDocument));
    expect(firstDocument.dispose).toHaveBeenCalledTimes(1);
    expect(firstDocument.renderPage).not.toHaveBeenCalled();

    await act(async () => secondOpen.resolve(secondDocument));
    expect(await screen.findByText("document-2")).toBeTruthy();
    expect(screen.queryByText("document-1")).toBeNull();
  });

  it("忽略旧页面在文档切换后的迟到渲染错误", async () => {
    const firstReady = createDeferred<void>();
    const firstDocument = createDocument("document-1", firstReady.promise);
    const secondDocument = createDocument("document-2", Promise.resolve());
    h.open.mockResolvedValueOnce(firstDocument).mockResolvedValueOnce(secondDocument);

    const view = render(createElement(PptxPreviewViewer, { data: new ArrayBuffer(1), labels }));
    expect(await screen.findByText("document-1")).toBeTruthy();

    view.rerender(createElement(PptxPreviewViewer, { data: new ArrayBuffer(2), labels }));
    expect(await screen.findByText("document-2")).toBeTruthy();

    await act(async () => firstReady.reject(new Error("old render failed")));
    expect(screen.queryByText(labels.loadError)).toBeNull();
    expect(screen.getByText("document-2")).toBeTruthy();
    expect(h.loggerError).not.toHaveBeenCalled();
  });

  it("新文件 generation 完整重置页码、缩放和元素选择状态", async () => {
    const element: PresentationPageElement = {
      slideIndex: 0,
      slidePart: "ppt/slides/slide1.xml",
      nodeId: "7",
      nodeName: "Title",
      nodeType: "shape",
      text: "Quarterly plan",
      bounds: { x: 100, y: 80, width: 400, height: 120 },
      zIndex: 1,
    };
    const firstDocument = createDocument("document-1", Promise.resolve(), [element], 2);
    const secondDocument = createDocument("document-2", Promise.resolve(), [element], 2);
    h.open.mockResolvedValueOnce(firstDocument).mockResolvedValueOnce(secondDocument);

    const props = {
      labels,
      referenceSource: {
        workspacePath: "/workspace",
        sourcePath: "/workspace/deck.pptx",
        sourceTitle: "deck.pptx",
      },
    };
    const view = render(
      createElement(PptxPreviewViewer, { ...props, data: new ArrayBuffer(1) }),
    );
    expect(await screen.findByText("document-1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: labels.nextPage }));
    fireEvent.click(screen.getByRole("button", { name: labels.zoomIn }));
    fireEvent.click(screen.getByRole("button", { name: labels.selectElement }));
    fireEvent.click(screen.getByRole("button", { name: element.text }));
    expect(screen.getByRole("button", { name: labels.exitElementSelection })).toBeTruthy();
    expect((screen.getByLabelText(labels.pageInput) as HTMLInputElement).value).toBe("2");
    expect(screen.getByText("125%")).toBeTruthy();

    view.rerender(
      createElement(PptxPreviewViewer, { ...props, data: new ArrayBuffer(2) }),
    );
    expect(await screen.findByText("document-2")).toBeTruthy();
    expect(screen.getByRole("button", { name: labels.selectElement })).toBeTruthy();
    expect((screen.getByLabelText(labels.pageInput) as HTMLInputElement).value).toBe("1");
    expect(screen.getByText("100%")).toBeTruthy();
    expect(
      document.querySelector('[data-pptx-element-selection-overlay="true"]'),
    ).toBeNull();
  });

  it("文件重载后忽略旧 generation 才完成的元素引用", async () => {
    const element: PresentationPageElement = {
      slideIndex: 0,
      slidePart: "ppt/slides/slide1.xml",
      nodeId: "7",
      nodeName: "Title",
      nodeType: "shape",
      text: "Quarterly plan",
      bounds: { x: 100, y: 80, width: 400, height: 120 },
      zIndex: 1,
    };
    const pendingReference = createDeferred<unknown>();
    h.createReference.mockReturnValue(pendingReference.promise);
    h.open
      .mockResolvedValueOnce(createDocument("document-1", Promise.resolve(), [element]))
      .mockResolvedValueOnce(createDocument("document-2", Promise.resolve(), [element]));

    const props = {
      labels,
      referenceSource: {
        workspacePath: "/workspace",
        sourcePath: "/workspace/deck.pptx",
        sourceTitle: "deck.pptx",
      },
    };
    const view = render(
      createElement(PptxPreviewViewer, { ...props, data: new ArrayBuffer(1) }),
    );
    expect(await screen.findByText("document-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: labels.selectElement }));
    fireEvent.click(screen.getByRole("button", { name: element.text }));
    const actionBar = await screen.findByRole("toolbar", { name: labels.aiEdit });
    fireEvent.click(within(actionBar).getByText(labels.aiEdit).closest("button")!);
    fireEvent.click(
      within(actionBar).getByText(labels.addToConversation).closest("button")!,
    );
    await waitFor(() => expect(h.createReference).toHaveBeenCalledTimes(1));

    view.rerender(
      createElement(PptxPreviewViewer, { ...props, data: new ArrayBuffer(2) }),
    );
    expect(await screen.findByText("document-2")).toBeTruthy();
    await act(async () => {
      pendingReference.resolve({ id: "stale-reference" });
    });

    expect(h.dispatchReference).not.toHaveBeenCalled();
  });

  it("AI 编辑先进入意见草稿，取消不分发，确认后才把意见加入引用", async () => {
    const element: PresentationPageElement = {
      slideIndex: 0,
      slidePart: "ppt/slides/slide1.xml",
      nodeId: "7",
      nodeName: "Title",
      nodeType: "shape",
      text: "Quarterly plan",
      bounds: { x: 100, y: 80, width: 400, height: 120 },
      zIndex: 1,
    };
    const reference = {
      ...element,
      id: "reference-1",
      workspacePath: "/workspace",
      sourcePath: "/workspace/deck.pptx",
      sourceTitle: "deck.pptx",
      sourceFingerprint: `sha256:${"a".repeat(64)}`,
      capturedAt: 1,
    };
    h.open.mockResolvedValue(
      createDocument("document", Promise.resolve(), [element]),
    );
    h.createReference.mockResolvedValue(reference);

    render(
      createElement(PptxPreviewViewer, {
        data: new ArrayBuffer(1),
        labels,
        referenceSource: {
          workspacePath: "/workspace",
          sourcePath: "/workspace/deck.pptx",
          sourceTitle: "deck.pptx",
        },
      }),
    );

    expect(await screen.findByText("document")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: labels.selectElement }));
    fireEvent.click(screen.getByRole("button", { name: element.text }));

    const actionBar = await screen.findByRole("toolbar", {
      name: labels.aiEdit,
    });
    // jsdom 没有真实布局，Radix hideWhenDetached 会把锚点内容标记为视觉隐藏；
    // 这里验证 DOM/行为数量，真实位置与可见性按项目约束交给人工 UI 验收。
    const actionButtons = within(actionBar).getAllByRole("button", {
      hidden: true,
    });
    expect(actionButtons).toHaveLength(1);
    const aiEditButton = actionButtons[0];
    expect(aiEditButton).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: labels.zoomIn }));
    expect(actionBar.isConnected).toBe(true);

    h.readSelectedText.mockReturnValue("Quarterly");
    const mouseDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    aiEditButton?.dispatchEvent(mouseDown);
    expect(mouseDown.defaultPrevented).toBe(true);
    fireEvent.click(aiEditButton as HTMLButtonElement);
    expect(h.createReference).not.toHaveBeenCalled();
    expect(h.dispatchReference).not.toHaveBeenCalled();

    const instructionInput = within(actionBar).getByPlaceholderText(
      labels.commentPlaceholder,
    );
    expect(instructionInput.tagName).toBe("TEXTAREA");
    expect(within(actionBar).queryByText(labels.aiEdit)).toBeNull();
    fireEvent.change(instructionInput, {
      target: { value: "  Make the title more concise  " },
    });
    fireEvent.click(
      within(actionBar).getByText(labels.cancelAiEdit).closest("button")!,
    );
    expect(h.createReference).not.toHaveBeenCalled();
    expect(h.dispatchReference).not.toHaveBeenCalled();

    fireEvent.click(
      within(actionBar).getByText(labels.aiEdit).closest("button")!,
    );
    fireEvent.change(
      within(actionBar).getByPlaceholderText(labels.commentPlaceholder),
      { target: { value: "  Make the title more concise  " } },
    );
    fireEvent.click(
      within(actionBar)
        .getByText(labels.addToConversation)
        .closest("button")!,
    );
    await waitFor(() =>
      expect(h.createReference).toHaveBeenCalledWith(
        expect.objectContaining({
          element,
          selectedText: "Quarterly",
          comment: "Make the title more concise",
        }),
      ),
    );
    await waitFor(() => expect(h.dispatchReference).toHaveBeenCalledWith(reference));
    expect(within(actionBar).getByText(labels.aiEdit)).toBeTruthy();

    fireEvent.keyDown(actionBar, { key: "Escape" });
    expect(actionBar.isConnected).toBe(false);
    expect(
      screen.getByRole("button", { name: labels.selectElement }),
    ).toBeTruthy();
  });

  it("评论草稿吞掉方向键，Esc 只回退草稿而不退出元素选择", async () => {
    const element: PresentationPageElement = {
      slideIndex: 0,
      slidePart: "ppt/slides/slide1.xml",
      nodeId: "7",
      nodeName: "Title",
      nodeType: "shape",
      text: "Quarterly plan",
      bounds: { x: 100, y: 80, width: 400, height: 120 },
      zIndex: 1,
    };
    h.open.mockResolvedValue(
      createDocument("document", Promise.resolve(), [element], 3),
    );

    render(
      createElement(PptxPreviewViewer, {
        data: new ArrayBuffer(1),
        labels,
        referenceSource: {
          workspacePath: "/workspace",
          sourcePath: "/workspace/deck.pptx",
          sourceTitle: "deck.pptx",
        },
      }),
    );

    expect(await screen.findByText("document")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: labels.selectElement }));
    fireEvent.click(screen.getByRole("button", { name: element.text }));
    const actionBar = await screen.findByRole("toolbar", {
      name: labels.aiEdit,
    });
    fireEvent.click(
      within(actionBar).getAllByRole("button", { hidden: true })[0]!,
    );

    const textarea = within(actionBar).getByPlaceholderText(
      labels.commentPlaceholder,
    );
    fireEvent.change(textarea, { target: { value: "Make it shorter" } });
    const pageInput = screen.getByLabelText(
      labels.pageInput,
    ) as HTMLInputElement;
    expect(pageInput.value).toBe("1");

    // 回归：Textarea 经 Portal 渲染但仍在 React 树内冒泡；方向键曾翻页并连带清空未提交评论。
    fireEvent.keyDown(textarea, { key: "ArrowRight" });
    fireEvent.keyDown(textarea, { key: "ArrowLeft" });
    expect(pageInput.value).toBe("1");
    expect(
      (
        within(actionBar).getByPlaceholderText(
          labels.commentPlaceholder,
        ) as HTMLTextAreaElement
      ).value,
    ).toBe("Make it shorter");

    // 回归：编辑评论时 Esc 只丢弃草稿回到 AI 编辑条，不直接退出元素选择模式。
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(actionBar.isConnected).toBe(true);
    expect(within(actionBar).getByText(labels.aiEdit)).toBeTruthy();
    expect(
      within(actionBar).queryByPlaceholderText(labels.commentPlaceholder),
    ).toBeNull();
    expect(h.createReference).not.toHaveBeenCalled();
    expect(h.dispatchReference).not.toHaveBeenCalled();

    fireEvent.keyDown(actionBar, { key: "Escape" });
    expect(actionBar.isConnected).toBe(false);
    expect(
      screen.getByRole("button", { name: labels.selectElement }),
    ).toBeTruthy();
  });

  it("输入法组合态下 Esc 只取消候选词，不丢弃评论草稿", async () => {
    const element: PresentationPageElement = {
      slideIndex: 0,
      slidePart: "ppt/slides/slide1.xml",
      nodeId: "7",
      nodeName: "Title",
      nodeType: "shape",
      text: "Quarterly plan",
      bounds: { x: 100, y: 80, width: 400, height: 120 },
      zIndex: 1,
    };
    h.open.mockResolvedValue(
      createDocument("document", Promise.resolve(), [element]),
    );

    render(
      createElement(PptxPreviewViewer, {
        data: new ArrayBuffer(1),
        labels,
        referenceSource: {
          workspacePath: "/workspace",
          sourcePath: "/workspace/deck.pptx",
          sourceTitle: "deck.pptx",
        },
      }),
    );

    expect(await screen.findByText("document")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: labels.selectElement }));
    fireEvent.click(screen.getByRole("button", { name: element.text }));
    const actionBar = await screen.findByRole("toolbar", {
      name: labels.aiEdit,
    });
    fireEvent.click(
      within(actionBar).getAllByRole("button", { hidden: true })[0]!,
    );

    const textarea = within(actionBar).getByPlaceholderText(
      labels.commentPlaceholder,
    );
    fireEvent.change(textarea, { target: { value: "标题" } });

    const draftValue = () =>
      (
        within(actionBar).queryByPlaceholderText(
          labels.commentPlaceholder,
        ) as HTMLTextAreaElement | null
      )?.value;

    // composition 事件维护的本地状态：部分平台 Esc keydown 上的 isComposing 已提前变 false。
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(draftValue()).toBe("标题");

    // 平台 isComposing 信号单独兜底：即使没收到 compositionStart 也不丢草稿。
    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: "Escape", isComposing: true });
    expect(draftValue()).toBe("标题");

    // 组合结束后的 Esc 才回退草稿，且仍停留在元素选择模式。
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(actionBar.isConnected).toBe(true);
    expect(within(actionBar).getByText(labels.aiEdit)).toBeTruthy();
    expect(draftValue()).toBeUndefined();
    expect(h.createReference).not.toHaveBeenCalled();
  });

  it("高亮含文本元素后允许底层文字划选，并继续拦截预览跳转", async () => {
    const textElement: PresentationPageElement = {
      slideIndex: 0,
      slidePart: "ppt/slides/slide1.xml",
      nodeId: "7",
      nodeName: "Title",
      nodeType: "shape",
      text: "Quarterly plan",
      bounds: { x: 100, y: 80, width: 400, height: 120 },
      zIndex: 1,
    };
    const tableCellElement: PresentationPageElement = {
      slideIndex: 0,
      slidePart: "ppt/slides/slide1.xml",
      nodeId: "8",
      nodeName: "Status table",
      nodeType: "table-cell",
      text: "On track",
      bounds: { x: 600, y: 80, width: 200, height: 120 },
      zIndex: 2,
      rowIndex: 0,
      cellIndex: 0,
    };
    const previewDocument = createDocument(
      "Quarterly plan",
      Promise.resolve(),
      [textElement, tableCellElement],
    );
    const navigate = vi.fn();
    previewDocument.renderPage.mockImplementation(
      (_pageIndex: number, container: HTMLElement) => {
        const link = document.createElement("a");
        link.href = "https://example.com";
        link.textContent = "Quarterly plan";
        link.addEventListener("click", navigate);
        container.append(link);
        return { ready: Promise.resolve(), dispose: vi.fn() };
      },
    );
    h.open.mockResolvedValue(previewDocument);

    render(
      createElement(PptxPreviewViewer, {
        data: new ArrayBuffer(1),
        labels,
        referenceSource: {
          workspacePath: "/workspace",
          sourcePath: "/workspace/deck.pptx",
          sourceTitle: "deck.pptx",
        },
      }),
    );

    const renderedText = await screen.findByText("Quarterly plan");
    const renderSurface = renderedText.parentElement;
    expect(renderSurface).not.toBeNull();
    vi.spyOn(
      renderSurface as HTMLElement,
      "getBoundingClientRect",
    ).mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1280,
      bottom: 720,
      width: 1280,
      height: 720,
      toJSON: () => ({}),
    });
    fireEvent.click(screen.getByRole("button", { name: labels.selectElement }));
    fireEvent.click(screen.getByRole("button", { name: textElement.text }));

    expect(renderSurface?.classList.contains("pointer-events-auto")).toBe(true);
    expect(renderSurface?.classList.contains("select-text")).toBe(true);
    expect(
      screen
        .getByRole("button", { name: textElement.text })
        .classList.contains("pointer-events-none"),
    ).toBe(true);

    const textPointerDown = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 100,
    });
    renderSurface?.dispatchEvent(textPointerDown);
    expect(textPointerDown.defaultPrevented).toBe(false);

    const linkClick = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
    });
    renderedText.dispatchEvent(linkClick);
    expect(linkClick.defaultPrevented).toBe(true);
    expect(navigate).not.toHaveBeenCalled();

    fireEvent.pointerDown(renderSurface as HTMLElement, {
      clientX: 650,
      clientY: 100,
    });
    expect(
      screen.getByRole("button", { name: tableCellElement.text }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: tableCellElement.text })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(renderSurface?.classList.contains("pointer-events-auto")).toBe(true);
  });

  it("同文件引用导航不重新解析，并在定位前退出元素选择模式", async () => {
    const element: PresentationPageElement = {
      slideIndex: 0,
      slidePart: "ppt/slides/slide1.xml",
      nodeId: "7",
      nodeName: "Title",
      nodeType: "shape",
      text: "Quarterly plan",
      bounds: { x: 100, y: 80, width: 400, height: 120 },
      zIndex: 1,
    };
    const data = new ArrayBuffer(1);
    h.open.mockResolvedValue(
      createDocument("document", Promise.resolve(), [element], 3),
    );
    const view = render(
      createElement(PptxPreviewViewer, {
        data,
        labels,
        referenceSource: {
          workspacePath: "/workspace",
          sourcePath: "/workspace/deck.pptx",
          sourceTitle: "deck.pptx",
        },
      }),
    );

    expect(await screen.findByText("document")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: labels.selectElement }));
    fireEvent.click(screen.getByRole("button", { name: element.text }));
    expect(await screen.findByRole("toolbar", { name: labels.aiEdit })).toBeTruthy();

    view.rerender(
      createElement(PptxPreviewViewer, {
        data,
        labels,
        referenceSource: {
          workspacePath: "/workspace",
          sourcePath: "/workspace/deck.pptx",
          sourceTitle: "deck.pptx",
        },
        referenceNavigation: {
          requestId: "navigation-1",
          pageIndex: 1,
          expectedSourceFingerprint: `sha256:${"a".repeat(64)}`,
        },
      }),
    );

    await waitFor(() =>
      expect(
        (screen.getByRole("textbox", { name: labels.pageInput }) as HTMLInputElement).value,
      ).toBe("2"),
    );
    expect(screen.queryByRole("toolbar", { name: labels.aiEdit })).toBeNull();
    expect(h.open).toHaveBeenCalledTimes(1);
  });

  it("页码不存在时保留文件预览并 toast，不使用 clamp 冒充定位成功", async () => {
    h.open.mockResolvedValue(createDocument("document", Promise.resolve()));

    render(
      createElement(PptxPreviewViewer, {
        data: new ArrayBuffer(1),
        labels,
        referenceNavigation: {
          requestId: "navigation-missing-page",
          pageIndex: 4,
          expectedSourceFingerprint: `sha256:${"a".repeat(64)}`,
        },
      }),
    );

    expect(await screen.findByText("document")).toBeTruthy();
    expect(
      (screen.getByRole("textbox", { name: labels.pageInput }) as HTMLInputElement).value,
    ).toBe("1");
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith("missing-page-5"));
  });

  it("文件 fingerprint 已变化但页码存在时仍定位并 toast", async () => {
    h.open.mockResolvedValue(
      createDocument("document", Promise.resolve(), [], 2),
    );

    render(
      createElement(PptxPreviewViewer, {
        data: new ArrayBuffer(1),
        labels,
        referenceNavigation: {
          requestId: "navigation-stale-source",
          pageIndex: 1,
          expectedSourceFingerprint: `sha256:${"b".repeat(64)}`,
        },
      }),
    );

    expect(await screen.findByText("document")).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByRole("textbox", { name: labels.pageInput }) as HTMLInputElement).value,
      ).toBe("2"),
    );
    expect(h.toast).toHaveBeenCalledWith("changed-source-2");
  });
});

describe("PptxPreviewViewer 滚动防护", () => {
  function stubScrollOffset(element: HTMLElement, top: number, left: number) {
    let scrollTop = top;
    let scrollLeft = left;
    Object.defineProperty(element, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    Object.defineProperty(element, "scrollLeft", {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
    });
    return {
      get scrollTop() {
        return scrollTop;
      },
      get scrollLeft() {
        return scrollLeft;
      },
    };
  }

  it("幻灯片内部容器被原生行为滚动后立即复位（滚动条已隐藏，偏移不可见也无法拖回）", async () => {
    const doc = createDocument("document-1", Promise.resolve());
    h.open.mockResolvedValueOnce(doc);

    render(createElement(PptxPreviewViewer, { data: new ArrayBuffer(1), labels }));
    const inner = await screen.findByText("document-1");

    const offset = stubScrollOffset(inner, 24, 8);
    inner.dispatchEvent(new Event("scroll"));

    expect(offset.scrollTop).toBe(0);
    expect(offset.scrollLeft).toBe(0);
  });
});
