import { describe, expect, it } from "vitest";
import {
  PROTOCOL_V4_LIMITS,
  V4_METHODS,
  v4AttachmentAbortParamsSchema,
  v4AttachmentBeginParamsSchema,
  v4AttachmentBeginResultSchema,
  v4AttachmentChunkParamsSchema,
  v4AttachmentCommitParamsSchema,
  v4AttachmentPreviewSourceParamsSchema,
  v4AttachmentPreviewSourceResultSchema,
  v4AttachmentReadParamsSchema,
  v4AttachmentReadResultSchema,
  v4ConversationAttachmentReadParamsSchema,
  v4ConversationAttachmentReadResultSchema,
  v4ConversationAttachmentStatParamsSchema,
  v4ConversationAttachmentStatResultSchema,
} from "../src/zcode-protocol-v4/index.js";
import { VIDEO_INPUT_MAX_BYTES } from "../src/zcode-media-policy.js";

const sha256 = `sha256:${"a".repeat(64)}`;
const VIDEO_INPUT_MAX_MIB = 30;

describe("v4 chunked attachment protocol", () => {
  it("只暴露 begin/chunk/commit/abort production wire methods", () => {
    expect(V4_METHODS.attachmentBegin).toBe("v4/attachment/begin");
    expect(V4_METHODS.attachmentChunk).toBe("v4/attachment/chunk");
    expect(V4_METHODS.attachmentCommit).toBe("v4/attachment/commit");
    expect(V4_METHODS.attachmentAbort).toBe("v4/attachment/abort");
    expect("attachmentPut" in V4_METHODS).toBe(false);
  });

  it("冻结上传 staging 硬限额", () => {
    expect(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes).toBe(512 * 1024);
    expect(PROTOCOL_V4_LIMITS.attachmentUploadMaxChunks).toBe(64);
    expect(PROTOCOL_V4_LIMITS.attachmentUploadMaxConcurrent).toBe(16);
    expect(PROTOCOL_V4_LIMITS.attachmentUploadMaxStagedBytes).toBe(64 * 1024 * 1024);
    expect(PROTOCOL_V4_LIMITS.attachmentUploadTtlMs).toBe(5 * 60_000);
  });

  it("预览读取不扩张上传边界，并允许 video 使用 30MiB 全局输入上限", () => {
    expect(VIDEO_INPUT_MAX_BYTES).toBe(VIDEO_INPUT_MAX_MIB * 1024 * 1024);
    expect(PROTOCOL_V4_LIMITS.attachmentMaxBytes).toBe(20 * 1024 * 1024);
    expect(PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes).toBe(VIDEO_INPUT_MAX_BYTES);
    expect(PROTOCOL_V4_LIMITS.attachmentPreviewMaxChunks).toBe(
      VIDEO_INPUT_MAX_BYTES / PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
    );
    expect(PROTOCOL_V4_LIMITS.attachmentReadCacheMaxBytes).toBe(VIDEO_INPUT_MAX_BYTES);

    expect(
      v4AttachmentReadResultSchema.parse({
        dataBase64: "eA==",
        mediaType: "video/mp4",
        totalBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1,
        nextOffset: 1,
      }),
    ).toMatchObject({ totalBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1 });
    expect(() =>
      v4AttachmentReadResultSchema.parse({
        dataBase64: "eA==",
        mediaType: "image/png",
        totalBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1,
        nextOffset: 1,
      }),
    ).toThrow();
    expect(() =>
      v4AttachmentReadResultSchema.parse({
        dataBase64: "eA==",
        mediaType: "video/mp4",
        totalBytes: PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes + 1,
        nextOffset: 1,
      }),
    ).toThrow();
  });

  it("begin 校验 metadata/checksum，允许明确的 0-byte upload", () => {
    const base = {
      connectionId: "connection-1",
      uploadId: "upload-1",
      sessionId: "session-1",
      fileName: "shot.png",
      mime: "image/png",
      totalBytes: 0,
      totalChunks: 0,
      checksum: sha256,
    };
    expect(v4AttachmentBeginParamsSchema.parse(base)).toEqual(base);
    expect(() =>
      v4AttachmentBeginParamsSchema.parse({ ...base, totalBytes: 1, totalChunks: 0 }),
    ).toThrow();
    expect(() =>
      v4AttachmentBeginParamsSchema.parse({ ...base, checksum: "sha256:nope" }),
    ).toThrow();
    expect(() => v4AttachmentBeginParamsSchema.parse({ ...base, mime: "bad\r\nmime" })).toThrow();
    expect(() => v4AttachmentBeginParamsSchema.parse({ ...base, fileName: "bad\0name" })).toThrow();
    expect(() =>
      v4AttachmentBeginParamsSchema.parse({
        ...base,
        totalBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1,
        totalChunks: 1,
      }),
    ).toThrow();
  });

  it("chunk 只接受合法 base64 且 decoded bytes 不超过 512KiB", () => {
    const base = {
      connectionId: "connection-1",
      uploadId: "upload-1",
      sessionId: "session-1",
      chunkIndex: 0,
    };
    expect(v4AttachmentChunkParamsSchema.parse({ ...base, dataBase64: "aGk=" })).toEqual({
      ...base,
      dataBase64: "aGk=",
    });
    expect(() => v4AttachmentChunkParamsSchema.parse({ ...base, dataBase64: "%%%=" })).toThrow();
    const oversized = Buffer.alloc(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes + 1).toString(
      "base64",
    );
    expect(() => v4AttachmentChunkParamsSchema.parse({ ...base, dataBase64: oversized })).toThrow();
  });

  it("result 与 terminal request 均为 strict schema", () => {
    expect(
      v4AttachmentBeginResultSchema.parse({
        uploadId: "upload-1",
        state: "committed",
        nextChunkIndex: 2,
        ref: "zcode-artifact://one",
      }),
    ).toEqual({
      uploadId: "upload-1",
      state: "committed",
      nextChunkIndex: 2,
      ref: "zcode-artifact://one",
    });
    const terminal = {
      connectionId: "connection-1",
      uploadId: "upload-1",
      sessionId: "session-1",
    };
    expect(v4AttachmentCommitParamsSchema.parse(terminal)).toEqual(terminal);
    expect(v4AttachmentAbortParamsSchema.parse(terminal)).toEqual(terminal);
    expect(() => v4AttachmentCommitParamsSchema.parse({ ...terminal, extra: true })).toThrow();
  });

  it("sent preview accepts exact image/video row targets and rejects other media", () => {
    const params = {
      sessionId: "session-1",
      ref: "/workspace/demo.mov",
      target: { rowId: 42, entityId: "message-42" },
      attachmentIndex: 1,
      offset: 0,
      limit: 1024,
    };
    expect(v4AttachmentReadParamsSchema.parse(params)).toEqual(params);
    expect(() =>
      v4AttachmentReadParamsSchema.parse({ ...params, attachmentIndex: undefined }),
    ).toThrow();

    expect(
      v4AttachmentReadResultSchema.parse({
        dataBase64: "AA==",
        mediaType: "video/quicktime",
        totalBytes: 1,
        nextOffset: null,
      }),
    ).toMatchObject({ mediaType: "video/quicktime" });
    expect(() =>
      v4AttachmentReadResultSchema.parse({
        dataBase64: "AA==",
        mediaType: "audio/mpeg",
        totalBytes: 1,
        nextOffset: null,
      }),
    ).toThrow();
  });

  it("share attachment read accepts non-media text/plain and requires row/index authority", () => {
    const params = {
      sessionId: "session-1",
      ref: "/Users/test/.zcode/tmp/paste-attachments/pasted.txt",
      target: { rowId: 42, entityId: "message-42" },
      attachmentIndex: 0,
      offset: 0,
      limit: 1024,
    };
    expect(V4_METHODS.conversationAttachmentRead).toBe("v4/conversation/attachmentRead");
    expect(v4ConversationAttachmentReadParamsSchema.parse(params)).toEqual(params);
    expect(
      v4ConversationAttachmentReadResultSchema.parse({
        dataBase64: "aGVsbG8=",
        mediaType: "text/plain",
        totalBytes: 5,
        nextOffset: null,
      }),
    ).toMatchObject({ mediaType: "text/plain" });
  });

  it("share attachment stat is metadata-only and keeps row/index authority", () => {
    const params = {
      sessionId: "session-1",
      ref: "/Users/test/.zcode/tmp/paste-attachments/pasted.txt",
      target: { rowId: 42, entityId: "message-42" },
      attachmentIndex: 0,
    };
    expect(V4_METHODS.conversationAttachmentStat).toBe("v4/conversation/attachmentStat");
    expect(v4ConversationAttachmentStatParamsSchema.parse(params)).toEqual(params);
    expect(
      v4ConversationAttachmentStatResultSchema.parse({
        mediaType: "text/plain",
        totalBytes: 5,
        mtimeMs: 7,
      }),
    ).toEqual({ mediaType: "text/plain", totalBytes: 5, mtimeMs: 7 });
    expect(() =>
      v4ConversationAttachmentStatParamsSchema.parse({ ...params, target: undefined }),
    ).toThrow();
  });

  it("stat 能表达超出传输上限的真实文件大小（容量超限才可能被判为阻断）", () => {
    // Bug 根因：stat 结果曾复用 30MiB 的预览上限，超大附件在 schema 就抛错，
    // 于是「已知容量超限」这个确定阻断被降级成 deferred 并静默丢内容。
    expect(PROTOCOL_V4_LIMITS.attachmentStatMaxBytes).toBeGreaterThan(
      PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes,
    );
    expect(
      v4ConversationAttachmentStatResultSchema.parse({
        mediaType: "video/mp4",
        totalBytes: PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes + 1,
      }),
    ).toMatchObject({ totalBytes: PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes + 1 });
    // 但 stat 仍有上界：超过它由 gateway 抛结构化 fault，而不是无声接受任意数字。
    expect(() =>
      v4ConversationAttachmentStatResultSchema.parse({
        mediaType: "video/mp4",
        totalBytes: PROTOCOL_V4_LIMITS.attachmentStatMaxBytes + 1,
      }),
    ).toThrow();
    // 搬运字节的读取通道边界不受影响。
    expect(() =>
      v4ConversationAttachmentReadResultSchema.parse({
        dataBase64: "eA==",
        mediaType: "video/mp4",
        totalBytes: PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes + 1,
        nextOffset: null,
      }),
    ).toThrow();
  });

  it("sent video local source is a strict desktop-only query result", () => {
    const params = {
      sessionId: "session-1",
      ref: "/workspace/demo.mov",
      target: { rowId: 42, entityId: "message-42" },
      attachmentIndex: 1,
      clientMode: "desktop-continuous",
    };
    expect(V4_METHODS.attachmentPreviewSource).toBe("v4/attachment/previewSource");
    expect(v4AttachmentPreviewSourceParamsSchema.parse(params)).toEqual(params);
    expect(() =>
      v4AttachmentPreviewSourceParamsSchema.parse({ ...params, attachmentIndex: undefined }),
    ).toThrow();
    expect(
      v4AttachmentPreviewSourceResultSchema.parse({
        kind: "local_path",
        path: "/workspace/demo.mov",
        mediaType: "video/quicktime",
      }),
    ).toMatchObject({ kind: "local_path", mediaType: "video/quicktime" });
    expect(v4AttachmentPreviewSourceResultSchema.parse({ kind: "chunked" })).toEqual({
      kind: "chunked",
    });
    expect(() =>
      v4AttachmentPreviewSourceResultSchema.parse({
        kind: "local_path",
        path: "/workspace/shot.png",
        mediaType: "image/png",
      }),
    ).toThrow();
  });
});
