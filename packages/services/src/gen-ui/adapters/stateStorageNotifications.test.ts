import { EventEmitter } from "node:events";
import {
  watch,
  type FSWatcher,
  type PathLike,
  type WatchListener,
  type WatchOptions,
} from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createGenUiStateStorage } from "#src/gen-ui/adapters/stateStorage.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, watch: vi.fn() };
});

class ControlledWatcher extends EventEmitter implements FSWatcher {
  close() {
    this.removeAllListeners();
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

it("broadcasts external state once despite duplicate file events and write acknowledgements", async () => {
  const watchers: ControlledWatcher[] = [];
  vi.mocked(watch).mockImplementation(
    (
      _path: PathLike,
      options: WatchOptions | WatchListener<string>,
      listener?: WatchListener<string>,
    ) => {
      const watcher = new ControlledWatcher();
      const onChange = typeof options === "function" ? options : listener;
      if (onChange) watcher.on("change", onChange);
      watchers.push(watcher);
      return watcher;
    },
  );
  const root = await mkdtemp(join(tmpdir(), "gen-ui-state-notifications-"));
  const a = createGenUiStateStorage(root);
  const b = createGenUiStateStorage(root);
  const target = {
    workspacePath: "/workspace",
    sessionId: "task",
    path: "/workspace/chart.html",
  };
  try {
    await a.get(target);
    await b.get(target);
    expect(watchers).toHaveLength(2);
    const receivedA = vi.fn();
    const receivedB = vi.fn();
    a.onChanged(receivedA);
    b.onChanged(receivedB);
    for (const [index, modelContent] of ["selection", "updated selection"].entries()) {
      const state = { modelContent, privateContent: null };
      const changed = new Promise<unknown>((resolve) => {
        const off = a.onChanged((event) => {
          off.dispose();
          resolve(event.state);
        });
      });
      await b.set(target, state);
      // 先读到新快照也不能吞掉其他订阅者的通知；磁盘与写入 ACK 仍走真实实现。
      expect(await a.get(target)).toEqual(state);
      expect(receivedA).toHaveBeenCalledTimes(index);
      const [scopeDirectory] = await readdir(root);
      const [stateFile] = (await readdir(join(root, scopeDirectory!))).filter((name) =>
        name.endsWith(".json"),
      );
      expect(stateFile).toBeDefined();
      // 原用例只等系统首次通知，批量运行时曾悬挂，也未覆盖回声。
      // 显式投递重复事件验证去重；原生 fs.watch 的接线另由串行集成用例覆盖。
      for (const watcher of watchers) {
        watcher.emit("change", "rename", stateFile);
        watcher.emit("change", "change", stateFile);
        watcher.emit("change", "rename", stateFile);
      }
      expect(await changed).toEqual(state);
      // 同值提交的 ACK 排在已投递通知之后，作为队列屏障，不用 sleep 猜测通知是否处理完。
      await Promise.all([a.set(target, state), b.set(target, state)]);
      for (const received of [receivedA, receivedB]) {
        expect(received).toHaveBeenCalledTimes(index + 1);
        expect(received).toHaveBeenLastCalledWith({ target, state });
      }
    }
  } finally {
    a.dispose();
    b.dispose();
    await rm(root, { recursive: true, force: true });
    vi.mocked(watch).mockReset();
  }
});
