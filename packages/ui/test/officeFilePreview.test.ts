// @vitest-environment jsdom

import { createElement, useState, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  calculateDocxPreviewFit,
  decodeBase64ToArrayBuffer,
  getOfficeFilePreviewKind,
  installDocumentLinkSafety,
  sanitizeDocumentLinks,
  sanitizeDocumentHref,
} from "@/lib/officeFilePreview.js";

const docxMockState = vi.hoisted(() => ({
  isLoading: false,
  editorOptions: undefined as unknown,
}));

const docxPreviewMockState = vi.hoisted(() => ({
  renderAsync: vi.fn(
    async (
      _buffer: ArrayBuffer,
      bodyContainer: HTMLElement,
      styleContainer: HTMLElement,
      options: { className: string },
    ) => {
      const style = document.createElement("style");
      style.textContent = `.${options.className} { color: black; }`;
      styleContainer.append(style);

      const wrapper = document.createElement("div");
      wrapper.className = `${options.className}-wrapper`;
      const page = document.createElement("section");
      page.className = options.className;
      page.textContent = "Rendered DOCX";
      const unsafeLink = document.createElement("a");
      unsafeLink.setAttribute("href", "java\nscript:alert(1)");
      unsafeLink.textContent = "Unsafe";
      const safeLink = document.createElement("a");
      safeLink.setAttribute("href", "https://example.com/document");
      safeLink.textContent = "Safe";
      wrapper.append(page);
      wrapper.append(unsafeLink, safeLink);
      bodyContainer.append(wrapper);
    },
  ),
}));

vi.mock("docx-preview", () => ({
  renderAsync: docxPreviewMockState.renderAsync,
}));

vi.mock("@extend-ai/react-xlsx/duke_sheets_wasm_bg.wasm?url", () => ({
  default: "xlsx-wasm-url",
}));

vi.mock("@extend-ai/react-docx/docx_wasm_bg.wasm?url", () => ({
  default: "docx-wasm-url",
}));

vi.mock("@extend-ai/react-xlsx", () => ({
  setWasmSource: vi.fn(),
  XlsxViewer: ({
    isDark,
    readOnly,
    rounded,
    showDefaultToolbar,
    loadingState,
    toolbar,
  }: {
    isDark: boolean;
    readOnly: boolean;
    rounded: boolean;
    showDefaultToolbar: boolean;
    loadingState: ReactNode;
    toolbar:
      | ReactNode
      | ((controller: {
          activeTabIndex: number;
          setActiveTabIndex: (index: number) => void;
          tabs: Array<{ id: string; name: string }>;
        }) => ReactNode);
  }) => {
    const tabs = [
      { id: "summary", name: "Summary" },
      { id: "details", name: "Details" },
    ];
    const [activeTabIndex, setActiveTabIndex] = useState(0);
    const toolbarContent =
      typeof toolbar === "function"
        ? toolbar({ activeTabIndex, setActiveTabIndex, tabs })
        : toolbar;

    return createElement(
      "div",
      {
        "data-dark": String(isDark),
        "data-read-only": String(readOnly),
        "data-rounded": String(rounded),
        "data-toolbar": String(showDefaultToolbar),
        "data-testid": "xlsx-viewer",
      },
      toolbarContent,
      createElement("div", {
        "data-active-sheet": tabs[activeTabIndex]?.name,
      }),
      loadingState,
    );
  },
}));

vi.mock("@extend-ai/react-docx", () => ({
  setWasmSource: vi.fn(),
  useDocxModel: () => ({
    model: { nodes: [] },
    isLoading: docxMockState.isLoading,
    error: undefined,
  }),
  useDocxEditor: (options: unknown) => {
    docxMockState.editorOptions = options;
    return {
      model: (options as { starterModel?: unknown }).starterModel,
    };
  },
  DocxEditorViewer: ({
    editor,
    mode,
    pageGapBackgroundColor,
    pageVirtualization,
  }: {
    editor: { model: unknown };
    mode: string;
    pageGapBackgroundColor: string;
    pageVirtualization: { zoomScale?: number };
  }) =>
    createElement("div", {
      "data-gap-background": pageGapBackgroundColor,
      "data-has-model": String(Boolean(editor.model)),
      "data-mode": mode,
      "data-testid": "docx-editor-viewer",
      "data-virtualization-scale": String(pageVirtualization.zoomScale),
    }),
}));

vi.mock("@/components/ui/pptx-preview-viewer.js", () => ({
  PptxPreviewViewer: ({
    onOpenBrowserUrl,
  }: {
    onOpenBrowserUrl?: (url: string) => void;
  }) =>
    createElement("div", {
      "data-pptx-open-url-handler": String(Boolean(onOpenBrowserUrl)),
    }),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  docxPreviewMockState.renderAsync.mockClear();
  docxMockState.editorOptions = undefined;
  docxMockState.isLoading = false;
});

describe("Office file preview", () => {
  it("recognizes supported Excel and Word extensions", () => {
    expect(getOfficeFilePreviewKind("/workspace/report.xlsx")).toBe("excel");
    expect(getOfficeFilePreviewKind("/workspace/report.XLSM")).toBe("excel");
    expect(getOfficeFilePreviewKind("C:\\workspace\\legacy.xls")).toBe("excel");
    expect(getOfficeFilePreviewKind("/workspace/proposal.docx")).toBe("docx");
    expect(getOfficeFilePreviewKind("/workspace/proposal.doc")).toBe("doc");
    expect(getOfficeFilePreviewKind("C:\\workspace\\LEGACY.DOC")).toBe("doc");
    expect(getOfficeFilePreviewKind("/workspace/data.csv")).toBeNull();
  });

  it("decodes RPC base64 content into an exact ArrayBuffer", () => {
    const expected = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
    const base64 = Buffer.from(expected).toString("base64");

    expect(new Uint8Array(decodeBase64ToArrayBuffer(base64))).toEqual(expected);
  });

  it("allows only http(s) and internal document anchors", () => {
    expect(sanitizeDocumentHref("https://example.com/a")).toBe("https://example.com/a");
    expect(sanitizeDocumentHref("HTTP://example.com/a")).toBe("HTTP://example.com/a");
    expect(sanitizeDocumentHref("#section-1")).toBe("#section-1");
    expect(sanitizeDocumentHref("javascript:alert(1)")).toBeNull();
    expect(sanitizeDocumentHref("java\nscript:alert(1)")).toBeNull();
    expect(sanitizeDocumentHref("j%61vascript:alert(1)")).toBeNull();
    expect(sanitizeDocumentHref("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(sanitizeDocumentHref("file:///tmp/secret")).toBeNull();
    expect(sanitizeDocumentHref("//evil.example/redirect")).toBeNull();
  });

  it("sanitizes link attributes added after a third-party renderer mounts", async () => {
    const root = document.createElement("div");
    const link = document.createElement("a");
    root.append(link);
    const rootQuerySelectorAll = vi.spyOn(root, "querySelectorAll");
    const dispose = installDocumentLinkSafety(root);

    link.setAttribute("href", "javascript:alert(1)");

    await waitFor(() => expect(link.hasAttribute("href")).toBe(false));
    expect(rootQuerySelectorAll).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("sanitizes only newly added renderer subtrees after the initial full scan", async () => {
    const root = document.createElement("div");
    const rootQuerySelectorAll = vi.spyOn(root, "querySelectorAll");
    const dispose = installDocumentLinkSafety(root);
    const addedSection = document.createElement("section");
    addedSection.innerHTML = '<a href="javascript:alert(1)">Unsafe</a>';

    root.append(addedSection);

    const addedLink = addedSection.querySelector("a");
    await waitFor(() => expect(addedLink?.hasAttribute("href")).toBe(false));
    expect(rootQuerySelectorAll).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("does not strip non-interactive Office image resources", () => {
    const root = document.createElement("div");
    const image = document.createElementNS("http://www.w3.org/2000/svg", "image");
    image.setAttribute("href", "data:image/png;base64,AA==");
    root.append(image);

    sanitizeDocumentLinks(root);

    expect(image.getAttribute("href")).toBe("data:image/png;base64,AA==");
  });

  it("keeps the PDF annotation layer disabled so document links never enter the DOM", () => {
    const source = readFileSync("packages/ui/src/components/ui/pdf-viewer.tsx", "utf8");

    expect(source).toContain("renderAnnotationLayer={false}");
  });

  it("fits DOCX pages to narrow containers without upscaling", () => {
    expect(
      calculateDocxPreviewFit({
        availableWidth: 571,
        naturalWidth: 794,
        naturalHeight: 4751,
      }),
    ).toEqual({
      scale: 571 / 794,
      width: 571,
      height: 4751 * (571 / 794),
    });

    expect(
      calculateDocxPreviewFit({
        availableWidth: 1000,
        naturalWidth: 794,
        naturalHeight: 4751,
      }),
    ).toEqual({
      scale: 1,
      width: 794,
      height: 4751,
    });

    expect(
      calculateDocxPreviewFit({
        availableWidth: 0,
        naturalWidth: 794,
        naturalHeight: 4751,
      }),
    ).toBeNull();
  });

  it("renders Excel in read-only mode with switchable sheet tabs only", async () => {
    const { PreviewPaneOfficeXlsxContent } = await import("@/previewPaneOfficeXlsxContent.js");
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(PreviewPaneOfficeXlsxContent, {
          buffer: new ArrayBuffer(4),
          errorMessage: "unavailable",
          isDark: true,
          sourcePath: "/workspace/report.xlsx",
        }),
      ),
    );

    const viewer = view.getByTestId("xlsx-viewer");
    expect(viewer.getAttribute("data-read-only")).toBe("true");
    expect(viewer.getAttribute("data-toolbar")).toBe("false");
    expect(viewer.getAttribute("data-dark")).toBe("true");
    expect(view.getByRole("tablist", { name: "Workbook sheets" })).not.toBeNull();

    const summaryTab = view.getByRole("tab", { name: "Summary" });
    const detailsTab = view.getByRole("tab", { name: "Details" });
    expect(summaryTab.getAttribute("aria-selected")).toBe("true");
    expect(viewer.querySelector("[data-active-sheet]")?.getAttribute("data-active-sheet")).toBe(
      "Summary",
    );

    fireEvent.click(detailsTab);
    expect(detailsTab.getAttribute("aria-selected")).toBe("true");
    expect(viewer.querySelector("[data-active-sheet]")?.getAttribute("data-active-sheet")).toBe(
      "Details",
    );

    fireEvent.keyDown(detailsTab, { key: "ArrowRight" });
    expect(summaryTab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(summaryTab);
    expect(view.container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(view.container.textContent).not.toContain("loading");
  });

  it("passes the controlled browser URL handler to PPTX previews", async () => {
    const { PptxPreviewContent } = await import("@/previewPanePptxContent.js");
    const view = render(
      createElement(PptxPreviewContent, {
        data: new ArrayBuffer(4),
        fileName: "/workspace/deck.pptx",
        labels: {
          addToConversation: "Add",
          aiEdit: "Edit",
          cancelAiEdit: "Cancel",
          exitElementSelection: "Exit",
          exportingPdf: "Exporting",
          exportPdf: "Export",
          exportPdfFailed: "Failed",
          exportPdfSuccess: (path: string) => path,
          loadError: "Error",
          loading: "Loading",
          nextPage: "Next",
          noSlides: "No slides",
          pageInput: "Page",
          previousPage: "Previous",
          referencedPageMissing: (page: number) => String(page),
          referencedSourceChanged: (page: number) => String(page),
          selectElement: "Select",
          thumbnail: (page: number) => String(page),
          thumbnails: "Thumbnails",
          zoomIn: "Zoom in",
          zoomOut: "Zoom out",
          commentPlaceholder: "Comment",
        },
        onOpenBrowserUrl: vi.fn(),
      }),
    );

    await waitFor(() => {
      expect(view.container.querySelector("[data-pptx-open-url-handler='true']")).not.toBeNull();
    });
  });

  it("renders DOCX through docx-preview with safe read-only options", async () => {
    const { PreviewPaneOfficeDocxContent } = await import("@/previewPaneOfficeDocxContent.js");
    const onOpenBrowserUrl = vi.fn();
    const view = render(
      createElement(PreviewPaneOfficeDocxContent, {
        buffer: new ArrayBuffer(4),
        errorMessage: "unavailable",
        onOpenBrowserUrl,
        sourcePath: "/workspace/proposal.docx",
      }),
    );

    await waitFor(() => {
      expect(docxPreviewMockState.renderAsync).toHaveBeenCalledTimes(1);
      expect(view.container.querySelector("section")?.textContent).toBe("Rendered DOCX");
    });

    expect(view.container.querySelector('a[href]')).not.toBeNull();
    expect(view.container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(view.container.querySelector('a[href="https://example.com/document"]')).not.toBeNull();
    fireEvent.click(view.container.querySelector('a[href="https://example.com/document"]')!);
    expect(onOpenBrowserUrl).toHaveBeenCalledWith("https://example.com/document");
    fireEvent.click(view.container.querySelector('a[aria-disabled="true"]')!);
    expect(onOpenBrowserUrl).toHaveBeenCalledTimes(1);

    const [buffer, bodyContainer, styleContainer, options] =
      docxPreviewMockState.renderAsync.mock.calls[0]!;
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(bodyContainer).toBeInstanceOf(HTMLElement);
    expect(styleContainer).toBeInstanceOf(HTMLElement);
    expect(styleContainer).not.toBe(bodyContainer);
    expect(options).toMatchObject({
      breakPages: true,
      debug: false,
      experimental: true,
      ignoreLastRenderedPageBreak: true,
      renderAltChunks: false,
      renderChanges: false,
      renderComments: false,
      useBase64URL: true,
    });
    expect(view.container.querySelector('[data-office-preview-kind="docx"]')).not.toBeNull();
    expect(view.container.querySelector("[data-docx-fit-viewport]")).not.toBeNull();
    expect(view.container.querySelector("[data-docx-fit-frame]")).not.toBeNull();
    expect(view.container.querySelector("[data-docx-fit-content]")).not.toBeNull();
    expect(styleContainer.textContent).toContain(
      "box-shadow: 0 2px 10px rgba(15, 23, 42, 0.08), 0 1px 2px rgba(15, 23, 42, 0.05)",
    );
  });

  it("keeps legacy DOC files on the read-only editor compatibility path", async () => {
    const { PreviewPaneOfficeLegacyDocContent } =
      await import("@/previewPaneOfficeLegacyDocContent.js");
    const html = renderToStaticMarkup(
      createElement(PreviewPaneOfficeLegacyDocContent, {
        buffer: new ArrayBuffer(4),
        errorMessage: "unavailable",
        sourcePath: "/workspace/proposal.doc",
      }),
    );

    expect(html).toContain('data-office-preview-kind="doc"');
    expect(html).toContain('data-testid="docx-editor-viewer"');
    expect(html).toContain('data-mode="read-only"');
    expect(html).toContain('data-has-model="true"');
    expect(html).toContain('data-gap-background="transparent"');
    expect(html).toContain('data-virtualization-scale="1"');
    expect(docxMockState.editorOptions).toMatchObject({
      initialDocumentTheme: "light",
      initialFileName: "/workspace/proposal.doc",
      starterModel: { nodes: [] },
    });
  });

  it("keeps the DOCX loading surface blank while exposing aria-busy", async () => {
    docxPreviewMockState.renderAsync.mockImplementationOnce(() => new Promise(() => undefined));
    const { PreviewPaneOfficeDocxContent } = await import("@/previewPaneOfficeDocxContent.js");
    const view = render(
      createElement(PreviewPaneOfficeDocxContent, {
        buffer: new ArrayBuffer(4),
        errorMessage: "unavailable",
        sourcePath: "/workspace/proposal.docx",
      }),
    );

    const pending = view.container.querySelector("[data-office-preview-pending]");
    expect(pending?.getAttribute("aria-busy")).toBe("true");
    expect(view.container.textContent).toBe("");
  });

  it("recovers from a DOCX parse error when the preview source changes", async () => {
    docxPreviewMockState.renderAsync.mockRejectedValueOnce(new Error("broken document"));
    const { PreviewPaneOfficeDocxContent } = await import("@/previewPaneOfficeDocxContent.js");
    const view = render(
      createElement(PreviewPaneOfficeDocxContent, {
        buffer: new ArrayBuffer(4),
        errorMessage: "unavailable",
        sourcePath: "/workspace/broken.docx",
      }),
    );

    await waitFor(() => {
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe("unavailable");
    });

    view.rerender(
      createElement(PreviewPaneOfficeDocxContent, {
        buffer: new ArrayBuffer(8),
        errorMessage: "unavailable",
        sourcePath: "/workspace/working.docx",
      }),
    );

    await waitFor(() => {
      expect(docxPreviewMockState.renderAsync).toHaveBeenCalledTimes(2);
      expect(view.container.querySelector("section")?.textContent).toBe("Rendered DOCX");
    });
  });

  it("does not let a stale DOCX render replace the latest source", async () => {
    let finishStaleRender: (() => void) | undefined;
    docxPreviewMockState.renderAsync.mockImplementationOnce(
      async (
        _buffer: ArrayBuffer,
        bodyContainer: HTMLElement,
        _styleContainer: HTMLElement,
        options: { className: string },
      ) => {
        await new Promise<void>((resolve) => {
          finishStaleRender = () => {
            const stalePage = document.createElement("section");
            stalePage.className = options.className;
            stalePage.textContent = "Stale DOCX";
            bodyContainer.append(stalePage);
            resolve();
          };
        });
      },
    );
    const { PreviewPaneOfficeDocxContent } = await import("@/previewPaneOfficeDocxContent.js");
    const view = render(
      createElement(PreviewPaneOfficeDocxContent, {
        buffer: new ArrayBuffer(4),
        errorMessage: "unavailable",
        sourcePath: "/workspace/old.docx",
      }),
    );

    await waitFor(() => {
      expect(docxPreviewMockState.renderAsync).toHaveBeenCalledTimes(1);
    });

    view.rerender(
      createElement(PreviewPaneOfficeDocxContent, {
        buffer: new ArrayBuffer(8),
        errorMessage: "unavailable",
        sourcePath: "/workspace/latest.docx",
      }),
    );
    await waitFor(() => {
      expect(docxPreviewMockState.renderAsync).toHaveBeenCalledTimes(2);
      expect(view.container.querySelector("section")?.textContent).toBe("Rendered DOCX");
    });

    await act(async () => {
      finishStaleRender?.();
    });

    expect(view.container.querySelector("section")?.textContent).toBe("Rendered DOCX");
    expect(view.container.textContent).not.toContain("Stale DOCX");
  });
});
