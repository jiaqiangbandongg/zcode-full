// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImagePreviewContent, SvgPreviewContent } from "@/previewPaneImageContent.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { WORKSPACE_FILE_ADD_TO_CHAT_EVENT } from "@/lib/workspaceFileDrag.js";
import { downloadImagePreview } from "@/components/ai-elements/image-preview-dialog.js";
import { toast } from "@/components/ui/toast.js";

vi.mock("@/components/ai-elements/image-preview-dialog.js", () => ({
  downloadImagePreview: vi.fn(),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const reference = {
  type: "file" as const,
  name: "image.png",
  path: "/project/image.png",
  relativePath: "image.png",
  workspacePath: "/project",
  workspaceIdentity: "ssh://host/project",
};

function setup(fileReference: typeof reference | null = reference) {
  const result = render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ImagePreviewContent, {
        title: "image.png",
        imageSource: "data:image/png,test",
        sourcePath: "/project/image.png",
        fileReference: fileReference ?? undefined,
      }),
    ),
  );
  const image = result.getByRole("img") as HTMLImageElement;
  Object.defineProperties(image, {
    naturalWidth: { value: 64 },
    naturalHeight: { value: 48 },
    complete: { value: true },
  });
  fireEvent.load(image);
  const open = () =>
    fireEvent.contextMenu(result.container.querySelector("[data-image-preview]")!, {
      clientX: 20,
      clientY: 20,
    });
  return { ...result, open };
}

describe("image preview actions", () => {
  it("offers three actions and passes the full workspace reference to the existing composer event", async () => {
    const received: unknown[] = [];
    const handler = (event: Event) => {
      received.push((event as CustomEvent).detail);
      event.preventDefault();
    };
    window.addEventListener(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, handler);
    try {
      const view = setup();
      view.open();
      expect(view.getByRole("menuitem", { name: "复制图片" })).toBeDefined();
      expect(view.getByRole("menuitem", { name: "下载图片" })).toBeDefined();
      fireEvent.click(view.getByRole("menuitem", { name: "添加到聊天" }));
      await waitFor(() => expect(received).toEqual([reference]));
      expect(toast).toHaveBeenCalledWith("已添加到聊天");
    } finally {
      window.removeEventListener(WORKSPACE_FILE_ADD_TO_CHAT_EVENT, handler);
    }
  });

  it("disables add-to-chat when there is no matching source reference", () => {
    const view = setup(null);
    view.open();
    // 显式无引用时，不允许把图片 URL 或远端路径当作本地文件写入草稿。
    expect(
      view.getByRole("menuitem", { name: "添加到聊天" }).getAttribute("data-disabled"),
    ).not.toBeNull();
  });

  it("downloads through the shared image helper with the leaf filename", async () => {
    vi.mocked(downloadImagePreview).mockResolvedValue({ kind: "started" });
    const view = setup();
    view.open();
    fireEvent.click(view.getByRole("menuitem", { name: "下载图片" }));
    await waitFor(() =>
      expect(downloadImagePreview).toHaveBeenCalledWith(
        { alt: "image.png", filename: "image.png", src: "data:image/png,test" },
        undefined,
      ),
    );
    expect(toast).toHaveBeenCalledWith("图片下载已开始");
  });

  it("reports an unhandled composer reference instead of claiming it was added", async () => {
    const view = setup();
    view.open();
    fireEvent.click(view.getByRole("menuitem", { name: "添加到聊天" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("添加失败，请先打开此工作区的可编辑聊天。"),
    );
  });

  it("downloads a file SVG from its original byte source instead of rendered text", async () => {
    const source = "data:image/svg+xml;base64,PHN2Zz7pPC9zdmc+";
    const loadDownloadSource = vi.fn().mockResolvedValue(source);
    vi.mocked(downloadImagePreview).mockResolvedValue({ kind: "started" });
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(SvgPreviewContent, {
          title: "latin1.svg",
          svgContent: "<svg>replacement text</svg>",
          sourcePath: "/project/latin1.svg",
          loadDownloadSource,
        }),
      ),
    );
    const image = view.getByRole("img") as HTMLImageElement;
    Object.defineProperties(image, { naturalWidth: { value: 64 }, naturalHeight: { value: 48 } });
    fireEvent.load(image);
    expect(loadDownloadSource).not.toHaveBeenCalled();
    fireEvent.contextMenu(view.container.querySelector("[data-image-preview]")!);
    fireEvent.click(view.getByRole("menuitem", { name: "下载图片" }));
    await waitFor(() =>
      expect(downloadImagePreview).toHaveBeenCalledWith(
        { alt: "latin1.svg", filename: "latin1.svg", src: source },
        undefined,
      ),
    );
    expect(loadDownloadSource).toHaveBeenCalledOnce();
  });
});
