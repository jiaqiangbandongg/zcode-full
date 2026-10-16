// @vitest-environment jsdom
import { createElement } from "react";
import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampMarkdownImagePreviewOffset,
  MarkdownImage,
  normalizeConsecutiveMarkdownImageBlocks,
} from "@/components/ai-elements/markdown-image.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { rewriteMarkdownArtifactImageSources } from "@zcode/shared";
import { sanitizeImageSourceForLog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  imageThumbnailClassName,
  imageThumbnailTriggerClassName,
} from "@/components/ai-elements/image-thumbnail-gallery.js";

afterEach(() => vi.restoreAllMocks());

describe("artifact-backed Markdown images", () => {
  it("reads an authorized session artifact instead of passing its custom URI to img", async () => {
    const ref = "zcode-artifact://session-1/cua-shot";
    const rewritten = rewriteMarkdownArtifactImageSources(`![shot](${ref})`);
    const src = rewritten.match(/!\[shot\]\(([^)]+)\)/u)?.[1] ?? "";
    const readAttachment = vi.fn().mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:cua-shot");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const rendered = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(MarkdownImage, {
          alt: "shot",
          src,
          sessionId: "session-1",
          readAttachment,
        }),
      ),
    );

    await waitFor(() =>
      expect(rendered.container.querySelector("img")?.getAttribute("src")).toBe("blob:cua-shot"),
    );
    expect(readAttachment).toHaveBeenCalledWith({ sessionId: "session-1", ref });
    expect(rendered.container.innerHTML).not.toContain("zcode-artifact://");
    rendered.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:cua-shot");
  });
});

describe("shared image thumbnail styles", () => {
  it("单图使用半宽、高度上限和 xl 圆角", () => {
    expect(imageThumbnailTriggerClassName).toContain("max-w-1/2");
    expect(imageThumbnailClassName).toContain("max-h-90");
    expect(imageThumbnailClassName).toContain("rounded-xl");
    expect(imageThumbnailClassName).toContain("object-cover");
  });
});

describe("sanitizeImageSourceForLog", () => {
  it("清除远程图片 URL 的身份、签名参数和 fragment", () => {
    const sanitized = sanitizeImageSourceForLog(
      "https://user:pass@example.com/a.png?token=secret#fragment",
    );
    expect(sanitized).toBe("https://example.com/a.png");
    expect(sanitized).not.toMatch(/user|pass|token|secret|fragment/u);
  });

  it("不把 Base64 图片内容写入日志", () => {
    expect(sanitizeImageSourceForLog("data:image/png;base64,SECRET")).toBe("data-url");
  });
});

describe("normalizeConsecutiveMarkdownImageBlocks", () => {
  it("只移除连续纯图片块之间的空行", () => {
    expect(
      normalizeConsecutiveMarkdownImageBlocks(
        "intro\n\n![one](one.png)\n\n![two](two.png)\n\ncaption",
      ),
    ).toBe("intro\n\n![one](one.png)\n![two](two.png)\n\ncaption");
  });

  it("不改写代码围栏中的图片语法", () => {
    const markdown = "```md\n![one](one.png)\n\n![two](two.png)\n```";
    expect(normalizeConsecutiveMarkdownImageBlocks(markdown)).toBe(markdown);
  });

  it.each([
    ["四反引号不会被三个反引号关闭", "````md\n```\n![one](one.png)\n\n![two](two.png)\n````"],
    ["四波浪号不会被三个波浪号关闭", "~~~~md\n~~~\n![one](one.png)\n\n![two](two.png)\n~~~~"],
    ["未闭合围栏保持到文末", "```md\n![one](one.png)\n\n![two](two.png)"],
    ["带 info string 的 opening fence", "````markdown\n![one](one.png)\n\n![two](two.png)\n````"],
  ])("%s", (_name, markdown) => {
    expect(normalizeConsecutiveMarkdownImageBlocks(markdown)).toBe(markdown);
  });
});

describe("clampMarkdownImagePreviewOffset", () => {
  it("图片未超出画布时保持居中", () => {
    expect(
      clampMarkdownImagePreviewOffset(
        { x: 80, y: -60 },
        1,
        { width: 400, height: 300 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ x: 0, y: 0 });
  });

  it("图片放大后限制拖拽边界", () => {
    expect(
      clampMarkdownImagePreviewOffset(
        { x: 500, y: -500 },
        2,
        { width: 600, height: 400 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ x: 200, y: -100 });
  });
});
