// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { Emitter } from "@zcode/rpc";
import type { IFileWatcherService } from "@zcode/services";
import type { FileWatchEvent } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import {
  shouldReloadPptxPreviewForWatchEvent,
  usePptxFileWatch,
} from "@/hooks/usePptxFileWatch.js";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

function createFileWatcherHarness() {
  const emitter = new Emitter<FileWatchEvent>();
  const watch = vi.fn(async () => ({ id: "watch-1" }));
  const unwatch = vi.fn(async () => {});
  const service = {
    watch,
    unwatch,
    disposeAll: vi.fn(),
    onDynamicChange: vi.fn(() => emitter.event),
  } satisfies IFileWatcherService;
  return { emitter, service, unwatch, watch };
}

describe("usePptxFileWatch", () => {
  it("先建立父目录订阅再允许首读，并只为目标或未知路径增加重载 generation", async () => {
    const { emitter, service, watch } = createFileWatcherHarness();
    const hook = renderHook(() =>
      usePptxFileWatch({
        filePath: "/workspace/slides/deck.pptx",
        fileWatcherService: service,
      }),
    );

    expect(hook.result.current.ready).toBe(false);
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    expect(watch).toHaveBeenCalledWith({ path: "/workspace/slides" });
    expect(hook.result.current.reloadGeneration).toBe(0);

    act(() => {
      emitter.fire({
        dirPath: "/workspace/slides",
        changedPath: "/workspace/slides/notes.txt",
      });
    });
    expect(hook.result.current.reloadGeneration).toBe(0);

    act(() => {
      emitter.fire({
        dirPath: "/workspace/slides",
        changedPath: "/workspace/slides/deck.pptx",
      });
    });
    expect(hook.result.current.reloadGeneration).toBe(1);

    act(() => emitter.fire({ dirPath: "/workspace/slides" }));
    expect(hook.result.current.reloadGeneration).toBe(2);
  });

  it("切换 source 和卸载时释放旧 watcher，watch 失败时仍允许基础读取", async () => {
    const first = createFileWatcherHarness();
    const second = createFileWatcherHarness();
    second.service.watch = vi.fn(async () => {
      throw new Error("watch unavailable");
    });

    const hook = renderHook(
      ({ filePath, fileWatcherService }) =>
        usePptxFileWatch({ filePath, fileWatcherService }),
      {
        initialProps: {
          filePath: "/workspace/first.pptx",
          fileWatcherService: first.service,
        },
      },
    );
    await waitFor(() => expect(hook.result.current.ready).toBe(true));

    hook.rerender({
      filePath: "/remote/second.pptx",
      fileWatcherService: second.service,
    });
    expect(hook.result.current.ready).toBe(false);
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    await waitFor(() =>
      expect(first.unwatch).toHaveBeenCalledWith({ id: "watch-1" }),
    );

    hook.unmount();
    expect(second.service.unwatch).not.toHaveBeenCalled();
  });

  it("同一路径切换 watcher service 时不会复用旧 service 的 ready 状态", async () => {
    const first = createFileWatcherHarness();
    const second = createFileWatcherHarness();
    second.service.watch = vi.fn(() => new Promise(() => {}));
    const observedReadyStates: boolean[] = [];

    const hook = renderHook(
      ({ fileWatcherService }) => {
        const result = usePptxFileWatch({
          filePath: "/workspace/deck.pptx",
          fileWatcherService,
        });
        observedReadyStates.push(result.ready);
        return result;
      },
      {
        initialProps: { fileWatcherService: first.service },
      },
    );
    await waitFor(() => expect(hook.result.current.ready).toBe(true));

    observedReadyStates.length = 0;
    hook.rerender({ fileWatcherService: second.service });

    // Bug 根因：远程重连会在 source path 不变时替换 workspace service。
    // 新 watcher 尚未 ready 的首帧不能复用旧 service 的 ready=true，否则读取会抢在订阅前发生。
    expect(observedReadyStates[0]).toBe(false);
    expect(hook.result.current.ready).toBe(false);
    await waitFor(() => expect(first.unwatch).toHaveBeenCalledWith({ id: "watch-1" }));
  });
});

describe("shouldReloadPptxPreviewForWatchEvent", () => {
  it("兼容 Windows 分隔符、盘符大小写和旧 Host 的目录级事件", () => {
    expect(
      shouldReloadPptxPreviewForWatchEvent(
        { dirPath: "C:\\Workspace", changedPath: "c:\\workspace\\Deck.pptx" },
        "C:\\Workspace\\Deck.pptx",
      ),
    ).toBe(true);
    expect(
      shouldReloadPptxPreviewForWatchEvent(
        { dirPath: "/workspace" },
        "/workspace/deck.pptx",
      ),
    ).toBe(true);
  });
});
