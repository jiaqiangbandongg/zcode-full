// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPlatformService } from "@zcode/shared";
import type { PresentationPreviewDocument } from "@/presentation/types.js";
import {
  materializePrintableFontFamilies,
  renderPresentationToPrintHost,
  resolvePrintableFontFamily,
} from "@/presentation/presentationPdfPrintExport.js";

const h = vi.hoisted(() => ({
  open: vi.fn(),
  loggerError: vi.fn(),
  toast: vi.fn(),
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

import {
  PptxPreviewViewer,
  type PptxPreviewViewerLabels,
} from "@/components/ui/pptx-preview-viewer.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";

interface MockHandle {
  ready: Promise<void>;
  dispose: ReturnType<typeof vi.fn>;
}

function createPrintableDocument(
  pageCount: number,
  options?: { failAtPage?: number },
): {
  doc: PresentationPreviewDocument & { renderPage: ReturnType<typeof vi.fn> };
  handles: MockHandle[];
  renderOrder: number[];
} {
  const handles: MockHandle[] = [];
  const renderOrder: number[] = [];
  const doc = {
    pageCount,
    pageSize: { width: 1280, height: 720 },
    dispose: vi.fn(),
    renderPage: vi.fn((pageIndex: number, container: HTMLElement) => {
      renderOrder.push(pageIndex);
      const element = document.createElement("div");
      element.textContent = `slide-${pageIndex}`;
      container.append(element);
      const ready =
        options?.failAtPage === pageIndex
          ? Promise.reject(new Error(`render failed at ${pageIndex}`))
          : Promise.resolve();
      // 避免 jsdom 报未处理 rejection：消费一次留给调用方的同一 Promise
      ready.catch(() => undefined);
      const handle: MockHandle = { ready, dispose: vi.fn(() => element.remove()) };
      handles.push(handle);
      return handle;
    }),
  };
  return { doc, handles, renderOrder };
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
};

function queryPrintHost() {
  return document.querySelector("[data-zcode-pptx-print-host]");
}

function queryPrintStyle() {
  return document.querySelector("style[data-zcode-pptx-print-style]");
}

beforeEach(() => {
  h.open.mockReset();
  h.loggerError.mockReset();
  h.toast.mockReset();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  queryPrintHost()?.remove();
  queryPrintStyle()?.remove();
});

describe("renderPresentationToPrintHost", () => {
  it("按顺序全量渲染所有页并注入打印样式", async () => {
    const { doc, renderOrder } = createPrintableDocument(3);

    const printHost = await renderPresentationToPrintHost(doc, document);

    expect(renderOrder).toEqual([0, 1, 2]);
    const host = queryPrintHost();
    expect(host).toBeTruthy();
    expect(host?.querySelectorAll("[data-zcode-pptx-print-page]")).toHaveLength(3);
    const style = queryPrintStyle();
    expect(style?.textContent).toContain("@page");
    expect(style?.textContent).toContain("size: 1280px 720px");
    expect(style?.textContent).toContain("break-after: page");
    expect(style?.textContent).toContain("scrollbar-width: none");
    printHost.dispose();
  });

  it("dispose 释放全部 render handle 并移除打印 DOM 与样式", async () => {
    const { doc, handles } = createPrintableDocument(3);

    const printHost = await renderPresentationToPrintHost(doc, document);
    printHost.dispose();

    for (const handle of handles) {
      expect(handle.dispose).toHaveBeenCalledTimes(1);
    }
    expect(queryPrintHost()).toBeNull();
    expect(queryPrintStyle()).toBeNull();

    // dispose 幂等
    printHost.dispose();
    for (const handle of handles) {
      expect(handle.dispose).toHaveBeenCalledTimes(1);
    }
  });

  it("中途渲染失败时抛错并清理已渲染的页面", async () => {
    const { doc, handles, renderOrder } = createPrintableDocument(3, { failAtPage: 1 });

    await expect(renderPresentationToPrintHost(doc, document)).rejects.toThrow(
      "render failed at 1",
    );

    expect(renderOrder).toEqual([0, 1]);
    for (const handle of handles) {
      expect(handle.dispose).toHaveBeenCalledTimes(1);
    }
    expect(queryPrintHost()).toBeNull();
    expect(queryPrintStyle()).toBeNull();
  });
});

describe("PPTX PDF 打印字体回退", () => {
  it("首选字体可用时保留原字体栈", () => {
    const isFontAvailable = vi.fn((family: string) => family === "Playfair Display");

    expect(
      resolvePrintableFontFamily(
        '"Playfair Display", Georgia, serif',
        "Legendary Jazz Master",
        isFontAvailable,
      ),
    ).toBeNull();
    expect(isFontAvailable).toHaveBeenCalledWith("Playfair Display", "latin");
  });

  it("移除不可用字体前缀并把原栈中首个可用字体放到首位", () => {
    const isFontAvailable = vi.fn((family: string) =>
      ["PingFang SC", "Hiragino Sans GB"].includes(family),
    );

    expect(
      resolvePrintableFontFamily(
        '"Microsoft YaHei", "微软雅黑", "PingFang SC", "Hiragino Sans GB", sans-serif',
        "电影与游戏之间的造梦人",
        isFontAvailable,
      ),
    ).toBe('"Hiragino Sans GB", sans-serif');
  });

  it("整条原字体栈均不可用时按文本与字体类别选择系统可用 fallback", () => {
    const available = new Set(["Arial Narrow", "Songti SC"]);
    const isFontAvailable = vi.fn((family: string) => available.has(family));

    expect(
      resolvePrintableFontFamily('"Liberation Sans Narrow"', "HIDEO KOJIMA", isFontAvailable),
    ).toBe('"Arial Narrow", Arial, Helvetica, sans-serif');
    expect(resolvePrintableFontFamily('"Noto Serif SC"', "三十余年创作脉络", isFontAvailable)).toBe(
      '"Songti SC", STSong, SimSun, "Noto Serif CJK SC", "Source Han Serif SC", serif',
    );
  });

  it("只修改打印 DOM 的文字节点父元素，不改动已可用字体", () => {
    const host = document.createElement("div");
    const missing = document.createElement("span");
    missing.style.fontFamily = '"Liberation Sans Narrow"';
    missing.textContent = "HIDEO KOJIMA";
    const available = document.createElement("span");
    available.style.fontFamily = '"Courier New", monospace';
    available.textContent = "BAFTA Fellowship";
    host.append(missing, available);
    document.body.append(host);

    materializePrintableFontFamilies(document, host, (family) =>
      ["Arial Narrow", "Courier New"].includes(family),
    );

    expect(missing.style.fontFamily).toBe('"Arial Narrow", Arial, Helvetica, sans-serif');
    expect(available.style.fontFamily).toBe('"Courier New", monospace');
    host.remove();
  });
});

describe("PptxPreviewViewer 导出 PDF 按钮", () => {
  function renderViewer(platform: IPlatformService | null, fileName?: string) {
    const viewer = createElement(PptxPreviewViewer, {
      data: new ArrayBuffer(1),
      labels,
      fileName,
    });
    return render(platform ? createElement(PlatformProvider, { platform }, viewer) : viewer);
  }

  it("无 platform 能力时不渲染导出按钮", async () => {
    const { doc } = createPrintableDocument(1);
    h.open.mockResolvedValueOnce(doc);

    renderViewer(null);
    expect(await screen.findByText("slide-0")).toBeTruthy();
    expect(screen.queryByLabelText("export-pdf")).toBeNull();
  });

  it("导出成功：全量渲染、保存为同名 pdf 并提示成功", async () => {
    const { doc, renderOrder } = createPrintableDocument(3);
    h.open.mockResolvedValueOnce(doc);
    const printPageToPdf = vi.fn().mockResolvedValue({ success: true, data: new ArrayBuffer(8) });
    const saveFile = vi.fn().mockResolvedValue({ success: true, path: "/tmp/deck.pdf" });
    const platform = { printPageToPdf, saveFile } as unknown as IPlatformService;

    renderViewer(platform, "/workspace/slides/deck.pptx");
    fireEvent.click(await screen.findByLabelText("export-pdf"));

    await waitFor(() => expect(h.toast).toHaveBeenCalledWith("export-pdf-success-/tmp/deck.pdf"));
    // 主视口先渲染第 0 页，导出容器再按 0,1,2 全量渲染
    expect(renderOrder.slice(-3)).toEqual([0, 1, 2]);
    expect(printPageToPdf).toHaveBeenCalledTimes(1);
    expect(saveFile).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: "deck.pdf" }));
    expect(queryPrintHost()).toBeNull();
    expect(queryPrintStyle()).toBeNull();
  });

  it("导出期间按钮切换为进行中并禁用", async () => {
    const { doc } = createPrintableDocument(1);
    h.open.mockResolvedValueOnce(doc);
    let resolvePrint!: (value: { success: boolean; data?: ArrayBuffer }) => void;
    const printPageToPdf = vi.fn(
      () =>
        new Promise<{ success: boolean; data?: ArrayBuffer }>((resolve) => {
          resolvePrint = resolve;
        }),
    );
    const saveFile = vi.fn().mockResolvedValue({ success: true, path: "/tmp/a.pdf" });
    const platform = { printPageToPdf, saveFile } as unknown as IPlatformService;

    renderViewer(platform);
    fireEvent.click(await screen.findByLabelText("export-pdf"));

    const exportingButton = await screen.findByLabelText("exporting-pdf");
    expect((exportingButton as HTMLButtonElement).disabled).toBe(true);

    await waitFor(() => expect(printPageToPdf).toHaveBeenCalledTimes(1));
    resolvePrint({ success: true, data: new ArrayBuffer(8) });
    await waitFor(() => expect(h.toast).toHaveBeenCalled());
    expect(await screen.findByLabelText("export-pdf")).toBeTruthy();
  });

  it("用户取消保存对话框时静默返回", async () => {
    const { doc } = createPrintableDocument(1);
    h.open.mockResolvedValueOnce(doc);
    const printPageToPdf = vi.fn().mockResolvedValue({ success: true, data: new ArrayBuffer(8) });
    const saveFile = vi.fn().mockResolvedValue({ success: false, canceled: true });
    const platform = { printPageToPdf, saveFile } as unknown as IPlatformService;

    renderViewer(platform);
    fireEvent.click(await screen.findByLabelText("export-pdf"));

    await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByLabelText("exporting-pdf")).toBeNull());
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("打印失败时提示失败且不弹保存对话框、无打印 DOM 残留", async () => {
    const { doc } = createPrintableDocument(1);
    h.open.mockResolvedValueOnce(doc);
    const printPageToPdf = vi.fn().mockResolvedValue({ success: false, error: "print_failed" });
    const saveFile = vi.fn();
    const platform = { printPageToPdf, saveFile } as unknown as IPlatformService;

    renderViewer(platform);
    fireEvent.click(await screen.findByLabelText("export-pdf"));

    await waitFor(() => expect(h.toast).toHaveBeenCalledWith("export-pdf-failed"));
    expect(saveFile).not.toHaveBeenCalled();
    expect(h.loggerError).toHaveBeenCalled();
    expect(queryPrintHost()).toBeNull();
    expect(queryPrintStyle()).toBeNull();
  });
});
