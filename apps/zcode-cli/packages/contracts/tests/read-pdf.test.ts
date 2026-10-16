import { describe, expect, it } from "vitest";
import {
  READ_PDF_MAX_PAGES_PER_REQUEST,
  READ_PDF_PAGES_DESCRIPTION,
  ReadInputJsonSchema,
  ReadInputSchema,
  ReadPdfInputJsonSchema,
  getReadPdfPagesValidationFailure,
  parseReadPdfPageRange,
} from "../src/tools/read.js";

describe("Read PDF contract", () => {
  it("keeps pages out of the legacy Read schema and exposes the exact PDF schema field", () => {
    expect(ReadInputJsonSchema.properties).not.toHaveProperty("pages");
    expect(ReadPdfInputJsonSchema.properties).toMatchObject({
      pages: {
        description: READ_PDF_PAGES_DESCRIPTION,
        type: "string",
      },
    });
    expect(READ_PDF_PAGES_DESCRIPTION).toBe(
      'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request.',
    );
  });

  it("parses PDF page syntax and rejects invalid or over-wide ranges", () => {
    expect(parseReadPdfPageRange("3")).toEqual({ firstPage: 3, lastPage: 3 });
    expect(parseReadPdfPageRange("2-5")).toEqual({ firstPage: 2, lastPage: 5 });
    expect(parseReadPdfPageRange("10-")).toEqual({ firstPage: 10, lastPage: Infinity });
    expect(parseReadPdfPageRange("0")).toBeUndefined();
    expect(parseReadPdfPageRange("5-4")).toBeUndefined();

    expect(ReadInputSchema.safeParse({ file_path: "/tmp/report.pdf", pages: "1-20" }).success).toBe(
      true,
    );
    const tooWide = ReadInputSchema.safeParse({
      file_path: "/tmp/report.pdf",
      pages: `1-${READ_PDF_MAX_PAGES_PER_REQUEST + 1}`,
    });
    expect(tooWide.success).toBe(false);
    expect(tooWide.error?.issues[0]?.message).toBe(
      'Page range "1-21" exceeds maximum of 20 pages per request. Please use a smaller range.',
    );
    expect(
      ReadInputSchema.safeParse({ file_path: "/tmp/report.pdf", pages: "10-" }).error?.issues[0]
        ?.message,
    ).toBe('Page range "10-" exceeds maximum of 20 pages per request. Please use a smaller range.');
  });

  it("does not apply PDF page validation to non-PDF compatibility calls", () => {
    expect(
      ReadInputSchema.safeParse({ file_path: "/tmp/notes.txt", pages: "not-a-range" }).success,
    ).toBe(true);
  });

  it("returns the exact validation messages and error codes for PDF pages", () => {
    expect(getReadPdfPagesValidationFailure("/tmp/report.pdf", "invalid")).toEqual({
      errorCode: 7,
      message:
        'Invalid pages parameter: "invalid". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.',
    });
    expect(getReadPdfPagesValidationFailure("/tmp/report.pdf", "1-21")).toEqual({
      errorCode: 8,
      message:
        'Page range "1-21" exceeds maximum of 20 pages per request. Please use a smaller range.',
    });
    expect(getReadPdfPagesValidationFailure("/tmp/notes.txt", "invalid")).toBeUndefined();
  });
});
