import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeExecutionAdapter } from "@zcode/adapters/exec";
import { createNodeFileSystemAdapter } from "@zcode/adapters/fs";
import { createJimpImageProcessorAdapter } from "@zcode/adapters/image";
import { AiSdkModelAdapter, AiSdkModelRegistry } from "@zcode/adapters/model";
import { createPopplerPdfDocumentAdapter } from "@zcode/adapters/pdf";
import {
  createInMemorySessionEventStore,
  createNodeToolArtifactStore,
  createSqliteSessionStore,
} from "@zcode/adapters/storage";
import {
  createModelId,
  createModelProviderId,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type ImageProcessorPort,
  type PdfDocumentPort,
} from "@zcode/contracts";
import { AgentRuntime } from "@zcode/core";

const CHAT_MODEL = {
  providerId: createModelProviderId("pdf-capture"),
  modelId: createModelId("pdf-e2e"),
};
const PAGE_ONE_BYTES = new TextEncoder().encode("page-one");
const PAGE_TWO_BYTES = new TextEncoder().encode("page-two");
const popplerAvailable =
  (await commandSucceeds("pdfinfo", ["-v"])) && (await commandSucceeds("pdftoppm", ["-v"]));

describe("Read PDF provider and cold-resume E2E", () => {
  it("preserves the final Chat page order after a real runtime cold resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-read-pdf-provider-e2e-"));
    const pdfPath = join(root, "two-pages.pdf");
    const sessionId = createSessionId("read-pdf-provider-e2e");
    const databasePath = join(root, "session.sqlite");
    const capture = await startChatCaptureServer(pdfPath);
    const artifactOptions = {
      imageCacheRootDir: join(root, "image-cache"),
      rootDir: join(root, "artifacts"),
      videoCacheRootDir: join(root, "video-cache"),
    };
    const liveStore = createSqliteSessionStore({ dbPath: databasePath });
    let liveStoreClosed = false;
    let resumedStore: ReturnType<typeof createSqliteSessionStore> | undefined;
    let liveRuntime: AgentRuntime | undefined;
    let resumedRuntime: AgentRuntime | undefined;

    const createRuntime = (
      sessionStore: ReturnType<typeof createSqliteSessionStore>,
    ): AgentRuntime =>
      new AgentRuntime(
        sessionId,
        {
          mode: "yolo",
          modelInputMediaCapabilities: { supportsImages: true, supportsPdf: true },
          modelProviderOptions: { apiFormat: "openai-chat-completions" },
          modelRef: CHAT_MODEL,
          modelStreaming: "off",
          workingDirectory: root,
        },
        {
          artifactStore: createNodeToolArtifactStore(artifactOptions),
          eventStore: createInMemorySessionEventStore(),
          fileSystemPort: createNodeFileSystemAdapter(),
          imageProcessorPort: passthroughImageProcessor,
          modelAdapter: createChatModelAdapter(capture.baseURL),
          pdfDocumentPort: deterministicPdfDocument,
          sessionStore,
        },
      );

    try {
      await writeFile(pdfPath, buildTwoPagePdf());
      liveRuntime = createRuntime(liveStore);
      await liveRuntime.executeTurn(`Read pages 1-2 from ${pdfPath}`);

      expect(capture.bodies).toHaveLength(2);
      expectReadToolPagesShape(capture.bodies[0]!);
      const liveWire = expectOrderedPdfToolResult(capture.bodies[1]!);

      liveRuntime.beginShutdown();
      liveStore.close();
      liveStoreClosed = true;
      resumedStore = createSqliteSessionStore({ dbPath: databasePath });
      resumedRuntime = createRuntime(resumedStore);
      await resumedRuntime.resumeFromStore();
      await resumedRuntime.executeTurn("Continue after cold resume.");

      expect(capture.bodies).toHaveLength(3);
      const resumedWire = expectOrderedPdfToolResult(capture.bodies[2]!);
      expect(resumedWire).toEqual(liveWire);
    } finally {
      liveRuntime?.beginShutdown();
      resumedRuntime?.beginShutdown();
      if (!liveStoreClosed) liveStore.close();
      resumedStore?.close();
      await closeServer(capture.server);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe.skipIf(!popplerAvailable)("Read PDF Poppler E2E", () => {
  it("runs the runtime descriptor and executor through Poppler in page order", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-read-pdf-e2e-"));
    const pdfPath = join(root, "two-pages.pdf");
    const executionPort = createNodeExecutionAdapter({
      outputRootDir: join(root, "exec-output"),
      processEnv: process.env,
    });

    try {
      await writeFile(pdfPath, buildTwoPagePdf());
      const sessionId = createSessionId("read-pdf-e2e");
      const turnId = createTurnId("read-pdf-e2e");
      const traceContext = createRootTraceContext({ sessionId, turnId });
      const runtime = new AgentRuntime(
        sessionId,
        {
          mode: "yolo",
          modelInputMediaCapabilities: { supportsImages: true, supportsPdf: true },
          workingDirectory: root,
        },
        {
          eventStore: createInMemorySessionEventStore(),
          executionPort,
          fileSystemPort: createNodeFileSystemAdapter(),
          imageProcessorPort: createJimpImageProcessorAdapter(),
          pdfDocumentPort: createPopplerPdfDocumentAdapter({ executionPort }),
        },
      );
      const model = {
        providerId: createModelProviderId("test"),
        modelId: createModelId("pdf-e2e"),
        properties: { supportsImages: true, supportsPdf: true },
      } as never;

      const readTool = runtime.getTools(model).find((tool) => tool.name === "Read")!;
      expect(readTool.inputSchema.properties.pages).toMatchObject({ type: "string" });

      const result = await runtime.getToolExecutor().execute(
        {
          id: createToolCallId("read-pdf-pages"),
          name: "Read",
          input: { file_path: pdfPath, pages: "1-2" },
        },
        { model, traceContext },
      );
      expect(result.success).toBe(true);
      expect(result.modelContent).toEqual([
        {
          type: "text",
          text: expect.stringMatching(
            /^PDF pages extracted: 2 page\(s\) from .*two-pages\.pdf \([\d.]+(?:KB| bytes)\)$/u,
          ),
        },
        expect.objectContaining({ type: "image", mediaType: "image/jpeg" }),
        expect.objectContaining({ type: "image", mediaType: "image/jpeg" }),
      ]);

      const pageDataUrls = (result.modelContent as any[])
        .filter((block) => block.type === "image")
        .map((block) => block.dataUrl);
      expect(pageDataUrls).toHaveLength(2);
      expect(pageDataUrls[0]).not.toBe(pageDataUrls[1]);
    } finally {
      await executionPort.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

async function commandSucceeds(command: string, args: string[]): Promise<boolean> {
  return await new Promise((resolve) => {
    execFile(command, args, { timeout: 5_000 }, (error) => resolve(error === null));
  });
}

function createChatModelAdapter(baseURL: string): AiSdkModelAdapter {
  const providerId = String(CHAT_MODEL.providerId);
  const modelId = String(CHAT_MODEL.modelId);
  return new AiSdkModelAdapter({
    registry: new AiSdkModelRegistry({
      env: {},
      inputMediaCapabilities: {
        [`${providerId}/${modelId}`]: { supportsImages: true, supportsPdf: true },
      },
      providers: {
        [providerId]: {
          apiKey: "pdf-e2e-key",
          baseURL: `${baseURL}/v1`,
          kind: "openai-compatible",
          providerOptions: { apiFormat: "openai-chat-completions" },
        },
      },
    }),
    retry: { maxAttempts: 1 },
  });
}

const deterministicPdfDocument: PdfDocumentPort = {
  async getPageCount() {
    return 2;
  },
  async renderPages() {
    // 故意逆序返回，确保页面排序由 Read 结果契约维护，而不是依赖 adapter 偶然顺序。
    return [
      { data: PAGE_TWO_BYTES, mediaType: "image/jpeg", pageNumber: 2 },
      { data: PAGE_ONE_BYTES, mediaType: "image/jpeg", pageNumber: 1 },
    ];
  },
};

const passthroughImageProcessor: ImageProcessorPort = {
  async resizeToFit(request) {
    return {
      data: request.data,
      mediaType: request.mediaType,
      originalHeight: 1,
      originalWidth: 1,
      height: 1,
      resized: false,
      width: 1,
    };
  },
  async prepareForModel(request) {
    return {
      data: request.data,
      mediaType: request.mediaType,
      compressed: false,
      originalHeight: 1,
      originalSizeBytes: request.data.byteLength,
      originalWidth: 1,
      height: 1,
      resized: false,
      strategy: "original",
      transformedSizeBytes: request.data.byteLength,
      width: 1,
    };
  },
};

async function startChatCaptureServer(pdfPath: string): Promise<{
  baseURL: string;
  bodies: Record<string, unknown>[];
  server: Server;
}> {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    bodies.push(JSON.parse(body) as Record<string, unknown>);
    const firstRequest = bodies.length === 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: firstRequest ? "tool_calls" : "stop",
            index: 0,
            message: firstRequest
              ? {
                  content: null,
                  role: "assistant",
                  tool_calls: [
                    {
                      function: {
                        arguments: JSON.stringify({ file_path: pdfPath, pages: "1-2" }),
                        name: "Read",
                      },
                      id: "read-pdf-pages",
                      type: "function",
                    },
                  ],
                }
              : { content: "done", role: "assistant" },
          },
        ],
        created: 0,
        id: `chatcmpl-read-pdf-${bodies.length}`,
        model: String(CHAT_MODEL.modelId),
        object: "chat.completion",
        usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("capture server has no port");
  return { baseURL: `http://127.0.0.1:${address.port}`, bodies, server };
}

function expectReadToolPagesShape(body: Record<string, unknown>): void {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const readTool = tools.find((tool) => {
    if (!tool || typeof tool !== "object") return false;
    const fn = (tool as Record<string, unknown>).function;
    return isRecord(fn) && fn.name === "Read";
  });
  expect(readTool).toMatchObject({
    function: {
      name: "Read",
      parameters: { properties: { pages: { type: "string" } } },
    },
    type: "function",
  });
}

function expectOrderedPdfToolResult(body: Record<string, unknown>): {
  mediaContent: unknown;
  toolContent: unknown;
} {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const toolIndex = messages.findIndex(
    (message) =>
      isRecord(message) && message.role === "tool" && message.tool_call_id === "read-pdf-pages",
  );
  expect(toolIndex).toBeGreaterThan(0);
  const toolMessage = messages[toolIndex];
  const mediaMessage = messages[toolIndex + 1];
  const toolContent = isRecord(toolMessage) ? toolMessage.content : undefined;
  expect(toolMessage).toMatchObject({
    content: expect.stringMatching(/^PDF pages extracted: 2 page\(s\)/u),
    role: "tool",
    tool_call_id: "read-pdf-pages",
  });
  expect(typeof toolContent).toBe("string");
  const imagePlaceholders = (toolContent as string).match(/\[Attached image\/jpeg[^\]]*\]/gu);
  expect(imagePlaceholders ?? []).toHaveLength(2);
  expect(mediaMessage).toEqual({
    content: [
      { text: "Tool result media from Read:", type: "text" },
      {
        image_url: { url: "data:image/jpeg;base64,cGFnZS1vbmU=" },
        type: "image_url",
      },
      {
        image_url: { url: "data:image/jpeg;base64,cGFnZS10d28=" },
        type: "image_url",
      },
    ],
    role: "user",
  });
  return {
    mediaContent: isRecord(mediaMessage) ? mediaMessage.content : undefined,
    toolContent,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

function buildTwoPagePdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 160 240] >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source, "ascii"));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(source, "ascii");
  source += `xref\n0 ${objects.length + 1}\n`;
  source += "0000000000 65535 f \n";
  source += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  source += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(source, "ascii");
}
