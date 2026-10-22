// 侧栏会话项拖拽的可用性开关（拖到项目上移动任务）。手机与 /remote web-remote 不启用。
// 2026-10-16 起「在分屏打开 / 拖到对话区分屏」入口已下线，这里只保留拖拽闸门；
// 用 context 而不是逐层 props：会话项 drag source 被多个侧栏 Section 共用，判定源收敛在 WorkspaceShellLayout 一处。
import { createContext, useContext, useMemo, type ReactNode } from "react";

interface V4SplitPaneEntryContextValue {
  readonly enabled: boolean;
}

const V4SplitPaneEntryContext = createContext<V4SplitPaneEntryContextValue>({ enabled: false });

export function V4SplitPaneEntryProvider({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  const value = useMemo<V4SplitPaneEntryContextValue>(() => ({ enabled }), [enabled]);
  return (
    <V4SplitPaneEntryContext.Provider value={value}>{children}</V4SplitPaneEntryContext.Provider>
  );
}

export function useV4SplitPaneEntry(): V4SplitPaneEntryContextValue {
  return useContext(V4SplitPaneEntryContext);
}
