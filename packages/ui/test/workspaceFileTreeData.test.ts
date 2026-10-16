import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import type { FileEntry, FileWatchEvent, GitRefreshResult } from "@zcode/shared";
import { ServiceProvider } from "@/hooks/useServices.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import {
  WORKSPACE_FILE_TREE_REFRESH_DIRECTORY_TIMEOUT_MS,
  WORKSPACE_FILE_TREE_REFRESH_GIT_TIMEOUT_MS,
} from "@/workspace-file-tree/constants.js";
import { useWorkspaceFileTreeData } from "@/workspace-file-tree/useWorkspaceFileTreeData.js";

const WORKSPACE_PATH = "/workspace";
const SRC_PATH = "/workspace/src";
const NEXT_WORKSPACE_PATH = "/next-workspace";

type FileTreeDataResult = ReturnType<typeof useWorkspaceFileTreeData>;

function file(path: string): FileEntry {
  return {
    name: path.split("/").pop() ?? path,
    path,
    type: "file",
  };
}

function directory(path: string): FileEntry {
  return {
    name: path.split("/").pop() ?? path,
    path,
    type: "directory",
  };
}

function createGitRefreshResult(
  workspacePath = WORKSPACE_PATH,
  unstagedChanges: GitRefreshResult["unstagedChanges"] = [],
): GitRefreshResult {
  return {
    branchComparison: null,
    identity: null,
    stagedChanges: [],
    summary: {
      ahead: 0,
      autoRefreshWatchPaths: [],
      behind: 0,
      branchName: null,
      headRefType: "branch",
      isDirty: false,
      isGitAvailable: true,
      isRepository: true,
      repoRoot: workspacePath,
      trackingBranchName: null,
      workspaceInRepoPath: ".",
      workspacePath,
    },
    unstagedChanges,
  };
}

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    clearTimeout,
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
    setTimeout,
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock);
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function flushReactWork() {
  await act(async () => {
    await flushMicrotasks();
  });
}

function createWorkspaceFileTreeHarness(initialEntriesByDirectory: Record<string, FileEntry[]>) {
  const entriesByDirectory = new Map(Object.entries(initialEntriesByDirectory));
  const watcherListeners = new Map<string, (event: FileWatchEvent) => void>();
  const watchedPathById = new Map<string, string>();
  let currentWorkspacePath = WORKSPACE_PATH;
  let latestResult: FileTreeDataResult | null = null;

  const services = {
    fileService: {
      readdir: vi.fn(async ({ path }: { path: string }) => entriesByDirectory.get(path) ?? []),
    },
    fileWatcherService: {
      onDynamicChange: (id: string) => (listener: (event: FileWatchEvent) => void) => {
        watcherListeners.set(id, listener);
        return {
          dispose() {
            watcherListeners.delete(id);
          },
        };
      },
      unwatch: vi.fn(async ({ id }: { id: string }) => {
        watcherListeners.delete(id);
        watchedPathById.delete(id);
      }),
      watch: vi.fn(async ({ path }: { path: string }) => {
        const id = `watch:${path}`;
        watchedPathById.set(id, path);
        return { id };
      }),
    },
    gitService: {
      getIgnoredPaths: vi.fn(async () => []),
      refresh: vi.fn(async () => createGitRefreshResult()),
    },
  } as unknown as IServiceAccessor;

  function Probe() {
    latestResult = useWorkspaceFileTreeData({
      workspacePath: currentWorkspacePath,
    });
    return null;
  }

  const root: Root = createRoot(installMinimalDom());
  const render = async () => {
    await act(async () => {
      root.render(
        createElement(
          ServiceProvider,
          { services },
          createElement(TabStoreProvider, null, createElement(Probe)),
        ),
      );
      await flushMicrotasks();
    });
  };

  return {
    entriesByDirectory,
    get latestResult() {
      if (!latestResult) {
        throw new Error("file tree hook result is not ready");
      }
      return latestResult;
    },
    root,
    services,
    async fireWatcherChange(path: string) {
      const watcherId = [...watchedPathById.entries()].find(
        ([, watchedPath]) => watchedPath === path,
      )?.[0];
      if (!watcherId) {
        throw new Error(`missing watcher for ${path}`);
      }
      await act(async () => {
        watcherListeners.get(watcherId)?.({ dirPath: path });
        vi.advanceTimersByTime(300);
        await flushMicrotasks();
      });
    },
    render,
    async setWorkspacePath(path: string) {
      currentWorkspacePath = path;
      await render();
    },
    setDirectoryEntries(path: string, entries: FileEntry[]) {
      entriesByDirectory.set(path, entries);
    },
    watchedPaths() {
      return [...watchedPathById.values()];
    },
  };
}

describe("useWorkspaceFileTreeData", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  it("实时刷新展开目录里的新增文件，不需要重启 ZCode", async () => {
    vi.useFakeTimers();
    const harness = createWorkspaceFileTreeHarness({
      [WORKSPACE_PATH]: [directory(SRC_PATH)],
      [SRC_PATH]: [file(`${SRC_PATH}/old.ts`)],
    });

    await harness.render();
    await act(async () => {
      await harness.latestResult.loadDirectory(SRC_PATH, 1);
      harness.latestResult.setExpandedPaths(new Set([SRC_PATH]));
      await flushMicrotasks();
    });
    await flushReactWork();

    expect(harness.latestResult.rows.map((row) => row.path)).toContain(
      `${SRC_PATH}/old.ts`,
    );

    harness.setDirectoryEntries(SRC_PATH, [file(`${SRC_PATH}/new.ts`)]);
    await harness.fireWatcherChange(SRC_PATH);

    expect(harness.services.fileService.readdir).toHaveBeenCalledWith({
      includeHidden: true,
      path: SRC_PATH,
    });
    expect(harness.latestResult.rows.map((row) => row.path)).toEqual([
      SRC_PATH,
      `${SRC_PATH}/new.ts`,
    ]);

    act(() => {
      harness.root.unmount();
    });
  });

  it("目录折叠后释放 watcher，避免已加载目录持续占用监听资源", async () => {
    const harness = createWorkspaceFileTreeHarness({
      [WORKSPACE_PATH]: [directory(SRC_PATH)],
      [SRC_PATH]: [file(`${SRC_PATH}/old.ts`)],
    });

    await harness.render();
    await act(async () => {
      await harness.latestResult.loadDirectory(SRC_PATH, 1);
      harness.latestResult.setExpandedPaths(new Set([SRC_PATH]));
      await flushMicrotasks();
    });
    await flushReactWork();

    expect(harness.watchedPaths()).toEqual(
      expect.arrayContaining([WORKSPACE_PATH, SRC_PATH]),
    );

    await act(async () => {
      harness.latestResult.setExpandedPaths(new Set());
      await flushMicrotasks();
    });
    await flushReactWork();

    expect(harness.watchedPaths()).toEqual([WORKSPACE_PATH]);
    expect(harness.latestResult.loadedDirectoryPaths.has(SRC_PATH)).toBe(true);

    act(() => {
      harness.root.unmount();
    });
  });

  it("点击刷新会重读已加载子目录，清掉重命名后的旧文件缓存", async () => {
    const harness = createWorkspaceFileTreeHarness({
      [WORKSPACE_PATH]: [directory(SRC_PATH)],
      [SRC_PATH]: [file(`${SRC_PATH}/old.ts`)],
    });

    await harness.render();
    await act(async () => {
      await harness.latestResult.loadDirectory(SRC_PATH, 1);
      harness.latestResult.setExpandedPaths(new Set([SRC_PATH]));
      await flushMicrotasks();
    });
    await flushReactWork();

    harness.setDirectoryEntries(SRC_PATH, [file(`${SRC_PATH}/renamed.ts`)]);
    await act(async () => {
      await harness.latestResult.refreshLoadedDirectories();
      await flushMicrotasks();
    });
    await flushReactWork();

    expect(harness.latestResult.rows.map((row) => row.path)).toEqual([
      SRC_PATH,
      `${SRC_PATH}/renamed.ts`,
    ]);
    expect(harness.latestResult.rows.map((row) => row.path)).not.toContain(
      `${SRC_PATH}/old.ts`,
    );

    act(() => {
      harness.root.unmount();
    });
  });

  it("根目录手动刷新失败时保留旧文件树和错误状态", async () => {
    const rootRefreshError = new Error("remote host disconnected");
    const harness = createWorkspaceFileTreeHarness({
      [WORKSPACE_PATH]: [directory(SRC_PATH)],
      [SRC_PATH]: [file(`${SRC_PATH}/old.ts`)],
    });

    await harness.render();
    await act(async () => {
      await harness.latestResult.loadDirectory(SRC_PATH, 1);
      harness.latestResult.setExpandedPaths(new Set([SRC_PATH]));
      await flushMicrotasks();
    });
    await flushReactWork();

    harness.services.fileService.readdir = vi.fn(
      async ({ path }: { path: string }) => {
        if (path === WORKSPACE_PATH) {
          throw rootRefreshError;
        }
        return harness.entriesByDirectory.get(path) ?? [];
      },
    );

    await act(async () => {
      await harness.latestResult.refreshLoadedDirectories();
      await flushMicrotasks();
    });
    await flushReactWork();

    expect(harness.latestResult.refreshingLoadedDirectories).toBe(false);
    expect(harness.latestResult.loadedDirectoryPaths.has(WORKSPACE_PATH)).toBe(
      true,
    );
    expect(harness.latestResult.errorByDirectory.get(WORKSPACE_PATH)).toBe(
      rootRefreshError,
    );
    expect(harness.latestResult.rows.map((row) => row.path)).toEqual([
      SRC_PATH,
      `${SRC_PATH}/old.ts`,
    ]);

    act(() => {
      harness.root.unmount();
    });
  });

  it("目录刷新永不返回时会释放刷新锁并允许再次刷新", async () => {
    vi.useFakeTimers();
    const harness = createWorkspaceFileTreeHarness({
      [WORKSPACE_PATH]: [directory(SRC_PATH)],
    });

    await harness.render();
    await flushReactWork();

    harness.services.fileService.readdir = vi.fn(
      async ({ path }: { path: string }) => {
        if (path === WORKSPACE_PATH) {
          await new Promise<void>(() => {});
        }
        return harness.entriesByDirectory.get(path) ?? [];
      },
    );

    let refreshPromise: Promise<void> | undefined;
    await act(async () => {
      refreshPromise = harness.latestResult.refreshLoadedDirectories();
      await flushMicrotasks();
    });
    expect(harness.latestResult.refreshingLoadedDirectories).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(WORKSPACE_FILE_TREE_REFRESH_DIRECTORY_TIMEOUT_MS);
      await refreshPromise;
      await flushMicrotasks();
    });
    await flushReactWork();

    expect(harness.latestResult.refreshingLoadedDirectories).toBe(false);
    expect(harness.latestResult.errorByDirectory.get(WORKSPACE_PATH)?.message)
      .toContain("timed out");
    expect(harness.latestResult.rows.map((row) => row.path)).toEqual([
      SRC_PATH,
    ]);

    harness.services.fileService.readdir = vi.fn(
      async ({ path }: { path: string }) =>
        harness.entriesByDirectory.get(path) ?? [],
    );
    await act(async () => {
      await harness.latestResult.refreshLoadedDirectories();
      await flushMicrotasks();
    });
    await flushReactWork();

    expect(harness.latestResult.refreshingLoadedDirectories).toBe(false);
    expect(harness.latestResult.errorByDirectory.has(WORKSPACE_PATH)).toBe(
      false,
    );
    expect(harness.latestResult.rows.map((row) => row.path)).toEqual([
      SRC_PATH,
    ]);

    act(() => {
      harness.root.unmount();
    });
  });

  it("Git 状态刷新永不返回时不会卡住文件树刷新锁", async () => {
    vi.useFakeTimers();
    const harness = createWorkspaceFileTreeHarness({
      [WORKSPACE_PATH]: [directory(SRC_PATH)],
    });

    await harness.render();
    await flushReactWork();

    harness.services.gitService.refresh = vi.fn(async () => {
      await new Promise<void>(() => {});
      return createGitRefreshResult();
    });

    let refreshPromise: Promise<void> | undefined;
    await act(async () => {
      refreshPromise = harness.latestResult.refreshLoadedDirectories();
      await flushMicrotasks();
    });
    expect(harness.latestResult.refreshingLoadedDirectories).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(WORKSPACE_FILE_TREE_REFRESH_GIT_TIMEOUT_MS);
      await refreshPromise;
      await flushMicrotasks();
    });
    await flushReactWork();

    expect(harness.latestResult.refreshingLoadedDirectories).toBe(false);

    harness.services.gitService.refresh = vi.fn(async () =>
      createGitRefreshResult(),
    );
    await act(async () => {
      await harness.latestResult.refreshLoadedDirectories();
      await flushMicrotasks();
    });
    await flushReactWork();

    expect(harness.latestResult.refreshingLoadedDirectories).toBe(false);
    expect(harness.latestResult.gitStatusAvailable).toBe(true);

    act(() => {
      harness.root.unmount();
    });
  });

  it("silent force 抢占非 silent 加载后会清理目录 loading 状态", async () => {
    const harness = createWorkspaceFileTreeHarness({
      [WORKSPACE_PATH]: [directory(SRC_PATH)],
    });
    let rootReadCount = 0;
    let releaseInitialRootReaddir: (() => void) | null = null;
    let releaseRefreshRootReaddir: (() => void) | null = null;
    harness.services.fileService.readdir = vi.fn(
      async ({ path }: { path: string }) => {
        if (path === WORKSPACE_PATH) {
          rootReadCount += 1;
          if (rootReadCount === 1) {
            await new Promise<void>((resolve) => {
              releaseInitialRootReaddir = resolve;
            });
          }
          if (rootReadCount === 2) {
            await new Promise<void>((resolve) => {
              releaseRefreshRootReaddir = resolve;
            });
          }
        }
        return harness.entriesByDirectory.get(path) ?? [];
      },
    );

    await harness.render();
    expect(harness.latestResult.loadingDirectoryPaths.has(WORKSPACE_PATH)).toBe(
      true,
    );

    let refreshPromise: Promise<void> | undefined;
    await act(async () => {
      refreshPromise = harness.latestResult.refreshLoadedDirectories();
      await flushMicrotasks();
    });

    releaseInitialRootReaddir?.();
    releaseRefreshRootReaddir?.();
    await act(async () => {
      await refreshPromise;
      await flushMicrotasks();
    });
    await flushReactWork();

    expect(harness.latestResult.loadingDirectoryPaths.has(WORKSPACE_PATH)).toBe(
      false,
    );
    expect(harness.latestResult.refreshingLoadedDirectories).toBe(false);

    act(() => {
      harness.root.unmount();
    });
  });

  it("切换 workspace 后，旧手动刷新 worker 不再消费剩余目录", async () => {
    const loadedDirectories = Array.from(
      { length: 6 },
      (_, index) => `${WORKSPACE_PATH}/dir-${index}`,
    );
    const harness = createWorkspaceFileTreeHarness({
      [WORKSPACE_PATH]: loadedDirectories.map(directory),
      [NEXT_WORKSPACE_PATH]: [],
    });

    await harness.render();
    await act(async () => {
      harness.latestResult.setLoadedDirectoryPaths(
        new Set([WORKSPACE_PATH, ...loadedDirectories]),
      );
      await flushMicrotasks();
    });
    await flushReactWork();

    const releaseBlockedReads: (() => void)[] = [];
    const readsAfterWorkspaceSwitch: string[] = [];
    let switchedWorkspace = false;
    harness.services.fileService.readdir = vi.fn(
      async ({ path }: { path: string }) => {
        if (path.startsWith(WORKSPACE_PATH)) {
          if (switchedWorkspace) {
            readsAfterWorkspaceSwitch.push(path);
          }
          if (releaseBlockedReads.length < 4) {
            await new Promise<void>((resolve) => {
              releaseBlockedReads.push(resolve);
            });
          }
          return [file(`${path}/stale.ts`)];
        }
        return harness.entriesByDirectory.get(path) ?? [];
      },
    );

    let refreshPromise: Promise<void> | undefined;
    await act(async () => {
      refreshPromise = harness.latestResult.refreshLoadedDirectories();
      await flushMicrotasks();
    });
    expect(releaseBlockedReads).toHaveLength(2);

    switchedWorkspace = true;
    await harness.setWorkspacePath(NEXT_WORKSPACE_PATH);
    for (const releaseBlockedRead of releaseBlockedReads) {
      releaseBlockedRead();
    }
    await act(async () => {
      await refreshPromise;
      await flushMicrotasks();
    });
    await flushReactWork();

    expect(readsAfterWorkspaceSwitch).toEqual([]);
    expect(harness.latestResult.loadedDirectoryPaths.has(WORKSPACE_PATH)).toBe(
      false,
    );
    expect(harness.latestResult.rows.map((row) => row.path)).toEqual([]);

    act(() => {
      harness.root.unmount();
    });
  });

  it("目录裁剪后同路径重建时，删除前的旧请求不能覆盖新快照", async () => {
    vi.useFakeTimers();
    const oldFilePath = `${SRC_PATH}/old.ts`;
    const newFilePath = `${SRC_PATH}/new.ts`;
    const harness = createWorkspaceFileTreeHarness({
      [WORKSPACE_PATH]: [directory(SRC_PATH)],
      [SRC_PATH]: [file(oldFilePath)],
    });

    await harness.render();
    await act(async () => {
      harness.latestResult.setExpandedPaths(new Set([SRC_PATH]));
      await flushMicrotasks();
    });
    await flushReactWork();

    let srcReadCount = 0;
    let releaseDeletedDirectoryRead: (() => void) | null = null;
    harness.services.fileService.readdir = vi.fn(
      async ({ path }: { path: string }) => {
        if (path === SRC_PATH) {
          srcReadCount += 1;
          if (srcReadCount === 1) {
            await new Promise<void>((resolve) => {
              releaseDeletedDirectoryRead = resolve;
            });
            return [file(oldFilePath)];
          }
          if (srcReadCount === 2) {
            throw new Error("directory was replaced");
          }
          return [file(newFilePath)];
        }
        return harness.entriesByDirectory.get(path) ?? [];
      },
    );

    let staleLoadPromise: Promise<unknown> | undefined;
    await act(async () => {
      staleLoadPromise = harness.latestResult.loadDirectory(SRC_PATH, 1, {
        force: true,
        silent: true,
      });
      await flushMicrotasks();
    });

    await harness.fireWatcherChange(SRC_PATH);
    await act(async () => {
      await harness.latestResult.loadDirectory(SRC_PATH, 1, {
        force: true,
        silent: true,
      });
      harness.latestResult.setExpandedPaths(new Set([SRC_PATH]));
      await flushMicrotasks();
    });
    await flushReactWork();

    expect(harness.latestResult.rows.map((row) => row.path)).toEqual([
      SRC_PATH,
      newFilePath,
    ]);

    releaseDeletedDirectoryRead?.();
    await act(async () => {
      await staleLoadPromise;
      await flushMicrotasks();
    });
    await flushReactWork();

    expect(harness.latestResult.rows.map((row) => row.path)).toEqual([
      SRC_PATH,
      newFilePath,
    ]);
    expect(harness.latestResult.rows.map((row) => row.path)).not.toContain(
      oldFilePath,
    );

    act(() => {
      harness.root.unmount();
    });
  });

  it("手动刷新旧目录快照晚于 watcher 返回时，不覆盖 watcher 的新快照", async () => {
    vi.useFakeTimers();
    const oldFilePath = `${SRC_PATH}/old.ts`;
    const newFilePath = `${SRC_PATH}/new.ts`;
    const harness = createWorkspaceFileTreeHarness({
      [WORKSPACE_PATH]: [directory(SRC_PATH)],
      [SRC_PATH]: [file(oldFilePath)],
    });

    await harness.render();
    await act(async () => {
      await harness.latestResult.loadDirectory(SRC_PATH, 1);
      harness.latestResult.setExpandedPaths(new Set([SRC_PATH]));
      await flushMicrotasks();
    });
    await flushReactWork();

    let releaseManualSrcReaddir: (() => void) | null = null;
    let srcReaddirCount = 0;
    harness.services.fileService.readdir = vi.fn(async ({ path }: { path: string }) => {
      if (path === SRC_PATH) {
        srcReaddirCount += 1;
        if (srcReaddirCount === 1) {
          await new Promise<void>((resolve) => {
            releaseManualSrcReaddir = resolve;
          });
          return [file(oldFilePath)];
        }
      }
      return harness.entriesByDirectory.get(path) ?? [];
    });

    let refreshPromise: Promise<void> | undefined;
    await act(async () => {
      refreshPromise = harness.latestResult.refreshLoadedDirectories();
      await flushMicrotasks();
    });

    harness.setDirectoryEntries(SRC_PATH, [file(newFilePath)]);
    await harness.fireWatcherChange(SRC_PATH);

    expect(harness.latestResult.rows.map((row) => row.path)).toEqual([
      SRC_PATH,
      newFilePath,
    ]);

    releaseManualSrcReaddir?.();
    await act(async () => {
      await refreshPromise;
      await flushMicrotasks();
    });
    await flushReactWork();

    expect(harness.latestResult.rows.map((row) => row.path)).toEqual([
      SRC_PATH,
      newFilePath,
    ]);
    expect(harness.latestResult.rows.map((row) => row.path)).not.toContain(
      oldFilePath,
    );

    act(() => {
      harness.root.unmount();
    });
  });

  it("连续点击刷新时只执行一轮已加载目录刷新", async () => {
    let releaseRootReaddir: (() => void) | null = null;
    const harness = createWorkspaceFileTreeHarness({
      [WORKSPACE_PATH]: [directory(SRC_PATH)],
      [SRC_PATH]: [file(`${SRC_PATH}/old.ts`)],
    });
    const originalReaddir = harness.services.fileService.readdir;
    harness.services.fileService.readdir = vi.fn(async ({ path }: { path: string }) => {
      if (path === WORKSPACE_PATH) {
        await new Promise<void>((resolve) => {
          releaseRootReaddir = resolve;
        });
      }
      return originalReaddir({ path });
    });

    await harness.render();
    releaseRootReaddir?.();
    await flushReactWork();
    await act(async () => {
      await harness.latestResult.loadDirectory(SRC_PATH, 1);
      harness.latestResult.setExpandedPaths(new Set([SRC_PATH]));
      await flushMicrotasks();
    });
    await flushReactWork();

    let releaseRefreshRootReaddir: (() => void) | null = null;
    harness.services.fileService.readdir = vi.fn(async ({ path }: { path: string }) => {
      if (path === WORKSPACE_PATH) {
        await new Promise<void>((resolve) => {
          releaseRefreshRootReaddir = resolve;
        });
      }
      return originalReaddir({ path });
    });

    let refreshPromise: Promise<void> | undefined;
    await act(async () => {
      refreshPromise = harness.latestResult.refreshLoadedDirectories();
      void harness.latestResult.refreshLoadedDirectories();
      await flushMicrotasks();
    });

    expect(harness.latestResult.refreshingLoadedDirectories).toBe(true);
    expect(harness.services.fileService.readdir).toHaveBeenCalledTimes(2);

    releaseRefreshRootReaddir?.();
    await act(async () => {
      await refreshPromise;
      await flushMicrotasks();
    });
    await flushReactWork();

    expect(harness.latestResult.refreshingLoadedDirectories).toBe(false);

    act(() => {
      harness.root.unmount();
    });
  });

  it("切换 workspace 后，旧刷新不能覆盖新 workspace 的 Git 状态", async () => {
    const stalePath = `${WORKSPACE_PATH}/stale.ts`;
    const releaseStaleGitRefreshes: (() => void)[] = [];
    const harness = createWorkspaceFileTreeHarness({
      [WORKSPACE_PATH]: [file(stalePath)],
      [NEXT_WORKSPACE_PATH]: [],
    });
    harness.services.gitService.refresh = vi.fn(
      async ({ workspacePath }: { workspacePath: string }) => {
        if (workspacePath === WORKSPACE_PATH) {
          await new Promise<void>((resolve) => {
            releaseStaleGitRefreshes.push(resolve);
          });
          return createGitRefreshResult(workspacePath, [
            {
              path: stalePath,
              kind: "modified",
              section: "unstaged",
              isUntracked: false,
            } as GitRefreshResult["unstagedChanges"][number],
          ]);
        }
        return createGitRefreshResult(workspacePath);
      },
    );

    await harness.render();
    await act(async () => {
      void harness.latestResult.refreshLoadedDirectories();
      await flushMicrotasks();
    });

    await harness.setWorkspacePath(NEXT_WORKSPACE_PATH);
    for (const releaseStaleGitRefresh of releaseStaleGitRefreshes) {
      releaseStaleGitRefresh();
    }
    await flushReactWork();

    expect(harness.latestResult.gitStatusByPath.has(stalePath)).toBe(false);
    expect(harness.latestResult.gitStatusByPath.size).toBe(0);

    act(() => {
      harness.root.unmount();
    });
  });
});
