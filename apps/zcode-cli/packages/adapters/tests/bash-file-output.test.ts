import { constants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { openSpy, statSpy } = vi.hoisted(() => ({ openSpy: vi.fn(), statSpy: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  openSpy.mockImplementation(actual.open);
  statSpy.mockImplementation(actual.stat);
  return { ...actual, open: openSpy, stat: statSpy };
});

import { BashFileOutput, readBashOutput } from "../src/exec/bash-file-output.js";

const roots: string[] = [];
const outputs: BashFileOutput[] = [];
afterEach(async () => {
  for (const output of outputs.splice(0)) {
    output.stopWatching();
    await output.close();
  }
  vi.useRealTimers();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(platform: NodeJS.Platform = process.platform) {
  const root = await mkdtemp(join(tmpdir(), "zcode-bash-file-"));
  roots.push(root);
  const path = join(root, "输出 with spaces.log");
  const output = new BashFileOutput(path, platform, null);
  outputs.push(output);
  return { output, path };
}

describe("Bash direct output", () => {
  it.each(["darwin", "linux", "win32"] as const)(
    "uses host %s flags and existing-file semantics",
    async (platform) => {
      const { output, path } = await fixture(platform);
      await writeFile(path, "existing\n");
      await output.prepare();
      const flags =
        platform === "win32"
          ? "w"
          : constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_APPEND |
            (constants.O_NOFOLLOW ?? 0);
      expect(openSpy).toHaveBeenCalledWith(path, flags, 0o600);
      expect(openSpy).toHaveBeenCalledTimes(1);
      await output.close();
      expect(await readFile(path, "utf8")).toBe(platform === "win32" ? "" : "existing\n");
    },
  );

  it("only deletes a file created by this preparation when cancelled", async () => {
    const fresh = await fixture();
    await fresh.output.prepare();
    await fresh.output.discard();
    await expect(readFile(fresh.path)).rejects.toMatchObject({ code: "ENOENT" });
    const existing = await fixture();
    await writeFile(existing.path, "preserved");
    await existing.output.prepare();
    await existing.output.discard();
    expect(await readFile(existing.path, "utf8")).toBe(
      process.platform === "win32" ? "" : "preserved",
    );
  });

  it("does not let descriptor cleanup failure replace cancellation or settlement", async () => {
    const { output, path } = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    openSpy.mockImplementationOnce(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementationOnce(async () => {
        await close();
        throw new Error("close failed");
      });
      return handle;
    });
    await output.prepare();
    await expect(output.discard()).resolves.toBeUndefined();
    expect(output.fd).toBeUndefined();
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads bounded head/tail with full file byte counts and explicit read errors", async () => {
    const { output, path } = await fixture();
    await output.prepare();
    await output.close();
    await writeFile(path, "abcdefgh");
    expect(await readBashOutput(path, 3, false, null)).toMatchObject({
      text: "abc",
      bytes: 8,
      truncated: true,
    });
    expect(await readBashOutput(path, 3, true, null)).toMatchObject({
      text: "fgh",
      bytes: 8,
      truncated: true,
    });
    expect(await output.result(0)).toMatchObject({ text: "", bytes: 8, truncated: true });
    await rm(path);
    expect((await output.result(3)).text).toContain("bash output unavailable");
  });

  it("polls after the foreground delay, reads at most 4 KiB and stops at settlement", async () => {
    const { output, path } = await fixture();
    await output.prepare();
    await output.close();
    const text = Array.from({ length: 500 }, (_, i) => `line-${i + 1}\r\n`).join("");
    await writeFile(path, text);
    openSpy.mockClear();
    const onRead = vi.fn();
    let read!: () => void;
    const first = new Promise<void>((resolve) => {
      read = resolve;
    });
    vi.useFakeTimers();
    output.watchProgress(8192, 2000, 1000, (sample, preview) => {
      onRead(sample, preview);
      read();
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(openSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await first;
    const [sample, preview] = onRead.mock.calls[0]!;
    expect(sample.bytesRead).toBe(4096);
    expect(preview).toMatchObject({ totalBytes: Buffer.byteLength(text), linesEstimated: true });
    expect(preview.text).toContain("line-500");
    expect(preview.text).not.toContain("line-450");
    expect(preview.fullText).toContain("line-450");
    output.stopWatching();
    await vi.advanceTimersByTimeAsync(10000);
    expect(onRead).toHaveBeenCalledTimes(1);
  });

  it("shares the progress interval across files and isolates background handoff", async () => {
    const first = await fixture();
    const second = await fixture();
    for (const fixture of [first, second]) {
      await fixture.output.prepare();
      await fixture.output.close();
    }
    await writeFile(first.path, "first output");
    await writeFile(second.path, "second output");
    const firstRead = vi.fn();
    const secondRead = vi.fn();
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const readFirst = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const readSecond = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    vi.useFakeTimers();
    first.output.watchProgress(4096, 2000, 1000, (sample) => {
      firstRead(sample.text);
      finishFirst();
    });
    await vi.advanceTimersByTimeAsync(500);
    second.output.watchProgress(4096, 2000, 1000, (sample) => {
      secondRead(sample.text);
      finishSecond();
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([readFirst, readSecond]);
    expect(firstRead).toHaveBeenCalledWith("first output");
    expect(secondRead).toHaveBeenCalledWith("second output");
    // 后台提交重启独立的大小 watchdog，只取消本任务的前台订阅。
    first.output.watchLimit(5 * 1024 ** 3, vi.fn());
    expect(vi.getTimerCount()).toBe(2);
    const nextRead = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    await vi.advanceTimersByTimeAsync(1000);
    await nextRead;
    expect(firstRead).toHaveBeenCalledTimes(1);
    expect(secondRead).toHaveBeenCalledTimes(2);
    second.output.stopWatching();
    expect(vi.getTimerCount()).toBe(1);
    first.output.stopWatching();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending subscription before its delay without starting a poller", async () => {
    const { output } = await fixture();
    const onRead = vi.fn();
    openSpy.mockClear();
    vi.useFakeTimers();
    output.watchProgress(4096, 2000, 1000, onRead);
    output.stopWatching();
    await vi.advanceTimersByTimeAsync(10000);
    expect(vi.getTimerCount()).toBe(0);
    expect(openSpy).not.toHaveBeenCalled();
    expect(onRead).not.toHaveBeenCalled();
  });

  it("drops an old file read after progress resubscription", async () => {
    const { output, path } = await fixture();
    await output.prepare();
    await output.close();
    await writeFile(path, "current output");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const gate = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    openSpy.mockImplementationOnce(async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        await close();
        closed.resolve();
      });
      await gate.promise;
      return handle;
    });
    const oldRead = vi.fn();
    const next = Promise.withResolvers<string>();
    vi.useFakeTimers();
    output.watchProgress(4096, 0, 1000, oldRead);
    await vi.advanceTimersByTimeAsync(1000);
    output.watchProgress(4096, 0, 1000, (sample) => next.resolve(sample.text));
    gate.resolve();
    await closed.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(oldRead).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await next.promise).toBe("current output");
  });

  it("checks every five seconds, ignores equality, and restarts at background commit", async () => {
    const { output, path } = await fixture();
    const actualStat = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let size = 5 * 1024 ** 3;
    statSpy.mockImplementation(async (candidate, ...args) =>
      candidate === path ? { size } : actualStat.stat(candidate, ...args),
    );
    const limit = vi.fn();
    vi.useFakeTimers();
    try {
      output.watchLimit(size, limit);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(statSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(limit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      output.watchLimit(size, limit);
      size += 1;
      await vi.advanceTimersByTimeAsync(4_999);
      expect(limit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(limit).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(limit).toHaveBeenCalledTimes(1);
    } finally {
      statSpy.mockImplementation(actualStat.stat);
    }
  });

  it("ignores a late stat result after settlement", async () => {
    const { output } = await fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let finish!: (value: { size: number }) => void;
    statSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const limit = vi.fn();
    vi.useFakeTimers();
    try {
      output.watchLimit(10, limit);
      await vi.advanceTimersByTimeAsync(5_000);
      output.stopWatching();
      finish({ size: 11 });
      await vi.advanceTimersByTimeAsync(0);
      expect(limit).not.toHaveBeenCalled();
    } finally {
      statSpy.mockImplementation(actual.stat);
    }
  });
});
