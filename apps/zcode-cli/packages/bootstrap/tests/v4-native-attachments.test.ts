// L2：M5 附件命令面——AttachmentRef → TurnAttachment 映射（attachment-refs.ts）、
// sendText/createSession 携带附件的 core 调用、active turn queue fallback、
// gateway chunked attachment transaction 的尺寸、顺序、幂等与宿主钩子收口。
// 模式对齐 v4-native-commands.test.ts（fake app/record/host → executor → 断言 core 调用）。
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SessionEventType } from "@zcode/contracts";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import {
  isUriAttachmentRef,
  mapAttachmentRefsToTurnAttachments,
} from "../src/zcode-protocol-v4/commands/attachment-refs.js";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";
import { ConversationV4Gateway } from "../src/zcode-protocol-v4/index.js";

function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    runtime: {
      getSessionModelSelection: () => ({ providerId: "test-provider", modelId: "test-model" }),
    },
    sendInput: vi.fn().mockImplementation(async (_input, options) => {
      options?.onTurnStartedObserved?.({
        id: "event-started",
        type: SessionEventType.TurnStarted,
        payload: { messageId: "msg-event-started" },
      });
      return {
        completion: Promise.resolve({}),
        kind: "started_turn",
        turnId: "turn-1",
      };
    }),
    steerTurn: vi.fn().mockResolvedValue({}),
    enqueueDeferredInput: vi.fn().mockResolvedValue({
      kind: "queued",
      pendingInputId: "pending-1",
      queueLength: 1,
      turnId: "turn-1",
    }),
    readTarget: vi.fn().mockResolvedValue(null),
    updateTargetStatus: vi.fn().mockResolvedValue(null),
    readToolResultArtifact: vi.fn().mockResolvedValue({
      uri: "zcode-artifact://a1",
      content: "data:text/plain;base64,aGVsbG8gd29ybGQ=", // "hello world"
      contentType: "text/plain",
      bytes: 11,
    }),
    ...overrides,
  };
}

function makeRecord(
  overrides: Partial<V4SessionRecordView> & { app?: ReturnType<typeof makeApp> } = {},
): V4SessionRecordView {
  return {
    app: (overrides.app ?? makeApp()) as unknown as V4SessionRecordView["app"],
    workspace: { workspacePath: "/w" },
    persistence: "immediate",
    ...overrides,
  } as V4SessionRecordView;
}

function makeHost(
  record: V4SessionRecordView,
  overrides: Partial<V4CommandCoreHost> = {},
): V4CommandCoreHost {
  return {
    getRecord: (id) => (id === "s1" ? record : undefined),
    afterLegacyStateMutation: async () => {},
    waitForProjectionEventCommit: async () => {},
    ...overrides,
  };
}

function envelope(type: string, payload: unknown): CommandEnvelope {
  return {
    type,
    payload,
    sessionId: "s1",
    commandId: "cmd-1",
    baseRevision: 0,
  } as unknown as CommandEnvelope;
}

async function settle() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

const pathRef = {
  ref: "/tmp/pic.png",
  fileName: "pic.png",
  mime: "image/png",
  bytes: 123,
};

describe("attachment-refs 映射（AttachmentRef → TurnAttachment）", () => {
  it("话题历史 artifact 保留引用，禁止自动解码正文", async () => {
    const app = makeApp();
    const mapped = await mapAttachmentRefsToTurnAttachments(app as never, [
      {
        ref: "zcode-artifact://history",
        fileName: "topic-history.txt",
        mime: "text/plain",
        bytes: 12,
        sourceKind: "topic-history",
      },
    ]);
    expect(mapped).toEqual([
      expect.objectContaining({
        type: "file",
        content: "zcode-artifact://history",
        sourceKind: "topic-history",
      }),
    ]);
    expect(app.readToolResultArtifact).not.toHaveBeenCalled();
  });

  it("本地路径 ref：图片/视频/文件按 mime 分型为 path 引用，展示元信息保真", async () => {
    const app = makeApp() as unknown as V4SessionRecordView["app"];
    const mapped = await mapAttachmentRefsToTurnAttachments(app, [
      pathRef,
      { ref: "/tmp/demo.mp4", fileName: "demo.mp4", mime: "video/mp4", bytes: 456 },
      { ref: "/tmp/report.pdf", fileName: "report.pdf", mime: "application/pdf", bytes: 789 },
      { ref: "/tmp/notes.txt", fileName: "notes.txt", mime: "text/plain", bytes: 9 },
    ]);
    expect(mapped).toEqual([
      {
        path: "/tmp/pic.png",
        type: "image",
        filename: "pic.png",
        mimeType: "image/png",
        sizeBytes: 123,
      },
      {
        path: "/tmp/demo.mp4",
        type: "video",
        filename: "demo.mp4",
        mimeType: "video/mp4",
        sizeBytes: 456,
      },
      {
        path: "/tmp/report.pdf",
        type: "pdf",
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 789,
      },
      {
        path: "/tmp/notes.txt",
        type: "file",
        filename: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 9,
      },
    ]);
  });

  it("PDF artifact URI ref 保留 durable URI，禁止按文本解码", async () => {
    const app = makeApp({
      readToolResultArtifact: vi.fn().mockResolvedValue({
        uri: "zcode-artifact://pdf-1",
        content: "data:application/pdf;base64,JVBERi0xLjQK",
        contentType: "text/plain",
        bytes: 9,
      }),
    }) as unknown as V4SessionRecordView["app"];
    const mapped = await mapAttachmentRefsToTurnAttachments(app, [
      { ref: "zcode-artifact://pdf-1", fileName: "report.pdf", mime: "application/pdf", bytes: 9 },
    ]);

    expect(mapped).toEqual([
      {
        content: "zcode-artifact://pdf-1",
        path: "report.pdf",
        type: "pdf",
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 9,
      },
    ]);
    expect(app.readToolResultArtifact).not.toHaveBeenCalled();
  });

  it("图片/视频 artifact URI ref：content 携带 URI（core 解析链读回，不在命令层内联）", async () => {
    const app = makeApp() as unknown as V4SessionRecordView["app"];
    const mapped = await mapAttachmentRefsToTurnAttachments(app, [
      { ref: "zcode-artifact://img-1", fileName: "shot.png", mime: "image/png", bytes: 42 },
      { ref: "zcode-artifact://video-1", fileName: "demo.mp4", mime: "video/mp4", bytes: 84 },
    ]);
    expect(mapped).toEqual([
      {
        content: "zcode-artifact://img-1",
        path: "shot.png",
        type: "image",
        filename: "shot.png",
        mimeType: "image/png",
        sizeBytes: 42,
      },
      {
        content: "zcode-artifact://video-1",
        path: "demo.mp4",
        type: "video",
        filename: "demo.mp4",
        mimeType: "video/mp4",
        sizeBytes: 84,
      },
    ]);
  });

  it("文本 artifact URI ref：读回并解码为 ≤64KiB 文本内容（旧 decodeTextProtocolAttachment 语义）", async () => {
    const rawApp = makeApp();
    const mapped = await mapAttachmentRefsToTurnAttachments(
      rawApp as unknown as V4SessionRecordView["app"],
      [{ ref: "zcode-artifact://a1", fileName: "paste.txt", mime: "text/plain", bytes: 11 }],
    );
    expect(rawApp.readToolResultArtifact).toHaveBeenCalledWith("zcode-artifact://a1");
    expect(mapped?.[0]).toMatchObject({
      content: "hello world",
      path: "paste.txt",
      type: "file",
    });
  });

  it("超限/读取失败的非图片 artifact ref：降级为仅展示元信息（不让发送整体失败）", async () => {
    const rawApp = makeApp({
      readToolResultArtifact: vi.fn().mockRejectedValue(new Error("gone")),
    });
    const app = rawApp as unknown as V4SessionRecordView["app"];
    const oversized = await mapAttachmentRefsToTurnAttachments(app, [
      {
        ref: "zcode-artifact://big",
        fileName: "big.txt",
        mime: "text/plain",
        bytes: 65 * 1024,
      },
    ]);
    expect(oversized?.[0]).toEqual({
      type: "file",
      filename: "big.txt",
      mimeType: "text/plain",
      sizeBytes: 65 * 1024,
    });
    const unreadable = await mapAttachmentRefsToTurnAttachments(app, [
      { ref: "zcode-artifact://a1", fileName: "gone.txt", mime: "text/plain", bytes: 4 },
    ]);
    expect(unreadable?.[0]).toEqual({
      type: "file",
      filename: "gone.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
    });
  });

  it("空/缺省 → undefined；isUriAttachmentRef 区分 scheme:// 与本地路径（含 Windows 盘符）", async () => {
    const app = makeApp() as unknown as V4SessionRecordView["app"];
    expect(await mapAttachmentRefsToTurnAttachments(app, undefined)).toBeUndefined();
    expect(await mapAttachmentRefsToTurnAttachments(app, [])).toBeUndefined();
    expect(isUriAttachmentRef("zcode-artifact://x")).toBe(true);
    expect(isUriAttachmentRef("/tmp/a.png")).toBe(false);
    // Windows 盘符路径（C:\...）没有 //，不得误判为 URI。
    expect(isUriAttachmentRef("C:\\Users\\a.png")).toBe(false);
  });
});

describe("v4 原生 sendText（附件）", () => {
  it("空闲会话：仅 attachments 也会映射后随 sendInput 提交", async () => {
    const app = makeApp();
    const record = makeRecord({ app });
    await new V4CommandExecutor(makeHost(record)).execute(
      envelope("sendText", { text: "", attachments: [pathRef] }),
    );
    await settle();
    expect(app.sendInput).toHaveBeenCalledWith(
      {
        text: "",
        attachments: [
          {
            path: "/tmp/pic.png",
            type: "image",
            filename: "pic.png",
            mimeType: "image/png",
            sizeBytes: 123,
          },
        ],
      },
      expect.objectContaining({
        inputId: "cmd-1",
        intent: expect.objectContaining({
          sourceCommandId: "cmd-1",
          attachmentRefs: [pathRef],
          requestedDelivery: "startNow",
        }),
      }),
    );
  });

  it("运行中仅附件：同 sourceCommandId/附件回退 CLI queue，不丢 payload", async () => {
    const app = makeApp({
      sendInput: vi.fn().mockResolvedValue({
        kind: "queued",
        pendingInputId: "pending-1",
        queueLength: 1,
        turnId: "turn-1",
      }),
    });
    const record = makeRecord({ app, activeAbortController: new AbortController() });
    await new V4CommandExecutor(makeHost(record, { getInputRoutingMode: () => "guide" })).execute(
      envelope("sendText", { text: "", attachments: [pathRef] }),
    );
    expect(app.sendInput).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "",
        attachments: [expect.objectContaining({ path: "/tmp/pic.png", type: "image" })],
      }),
      expect.objectContaining({
        inputId: "cmd-1",
        intent: expect.objectContaining({
          sourceCommandId: "cmd-1",
          clientId: "cli",
          attachmentRefs: [pathRef],
          requestedDelivery: "guide",
          fallbackReasonCode: "guide.attachmentsUnsupported",
        }),
      }),
    );
    expect(app.steerTurn).not.toHaveBeenCalled();
    expect(app.enqueueDeferredInput).not.toHaveBeenCalled();
  });

  it("正文和附件都为空时统一拒绝", async () => {
    const app = makeApp();
    const record = makeRecord({ app });

    await expect(
      new V4CommandExecutor(makeHost(record)).execute(
        envelope("sendText", { text: "   ", attachments: [] }),
      ),
    ).rejects.toMatchObject({ reasonCode: "proto.invalidPayload" });
    expect(app.sendInput).not.toHaveBeenCalled();
    expect(app.enqueueDeferredInput).not.toHaveBeenCalled();
  });
});

describe("v4 原生 createSession（firstInput 附件）", () => {
  it("仅 firstInput.attachments 也会映射后随首条 turn 提交", async () => {
    const app = makeApp();
    const record = makeRecord({ app, persistence: "deferred" });
    const host = makeHost(record, {
      createSessionRecord: async () => ({ sessionId: "s1" }),
    });
    const result = await new V4CommandExecutor(host).execute(
      envelope("createSession", {
        workspaceId: "/w",
        firstInput: { text: "", attachments: [pathRef] },
      }),
    );
    await settle();
    expect(result).toEqual({
      type: "createSession",
      sessionId: "s1",
      input: {
        delivery: "startNow",
        inputId: "cmd-1",
      },
    });
    expect(app.sendInput).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "",
        attachments: [expect.objectContaining({ path: "/tmp/pic.png", type: "image" })],
      }),
      expect.anything(),
    );
  });
});

describe("gateway v4 chunked attachment transaction", () => {
  function makeGateway(overrides: {
    putSessionAttachment?: (
      sessionId: string,
      input: { fileName: string; mime: string; bytes: Uint8Array },
    ) => Promise<{ ref: string }>;
    readSessionAttachment?: (
      sessionId: string,
      input: {
        ref: string;
        mime: string;
        maxBytes: number;
        messageId?: string;
        attachmentIndex?: number;
      },
    ) => Promise<{ bytes: Uint8Array; mediaType: string }>;
    resolveSessionAttachmentPreviewSource?: (
      sessionId: string,
      input: {
        ref: string;
        mime: string;
        messageId?: string;
        attachmentIndex?: number;
      },
    ) => Promise<{ kind: "local_path"; path: string; mediaType: string } | { kind: "chunked" }>;
  }) {
    return new ConversationV4Gateway({
      sessionExists: (sessionId) => sessionId === "s1",
      emitWireFrame: () => {},
      executeCommand: async () => undefined,
      ...overrides,
    });
  }

  const sha256 = (bytes: Uint8Array) =>
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const begin = (bytes: Uint8Array, overrides: Record<string, unknown> = {}) => ({
    connectionId: "connection-1",
    uploadId: "upload-1",
    sessionId: "s1",
    fileName: "shot.png",
    mime: "image/png",
    totalBytes: bytes.byteLength,
    totalChunks: bytes.byteLength === 0 ? 0 : 1,
    checksum: sha256(bytes),
    ...overrides,
  });

  function ingestAttachmentRow(
    gateway: ConversationV4Gateway,
    attachments: readonly (typeof pathRef)[],
    options: { detached?: boolean } = {},
  ): void {
    type GatewayEvent = Parameters<ConversationV4Gateway["ingest"]>[1];
    const ingest = (event: GatewayEvent) => {
      if (options.detached) gateway.ingestDetachedLiveSession("s1", event);
      else gateway.ingest("s1", event);
    };
    ingest({
      id: "preview-session-created",
      sessionId: "s1",
      type: SessionEventType.SessionCreated,
      timestamp: new Date(1),
      traceId: "trace-preview",
      sequenceNumber: 1,
      payload: { mode: "default", contextWindow: 200_000 },
    } as GatewayEvent);
    ingest({
      id: "preview-turn-started",
      sessionId: "s1",
      turnId: "turn-preview",
      type: SessionEventType.TurnStarted,
      timestamp: new Date(2),
      traceId: "trace-preview",
      sequenceNumber: 2,
      payload: {
        turnNumber: 1,
        input: "preview",
        messageId: "message-preview",
        intent: { attachmentRefs: attachments },
      },
    } as GatewayEvent);
  }

  function ingestAssistantArtifactImage(gateway: ConversationV4Gateway, ref: string): void {
    ingestAttachmentRow(gateway, []);
    type GatewayEvent = Parameters<ConversationV4Gateway["ingest"]>[1];
    gateway.ingest("s1", {
      id: "preview-assistant-text",
      sessionId: "s1",
      turnId: "turn-preview",
      type: SessionEventType.ModelStreaming,
      timestamp: new Date(3),
      traceId: "trace-preview",
      sequenceNumber: 3,
      payload: {
        kind: "text_delta",
        delta: `Screenshot: ![CUA result](${ref})`,
        done: false,
      },
    } as GatewayEvent);
  }

  it("begin/chunk/commit 原子寄存，begin/commit retry 返回同一进度/ref", async () => {
    const bytes = Buffer.from("hello attachment");
    const put = vi.fn().mockResolvedValue({ ref: "zcode-artifact://p1" });
    const gateway = makeGateway({ putSessionAttachment: put });
    await expect(gateway.attachmentBegin(begin(bytes))).resolves.toEqual({
      uploadId: "upload-1",
      state: "staging",
      nextChunkIndex: 0,
    });
    await expect(gateway.attachmentBegin(begin(bytes))).resolves.toEqual({
      uploadId: "upload-1",
      state: "staging",
      nextChunkIndex: 0,
    });
    await expect(
      gateway.attachmentChunk({
        connectionId: "connection-1",
        uploadId: "upload-1",
        sessionId: "s1",
        chunkIndex: 0,
        dataBase64: bytes.toString("base64"),
      }),
    ).resolves.toEqual({ uploadId: "upload-1", nextChunkIndex: 1 });
    const result = await gateway.attachmentCommit({
      connectionId: "connection-1",
      uploadId: "upload-1",
      sessionId: "s1",
    });
    expect(result).toEqual({ ref: "zcode-artifact://p1" });
    await expect(
      gateway.attachmentCommit({
        connectionId: "connection-1",
        uploadId: "upload-1",
        sessionId: "s1",
      }),
    ).resolves.toEqual(result);
    await expect(gateway.attachmentBegin(begin(bytes))).resolves.toEqual({
      uploadId: "upload-1",
      state: "committed",
      nextChunkIndex: 1,
      ref: "zcode-artifact://p1",
    });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith("s1", {
      fileName: "shot.png",
      mime: "image/png",
      bytes: new Uint8Array(bytes),
    });
  });

  it("20MiB+1 在 begin/staging 前拒绝，不触碰宿主钩子", async () => {
    const put = vi.fn();
    const gateway = makeGateway({ putSessionAttachment: put });
    await expect(
      gateway.attachmentBegin(
        begin(new Uint8Array(), {
          totalBytes: 20 * 1024 * 1024 + 1,
          totalChunks: 41,
        }),
      ),
    ).rejects.toThrow();
    expect(put).not.toHaveBeenCalled();
  });

  it("duplicate identical no-op；future/conflicting duplicate 与错误 checksum 明确失败", async () => {
    const bytes = Buffer.from("abcdef");
    const gateway = makeGateway({
      putSessionAttachment: vi.fn().mockResolvedValue({ ref: "zcode-artifact://p1" }),
    });
    await gateway.attachmentBegin(begin(bytes, { totalChunks: 2 }));
    const first = Buffer.from("abc");
    const chunk = {
      connectionId: "connection-1",
      uploadId: "upload-1",
      sessionId: "s1",
      chunkIndex: 0,
      dataBase64: first.toString("base64"),
    };
    await gateway.attachmentChunk(chunk);
    await expect(gateway.attachmentChunk(chunk)).resolves.toEqual({
      uploadId: "upload-1",
      nextChunkIndex: 1,
    });
    await expect(gateway.attachmentChunk({ ...chunk, chunkIndex: 2 })).rejects.toThrow(
      "fault.attachment.chunkGap",
    );
    await expect(
      gateway.attachmentChunk({ ...chunk, dataBase64: Buffer.from("xxx").toString("base64") }),
    ).rejects.toThrow("fault.attachment.chunkConflict");
    await gateway.attachmentChunk({
      ...chunk,
      chunkIndex: 1,
      dataBase64: Buffer.from("def").toString("base64"),
    });
    await expect(
      gateway.attachmentCommit({
        connectionId: "connection-1",
        uploadId: "upload-1",
        sessionId: "s1",
      }),
    ).resolves.toEqual({ ref: "zcode-artifact://p1" });

    const wrong = makeGateway({ putSessionAttachment: vi.fn() });
    await wrong.attachmentBegin(
      begin(bytes, { totalChunks: 2, checksum: `sha256:${"0".repeat(64)}` }),
    );
    await wrong.attachmentChunk(chunk);
    await wrong.attachmentChunk({
      ...chunk,
      chunkIndex: 1,
      dataBase64: Buffer.from("def").toString("base64"),
    });
    await expect(
      wrong.attachmentCommit({
        connectionId: "connection-1",
        uploadId: "upload-1",
        sessionId: "s1",
      }),
    ).rejects.toThrow("fault.attachment.checksumMismatch");
  });

  it("empty upload 可直接 commit；missing/abort/connection close/session close 清 staging", async () => {
    const put = vi.fn().mockResolvedValue({ ref: "zcode-artifact://empty" });
    const gateway = makeGateway({ putSessionAttachment: put });
    await gateway.attachmentBegin(begin(new Uint8Array()));
    await expect(
      gateway.attachmentCommit({
        connectionId: "connection-1",
        uploadId: "upload-1",
        sessionId: "s1",
      }),
    ).resolves.toEqual({ ref: "zcode-artifact://empty" });

    const bytes = Buffer.from("pending");
    await gateway.attachmentBegin(begin(bytes, { uploadId: "abort-me" }));
    await gateway.attachmentAbort({
      connectionId: "connection-1",
      uploadId: "abort-me",
      sessionId: "s1",
    });
    await gateway.attachmentAbort({
      connectionId: "connection-1",
      uploadId: "abort-me",
      sessionId: "s1",
    });
    await expect(
      gateway.attachmentCommit({
        connectionId: "connection-1",
        uploadId: "abort-me",
        sessionId: "s1",
      }),
    ).rejects.toThrow("fault.attachment.uploadNotFound");

    await gateway.attachmentBegin(begin(bytes, { uploadId: "connection-close" }));
    gateway.setConnectionFlowState({ connectionId: "connection-1", state: "closed" });
    await expect(
      gateway.attachmentCommit({
        connectionId: "connection-1",
        uploadId: "connection-close",
        sessionId: "s1",
      }),
    ).rejects.toThrow("fault.attachment.uploadNotFound");

    await gateway.attachmentBegin(begin(bytes, { uploadId: "session-close" }));
    gateway.disposeSession("s1");
    await expect(
      gateway.attachmentCommit({
        connectionId: "connection-1",
        uploadId: "session-close",
        sessionId: "s1",
      }),
    ).rejects.toThrow("fault.attachment.uploadNotFound");
  });

  it("已发送图片按 row/ref 授权分块读取，并复用有界短时缓存", async () => {
    const bytes = Buffer.alloc(PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes + 3, 7);
    const read = vi.fn().mockResolvedValue({ bytes, mediaType: "image/png" });
    const gateway = makeGateway({ readSessionAttachment: read });
    ingestAttachmentRow(gateway, [pathRef]);

    const first = await gateway.attachmentRead({
      sessionId: "s1",
      ref: pathRef.ref,
      offset: 0,
      limit: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
    });
    expect(Buffer.from(first.dataBase64, "base64")).toHaveLength(
      PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
    );
    expect(first).toMatchObject({
      mediaType: "image/png",
      totalBytes: bytes.byteLength,
      nextOffset: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
    });

    await expect(
      gateway.attachmentRead({
        sessionId: "s1",
        ref: pathRef.ref,
        offset: first.nextOffset,
        limit: PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes,
      }),
    ).resolves.toMatchObject({
      dataBase64: Buffer.from(bytes.subarray(-3)).toString("base64"),
      nextOffset: null,
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("s1", {
      ref: pathRef.ref,
      mime: pathRef.mime,
      maxBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
    });
    gateway.dispose();
  });

  it("Share metadata stat 也必须经过 row/index 授权，不能触发任意路径读取", async () => {
    const stat = vi.fn().mockResolvedValue({
      totalBytes: 10,
      mediaType: "text/plain",
    });
    const gateway = makeGateway({ statSessionAttachment: stat });
    ingestAttachmentRow(gateway, [pathRef]);

    await expect(
      gateway.conversationAttachmentStat({
        sessionId: "s1",
        ref: "/tmp/not-authorized.txt",
        target: { rowId: 42, entityId: "not-authorized" },
        attachmentIndex: 0,
      }),
    ).rejects.toThrow("fault.attachment.shareStatNotAuthorized");
    expect(stat).not.toHaveBeenCalled();
    gateway.dispose();
  });
  it.each(["topic-history", "clipboard-text"] as const)(
    "%s 文本按权威行授权预览，拒绝其他行及引用",
    async (sourceKind) => {
      const bytes = Buffer.from("Sender: 群成员 | open_id: ou_member\n原文第二行");
      const attachment = {
        ref: "zcode-artifact://history",
        fileName: "history.txt",
        mime: "text/plain",
        bytes: bytes.length,
        sourceKind,
      };
      const read = vi.fn().mockResolvedValue({ bytes, mediaType: "text/plain" });
      const gateway = makeGateway({ readSessionAttachment: read });
      ingestAttachmentRow(gateway, [attachment]);
      const request = {
        sessionId: "s1",
        ref: attachment.ref,
        target: { rowId: 2, entityId: "message-preview" },
        attachmentIndex: 0,
        offset: 0,
        limit: 1000,
      };
      await expect(gateway.attachmentRead(request)).resolves.toMatchObject({
        dataBase64: bytes.toString("base64"),
        nextOffset: null,
      });
      await expect(
        gateway.attachmentRead({
          ...request,
          target: { ...request.target, entityId: "other-message" },
        }),
      ).rejects.toThrow("fault.attachment.previewRefNotAuthorized");
      await expect(
        gateway.attachmentRead({ ...request, ref: "/tmp/arbitrary.txt" }),
      ).rejects.toThrow("fault.attachment.previewRefNotAuthorized");
      expect(read).toHaveBeenCalledTimes(1);
      gateway.dispose();
    },
  );

  it("legacy ref-only 读取在 durable previewRef 存在时不回退原始路径", async () => {
    const attachment = {
      ...pathRef,
      previewRef: "zcode-artifact://preview-image",
    };
    const bytes = Buffer.from("persisted-image");
    const read = vi.fn().mockResolvedValue({ bytes, mediaType: "image/png" });
    const gateway = makeGateway({ readSessionAttachment: read });
    ingestAttachmentRow(gateway, [attachment]);

    await expect(
      gateway.attachmentRead({
        sessionId: "s1",
        ref: attachment.ref,
        offset: 0,
        limit: 100,
      }),
    ).rejects.toThrow("fault.attachment.previewRefNotAuthorized");
    expect(read).not.toHaveBeenCalled();

    await expect(
      gateway.attachmentRead({
        sessionId: "s1",
        ref: attachment.previewRef,
        offset: 0,
        limit: 100,
      }),
    ).resolves.toMatchObject({
      dataBase64: bytes.toString("base64"),
      mediaType: "image/png",
      nextOffset: null,
    });
    expect(read).toHaveBeenCalledWith("s1", {
      ref: attachment.previewRef,
      mime: attachment.mime,
      maxBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
    });
    gateway.dispose();
  });

  it("只授权当前 session 助手 Markdown 中真实出现的图片 artifact", async () => {
    const ref = "zcode-artifact://s1/cua-shot";
    const read = vi.fn().mockResolvedValue({
      bytes: Buffer.from("cua-image"),
      mediaType: "image/png",
    });
    const gateway = makeGateway({ readSessionAttachment: read });
    ingestAssistantArtifactImage(gateway, ref);

    await expect(
      gateway.attachmentRead({ sessionId: "s1", ref, offset: 0, limit: 100 }),
    ).resolves.toMatchObject({
      dataBase64: Buffer.from("cua-image").toString("base64"),
      mediaType: "image/png",
      nextOffset: null,
    });
    await expect(
      gateway.attachmentRead({
        sessionId: "s1",
        ref: "zcode-artifact://s1/not-in-markdown",
        offset: 0,
        limit: 100,
      }),
    ).rejects.toThrow("fault.attachment.previewRefNotAuthorized");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("s1", {
      ref,
      mime: "image/*",
      maxBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
    });
    gateway.dispose();
  });

  it("已发送视频按 row 身份和附件序号授权，并把持久消息锚点交给宿主", async () => {
    const video = {
      ref: "/tmp/demo.mov",
      previewRef: "zcode-artifact://preview-video",
      fileName: "demo.mov",
      mime: "video/quicktime",
      bytes: 8,
    };
    // 修复原因：video 全局 preview 上限已从 100MiB 收敛到 30MiB；样本只需越过
    // V4 upload 20MiB 边界来证明已发送预览读取不复用上传上限。
    const bytes = Buffer.alloc(PROTOCOL_V4_LIMITS.attachmentMaxBytes + 1, 9);
    expect(bytes.byteLength).toBeLessThanOrEqual(PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes);
    const read = vi.fn().mockResolvedValue({
      bytes,
      mediaType: "video/quicktime",
    });
    const gateway = makeGateway({ readSessionAttachment: read });
    ingestAttachmentRow(gateway, [pathRef, video]);

    const first = await gateway.attachmentRead({
      sessionId: "s1",
      ref: video.ref,
      target: { rowId: 2, entityId: "message-preview" },
      attachmentIndex: 1,
      offset: 0,
      limit: 100,
    });
    expect(first).toMatchObject({
      dataBase64: Buffer.from(bytes.subarray(0, 100)).toString("base64"),
      mediaType: "video/quicktime",
      totalBytes: bytes.byteLength,
      nextOffset: 100,
    });
    await gateway.attachmentRead({
      sessionId: "s1",
      ref: video.ref,
      target: { rowId: 2, entityId: "message-preview" },
      attachmentIndex: 1,
      offset: first.nextOffset!,
      limit: 100,
    });
    expect(read).toHaveBeenCalledWith("s1", {
      ref: video.ref,
      mime: video.mime,
      maxBytes: PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes,
      messageId: "message-preview",
      attachmentIndex: 1,
    });
    expect(read).toHaveBeenCalledTimes(1);

    await expect(
      gateway.attachmentRead({
        sessionId: "s1",
        ref: video.ref,
        target: { rowId: 2, entityId: "another-message" },
        attachmentIndex: 1,
        offset: 0,
        limit: 100,
      }),
    ).rejects.toThrow("fault.attachment.previewRefNotAuthorized");
    gateway.dispose();
  });

  it("已发送 PDF 按 row 身份授权并通过 chunk 读取", async () => {
    const pdf = {
      ref: "zcode-artifact://preview-pdf",
      fileName: "report.pdf",
      mime: "application/pdf; charset=binary",
      bytes: 13,
    };
    const bytes = Buffer.from("%PDF-1.7\nbody");
    const read = vi.fn().mockResolvedValue({ bytes, mediaType: "application/pdf" });
    const gateway = makeGateway({ readSessionAttachment: read });
    ingestAttachmentRow(gateway, [pathRef, pdf]);

    await expect(
      gateway.attachmentRead({
        sessionId: "s1",
        ref: pdf.ref,
        target: { rowId: 2, entityId: "message-preview" },
        attachmentIndex: 1,
        offset: 0,
        limit: 100,
      }),
    ).resolves.toMatchObject({
      dataBase64: bytes.toString("base64"),
      mediaType: "application/pdf",
      totalBytes: bytes.byteLength,
      nextOffset: null,
    });
    expect(read).toHaveBeenCalledWith("s1", {
      ref: pdf.ref,
      mime: pdf.mime,
      maxBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
      messageId: "message-preview",
      attachmentIndex: 1,
    });
    await expect(
      gateway.attachmentRead({
        sessionId: "s1",
        ref: pdf.ref,
        target: { rowId: 2, entityId: "wrong-message" },
        attachmentIndex: 1,
        offset: 0,
        limit: 100,
      }),
    ).rejects.toThrow("fault.attachment.previewRefNotAuthorized");
    gateway.dispose();
  });

  it("Desktop local sent video reuses exact authorization before returning a local source", async () => {
    const video = {
      ref: "/tmp/demo.mov",
      previewRef: "zcode-artifact://preview-video",
      fileName: "demo.mov",
      mime: "video/quicktime",
      bytes: 8,
    };
    const resolveSource = vi.fn().mockResolvedValue({
      kind: "local_path",
      path: "/tmp/.zcode/video-cache/demo.mov",
      mediaType: "video/quicktime",
    });
    const gateway = makeGateway({ resolveSessionAttachmentPreviewSource: resolveSource });
    ingestAttachmentRow(gateway, [pathRef, video]);

    await expect(
      gateway.attachmentPreviewSource({
        sessionId: "s1",
        ref: video.ref,
        target: { rowId: 2, entityId: "message-preview" },
        attachmentIndex: 1,
        clientMode: "desktop-continuous",
      }),
    ).resolves.toEqual({
      kind: "local_path",
      path: "/tmp/.zcode/video-cache/demo.mov",
      mediaType: "video/quicktime",
    });
    expect(resolveSource).toHaveBeenCalledWith("s1", {
      ref: video.ref,
      mime: video.mime,
      messageId: "message-preview",
      attachmentIndex: 1,
    });
    await expect(
      gateway.attachmentPreviewSource({
        sessionId: "s1",
        ref: video.ref,
        target: { rowId: 2, entityId: "wrong-message" },
        attachmentIndex: 1,
        clientMode: "desktop-continuous",
      }),
    ).rejects.toThrow("fault.attachment.previewRefNotAuthorized");
    gateway.dispose();
  });

  it("local source query leaves images and web-remote video on the chunked path", async () => {
    const resolveSource = vi.fn();
    const gateway = makeGateway({ resolveSessionAttachmentPreviewSource: resolveSource });
    const video = {
      ref: "/tmp/demo.mp4",
      fileName: "demo.mp4",
      mime: "video/mp4",
      bytes: 8,
    };
    ingestAttachmentRow(gateway, [pathRef, video]);

    await expect(
      gateway.attachmentPreviewSource({
        sessionId: "s1",
        ref: pathRef.ref,
        target: { rowId: 2, entityId: "message-preview" },
        attachmentIndex: 0,
        clientMode: "desktop-continuous",
      }),
    ).resolves.toEqual({ kind: "chunked" });
    await expect(
      gateway.attachmentPreviewSource({
        sessionId: "s1",
        ref: video.ref,
        target: { rowId: 2, entityId: "message-preview" },
        attachmentIndex: 1,
        clientMode: "web-remote-replayable",
      }),
    ).resolves.toEqual({ kind: "chunked" });
    expect(resolveSource).not.toHaveBeenCalled();
    gateway.dispose();
  });

  it("拒绝助手 Markdown 引用其他 session 的 artifact", async () => {
    const foreignRef = "zcode-artifact://s2/cua-shot";
    const read = vi.fn().mockResolvedValue({
      bytes: Buffer.from("foreign-cua-image"),
      mediaType: "image/png",
    });
    const gateway = makeGateway({ readSessionAttachment: read });
    ingestAssistantArtifactImage(gateway, foreignRef);

    await expect(
      gateway.attachmentRead({
        sessionId: "s1",
        ref: foreignRef,
        offset: 0,
        limit: 100,
      }),
    ).rejects.toThrow("fault.attachment.previewRefNotAuthorized");
    expect(read).not.toHaveBeenCalled();
    gateway.dispose();
  });

  it("同一原始路径跨轮预览按各自持久消息隔离缓存", async () => {
    type GatewayEvent = Parameters<ConversationV4Gateway["ingest"]>[1];
    const video = {
      ref: "/tmp/reused.mp4",
      fileName: "reused.mp4",
      mime: "video/mp4",
      bytes: 1,
    };
    const read = vi.fn(async (_sessionId: string, input: { messageId?: string }) => ({
      bytes: Buffer.from(input.messageId ?? "missing"),
      mediaType: "video/mp4",
    }));
    const gateway = makeGateway({ readSessionAttachment: read });
    ingestAttachmentRow(gateway, [{ ...video, previewRef: "zcode-artifact://first" }]);
    gateway.ingest("s1", {
      id: "preview-turn-complete",
      sessionId: "s1",
      turnId: "turn-preview",
      type: SessionEventType.TurnComplete,
      timestamp: new Date(3),
      traceId: "trace-preview",
      sequenceNumber: 3,
      payload: {
        response: "done",
        tokenCount: 0,
        toolCallCount: 0,
        duration: 1,
        resultType: "success",
      },
    } as GatewayEvent);
    gateway.ingest("s1", {
      id: "preview-turn-started-2",
      sessionId: "s1",
      turnId: "turn-preview-2",
      type: SessionEventType.TurnStarted,
      timestamp: new Date(4),
      traceId: "trace-preview-2",
      sequenceNumber: 4,
      payload: {
        turnNumber: 2,
        input: "preview again",
        messageId: "message-preview-2",
        intent: {
          attachmentRefs: [{ ...video, previewRef: "zcode-artifact://second" }],
        },
      },
    } as GatewayEvent);

    const first = await gateway.attachmentRead({
      sessionId: "s1",
      ref: video.ref,
      target: { rowId: 2, entityId: "message-preview" },
      attachmentIndex: 0,
      offset: 0,
      limit: 100,
    });
    const second = await gateway.attachmentRead({
      sessionId: "s1",
      ref: video.ref,
      target: { rowId: 4, entityId: "message-preview-2" },
      attachmentIndex: 0,
      offset: 0,
      limit: 100,
    });

    expect(Buffer.from(first.dataBase64, "base64").toString()).toBe("message-preview");
    expect(Buffer.from(second.dataBase64, "base64").toString()).toBe("message-preview-2");
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenNthCalledWith(
      1,
      "s1",
      expect.objectContaining({ messageId: "message-preview", attachmentIndex: 0 }),
    );
    expect(read).toHaveBeenNthCalledWith(
      2,
      "s1",
      expect.objectContaining({ messageId: "message-preview-2", attachmentIndex: 0 }),
    );
    gateway.dispose();
  });

  it("app restart 冷恢复先恢复 session/persisted row，再授权 previewRef", async () => {
    type GatewayEvent = Parameters<ConversationV4Gateway["ingest"]>[1];
    const attachment = { ...pathRef, previewRef: "zcode-artifact://preview-cold" };
    const persistedEvents = [
      {
        id: "cold-session-created",
        sessionId: "s1",
        type: SessionEventType.SessionCreated,
        timestamp: new Date(1),
        traceId: "trace-cold",
        sequenceNumber: 1,
        payload: { mode: "default", contextWindow: 200_000 },
      } as GatewayEvent,
      {
        id: "cold-turn-started",
        sessionId: "s1",
        turnId: "turn-cold",
        type: SessionEventType.TurnStarted,
        timestamp: new Date(2),
        traceId: "trace-cold",
        sequenceNumber: 2,
        payload: {
          turnNumber: 1,
          input: "cold preview",
          intent: { attachmentRefs: [attachment] },
        },
      } as GatewayEvent,
    ];
    let sessionExists = false;
    const resumePersistedSession = vi.fn(async () => {
      sessionExists = true;
      return { status: "resumed" as const };
    });
    const read = vi.fn().mockResolvedValue({
      bytes: Buffer.from("cold-image"),
      mediaType: "image/png",
    });
    const gateway = new ConversationV4Gateway({
      sessionExists: () => sessionExists,
      resumePersistedSession,
      loadPersistedEvents: async () => ({ events: persistedEvents, synthesized: true }),
      emitWireFrame: () => {},
      executeCommand: async () => undefined,
      readSessionAttachment: read,
    });

    await expect(
      gateway.attachmentRead({
        sessionId: "s1",
        ref: attachment.previewRef,
        offset: 0,
        limit: 100,
      }),
    ).resolves.toMatchObject({
      dataBase64: Buffer.from("cold-image").toString("base64"),
      mediaType: "image/png",
      nextOffset: null,
    });
    expect(resumePersistedSession).toHaveBeenCalledWith("s1", undefined);
    expect(read).toHaveBeenCalledWith("s1", {
      ref: attachment.previewRef,
      mime: "image/png",
      maxBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
    });
    gateway.dispose();
  });

  it("detached projection hydration 不替代 attachment 所需的 host activation", async () => {
    let sessionExists = false;
    let releaseHydration!: () => void;
    let markHydrationStarted!: () => void;
    const hydrationStarted = new Promise<void>((resolve) => {
      markHydrationStarted = resolve;
    });
    const hydrationGate = new Promise<void>((resolve) => {
      releaseHydration = resolve;
    });
    const resumePersistedSession = vi.fn(async () => {
      sessionExists = true;
      return { status: "resumed" as const };
    });
    const read = vi.fn().mockResolvedValue({
      bytes: Buffer.from("detached-image"),
      mediaType: "image/png",
    });
    const gateway = new ConversationV4Gateway({
      sessionExists: () => sessionExists,
      resumePersistedSession,
      loadPersistedEvents: async () => {
        markHydrationStarted();
        await hydrationGate;
        return { events: [], synthesized: false };
      },
      emitWireFrame: () => {},
      executeCommand: async () => undefined,
      readSessionAttachment: read,
    });
    ingestAttachmentRow(gateway, [pathRef], { detached: true });

    const subscribing = gateway.subscribe({
      topic: "conversation/s1",
      connectionId: "connection-detached",
      clientMode: "desktop-continuous",
    });
    await hydrationStarted;
    const reading = gateway.attachmentRead({
      sessionId: "s1",
      ref: pathRef.ref,
      offset: 0,
      limit: 100,
    });

    try {
      await Promise.resolve();
      expect(resumePersistedSession).toHaveBeenCalledWith("s1", undefined);
      releaseHydration();
      await expect(reading).resolves.toMatchObject({
        dataBase64: Buffer.from("detached-image").toString("base64"),
      });
      await subscribing;
    } finally {
      releaseHydration();
      await Promise.allSettled([subscribing, reading]);
      gateway.dispose();
    }
  });

  it("非 image/video、跨行 ref 与越界读取在宿主文件系统前拒绝", async () => {
    const read = vi.fn().mockResolvedValue({ bytes: Buffer.from("png"), mediaType: "image/png" });
    const gateway = makeGateway({ readSessionAttachment: read });
    ingestAttachmentRow(gateway, [
      pathRef,
      { ref: "/tmp/note.txt", fileName: "note.txt", mime: "text/plain", bytes: 4 },
    ]);

    await expect(
      gateway.attachmentRead({
        sessionId: "s1",
        ref: "/tmp/note.txt",
        offset: 0,
        limit: 100,
      }),
    ).rejects.toThrow("fault.attachment.previewRefNotAuthorized");
    await expect(
      gateway.attachmentRead({
        sessionId: "s1",
        ref: "/tmp/foreign.png",
        offset: 0,
        limit: 100,
      }),
    ).rejects.toThrow("fault.attachment.previewRefNotAuthorized");
    expect(read).not.toHaveBeenCalled();

    await gateway.attachmentRead({ sessionId: "s1", ref: pathRef.ref, offset: 0, limit: 100 });
    await expect(
      gateway.attachmentRead({ sessionId: "s1", ref: pathRef.ref, offset: 4, limit: 100 }),
    ).rejects.toThrow("fault.attachment.previewRangeInvalid");
    gateway.dispose();
  });
});
