import { useCallback, useEffect, useRef, useState } from "react";
import type { WebRemoteControlWorkspaceTarget } from "@zcode/shared";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";

/**
 * home-only 没有项目契约，工作区行只投影桌面 listWorkspaces 与推送；不轮询，也不另存连接状态。
 * 推送和新请求都会让在途旧响应失效，迟到列表不能覆盖更新的连接事实。
 */
export function useHomeOnlyWorkspaces(switcher: WebRemoteControlWorkspaceSwitcherApi) {
  const [state, setState] = useState<{
    workspaces: WebRemoteControlWorkspaceTarget[] | null;
    error: string | null;
  }>({ workspaces: null, error: null });
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const request = ++generation.current;
    try {
      const result = await switcher.listWorkspaces();
      if (request === generation.current) setState({ workspaces: result.workspaces, error: null });
    } catch (cause) {
      if (request !== generation.current) return;
      const error = getErrorMessage(cause);
      logger.warn("[project-sidebar] home-only 工作区列表读取失败", { error });
      setState((current) => ({ ...current, error }));
    }
  }, [switcher]);
  useEffect(() => {
    void reload();
    const unsubscribe = switcher.onWorkspaceListUpdated?.((result) => {
      generation.current += 1;
      setState({ workspaces: result.workspaces, error: null });
    });
    return () => {
      generation.current += 1;
      unsubscribe?.();
    };
  }, [switcher, reload]);
  return { ...state, reload };
}
