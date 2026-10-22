import type { ModelRequestAuth, ModelSelection, SessionEventSink } from "@zcode/contracts";
import type { OffPeakControlParams, OffPeakControlResult } from "@zcode/shared";
import { isTerminalRuntimeTask } from "../../runtime-task/registry.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ExecuteTurnOptions, ModelExecutionContext } from "../types.js";
import { OffPeakLifecycle, type OffPeakLifecycleEvent, type OffPeakOutcome } from "./lifecycle.js";
import { OffPeakTicketAuthority, type OffPeakModelBinding } from "./model-binding.js";

const controllers = new WeakMap<AgentRuntimeInternal, OffPeakRuntimeExecution>();
const sinks = new WeakMap<AgentRuntimeInternal, (event: OffPeakLifecycleEvent) => void>();
const temporarySelections = new WeakMap<AgentRuntimeInternal, ModelSelection | undefined>();

export function configureOffPeakRuntime(
  runtime: AgentRuntimeInternal,
  sink?: (event: OffPeakLifecycleEvent) => void,
): void {
  if (sink) sinks.set(runtime, sink);
}
export function getOffPeakExecution(
  runtime: AgentRuntimeInternal,
): OffPeakRuntimeExecution | undefined {
  return controllers.get(runtime);
}
export function markTemporaryRuntimeSelection(
  runtime: AgentRuntimeInternal,
  ordinary: ModelSelection | undefined,
): void {
  temporarySelections.set(runtime, ordinary && structuredClone(ordinary));
}
export function selectionForPersistence(
  runtime: AgentRuntimeInternal,
  selection?: ModelSelection,
): ModelSelection | undefined {
  if (temporarySelections.has(runtime)) return temporarySelections.get(runtime);
  const execution = controllers.get(runtime);
  // 终态控制器只保留幂等回执，不能继续覆盖随后普通用户选择的持久化。
  return execution && !execution.lifecycle.terminal && !execution.lifecycle.ownedByUser
    ? execution.ordinarySelection
    : selection;
}
export function acceptOffPeakUserTakeover(runtime: AgentRuntimeInternal): void {
  controllers.get(runtime)?.lifecycle.takeOver();
}
export function refreshOffPeakWork(runtime: AgentRuntimeInternal): void {
  controllers.get(runtime)?.refreshWork();
}
export async function controlOffPeakRuntime(
  runtime: AgentRuntimeInternal,
  input: OffPeakControlParams,
): Promise<OffPeakControlResult> {
  const execution = controllers.get(runtime);
  if (
    input.sessionId !== runtime.sessionId ||
    !execution ||
    execution.executionId !== input.executionId
  )
    return { accepted: false };
  if (input.action === "cancel") {
    await execution.cancel();
    return { accepted: true };
  }
  return {
    accepted: execution.replaceTicket(
      input.executionId,
      input.renewalId,
      input.ticketId,
      input.requestAuth,
    ),
  };
}

/** 仅在普通执行入口衔接上下文，模型循环、通知和工具仍由原来的执行器调度。 */
export function prepareOffPeakTurn(
  runtime: AgentRuntimeInternal,
  original?: ExecuteTurnOptions,
): {
  options: ExecuteTurnOptions | undefined;
  release(outcome: OffPeakOutcome): void;
} {
  let execution = controllers.get(runtime);
  const initial = original?.modelExecution?.offPeak;
  if (initial) {
    if (execution && !execution.lifecycle.terminal && execution.executionId !== initial.executionId)
      throw new Error("off_peak_execution_already_active");
    if (!execution || execution.lifecycle.terminal) {
      const selection = original?.intent?.modelSelection;
      if (!selection || !original?.offPeakTaskId)
        throw new Error("off_peak_execution_identity_missing");
      execution = new OffPeakRuntimeExecution(
        runtime,
        original.offPeakTaskId,
        selection,
        original.modelExecution!,
      );
      controllers.set(runtime, execution);
      runtime.setSessionModelSelection(selection);
    }
  }
  const ownsTurn =
    execution &&
    !execution.lifecycle.terminal &&
    (initial || original?.offPeakExecutionId === execution.executionId);
  if (!execution || !ownsTurn || execution.lifecycle.ownedByUser) {
    // 同会话原先存在的后台工作不属于本项闲时任务，仍使用原普通选择。
    return {
      options:
        execution &&
        !execution.lifecycle.terminal &&
        !execution.lifecycle.ownedByUser &&
        !original?.intent
          ? { ...original, executionSelection: execution.ordinarySelection }
          : original,
      release() {},
    };
  }
  const binding = execution.authority.createBinding();
  const activeExecution = execution;
  const options: ExecuteTurnOptions = {
    ...original,
    automationId: undefined,
    offPeakExecutionId: execution.executionId,
    offPeakTaskId: execution.offPeakTaskId,
    executionSelection: execution.selection,
    modelExecution: {
      selectionScope: "execution",
      memoryExtraction: "skip",
      requestDependencies: binding.requestDependencies,
      subagents: { foregroundModel: "submission", background: "allow" },
    },
  };
  return {
    options,
    release(outcome) {
      activeExecution.lifecycle.mainEnded(outcome);
      binding.release();
      activeExecution.refreshWork();
    },
  };
}

export class OffPeakRuntimeExecution {
  readonly lifecycle: OffPeakLifecycle;
  readonly authority: OffPeakTicketAuthority;
  readonly ordinarySelection: ModelSelection | undefined;
  readonly executionId: string;
  private pendingInputs = true;
  private reading = false;
  private revision = 0;
  private unsubscribeRegistry?: () => void;
  private readonly eventSink: SessionEventSink;

  constructor(
    private readonly runtime: AgentRuntimeInternal,
    readonly offPeakTaskId: string,
    readonly selection: ModelSelection,
    execution: ModelExecutionContext,
  ) {
    const initial = execution.offPeak!;
    this.executionId = initial.executionId;
    this.ordinarySelection = runtime.getSessionModelSelection();
    this.lifecycle = new OffPeakLifecycle({
      ...initial,
      offPeakTaskId,
      readWork: () => {
        const tasks = Object.values(runtime.runtimeTaskRegistry.all()).filter(
          (task) => task.offPeakExecutionId === this.executionId,
        );
        return {
          mainRunning: runtime.hasActiveOrQueuedTurnWork(),
          backgroundRunning: tasks.some((task) => !isTerminalRuntimeTask(task)),
          pendingNotifications: tasks.some(
            (task) =>
              (task.isBackgrounded && task.notified !== true) ||
              (task.pendingMessages?.length ?? 0) > 0,
          ),
          pendingInputs:
            this.pendingInputs || this.reading || runtime.pendingInputReservations.size > 0,
        };
      },
      emit: (event) => {
        sinks.get(runtime)?.(event);
        if (event.type === "completed") this.dispose();
      },
    });
    this.authority = new OffPeakTicketAuthority(this.lifecycle, {
      ...initial,
      providerId: selection.providerId,
      requestAuthSource: execution.requestDependencies?.requestAuth?.source,
    });
    runtime.runtimeTaskRegistry.setOffPeakExecutionId?.(this.executionId);
    this.unsubscribeRegistry = runtime.runtimeTaskRegistry.subscribe?.(() => this.refreshWork());
    this.eventSink = {
      onSessionEvent: (event) => {
        // 队列事实留在原投影；这里只订阅改变完成条件的事件，不复制 accepted input queue。
        if (event.type.startsWith("turn_") || event.type.startsWith("subagent_"))
          this.refreshWork();
      },
    };
    runtime.eventSinks.add(this.eventSink);
  }

  createChildBinding(): OffPeakModelBinding | undefined {
    return this.lifecycle.ownedByUser || this.lifecycle.terminal
      ? undefined
      : this.authority.createBinding();
  }
  replaceTicket(
    executionId: string,
    renewalId: number,
    ticketId: string,
    auth: ModelRequestAuth,
  ): boolean {
    return (
      executionId === this.executionId && this.authority.replaceTicket(renewalId, ticketId, auth)
    );
  }
  async cancel(): Promise<void> {
    // 终态控制器保留用于重复确认；旧 cancel 不能停止同会话后来启动的用户轮。
    if (this.lifecycle.terminal) return;
    const foregroundExecutionId = this.runtime.getActiveForegroundExecutionId();
    for (const task of Object.values(this.runtime.runtimeTaskRegistry.all())) {
      if (task.offPeakExecutionId === this.executionId)
        this.runtime.runtimeTaskRegistry.update(task.taskId, (current) => ({
          ...current,
          offPeakCancelled: true,
        }));
    }
    for (const command of this.runtime.runtimeCommandQueue.snapshot()) {
      if (
        command.offPeakExecutionId === this.executionId &&
        (command.mode === "task-notification" || command.mode === "subagent-message")
      )
        this.runtime.runtimeCommandQueue.removeById(command.id);
    }
    this.lifecycle.cancel();
    if (foregroundExecutionId)
      this.runtime.stopActiveForegroundExecution({
        expectedForegroundExecutionId: foregroundExecutionId,
      });
    const tasks = Object.values(this.runtime.runtimeTaskRegistry.all()).filter(
      (task) => task.offPeakExecutionId === this.executionId && !isTerminalRuntimeTask(task),
    );
    await Promise.all(
      tasks.map((task) =>
        this.runtime.stopBackgroundTask(task.taskId, {
          traceContext: this.runtime.rootTraceContext,
        }),
      ),
    );
  }
  refreshWork(): void {
    this.revision++;
    if (this.reading || this.lifecycle.terminal) return;
    this.reading = true;
    void this.readPendingInputs()
      .catch((error) => {
        // 无法读取权威队列时不提前完成，也不凭计时器猜测；下一次工作事件重新读取。
        this.pendingInputs = true;
        this.runtime.logger?.warn("Off-peak work projection failed", {
          error: String(error),
          event: "off_peak.work_read_failed",
        });
      })
      .finally(() => {
        this.reading = false;
        this.lifecycle.workChanged();
      });
  }
  private async readPendingInputs(): Promise<void> {
    let version: number;
    do {
      version = this.revision;
      const projection = await this.runtime.rebuildProjection();
      this.pendingInputs = projection.pendingSteerInputs.length > 0;
    } while (version !== this.revision && !this.lifecycle.terminal);
  }
  private dispose(): void {
    this.unsubscribeRegistry?.();
    this.runtime.eventSinks.delete(this.eventSink);
    this.runtime.runtimeTaskRegistry.setOffPeakExecutionId?.(undefined);
    if (!this.lifecycle.ownedByUser) this.runtime.setSessionModelSelection(this.ordinarySelection);
  }
}
