import { describe, expect, it, vi } from "vitest";
import {
  CoreErrorType,
  READ_PDF_EXTRACT_MAX_INPUT_BYTES,
  READ_PDF_NATIVE_MAX_INPUT_BYTES,
  createModelId,
  createModelProviderId,
  createSessionId,
  createToolCallId,
  createTurnId,
  PdfDocumentPortError,
  ReadErrorCode,
  type FileSystemPort,
  type ImageProcessorPort,
  type PdfDocumentPort,
} from "@zcode/contracts";
import { readHandler, readToolEntry } from "../src/tool/handlers/read.js";
import type { ToolExecutionContext } from "../src/tool/types.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";

const PDF_PATH = "/tmp/report.pdf";

describe("Read PDF handling", () => {
  it("returns the page summary followed by ordered prepared page images", async () => {
    const renderPages = vi.fn(async () => [
      {
        pageNumber: 2,
        data: new Uint8Array(Buffer.from("page-two")),
        mediaType: "image/jpeg" as const,
      },
      {
        pageNumber: 3,
        data: new Uint8Array(Buffer.from("page-three")),
        mediaType: "image/jpeg" as const,
      },
    ]);
    const result = await executeReadPdf(
      { file_path: PDF_PATH, pages: "2-3" },
      { supportsPdf: true, supportsImages: true },
      { renderPages },
    );

    expect(result.output).toMatchObject({
      type: "parts",
      filePath: PDF_PATH,
      numParts: 2,
      originalSize: 1_536,
      pages: [{ pageNumber: 2 }, { pageNumber: 3 }],
    });
    expect(result.modelContent).toEqual([
      { type: "text", text: `PDF pages extracted: 2 page(s) from ${PDF_PATH} (1.5KB)` },
      expect.objectContaining({
        type: "image",
        mediaType: "image/jpeg",
        dataUrl: `data:image/jpeg;base64,${Buffer.from("page-two").toString("base64")}`,
      }),
      expect.objectContaining({
        type: "image",
        mediaType: "image/jpeg",
        dataUrl: `data:image/jpeg;base64,${Buffer.from("page-three").toString("base64")}`,
      }),
    ]);
    expect(JSON.stringify(result.modelContent)).not.toMatch(
      /Page_\d+_(?:image|parse_result)|text layer/u,
    );
  });

  it("returns a unified tool error before Poppler when page images are unsupported", async () => {
    const renderPages = vi.fn();
    const result = await executeReadPdf(
      { file_path: PDF_PATH, pages: "1-2" },
      { supportsPdf: true, supportsImages: false },
      { renderPages },
    );

    expect(result.success).toBe(false);
    expect(result.output).toEqual({
      result: false,
      errorCode: ReadErrorCode.PDF_PAGES_IMAGES_UNSUPPORTED,
      message:
        "The current model supports PDF input but does not support image input; remove the pages parameter.",
    });
    expect(result.modelContent).toBe(
      "<tool_use_error>The current model supports PDF input but does not support image input; remove the pages parameter.</tool_use_error>",
    );
    expect(renderPages).not.toHaveBeenCalled();
  });

  it.each([
    ["unavailable", ReadErrorCode.PDF_CONFIGURATION_ERROR],
    ["corrupted", ReadErrorCode.PDF_INVALID],
    ["timeout", ReadErrorCode.PDF_TIMEOUT],
    ["password_protected", ReadErrorCode.PDF_PASSWORD_PROTECTED],
    ["page_out_of_range", ReadErrorCode.PDF_PAGE_OUT_OF_RANGE],
    ["permission_denied", ReadErrorCode.PDF_PERMISSION_DENIED],
    ["io_error", ReadErrorCode.PDF_IO_ERROR],
    ["process_failed", ReadErrorCode.PDF_PROCESS_FAILED],
  ] as const)("preserves the %s Poppler failure category", async (portCode, readCode) => {
    const result = await executeReadPdf(
      { file_path: PDF_PATH, pages: "1" },
      { supportsPdf: true, supportsImages: true },
      {
        renderPages: async () => {
          throw new PdfDocumentPortError(portCode, `PDF failure: ${portCode}`);
        },
      },
    );

    expect(result.output).toEqual({
      result: false,
      errorCode: readCode,
      message: `PDF failure: ${portCode}`,
    });
  });

  it("normalizes paged Poppler cancellation for the executor", async () => {
    await expect(
      executeReadPdf(
        { file_path: PDF_PATH, pages: "1" },
        { supportsPdf: true, supportsImages: true },
        {
          renderPages: async () => {
            throw new PdfDocumentPortError("cancelled", "PDF extraction cancelled");
          },
        },
      ),
    ).rejects.toMatchObject({
      message: "PDF extraction cancelled",
      type: CoreErrorType.ToolCancelled,
    });
  });

  it("reads a small PDF natively without invoking Poppler rendering", async () => {
    const getPageCount = vi.fn(async () => 2);
    const renderPages = vi.fn();
    const result = await executeReadPdf(
      { file_path: PDF_PATH },
      { supportsPdf: true, supportsImages: false },
      { getPageCount, renderPages },
    );

    expect(result.success).toBe(true);
    expect(result.modelContent).toEqual([
      { type: "text", text: `PDF file read: ${PDF_PATH} (1.5KB)` },
      expect.objectContaining({
        type: "file",
        mediaType: "application/pdf",
        dataUrl: expect.stringMatching(/^data:application\/pdf;base64,/u),
      }),
    ]);
    expect(getPageCount).toHaveBeenCalledTimes(1);
    expect(renderPages).not.toHaveBeenCalled();
  });

  it("uses the exact error for a non-regular PDF path", async () => {
    const result = await executeReadPdf(
      { file_path: PDF_PATH, pages: "1" },
      { supportsPdf: true, supportsImages: true },
      {},
      fileSystemPortWith({
        async stat(request) {
          return { path: request.path, kind: "directory", sizeBytes: 0 };
        },
      }),
    );

    expect(result.modelContent).toBe(
      `<tool_use_error>Path is not a regular file: ${PDF_PATH}</tool_use_error>`,
    );
  });

  it("uses the exact native PDF size-limit error", async () => {
    const result = await executeReadPdf(
      { file_path: PDF_PATH },
      { supportsPdf: true, supportsImages: false },
      {},
      fileSystemPortWith({
        async stat(request) {
          return {
            path: request.path,
            kind: "file",
            sizeBytes: READ_PDF_NATIVE_MAX_INPUT_BYTES + 1,
          };
        },
      }),
    );

    expect(result.modelContent).toBe(
      "<tool_use_error>PDF file exceeds maximum allowed size of 20MB.</tool_use_error>",
    );
  });

  it("uses the exact page-extraction size-limit error", async () => {
    const result = await executeReadPdf(
      { file_path: PDF_PATH, pages: "1" },
      { supportsPdf: true, supportsImages: true },
      {},
      fileSystemPortWith({
        async stat(request) {
          return {
            path: request.path,
            kind: "file",
            sizeBytes: READ_PDF_EXTRACT_MAX_INPUT_BYTES + 1,
          };
        },
      }),
    );

    expect(result.modelContent).toBe(
      "<tool_use_error>PDF file exceeds maximum allowed size for text extraction (100MB).</tool_use_error>",
    );
  });

  it("uses the exact missing-PDF-header error", async () => {
    const invalidPdf = new Uint8Array(Buffer.from("not-a-pdf"));
    const result = await executeReadPdf(
      { file_path: PDF_PATH },
      { supportsPdf: true, supportsImages: false },
      { getPageCount: async () => undefined },
      fileSystemPortWith({
        async readBinaryFile(request) {
          return {
            path: request.path,
            content: invalidPdf,
            bytesRead: invalidPdf.byteLength,
            sizeBytes: invalidPdf.byteLength,
            truncated: false,
          };
        },
        async stat(request) {
          return { path: request.path, kind: "file", sizeBytes: invalidPdf.byteLength };
        },
      }),
    );

    expect(result.modelContent).toBe(
      `<tool_use_error>File is not a valid PDF (missing %PDF- header): ${PDF_PATH}</tool_use_error>`,
    );
  });

  it("uses the fixed punctuation when requiring pages for a long PDF", async () => {
    const result = await executeReadPdf(
      { file_path: PDF_PATH },
      { supportsPdf: true, supportsImages: false },
      { getPageCount: async () => 88 },
    );

    expect(result.modelContent).toBe(
      '<tool_use_error>This PDF has 88 pages, which is too many to read at once. Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). Maximum 20 pages per request.</tool_use_error>',
    );
  });

  it("continues native PDF reading when page-count inspection is unavailable", async () => {
    const result = await executeReadPdf(
      { file_path: PDF_PATH },
      { supportsPdf: true, supportsImages: false },
      { getPageCount: async () => undefined },
    );

    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({ type: "pdf", filePath: PDF_PATH });
  });

  it("propagates native page-count cancellation while the outer signal is still live", async () => {
    await expect(
      executeReadPdf(
        { file_path: PDF_PATH },
        { supportsPdf: true, supportsImages: false },
        {
          getPageCount: async () => {
            throw new PdfDocumentPortError("cancelled", "PDF inspection cancelled");
          },
        },
      ),
    ).rejects.toMatchObject({
      message: "PDF inspection cancelled",
      type: CoreErrorType.ToolCancelled,
    });
  });

  it("propagates unexpected native page-count inspection failures", async () => {
    const inspectionError = new Error("unexpected pdfinfo adapter failure");

    await expect(
      executeReadPdf(
        { file_path: PDF_PATH },
        { supportsPdf: true, supportsImages: false },
        {
          getPageCount: async () => {
            throw inspectionError;
          },
        },
      ),
    ).rejects.toBe(inspectionError);
  });

  it("treats an undefined PDF capability in the current turn snapshot as unsupported", async () => {
    const context = contextWith({});
    context.model = createTestRuntimeModel({
      generateText: async () => ({ finishReason: "stop", text: "", usage: {} }),
      inputFormat: { supportsPdf: false },
      modelId: "turn-unknown-pdf",
    });

    const output = await readHandler({ file_path: PDF_PATH, pages: "1" }, context);
    expect(output).toMatchObject({ type: "text", filePath: PDF_PATH });
  });
});

async function executeReadPdf(
  input: unknown,
  capabilities: { supportsPdf?: boolean; supportsImages?: boolean },
  pdfPort: Partial<PdfDocumentPort>,
  fileSystem?: FileSystemPort,
) {
  const context = contextWith(pdfPort, fileSystem);
  context.model = createTestRuntimeModel({
    generateText: async () => ({ finishReason: "stop", text: "", usage: {} }),
    inputFormat: {
      supportsPdf: capabilities.supportsPdf ?? false,
      supportsImage: capabilities.supportsImages ?? false,
    },
    modelId: "pdf-model",
  });
  const output = await readHandler(input, context);
  if (isHandlerFailure(output)) {
    return {
      success: false,
      output,
      modelContent: `<tool_use_error>${output.message}</tool_use_error>`,
    };
  }
  return {
    success: true,
    output,
    modelContent: readToolEntry.formatModelContent?.(output),
  };
}

function isHandlerFailure(
  value: unknown,
): value is { result: false; errorCode: number; message: string } {
  return typeof value === "object" && value !== null && "result" in value && value.result === false;
}

function contextWith(
  pdfPort: Partial<PdfDocumentPort>,
  fileSystem: FileSystemPort = fileSystemPort(),
): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    fileSystemPort: fileSystem,
    imageProcessorPort: imageProcessorPort(),
    pdfDocumentPort: pdfPort as PdfDocumentPort,
    sessionId: createSessionId("read-pdf-context"),
    toolCallId: createToolCallId("read-pdf-context"),
    traceId: "trace-read-pdf" as never,
    turnId: createTurnId("read-pdf-context"),
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
  };
}

function fileSystemPortWith(overrides: Partial<FileSystemPort>): FileSystemPort {
  return { ...fileSystemPort(), ...overrides } as FileSystemPort;
}

function fileSystemPort(): FileSystemPort {
  const data = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(1_527)]);
  return {
    async stat(request) {
      return { path: request.path, kind: "file", sizeBytes: data.byteLength };
    },
    async readBinaryFile(request) {
      return {
        path: request.path,
        content: new Uint8Array(data),
        bytesRead: data.byteLength,
        sizeBytes: data.byteLength,
        truncated: false,
      };
    },
    async readTextFileRange(request) {
      return {
        path: request.path,
        content: data.toString("utf8"),
        encoding: "utf8" as const,
        bytesRead: data.byteLength,
        sizeBytes: data.byteLength,
        truncated: false,
        startLine: 1,
        lineCount: 1,
        totalLines: 1,
      };
    },
  } as FileSystemPort;
}

function imageProcessorPort(): ImageProcessorPort {
  return {
    async prepareForModel(request) {
      return {
        data: request.data,
        mediaType: request.mediaType,
        originalSizeBytes: request.data.byteLength,
        transformedSizeBytes: request.data.byteLength,
        resized: false,
        compressed: false,
        strategy: "original" as const,
      };
    },
  };
}
