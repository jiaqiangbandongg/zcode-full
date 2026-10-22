import { afterEach, describe, expect, it, vi } from "vitest";
import { copyPreviewImage, getImagePreviewPixelRatio } from "@/previewPaneImageContent.js";

describe("ImagePreviewContent", () => {
  it("detects retina pixel ratios from image file names", () => {
    expect(getImagePreviewPixelRatio("/tmp/logo@2x.png")).toBe(2);
    expect(getImagePreviewPixelRatio("icon@3x.webp")).toBe(3);
    expect(getImagePreviewPixelRatio("asset@1.5x.avif")).toBe(1.5);
    expect(getImagePreviewPixelRatio("/tmp/@2x/logo.png")).toBe(1);
    expect(getImagePreviewPixelRatio("logo@0x.png")).toBe(1);
    expect(getImagePreviewPixelRatio("logo@2x.backup.png")).toBe(1);
  });
});

describe("copyPreviewImage", () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    const blob = new Blob(["png"], { type: "image/png" });
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toBlob: (callback: (value: Blob | null) => void) => callback(blob),
    };
    const write = vi.fn(async (items: { data: Record<string, Promise<Blob>> }[]) => {
      await items[0]!.data["image/png"];
    });
    vi.stubGlobal("document", { createElement: () => canvas });
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(public data: Record<string, Promise<Blob>>) {}
      },
    );
    const image = { complete: true, naturalWidth: 640, naturalHeight: 480 } as HTMLImageElement;
    return { blob, canvas, drawImage, image, write };
  }

  it("writes PNG at natural resolution and submits before asynchronous conversion finishes", async () => {
    const { canvas, drawImage, image, write, blob } = setup();
    let finish!: (value: Blob) => void;
    canvas.toBlob = (callback) => {
      finish = callback;
    };
    const result = copyPreviewImage(image);
    expect(write).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(480);
    expect(drawImage).toHaveBeenCalledWith(image, 0, 0);
    finish(blob);
    await result;
  });

  it("rejects images that have not loaded without writing to the clipboard", async () => {
    const { image, write } = setup();
    await expect(
      copyPreviewImage({ ...image, complete: false } as HTMLImageElement),
    ).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  it("reports conversion failure instead of pretending the image was copied", async () => {
    const { canvas, image } = setup();
    canvas.toBlob = (callback) => callback(null);
    await expect(copyPreviewImage(image)).rejects.toThrow();
  });

  it("propagates clipboard denial and unsupported environments", async () => {
    const { image, write } = setup();
    write.mockRejectedValueOnce(new Error("NotAllowedError"));
    await expect(copyPreviewImage(image)).rejects.toThrow("NotAllowedError");
    vi.stubGlobal("navigator", {});
    await expect(copyPreviewImage(image)).rejects.toThrow();
  });
});
