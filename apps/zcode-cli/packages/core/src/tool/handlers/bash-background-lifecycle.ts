import type {
  BackgroundExecutionStartResult,
  ExecutionPort,
  ExecutionRequest,
  ExecutionResult,
  ExecutionRunOptions,
} from "@zcode/contracts";

export type BashBackgroundLifecycleMode = "explicit" | "auto_on_timeout";

export type BashBackgroundLifecycleResult =
  | {
      kind: "foreground";
      result: ExecutionResult;
    }
  | {
      kind: "backgrounded";
      task: BackgroundExecutionStartResult;
    };

export interface BashBackgroundLifecycleExecutionPort extends ExecutionPort {
  runBashWithBackgroundLifecycle(
    request: ExecutionRequest,
    lifecycle: { mode: BashBackgroundLifecycleMode },
    options?: ExecutionRunOptions,
  ): Promise<BashBackgroundLifecycleResult>;
}

export function supportsBashBackgroundLifecycle(
  executionPort: ExecutionPort,
): executionPort is BashBackgroundLifecycleExecutionPort {
  return (
    typeof (executionPort as Partial<BashBackgroundLifecycleExecutionPort>)
      .runBashWithBackgroundLifecycle === "function"
  );
}
