import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { IDisposable, Event } from "@zcode/rpc";
import type { ZCodePromptAttachment } from "@zcode/shared";
import {
  REMOTE_PROMPT_ATTACHMENT_ROOT,
  buildRemotePromptAttachmentPath,
  createRemotePromptAttachmentSessionService,
  createRemotePromptAttachmentTaskService,
  materializeRemotePromptAttachments,
} from "../src/host/remotePromptAttachments.js";

function createClosedStream(stdoutText = "") {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const onClose: Event<number> = (
    listener: (code: number) => void,
  ): IDisposable => {
    queueMicrotask(() => {
      if (stdoutText) {
        stdout.write(stdoutText);
      }
      stdout.end();
      listener(0);
    });
    return { dispose() {} };
  };
  return { stdin, stdout, stderr, onClose };
}

describe("remote prompt attachment materialization", () => {
  it("uploads host localPath attachments and rewrites prompt paths", async () => {
    const upload = vi.fn(
      async (_localPath: string, _remotePath: string) => undefined,
    );
    const exec = vi
      .fn()
      .mockResolvedValueOnce(createClosedStream("/home/tester"))
      .mockResolvedValueOnce(createClosedStream())
      .mockResolvedValueOnce(createClosedStream());
    const hostPath =
      "C:\\Users\\tester\\.zcode\\tmp\\paste-attachments\\pasted-text.txt";
    const attachments: ZCodePromptAttachment[] = [
      {
        kind: "file",
        filename: "pasted text.txt",
        localPath: hostPath,
        mimeType: "text/plain",
        sizeBytes: 8192,
        sourceKind: "clipboard-text",
      },
      {
        kind: "image",
        filename: "inline.png",
        mimeType: "image/png",
        dataBase64: "aW1hZ2U=",
        sizeBytes: 5,
      },
    ];

    const result = await materializeRemotePromptAttachments(
      {
        content: `请读取 ${hostPath}`,
        traceId: "trace:abc/123",
        attachments,
      },
      { backend: { exec, upload } },
    );

    const remotePath = upload.mock.calls[0]?.[1] ?? "";
    expect(remotePath).toMatch(
      /^\/home\/tester\/\.zcode\/tmp\/prompt-attachments\/trace-abc-123\/[A-Za-z0-9._-]+\/01-pasted-text\.txt$/,
    );
    expect(upload).toHaveBeenCalledWith(hostPath, remotePath);
    expect(exec.mock.calls[0]?.[0]).toBe('printf %s "$HOME"');
    expect(exec.mock.calls[1]?.[0]).toContain("mkdir -p");
    expect(exec.mock.calls[1]?.[0]).toContain("command chmod 700");
    expect(exec.mock.calls[1]?.[0]).not.toContain('"$HOME"');
    expect(exec.mock.calls[2]?.[0]).toContain("command chmod 600");
    expect(exec.mock.calls[2]?.[0]).not.toContain('"$HOME"');
    expect(result.uploadedCount).toBe(1);
    expect(result.content).toBe(`请读取 ${remotePath}`);
    expect(result.attachments?.[0]).toEqual({
      ...attachments[0],
      localPath: remotePath,
    });
    expect(result.attachments?.[1]).toBe(attachments[1]);
  });

  it("skips attachments that already point at the remote materialization directory", async () => {
    const upload = vi.fn(
      async (_localPath: string, _remotePath: string) => undefined,
    );
    const exec = vi.fn(async (_command: string) => createClosedStream());
    const remotePath = `${REMOTE_PROMPT_ATTACHMENT_ROOT}/trace/01-image.png`;
    const attachments: ZCodePromptAttachment[] = [
      {
        kind: "image",
        filename: "image.png",
        localPath: remotePath,
        mimeType: "image/png",
      },
    ];

    const result = await materializeRemotePromptAttachments(
      { content: remotePath, traceId: "trace", attachments },
      { backend: { exec, upload } },
    );

    expect(exec).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(result.uploadedCount).toBe(0);
    expect(result.attachments).toBe(attachments);
    expect(result.content).toBe(remotePath);
  });

  it("skips attachments that already point at the resolved remote materialization directory", async () => {
    const upload = vi.fn(
      async (_localPath: string, _remotePath: string) => undefined,
    );
    const exec = vi.fn(async (_command: string) => createClosedStream("/home/tester"));
    const remotePath = "/home/tester/.zcode/tmp/prompt-attachments/trace/01-image.png";
    const attachments: ZCodePromptAttachment[] = [
      {
        kind: "image",
        filename: "image.png",
        localPath: remotePath,
        mimeType: "image/png",
      },
    ];

    const result = await materializeRemotePromptAttachments(
      { content: remotePath, traceId: "trace", attachments },
      { backend: { exec, upload } },
    );

    expect(exec).toHaveBeenCalledTimes(1);
    expect(upload).not.toHaveBeenCalled();
    expect(result.uploadedCount).toBe(0);
    expect(result.attachments).toBe(attachments);
    expect(result.content).toBe(remotePath);
  });

  it("fails before sending a prompt with an unreadable host attachment path", async () => {
    const upload = vi.fn(async (_localPath: string, _remotePath: string) => {
      throw new Error("EACCES");
    });
    const exec = vi
      .fn()
      .mockResolvedValueOnce(createClosedStream("/home/tester"))
      .mockResolvedValueOnce(createClosedStream());

    await expect(
      materializeRemotePromptAttachments(
        {
          content: "inspect",
          traceId: "trace",
          attachments: [
            {
              kind: "file",
              filename: "secret.txt",
              localPath: "C:\\secret.txt",
              mimeType: "text/plain",
              sizeBytes: 1,
            },
          ],
        },
        { backend: { exec, upload } },
      ),
    ).rejects.toThrow("远端附件上传失败：secret.txt");
  });

  it("builds private safe remote paths", () => {
    expect(
      buildRemotePromptAttachmentPath({
        filename: "../../api 文档.txt",
        index: 2,
        nonce: "nonce:with/slash",
        traceId: "trace/id:456",
      }),
    ).toBe(
      `${REMOTE_PROMPT_ATTACHMENT_ROOT}/trace-id-456/nonce-with-slash/03-api-.txt`,
    );
  });

  it("materializes desktop-continuous session prompts before calling the remote session service", async () => {
    const remoteAttachment: ZCodePromptAttachment = {
      kind: "file",
      filename: "pasted.txt",
      localPath: "/home/tester/.zcode/tmp/prompt-attachments/input/01-pasted.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      sourceKind: "clipboard-text",
    };
    const sendPrompt = vi.fn(async () => ({ accepted: true }));
    const service = createRemotePromptAttachmentSessionService(
      { sendPrompt },
      {
        materializePromptAttachments: async (params) => ({
          content: params.content.replace("/tmp/host-paste.txt", remoteAttachment.localPath!),
          attachments: [remoteAttachment],
        }),
      },
    );

    await service.sendPrompt({
      sessionId: "task-1",
      inputId: "input-1",
      content: "read /tmp/host-paste.txt",
      attachments: [
        {
          kind: "file",
          filename: "pasted.txt",
          localPath: "/tmp/host-paste.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          sourceKind: "clipboard-text",
        },
      ],
    });

    expect(sendPrompt).toHaveBeenCalledWith({
      sessionId: "task-1",
      inputId: "input-1",
      content:
        "read /home/tester/.zcode/tmp/prompt-attachments/input/01-pasted.txt",
      attachments: [remoteAttachment],
    });
  });

  it("materializes web-remote queued task commands before calling the remote task service", async () => {
    const remoteAttachment: ZCodePromptAttachment = {
      kind: "file",
      filename: "pasted.txt",
      localPath: "/home/tester/.zcode/tmp/prompt-attachments/input/01-pasted.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      sourceKind: "clipboard-text",
    };
    const enqueueTaskCommand = vi.fn(async () => ({ accepted: true }));
    const service = createRemotePromptAttachmentTaskService(
      { enqueueTaskCommand },
      {
        materializePromptAttachments: async (params) => ({
          content: params.content.replace("/tmp/host-paste.txt", remoteAttachment.localPath!),
          attachments: [remoteAttachment],
        }),
      },
    );

    await service.enqueueTaskCommand({
      taskId: "task-1",
      commandId: "command-1",
      traceId: "input-1",
      type: "send_prompt",
      content: "read /tmp/host-paste.txt",
      attachments: [
        {
          kind: "file",
          filename: "pasted.txt",
          localPath: "/tmp/host-paste.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          sourceKind: "clipboard-text",
        },
      ],
    });

    expect(enqueueTaskCommand).toHaveBeenCalledWith({
      taskId: "task-1",
      commandId: "command-1",
      traceId: "input-1",
      type: "send_prompt",
      content:
        "read /home/tester/.zcode/tmp/prompt-attachments/input/01-pasted.txt",
      attachments: [remoteAttachment],
    });
  });
});
