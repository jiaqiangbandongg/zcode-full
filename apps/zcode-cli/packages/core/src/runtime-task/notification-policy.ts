import type { RuntimeTaskSnapshot, RuntimeTaskType } from "./registry.js";

export function runtimeTaskTypeOf(
  task: Pick<RuntimeTaskSnapshot, "taskType" | "type"> | undefined,
): RuntimeTaskType | undefined {
  return task?.taskType ?? task?.type;
}

export function shouldSuppressSealedSubagentBashNotification(input: {
  isSubagentChildRuntime: boolean;
  notificationSealed: boolean;
  registryTask?: Pick<RuntimeTaskSnapshot, "taskType" | "type">;
  toolName?: string;
}): boolean {
  if (!input.isSubagentChildRuntime) return false;
  if (!input.notificationSealed) return false;
  return input.toolName === "Bash" || runtimeTaskTypeOf(input.registryTask) === "local_bash";
}
