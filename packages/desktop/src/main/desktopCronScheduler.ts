// desktop main 侧的 cron scheduler 进程管理器。
// 职责：拉起/销毁常驻 scheduler 进程；把 scheduler 的派发请求路由给某个本地 host（转成 CronRun）；
// 把 host 回报的 CronRunResult 转回 scheduler 结算。scheduler 只碰 tasks-index，createTask 在 host 域执行。
import { utilityProcess as electronUtilityProcess } from "electron";
import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { HostMessageTypes } from "@zcode/shared";
import { buildHostProcessEnv, schedulerModulePath } from "./desktopRuntimeEnv.js";
import { ingestSchedulerSelfResourceSample } from "./processResourceSelfHeapSource.js";
import { registerSchedulerProcess, unregisterSchedulerProcess } from "./resourceManagerWindow.js";
import type {
  MainToSchedulerMessage,
  SchedulerToMainMessage,
} from "../scheduler/schedulerProtocol.js";

export interface CronRunResultPayload {
  runId: string;
  ok: boolean;
  taskId?: string;
  sessionId?: string;
  error?: string;
  failureKind?: "transient" | "permanent";
}

/** host → main 的闲时任务派发结果（与 cron 消息独立）。 */
export interface OffPeakRunResultPayload {
  offPeakTaskId: string;
  ok: boolean;
  lifecycleManaged?: true;
  conversationId?: string;
  sessionId?: string;
  error?: string;
  failureKind?: "transient" | "permanent";
}

interface CronSchedulerDeps {
  hostProcessLocalEnv: Record<string, string>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  /** 选一个能执行本地 workspace 派发的 host；无可用 host 时返回 null（scheduler 会退避重试）。 */
  resolveDispatchHost: () => ElectronUtilityProcess | null;
  /** 闲时任务执行中计数变化（keep-awake：main 据此 + 设置切 powerSaveBlocker）。 */
  onOffPeakActiveCountChanged?: (count: number) => void;
}

export interface CronSchedulerHandle {
  /** host 回报派发结果时调用，转交给 scheduler 结算。 */
  handleCronRunResult: (result: CronRunResultPayload) => void;
  /** host 回报闲时任务派发结果时调用，转交给 scheduler 结算。 */
  handleOffPeakRunResult: (result: OffPeakRunResultPayload) => void;
  /** manual run 落库后立即唤醒 scheduler，不等待下一次轮询。 */
  wake: (automationId: string) => void;
  /** app 退出前优雅收尾（通知 scheduler 释放认领 + 关库，兜底强杀）。 */
  dispose: () => Promise<void>;
}

const DISPOSE_FORCE_KILL_MS = 1_500;

export function spawnCronScheduler(deps: CronSchedulerDeps): CronSchedulerHandle {
  const child = electronUtilityProcess.fork(schedulerModulePath, [], {
    serviceName: "zcode-cron-scheduler",
    execArgv: ["--no-warnings"],
    env: {
      ...buildHostProcessEnv(deps.hostProcessLocalEnv),
      ZCODE_PROCESS_LABEL: "scheduler",
    },
  });

  deps.logger.info(`[cron-scheduler] forked scheduler process pid=${child.pid}`);
  // 资源遥测的 scheduler 角色 pid 只有 spawn 点知道，这里登记到进程角色注册表。
  registerSchedulerProcess(child);
  let isDisposing = false;
  let disposePromise: Promise<void> | null = null;

  const postToScheduler = (message: MainToSchedulerMessage): void => {
    try {
      child.postMessage(message);
    } catch (error) {
      deps.logger.warn("[cron-scheduler] postMessage to scheduler failed:", error);
    }
  };

  child.on("message", (raw: unknown) => {
    const msg = raw as SchedulerToMainMessage;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "scheduler-log") {
      const level = msg.level === "warn" ? "warn" : msg.level === "error" ? "error" : "info";
      deps.logger[level](`[cron-scheduler] ${msg.message}`);
      return;
    }

    if (msg.type === "offpeak-active-count") {
      deps.onOffPeakActiveCountChanged?.(msg.count);
      return;
    }

    // scheduler 自采的 60 秒样本：main 只取 heap 作 scheduler 角色事件的 heap 维度，
    // 非法样本在入口按 schema 丢弃。
    if (msg.type === "scheduler-resource-sample") {
      ingestSchedulerSelfResourceSample(msg.sample);
      return;
    }

    if (msg.type === "cron-dispatch-request") {
      if (isDisposing) {
        // App 退出时 Cron 与 Host 并行收口；进入 disposing 后继续派发会把新任务
        // 发送给正在关闭的 Host。明确拒绝派发，避免为了保持串行而额外增加 1.5 秒退出延迟。
        postToScheduler({
          type: "cron-dispatch-result",
          runId: msg.runId,
          ok: false,
          failureKind: "transient",
          error: "app is shutting down",
        });
        return;
      }
      const host = deps.resolveDispatchHost();
      if (!host) {
        // 没有可派发的本地 host（无窗口/未就绪）：按 transient 回执，scheduler 退避后重试。
        postToScheduler({
          type: "cron-dispatch-result",
          runId: msg.runId,
          ok: false,
          failureKind: "transient",
          error: "no local host available",
        });
        return;
      }
      try {
        host.postMessage({
          type: HostMessageTypes.CronRun,
          automationId: msg.automationId,
          runId: msg.runId,
          prompt: msg.prompt,
          targetTaskId: msg.targetTaskId,
          modelSelection: msg.modelSelection,
          mode: msg.mode,
          workspacePath: msg.workspacePath,
          workspaceIdentity: msg.workspaceIdentity,
          projectId: msg.projectId,
          hostId: msg.hostId,
          additionalDirectories: msg.additionalDirectories,
        });
      } catch (error) {
        deps.logger.warn("[cron-scheduler] forward CronRun to host failed:", error);
        postToScheduler({
          type: "cron-dispatch-result",
          runId: msg.runId,
          ok: false,
          failureKind: "transient",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (msg.type === "offpeak-dispatch-request") {
      const host = deps.resolveDispatchHost();
      if (!host) {
        // 无可用 host：transient 回执，scheduler 按 off-peak 独立退避重试（顺延不丢弃）。
        postToScheduler({
          type: "offpeak-dispatch-result",
          offPeakTaskId: msg.offPeakTaskId,
          ok: false,
          failureKind: "transient",
          error: "no local host available",
        });
        return;
      }
      try {
        host.postMessage({
          type: HostMessageTypes.OffPeakRun,
          offPeakTaskId: msg.offPeakTaskId,
          prompt: msg.prompt,
          permissionMode: msg.permissionMode,
          modelSelection: msg.modelSelection,
          conversationId: msg.conversationId,
          sessionId: msg.sessionId,
          serverTicketId: msg.serverTicketId,
          workspacePath: msg.workspacePath,
          workspaceIdentity: msg.workspaceIdentity,
          projectId: msg.projectId,
          hostId: msg.hostId,
          additionalDirectories: msg.additionalDirectories,
        });
      } catch (error) {
        deps.logger.warn("[cron-scheduler] forward OffPeakRun to host failed:", error);
        postToScheduler({
          type: "offpeak-dispatch-result",
          offPeakTaskId: msg.offPeakTaskId,
          ok: false,
          failureKind: "transient",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  });

  child.on("exit", (code) => {
    unregisterSchedulerProcess(child);
    deps.logger.info(`[cron-scheduler] scheduler process exited code=${code}`);
  });

  return {
    handleCronRunResult(result) {
      postToScheduler({ type: "cron-dispatch-result", ...result });
    },
    handleOffPeakRunResult(result) {
      postToScheduler({ type: "offpeak-dispatch-result", ...result });
    },
    wake(automationId) {
      if (isDisposing) return;
      postToScheduler({ type: "scheduler-wake", automationId });
    },
    dispose() {
      if (disposePromise) return disposePromise;
      isDisposing = true;
      postToScheduler({ type: "scheduler-dispose" });
      disposePromise = new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // 忽略。
          }
          done();
        }, DISPOSE_FORCE_KILL_MS);
        child.once("exit", done);
      });
      return disposePromise;
    },
  };
}
