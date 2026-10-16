import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileWatcherService,
  resolveFileWatchChangedPath,
} from "../src/fileWatcher/fileWatcherService.js";
import { collectServiceMemoryDiagnostics } from "../src/memoryDiagnostics.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-file-watcher-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("fileWatcherService", () => {
  it("resolves a changed child path and keeps unknown watcher paths conservative", () => {
    const watchedPath = resolve("workspace", "slides");
    // 修复原因：旧断言写死 POSIX 路径；产品使用宿主 path.resolve，Windows 会返回盘符与反斜杠。
    expect(resolveFileWatchChangedPath(watchedPath, "deck.pptx")).toBe(
      resolve(watchedPath, "deck.pptx"),
    );
    expect(resolveFileWatchChangedPath(watchedPath, null)).toBeUndefined();
  });

  it("treats a stale watcher subscription as a no-op event", async () => {
    const service = createFileWatcherService();
    const dir = makeTempDir();
    const { id } = await service.watch({ path: dir });

    await service.unwatch({ id });

    let fired = false;
    const subscription = service.onDynamicChange(id)(() => {
      fired = true;
    });
    subscription.dispose();

    expect(fired).toBe(false);
  });

  it("disposes all active watchers and keeps stale ids no-op", async () => {
    const service = createFileWatcherService();
    const firstDir = makeTempDir();
    const secondDir = makeTempDir();
    const first = await service.watch({ path: firstDir });
    const second = await service.watch({ path: secondDir });

    service.disposeAll();
    await service.unwatch(first);
    await service.unwatch(second);

    let fired = false;
    const firstSubscription = service.onDynamicChange(first.id)(() => {
      fired = true;
    });
    const secondSubscription = service.onDynamicChange(second.id)(() => {
      fired = true;
    });
    firstSubscription.dispose();
    secondSubscription.dispose();

    expect(fired).toBe(false);
  });
});

describe("fileWatcher memory diagnostics", () => {
  it("注册 open watcher 计数，disposeAll 后注销", async () => {
    const service = createFileWatcherService();
    expect(collectServiceMemoryDiagnostics()["fileWatcher.open"]).toBe(0);
    await service.watch({ path: makeTempDir() });
    expect(collectServiceMemoryDiagnostics()["fileWatcher.open"]).toBe(1);
    service.disposeAll();
    expect(collectServiceMemoryDiagnostics()["fileWatcher.open"]).toBeUndefined();
  });
});
