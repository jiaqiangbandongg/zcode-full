import { access, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordBrowserVideo,
  type BrowserWebmRecorderFactory,
} from "../src/main/browserView/browserVideoRecorder.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-browser-recorder-test-"));
  tempRoots.push(root);
  return root;
}

describe("browserVideoRecorder", () => {
  it("用内置 recorder 直接产出 WebM，并在停止前切换到 finalizing", async () => {
    const root = await createTempRoot();
    const targetFrame = { routingId: 7 };
    const phases: string[] = [];
    const onCaptureComplete = vi.fn();
    const stop = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const createRecorder: BrowserWebmRecorderFactory = vi.fn(async (input) => {
      expect(input).toMatchObject({
        outputPath: expect.stringMatching(/recording-1\.webm$/u),
        targetFrame,
        viewport: { width: 1280, height: 720 },
        fps: 25,
      });
      await writeFile(input.outputPath, Buffer.from("webm-bytes"));
      return { stop, cancel };
    });
    const now = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_120);

    const result = await recordBrowserVideo({
      targetFrame,
      tempRoot: root,
      recordingId: "recording-1",
      viewport: { width: 1280, height: 720 },
      fps: 25,
      signal: new AbortController().signal,
      executeScenario: vi.fn(async () => undefined),
      onPhase: (phase) => phases.push(phase),
      onCaptureComplete,
      createRecorder,
      now,
    });

    expect(result).toEqual({
      path: join(root, "recording-1.webm"),
      mimeType: "video/webm",
      width: 1280,
      height: 720,
      fps: 25,
      durationMs: 120,
      frameCount: 3,
    });
    expect(phases).toEqual(["capturing", "finalizing"]);
    expect(onCaptureComplete).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("场景执行失败时取消 recorder 并删除不完整 WebM", async () => {
    const root = await createTempRoot();
    const outputPath = join(root, "recording-fail.webm");
    const cancel = vi.fn(async () => undefined);
    const createRecorder: BrowserWebmRecorderFactory = async () => {
      await writeFile(outputPath, Buffer.from("partial"));
      return { stop: vi.fn(async () => undefined), cancel };
    };

    await expect(
      recordBrowserVideo({
        targetFrame: {},
        tempRoot: root,
        recordingId: "recording-fail",
        viewport: { width: 800, height: 600 },
        fps: 25,
        signal: new AbortController().signal,
        executeScenario: async () => {
          throw new Error("scenario failed");
        },
        createRecorder,
      }),
    ).rejects.toThrow("scenario failed");

    expect(cancel).toHaveBeenCalledOnce();
    await expect(access(outputPath)).rejects.toThrow();
  });

  it("recorder 没有写出有效数据时不伪造 artifact", async () => {
    const root = await createTempRoot();
    const createRecorder: BrowserWebmRecorderFactory = async ({ outputPath }) => {
      await writeFile(outputPath, Buffer.alloc(0));
      return {
        stop: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
      };
    };

    await expect(
      recordBrowserVideo({
        targetFrame: {},
        tempRoot: root,
        recordingId: "recording-empty",
        viewport: { width: 800, height: 600 },
        fps: 25,
        signal: new AbortController().signal,
        executeScenario: async () => undefined,
        createRecorder,
      }),
    ).rejects.toThrow("Browser recording produced an empty WebM artifact");
  });
});
