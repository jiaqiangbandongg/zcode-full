import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Event, IDisposable } from "@zcode/rpc";
import type { RemoteUploadOptions } from "@zcode/server/remote";
import { createRemotePromptAttachmentTransferService } from "../src/host/promptAttachmentTransferService.js";

function createClosedStream(stdoutText = "") {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const onClose: Event<number> = (listener: (code: number) => void): IDisposable => {
    queueMicrotask(() => {
      if (stdoutText) stdout.write(stdoutText);
      stdout.end();
      listener(0);
    });
    return { dispose() {} };
  };
  return { stdin, stdout, stderr, onClose };
}

function createExec() {
  return vi.fn(async (command: string) =>
    createClosedStream(command === 'printf %s "$HOME"' ? "/home/tester" : ""),
  );
}

function stageParams(operationId = "attachment-1") {
  return {
    operationId,
    sessionId: "session-1",
    workspacePath: "/workspace",
    workspaceIdentity: "remote:ssh:host:/workspace",
    remoteSessionId: "remote-session-1",
    localPath: "/Users/tester/image.png",
    fileName: "image.png",
    mime: "image/png",
    sizeBytes: 100,
  };
}

describe("remote prompt attachment transfer service", () => {
  it("上报单调上传进度，按 workspace/session identity 暂存并可 adopt", async () => {
    const exec = createExec();
    const upload = vi.fn(
      async (_localPath: string, _remotePath: string, options?: RemoteUploadOptions) => {
        options?.onProgress?.({ uploadedBytes: 20, totalBytes: 100 });
        options?.onProgress?.({ uploadedBytes: 75, totalBytes: 100 });
        // SFTP 回退 exec 时底层计数可能从 0 重新开始，host 不得让 UI 进度倒退。
        options?.onProgress?.({ uploadedBytes: 50, totalBytes: 100 });
        options?.onProgress?.({ uploadedBytes: 100, totalBytes: 100 });
      },
    );
    const service = createRemotePromptAttachmentTransferService({ exec, upload });
    const progress: Array<{ phase: string; uploadedBytes: number }> = [];
    const subscription = service.onDynamicProgress("attachment-1")((event) => {
      progress.push({ phase: event.phase, uploadedBytes: event.uploadedBytes });
    });

    const result = await service.stage(stageParams());
    await service.adopt("attachment-1");
    await service.cleanup("attachment-1");
    subscription.dispose();

    expect(result.ref).toContain("/remote-ssh-host-workspace-remote-session-1-attachment-1/");
    expect(progress.map((event) => event.uploadedBytes)).toEqual([20, 75, 100, 100, 100]);
    expect(progress.map((event) => event.phase)).toEqual([
      "uploading",
      "uploading",
      "uploading",
      "committing",
      "complete",
    ]);
    expect(exec.mock.calls.some(([command]) => String(command).startsWith("rm -f "))).toBe(false);
  });

  it("cancel 中止正在上传的 backend，并让 stage 进入 canceled", async () => {
    const exec = createExec();
    const upload = vi.fn(
      async (_localPath: string, _remotePath: string, options?: RemoteUploadOptions) =>
        new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            const error = new Error("canceled");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const service = createRemotePromptAttachmentTransferService({ exec, upload });
    const phases: string[] = [];
    service.onDynamicProgress("attachment-2")((event) => phases.push(event.phase));

    const staging = service.stage(stageParams("attachment-2"));
    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await service.cancel("attachment-2");

    await expect(staging).rejects.toThrow("远端附件上传失败");
    expect(phases).toContain("canceled");
    expect(vi.mocked(upload).mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  });

  it("未 adopt 的 ready 暂存内容在 cleanup 时立即删除", async () => {
    const exec = createExec();
    const upload = vi.fn(async () => {});
    const service = createRemotePromptAttachmentTransferService({ exec, upload });

    await service.stage(stageParams("attachment-3"));
    await service.cleanup("attachment-3");

    expect(exec.mock.calls.some(([command]) => String(command).startsWith("rm -f "))).toBe(true);
  });
});
