import { useEffect, useRef } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import type {
  ProjectTaskRef,
  WebRemoteControlStatus,
  WindowHostTaskUnreadSignal,
} from "@/project-sidebar/contract.js";
import { mutateProjectTask, readProjectTaskMeta } from "@/project-sidebar/task-mutation.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { onTaskNavigationCommitted } from "@/store/zcodeSessionStoreNavigation.js";
import { logger } from "@/logger.js";

/** 前台完成补记记录：written=已补写，marker=补写回包的未读版本（自动清除的 CAS 凭据）。 */
interface ForegroundCompletionEntry {
  target: WindowHostTaskUnreadSignal["address"];
  written: boolean;
  marker?: number;
}
type ForegroundCompletionMap = Map<string, ForegroundCompletionEntry>;

/** 目录 Provider 是唯一消费者；只保存接收水位与在途命令，不另存一份未读状态。 */
export function useProjectUnreadSignals(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
  refresh: () => Promise<void>,
  observeRemoteViewing = false,
) {
  const services = useBaseWorkspaceServices();
  const availablePlatform = useOptionalPlatform();
  const platform = observeRemoteViewing ? availablePlatform : null;
  const tabs = useTabStoreApi();
  const scopeKey = JSON.stringify(scopes);
  const latestRefresh = useRef(refresh);
  latestRefresh.current = refresh;
  const received = useRef(new Map<string, { updatedAt: number; status: string }>());
  // useRef 而非 effect 内 Map：scopeKey 等依赖变化会让 effect 重跑，
  // 未补写/未清除的记录不能跟着闭包一起丢。
  const foregroundCompletionsRef = useRef<ForegroundCompletionMap>(new Map());
  // 同一任务的串行队列与在途标记必须跨 effect 存活：effect 重跑（scopeKey/services
  // 变化）后，旧实例未完成的 mark-unread 与新实例的重试/清除仍共用一条链，
  // 否则迟到的旧补写会在自动清除之后落库，重新制造无法自动清除的未读。
  const foregroundQueuesRef = useRef(new Map<string, Promise<void>>());
  // 在途补写按任务存 Promise：focus 早于补写回包到达时，flushThenClear 必须
  // 等待在途 Promise 落定后再做 marker CAS 清除，否则清除读不到 marker 而失效。
  const foregroundPendingWritesRef = useRef(new Map<string, Promise<void>>());
  const foregroundPendingClearsRef = useRef(new Set<string>());
  const taskKey = (target: ProjectTaskRef) =>
    JSON.stringify([target.workspaceIdentity?.trim() || target.workspacePath, target.taskId]);
  // 队列挂在组件级 ref 上：跨 effect 串行；命令自身负责校验当前记录是否仍然有效。
  const enqueueForegroundCommand = (
    target: ProjectTaskRef,
    command: () => Promise<void>,
  ) => {
    const key = taskKey(target);
    const previous = foregroundQueuesRef.current.get(key) ?? Promise.resolve();
    const current = previous.then(command);
    const settled = current
      .catch(() => {})
      .finally(() => {
        if (foregroundQueuesRef.current.get(key) === settled) {
          foregroundQueuesRef.current.delete(key);
        }
      });
    foregroundQueuesRef.current.set(key, settled);
    return current;
  };
  useEffect(() => {
    let disposed = false;
    const pending = new Set<{
      target: WindowHostTaskUnreadSignal["address"];
      viewed: boolean;
      started: boolean;
    }>();
    const ports = {
      service: services.zcodeTaskService,
      controller: services.windowControllerService,
    };
    const foregroundCompletions = foregroundCompletionsRef.current;
    // 方案 A：前台完成不立即写未读，只记录；离开窗口（失焦/最小化/页面隐藏）时补写
    // 未读让角标/蓝点亮起，用户回到窗口且该任务仍在面前时按写回的精确 marker 自动
    // 清除——不允许「蓝点卡在正打开的任务上，必须点走再点回」。聚焦期间永不补记。
    // spec: docs/ui/task-unread-state.md 被动标记未读「前台完成的离开补记」。
    // 补写/清除的串行队列与在途标记挂在组件级 ref 上（跨 effect 共享）：effect 重跑
    // 后旧实例未完成的命令由新实例按共享记录继续，不会静默跳过或重复写入。
    const flushOnLeave = () => {
      const writes: Array<Promise<void>> = [];
      for (const [key, entry] of foregroundCompletions) {
        if (entry.written) continue;
        // 已有在途补写：等待它完成（而不是跳过）。跳过会让紧随其后的
        // 自动清除读不到 marker，未读会永久卡在正打开的任务上。
        const pendingWrite = foregroundPendingWritesRef.current.get(key);
        if (pendingWrite) {
          writes.push(pendingWrite);
          continue;
        }
        const command = enqueueForegroundCommand(entry.target, async () => {
          // 记录已被新信号覆盖/清除时，迟到回包不再驱动状态。
          if (foregroundCompletionsRef.current.get(key) !== entry) return;
          const meta = await mutateProjectTask(
            ports,
            entry.target,
            { kind: "mark-unread" },
            entry.target.remoteSessionId,
          );
          // 写成功才置 written；失败保持 false，下个生命周期事件重试，不丢提醒。
          entry.written = true;
          if (meta?.unreadAt != null) entry.marker = meta.unreadAt;
        })
          .then(async () => {
            foregroundPendingWritesRef.current.delete(key);
            if (!disposed) await latestRefresh.current();
          })
          .catch((error: unknown) => {
            foregroundPendingWritesRef.current.delete(key);
            if (!disposed) {
              logger.warn("[project-sidebar] 前台完成补记未读写入失败", {
                ...entry.target,
                error,
              });
              void latestRefresh.current();
            }
          });
        foregroundPendingWritesRef.current.set(key, command);
        writes.push(command);
      }
      return Promise.all(writes);
    };
    const clearOnFocus = () => {
      for (const [key, entry] of [...foregroundCompletions]) {
        // 只清「已补写且用户回到窗口时任务仍在面前」的记录；
        // 未补写的（还没离开过）保持记录，等真正的离开事件。
        if (!entry.written || entry.marker == null) continue;
        // focus 与 visibilitychange-visible 可能连发：在途清除去重，避免重复 mark-read。
        if (foregroundPendingClearsRef.current.has(key)) continue;
        if (!(isDesktopViewing(entry.target) || isRemoteViewing(entry.target))) continue;
        foregroundPendingClearsRef.current.add(key);
        // mark-read 排在同一任务队列里补写之后执行：此时补写回包已到、marker 已就位。
        // marker 仍为空说明补写失败（保留记录等下次离开重试）；CAS 成功才移除记录。
        // effect 重跑不中断本命令；迟到回包以「记录仍在」为准，不在清除前静默丢弃。
        void enqueueForegroundCommand(entry.target, async () => {
          if (entry.marker == null) return;
          await mutateProjectTask(
            ports,
            entry.target,
            { kind: "mark-read", expectedUnreadAt: entry.marker },
            entry.target.remoteSessionId,
          );
          if (foregroundCompletionsRef.current.get(key) === entry) {
            foregroundCompletionsRef.current.delete(key);
          }
        })
          .then(async () => {
            foregroundPendingClearsRef.current.delete(key);
            if (!disposed) await latestRefresh.current();
          })
          .catch((error: unknown) => {
            foregroundPendingClearsRef.current.delete(key);
            if (!disposed) {
              logger.warn("[project-sidebar] 前台完成自动已读失败", { ...entry.target, error });
              void latestRefresh.current();
            }
          });
      }
    };
    let remoteView: WebRemoteControlStatus["mobileTaskView"];
    let statusEventSeen = false;
    let statusReady = !platform;
    let releaseStatus!: () => void;
    const initialStatus = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    if (statusReady) releaseStatus();
    const isRemoteViewing = (target: WindowHostTaskUnreadSignal["address"]) =>
      remoteView?.taskId === target.taskId &&
      (remoteView.workspaceIdentity?.trim() || remoteView.workspacePath) ===
        (target.workspaceIdentity?.trim() || target.workspacePath) &&
      (!remoteView.remoteSessionId ||
        !target.remoteSessionId ||
        remoteView.remoteSessionId === target.remoteSessionId);
    const acceptStatus = (status: WebRemoteControlStatus) => {
      if (disposed) return;
      // 只消费 Main 验证后的瞬时查看事实；最后导航位置与连接状态宽限都不能代替它。
      const previousViewKey = remoteView
        ? JSON.stringify([taskKey(remoteView), remoteView.remoteSessionId])
        : null;
      remoteView = status.mobileTaskView;
      statusReady = true;
      releaseStatus();
      let pendingWrite = false;
      for (const operation of pending)
        if (isRemoteViewing(operation.target)) {
          operation.viewed = true;
          pendingWrite ||= operation.started;
        }
      if (
        !remoteView ||
        previousViewKey === JSON.stringify([taskKey(remoteView), remoteView.remoteSessionId]) ||
        pendingWrite
      )
        return;
      const target = remoteView;
      // 已有在途写时沿用其精确回包CAS；写入已结束的新查看才读取权威marker。
      // 后续完成命令排在此次读取和CAS之后，不能读到离开后产生的新marker。
      void enqueueForegroundCommand(target, async () => {
        const meta = await readProjectTaskMeta(ports, target, target.remoteSessionId);
        if (disposed || meta?.unreadAt == null) return;
        await mutateProjectTask(
          ports,
          target,
          { kind: "mark-read", expectedUnreadAt: meta.unreadAt },
          target.remoteSessionId,
        );
      })
        .then(() => {
          if (!disposed) return latestRefresh.current();
        })
        .catch((error) => {
          if (!disposed) {
            logger.warn("[project-sidebar] 查看任务已读写入失败", { ...target, error });
            void latestRefresh.current();
          }
        });
    };
    // 必须逐事件处理；React state 合批会丢失“查看后立即离开”的事实。
    const unsubscribeStatus = platform?.onWebRemoteControlStatusChanged?.((status) => {
      statusEventSeen = true;
      acceptStatus(status);
    });
    if (platform)
      void platform
        .getWebRemoteControlStatus()
        .then((status) => {
          if (!statusEventSeen) acceptStatus(status);
        })
        .catch((error) => {
          if (disposed || statusEventSeen) return;
          // 状态不可读时不猜测“已经看过”，也不让本地完成写永久等待；新有效查看仍会通过精确 CAS 收敛。
          statusReady = true;
          releaseStatus();
          logger.warn("[project-sidebar] 查看状态初始读取失败", error);
        });
    const isDesktopViewing = (target: ProjectTaskRef) => {
      const tabState = tabs.getState();
      const tab = tabState.tabs.find((item) => item.id === tabState.activeTabId);
      const key = target.workspaceIdentity?.trim() || target.workspacePath;
      const state = useZCodeSessionStore.getState();
      const route = state.taskNavHistory.entries[state.taskNavHistory.cursor];
      // 前台完成只认完整导航地址；缓存 activeTaskId 或其它工作区的同名任务不代表当前页面。
      return Boolean(
        route?.kind === "task" &&
        route.taskId === target.taskId &&
        (route.workspaceIdentity?.trim() || route.workspacePath) === key &&
        tab &&
        isWorkspaceTab(tab) &&
        (tab.workspaceIdentity?.trim() || tab.workspacePath) === key &&
        state.getWorkspaceState(target.workspacePath, target.workspaceIdentity).activeTaskId ===
          target.taskId,
      );
    };
    // 跨工作区先激活 tab 会暴露缓存任务，草稿也可能保留旧历史；只消费选择提交的完整目标。
    const onVisibilityChange = () => {
      // 最小化/遮挡 = 离开（补写）；恢复可见 = 回来（先重试补写，再自动清除在面前的）。
      if (document.hidden) flushOnLeave();
      else flushThenClear();
    };
    const flushThenClear = async () => {
      // 回到窗口/恢复可见：先等补写落定（source 恢复后补上提醒），
      // 再对已补写且仍在面前的任务做自动清除。顺序保证清除只消费已写 marker。
      await flushOnLeave();
      clearOnFocus();
    };
    window.addEventListener("blur", flushOnLeave);
    window.addEventListener("focus", flushThenClear);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const navigation = onTaskNavigationCommitted((target) => {
      for (const operation of pending) {
        if (
          operation.target.taskId === target.taskId &&
          (operation.target.workspaceIdentity?.trim() || operation.target.workspacePath) ===
            (target.workspaceIdentity?.trim() || target.workspacePath) &&
          isDesktopViewing(target)
        )
          operation.viewed = true;
      }
    });
    const receive = (signal: WindowHostTaskUnreadSignal) => {
      if (disposed) return;
      const target = signal.address;
      const key = JSON.stringify([
        target.workspaceIdentity?.trim() || target.workspacePath,
        target.taskId,
      ]);
      const previous = received.current.get(key);
      if (
        previous &&
        (previous.updatedAt > signal.updatedAt ||
          (previous.updatedAt === signal.updatedAt && previous.status === signal.status))
      )
        return;
      received.current.set(key, signal);
      if (isDesktopViewing(target) || isRemoteViewing(target)) {
        // 信号到达时页面已隐藏（最小化），不会再有 blur 事件，直接补写。
        foregroundCompletions.set(taskKey(target), { target, written: false });
        if (document.hidden) flushOnLeave();
        return;
      }
      // 非查看路径本来就要写未读，顺带清掉可能残留的前台完成记录，避免重复补写。
      foregroundCompletions.delete(taskKey(target));
      const operation = { target, viewed: false, started: false };
      pending.add(operation);
      let committed = false;
      void enqueueForegroundCommand(target, async () => {
        try {
          if (!statusReady) await initialStatus;
          if (disposed || operation.viewed || isDesktopViewing(target) || isRemoteViewing(target))
            return;
          operation.started = true;
          const meta = await mutateProjectTask(
            ports,
            target,
            { kind: "mark-unread" },
            target.remoteSessionId,
          );
          committed = true;
          if (disposed) return;
          if (operation.viewed && meta?.unreadAt != null)
            await mutateProjectTask(
              ports,
              target,
              { kind: "mark-read", expectedUnreadAt: meta.unreadAt },
              target.remoteSessionId,
            );
        } finally {
          // JS同步结束处移除，防止回包处理已完成但pending尚存时丢掉新的查看命令。
          pending.delete(operation);
        }
      })
        .then(async () => {
          if (!disposed) await latestRefresh.current();
        })
        .catch((error: unknown) => {
          if (disposed) return;
          if (!committed && received.current.get(key) === signal) received.current.delete(key);
          logger.warn("[project-sidebar] 后台完成未读写入失败", { ...target, error });
          void latestRefresh.current();
        })
        .finally(() => pending.delete(operation));
    };
    const subscriptions = services.windowControllerService
      ? [services.windowControllerService.onDynamicTaskUnreadSignal()(receive)]
      : scopes.map((scope) =>
          services.zcodeTaskService.onDynamicWorkspaceEvent(scope)((event) => {
            if (
              event.type !== "workspace_task_list_changed" ||
              event.reason !== "task_status_changed" ||
              event.unreadSignal !== "background_terminal" ||
              !event.taskMeta ||
              (event.taskMeta.status !== "completed" && event.taskMeta.status !== "error")
            )
              return;
            receive({
              address: {
                taskId: event.taskId ?? event.taskMeta.taskId,
                workspacePath: event.workspacePath,
                ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
              },
              updatedAt: event.taskMeta.updatedAt,
              status: event.taskMeta.status,
            });
          }),
        );
    return () => {
      disposed = true;
      subscriptions.forEach((subscription) => subscription.dispose());
      navigation.dispose();
      unsubscribeStatus?.();
      window.removeEventListener("blur", flushOnLeave);
      window.removeEventListener("focus", flushThenClear);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      releaseStatus();
    };
  }, [services, tabs, platform, services.windowControllerService ? "controller" : scopeKey]);
}
