import type { FilePart } from "@zcode/contracts";
import { createPartId } from "../deps.js";
import type {
  MessageId,
  ModelMessageContent,
  ModelMessageContentBlock,
  SessionId,
  SessionStorePort,
  ToolArtifactStorePort,
  TraceContext,
  TurnId,
} from "../deps.js";

type DataBackedToolMediaBlock =
  | Extract<ModelMessageContentBlock, { type: "image" | "video" }>
  | (Extract<ModelMessageContentBlock, { type: "file" }> & { dataUrl: string });

type PersistedToolMediaLayoutEntry =
  | { type: "attachment"; attachmentIndex: number }
  | { type: "text"; text: string };

export async function persistToolResultMediaAttachments(input: {
  artifactStore?: ToolArtifactStorePort;
  assistantMessageId: MessageId;
  content: ModelMessageContent;
  sessionId: SessionId;
  sessionStore?: SessionStorePort;
  toolCallId: string;
  toolName: string;
  traceContext: TraceContext;
  turnId: TurnId;
}): Promise<
  | {
      attachments: FilePart[];
      modelContentLayout: PersistedToolMediaLayoutEntry[];
    }
  | undefined
> {
  if (!input.sessionStore) return undefined;
  const projection = persistedToolMediaProjection(input.content);
  if (!projection) return undefined;
  if (!input.artifactStore) {
    throw new Error("Cannot persist tool result media without an artifact store");
  }

  const attachments: FilePart[] = [];
  for (const [index, block] of projection.mediaBlocks.entries()) {
    const existingArtifactUri = block.source?.uri?.startsWith("zcode-artifact://")
      ? block.source.uri
      : undefined;
    // 已完成工具的媒体属于结果收尾；继承本轮 Stop 信号会中断保存并丢失冷恢复内容。
    const artifactUri =
      existingArtifactUri ??
      (
        await input.artifactStore.writeToolResultArtifact({
          content: block.dataUrl,
          contentType: "text/plain",
          retention: "session",
          sessionId: input.sessionId,
          toolCallId: `${input.toolCallId}-media-${index + 1}`,
          toolName: input.toolName,
          trace: input.traceContext,
          turnId: input.turnId,
        })
      ).uri;

    attachments.push({
      id: createPartId(),
      messageID: input.assistantMessageId,
      sessionID: input.sessionId,
      type: "file",
      mime: block.mediaType,
      ...(block.type === "file" && block.name
        ? { filename: block.name }
        : block.source?.placeholder
          ? { filename: block.source.placeholder }
          : {}),
      url: artifactUri,
      metadata: {
        artifactUri,
        recoverability: "provider_ready",
        storageKind: "artifact",
        ...(block.source?.sizeBytes !== undefined ? { sizeBytes: block.source.sizeBytes } : {}),
        ...(block.source?.sha256 ? { sha256: block.source.sha256 } : {}),
      },
    });
  }
  return { attachments, modelContentLayout: projection.modelContentLayout };
}

function persistedToolMediaProjection(content: ModelMessageContent):
  | {
      mediaBlocks: DataBackedToolMediaBlock[];
      modelContentLayout: PersistedToolMediaLayoutEntry[];
    }
  | undefined {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  const mediaBlocks: DataBackedToolMediaBlock[] = [];
  const modelContentLayout: PersistedToolMediaLayoutEntry[] = [];
  for (const block of content) {
    if (block.type === "text") {
      modelContentLayout.push({ type: "text", text: block.text });
      continue;
    }
    if ((block.type === "image" || block.type === "video") && block.dataUrl.startsWith("data:")) {
      modelContentLayout.push({ type: "attachment", attachmentIndex: mediaBlocks.length });
      mediaBlocks.push(block);
      continue;
    }
    if (block.type === "file" && block.dataUrl?.startsWith("data:")) {
      modelContentLayout.push({ type: "attachment", attachmentIndex: mediaBlocks.length });
      mediaBlocks.push(block as DataBackedToolMediaBlock);
      continue;
    }
    return undefined;
  }
  return mediaBlocks.length > 0 ? { mediaBlocks, modelContentLayout } : undefined;
}
