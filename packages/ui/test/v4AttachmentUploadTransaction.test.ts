import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import {
  ATTACHMENT_UPLOAD_CHUNK_BYTES,
  measureAttachmentChannelRequestBytes,
  uploadAttachmentTransaction,
  type AttachmentUploadAgent,
} from "../src/v4/attachmentUploadTransaction.js";

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", { value: webcrypto });
}

function input(bytes: Uint8Array) {
  return {
    sessionId: "session-1",
    fileName: "payload.bin",
    mime: "application/octet-stream",
    dataBase64: Buffer.from(bytes).toString("base64"),
  };
}

function agent(overrides: Partial<AttachmentUploadAgent> = {}): AttachmentUploadAgent {
  return {
    attachmentBeginV4: vi.fn(async (params) => ({
      uploadId: params.uploadId,
      state: "staging" as const,
      nextChunkIndex: 0,
    })),
    attachmentChunkV4: vi.fn(async (params) => ({
      uploadId: params.uploadId,
      nextChunkIndex: params.chunkIndex + 1,
    })),
    attachmentCommitV4: vi.fn(async () => ({ ref: "zcode-artifact://upload/one" })),
    attachmentAbortV4: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("v4 attachment upload transaction", () => {
  it("20MiB exactly 分片成功，所有真实 Channel request <=1MiB", async () => {
    const bytes = new Uint8Array(PROTOCOL_V4_LIMITS.attachmentMaxBytes);
    const service = agent();
    await expect(
      uploadAttachmentTransaction(
        service,
        {
          workspacePath: "/workspace/含多字节路径",
          workspaceIdentity: "remote:ssh:test:/workspace/含多字节路径",
        },
        input(bytes),
      ),
    ).resolves.toEqual({ ref: "zcode-artifact://upload/one" });

    const expectedChunks = Math.ceil(bytes.byteLength / ATTACHMENT_UPLOAD_CHUNK_BYTES);
    expect(service.attachmentChunkV4).toHaveBeenCalledTimes(expectedChunks);
    for (const [params] of vi.mocked(service.attachmentChunkV4).mock.calls) {
      expect(Buffer.from(params.dataBase64, "base64").byteLength).toBeLessThanOrEqual(
        PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
      );
      expect(measureAttachmentChannelRequestBytes("attachmentChunkV4", params)).toBeLessThanOrEqual(
        PROTOCOL_V4_LIMITS.maxFrameBytes,
      );
    }
    const begin = vi.mocked(service.attachmentBeginV4).mock.calls[0][0];
    expect(begin.checksum).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
    expect(begin.totalBytes).toBe(PROTOCOL_V4_LIMITS.attachmentMaxBytes);
  });

  it("20MiB+1 在 begin 前拒绝", async () => {
    const service = agent();
    await expect(
      uploadAttachmentTransaction(
        service,
        { workspacePath: "/workspace" },
        input(new Uint8Array(PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1)),
      ),
    ).rejects.toThrow("proto.payloadTooLarge");
    expect(service.attachmentBeginV4).not.toHaveBeenCalled();
  });

  it("非法 base64 在 begin 前拒绝", async () => {
    const service = agent();
    await expect(
      uploadAttachmentTransaction(
        service,
        { workspacePath: "/workspace" },
        {
          ...input(new Uint8Array()),
          dataBase64: "%%%=",
        },
      ),
    ).rejects.toThrow("proto.invalidBase64");
    expect(service.attachmentBeginV4).not.toHaveBeenCalled();
  });

  it("chunk 失败 abort，但不修改调用者持有的 attachment payload", async () => {
    const original = input(Buffer.from("preserve me"));
    const service = agent({
      attachmentChunkV4: vi.fn(async () => {
        throw new Error("fault.injected");
      }),
    });
    await expect(
      uploadAttachmentTransaction(service, { workspacePath: "/workspace" }, original),
    ).rejects.toThrow("fault.injected");
    expect(service.attachmentAbortV4).toHaveBeenCalledTimes(1);
    expect(original).toEqual(input(Buffer.from("preserve me")));
  });

  it("begin retry 已 committed 时直接复用 ref，不重复 chunk/artifact", async () => {
    const service = agent({
      attachmentBeginV4: vi.fn(async (params) => ({
        uploadId: params.uploadId,
        state: "committed" as const,
        nextChunkIndex: 1,
        ref: "zcode-artifact://upload/existing",
      })),
    });
    await expect(
      uploadAttachmentTransaction(
        service,
        { workspacePath: "/workspace" },
        input(Buffer.from("already there")),
      ),
    ).resolves.toEqual({ ref: "zcode-artifact://upload/existing" });
    expect(service.attachmentChunkV4).not.toHaveBeenCalled();
    expect(service.attachmentCommitV4).not.toHaveBeenCalled();
  });

  it("分块进度单调递增，并在 commit 前切换为 committing", async () => {
    const bytes = new Uint8Array(ATTACHMENT_UPLOAD_CHUNK_BYTES * 2 + 7);
    const service = agent();
    const progress: Array<{
      phase: "uploading" | "committing";
      uploadedBytes: number;
      totalBytes: number;
    }> = [];

    await uploadAttachmentTransaction(service, { workspacePath: "/workspace" }, input(bytes), {
      onProgress: (value) => progress.push(value),
    });

    expect(progress.at(-1)).toEqual({
      phase: "committing",
      uploadedBytes: bytes.byteLength,
      totalBytes: bytes.byteLength,
    });
    expect(progress.some((value) => value.phase === "uploading")).toBe(true);
    const uploadedBytes = progress.map((value) => value.uploadedBytes);
    const sortedUploadedBytes = progress.map((value) => value.uploadedBytes).sort((a, b) => a - b);
    expect(uploadedBytes).toEqual(sortedUploadedBytes);
    expect(progress.filter((value) => value.phase === "uploading").at(-1)?.uploadedBytes).toBe(
      bytes.byteLength,
    );
  });

  it("AbortSignal 在分块之间取消并调用 abort，不进入 commit", async () => {
    const controller = new AbortController();
    const service = agent({
      attachmentChunkV4: vi.fn(async (params) => {
        controller.abort();
        return {
          uploadId: params.uploadId,
          nextChunkIndex: params.chunkIndex + 1,
        };
      }),
    });

    await expect(
      uploadAttachmentTransaction(
        service,
        { workspacePath: "/workspace" },
        input(new Uint8Array(ATTACHMENT_UPLOAD_CHUNK_BYTES + 1)),
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(service.attachmentChunkV4).toHaveBeenCalledTimes(1);
    expect(service.attachmentCommitV4).not.toHaveBeenCalled();
    expect(service.attachmentAbortV4).toHaveBeenCalledTimes(1);
  });
});
