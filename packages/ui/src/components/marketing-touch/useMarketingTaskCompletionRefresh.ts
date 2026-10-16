import { createContext, useContext, useEffect } from "react";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";
import {
  acquireSessionsIndex,
  releaseSessionsIndex,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";

export const MarketingRefreshContext = createContext<(() => void) | null>(null);

/** 仅观察任务完成边沿；活动查询仍由窗口唯一 poller 调度。 */
export function useMarketingTaskCompletionRefresh({
  workspacePath,
  workspaceIdentity,
  endpointKey,
  rpcReady,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  endpointKey?: string;
  rpcReady: boolean;
}): void {
  const refresh = useContext(MarketingRefreshContext);
  const { zcodeAgentService } = useServices();
  useEffect(() => {
    if (!refresh || !rpcReady) return;
    const identity = workspaceIdentity?.trim();
    const scope: SessionsIndexScope = {
      workspaceKey: identity || workspacePath,
      workspacePath,
      ...(identity ? { workspaceIdentity: identity } : {}),
      ...(endpointKey ? { endpointKey } : {}),
    };
    const store = acquireSessionsIndex(scope, zcodeAgentService);
    let previous: Map<string, SessionSummary["phase"]> | null = null;
    const observe = () => {
      // 初次历史与断连恢复只建立基线，避免把旧完成状态当成新完成事件。
      if (store.getStatus() !== "live") {
        previous = null;
        return;
      }
      const sessions = store.getSessions();
      const completed = sessions.some((session) => {
        const phase = previous?.get(session.sessionId);
        return (
          phase !== undefined &&
          phase !== "completedSuccess" &&
          session.phase === "completedSuccess"
        );
      });
      previous = new Map(sessions.map((session) => [session.sessionId, session.phase]));
      if (completed) refresh();
    };
    const unsubscribe = store.subscribe(observe);
    observe();
    return () => {
      unsubscribe();
      releaseSessionsIndex(scope, store);
    };
  }, [endpointKey, refresh, rpcReady, workspaceIdentity, workspacePath, zcodeAgentService]);
}
