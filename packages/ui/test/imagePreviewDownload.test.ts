import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadImagePreview } from "@/components/ai-elements/image-preview-dialog.js";

afterEach(() => vi.unstubAllGlobals());

describe("image preview download", () => {
  it.each([
    ["image/png", "png"],
    ["image/jpeg", "jpg"],
    ["image/webp", "webp"],
    ["image/apng", "apng"],
    ["image/avif", "avif"],
    ["image/bmp", "bmp"],
    ["image/x-ms-bmp", "bmp"],
    ["image/gif", "gif"],
    ["image/x-icon", "ico"],
    ["image/vnd.microsoft.icon", "ico"],
    ["image/svg+xml;charset=utf-8", "svg"],
  ])("keeps source bytes and extension for %s", async (type, extension) => {
    const content =
      extension === "svg" ? '<svg xmlns="http://www.w3.org/2000/svg"/>' : "image-data";
    const saveFile = vi
      .fn()
      .mockResolvedValue({ success: true, path: `/saved/drawing.${extension}` });
    const result = await downloadImagePreview(
      { alt: "drawing", src: `data:${type},${encodeURIComponent(content)}` },
      saveFile,
    );
    expect(result).toEqual({ kind: "saved", path: `/saved/drawing.${extension}` });
    const request = saveFile.mock.calls[0]![0];
    expect(request.suggestedName).toBe(`drawing.${extension}`);
    expect(new TextDecoder().decode(request.data)).toBe(content);
  });

  it.each([
    ["application/octet-stream", "photo.BMP", "photo.bmp"],
    ["application/octet-stream", "drawing.svg", "drawing.svg"],
    ["image/jpeg", "photo.jpeg", "photo.jpeg"],
    ["image/png", "wrong.bmp", "wrong.png"],
  ])("uses a compatible source extension for %s/%s", async (type, filename, expected) => {
    const saveFile = vi.fn().mockResolvedValue({ success: true, path: `/saved/${expected}` });
    await downloadImagePreview(
      { alt: "picture", filename, src: `data:${type},original` },
      saveFile,
    );
    expect(saveFile.mock.calls[0]![0].suggestedName).toBe(expected);
  });

  it("preserves non-UTF-8 SVG bytes from a binary source", async () => {
    const bytes = new Uint8Array([60, 115, 118, 103, 62, 233, 60, 47, 115, 118, 103, 62]);
    const saveFile = vi.fn().mockResolvedValue({ success: true, path: "/saved/latin1.svg" });
    await downloadImagePreview(
      {
        alt: "latin1.svg",
        src: `data:image/svg+xml;base64,${Buffer.from(bytes).toString("base64")}`,
      },
      saveFile,
    );
    expect(new Uint8Array(saveFile.mock.calls[0]![0].data)).toEqual(bytes);
    expect(saveFile.mock.calls[0]![0].suggestedName).toBe("latin1.svg");
  });

  it("keeps a trusted URL extension for native HTTP downloads", async () => {
    const saveFile = vi.fn().mockResolvedValue({ success: true, path: "/saved/photo.ico" });
    const src = "https://example.com/images/photo.ico?version=2";
    await downloadImagePreview({ alt: "photo", src }, saveFile);
    expect(saveFile).toHaveBeenCalledWith({ sourceUrl: src, suggestedName: "photo.ico" });
  });

  it("distinguishes canceled saves from failures", async () => {
    const item = { alt: "image.png", src: "data:image/png,test" };
    await expect(
      downloadImagePreview(item, vi.fn().mockResolvedValue({ success: false, canceled: true })),
    ).resolves.toEqual({ kind: "canceled" });
    await expect(
      downloadImagePreview(item, vi.fn().mockResolvedValue({ success: false, error: "disk full" })),
    ).rejects.toThrow("disk full");
  });

  it("uses the browser download with an original extension when there is no desktop save port", async () => {
    const click = vi.fn();
    const anchor = { href: "", download: "", click, remove: vi.fn() };
    vi.stubGlobal("document", { createElement: () => anchor, body: { appendChild: vi.fn() } });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image-preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    await expect(
      downloadImagePreview({
        alt: "sample.svg",
        src: "data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E",
      }),
    ).resolves.toEqual({ kind: "started" });
    expect(anchor.download).toBe("sample.svg");
    expect(click).toHaveBeenCalledOnce();
    vi.restoreAllMocks();
  });
});
