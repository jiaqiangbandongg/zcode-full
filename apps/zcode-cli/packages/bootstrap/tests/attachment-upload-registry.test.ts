import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { AttachmentUploadRegistry } from "../src/zcode-protocol-v4/attachment-upload-registry.js";

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function begin(bytes: Uint8Array, uploadId = "upload-1", totalChunks = 1) {
  return {
    connectionId: "connection-1",
    sessionId: "session-1",
    uploadId,
    fileName: "payload.bin",
    mime: "application/octet-stream",
    totalBytes: bytes.byteLength,
    totalChunks: bytes.byteLength === 0 ? 0 : totalChunks,
    checksum: sha256(bytes),
  };
}

describe("AttachmentUploadRegistry hard bounds", () => {
  it("20MiB exactly 以 40 个 512KiB chunk 原子 commit", async () => {
    const bytes = new Uint8Array(PROTOCOL_V4_LIMITS.attachmentMaxBytes);
    const put = vi.fn(async () => ({ ref: "zcode-artifact://exact-20mib" }));
    const registry = new AttachmentUploadRegistry({ now: () => 0, putSessionAttachment: put });
    const chunkBytes = PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes;
    const totalChunks = bytes.byteLength / chunkBytes;
    registry.begin(begin(bytes, "exact-20mib", totalChunks));
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
      const start = chunkIndex * chunkBytes;
      registry.chunk({
        connectionId: "connection-1",
        sessionId: "session-1",
        uploadId: "exact-20mib",
        chunkIndex,
        dataBase64: Buffer.from(bytes.subarray(start, start + chunkBytes)).toString("base64"),
      });
    }
    await expect(
      registry.commit({
        connectionId: "connection-1",
        sessionId: "session-1",
        uploadId: "exact-20mib",
      }),
    ).resolves.toEqual({ ref: "zcode-artifact://exact-20mib" });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1].bytes.byteLength).toBe(PROTOCOL_V4_LIMITS.attachmentMaxBytes);
  });

  it("active upload 数量有硬上限；conflicting begin 不覆盖原 metadata", () => {
    const empty = new Uint8Array();
    const registry = new AttachmentUploadRegistry({
      now: () => 0,
      putSessionAttachment: vi.fn(async () => ({ ref: "unused" })),
    });
    for (let index = 0; index < PROTOCOL_V4_LIMITS.attachmentUploadMaxConcurrent; index += 1) {
      registry.begin(begin(empty, `upload-${index}`, 0));
    }
    expect(() =>
      registry.begin(begin(empty, "upload-overflow", 0)),
    ).toThrow("fault.attachment.tooManyUploads");
    expect(() =>
      registry.begin({ ...begin(empty, "upload-0", 0), fileName: "conflict.bin" }),
    ).toThrow("fault.attachment.beginConflict");
  });

  it("全局 decoded staging 64MiB 正好可用，后一字节拒绝", () => {
    const registry = new AttachmentUploadRegistry({
      now: () => 0,
      putSessionAttachment: vi.fn(async () => ({ ref: "unused" })),
    });
    const chunkBytes = PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes;
    const chunkBase64 = Buffer.alloc(chunkBytes).toString("base64");
    const bytesPerUpload = 16 * 1024 * 1024;
    const chunksPerUpload = bytesPerUpload / chunkBytes;
    for (let uploadIndex = 0; uploadIndex < 4; uploadIndex += 1) {
      const uploadId = `capacity-${uploadIndex}`;
      registry.begin({
        connectionId: "connection-1",
        sessionId: "session-1",
        uploadId,
        fileName: "capacity.bin",
        mime: "application/octet-stream",
        totalBytes: bytesPerUpload,
        totalChunks: chunksPerUpload,
        checksum: `sha256:${"0".repeat(64)}`,
      });
      for (let chunkIndex = 0; chunkIndex < chunksPerUpload; chunkIndex += 1) {
        registry.chunk({
          connectionId: "connection-1",
          sessionId: "session-1",
          uploadId,
          chunkIndex,
          dataBase64: chunkBase64,
        });
      }
    }
    registry.begin({
      connectionId: "connection-1",
      sessionId: "session-1",
      uploadId: "capacity-overflow",
      fileName: "one.bin",
      mime: "application/octet-stream",
      totalBytes: 1,
      totalChunks: 1,
      checksum: `sha256:${"0".repeat(64)}`,
    });
    expect(() =>
      registry.chunk({
        connectionId: "connection-1",
        sessionId: "session-1",
        uploadId: "capacity-overflow",
        chunkIndex: 0,
        dataBase64: "AA==",
      }),
    ).toThrow("fault.attachment.stagingCapacityExceeded");
    registry.clear();
  });

  it("incomplete commit 明确失败；TTL 到期释放 staging", async () => {
    let now = 0;
    const bytes = Buffer.from("two chunks");
    const put = vi.fn(async () => ({ ref: "unused" }));
    const registry = new AttachmentUploadRegistry({ now: () => now, putSessionAttachment: put });
    registry.begin(begin(bytes, "incomplete", 2));
    registry.chunk({
      connectionId: "connection-1",
      sessionId: "session-1",
      uploadId: "incomplete",
      chunkIndex: 0,
      dataBase64: Buffer.from("two ").toString("base64"),
    });
    await expect(
      registry.commit({
        connectionId: "connection-1",
        sessionId: "session-1",
        uploadId: "incomplete",
      }),
    ).rejects.toThrow("fault.attachment.uploadIncomplete");

    now = PROTOCOL_V4_LIMITS.attachmentUploadTtlMs + 1;
    registry.pruneExpired();
    await expect(
      registry.commit({
        connectionId: "connection-1",
        sessionId: "session-1",
        uploadId: "incomplete",
      }),
    ).rejects.toThrow("fault.attachment.uploadNotFound");
    expect(put).not.toHaveBeenCalled();
  });

  it("CLI registry 换代后半上传不存在，不自动 replay bytes", async () => {
    const bytes = Buffer.from("restart pending");
    const put = vi.fn(async () => ({ ref: "unused" }));
    const beforeRestart = new AttachmentUploadRegistry({
      now: () => 0,
      putSessionAttachment: put,
    });
    beforeRestart.begin(begin(bytes, "restart-upload"));
    beforeRestart.chunk({
      connectionId: "connection-1",
      sessionId: "session-1",
      uploadId: "restart-upload",
      chunkIndex: 0,
      dataBase64: bytes.toString("base64"),
    });
    beforeRestart.clear();
    const afterRestart = new AttachmentUploadRegistry({
      now: () => 1,
      putSessionAttachment: put,
    });
    await expect(
      afterRestart.commit({
        connectionId: "connection-1",
        sessionId: "session-1",
        uploadId: "restart-upload",
      }),
    ).rejects.toThrow("fault.attachment.uploadNotFound");
    expect(put).not.toHaveBeenCalled();
  });

  it("并发 commit single-flight，只写一个 artifact", async () => {
    const bytes = Buffer.from("single flight");
    let resolvePut!: (value: { ref: string }) => void;
    const put = vi.fn(
      () =>
        new Promise<{ ref: string }>((resolve) => {
          resolvePut = resolve;
        }),
    );
    const registry = new AttachmentUploadRegistry({ now: () => 0, putSessionAttachment: put });
    registry.begin(begin(bytes));
    registry.chunk({
      connectionId: "connection-1",
      sessionId: "session-1",
      uploadId: "upload-1",
      chunkIndex: 0,
      dataBase64: bytes.toString("base64"),
    });
    const terminal = {
      connectionId: "connection-1",
      sessionId: "session-1",
      uploadId: "upload-1",
    };
    const first = registry.commit(terminal);
    const second = registry.commit(terminal);
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    resolvePut({ ref: "zcode-artifact://single" });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ref: "zcode-artifact://single" },
      { ref: "zcode-artifact://single" },
    ]);
  });
});
