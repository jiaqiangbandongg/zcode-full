import {
  providerProvisioningResultSchema,
  providerProvisioningTriggerSchema,
  type ProviderProvisioningResult,
  type ProviderProvisioningTrigger,
} from "@zcode/shared";

export interface ProvisioningSyncEvent {
  kind: "completed" | "warning";
  environmentKey: string;
  trigger: ProviderProvisioningTrigger;
  status: ProviderProvisioningResult["status"];
  durationMs: number;
}

/** 只认 Main 完整落盘的结构化结果，保留重复事件，不转抄自由文本错误。 */
export function parseProvisioningSyncEvents(text: string): ProvisioningSyncEvent[] {
  const events: ProvisioningSyncEvent[] = [];
  for (const line of text.split("\n").slice(0, -1)) {
    const match = line.match(
      /^\[[^\]]+\] \[(\w+)\] \[pid:\d+\] \[main\] \[provider-provisioning\] Environment sync (completed|did not apply) (.+)$/u,
    );
    if (!match) continue;
    const context: Record<string, unknown> = JSON.parse(match[3]!);
    if (
      !context ||
      typeof context !== "object" ||
      typeof context.environmentKey !== "string" ||
      !context.environmentKey ||
      typeof context.durationMs !== "number" ||
      !Number.isFinite(context.durationMs) ||
      context.durationMs < 0
    ) {
      throw new Error("Provisioning Main 日志缺少合法上下文");
    }
    const status = providerProvisioningResultSchema.shape.status.parse(context.status);
    const trigger = providerProvisioningTriggerSchema.parse(context.trigger);
    const kind = match[2] === "completed" ? "completed" : "warning";
    const applied = status === "applied" || status === "already-applied";
    if ((kind === "completed") !== applied || match[1] !== (applied ? "info" : "warn")) {
      throw new Error("Provisioning Main 日志级别、事件与状态不一致");
    }
    events.push({
      kind,
      environmentKey: context.environmentKey,
      trigger,
      status,
      durationMs: context.durationMs,
    });
  }
  return events;
}
