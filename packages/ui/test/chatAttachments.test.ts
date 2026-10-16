import { describe, expect, it, vi } from "vitest";
import { VIDEO_INPUT_MAX_BYTES } from "@zcode/shared";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import {
  MissingInlineImageContentError,
  OversizedInlineImageAttachmentError,
  OversizedInlinePdfAttachmentError,
  OversizedInlineVideoAttachmentError,
  countClipboardTextLines,
  createClipboardTextComposerAttachment,
  createClipboardTextPathComposerAttachment,
  createChatComposerAttachment,
  createChatComposerPathAttachment,
  restoreChatComposerAttachment,
  serializeChatComposerAttachment,
  shouldCreateClipboardTextAttachment,
  shouldPreferSpreadsheetClipboardText,
} from "../src/lib/chatAttachments.js";

class TestFileReader {
  result: string | ArrayBuffer | null = null;
  error: Error | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(file: File) {
    void file.arrayBuffer().then(
      (buffer) => {
        const bytes = Buffer.from(buffer);
        this.result = `data:${file.type};base64,${bytes.toString("base64")}`;
        this.onload?.();
      },
      (error: unknown) => {
        this.error = error instanceof Error ? error : new Error(String(error));
        this.onerror?.();
      },
    );
  }
}

vi.stubGlobal("FileReader", TestFileReader);

const OVERSIZED_INLINE_IMAGE_BASE64 = "A".repeat(Math.ceil(((20 * 1024 * 1024 + 1) * 4) / 3));
const OVERSIZED_INLINE_VIDEO_BASE64 = "A".repeat(Math.ceil(((VIDEO_INPUT_MAX_BYTES + 1) * 4) / 3));
const OVERSIZED_INLINE_PDF_BASE64 = "A".repeat(
  Math.ceil(((PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1) * 4) / 3),
);

describe("serializeChatComposerAttachment", () => {
  it("keeps deferred text source metadata in Web file serialization", async () => {
    const file = createClipboardTextComposerAttachment("original text");
    expect(
      await serializeChatComposerAttachment({
        ...file,
        sourceKind: "topic-history",
        messageCount: 2,
      }),
    ).toMatchObject({ sourceKind: "topic-history", messageCount: 2, textContent: "original text" });
  });
  it("文本文件会作为普通 file 附件序列化，并保留可读内容", async () => {
    const file = new File(["hello zcode"], "notes.txt", {
      type: "text/plain",
    });

    const attachment = await serializeChatComposerAttachment(createChatComposerAttachment(file));

    expect(attachment).toMatchObject({
      kind: "file",
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: file.size,
      textContent: "hello zcode",
    });
    expect(attachment.dataBase64).toBeUndefined();
  });

  it("本地 PDF 路径只序列化路径，并保留 PDF attachment kind", async () => {
    const attachment = await serializeChatComposerAttachment(
      createChatComposerPathAttachment("/tmp/report.pdf"),
    );

    expect(attachment).toEqual({
      kind: "pdf",
      filename: "report.pdf",
      localPath: "/tmp/report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 0,
    });
  });

  it("无路径 PDF 使用 dataBase64 序列化，并可从草稿恢复", async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
    const file = new File([bytes], "report.pdf", { type: "application/pdf; charset=binary" });
    const serialized = await serializeChatComposerAttachment(createChatComposerAttachment(file));

    expect(serialized).toEqual({
      kind: "pdf",
      filename: "report.pdf",
      mimeType: "application/pdf",
      dataBase64: Buffer.from(bytes).toString("base64"),
      sizeBytes: bytes.byteLength,
    });
    expect(restoreChatComposerAttachment(serialized)).toMatchObject({
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
    });
  });

  it("Web PDF 超过 V4 上限时在 base64 编码前抛结构化错误", async () => {
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "large.pdf", {
      type: "application/pdf",
    });
    const attachment = createChatComposerAttachment(file);
    Object.defineProperty(attachment, "sizeBytes", {
      value: PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1,
    });
    const readAsDataUrl = vi.spyOn(TestFileReader.prototype, "readAsDataURL");

    try {
      await expect(serializeChatComposerAttachment(attachment)).rejects.toMatchObject({
        filename: "large.pdf",
        maxSizeBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
        name: "OversizedInlinePdfAttachmentError",
      });
      expect(readAsDataUrl).not.toHaveBeenCalled();
    } finally {
      readAsDataUrl.mockRestore();
    }
  });

  it("带本地路径的拖拽普通文件只序列化路径引用", async () => {
    const file = new File(["hello zcode"], "notes.txt", {
      type: "text/plain",
    });

    const attachment = await serializeChatComposerAttachment(
      createChatComposerAttachment(file, "/tmp/notes.txt"),
    );

    expect(attachment).toEqual({
      kind: "file",
      filename: "notes.txt",
      localPath: "/tmp/notes.txt",
      mimeType: "text/plain",
      sizeBytes: file.size,
    });
  });

  it("图片仍保持 ZCode Agent image 附件格式", async () => {
    const file = new File(["png-bytes"], "image.png", {
      type: "image/png",
    });

    await expect(
      serializeChatComposerAttachment({
        ...createChatComposerAttachment(file),
        id: "attachment-2",
      }),
    ).resolves.toEqual({
      kind: "image",
      filename: "image.png",
      mimeType: "image/png",
      dataBase64: "cG5nLWJ5dGVz",
      sizeBytes: file.size,
    });
  });

  it("无本地路径的大图片会在发送前拦截，避免 base64 payload 过大", async () => {
    const file = new File(["png-bytes"], "large.png", {
      type: "image/png",
    });

    await expect(
      serializeChatComposerAttachment({
        ...createChatComposerAttachment(file),
        sizeBytes: 21 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({
      filename: "large.png",
      maxSizeBytes: 20 * 1024 * 1024,
      name: "OversizedInlineImageAttachmentError",
      sizeBytes: 21 * 1024 * 1024,
    });
    await expect(
      serializeChatComposerAttachment({
        ...createChatComposerAttachment(file),
        sizeBytes: 21 * 1024 * 1024,
      }),
    ).rejects.toBeInstanceOf(OversizedInlineImageAttachmentError);
  });

  it("带本地路径的大图片只序列化路径引用", async () => {
    const file = new File(["png-bytes"], "large.png", {
      type: "image/png",
    });

    await expect(
      serializeChatComposerAttachment({
        ...createChatComposerAttachment(file, "/tmp/large.png"),
        sizeBytes: 21 * 1024 * 1024,
      }),
    ).resolves.toEqual({
      kind: "image",
      filename: "large.png",
      localPath: "/tmp/large.png",
      mimeType: "image/png",
      sizeBytes: 21 * 1024 * 1024,
    });
  });

  it("恢复无本地路径的大图片时会在 base64 解码前拦截", () => {
    expect(() =>
      restoreChatComposerAttachment({
        dataBase64: "A",
        filename: "large.png",
        kind: "image",
        mimeType: "image/png",
        sizeBytes: 21 * 1024 * 1024,
      }),
    ).toThrow(OversizedInlineImageAttachmentError);
  });

  it("恢复无本地路径的超大 PDF 时会在 base64 解码前拦截", () => {
    expect(() =>
      restoreChatComposerAttachment({
        dataBase64: OVERSIZED_INLINE_PDF_BASE64,
        filename: "large.pdf",
        kind: "pdf",
        mimeType: "application/pdf",
      }),
    ).toThrow(OversizedInlinePdfAttachmentError);
  });

  it("恢复缺少 sizeBytes 的超大 base64 图片时会在解码前拦截", () => {
    expect(() =>
      restoreChatComposerAttachment({
        dataBase64: OVERSIZED_INLINE_IMAGE_BASE64,
        filename: "legacy-large.png",
        kind: "image",
        mimeType: "image/png",
      }),
    ).toThrow(OversizedInlineImageAttachmentError);
  });

  it("恢复 sizeBytes 偏小但 base64 超限的图片时会按实际长度拦截", () => {
    expect(() =>
      restoreChatComposerAttachment({
        dataBase64: OVERSIZED_INLINE_IMAGE_BASE64,
        filename: "mismatched-large.png",
        kind: "image",
        mimeType: "image/png",
        sizeBytes: 1,
      }),
    ).toThrow(OversizedInlineImageAttachmentError);
  });

  it("恢复带本地路径且 base64 超限的图片时跳过解码并保留路径引用", () => {
    const atobSpy = vi.spyOn(globalThis, "atob");

    try {
      expect(
        restoreChatComposerAttachment({
          dataBase64: OVERSIZED_INLINE_IMAGE_BASE64,
          filename: "path-large.png",
          kind: "image",
          localPath: "/tmp/path-large.png",
          mimeType: "image/png",
          sizeBytes: 1,
        }),
      ).toMatchObject({
        filename: "path-large.png",
        localPath: "/tmp/path-large.png",
        mimeType: "image/png",
        sizeBytes: 20 * 1024 * 1024 + 1,
      });
      expect(atobSpy).not.toHaveBeenCalled();
    } finally {
      atobSpy.mockRestore();
    }
  });

  it("恢复无本地路径且无 base64 的小图片时会结构化拒绝", () => {
    expect(() =>
      restoreChatComposerAttachment({
        filename: "metadata-only.png",
        kind: "image",
        mimeType: "image/png",
        sizeBytes: 1,
      }),
    ).toThrow(MissingInlineImageContentError);
  });

  it("恢复无本地路径且无 base64 的超大图片时保留发送前拦截状态", () => {
    expect(
      restoreChatComposerAttachment({
        filename: "metadata-only-large.png",
        kind: "image",
        mimeType: "image/png",
        sizeBytes: 21 * 1024 * 1024,
      }),
    ).toMatchObject({
      filename: "metadata-only-large.png",
      mimeType: "image/png",
      sizeBytes: 21 * 1024 * 1024,
    });
  });
});

describe("clipboard text attachments", () => {
  it("Excel HTML 或制表符文本优先于同 payload 的合成图片", () => {
    expect(shouldPreferSpreadsheetClipboardText("A\tB\n1\t2", "")).toBe(true);
    expect(
      shouldPreferSpreadsheetClipboardText(
        "单个单元格",
        '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><meta name=ProgId content=Excel.Sheet>',
      ),
    ).toBe(true);
    expect(
      shouldPreferSpreadsheetClipboardText("Numbers 单元格", "<table><tr><td>x</td></tr></table>"),
    ).toBe(true);
    expect(shouldPreferSpreadsheetClipboardText("https://example.com/image.png", "<img>")).toBe(
      false,
    );
    expect(shouldPreferSpreadsheetClipboardText("", "Excel.Sheet")).toBe(false);
  });

  it("剪贴板文本大于等于 15360 字符时转为附件", () => {
    expect(shouldCreateClipboardTextAttachment("a".repeat(15_359))).toBe(false);
    expect(shouldCreateClipboardTextAttachment("a".repeat(15_360))).toBe(true);
  });

  it("转附件不再依赖行数", () => {
    const manyShortLines = Array.from({ length: 100 }, () => "x").join("\n");
    const singleLongLine = "x".repeat(15_360);

    expect(countClipboardTextLines(manyShortLines)).toBe(100);
    expect(shouldCreateClipboardTextAttachment(manyShortLines)).toBe(false);
    expect(countClipboardTextLines(singleLongLine)).toBe(1);
    expect(shouldCreateClipboardTextAttachment(singleLongLine)).toBe(true);
  });

  it("兼容 CRLF 和 CR 换行计数", () => {
    expect(countClipboardTextLines("a\r\nb\rc\nd")).toBe(4);
  });

  it("创建带 clipboard-text 元数据的文本附件", async () => {
    const text = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join("\n");

    const attachment = createClipboardTextComposerAttachment(text, {
      now: new Date("2026-06-27T15:30:12"),
    });

    expect(attachment).toMatchObject({
      filename: "pasted-text-20260627-153012.txt",
      mimeType: "text/plain",
      sourceKind: "clipboard-text",
      lineCount: 15,
      charCount: text.length,
    });
    await expect(attachment.file?.text()).resolves.toBe(text);
  });

  it("落盘后的粘贴文本附件只序列化 localPath，不内联 textContent", async () => {
    const text = "x".repeat(15_360);
    const attachment = await serializeChatComposerAttachment(
      createClipboardTextPathComposerAttachment(text, {
        filename: "pasted-text-20260630-104512-a1b2c3.txt",
        localPath: "/Users/test/.zcode/tmp/paste-attachments/2026-06-30/pasted-text.txt",
        mimeType: "text/plain",
        sizeBytes: Buffer.byteLength(text, "utf8"),
      }),
    );

    expect(attachment).toEqual({
      kind: "file",
      filename: "pasted-text-20260630-104512-a1b2c3.txt",
      localPath: "/Users/test/.zcode/tmp/paste-attachments/2026-06-30/pasted-text.txt",
      mimeType: "text/plain",
      sourceKind: "clipboard-text",
      sizeBytes: 15_360,
    });
  });
});

describe("video attachments", () => {
  it("使用 30MiB 全局 video 输入上限", () => {
    expect(VIDEO_INPUT_MAX_BYTES).toBe(30 * 1024 * 1024);
  });

  it("无 localPath 的视频走 dataBase64 序列化为 kind video", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "demo.mp4", {
      type: "video/mp4",
    });

    const attachment = await serializeChatComposerAttachment(createChatComposerAttachment(file));

    expect(attachment).toMatchObject({
      kind: "video",
      filename: "demo.mp4",
      mimeType: "video/mp4",
      sizeBytes: file.size,
    });
    expect(attachment.dataBase64).toEqual(Buffer.from([1, 2, 3, 4]).toString("base64"));
  });

  it("有 localPath 的视频只序列化路径引用（零拷贝）", async () => {
    const file = new File([new Uint8Array([9, 9])], "clip.mov", {
      type: "video/quicktime",
    });

    const attachment = await serializeChatComposerAttachment(
      createChatComposerAttachment(file, "/tmp/clip.mov"),
    );

    expect(attachment).toEqual({
      kind: "video",
      filename: "clip.mov",
      localPath: "/tmp/clip.mov",
      mimeType: "video/quicktime",
      sizeBytes: file.size,
    });
  });

  it("Web 无路径视频超过 V4 上限时在 base64 编码前抛结构化错误", async () => {
    const file = new File([new Uint8Array(4)], "big.mp4", { type: "video/mp4" });
    const attachment = createChatComposerAttachment(file);
    Object.defineProperty(attachment, "sizeBytes", {
      value: PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1,
    });
    const readAsDataUrl = vi.spyOn(TestFileReader.prototype, "readAsDataURL");

    try {
      await expect(serializeChatComposerAttachment(attachment)).rejects.toMatchObject({
        filename: "big.mp4",
        maxSizeBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
        name: "OversizedInlineVideoAttachmentError",
        sizeBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1,
      });
      expect(readAsDataUrl).not.toHaveBeenCalled();
    } finally {
      readAsDataUrl.mockRestore();
    }
  });

  it("restore 恢复 video dataBase64 附件并生成可预览 objectUrl", () => {
    const attachment = restoreChatComposerAttachment({
      kind: "video",
      filename: "demo.mp4",
      mimeType: "video/mp4",
      dataBase64: Buffer.from([5, 6, 7]).toString("base64"),
      sizeBytes: 3,
    });

    expect(attachment.mimeType).toBe("video/mp4");
    expect(attachment.sizeBytes).toBeGreaterThanOrEqual(3);
    expect(attachment.objectUrl).toBeDefined();
  });

  it.each([
    ["缺少", undefined],
    ["低报", 1],
  ])("restore 会在解码前拦截 sizeBytes %s的超限视频", (_label, sizeBytes) => {
    const atobSpy = vi.spyOn(globalThis, "atob");

    try {
      expect(() =>
        restoreChatComposerAttachment({
          kind: "video",
          filename: "oversized.mp4",
          mimeType: "video/mp4",
          dataBase64: OVERSIZED_INLINE_VIDEO_BASE64,
          ...(sizeBytes === undefined ? {} : { sizeBytes }),
        }),
      ).toThrow(OversizedInlineVideoAttachmentError);
      expect(atobSpy).not.toHaveBeenCalled();
    } finally {
      atobSpy.mockRestore();
    }
  });

  it("video 扩展名在无浏览器 mime 时按文件名推断", () => {
    const attachment = createChatComposerAttachment(
      new File([new Uint8Array(1)], "a.MOV", { type: "" }),
    );
    expect(attachment.mimeType).toBe("video/quicktime");
  });
});
