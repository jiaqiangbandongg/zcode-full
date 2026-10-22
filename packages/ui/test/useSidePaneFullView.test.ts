// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearTaskSidePaneMemoryStateForTest } from "@/lib/taskSidePaneMemory.js";
import { useSidePaneFullView } from "@/side-pane-full-view/useSidePaneFullView.js";

interface Props {
  ownerId: string | null;
  isSidePaneOpen: boolean;
  enabled?: boolean;
  workspacePath?: string;
}

function renderFullView(initial: Props) {
  return renderHook(
    ({ ownerId, isSidePaneOpen, enabled = true, workspacePath = "/workspace" }: Props) =>
      useSidePaneFullView({ workspacePath, ownerId, isSidePaneOpen, enabled }),
    { initialProps: initial },
  );
}

describe("useSidePaneFullView", () => {
  beforeEach(() => {
    clearTaskSidePaneMemoryStateForTest();
  });

  it("enters on the side pane surface with a collapsed floating composer and toggles off", () => {
    const { result } = renderFullView({ ownerId: "task-a", isSidePaneOpen: true });
    expect(result.current.fullView).toBeNull();

    act(() => result.current.toggle());
    expect(result.current.fullView).toEqual({ surface: "side-pane", floating: "collapsed" });

    act(() => result.current.setSurface("conversation"));
    act(() => result.current.setFloating("minimized"));
    expect(result.current.fullView).toEqual({ surface: "conversation", floating: "minimized" });

    act(() => result.current.toggle());
    expect(result.current.fullView).toBeNull();
  });

  it("remembers the state per session and restores it when switching back", () => {
    const { result, rerender } = renderFullView({ ownerId: "task-a", isSidePaneOpen: true });
    act(() => result.current.enter());
    act(() => result.current.setFloating("expanded"));

    rerender({ ownerId: "task-b", isSidePaneOpen: true });
    expect(result.current.fullView).toBeNull();

    rerender({ ownerId: "task-a", isSidePaneOpen: true });
    expect(result.current.fullView).toEqual({ surface: "side-pane", floating: "expanded" });
  });

  it("is inactive while the side pane is closed and is cleared when the same session closes it", () => {
    const { result, rerender } = renderFullView({ ownerId: "task-a", isSidePaneOpen: true });
    act(() => result.current.enter());

    rerender({ ownerId: "task-a", isSidePaneOpen: false });
    expect(result.current.fullView).toBeNull();

    // 重新打开面板不能回到完整视图。
    rerender({ ownerId: "task-a", isSidePaneOpen: true });
    expect(result.current.fullView).toBeNull();
  });

  it("keeps a session's record when the pane closes only because another session became active", () => {
    const { result, rerender } = renderFullView({ ownerId: "task-a", isSidePaneOpen: true });
    act(() => result.current.enter());

    // 切到 B 时面板开合状态随 owner 恢复，可能在同一轮里变为关闭。
    rerender({ ownerId: "task-b", isSidePaneOpen: false });
    rerender({ ownerId: "task-a", isSidePaneOpen: false });
    rerender({ ownerId: "task-a", isSidePaneOpen: true });
    expect(result.current.fullView).toEqual({ surface: "side-pane", floating: "collapsed" });
  });

  it("does nothing when the platform does not support full view", () => {
    const { result } = renderFullView({ ownerId: "task-a", isSidePaneOpen: true, enabled: false });
    act(() => result.current.toggle());
    expect(result.current.fullView).toBeNull();
  });

  it("isolates records by workspace", () => {
    const { result, rerender } = renderFullView({ ownerId: null, isSidePaneOpen: true });
    act(() => result.current.enter());

    rerender({ ownerId: null, isSidePaneOpen: true, workspacePath: "/other" });
    expect(result.current.fullView).toBeNull();

    rerender({ ownerId: null, isSidePaneOpen: true, workspacePath: "/workspace" });
    expect(result.current.fullView).toEqual({ surface: "side-pane", floating: "collapsed" });
  });

  // 回归：controller 进入 memo 的 WorkspaceShellLayout，引用不稳定会让切换会话时出现更新死循环。
  it("returns the same controller object until the full view state changes", () => {
    const { result, rerender } = renderFullView({ ownerId: "task-a", isSidePaneOpen: true });
    const first = result.current;
    rerender({ ownerId: "task-a", isSidePaneOpen: true });
    expect(result.current).toBe(first);

    act(() => result.current.enter());
    const entered = result.current;
    expect(entered).not.toBe(first);
    rerender({ ownerId: "task-a", isSidePaneOpen: true });
    expect(result.current).toBe(entered);
  });
});
