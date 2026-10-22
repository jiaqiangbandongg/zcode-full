import type { RuntimeCommand, RuntimeCommandId } from "../command-queue.js";
import { createTurnCancelledError } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";

type ResolvableRuntimeCommand<Result> = RuntimeCommand & {
  readonly id: RuntimeCommandId;
  readonly reject: (error: unknown) => void;
  readonly resolve: (result: Result) => void;
};

export function enqueueCancellableRuntimeCommand<
  Result,
  Command extends ResolvableRuntimeCommand<Result>,
>(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    createCommand: (handlers: {
      reject: (error: unknown) => void;
      resolve: (result: Result) => void;
    }) => Command;
    onCommandCancelled?: () => void;
    /** 已通过取消检查，尚未进入 drain 的同步接纳点。 */
    onCommandAccepted?: () => void;
  },
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    let settled = false;
    const abortSignal = input.abortSignal;
    const cleanup = () => {
      abortSignal?.removeEventListener("abort", abortQueuedCommand);
    };
    const resolveCommand = (result: Result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const rejectCommand = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const command = input.createCommand({
      reject: rejectCommand,
      resolve: resolveCommand,
    });
    function abortQueuedCommand() {
      if (settled) return;
      const removed = runtime.runtimeCommandQueue.removeById(command.id);
      if (removed) {
        input.onCommandCancelled?.();
        rejectCommand(createTurnCancelledError(abortSignal?.reason));
        return;
      }
      // 取消可能撞上 command 刚出队但尚未进入实际执行的窄窗口，先记账让执行侧跳过。
      runtime.runtimeCommandQueue.markCancelPending(command.id);
    }
    if (abortSignal?.aborted) {
      input.onCommandCancelled?.();
      rejectCommand(createTurnCancelledError(abortSignal.reason));
      return;
    }
    abortSignal?.addEventListener("abort", abortQueuedCommand, { once: true });
    try {
      input.onCommandAccepted?.();
    } catch (error) {
      input.onCommandCancelled?.();
      rejectCommand(error);
      return;
    }
    runtime.enqueueRuntimeCommand(command);
  });
}
