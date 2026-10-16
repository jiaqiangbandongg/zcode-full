// @vitest-environment jsdom
import { createElement, type ReactNode, useCallback } from "react";
import { act, renderHook } from "@testing-library/react";
import type { ISettingService } from "@zcode/services";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRestoredRecentProjectPaths,
  getRecentProjectPathsFromSettings,
  hasCompletedTabPersistenceInitialRestore,
  useTabPersistence,
} from "@/hooks/useTabPersistence.js";
import { TabStoreProvider, useTabStoreApi } from "@/store/TabStoreProvider.js";

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
  delete (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback;
});

describe("useTabPersistence", () => {
  it("deferred restore 完成前不持久化 active-only 瞬态", async () => {
    vi.useFakeTimers();
    let runIdleCallback: (() => void) | undefined;
    Object.defineProperty(globalThis, "requestIdleCallback", {
      configurable: true,
      value: vi.fn((callback: () => void) => {
        runIdleCallback = callback;
        return 9;
      }),
    });
    Object.defineProperty(globalThis, "cancelIdleCallback", {
      configurable: true,
      value: vi.fn(),
    });
    const update = vi.fn(async () => undefined);
    const settingService = {
      get: vi.fn(async () => ({
        lastWorkspaceSession: [
          { kind: "local" as const, workspacePath: "/workspace/active" },
          { kind: "local" as const, workspacePath: "/workspace/inactive" },
        ],
        lastActiveTabIndex: 0,
        recentProjects: ["/workspace/active", "/workspace/inactive"],
      })),
      update,
    } as unknown as ISettingService;

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(TabStoreProvider, null, children);
    const { result } = renderHook(
      () => {
        const store = useTabStoreApi();
        const restorePersistedSession = useCallback(() => {
          store.getState().restoreTabs(["/workspace/active"], 0);
          return {
            deferredRestore: () =>
              store.getState().completeTabRestore(["/workspace/active", "/workspace/inactive"]),
          };
        }, [store]);
        const persistence = useTabPersistence({
          settingService,
          restorePersistedSession,
        });
        return { persistence, store };
      },
      { wrapper },
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.persistence.isRestoring).toBe(false);
    expect(result.current.persistence.hasCompletedFullRestore).toBe(false);
    expect(
      result.current.store
        .getState()
        .tabs.map((tab) => (tab.kind === "workspace" ? tab.workspacePath : tab.kind)),
    ).toEqual(["/workspace/active"]);

    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(update).not.toHaveBeenCalled();

    act(() => runIdleCallback?.());
    expect(result.current.persistence.hasCompletedFullRestore).toBe(true);
    expect(
      result.current.store
        .getState()
        .tabs.map((tab) => (tab.kind === "workspace" ? tab.workspacePath : tab.kind)),
    ).toEqual(["/workspace/active", "/workspace/inactive"]);

    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        lastWorkspaceSession: [
          { kind: "local", workspacePath: "/workspace/active" },
          { kind: "local", workspacePath: "/workspace/inactive" },
        ],
      }),
    );
  });

  it("restoreSession 从关闭切到开启时会先等待当前恢复完成", () => {
    const settingService = {} as ISettingService;

    expect(
      hasCompletedTabPersistenceInitialRestore({
        settingService,
        restoreSession: true,
        restoreLifecycle: {
          settingService: undefined,
          restoreSession: false,
          completed: true,
          fullyCompleted: true,
        },
      }),
    ).toBe(false);
  });

  it("当前 settingService 的恢复完成后才允许初始 workspace 注入", () => {
    const settingService = {} as ISettingService;

    expect(
      hasCompletedTabPersistenceInitialRestore({
        settingService,
        restoreSession: true,
        restoreLifecycle: {
          settingService,
          restoreSession: true,
          completed: true,
          fullyCompleted: true,
        },
      }),
    ).toBe(true);
  });

  it("不需要恢复会话时不阻塞初始 workspace 注入", () => {
    expect(
      hasCompletedTabPersistenceInitialRestore({
        settingService: undefined,
        restoreSession: true,
        restoreLifecycle: {
          settingService: undefined,
          restoreSession: true,
          completed: false,
          fullyCompleted: false,
        },
      }),
    ).toBe(true);
  });

  it("会话工作区不会进入最近项目", () => {
    expect(
      getRecentProjectPathsFromSettings({
        lastWorkspaceSession: [
          {
            kind: "local",
            workspacePath: "/Users/demo/.zcode/workspace/default",
            workspacePurpose: "conversation",
          },
          {
            kind: "local",
            workspacePath: "/Users/demo/project",
            workspacePurpose: "project",
          },
          {
            kind: "local",
            workspacePath: "/Users/demo/legacy-project",
          },
        ],
      }),
    ).toEqual(["/Users/demo/project", "/Users/demo/legacy-project"]);
  });

  it("canonical conversation 路径即使旧数据缺少 purpose 也不会进入最近项目", () => {
    const conversationWorkspacePath = "/Users/demo/.zcode/workspace/default";

    expect(
      getRecentProjectPathsFromSettings(
        {
          lastWorkspaceSession: [
            {
              kind: "local",
              workspacePath: conversationWorkspacePath,
            },
            {
              kind: "local",
              workspacePath: "/Users/demo/project",
            },
          ],
        },
        [conversationWorkspacePath],
      ),
    ).toEqual(["/Users/demo/project"]);
  });

  it("恢复时会清理 recentProjects 里遗留的 canonical conversation 路径", () => {
    const conversationWorkspacePath = "/Users/demo/.zcode/workspace/default";

    expect(
      buildRestoredRecentProjectPaths(
        {
          lastWorkspaceSession: [
            { kind: "local", workspacePath: conversationWorkspacePath },
            { kind: "local", workspacePath: "/Users/demo/project" },
          ],
          recentProjects: [conversationWorkspacePath, "/Users/demo/older-project"],
        },
        [conversationWorkspacePath],
      ),
    ).toEqual(["/Users/demo/older-project", "/Users/demo/project"]);
  });
});
