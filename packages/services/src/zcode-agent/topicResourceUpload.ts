import {
  V4_METHODS,
  v4AttachmentBeginResultSchema,
  v4AttachmentChunkResultSchema,
  v4AttachmentCommitResultSchema,
  v4AttachmentAbortResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import {
  zcodeTopicResourceReadResultSchema,
  type ZCodePromptAttachment,
  type ZCodeProtocolTrace,
} from "@zcode/shared";
import { uploadBotGroupAttachments } from "./groupAttachmentUpload.js";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";
import type { ZCodeAgentSessionTarget } from "./zcodeAgent.js";

/** 反向请求绑定实际 CLI 连接；上传不能再次按路径选择运行时。 */
export async function uploadTopicResourceToClient(
  client: Pick<ZCodeProtocolClient, "request">,
  connectionId: string,
  target: ZCodeAgentSessionTarget,
  attachment: ZCodePromptAttachment,
  signal: AbortSignal,
  trace?: ZCodeProtocolTrace,
) {
  const [ref] = await uploadBotGroupAttachments(
    {
      attachmentBeginV4: (p) =>
        client.request(
          V4_METHODS.attachmentBegin,
          {
            connectionId,
            uploadId: p.uploadId,
            sessionId: p.sessionId,
            fileName: p.fileName,
            mime: p.mime,
            totalBytes: p.totalBytes,
            totalChunks: p.totalChunks,
            checksum: p.checksum,
          },
          v4AttachmentBeginResultSchema,
          { signal, trace },
        ),
      attachmentChunkV4: (p) =>
        client.request(
          V4_METHODS.attachmentChunk,
          {
            connectionId,
            uploadId: p.uploadId,
            sessionId: p.sessionId,
            chunkIndex: p.chunkIndex,
            dataBase64: p.dataBase64,
          },
          v4AttachmentChunkResultSchema,
          { signal, trace },
        ),
      attachmentCommitV4: (p) =>
        client.request(
          V4_METHODS.attachmentCommit,
          {
            connectionId,
            uploadId: p.uploadId,
            sessionId: p.sessionId,
          },
          v4AttachmentCommitResultSchema,
          { signal, trace },
        ),
      attachmentAbortV4: async (p) => {
        await client.request(
          V4_METHODS.attachmentAbort,
          {
            connectionId,
            uploadId: p.uploadId,
            sessionId: p.sessionId,
          },
          v4AttachmentAbortResultSchema,
        );
      },
    },
    target,
    [attachment],
    signal,
  );
  return zcodeTopicResourceReadResultSchema.parse(ref);
}
