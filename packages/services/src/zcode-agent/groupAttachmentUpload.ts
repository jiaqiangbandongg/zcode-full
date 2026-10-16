import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ZCodePromptAttachment } from "@zcode/shared";
import { PROTOCOL_V4_LIMITS, type AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService, ZCodeAgentSessionTarget } from "#src/zcode-agent/zcodeAgent.js";

const CHUNK_BYTES = 384 * 1024;
type UploadAgent = Pick<
  IZCodeAgentService,
  "attachmentBeginV4" | "attachmentChunkV4" | "attachmentCommitV4" | "attachmentAbortV4"
>;

/** 内容寄存在目标 CLI，群队列只保存引用；远端不能直接使用桌面临时路径。 */
export async function uploadBotGroupAttachments(
  agent: UploadAgent,
  target: ZCodeAgentSessionTarget,
  attachments: readonly ZCodePromptAttachment[],
  signal?: AbortSignal,
): Promise<AttachmentRef[]> {
  const refs: AttachmentRef[] = [];
  for (const attachment of attachments) {
    signal?.throwIfAborted();
    const data =
      attachment.dataBase64 !== undefined
        ? Buffer.from(attachment.dataBase64, "base64")
        : attachment.localPath
          ? await readFile(attachment.localPath, { signal })
          : attachment.kind === "file" && attachment.textContent !== undefined
            ? Buffer.from(attachment.textContent)
            : null;
    if (!data) throw new Error("Attachment content is unavailable");
    if (data.length > PROTOCOL_V4_LIMITS.attachmentMaxBytes)
      throw new Error("Attachment exceeds protocol size limit");
    const common = { ...target, uploadId: randomUUID() };
    const totalChunks = Math.ceil(data.length / CHUNK_BYTES);
    const toRef = (ref: string): AttachmentRef => ({
      ref,
      fileName: attachment.filename,
      mime: attachment.mimeType,
      bytes: data.length,
      ...(attachment.kind === "file" && attachment.sourceKind
        ? { sourceKind: attachment.sourceKind, messageCount: attachment.messageCount }
        : {}),
    });
    try {
      // begin 的确认也可能丢失；从发送起就按 uploadId 清理，不等待确认后才标记。
      const begin = await agent.attachmentBeginV4({
        ...common,
        fileName: attachment.filename,
        mime: attachment.mimeType,
        totalBytes: data.length,
        totalChunks,
        checksum: `sha256:${createHash("sha256").update(data).digest("hex")}`,
      });
      signal?.throwIfAborted();
      if (begin.state === "committed") {
        refs.push(toRef(begin.ref));
        continue;
      }
      if (begin.nextChunkIndex > totalChunks) throw new Error("Invalid attachment upload progress");
      for (let index = begin.nextChunkIndex; index < totalChunks; index++) {
        signal?.throwIfAborted();
        const chunk = await agent.attachmentChunkV4({
          ...common,
          chunkIndex: index,
          dataBase64: data
            .subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)
            .toString("base64"),
        });
        if (chunk.nextChunkIndex !== index + 1)
          throw new Error("Invalid attachment upload progress");
      }
      // 取消可能在最后一个分块期间发生；提交前再次检查，避免交付已取消的资源。
      signal?.throwIfAborted();
      const committed = await agent.attachmentCommitV4(common);
      signal?.throwIfAborted();
      refs.push(toRef(committed.ref));
    } catch (error) {
      await agent.attachmentAbortV4(common).catch(() => undefined);
      throw error;
    }
  }
  return refs;
}
