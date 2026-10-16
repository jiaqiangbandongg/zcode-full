import { describe, expect, it, vi } from "vitest";
import { uploadBotGroupAttachments } from "../src/zcode-agent/groupAttachmentUpload.js";

describe("group attachment transaction", () => {
  it("does not release history refs until the target commits the text bytes", async () => {
    let complete!: (value: { ref: string }) => void;
    const committed = new Promise<{ ref: string }>((resolve) => {
      complete = resolve;
    });
    const agent = {
      attachmentBeginV4: vi.fn(async () => ({ state: "uploading", nextChunkIndex: 0 })),
      attachmentChunkV4: vi.fn(async (_params: { dataBase64: string }) => ({ nextChunkIndex: 1 })),
      attachmentCommitV4: vi.fn(() => committed),
      attachmentAbortV4: vi.fn(),
    };
    let released = false;
    const upload = uploadBotGroupAttachments(
      agent as never,
      { sessionId: "task", workspacePath: "/work" },
      [
        {
          kind: "file",
          filename: "history.txt",
          mimeType: "text/plain",
          sourceKind: "topic-history",
          messageCount: 1,
          textContent: "北京\n历史原文",
          sizeBytes: 19,
        },
      ],
    ).then((refs) => {
      released = true;
      return refs;
    });
    await vi.waitFor(() => expect(agent.attachmentCommitV4).toHaveBeenCalledOnce());
    expect(released).toBe(false);
    expect(
      Buffer.from(agent.attachmentChunkV4.mock.calls[0]![0].dataBase64, "base64").toString(),
    ).toBe("北京\n历史原文");
    complete({ ref: "zcode-artifact://history" });
    expect(await upload).toEqual([
      expect.objectContaining({ ref: "zcode-artifact://history", sourceKind: "topic-history" }),
    ]);
  });

  it("aborts a cancelled upload before committing it", async () => {
    const controller = new AbortController();
    const agent = {
      attachmentBeginV4: vi.fn(async () => ({ state: "uploading", nextChunkIndex: 0 })),
      attachmentChunkV4: vi.fn(async () => {
        controller.abort();
        return { nextChunkIndex: 1 };
      }),
      attachmentCommitV4: vi.fn(),
      attachmentAbortV4: vi.fn(async () => undefined),
    };
    await expect(
      uploadBotGroupAttachments(
        agent as never,
        { workspacePath: "/work", sessionId: "task" },
        [
          {
            kind: "file",
            filename: "a.txt",
            mimeType: "text/plain",
            sizeBytes: 3,
            dataBase64: "YWJj",
          },
        ],
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(agent.attachmentCommitV4).not.toHaveBeenCalled();
    expect(agent.attachmentAbortV4).toHaveBeenCalledOnce();
  });
  it("commits a content reference on the target runtime before admission", async () => {
    const agent = {
      attachmentBeginV4: vi.fn(async () => ({ state: "uploading", nextChunkIndex: 0 })),
      attachmentChunkV4: vi.fn(async () => ({ nextChunkIndex: 1 })),
      attachmentCommitV4: vi.fn(async () => ({ ref: "zcode-artifact://file" })),
      attachmentAbortV4: vi.fn(async () => undefined),
    };
    const refs = await uploadBotGroupAttachments(
      agent as never,
      {
        workspacePath: "/work",
        workspaceIdentity: "ssh://host/work",
        remoteSessionId: "remote",
        sessionId: "task",
      },
      [
        {
          kind: "file",
          filename: "a.txt",
          sourceKind: "topic-history",
          messageCount: 2,
          mimeType: "text/plain",
          sizeBytes: 3,
          dataBase64: "YWJj",
        },
      ],
    );
    expect(refs[0]?.ref).toBe("zcode-artifact://file");
    expect(refs[0]).toMatchObject({ sourceKind: "topic-history", messageCount: 2 });
    expect(agent.attachmentBeginV4).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceIdentity: "ssh://host/work",
        remoteSessionId: "remote",
        totalBytes: 3,
        checksum: expect.stringMatching(/^sha256:/),
      }),
    );
  });

  it("aborts on chunk failure instead of submitting incomplete data", async () => {
    const agent = {
      attachmentBeginV4: vi.fn(async () => ({ state: "uploading", nextChunkIndex: 0 })),
      attachmentChunkV4: vi.fn(async () => {
        throw new Error("offline");
      }),
      attachmentCommitV4: vi.fn(),
      attachmentAbortV4: vi.fn(async () => undefined),
    };
    await expect(
      uploadBotGroupAttachments(agent as never, { workspacePath: "/work", sessionId: "task" }, [
        { kind: "image", filename: "a.png", mimeType: "image/png", dataBase64: "YWJj" },
      ]),
    ).rejects.toThrow("offline");
    expect(agent.attachmentAbortV4).toHaveBeenCalledOnce();
    expect(agent.attachmentCommitV4).not.toHaveBeenCalled();
  });
});
