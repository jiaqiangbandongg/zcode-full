// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useState } from "react";
import {
  shouldRestorePersistedPaneSession,
  usePaneSessionPersistence,
  persistPaneSession,
  readPersistedPaneSession,
} from "@/v4/usePaneSessionPersistence.js";

describe("pane last-session restore precedence", () => {
  it("restores only a cold workspace without an explicit draft intent", () => {
    expect(
      shouldRestorePersistedPaneSession({
        activeSessionId: null,
        draftFocusVersion: 0,
        enabled: true,
        rendererReload: true,
      }),
    ).toBe(true);
  });

  it("keeps an explicit draft instead of restoring the previous session", () => {
    expect(
      shouldRestorePersistedPaneSession({
        activeSessionId: null,
        draftFocusVersion: 1,
        enabled: true,
        rendererReload: true,
      }),
    ).toBe(false);
  });

  it("does not restore over an already selected session", () => {
    expect(
      shouldRestorePersistedPaneSession({
        activeSessionId: "session-current",
        draftFocusVersion: 0,
        enabled: true,
        rendererReload: true,
      }),
    ).toBe(false);
  });

  it("does not consume desktop persistence in web remote replayable mode", () => {
    expect(
      shouldRestorePersistedPaneSession({
        activeSessionId: null,
        draftFocusVersion: 0,
        enabled: false,
        rendererReload: true,
      }),
    ).toBe(false);
  });

  it("does not restore a persisted session on app cold launch or workspace entry", () => {
    expect(
      shouldRestorePersistedPaneSession({
        activeSessionId: null,
        draftFocusVersion: 0,
        enabled: true,
        rendererReload: false,
      }),
    ).toBe(false);
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("页签指定的启动 pane 恢复", () => {
  it("冷启动只恢复持久化激活页签，显式新任务随后清除旧恢复目标", () => {
    const workspaceKey = "remote:server:a:/srv/app";
    persistPaneSession(workspaceKey, "task-before-restart");
    const { result } = renderHook(() => {
      const [sessionId, setSessionId] = useState<string | null>(null);
      const [draftFocusVersion, setDraftFocusVersion] = useState(0);
      usePaneSessionPersistence({
        workspaceKey,
        activeSessionId: sessionId,
        draftFocusVersion,
        restoreOnStartup: true,
        selectSession: setSessionId,
      });
      return {
        sessionId,
        newTask: () => {
          setSessionId(null);
          setDraftFocusVersion(1);
        },
      };
    });
    expect(result.current.sessionId).toBe("task-before-restart");
    act(() => result.current.newTask());
    expect(readPersistedPaneSession(workspaceKey)).toBeNull();
    expect(result.current.sessionId).toBeNull();
  });
});

describe("挂回后验证原会话", () => {
  it("挂回门禁关闭时不查询，权威确认已删除后回到当前项目的新任务页", async () => {
    const workspaceKey = "remote:server:a:/srv/app";
    persistPaneSession(workspaceKey, "deleted-task");
    const lookup = vi.fn(async () => false);
    const { result, rerender } = renderHook(
      ({ ready }) => {
        const [sessionId, setSessionId] = useState<string | null>("deleted-task");
        usePaneSessionPersistence({
          workspaceKey,
          activeSessionId: sessionId,
          draftFocusVersion: 0,
          selectSession: setSessionId,
          lookupSession: ready ? lookup : undefined,
          onSessionMissing: () => setSessionId(null),
        });
        return sessionId;
      },
      { initialProps: { ready: false } },
    );
    expect(result.current).toBe("deleted-task");
    expect(lookup).not.toHaveBeenCalled();
    await act(async () => rerender({ ready: true }));
    expect(lookup).toHaveBeenCalledWith("deleted-task");
    expect(result.current).toBeNull();
    expect(readPersistedPaneSession(workspaceKey)).toBeNull();
  });
});

describe("恢复查询的意图与模式边界", () => {
  it("新任务刚被 ACK 选中但索引尚未写入时，不能当作恢复目标删除", async () => {
    const lookup = vi.fn(async () => false);
    const missing = vi.fn();
    const { rerender } = renderHook(
      ({ activeSessionId }) =>
        usePaneSessionPersistence({
          workspaceKey: "remote:server:a:/srv/app",
          activeSessionId,
          draftFocusVersion: 1,
          selectSession: vi.fn(),
          lookupSession: lookup,
          onSessionMissing: missing,
        }),
      { initialProps: { activeSessionId: null as string | null } },
    );
    await act(async () => rerender({ activeSessionId: "just-created-task" }));
    expect(lookup).not.toHaveBeenCalled();
    expect(missing).not.toHaveBeenCalled();
  });

  it("查询失败保留恢复会话；下一 attachment 就绪后可重新验证", async () => {
    const workspaceKey = "remote:server:a:/srv/app";
    const missing = vi.fn();
    const lookup = vi.fn().mockRejectedValue(new Error("disconnected"));
    const { rerender } = renderHook(
      ({ lookupSession }) =>
        usePaneSessionPersistence({
          workspaceKey,
          activeSessionId: "task-a",
          draftFocusVersion: 0,
          selectSession: vi.fn(),
          lookupSession,
          onSessionMissing: missing,
        }),
      { initialProps: { lookupSession: lookup } },
    );
    await act(async () => {});
    expect(missing).not.toHaveBeenCalled();
    expect(readPersistedPaneSession(workspaceKey)).toBe("task-a");
    const nextLookup = vi.fn(async () => true);
    await act(async () => rerender({ lookupSession: nextLookup }));
    expect(nextLookup).toHaveBeenCalledWith("task-a");
    expect(missing).not.toHaveBeenCalled();
  });

  it.each(["workspace", "task", "draft", "attachment"])(
    "%s 变化后的旧删除查询不得覆盖新意图",
    async (change) => {
      let finish!: (exists: boolean) => void;
      const lookup = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            finish = resolve;
          }),
      );
      const missing = vi.fn();
      const initialProps = {
        workspaceKey: "remote:server:a:/srv/app",
        activeSessionId: "task-a" as string | null,
        draftFocusVersion: 0,
        lookupSession: lookup as (id: string) => Promise<boolean>,
      };
      const { rerender } = renderHook(
        (props) =>
          usePaneSessionPersistence({
            ...props,
            selectSession: vi.fn(),
            onSessionMissing: missing,
          }),
        { initialProps },
      );
      const finishOld = finish;
      rerender({
        ...initialProps,
        ...(change === "workspace" ? { workspaceKey: "remote:server:b:/srv/app" } : {}),
        ...(change === "task" ? { activeSessionId: "task-b" } : {}),
        ...(change === "draft" ? { activeSessionId: null, draftFocusVersion: 1 } : {}),
        ...(change === "attachment" ? { lookupSession: async () => true } : {}),
      });
      await act(async () => finishOld(false));
      expect(missing).not.toHaveBeenCalled();
    },
  );

  it("手机 replayable 不消费、不覆盖桌面选择且不启动恢复查询", async () => {
    const workspaceKey = "remote:server:a:/srv/app";
    persistPaneSession(workspaceKey, "desktop-task");
    const lookup = vi.fn(async () => false);
    const selectSession = vi.fn();
    const missing = vi.fn();
    renderHook(() =>
      usePaneSessionPersistence({
        workspaceKey,
        activeSessionId: "mobile-task",
        draftFocusVersion: 0,
        enabled: false,
        restoreOnStartup: true,
        selectSession,
        lookupSession: lookup,
        onSessionMissing: missing,
      }),
    );
    await act(async () => {});
    expect(readPersistedPaneSession(workspaceKey)).toBe("desktop-task");
    expect(selectSession).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(missing).not.toHaveBeenCalled();
  });
});
