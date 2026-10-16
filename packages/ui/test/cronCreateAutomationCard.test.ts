import { describe, expect, it } from "vitest";
import { readCronCreateAutomationOutputSummary } from "@/ToolCallBlocks/renderers/cron-create.js";
import { describeAutomationCardSchedule } from "@/settings/automationCardSchedule.js";

describe("CronCreateAutomationCard output", () => {
  it("保留 scheduleRule，使长小时间隔不会按兼容 cron 展示为每小时", () => {
    const automation = readCronCreateAutomationOutputSummary(
      JSON.stringify({
        automation: {
          automation_id: "automation-31-hours",
          title: "每 31 小时执行",
          cron_expr: "49 * * * *",
          scheduleRule: {
            unit: "hourly",
            interval: 31,
            hour: 0,
            minute: 49,
            anchorAt: new Date(2026, 7, 5, 17, 49).getTime(),
          },
        },
      }),
    );

    expect(automation).toMatchObject({
      automationId: "automation-31-hours",
      title: "每 31 小时执行",
      cronExpr: "49 * * * *",
      scheduleRule: {
        unit: "hourly",
        interval: 31,
        minute: 49,
      },
    });
    expect(automation?.scheduleRule).toBeDefined();

    const schedule = describeAutomationCardSchedule(
      {
        cronExpr: automation?.cronExpr ?? "",
        scheduleRule: automation?.scheduleRule,
      },
      {
        formatMessage: ({ id }, values) =>
          id === "automations.schedule.customHourly"
            ? `每 ${values?.["interval"]} 小时的第 ${values?.["time"]} 分`
            : id,
      },
    );

    expect(schedule).toBe("每 31 小时的第 49 分");
  });
});
