import { describe, expect, it } from "vitest";
import {
  assertPptxPreviewDataComplete,
  isPptxPreviewIncompleteFileError,
  readPptxPreviewData,
} from "@/lib/pptxPreviewData.js";

describe("PPTX preview data loading", () => {
  it("does not return a truncated buffer to the parser", async () => {
    const reads: Array<{ offset: number; length: number }> = [];

    await expect(
      readPptxPreviewData({
        fileSize: 3,
        readRange: async (offset, length) => {
          reads.push({ offset, length });
          return offset === 0 ? new Uint8Array([1, 2]) : new Uint8Array(0);
        },
        isDisposed: () => false,
      }),
    ).rejects.toMatchObject({
      code: "PPTX_PREVIEW_INCOMPLETE_FILE",
      expectedBytes: 3,
      actualBytes: 2,
    });
    expect(reads).toEqual([
      { offset: 0, length: 3 },
      { offset: 2, length: 1 },
    ]);
  });

  it("returns all bytes when every range is available", async () => {
    await expect(
      readPptxPreviewData({
        fileSize: 3,
        readRange: async (offset) =>
          offset === 0 ? new Uint8Array([1, 2]) : new Uint8Array([3]),
        isDisposed: () => false,
      }),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer);
  });

  it("stops requesting ranges after the source is disposed", async () => {
    let disposed = false;
    let readCount = 0;

    await expect(
      readPptxPreviewData({
        fileSize: 4,
        readRange: async () => {
          readCount += 1;
          disposed = true;
          return new Uint8Array([1, 2]);
        },
        isDisposed: () => disposed,
      }),
    ).resolves.toBeNull();
    expect(readCount).toBe(1);
  });

  it("rejects data when the file size changes during the read", () => {
    expect(() =>
      assertPptxPreviewDataComplete({
        expectedBytes: 3,
        actualBytes: 3,
        observedFileSize: 4,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "PPTX_PREVIEW_INCOMPLETE_FILE",
        expectedBytes: 3,
        actualBytes: 3,
        observedFileSize: 4,
      }),
    );
  });

  it("recognizes structured incomplete-file errors", () => {
    expect(
      isPptxPreviewIncompleteFileError(
        new Error("PPTX preview read was incomplete: expected 3 bytes, received 2"),
      ),
    ).toBe(false);
    expect(isPptxPreviewIncompleteFileError({ code: "PPTX_PREVIEW_INCOMPLETE_FILE" })).toBe(true);
  });
});
