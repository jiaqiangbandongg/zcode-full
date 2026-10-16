import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeBrowserRecordingArtifact } from "../src/host/browserRecordingArtifactMaterializer.js";

const tempRoots: string[] = [];
const artifact = {
  path: "/main/tmp/recording.webm",
  mimeType: "video/webm" as const,
  width: 1280,
  height: 720,
  fps: 25,
  durationMs: 1_000,
  frameCount: 25,
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("browserRecordingArtifactMaterializer", () => {
  it("原子覆盖工作区内已有 WebM，并返回实际绝对路径", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-recording-materialize-"));
    tempRoots.push(root);
    const source = join(root, "source.webm");
    await writeFile(source, "new-video");
    await writeFile(join(root, "demo.webm"), "old-video");

    const result = await materializeBrowserRecordingArtifact({
      artifact,
      localPath: source,
      outputPath: "demo.webm",
      workspacePath: root,
    });

    expect(result.path).toBe(join(root, "demo.webm"));
    await expect(readFile(result.path, "utf8")).resolves.toBe("new-video");
  });

  it("拒绝本地和远端 outputPath 越出 workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-recording-materialize-"));
    tempRoots.push(root);
    await expect(
      materializeBrowserRecordingArtifact({
        artifact,
        localPath: join(root, "source.webm"),
        outputPath: "../escape.webm",
        workspacePath: root,
      }),
    ).rejects.toThrow("inside the workspace");

    await expect(
      materializeBrowserRecordingArtifact({
        artifact,
        localPath: join(root, "source.webm"),
        outputPath: "../escape.webm",
        workspacePath: "/remote/repo",
        remoteSessionId: "ssh:one",
        remoteBackend: { upload: vi.fn() },
      }),
    ).rejects.toThrow("inside the remote workspace");
  });

  it("本地和远端 materializer 都拒绝旧 MP4 扩展名", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-recording-materialize-"));
    tempRoots.push(root);
    await expect(
      materializeBrowserRecordingArtifact({
        artifact,
        localPath: join(root, "source.webm"),
        outputPath: "recordings/legacy.mp4",
        workspacePath: root,
      }),
    ).rejects.toThrow("must end with .webm");

    await expect(
      materializeBrowserRecordingArtifact({
        artifact,
        localPath: join(root, "source.webm"),
        outputPath: "recordings/legacy.mp4",
        workspacePath: "/remote/repo",
        remoteSessionId: "ssh:one",
        remoteBackend: { upload: vi.fn() },
      }),
    ).rejects.toThrow("must end with .webm");
  });

  it("远端 workspace 复用 backend.upload，不把 main 临时路径暴露给 Agent", async () => {
    const upload = vi.fn(async () => undefined);
    const result = await materializeBrowserRecordingArtifact({
      artifact,
      localPath: "/main/tmp/recording.webm",
      outputPath: "recordings/demo.webm",
      workspacePath: "/remote/repo",
      remoteSessionId: "ssh:one",
      remoteBackend: { upload },
    });

    expect(upload).toHaveBeenCalledWith(
      "/main/tmp/recording.webm",
      "/remote/repo/recordings/demo.webm",
    );
    expect(result.path).toBe("/remote/repo/recordings/demo.webm");
  });
});
