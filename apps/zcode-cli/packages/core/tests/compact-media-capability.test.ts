import { describe, expect, it } from "vitest";
import { createSessionId, type ModelInputFormat, type ModelInputMessage } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestImageArtifactStore } from "./test-image-artifact-store.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestInputFormat, createTestRuntimeModel } from "./test-runtime-model.js";
import { DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES } from "../src/runtime/helpers/media-budget.js";

const SHARED_MAX_IMAGE_DATA_URL = imageDataUrl(5 * 1024 * 1024);
const RETAINED_IMAGE_COUNT = Math.floor(
  DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES / Buffer.byteLength(SHARED_MAX_IMAGE_DATA_URL, "utf8"),
);
const OVER_BUDGET_IMAGE_COUNT = RETAINED_IMAGE_COUNT + 2;

describe("compact media policy projection", () => {
  it.each<{
    capabilities: ModelInputFormat;
    expectedFileCount: number;
    expectedImageCount: number;
    expectedVideoCount: number;
    omittedText: string;
    unsupportedKind: "image" | "pdf" | "video";
  }>([
    {
      capabilities: createTestInputFormat({ supportsImage: false }),
      expectedFileCount: 1,
      expectedImageCount: 0,
      expectedVideoCount: 1,
      omittedText: "does not support image input",
      unsupportedKind: "image",
    },
    {
      capabilities: createTestInputFormat({ supportsPdf: false }),
      expectedFileCount: 0,
      expectedImageCount: RETAINED_IMAGE_COUNT,
      expectedVideoCount: 1,
      omittedText: "does not support PDF input",
      unsupportedKind: "pdf",
    },
    {
      capabilities: createTestInputFormat({ supportsVideo: false }),
      expectedFileCount: 1,
      expectedImageCount: RETAINED_IMAGE_COUNT,
      expectedVideoCount: 0,
      omittedText: "does not support video input",
      unsupportedKind: "video",
    },
  ])(
    "projects unsupported historical $unsupportedKind media and enforces the aggregate budget before automatic compact requests",
    async ({
      capabilities,
      expectedFileCount,
      expectedImageCount,
      expectedVideoCount,
      omittedText,
      unsupportedKind,
    }) => {
      const requests: Array<{
        fileCount: number;
        imageCount: number;
        kind: "compact" | "normal";
        text: string;
        videoCount: number;
      }> = [];
      let normalResponseCount = 0;
      const generateText = async (request: { messages: ModelInputMessage[] }) => {
        const text = requestTextBlocks(request.messages).join("\n");
        const isCompact = text.includes("create a detailed summary");
        requests.push({
          fileCount: requestFileBlocks(request.messages).length,
          imageCount: requestImageBlocks(request.messages).length,
          kind: isCompact ? "compact" : "normal",
          text,
          videoCount: requestVideoBlocks(request.messages).length,
        });

        if (isCompact) {
          return {
            finishReason: "stop",
            text: "<summary>Text-only auto compact summary.</summary>",
            usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          };
        }

        normalResponseCount++;
        return {
          finishReason: "stop",
          text: `normal response ${normalResponseCount}`,
          usage: {
            inputTokens: normalResponseCount === 2 ? 115 : 3,
            outputTokens: 1,
            totalTokens: normalResponseCount === 2 ? 116 : 4,
          },
        };
      };
      const runtime = createTestAgentRuntime(
        createSessionId(`runtime-auto-compact-media-capability-${unsupportedKind}`),
        {
          compact: {
            bufferTokens: 10,
            contextWindow: 120,
            summaryReserveTokens: 0,
          },
          maxOutputTokens: 1,
          mode: "plan",
          systemPrompt: "You are an auto compact media capability test agent.",
          workingDirectory: `/tmp/zcode-runtime-auto-compact-media-capability-${unsupportedKind}`,
        },
        {
          artifactStore: createTestImageArtifactStore(),
          eventStore: createTestSessionEventStore(),
          modelFactory: () => createTestRuntimeModel({ generateText, inputFormat: capabilities }),
        },
      );

      await runtime.executeTurn("auto compact image warmup", [
        {
          type: "image",
          path: "[image #1]",
          content: SHARED_MAX_IMAGE_DATA_URL,
        },
      ]);
      runtime["messageHistory"].addUser(
        [
          ...Array.from({ length: OVER_BUDGET_IMAGE_COUNT - 1 }, () => ({
            type: "image" as const,
            dataUrl: SHARED_MAX_IMAGE_DATA_URL,
          })),
          { type: "text", text: "historical PDF attachment" },
          {
            type: "file",
            mediaType: "application/pdf",
            name: "historical.pdf",
            dataUrl: "data:application/pdf;base64,AAAA",
            text: "",
          },
          {
            type: "video",
            mediaType: "video/mp4",
            dataUrl: "data:video/mp4;base64,dmlkZW8=",
          },
        ],
        { source: "real_user" },
      );
      await runtime.executeTurn("old context ".repeat(80));
      const result = await runtime.executeTurn("continue after media capability auto compact");

      const compactRequest = requests.find((request) => request.kind === "compact");
      expect(result.response).toBe("normal response 3");
      expect(requests.map((request) => request.kind)).toEqual([
        "normal",
        "normal",
        "compact",
        "normal",
      ]);
      expect(compactRequest?.fileCount).toBe(expectedFileCount);
      expect(compactRequest?.imageCount).toBe(expectedImageCount);
      expect(compactRequest?.videoCount).toBe(expectedVideoCount);
      expect(compactRequest?.text).toContain(omittedText);
      if (capabilities.supportsImages === true) {
        expect(compactRequest?.text).toContain("Media omitted from provider request");
      }
    },
  );
});

function imageDataUrl(payloadBytes: number): string {
  return `data:image/png;base64,${"A".repeat(payloadBytes)}`;
}

function requestImageBlocks(messages: ModelInputMessage[]) {
  return messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((block) => block.type === "image") : [],
  );
}

function requestFileBlocks(messages: ModelInputMessage[]) {
  return messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((block) => block.type === "file") : [],
  );
}

function requestVideoBlocks(messages: ModelInputMessage[]) {
  return messages.flatMap((message) =>
    Array.isArray(message.content) ? message.content.filter((block) => block.type === "video") : [],
  );
}

function requestTextBlocks(messages: ModelInputMessage[]): string[] {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
      : [message.content],
  );
}
