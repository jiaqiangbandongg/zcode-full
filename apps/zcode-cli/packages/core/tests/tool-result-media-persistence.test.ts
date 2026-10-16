import { describe, expect, it, vi } from "vitest";
import {
  createMessageId,
  createRootTraceContext,
  createSessionId,
  createTurnId,
  type ToolArtifactStorePort,
} from "@zcode/contracts";
import {
  filePartToContentBlock,
  projectPersistedToolMediaContent,
} from "../src/agent/file-part-hydration.js";
import { persistToolResultMediaAttachments } from "../src/runtime/helpers/tool-result-media-persistence.js";

describe("tool result media persistence", () => {
  it("fails the turn when provider-ready media cannot be written durably", async () => {
    const sessionId = createSessionId("tool-media-write-failure");
    const turnId = createTurnId("tool-media-write-failure");
    const writeToolResultArtifact = vi.fn(async () => {
      throw new Error("artifact write failed");
    });

    await expect(
      persistToolResultMediaAttachments({
        artifactStore: { writeToolResultArtifact } as never,
        assistantMessageId: createMessageId("assistant-tool-media-write-failure"),
        content: [
          {
            type: "video",
            mediaType: "video/mp4",
            dataUrl: "data:video/mp4;base64,dmlkZW8=",
          },
        ],
        sessionId,
        sessionStore: {} as never,
        toolCallId: "read-video",
        toolName: "Read",
        traceContext: createRootTraceContext({ sessionId, turnId }),
        turnId,
      }),
    ).rejects.toThrow("artifact write failed");
    expect(writeToolResultArtifact).toHaveBeenCalledTimes(1);
  });

  it("does not require artifact persistence for text-only tool content", async () => {
    const sessionId = createSessionId("tool-text-no-artifact");
    const turnId = createTurnId("tool-text-no-artifact");

    await expect(
      persistToolResultMediaAttachments({
        assistantMessageId: createMessageId("assistant-tool-text-no-artifact"),
        content: "plain text",
        sessionId,
        sessionStore: {} as never,
        toolCallId: "read-text",
        toolName: "Read",
        traceContext: createRootTraceContext({ sessionId, turnId }),
        turnId,
      }),
    ).resolves.toBeUndefined();
  });

  it("restores PDF page images in their original order after a cold resume", async () => {
    const sessionId = createSessionId("tool-pdf-media-order");
    const turnId = createTurnId("tool-pdf-media-order");
    const contents = new Map<string, string>();
    const artifactStore: ToolArtifactStorePort = {
      async writeToolResultArtifact(request) {
        const uri = `zcode-artifact://pdf-page-${contents.size + 1}`;
        contents.set(uri, request.content);
        return {
          id: `pdf-page-${contents.size}`,
          uri,
          bytes: Buffer.byteLength(request.content),
          contentType: request.contentType ?? "text/plain",
          createdAt: new Date(0),
        };
      },
      async readToolResultArtifact(request) {
        const content = contents.get(request.uri);
        if (content === undefined) throw new Error(`Missing artifact: ${request.uri}`);
        return {
          uri: request.uri,
          content,
          bytes: Buffer.byteLength(content),
          contentType: "text/plain",
        };
      },
    };
    const summary = "PDF pages extracted: 2 page(s) from /tmp/report.pdf (2KB)";
    const persisted = await persistToolResultMediaAttachments({
      artifactStore,
      assistantMessageId: createMessageId("assistant-tool-pdf-media-order"),
      content: [
        { type: "text", text: summary },
        {
          type: "image",
          mediaType: "image/jpeg",
          dataUrl: "data:image/jpeg;base64,cGFnZS0x",
        },
        {
          type: "image",
          mediaType: "image/jpeg",
          dataUrl: "data:image/jpeg;base64,cGFnZS0y",
        },
      ],
      sessionId,
      sessionStore: {} as never,
      toolCallId: "read-pdf",
      toolName: "Read",
      traceContext: createRootTraceContext({ sessionId, turnId }),
      turnId,
    });

    expect(persisted?.modelContentLayout).toEqual([
      { type: "text", text: summary },
      { type: "attachment", attachmentIndex: 0 },
      { type: "attachment", attachmentIndex: 1 },
    ]);
    const attachmentBlocks = await Promise.all(
      persisted!.attachments.map((attachment) => filePartToContentBlock(attachment, artifactStore)),
    );
    const restored = projectPersistedToolMediaContent(
      persisted!.modelContentLayout,
      attachmentBlocks,
    );
    expect(restored?.map((block) => (block.type === "text" ? block.text : block.dataUrl))).toEqual([
      summary,
      "data:image/jpeg;base64,cGFnZS0x",
      "data:image/jpeg;base64,cGFnZS0y",
    ]);
  });
});
