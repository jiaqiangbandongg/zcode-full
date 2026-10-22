import type { ZCodeAutomationScheduleRule } from "@zcode/shared";
import { Cron } from "croner";

/** 校验 cron 表达式是否合法（5 段，本地时区）。 */
export function isValidCronExpr(cronExpr: string): boolean {
  try {
    // croner 构造时即解析，非法表达式会抛错。
    new Cron(cronExpr);
    return true;
  } catch {
    return false;
  }
}

/** 非法自定义调度规则；规则必须先通过领域校验才能写入内部任务库。 */
export class InvalidAutomationScheduleRuleError extends Error {
  constructor(message: string) {
    super(`非法的定时任务调度规则：${message}`);
    this.name = "InvalidAutomationScheduleRuleError";
  }
}

const MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL = 1_200;
const AUTOMATION_SCHEDULE_RULE_UNITS = new Set([
  "minute",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);

function hasOnlyIntegersInRange(values: number[] | undefined, min: number, max: number): boolean {
  return Boolean(
    values?.length &&
    values.every((value) => Number.isInteger(value) && value >= min && value <= max),
  );
}

export function assertValidAutomationScheduleRule(rule: ZCodeAutomationScheduleRule): void {
  if (!AUTOMATION_SCHEDULE_RULE_UNITS.has(rule.unit)) {
    throw new InvalidAutomationScheduleRuleError("unit 不受支持");
  }
  if (!Number.isInteger(rule.interval) || rule.interval < 1) {
    throw new InvalidAutomationScheduleRuleError("interval 必须是正整数");
  }
  if (rule.unit === "monthly" && rule.interval > MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL) {
    throw new InvalidAutomationScheduleRuleError(
      `monthly interval 不能超过 ${MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL}`,
    );
  }
  if (!Number.isInteger(rule.hour) || rule.hour < 0 || rule.hour > 23) {
    throw new InvalidAutomationScheduleRuleError("hour 必须是 0-23 的整数");
  }
  if (!Number.isInteger(rule.minute) || rule.minute < 0 || rule.minute > 59) {
    throw new InvalidAutomationScheduleRuleError("minute 必须是 0-59 的整数");
  }
  if (
    rule.monthlyMode !== undefined &&
    rule.monthlyMode !== "date" &&
    rule.monthlyMode !== "weekday"
  ) {
    throw new InvalidAutomationScheduleRuleError("monthlyMode 不受支持");
  }
  if (rule.weekdays && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
    throw new InvalidAutomationScheduleRuleError("weekdays 必须是 0-6 的非空整数数组");
  }
  if (rule.unit === "weekly" && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
    throw new InvalidAutomationScheduleRuleError("weekly 规则必须包含有效的 weekdays");
  }
  if (rule.unit === "monthly") {
    if (rule.monthlyMode === "weekday" && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
      throw new InvalidAutomationScheduleRuleError("monthly weekday 规则必须包含有效的 weekdays");
    }
    if (rule.monthlyMode !== "weekday" && !hasOnlyIntegersInRange(rule.monthDays, 1, 31)) {
      throw new InvalidAutomationScheduleRuleError("monthly date 规则必须包含有效的 monthDays");
    }
  }
  if (rule.months && !hasOnlyIntegersInRange(rule.months, 1, 12)) {
    throw new InvalidAutomationScheduleRuleError("months 必须是 1-12 的非空整数数组");
  }
  if (rule.monthDays && !hasOnlyIntegersInRange(rule.monthDays, 1, 31)) {
    throw new InvalidAutomationScheduleRuleError("monthDays 必须是 1-31 的非空整数数组");
  }
}
