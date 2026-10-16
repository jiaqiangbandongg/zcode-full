import type { IDisposable } from "@zcode/rpc";
import { resolveWorkspaceKey } from "@zcode/shared";

export interface HostRemoteTaskMeta {
  taskId: string;
  traceId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface HostRemoteWorkspaceContext {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * 保存 shared remote Host 代理层持有的 workspace 资源。
 *
 * dedicated Host 会随 tab 退出，历史 task meta 和事件监听可由进程整体回收；
 * WSL Host Pool 会跨 workspace 复用，必须按 workspace 主动清理，否则引用会随 Host 寿命持续增长。
 */
export function createHostRemoteWorkspaceProxyState(): {
  rememberTaskMeta: (meta: HostRemoteTaskMeta) => void;
  getTaskMeta: (taskId: string) => HostRemoteTaskMeta | undefined;
  ensureWorkspaceSubscription: (
    context: HostRemoteWorkspaceContext,
    subscribe: () => IDisposable,
  ) => boolean;
  trackTaskReady: (
    taskId: string,
    context: HostRemoteWorkspaceContext,
    subscribe: (listener: () => void) => IDisposable,
    onReady: () => void,
  ) => void;
  disposeTaskReadySubscription: (taskId: string) => void;
  clearWorkspace: (context: HostRemoteWorkspaceContext) => void;
} {
  const taskMetaById = new Map<string, HostRemoteTaskMeta>();
  const workspaceSubscriptions = new Map<string, IDisposable>();
  const taskReadySubscriptions = new Map<
    string,
    { workspaceKey: string; disposable: IDisposable }
  >();

  function disposeTaskReadySubscription(taskId: string): void {
    const entry = taskReadySubscriptions.get(taskId);
    if (!entry) {
      return;
    }
    taskReadySubscriptions.delete(taskId);
    entry.disposable.dispose();
  }

  return {
    rememberTaskMeta(meta) {
      taskMetaById.set(meta.taskId, meta);
    },

    getTaskMeta(taskId) {
      return taskMetaById.get(taskId);
    },

    ensureWorkspaceSubscription(context, subscribe) {
      const workspaceKey = resolveWorkspaceKey(context);
      if (workspaceSubscriptions.has(workspaceKey)) {
        return false;
      }
      workspaceSubscriptions.set(workspaceKey, subscribe());
      return true;
    },

    trackTaskReady(taskId, context, subscribe, onReady) {
      let readyBeforeRegistration = false;
      const disposable = subscribe(() => {
        readyBeforeRegistration = true;
        disposeTaskReadySubscription(taskId);
        onReady();
      });
      if (readyBeforeRegistration) {
        // 动态 RPC 事件通常不会同步 replay，但这里处理同步实现，避免 ready 已结束后又留下 listener。
        disposable.dispose();
        return;
      }
      disposeTaskReadySubscription(taskId);
      taskReadySubscriptions.set(taskId, {
        workspaceKey: resolveWorkspaceKey(context),
        disposable,
      });
    },

    disposeTaskReadySubscription,

    clearWorkspace(context) {
      const workspaceKey = resolveWorkspaceKey(context);
      workspaceSubscriptions.get(workspaceKey)?.dispose();
      workspaceSubscriptions.delete(workspaceKey);

      for (const [taskId, meta] of taskMetaById) {
        if (resolveWorkspaceKey(meta) === workspaceKey) {
          taskMetaById.delete(taskId);
        }
      }
      for (const [taskId, entry] of taskReadySubscriptions) {
        if (entry.workspaceKey === workspaceKey) {
          disposeTaskReadySubscription(taskId);
        }
      }
    },
  };
}
