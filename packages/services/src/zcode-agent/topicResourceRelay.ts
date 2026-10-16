import { createHash } from "node:crypto";
import {
  TOPIC_RESOURCE_RELAY_CHUNK_BYTES,
  zcodeTopicResourceRelayRequestSchema,
  zcodeTopicResourceRelayKeySchema,
  zcodeTopicResourceRelayChunkRequestSchema,
  zcodeTopicResourceRelayMetadataSchema,
  type ZCodeTopicResourceRelayRequest,
  type ZCodePromptAttachment,
} from "@zcode/shared";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";

export interface TopicResourceRelayDependencies {
  reply?(
    request: import("@zcode/shared").ChannelReplyHostRequest,
  ): Promise<import("@zcode/shared").ChannelReplyResult>;
  validate(request: ZCodeTopicResourceRelayRequest, signal: AbortSignal): Promise<void>;
  read(
    request: ZCodeTopicResourceRelayRequest,
    signal: AbortSignal,
  ): Promise<ZCodePromptAttachment>;
}
interface Transfer {
  request: ZCodeTopicResourceRelayRequest;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  data?: Buffer;
}

/** 只缓存有界附件字节；过载直接拒绝，不构成第二份执行队列。每条远程连接独立持有。 */
export function createTopicResourceRelay(deps: TopicResourceRelayDependencies) {
  const transfers = new Map<string, Transfer>();
  let disposed = false;
  const release = (id: string, expected?: Transfer) => {
    const entry = transfers.get(id);
    // 取消后同 ID 可重新开始；旧读取的迟到异常不能删除新的传输。
    if (!entry || (expected && entry !== expected)) return;
    transfers.delete(id);
    clearTimeout(entry.timer);
    entry.controller.abort(new Error("Topic resource transfer closed"));
    entry.data = undefined;
  };
  const lookup = (value: unknown) => {
    const key = zcodeTopicResourceRelayKeySchema.parse(value);
    const entry = transfers.get(key.requestId);
    if (disposed || !entry || entry.request.taskId !== key.taskId)
      throw new Error("Topic resource transfer unavailable");
    entry.controller.signal.throwIfAborted();
    return entry;
  };
  return {
    async begin(value: unknown) {
      const request = zcodeTopicResourceRelayRequestSchema.parse(value);
      if (disposed) throw new Error("Topic resource connection closed");
      if (transfers.has(request.requestId))
        throw new Error("Topic resource request already active");
      if (transfers.size >= 2) throw new Error("Topic resource transfer busy");
      const controller = new AbortController();
      const entry: Transfer = {
        request,
        controller,
        timer: setTimeout(() => release(request.requestId), 120_000),
      };
      transfers.set(request.requestId, entry);
      try {
        await deps.validate(request, controller.signal);
        controller.signal.throwIfAborted();
        const attachment = await deps.read(request, controller.signal);
        controller.signal.throwIfAborted();
        const encoded = attachment.dataBase64;
        if (
          encoded === undefined ||
          encoded.length > Math.ceil(PROTOCOL_V4_LIMITS.attachmentMaxBytes / 3) * 4
        )
          throw new Error("Topic resource exceeds transfer limit");
        const data = Buffer.from(encoded, "base64");
        if (data.toString("base64") !== encoded) throw new Error("Invalid topic resource encoding");
        const metadata = zcodeTopicResourceRelayMetadataSchema.parse({
          fileName: attachment.filename,
          mime: attachment.mimeType,
          bytes: data.length,
          totalChunks: Math.ceil(data.length / TOPIC_RESOURCE_RELAY_CHUNK_BYTES),
          checksum: `sha256:${createHash("sha256").update(data).digest("hex")}`,
        });
        await deps.validate(request, controller.signal);
        controller.signal.throwIfAborted();
        entry.data = data;
        return metadata;
      } catch (error) {
        release(request.requestId, entry);
        throw error;
      }
    },
    async chunk(value: unknown) {
      const { index, ...key } = zcodeTopicResourceRelayChunkRequestSchema.parse(value);
      const entry = lookup(key);
      try {
        await deps.validate(entry.request, entry.controller.signal);
        entry.controller.signal.throwIfAborted();
        const data = entry.data;
        if (!data || index >= Math.ceil(data.length / TOPIC_RESOURCE_RELAY_CHUNK_BYTES))
          throw new Error("Topic resource chunk unavailable");
        return {
          dataBase64: data
            .subarray(
              index * TOPIC_RESOURCE_RELAY_CHUNK_BYTES,
              (index + 1) * TOPIC_RESOURCE_RELAY_CHUNK_BYTES,
            )
            .toString("base64"),
        };
      } catch (error) {
        release(key.requestId, entry);
        throw error;
      }
    },
    async finish(value: unknown) {
      const entry = lookup(value);
      try {
        if (!entry.data) throw new Error("Topic resource is not ready");
        await deps.validate(entry.request, entry.controller.signal);
        entry.controller.signal.throwIfAborted();
        return { completed: true as const };
      } finally {
        release(entry.request.requestId, entry);
      }
    },
    cancel(value: unknown) {
      const key = zcodeTopicResourceRelayKeySchema.parse(value);
      if (transfers.get(key.requestId)?.request.taskId !== key.taskId) return false;
      release(key.requestId);
      return true;
    },
    dispose() {
      disposed = true;
      for (const key of transfers.keys()) release(key);
    },
  };
}
