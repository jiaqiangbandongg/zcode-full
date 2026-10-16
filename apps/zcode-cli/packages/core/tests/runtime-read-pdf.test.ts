import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createSessionId,
  type FileSystemPort,
  type ImageProcessorPort,
  type ModelRequest,
  type PdfDocumentPort,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const WORKSPACE_PATH = join(tmpdir(), "zcode-runtime-read-pdf");
const PDF_PATH = join(WORKSPACE_PATH, "report.pdf");
const PDF_CONTENT = new Uint8Array(Buffer.from("%PDF-1.7\nfixture"));
const TOOL_CALL_ID = "read-pdf";

describe.each(["interactive", "subagent_child"] as const)(
  "AgentRuntime PDF dependency wiring (%s)",
  (taskType) => {
    it("returns rendered page images to the model through the injected PDF port", async () => {
      const renderPages = vi.fn<PdfDocumentPort["renderPages"]>(async () =>
        [2, 3].map((pageNumber) => ({
          pageNumber,
          data: new Uint8Array(Buffer.from(`page-${pageNumber}`)),
          mediaType: "image/jpeg",
        })),
      );
      const getPageCount = vi.fn<PdfDocumentPort["getPageCount"]>();
      const { requests, readBinaryFile } = await executePdfRead(taskType, {
        pages: "2-3",
        pdfDocumentPort: { getPageCount, renderPages },
      });

      expect(renderPages).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ filePath: PDF_PATH, firstPage: 2, lastPage: 3 }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(getPageCount).not.toHaveBeenCalled();
      expect(readBinaryFile).not.toHaveBeenCalled();
      const toolResult = requests[1]?.messages.find(
        (message) => message.role === "tool" && message.toolCallId === TOOL_CALL_ID,
      );
      expect(toolResult).toMatchObject({ role: "tool", toolName: "Read", isError: false });
      expect(toolResult?.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("PDF pages extracted: 2 page(s)"),
        }),
        ...[2, 3].map((pageNumber) =>
          expect.objectContaining({
            type: "image",
            mediaType: "image/jpeg",
            dataUrl: `data:image/jpeg;base64,${Buffer.from(`page-${pageNumber}`).toString("base64")}`,
          }),
        ),
      ]);
    });

    it("checks the page count before sending a whole PDF to the model", async () => {
      const getPageCount = vi.fn<PdfDocumentPort["getPageCount"]>(async () => 11);
      const renderPages = vi.fn<PdfDocumentPort["renderPages"]>();
      const { requests, readBinaryFile } = await executePdfRead(taskType, {
        pdfDocumentPort: { getPageCount, renderPages },
      });

      expect(getPageCount).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ filePath: PDF_PATH }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(renderPages).not.toHaveBeenCalled();
      expect(readBinaryFile).not.toHaveBeenCalled();
      expect(
        requests[1]?.messages.find(
          (message) => message.role === "tool" && message.toolCallId === TOOL_CALL_ID,
        ),
      ).toMatchObject({
        isError: true,
        content: expect.stringContaining(
          "This PDF has 11 pages, which is too many to read at once",
        ),
      });
    });
  },
);

async function executePdfRead(
  taskType: "interactive" | "subagent_child",
  options: { pages?: string; pdfDocumentPort: PdfDocumentPort },
) {
  const requests: ModelRequest[] = [];
  const readBinaryFile = vi.fn<FileSystemPort["readBinaryFile"]>(async (request) => ({
    path: request.path,
    content: PDF_CONTENT,
    bytesRead: PDF_CONTENT.byteLength,
    sizeBytes: PDF_CONTENT.byteLength,
  }));
  const fileSystemPort = {
    stat: vi.fn<FileSystemPort["stat"]>(async (request) => ({
      path: request.path,
      kind: "file",
      sizeBytes: PDF_CONTENT.byteLength,
    })),
    readBinaryFile,
  } as unknown as FileSystemPort;
  const imageProcessorPort: ImageProcessorPort = {
    resizeToFit: vi.fn<ImageProcessorPort["resizeToFit"]>(),
    async prepareForModel(request) {
      return {
        data: request.data,
        mediaType: request.mediaType,
        originalSizeBytes: request.data.byteLength,
        transformedSizeBytes: request.data.byteLength,
        resized: false,
        compressed: false,
        strategy: "original",
      };
    },
  };
  const runtime = createTestAgentRuntime(
    createSessionId(`runtime-read-pdf-${taskType}`),
    {
      taskType,
      mode: "build",
      modelStreaming: "off",
      workingDirectory: WORKSPACE_PATH,
      memory: { enabled: false },
      compact: { enabled: false },
    },
    {
      eventStore: createTestSessionEventStore(),
      fileSystemPort,
      imageProcessorPort,
      pdfDocumentPort: options.pdfDocumentPort,
      modelFactory: createTestModelFactory({
        async generateText(request) {
          requests.push(request);
          return requests.length === 1
            ? {
                finishReason: "tool-calls",
                text: "",
                toolCalls: [
                  {
                    id: TOOL_CALL_ID,
                    name: "Read",
                    input: {
                      file_path: PDF_PATH,
                      ...(options.pages === undefined ? {} : { pages: options.pages }),
                    },
                  },
                ],
                usage: {},
              }
            : { finishReason: "stop", text: "done", usage: {} };
        },
      }),
    },
  );

  await runtime.executeTurn("Read the PDF");
  expect(requests).toHaveLength(2);
  return { requests, readBinaryFile };
}
