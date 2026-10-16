import { describe, expect, it } from "vitest";
import {
  buildIntervalScheduleRule,
  buildRelativeDelaySchedule,
  computeInitialAutomationNextRunAt,
  computeNextRunAt,
  computeScheduleRuleNextRunAt,
  inferMinuteIntervalScheduleRule,
  isOneShotAutomation,
  isValidCronExpr,
  StaleOneShotAutomationScheduleError,
} from "../src/session/automationCron.js";

describe("automationCron", () => {
  it("isOneShotAutomation：只有非循环且至多一次的任务是纯一次性", () => {
    // 一次性语义是确定的目标时刻，scheduler misfire 后据此终态，不得再排程。
    expect(isOneShotAutomation({ recurring: false })).toBe(true);
    expect(isOneShotAutomation({ recurring: false, maxRuns: 1 })).toBe(true);
    expect(isOneShotAutomation({ recurring: false, maxRuns: 3 })).toBe(false);
    expect(isOneShotAutomation({ recurring: true })).toBe(false);
  });

  it("isValidCronExpr：合法 5 段表达式返回 true", () => {
    expect(isValidCronExpr("0 9 * * *")).toBe(true);
    expect(isValidCronExpr("*/5 * * * *")).toBe(true);
    expect(isValidCronExpr("30 18 * * 1,3,5")).toBe(true);
    expect(isValidCronExpr("0 9 * */2 1#1")).toBe(true);
  });

  it("isValidCronExpr：非法表达式返回 false", () => {
    expect(isValidCronExpr("not a cron")).toBe(false);
    expect(isValidCronExpr("99 99 * * *")).toBe(false);
    expect(isValidCronExpr("")).toBe(false);
  });

  it("computeNextRunAt：每天 09:00 的下一次严格晚于基准且命中 09:00", () => {
    // 基准：本地 2023-11-14T20:00 左右（用固定戳，避免依赖当前时间）。
    const from = new Date(2023, 10, 14, 20, 0, 0).getTime();
    const next = computeNextRunAt("0 9 * * *", from);
    expect(next).not.toBeNull();
    expect(next!).toBeGreaterThan(from);
    const d = new Date(next!);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });

  it("computeNextRunAt：从 08:00 出发，当天 09:00 即为下一次", () => {
    const from = new Date(2023, 10, 14, 8, 0, 0).getTime();
    const next = computeNextRunAt("0 9 * * *", from);
    const expected = new Date(2023, 10, 14, 9, 0, 0).getTime();
    expect(next).toBe(expected);
  });

  it("computeNextRunAt：每分钟表达式返回下一分钟", () => {
    const from = new Date(2023, 10, 14, 8, 0, 30).getTime();
    const next = computeNextRunAt("* * * * *", from);
    const expected = new Date(2023, 10, 14, 8, 1, 0).getTime();
    expect(next).toBe(expected);
  });

  it("相对分钟计划以服务端真实时钟为锚点，保留秒级延迟", () => {
    const from = new Date(2026, 6, 28, 14, 44, 28).getTime();
    const schedule = buildRelativeDelaySchedule(3, from);

    expect(schedule.cronExpr).toBe("47 14 28 7 *");
    expect(schedule.scheduleRule).toMatchObject({
      unit: "minute",
      interval: 3,
      anchorAt: from,
    });
    expect(computeScheduleRuleNextRunAt(schedule.scheduleRule!, from)).toBe(from + 3 * 60_000);
  });

  it("一次性固定月日 cron 刚错过目标分钟时立即到期，避免滚到下一年", () => {
    const from = new Date(2026, 6, 16, 17, 31, 30).getTime();

    expect(
      computeInitialAutomationNextRunAt(
        {
          cronExpr: "31 17 16 7 *",
          recurring: false,
        },
        from,
      ),
    ).toBe(from);
  });

  it("一次性固定月日 cron 目标已过去 4 分 53 秒时拒绝创建", () => {
    const from = new Date(2026, 6, 28, 14, 38, 53).getTime();

    expect(() =>
      computeInitialAutomationNextRunAt(
        {
          cronExpr: "34 14 28 7 *",
          recurring: false,
        },
        from,
      ),
    ).toThrow(StaleOneShotAutomationScheduleError);
  });

  it("一次性固定月日 cron 跨过目标整一分钟时不再补执行", () => {
    const from = new Date(2026, 6, 28, 14, 35, 0).getTime();

    expect(() =>
      computeInitialAutomationNextRunAt(
        {
          cronExpr: "34 14 28 7 *",
          recurring: false,
        },
        from,
      ),
    ).toThrow(StaleOneShotAutomationScheduleError);
  });

  it("循环任务与尚未到期的一次性日历任务保持原计划", () => {
    const from = new Date(2026, 6, 16, 17, 31, 30).getTime();
    const nextYear = new Date(2027, 6, 16, 17, 31, 0).getTime();

    expect(
      computeInitialAutomationNextRunAt(
        { cronExpr: "31 17 16 7 *", recurring: true },
        from,
      ),
    ).toBe(nextYear);
    expect(
      computeInitialAutomationNextRunAt(
        { cronExpr: "32 17 16 7 *", recurring: false },
        from,
      ),
    ).toBe(new Date(2026, 6, 16, 17, 32, 0).getTime());
  });

  it("一次性固定月日 cron 目标已过去 6 分钟（模型时钟漂移）时拒绝创建，不静默滚到下一年", () => {
    // 回归：'8分钟后' 被模型自算成固定日历 cron，创建时目标分钟已过去几分钟，
    // 旧的 5 分钟窗口放过它 → 静默滚到下一年（下次运行显示 2027）。30 分钟窗口覆盖漂移，改为拒绝。
    const from = new Date(2026, 6, 16, 17, 37, 0).getTime();

    expect(() =>
      computeInitialAutomationNextRunAt(
        { cronExpr: "31 17 16 7 *", recurring: false },
        from,
      ),
    ).toThrow(StaleOneShotAutomationScheduleError);
  });

  it("一次性日历任务在目标月份之后创建时保留下一年语义", () => {
    // 创建于 8 月、目标是 7 月 16 日：目标已过去约一个月，远超陈旧识别窗口，
    // 属于用户明确要约到下一年，而非模型算错的近似当下时刻。
    const from = new Date(2026, 7, 16, 12, 0, 0).getTime();

    expect(
      computeInitialAutomationNextRunAt(
        { cronExpr: "31 17 16 7 *", recurring: false },
        from,
      ),
    ).toBe(new Date(2027, 6, 16, 17, 31, 0).getTime());
  });

  it("computeScheduleRuleNextRunAt：每 31 小时按锚点推进并保持第 49 分", () => {
    const anchorAt = new Date(2026, 7, 4, 18, 38).getTime();
    const rule = {
      unit: "hourly" as const,
      interval: 31,
      hour: 0,
      minute: 49,
      anchorAt,
    };

    const first = computeScheduleRuleNextRunAt(rule, anchorAt);
    expect(first).toBe(new Date(2026, 7, 4, 18, 49).getTime());
    expect(computeScheduleRuleNextRunAt(rule, first!)).toBe(
      new Date(2026, 7, 6, 1, 49).getTime(),
    );
  });

  it("computeScheduleRuleNextRunAt：每 2 周保持锚点周序", () => {
    const anchorAt = new Date(2024, 0, 1, 8, 0).getTime(); // 周一
    const next = computeScheduleRuleNextRunAt(
      {
        unit: "weekly",
        interval: 2,
        hour: 9,
        minute: 0,
        anchorAt,
        weekdays: [2],
      },
      new Date(2024, 0, 2, 10, 0).getTime(),
    );
    expect(next).toBe(new Date(2024, 0, 16, 9, 0).getTime());
  });

  it("每 10 分钟从创建时刻计时，不提前命中墙钟刻度且不随晚派发漂移", () => {
    const anchorAt = new Date(2026, 6, 20, 11, 46, 15).getTime();
    const rule = inferMinuteIntervalScheduleRule("*/10 * * * *", anchorAt);

    expect(rule).toMatchObject({ unit: "minute", interval: 10, anchorAt });
    expect(computeScheduleRuleNextRunAt(rule!, anchorAt)).toBe(
      new Date(2026, 6, 20, 11, 56, 15).getTime(),
    );
    expect(computeScheduleRuleNextRunAt(rule!, new Date(2026, 6, 20, 11, 57).getTime())).toBe(
      new Date(2026, 6, 20, 12, 6, 15).getTime(),
    );
  });

  it("computeScheduleRuleNextRunAt：每 2 年保持锚点月日", () => {
    const anchorAt = new Date(2026, 6, 12, 8, 0).getTime();
    const next = computeScheduleRuleNextRunAt(
      {
        unit: "yearly",
        interval: 2,
        hour: 9,
        minute: 30,
        anchorAt,
        monthDays: [12],
      },
      new Date(2026, 6, 13, 0, 0).getTime(),
    );
    expect(next).toBe(new Date(2028, 6, 12, 9, 30).getTime());
  });

  it("computeScheduleRuleNextRunAt：月度间隔 1200 的边界仍能计算下一轮", () => {
    const anchorAt = new Date(2026, 0, 1, 10, 0).getTime();
    const next = computeScheduleRuleNextRunAt(
      {
        unit: "monthly",
        interval: 1_200,
        hour: 9,
        minute: 0,
        anchorAt,
        monthDays: [1],
        monthlyMode: "date",
      },
      anchorAt,
    );

    expect(next).toBe(new Date(2126, 0, 1, 9, 0).getTime());
  });

  it("computeScheduleRuleNextRunAt：months 覆盖锚点月份", () => {
    // 锚点在 7 月，但规则指定 3 月 5 日 → 下次应落到（次年）3 月。
    const anchorAt = new Date(2026, 6, 12, 8, 0).getTime();
    const next = computeScheduleRuleNextRunAt(
      {
        unit: "yearly",
        interval: 1,
        hour: 9,
        minute: 30,
        anchorAt,
        months: [3],
        monthDays: [5],
      },
      new Date(2026, 6, 13, 0, 0).getTime(),
    );
    expect(next).toBe(new Date(2027, 2, 5, 9, 30).getTime());
  });

  it("computeScheduleRuleNextRunAt：2/29 只在闰年触发（溢出守卫）", () => {
    const anchorAt = new Date(2025, 0, 1, 8, 0).getTime();
    const next = computeScheduleRuleNextRunAt(
      {
        unit: "yearly",
        interval: 1,
        hour: 9,
        minute: 30,
        anchorAt,
        months: [2],
        monthDays: [29],
      },
      new Date(2025, 5, 1, 0, 0).getTime(),
    );
    // 2026/2027 非闰年被守卫跳过，落到 2028-02-29。
    expect(next).toBe(new Date(2028, 1, 29, 9, 30).getTime());
  });

  describe("buildIntervalScheduleRule：会话侧长间隔 carrier 归一化", () => {
    // Bug 背景：cron 各字段有步长上限（minute 59、hour 24、day-of-month 31、month 12），
    // 「每50小时/每40天/每13个月」无法用五段 cron 直接表达。会话侧用 intervalUnit+interval
    // 受控 carrier，host 端用本函数把兼容 cron 各字段解析成权威 scheduleRule，真实间隔由
    // scheduleRule 承载，cronExpr 仅作展示。anchorAt 由调用方（service）传入真实创建/修改时刻。
    const anchorAt = new Date(2026, 7, 4, 10, 30, 0).getTime();

    it("hourly：从兼容 cron 解析 minute，间隔 50 落入 scheduleRule", () => {
      // 兼容 cron '15 * * * *' 表示「每小时的第15分」，真实间隔 50 小时由 carrier 承载。
      const rule = buildIntervalScheduleRule("hourly", 50, "15 * * * *", anchorAt);
      expect(rule).toMatchObject({
        unit: "hourly",
        interval: 50,
        hour: 0,
        minute: 15,
        anchorAt,
      });
      expect(rule!.weekdays).toBeUndefined();
      // 下一次：锚点 10:30 之后第一个 15 分，再 +50 小时。
      expect(computeScheduleRuleNextRunAt(rule!, anchorAt)).toBe(
        new Date(2026, 7, 4, 10, 15).getTime() + 50 * 3_600_000,
      );
    });

    it("daily：解析 hour/minute，间隔 40 落入 scheduleRule", () => {
      const rule = buildIntervalScheduleRule("daily", 40, "9 9 * * *", anchorAt);
      expect(rule).toMatchObject({
        unit: "daily",
        interval: 40,
        hour: 9,
        minute: 9,
        anchorAt,
      });
      // 下一次：锚点 8/4 10:30 已过当天 09:09，按 40 天间隔推进，下一轮是 8/4 + 40 = 9/13 09:09。
      expect(computeScheduleRuleNextRunAt(rule!, anchorAt)).toBe(
        new Date(2026, 8, 13, 9, 9).getTime(),
      );
    });

    it("weekly：从 dow 解析 weekdays，间隔 8 落入 scheduleRule", () => {
      // 兼容 cron '0 9 * * 1,3,5' 表示周一/三/五 09:00，真实间隔 8 周。
      const rule = buildIntervalScheduleRule("weekly", 8, "0 9 * * 1,3,5", anchorAt);
      expect(rule).toMatchObject({
        unit: "weekly",
        interval: 8,
        hour: 9,
        minute: 0,
        weekdays: [1, 3, 5],
        anchorAt,
      });
    });

    it("monthly：从 dom 解析 monthDays，间隔 13 落入 scheduleRule", () => {
      // 兼容 cron '0 9 15 * *' 表示每月 15 日 09:00，真实间隔 13 个月。
      const rule = buildIntervalScheduleRule("monthly", 13, "0 9 15 * *", anchorAt);
      expect(rule).toMatchObject({
        unit: "monthly",
        interval: 13,
        hour: 9,
        minute: 0,
        monthDays: [15],
        monthlyMode: "date",
        anchorAt,
      });
    });

    it("yearly：从 dom+month 解析 months+monthDays，间隔 2 落入 scheduleRule", () => {
      // 兼容 cron '0 9 15 6 *' 表示每年 6 月 15 日 09:00，真实间隔 2 年。
      const rule = buildIntervalScheduleRule("yearly", 2, "0 9 15 6 *", anchorAt);
      expect(rule).toMatchObject({
        unit: "yearly",
        interval: 2,
        hour: 9,
        minute: 0,
        months: [6],
        monthDays: [15],
        anchorAt,
      });
    });

    it("minute：直接以 anchorAt 的时分作展示锚点，间隔 90 落入 scheduleRule", () => {
      // 兼容 cron '* * * * *' 仅作占位展示，真实间隔 90 分钟。
      const rule = buildIntervalScheduleRule("minute", 90, "* * * * *", anchorAt);
      expect(rule).toMatchObject({
        unit: "minute",
        interval: 90,
        hour: 10,
        minute: 30,
        anchorAt,
      });
    });

    it("兼容 cron 字段缺失时回退到安全默认值，不抛错", () => {
      // 模型可能传 '* * * * *' 占位 cron 给 weekly/monthly/yearly；解析失败时给合理默认值
      // （weekday=[1]、monthDays=[1]、months=[锚点月]），保证调度引擎仍可计算。
      // hour/minute 取锚点时分（'*' 解析为 undefined 后回退到 anchorAt 的时分）。
      const rule = buildIntervalScheduleRule("weekly", 5, "* * * * *", anchorAt);
      expect(rule).toMatchObject({
        unit: "weekly",
        interval: 5,
        weekdays: [1],
        hour: 10,
        minute: 30,
      });
      const monthlyRule = buildIntervalScheduleRule("monthly", 7, "* * * * *", anchorAt);
      expect(monthlyRule).toMatchObject({ unit: "monthly", monthDays: [4] });
      const yearlyRule = buildIntervalScheduleRule("yearly", 3, "* * * * *", anchorAt);
      expect(yearlyRule).toMatchObject({
        unit: "yearly",
        months: [new Date(anchorAt).getMonth() + 1],
        monthDays: [new Date(anchorAt).getDate()],
      });
    });

    it("无效 unit 抛错，避免静默生成错误规则", () => {
      expect(() =>
        buildIntervalScheduleRule("decade" as never, 10, "0 9 * * *", anchorAt),
      ).toThrow();
    });
  });
});
