import { useEffect, useLayoutEffect, useRef } from "react";
import type {
  WebRemoteControlMobileTaskView,
  WebRemoteControlTaskViewSwitcher,
} from "@/web-remote-control/contract.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { logger } from "@/logger.js";

/** 宽窄屏复用实际聊天表面；导航位置和当前查看分别上报，不保存第二份导航状态。 */
export function WebRemoteControlTaskViewReporter({
  enabled,
  activeTaskId,
  workspacePath,
  workspaceIdentity,
  switcher,
}: {
  enabled: boolean;
  activeTaskId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  switcher?: WebRemoteControlTaskViewSwitcher;
}) {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const navigationCommitted = useZCodeSessionStore((state) => {
    const route = state.taskNavHistory.entries[state.taskNavHistory.cursor];
    return (
      route?.kind === "task" &&
      route.taskId === activeTaskId &&
      (route.workspaceIdentity?.trim() || route.workspacePath) === workspaceKey &&
      state.getWorkspaceState(workspacePath, workspaceIdentity).activeTaskId === activeTaskId
    );
  });
  const viewing = enabled && navigationCommitted && activeTaskId !== null;
  const viewKey = viewing ? JSON.stringify([workspaceKey, activeTaskId]) : null;
  const updateNavigation = switcher?.updateMobileViewState;
  const updateView = switcher?.updateMobileTaskView;
  const hasViewReporter = Boolean(updateView);
  const committed = useRef<{
    view: WebRemoteControlMobileTaskView | null;
    updateView: WebRemoteControlTaskViewSwitcher["updateMobileTaskView"];
  }>({ view: null, updateView: undefined });
  useLayoutEffect(() => {
    // 只发布已经提交的显示地址；render 中写 ref 会让旧页面的事件提前读到尚未提交的新目标。
    committed.current = {
      view: viewing
        ? {
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            taskId: activeTaskId,
          }
        : null,
      updateView,
    };
  });

  useEffect(() => {
    if (!updateNavigation) return;
    // Bug 根因：草稿晋升上报原本只装在窄屏 Shell，宽屏会一直保留旧 task 导航位置。
    void updateNavigation(workspaceKey, activeTaskId ?? undefined).catch((error: unknown) => {
      logger.warn("[WebRemoteControlTaskViewReporter] 同步导航位置失败", {
        workspaceKey,
        activeTaskId,
        error,
      });
    });
  }, [activeTaskId, workspaceKey, updateNavigation]);

  useEffect(() => {
    const initialReporter = committed.current.updateView;
    if (!initialReporter) return;
    let lastReported: string | null | undefined;
    const publish = (view: WebRemoteControlMobileTaskView | null) => {
      const key = view
        ? JSON.stringify([view.workspaceIdentity?.trim() || view.workspacePath, view.taskId])
        : null;
      if (lastReported === key) return;
      lastReported = key;
      void (committed.current.updateView ?? initialReporter)(view).catch((error: unknown) => {
        if (lastReported === key) lastReported = undefined;
        logger.warn("[WebRemoteControlTaskViewReporter] 同步查看状态失败", { view, error });
      });
    };
    const sync = () =>
      publish(document.visibilityState === "visible" ? committed.current.view : null);
    const hide = () => publish(null);
    // Bug 根因：挂载和 activeTaskId 不代表用户看见聊天；Home、遮盖层及后台必须显式取消查看。
    sync();
    document.addEventListener("visibilitychange", sync);
    // freeze/resume 不一定伴随 visibilitychange；恢复重新读取实际可见地址，不重放旧报告。
    document.addEventListener("freeze", hide);
    document.addEventListener("resume", sync);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      document.removeEventListener("freeze", hide);
      document.removeEventListener("resume", sync);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", sync);
      hide();
    };
    // callback 换引用不是一次查看；只让实际显示目标和能力变化重建订阅，避免擦掉手动未读。
  }, [viewKey, hasViewReporter]);
  return null;
}
