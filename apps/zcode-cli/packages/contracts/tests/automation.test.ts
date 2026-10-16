import { describe, expect, it } from "vitest";
import {
  CronCreateInputJsonSchema,
  CronCreateInputSchema,
  CronUpdateInputJsonSchema,
  CronUpdateInputSchema,
} from "../src/tools/automation.js";

describe("automation tool contracts", () => {
  it("CronCreate 要求标题保留用户的时间规则", () => {
    expect(
      CronCreateInputSchema.safeParse({
        cron: "*/20 * * * *",
        delayMinutes: null,
        prompt: "提醒我喝水",
      }).success,
    ).toBe(false);

    expect(CronCreateInputJsonSchema.required).toContain("title");
    // 向后兼容：delayMinutes 是新增的相对时间能力，绝不能变成必填让旧调用方
    // （只传 cron/prompt/title 的模型或客户端）被 schema 拒绝。
    expect(CronCreateInputJsonSchema.required).not.toContain("delayMinutes");
    expect(CronCreateInputJsonSchema).toHaveProperty(
      "properties.title.description",
      expect.stringContaining("preserves the user's natural-language schedule phrase"),
    );
  });

  it("CronCreate schema 说明本地五段 cron 与有限次数语义", () => {
    expect(CronCreateInputJsonSchema).toHaveProperty(
      "properties.cron.description",
      expect.stringContaining("minute hour day-of-month month day-of-week"),
    );
    expect(CronCreateInputJsonSchema).toHaveProperty(
      "properties.cron.description",
      expect.stringContaining("*/20 * * * *"),
    );
    expect(CronCreateInputJsonSchema).toHaveProperty(
      "properties.delayMinutes.description",
      expect.stringContaining("host calculates the future local schedule"),
    );
    expect(CronCreateInputJsonSchema).toHaveProperty(
      "properties.recurring.description",
      expect.stringContaining("true (default)"),
    );
    expect(CronCreateInputJsonSchema).toHaveProperty(
      "properties.maxRuns.description",
      expect.stringContaining("recurring=false"),
    );
    expect(CronCreateInputJsonSchema).toHaveProperty(
      "properties.prompt.description",
      expect.stringContaining("do not ask it to create or schedule another automation"),
    );
  });

  it("CronCreate 相对时间使用结构化 delayMinutes", () => {
    expect(
      CronCreateInputSchema.parse({
        delayMinutes: 3,
        prompt: "提醒我接水",
        title: "3分钟后接水提醒",
        recurring: false,
      }),
    ).toMatchObject({ delayMinutes: 3, recurring: false });
    // 向后兼容：旧调用方省略 delayMinutes（以及 provider 丢弃 null 字段）时，
    // 普通 cron 创建必须原样可用，且不得被误判成相对任务。
    expect(
      CronCreateInputSchema.parse({
        cron: "0 9 * * *",
        prompt: "每天九点提醒我喝水",
        title: "每天9点喝水提醒",
      }),
    ).toMatchObject({ cron: "0 9 * * *" });
    expect(
      CronCreateInputSchema.parse({
        cron: "*/20 * * * *",
        delayMinutes: null,
        prompt: "提醒我喝水",
        title: "每20分钟喝水提醒",
      }),
    ).toMatchObject({ cron: "*/20 * * * *", delayMinutes: null });
    // 省略 delayMinutes 时 cron 仍必填，缺 cron 必须拒绝而不是当成相对任务。
    expect(
      CronCreateInputSchema.safeParse({
        prompt: "提醒我接水",
        title: "接水提醒",
      }).success,
    ).toBe(false);
    expect(
      CronCreateInputSchema.safeParse({
        delayMinutes: null,
        prompt: "提醒我接水",
        title: "接水提醒",
      }).success,
    ).toBe(false);
    // 相对延迟由 host 用真实时钟换算，模型不得再同时提交 cron。
    expect(
      CronCreateInputSchema.safeParse({
        cron: "*/5 * * * *",
        delayMinutes: 3,
        prompt: "提醒我接水",
        title: "3分钟后接水提醒",
        recurring: false,
      }).success,
    ).toBe(false);
  });

  it("CronUpdate 接受严格的非空 patch，并维护 recurring/maxRuns 组合不变量", () => {
    expect(
      CronUpdateInputSchema.parse({
        id: "automation-1",
        title: "新的标题",
        recurring: true,
        maxRuns: null,
      }),
    ).toEqual({
      id: "automation-1",
      title: "新的标题",
      recurring: true,
      maxRuns: null,
    });
    expect(
      CronUpdateInputSchema.parse({
        id: "automation-1",
        title: "无限循环的新标题",
        recurring: true,
      }),
    ).toEqual({
      id: "automation-1",
      title: "无限循环的新标题",
      recurring: true,
    });

    expect(CronUpdateInputSchema.safeParse({ id: "automation-1" }).success).toBe(false);
    expect(
      CronUpdateInputSchema.safeParse({
        id: "automation-1",
        cron: "*/6 * * * *",
      }).success,
    ).toBe(false);
    expect(
      CronUpdateInputSchema.safeParse({
        id: "automation-1",
        title: "新的标题",
        maxRuns: null,
      }).success,
    ).toBe(false);
    expect(
      CronUpdateInputSchema.safeParse({
        id: "automation-1",
        title: "新的标题",
        recurring: false,
        maxRuns: null,
      }).success,
    ).toBe(false);
    expect(
      CronUpdateInputSchema.safeParse({
        id: "automation-1",
        title: "新的标题",
        recurring: true,
        maxRuns: 3,
      }).success,
    ).toBe(false);
    expect(
      CronUpdateInputSchema.safeParse({
        id: "automation-1",
        title: "新的标题",
        prompt: "新的提示词",
        enabled: false,
      }).success,
    ).toBe(false);
  });

  it("CronUpdate provider schema 强制同步 title，且不使用 provider-internal 组合关键字", () => {
    expect(CronUpdateInputJsonSchema.required).toContain("id");
    expect(CronUpdateInputJsonSchema.required).toContain("title");
    expect(CronUpdateInputJsonSchema).toHaveProperty(
      "properties.title.description",
      expect.stringContaining("every 5 minutes to every 6 minutes"),
    );
    // 与 core 跨 provider 守卫同一规范：provider-visible schema 禁止 anyOf 等
    // provider-internal key。recurring/maxRuns 组合不变量由 runtime refine 强制，
    // 模型侧靠字段 description 提示。
    expect(CronUpdateInputJsonSchema).not.toHaveProperty("anyOf");
    expect(CronUpdateInputJsonSchema).toHaveProperty(
      "properties.maxRuns.description",
      expect.stringContaining("recurring=true"),
    );
    expect(CronUpdateInputJsonSchema).toHaveProperty(
      "properties.recurring.description",
      expect.stringContaining("Do not combine true with a numeric maxRuns"),
    );
    // 非法组合必须由 runtime schema 拒绝，这是 anyOf 删除后的唯一强制层。
    expect(
      CronUpdateInputSchema.safeParse({
        id: "automation-1",
        title: "新的标题",
        recurring: true,
        maxRuns: 3,
      }).success,
    ).toBe(false);
    expect(
      CronCreateInputSchema.safeParse({
        id: "automation-1",
        title: "新的标题",
        maxRuns: null,
      }).success,
    ).toBe(false);
  });

  it("CronCreate 长间隔周期用 intervalUnit + interval 统一 carrier", () => {
    // cron 字段步长超限的场景（含 hourly N>24、daily N>31 等）统一用 intervalUnit+interval。
    expect(
      CronCreateInputSchema.parse({
        cron: "0 * * * *",
        intervalUnit: "hourly",
        interval: 50,
        prompt: "每50小时发送你好",
        title: "每50小时发送你好",
      }),
    ).toMatchObject({ intervalUnit: "hourly", interval: 50 });
    expect(
      CronCreateInputSchema.parse({
        cron: "0 9 * * *",
        intervalUnit: "daily",
        interval: 40,
        prompt: "每40天发送1+1",
        title: "每40天发送1+1",
      }),
    ).toMatchObject({ intervalUnit: "daily", interval: 40 });

    // interval 必须统一限制为 UI 自定义重复的 1-200 整数范围。
    expect(
      CronCreateInputSchema.parse({
        cron: "* * * * *",
        intervalUnit: "minute",
        interval: 200,
        prompt: "x",
        title: "每200分钟提醒",
      }),
    ).toMatchObject({ intervalUnit: "minute", interval: 200 });
    for (const interval of [0, 201, 1.5]) {
      expect(
        CronCreateInputSchema.safeParse({
          cron: "0 9 * * *",
          intervalUnit: "daily",
          interval,
          prompt: "x",
          title: "t",
        }).success,
      ).toBe(false);
    }

    // intervalUnit 与 interval 必须配对：只传一个要拒绝。
    expect(
      CronCreateInputSchema.safeParse({
        cron: "0 9 * * *",
        intervalUnit: "daily",
        prompt: "x",
        title: "t",
      }).success,
    ).toBe(false);
    expect(
      CronCreateInputSchema.safeParse({
        cron: "0 9 * * *",
        interval: 40,
        prompt: "x",
        title: "t",
      }).success,
    ).toBe(false);

    // 与 delayMinutes（一次性）互斥。
    expect(
      CronCreateInputSchema.safeParse({
        cron: "0 9 * * *",
        intervalUnit: "daily",
        interval: 40,
        delayMinutes: 5,
        prompt: "x",
        title: "t",
        recurring: false,
      }).success,
    ).toBe(false);

    // interval carrier 的领域语义是无限循环，不能伪装成一次性或有限次数任务。
    for (const invalidMode of [{ recurring: false }, { maxRuns: 2 }]) {
      expect(
        CronCreateInputSchema.safeParse({
          cron: "0 9 * * *",
          intervalUnit: "daily",
          interval: 40,
          prompt: "x",
          title: "每40天提醒",
          ...invalidMode,
        }).success,
      ).toBe(false);
    }

    // intervalUnit 必须是已知枚举。
    expect(
      CronCreateInputSchema.safeParse({
        cron: "0 9 * * *",
        intervalUnit: "decade",
        interval: 10,
        prompt: "x",
        title: "t",
      }).success,
    ).toBe(false);
  });

  it("CronUpdate 支持把任务改为长间隔周期", () => {
    expect(
      CronUpdateInputSchema.parse({
        id: "automation-1",
        title: "每40天发送1+1",
        cron: "0 9 * * *",
        intervalUnit: "daily",
        interval: 40,
      }),
    ).toEqual({
      id: "automation-1",
      title: "每40天发送1+1",
      cron: "0 9 * * *",
      intervalUnit: "daily",
      interval: 40,
    });
    // 边界与 UI 一致：200 合法，0 / 201 / 小数必须拒绝。
    expect(
      CronUpdateInputSchema.parse({
        id: "automation-1",
        title: "每200个月发送1+1",
        cron: "0 9 15 * *",
        intervalUnit: "monthly",
        interval: 200,
      }),
    ).toMatchObject({ intervalUnit: "monthly", interval: 200 });
    for (const interval of [0, 201, 1.5]) {
      expect(
        CronUpdateInputSchema.safeParse({
          id: "automation-1",
          title: "t",
          intervalUnit: "monthly",
          interval,
        }).success,
      ).toBe(false);
    }
    // interval carrier 会切换为无限循环，不能和一次性 / 有限次数语义组合。
    for (const invalidMode of [{ recurring: false }, { maxRuns: 2 }]) {
      expect(
        CronUpdateInputSchema.safeParse({
          id: "automation-1",
          title: "每40天发送1+1",
          intervalUnit: "daily",
          interval: 40,
          ...invalidMode,
        }).success,
      ).toBe(false);
    }

    // 仅传 intervalUnit 不传 interval 被拒。
    expect(
      CronUpdateInputSchema.safeParse({
        id: "automation-1",
        title: "t",
        intervalUnit: "monthly",
      }).success,
    ).toBe(false);
  });
});
