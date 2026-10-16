import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AutomationCreateLimitError,
  AutomationRepo,
  CLAIM_STALE_MS,
  DISPATCH_MAX_ATTEMPTS,
  DISPATCH_RETRY_BASE_MS,
} from "../src/session/automationRepo.js";
import {
  AutomationService,
  InvalidAutomationIntervalCarrierError,
  InvalidAutomationMaxRunsUpdateError,
  InvalidAutomationScheduleRuleError,
} from "../src/session/automationService.js";
import {
  computeAutomationNextRunAt,
  StaleOneShotAutomationScheduleError,
} from "../src/session/automationCron.js";
import {
  AUTOMATION_CREATE_LIMIT,
  type ZCodeAutomationCreateParams,
  type ZCodeAutomationLifecycleStatus,
} from "@zcode/shared";

// 固定基准时间，保证退避 / 重排断言可复现。
const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function makeParams(
  overrides: Partial<ZCodeAutomationCreateParams> = {},
): ZCodeAutomationCreateParams {
  return {
    title: "每日巡检",
    cronExpr: "0 9 * * *",
    prompt: "检查昨天的错误日志并汇总",
    workspacePath: "/tmp/ws",
    recurring: true,
    ...overrides,
  };
}

// 修复原因：此前测试用 setDataBaseDir(tempDir) 把全局 _dataBaseDir 重定向到临时目录，
// 但 vitest threads 池并发跑测试文件时，全局值会被其它文件的 setDataBaseDir 互相覆盖，
// 导致 repo 与裸 SQL 操作在并发窗口内写进真实库 ~/.zcode/v2（/tmp/ws 系列脏数据即因此产生）。
// 改为依赖注入：每个 describe 持有独立 tempDir，repo 通过构造参数接收 dbPath，
// 裸 SQL 用同一 dbPath，彻底脱离全局单例。
function buildTempDbPath(tempDir: string): string {
  return join(tempDir, "tasks-index.sqlite");
}

describe("AutomationRepo 调度状态机", () => {
  let tempDir: string | null = null;
  let dbPath: string;
  let repo: AutomationRepo;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-automation-repo-"));
    dbPath = buildTempDbPath(tempDir);
    repo = new AutomationRepo(dbPath);
  });

  afterEach(() => {
    repo.close();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("create + list + get：新建后可查询，初始为 active/enabled", async () => {
    const created = await repo.create(makeParams({ targetTaskId: "task-1" }), {
      nextRunAt: NOW + MINUTE,
    });
    expect(created.enabled).toBe(true);
    expect(created.lifecycleStatus).toBe("active");
    expect(created.recurring).toBe(true);
    expect(created.nextRunAt).toBe(NOW + MINUTE);
    expect(created.runCount).toBe(0);
    expect(created.targetTaskId).toBe("task-1");

    const list = await repo.list();
    expect(list).toHaveLength(1);
    const got = await repo.get(created.automationId);
    expect(got?.automationId).toBe(created.automationId);
    expect(got?.cronExpr).toBe("0 9 * * *");
    expect(got?.targetTaskId).toBe("task-1");
  });

  it.each([undefined, "yolo", "guarded"] as const)(
    "重开数据库保留 automation mode=%s，无默认值迁移",
    async (mode) => {
      const created = await repo.create(makeParams({ mode }), { nextRunAt: NOW + MINUTE });
      repo.close();
      repo = new AutomationRepo(dbPath);
      expect((await repo.get(created.automationId))?.mode).toBe(mode);
      expect((await repo.list())[0]?.mode).toBe(mode);
    },
  );

  it("首次派发区分跟随默认、未迁移旧选择和损坏新值，不从旧列恢复执行选择", async () => {
    const created = await repo.create(makeParams(), { nextRunAt: NOW + MINUTE });
    await expect(
      repo.getModelSelectionForDispatch(created.automationId, created.workspaceKey),
    ).resolves.toBeUndefined();
    const db = new DatabaseSync(dbPath);
    try {
      for (const raw of [null, "{}", "invalid-json"]) {
        db.prepare(
          "UPDATE automations SET model_selection = ?, model = ?, provider = ? WHERE automation_id = ?",
        ).run(raw, "unrecognized-old-model", "glm", created.automationId);
        await expect(
          repo.getModelSelectionForDispatch(created.automationId, created.workspaceKey),
        ).rejects.toThrow("Automation 模型选择不可用");
      }
      // 新版明确跟随是合法产品意图；保留的旧列仅供回滚，不得重新带回旧选择。
      db.prepare("UPDATE automations SET model_selection = 'null' WHERE automation_id = ?").run(
        created.automationId,
      );
      await expect(
        repo.getModelSelectionForDispatch(created.automationId, created.workspaceKey),
      ).resolves.toBeUndefined();
      const selection = {
        providerId: "custom",
        modelId: "model",
        options: { reasoningLevel: "high" },
      };
      db.prepare("UPDATE automations SET model_selection = ? WHERE automation_id = ?").run(
        JSON.stringify(selection),
        created.automationId,
      );
      await expect(
        repo.getModelSelectionForDispatch(created.automationId, created.workspaceKey),
      ).resolves.toEqual(selection);
      await expect(
        repo.getModelSelectionForDispatch(created.automationId, "another-workspace"),
      ).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  it("旧账号与自定义选择仅凭存储即可导入，不需要账号或候选配置", async () => {
    const first = await repo.create(makeParams(), { nextRunAt: NOW + MINUTE });
    const second = await repo.create(makeParams(), { nextRunAt: NOW + MINUTE });
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "UPDATE automations SET model_selection = NULL, model = ? WHERE automation_id = ?",
    ).run("builtin:bigmodel-coding-plan/GLM-5", first.automationId);
    db.prepare(
      "UPDATE automations SET model_selection = NULL, model = ? WHERE automation_id = ?",
    ).run("custom-provider/model", second.automationId);
    db.exec("DELETE FROM tasks_schema_migration WHERE id='0002_provider_selection'");
    db.close();
    repo.close();
    repo = new AutomationRepo(dbPath);
    const list = await repo.list();
    expect(
      list.find((item) => item.automationId === first.automationId)?.modelSelection?.providerId,
    ).toBe("account:bigmodel-individual-coding-plan");
    expect(
      list.find((item) => item.automationId === second.automationId)?.modelSelection?.providerId,
    ).toBe("custom-provider");
    expect((await repo.get(first.automationId))?.modelSelection?.providerId).toBe(
      "account:bigmodel-individual-coding-plan",
    );
  });

  it("delete：返回真实删除结果并限定 workspace", async () => {
    const created = await repo.create(makeParams(), { nextRunAt: NOW + MINUTE });

    await expect(repo.delete(created.automationId, created.workspaceKey)).resolves.toBe(true);
    await expect(repo.get(created.automationId)).resolves.toBeNull();
    await expect(repo.delete(created.automationId, created.workspaceKey)).resolves.toBe(false);
  });

  it.each([
    "builtin:zai-coding-plan/GLM-5.3-Flash",
    "custom:builtin%3Azai-coding-plan:GLM-5.3-Flash",
  ])("旧定时任务解码 %s，并在新列固定迁移结果但保留回滚字段", async (legacyModel) => {
    const created = await repo.create(makeParams(), { nextRunAt: NOW });
    repo.close();
    const db = new DatabaseSync(dbPath);
    db.prepare(
      "UPDATE automations SET model = ?, provider = 'glm', thought_level = 'high', model_selection = NULL WHERE automation_id = ?",
    ).run(legacyModel, created.automationId);
    db.exec("DELETE FROM tasks_schema_migration WHERE id='0002_provider_selection'");
    db.close();
    repo = new AutomationRepo(dbPath);
    const expected = {
      providerId: "account:zai-individual-coding-plan",
      modelId: "GLM-5.3-Flash",
      options: { reasoningLevel: "high" },
    };
    expect((await repo.get(created.automationId))?.modelSelection).toEqual(expected);
    await repo.update(created.automationId, { title: "Edited title" });
    repo.close();
    const persistedDb = new DatabaseSync(dbPath);
    const row = persistedDb
      .prepare(
        "SELECT model, provider, thought_level, model_selection FROM automations WHERE automation_id = ?",
      )
      .get(created.automationId);
    persistedDb.close();
    expect(row).toMatchObject({ model: legacyModel, provider: "glm", thought_level: "high" });
    expect(JSON.parse(String(row?.model_selection))).toEqual(expected);
    repo = new AutomationRepo(dbPath);
    expect((await repo.get(created.automationId))?.modelSelection).toEqual(expected);
  });

  it.each(["null", "{}", "{broken"])(
    "新选择 %s 不回读旧模型，清空后重启也不复活",
    async (modelSelection) => {
      const created = await repo.create(makeParams(), { nextRunAt: NOW });
      repo.close();
      const db = new DatabaseSync(dbPath);
      db.prepare(
        "UPDATE automations SET model = 'personal:p/m', provider = 'glm', thought_level = 'low', model_selection = ? WHERE automation_id = ?",
      ).run(modelSelection, created.automationId);
      db.close();
      repo = new AutomationRepo(dbPath);
      expect((await repo.get(created.automationId))?.modelSelection).toBeUndefined();
      await repo.update(created.automationId, { modelSelection: null });
      repo.close();
      repo = new AutomationRepo(dbPath);
      expect((await repo.get(created.automationId))?.modelSelection).toBeUndefined();
    },
  );

  it("delete：其他 workspace 的同 ID 不会被删除", async () => {
    const created = await repo.create(makeParams(), { nextRunAt: NOW + MINUTE });

    await expect(repo.delete(created.automationId, "other-workspace")).resolves.toBe(false);
    await expect(repo.get(created.automationId)).resolves.toBeDefined();
  });

  it("Bot 创建来源只在内部读取接口持久化，不泄露到 automation 展示模型", async () => {
    const botDeliveryTarget = {
      provider: "feishu" as const,
      botId: "bot-feishu",
      providerUserId: "chat-1",
      chatType: "group" as const,
    };
    const created = await repo.create(makeParams({ botDeliveryTarget }), {
      nextRunAt: NOW + MINUTE,
    });

    await expect(
      repo.getBotDeliveryTarget(created.automationId, created.workspaceKey),
    ).resolves.toEqual(botDeliveryTarget);
    expect(await repo.get(created.automationId)).not.toHaveProperty("botDeliveryTarget");
    repo.close();
    repo = new AutomationRepo(dbPath);
    await expect(
      repo.getBotDeliveryTarget(created.automationId, created.workspaceKey),
    ).resolves.toEqual(botDeliveryTarget);
    await expect(
      repo.getBotDeliveryTarget(created.automationId, "other-workspace"),
    ).resolves.toBeUndefined();
  });

  it("Bot 回推目标脏数据按未配置处理，不能拖垮定时任务列表", async () => {
    const created = await repo.create(makeParams(), { nextRunAt: NOW + MINUTE });
    repo.close();
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE automations SET bot_delivery_target = ? WHERE automation_id = ?").run(
      '{"provider":"telegram"}',
      created.automationId,
    );
    db.close();
    repo = new AutomationRepo(dbPath);

    await expect(repo.getBotDeliveryTarget(created.automationId)).resolves.toBeUndefined();
    await expect(repo.list()).resolves.toHaveLength(1);
  });

  it("读取历史空白或未知 mode 时按未设置归一化，避免单条脏数据拖垮整批协议校验", async () => {
    const blankMode = await repo.create(makeParams({ title: "blank mode" }), {
      nextRunAt: NOW + MINUTE,
    });
    const unknownMode = await repo.create(makeParams({ title: "unknown mode" }), {
      nextRunAt: NOW + MINUTE,
    });
    repo.close();

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE automations SET mode = ? WHERE automation_id = ?").run(
      "",
      blankMode.automationId,
    );
    db.prepare("UPDATE automations SET mode = ? WHERE automation_id = ?").run(
      "legacy-superuser",
      unknownMode.automationId,
    );
    db.close();

    repo = new AutomationRepo(dbPath);
    const automations = await repo.list({ workspacePath: "/tmp/ws" });
    expect(automations).toHaveLength(2);
    expect(automations.map((automation) => automation.mode)).toEqual([undefined, undefined]);
  });

  it("升级旧库时用历史 run_count 初始化定时派发计数", async () => {
    const created = await repo.create(makeParams({ recurring: false, maxRuns: 3 }), {
      nextRunAt: NOW,
    });
    await repo.markDispatched(created.automationId, {
      dispatchedAt: NOW,
      nextRunAt: NOW + MINUTE,
    });
    await repo.markDispatched(created.automationId, {
      dispatchedAt: NOW + MINUTE,
      nextRunAt: NOW + 2 * MINUTE,
    });
    repo.close();

    const db = new DatabaseSync(dbPath);
    db.exec("ALTER TABLE automations DROP COLUMN scheduled_run_count");
    db.exec("DELETE FROM tasks_schema_migration");
    db.close();

    repo = new AutomationRepo(dbPath);
    expect(await repo.getScheduledRunCount(created.automationId)).toBe(2);

    await repo.markDispatched(created.automationId, {
      dispatchedAt: NOW + 2 * MINUTE,
      nextRunAt: NOW + 3 * MINUTE,
    });
    await expect(repo.get(created.automationId)).resolves.toMatchObject({
      runCount: 3,
      lifecycleStatus: "completed",
      enabled: false,
    });
  });

  it("create/update 写入边界拒绝非法 mode，避免继续制造不可序列化数据", async () => {
    await expect(
      repo.create(makeParams({ mode: "legacy-superuser" as never }), {
        nextRunAt: NOW + MINUTE,
      }),
    ).rejects.toThrow(/mode/i);

    const created = await repo.create(makeParams({ mode: "build" }), {
      nextRunAt: NOW + MINUTE,
    });
    await expect(
      repo.update(created.automationId, { mode: "legacy-superuser" as never }),
    ).rejects.toThrow(/mode/i);
    await expect(repo.get(created.automationId)).resolves.toMatchObject({ mode: "build" });
  });

  it("hasTaskBinding 只在当前 workspaceKey 内按 targetTaskId 查询", async () => {
    await repo.create(
      makeParams({
        workspacePath: "/tmp/ws-a",
        workspaceIdentity: "remote:ssh:dev:/tmp/ws-a",
        targetTaskId: "session-1",
      }),
      { nextRunAt: NOW + MINUTE },
    );
    await repo.create(makeParams({ workspacePath: "/tmp/ws-b", targetTaskId: "session-other" }), {
      nextRunAt: NOW + MINUTE,
    });

    await expect(
      repo.hasTaskBinding({
        workspacePath: "/tmp/ws-a",
        workspaceIdentity: "remote:ssh:dev:/tmp/ws-a",
        targetTaskId: "session-1",
      }),
    ).resolves.toBe(true);
    await expect(
      repo.hasTaskBinding({
        workspacePath: "/tmp/ws-a",
        workspaceIdentity: "remote:ssh:other:/tmp/ws-a",
        targetTaskId: "session-1",
      }),
    ).resolves.toBe(false);
    await expect(
      repo.hasTaskBinding({ workspacePath: "/tmp/ws-b", targetTaskId: "session-1" }),
    ).resolves.toBe(false);
  });

  it("create：所有生命周期状态合计达到 20 条后拒绝创建，删除后释放名额", async () => {
    const statuses: ZCodeAutomationLifecycleStatus[] = ["active", "paused", "completed", "failed"];
    for (let index = 0; index < AUTOMATION_CREATE_LIMIT; index += 1) {
      await repo.create(makeParams({ title: `task-${index}` }), {
        nextRunAt: NOW + MINUTE,
        lifecycleStatus: statuses[index % statuses.length],
      });
    }

    const retained = await repo.list();
    expect(retained).toHaveLength(AUTOMATION_CREATE_LIMIT);
    expect(new Set(retained.map((automation) => automation.lifecycleStatus))).toEqual(
      new Set(statuses),
    );

    await expect(
      repo.create(makeParams({ title: "task-over-limit" }), {
        nextRunAt: NOW + MINUTE,
      }),
    ).rejects.toBeInstanceOf(AutomationCreateLimitError);

    await repo.delete(retained[0]!.automationId);
    await expect(
      repo.create(makeParams({ title: "task-after-delete" }), {
        nextRunAt: NOW + MINUTE,
      }),
    ).resolves.toMatchObject({ title: "task-after-delete" });
  });

  it("update：null 显式清空结构化模型选择与有限次数上限", async () => {
    const created = await repo.create(
      makeParams({
        modelSelection: {
          providerId: "zai",
          modelId: "glm-4.5",
          options: { reasoningLevel: "high" },
        },
        mode: "build",
        recurring: false,
        maxRuns: 3,
      }),
      { nextRunAt: NOW + MINUTE },
    );

    const updated = await repo.update(created.automationId, {
      modelSelection: null,
      mode: null,
      recurring: true,
      maxRuns: null,
    });

    expect(updated?.modelSelection).toBeUndefined();
    expect(updated?.mode).toBeUndefined();
    expect(updated?.recurring).toBe(true);
    expect(updated?.maxRuns).toBeUndefined();
  });

  it("service update：原地保留 automation 身份、绑定会话和运行历史", async () => {
    const service = new AutomationService(repo);
    const created = await repo.create(
      makeParams({
        targetTaskId: "task-history",
        modelSelection: { providerId: "zai", modelId: "glm-5" },
      }),
      { nextRunAt: NOW - 1 },
    );
    const [claimed] = await repo.claimDue(NOW);
    const runId = `${created.automationId}:${NOW}`;
    await repo.upsertRunClaimed({
      runId,
      automationId: created.automationId,
      workspaceKey: "/tmp/ws",
      scheduledAt: NOW,
      trigger: "schedule",
    });
    await repo.markRunDispatch({
      runId,
      dispatchStatus: "dispatched",
      sessionId: "run-session-1",
    });
    await repo.markDispatched(claimed!.automationId, {
      dispatchedAt: NOW,
      nextRunAt: NOW + MINUTE,
    });

    const updated = await service.update(created.automationId, {
      title: "更新后的巡检",
      prompt: "检查最近一小时的错误日志",
      scheduleEditedByUser: true,
    });

    expect(updated).toMatchObject({
      automationId: created.automationId,
      targetTaskId: "task-history",
      modelSelection: { providerId: "zai", modelId: "glm-5" },
      scheduleEditedByUser: true,
      runCount: 1,
      title: "更新后的巡检",
      prompt: "检查最近一小时的错误日志",
    });
    await expect(repo.listRuns(created.automationId)).resolves.toMatchObject([
      {
        automationId: created.automationId,
        sessionId: "run-session-1",
      },
    ]);
  });

  it("service update：拒绝单独清空有限次数上限且不改变活动任务", async () => {
    const service = new AutomationService(repo);
    const created = await repo.create(makeParams({ recurring: false, maxRuns: 5 }), {
      nextRunAt: NOW + MINUTE,
    });
    await repo.markDispatched(created.automationId, {
      dispatchedAt: NOW,
      nextRunAt: NOW + MINUTE,
    });
    await repo.markDispatched(created.automationId, {
      dispatchedAt: NOW + MINUTE,
      nextRunAt: NOW + 2 * MINUTE,
    });

    await expect(service.update(created.automationId, { maxRuns: null })).rejects.toBeInstanceOf(
      InvalidAutomationMaxRunsUpdateError,
    );
    await expect(repo.get(created.automationId)).resolves.toMatchObject({
      recurring: false,
      maxRuns: 5,
      runCount: 2,
      lifecycleStatus: "active",
      enabled: true,
    });

    await expect(
      service.update(created.automationId, {
        recurring: true,
        maxRuns: null,
      }),
    ).resolves.toMatchObject({
      recurring: true,
      maxRuns: undefined,
      runCount: 2,
      lifecycleStatus: "active",
      enabled: true,
    });
  });

  it("service update：切换无限循环时自动清除旧 maxRuns，并拒绝矛盾组合", async () => {
    const service = new AutomationService(repo);
    const created = await repo.create(makeParams({ recurring: false, maxRuns: 3 }), {
      nextRunAt: NOW + MINUTE,
    });

    await expect(
      service.update(created.automationId, { recurring: true, maxRuns: 3 }),
    ).rejects.toBeInstanceOf(InvalidAutomationMaxRunsUpdateError);
    await expect(repo.get(created.automationId)).resolves.toMatchObject({
      recurring: false,
      maxRuns: 3,
      lifecycleStatus: "active",
      enabled: true,
    });

    await expect(service.update(created.automationId, { recurring: true })).resolves.toMatchObject({
      recurring: true,
      maxRuns: undefined,
      lifecycleStatus: "active",
      enabled: true,
    });

    await expect(service.update(created.automationId, { maxRuns: 5 })).rejects.toBeInstanceOf(
      InvalidAutomationMaxRunsUpdateError,
    );
    await expect(repo.get(created.automationId)).resolves.toMatchObject({
      recurring: true,
      maxRuns: undefined,
      lifecycleStatus: "active",
      enabled: true,
    });

    const legacyDirty = await repo.create(
      makeParams({ title: "历史脏任务", recurring: true, maxRuns: 4 }),
      { nextRunAt: NOW + MINUTE },
    );
    await expect(
      service.update(legacyDirty.automationId, { title: "已归一化任务" }),
    ).resolves.toMatchObject({
      title: "已归一化任务",
      recurring: true,
      maxRuns: undefined,
    });
  });

  it("service update：只切换无限循环时保留长月度 scheduleRule", async () => {
    const service = new AutomationService(repo);
    const scheduleRule = {
      unit: "monthly" as const,
      interval: 29,
      hour: 9,
      minute: 0,
      anchorAt: NOW,
      monthDays: [1],
    };
    const created = await repo.create(
      makeParams({
        cronExpr: "0 9 1 * *",
        recurring: false,
        maxRuns: 3,
        scheduleRule,
      }),
      { nextRunAt: NOW + 29 * 31 * 24 * 60 * MINUTE },
    );

    const updated = await service.update(created.automationId, {
      title: "每 29 个月巡检",
      recurring: true,
    });

    expect(updated).toMatchObject({
      recurring: true,
      maxRuns: undefined,
      scheduleRule,
      nextRunAt: created.nextRunAt,
    });
  });

  it("service create/update：非法 scheduleRule 在写库前被领域层拒绝", async () => {
    const service = new AutomationService(repo);
    const invalidMonthlyRule = {
      unit: "monthly" as const,
      interval: 1_201,
      hour: 9,
      minute: 0,
      anchorAt: NOW,
      monthDays: [1],
      monthlyMode: "date" as const,
    };

    await expect(
      service.create(makeParams({ scheduleRule: invalidMonthlyRule })),
    ).rejects.toBeInstanceOf(InvalidAutomationScheduleRuleError);
    await expect(
      service.create(makeParams({ scheduleRule: { ...invalidMonthlyRule, interval: 0 } })),
    ).rejects.toBeInstanceOf(InvalidAutomationScheduleRuleError);
    await expect(repo.list()).resolves.toHaveLength(0);

    const created = await service.create(makeParams());
    await expect(
      service.update(created.automationId, {
        scheduleRule: {
          ...invalidMonthlyRule,
          interval: 1,
          monthDays: [],
        },
      }),
    ).rejects.toBeInstanceOf(InvalidAutomationScheduleRuleError);
    await expect(
      service.update(created.automationId, {
        scheduleRule: {
          ...invalidMonthlyRule,
          interval: 1,
          monthlyMode: "weekday",
          weekdays: [],
        },
      }),
    ).rejects.toBeInstanceOf(InvalidAutomationScheduleRuleError);
    await expect(repo.get(created.automationId)).resolves.toMatchObject({
      automationId: created.automationId,
      scheduleRule: undefined,
    });
  });

  it("service create：陈旧的一次性固定日历目标在写库前被拒绝", async () => {
    const service = new AutomationService(repo);
    const dateNow = vi
      .spyOn(Date, "now")
      .mockReturnValue(new Date(2026, 6, 28, 14, 38, 53).getTime());

    try {
      await expect(
        service.create(
          makeParams({
            cronExpr: "34 14 28 7 *",
            recurring: false,
          }),
        ),
      ).rejects.toBeInstanceOf(StaleOneShotAutomationScheduleError);
      await expect(repo.list()).resolves.toHaveLength(0);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("service create：相对分钟任务忽略模型 cron，并以真实当前时间计算 nextRunAt", async () => {
    const service = new AutomationService(repo);
    const now = new Date(2026, 6, 28, 14, 44, 28).getTime();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      const created = await service.create(
        makeParams({
          // 模拟模型误以为当前是 16:39；该值不能再成为相对时间任务的调度真值。
          cronExpr: "42 16 28 7 *",
          relativeDelayMinutes: 3,
          recurring: false,
        }),
      );

      expect(created).toMatchObject({
        cronExpr: "47 14 28 7 *",
        nextRunAt: now + 3 * MINUTE,
        recurring: false,
        scheduleRule: {
          unit: "minute",
          interval: 3,
          anchorAt: now,
        },
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("create + list + get：保留权限模式和稀疏结构化模型选择", async () => {
    const created = await repo.create(
      makeParams({
        mode: "build",
        modelSelection: {
          providerId: "zai",
          modelId: "glm-5",
          options: { reasoningLevel: "high" },
        },
      }),
      { nextRunAt: NOW + MINUTE },
    );

    expect(created.mode).toBe("build");
    expect(created.modelSelection).toEqual({
      providerId: "zai",
      modelId: "glm-5",
      options: { reasoningLevel: "high" },
    });

    const got = await repo.get(created.automationId);
    expect(got?.mode).toBe("build");
    expect(got?.modelSelection).toEqual(created.modelSelection);

    const list = await repo.list();
    expect(list[0]?.mode).toBe("build");
    expect(list[0]?.modelSelection).toEqual(created.modelSelection);
  });

  it("create + get：保留自定义重复规则", async () => {
    const scheduleRule = {
      unit: "weekly" as const,
      interval: 3,
      hour: 10,
      minute: 30,
      anchorAt: NOW,
      weekdays: [1, 3],
    };
    const created = await repo.create(makeParams({ scheduleRule }), {
      nextRunAt: NOW + MINUTE,
    });

    expect(created.scheduleRule).toEqual(scheduleRule);
    expect((await repo.get(created.automationId))?.scheduleRule).toEqual(scheduleRule);
  });

  it("service create：每 31 小时可用合法兼容 cron 保存并按真实规则排程", async () => {
    const createdAt = new Date(2026, 7, 4, 18, 38).getTime();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(createdAt);

    try {
      const created = await new AutomationService(repo).create(
        makeParams({
          cronExpr: "49 * * * *",
          scheduleRule: {
            unit: "hourly",
            interval: 31,
            hour: 0,
            minute: 49,
            anchorAt: 0,
          },
        }),
      );

      expect(created).toMatchObject({
        cronExpr: "49 * * * *",
        scheduleRule: {
          unit: "hourly",
          interval: 31,
          minute: 49,
          anchorAt: createdAt,
        },
        nextRunAt: new Date(2026, 7, 4, 18, 49).getTime(),
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("service create/update：长分钟和天间隔使用合法兼容 cron，并持久化真实 scheduleRule", async () => {
    const createdAt = new Date(2026, 7, 4, 18, 38).getTime();
    const updatedAt = createdAt + MINUTE;
    const dateNow = vi.spyOn(Date, "now");
    const service = new AutomationService(repo);

    try {
      for (const [minuteInterval, dayInterval] of [
        [61, 32],
        [200, 200],
      ]) {
        dateNow.mockReturnValue(createdAt);
        const created = await service.create(
          makeParams({
            title: `每 ${minuteInterval} 分钟`,
            cronExpr: "* * * * *",
            scheduleRule: {
              unit: "minute",
              interval: minuteInterval,
              hour: 18,
              minute: 38,
              anchorAt: 0,
            },
          }),
        );

        expect(created).toMatchObject({
          cronExpr: "* * * * *",
          scheduleRule: {
            unit: "minute",
            interval: minuteInterval,
            anchorAt: createdAt,
          },
          nextRunAt: createdAt + minuteInterval * MINUTE,
        });
        await expect(repo.get(created.automationId)).resolves.toMatchObject({
          cronExpr: "* * * * *",
          scheduleRule: {
            unit: "minute",
            interval: minuteInterval,
            anchorAt: createdAt,
          },
        });

        dateNow.mockReturnValue(updatedAt);
        const updated = await service.update(created.automationId, {
          cronExpr: "49 17 * * *",
          scheduleRule: {
            unit: "daily",
            interval: dayInterval,
            hour: 17,
            minute: 49,
            anchorAt: 0,
          },
        });
        const expectedNextRun = new Date(updatedAt);
        expectedNextRun.setDate(expectedNextRun.getDate() + dayInterval);
        expectedNextRun.setHours(17, 49, 0, 0);

        expect(updated).toMatchObject({
          cronExpr: "49 17 * * *",
          scheduleRule: {
            unit: "daily",
            interval: dayInterval,
            hour: 17,
            minute: 49,
            anchorAt: updatedAt,
          },
          nextRunAt: expectedNextRun.getTime(),
        });
        await expect(repo.get(created.automationId)).resolves.toMatchObject({
          cronExpr: "49 17 * * *",
          scheduleRule: {
            unit: "daily",
            interval: dayInterval,
            hour: 17,
            minute: 49,
            anchorAt: updatedAt,
          },
          nextRunAt: expectedNextRun.getTime(),
        });
      }
    } finally {
      dateNow.mockRestore();
    }
  });

  it("service create/update：会话 interval carrier 以 scheduleRule 承载 1–200 的真实间隔", async () => {
    const createdAt = new Date(2026, 7, 4, 18, 38).getTime();
    const updatedAt = createdAt + MINUTE;
    const dateNow = vi.spyOn(Date, "now");
    const service = new AutomationService(repo);

    try {
      dateNow.mockReturnValue(createdAt);
      const created = await service.create(
        makeParams({
          title: "每200分钟提醒",
          // cron 仅作合法兼容表达式，真实频率必须由 carrier 归一化后的 scheduleRule 承载。
          cronExpr: "* * * * *",
          intervalUnit: "minute",
          interval: 200,
        }),
      );
      expect(created).toMatchObject({
        cronExpr: "* * * * *",
        scheduleRule: {
          unit: "minute",
          interval: 200,
          anchorAt: createdAt,
        },
        nextRunAt: createdAt + 200 * MINUTE,
      });

      dateNow.mockReturnValue(updatedAt);
      const updated = await service.update(created.automationId, {
        cronExpr: "49 * * * *",
        intervalUnit: "hourly",
        interval: 200,
      });
      expect(updated).toMatchObject({
        cronExpr: "49 * * * *",
        scheduleRule: {
          unit: "hourly",
          interval: 200,
          minute: 49,
          anchorAt: updatedAt,
        },
      });
      await expect(repo.get(created.automationId)).resolves.toMatchObject({
        scheduleRule: { unit: "hourly", interval: 200, minute: 49, anchorAt: updatedAt },
      });

      // 领域层也要守住 carrier=无限循环；旧客户端或内部调用不能写入矛盾状态。
      await expect(
        service.create(
          makeParams({
            cronExpr: "0 9 * * *",
            intervalUnit: "daily",
            interval: 40,
            recurring: false,
          }),
        ),
      ).rejects.toBeInstanceOf(InvalidAutomationIntervalCarrierError);
      await expect(
        service.update(created.automationId, {
          intervalUnit: "hourly",
          interval: 200,
          recurring: false,
        }),
      ).rejects.toBeInstanceOf(InvalidAutomationIntervalCarrierError);

      // 领域层不能只信任协议校验：旧客户端或内部调用绕过 protocol 时也必须拒绝越界 carrier。
      await expect(
        service.create(
          makeParams({
            cronExpr: "* * * * *",
            intervalUnit: "minute",
            interval: 201,
          }),
        ),
      ).rejects.toBeInstanceOf(InvalidAutomationIntervalCarrierError);
      await expect(
        service.update(created.automationId, { intervalUnit: "hourly", interval: 201 }),
      ).rejects.toBeInstanceOf(InvalidAutomationIntervalCarrierError);
      await expect(repo.get(created.automationId)).resolves.toMatchObject({
        scheduleRule: { unit: "hourly", interval: 200, minute: 49, anchorAt: updatedAt },
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("service update：interval carrier 将一次性任务切换为无限循环，派发后仍保持 active", async () => {
    const createdAt = new Date(2026, 7, 4, 16, 38).getTime();
    const updatedAt = createdAt + MINUTE;
    const dateNow = vi.spyOn(Date, "now");
    const service = new AutomationService(repo);

    try {
      dateNow.mockReturnValue(createdAt);
      const created = await service.create(
        makeParams({
          title: "一次性日报",
          cronExpr: "49 17 * * *",
          recurring: false,
        }),
      );

      dateNow.mockReturnValue(updatedAt);
      const updated = await service.update(created.automationId, {
        intervalUnit: "daily",
        interval: 40,
      });
      // 第一次保留当天尚未到达的 17:49；后续轮次才按 40 天 interval 推进。
      const firstNextRunAt = new Date(2026, 7, 4, 17, 49).getTime();
      const secondNextRunAt = new Date(2026, 8, 13, 17, 49).getTime();

      expect(updated).toMatchObject({
        recurring: true,
        maxRuns: undefined,
        lifecycleStatus: "active",
        scheduleRule: {
          unit: "daily",
          interval: 40,
          hour: 17,
          minute: 49,
          anchorAt: updatedAt,
        },
        nextRunAt: firstNextRunAt,
      });
      expect(computeAutomationNextRunAt(updated!, firstNextRunAt)).toBe(secondNextRunAt);

      await repo.claimDue(firstNextRunAt);
      await repo.markDispatched(created.automationId, {
        dispatchedAt: firstNextRunAt,
        nextRunAt: secondNextRunAt,
      });

      await expect(repo.get(created.automationId)).resolves.toMatchObject({
        recurring: true,
        maxRuns: undefined,
        lifecycleStatus: "active",
        enabled: true,
        runCount: 1,
        nextRunAt: secondNextRunAt,
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("service update：显式 scheduleRule=null 必须清除已有自定义重复规则", async () => {
    const createdAt = new Date(2026, 7, 4, 18, 38).getTime();
    const updatedAt = createdAt + MINUTE;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(createdAt);
    const service = new AutomationService(repo);

    try {
      const created = await service.create(
        makeParams({
          cronExpr: "49 * * * *",
          scheduleRule: {
            unit: "hourly",
            interval: 31,
            hour: 0,
            minute: 49,
            anchorAt: createdAt,
          },
        }),
      );

      dateNow.mockReturnValue(updatedAt);
      const updated = await service.update(created.automationId, { scheduleRule: null });

      expect(updated).toMatchObject({ cronExpr: "49 * * * *", scheduleRule: undefined });
      await expect(repo.get(created.automationId)).resolves.toMatchObject({
        cronExpr: "49 * * * *",
        scheduleRule: undefined,
      });
    } finally {
      dateNow.mockRestore();
    }
  });

  it("claimDue：到期任务被认领且置 running；同一轮不会被二次认领", async () => {
    const a = await repo.create(makeParams(), { nextRunAt: NOW - 1 });
    const first = await repo.claimDue(NOW);
    expect(first.map((x) => x.automationId)).toEqual([a.automationId]);
    expect(first[0]!.dispatchStatus).toBe("claimed");

    // 已 running，第二次认领应为空（single-flight）。
    const second = await repo.claimDue(NOW);
    expect(second).toHaveLength(0);
  });

  it("claimDue：未到期不认领", async () => {
    await repo.create(makeParams(), { nextRunAt: NOW + 10 * MINUTE });
    const due = await repo.claimDue(NOW);
    expect(due).toHaveLength(0);
  });

  it("claimDue：截止日期已过时转 completed 且不再认领", async () => {
    const automation = await repo.create(makeParams({ endAt: NOW - MINUTE }), {
      nextRunAt: NOW - 1,
    });

    expect(await repo.claimDue(NOW)).toHaveLength(0);
    expect(await repo.get(automation.automationId)).toMatchObject({
      endAt: NOW - MINUTE,
      enabled: false,
      lifecycleStatus: "completed",
    });
  });

  it("markDispatched（循环）：run_count+1、推进 next_run_at、复位 running、保持 active", async () => {
    const a = await repo.create(makeParams(), { nextRunAt: NOW - 1 });
    await repo.claimDue(NOW);
    await repo.markDispatched(a.automationId, {
      dispatchedAt: NOW,
      nextRunAt: NOW + 24 * 60 * MINUTE,
    });
    const got = await repo.get(a.automationId);
    expect(got?.runCount).toBe(1);
    expect(got?.dispatchStatus).toBe("dispatched");
    expect(got?.lifecycleStatus).toBe("active");
    expect(got?.enabled).toBe(true);
    expect(got?.nextRunAt).toBe(NOW + 24 * 60 * MINUTE);
    expect(got?.lastRunAt).toBe(NOW);
  });

  it("markDispatched：下一次运行越过截止日期时转 completed", async () => {
    const automation = await repo.create(makeParams({ endAt: NOW + MINUTE }), {
      nextRunAt: NOW - 1,
    });
    await repo.claimDue(NOW);
    await repo.markDispatched(automation.automationId, {
      dispatchedAt: NOW,
      nextRunAt: NOW + 2 * MINUTE,
    });

    expect(await repo.get(automation.automationId)).toMatchObject({
      enabled: false,
      lifecycleStatus: "completed",
      runCount: 1,
    });
  });

  it("markDispatched（有限次）：达 max_runs 转 completed 并停用", async () => {
    const a = await repo.create(makeParams({ recurring: false, maxRuns: 1 }), {
      nextRunAt: NOW - 1,
    });
    await repo.claimDue(NOW);
    await repo.markDispatched(a.automationId, {
      dispatchedAt: NOW,
      nextRunAt: null,
    });
    const got = await repo.get(a.automationId);
    expect(got?.runCount).toBe(1);
    expect(got?.lifecycleStatus).toBe("completed");
    expect(got?.enabled).toBe(false);
    expect(got?.nextRunAt).toBeUndefined();
    // completed 不再被认领。
    expect(await repo.claimDue(NOW + 100 * MINUTE)).toHaveLength(0);
  });

  it("markDispatchFailed（transient）：累加 attempts + 写退避 retry_at，且退避后可被重认领", async () => {
    const a = await repo.create(makeParams(), { nextRunAt: NOW - 1 });
    await repo.claimDue(NOW);
    await repo.markDispatchFailed(a.automationId, {
      failedAt: NOW,
      error: "host 不存在",
      kind: "transient",
      nextRunAt: NOW + 24 * 60 * MINUTE,
    });
    const got = await repo.get(a.automationId);
    expect(got?.dispatchStatus).toBe("failed_to_dispatch");
    expect(got?.dispatchAttempts).toBe(1);
    expect(got?.retryAt).toBe(NOW + DISPATCH_RETRY_BASE_MS);
    expect(got?.enabled).toBe(true);

    // 退避时间未到不认领；到点后按 retry_at 认领。
    expect(await repo.claimDue(NOW + DISPATCH_RETRY_BASE_MS - 1)).toHaveLength(0);
    const retried = await repo.claimDue(NOW + DISPATCH_RETRY_BASE_MS);
    expect(retried.map((x) => x.automationId)).toEqual([a.automationId]);
  });

  it("markDispatchFailed（permanent）：直接转 failed 终态并停用", async () => {
    const a = await repo.create(makeParams(), { nextRunAt: NOW - 1 });
    await repo.claimDue(NOW);
    await repo.markDispatchFailed(a.automationId, {
      failedAt: NOW,
      error: "workspace 不存在",
      kind: "permanent",
    });
    const got = await repo.get(a.automationId);
    expect(got?.lifecycleStatus).toBe("failed");
    expect(got?.enabled).toBe(false);
    expect(got?.lastError).toBe("workspace 不存在");
  });

  it("markDispatchFailed（transient 达上限，循环任务）：放弃本轮、跳下一个 next_run_at、清重试态", async () => {
    const a = await repo.create(makeParams(), { nextRunAt: NOW - 1 });
    const nextNormal = NOW + 24 * 60 * MINUTE;
    // 连续失败至 MAX_ATTEMPTS。
    for (let i = 0; i < DISPATCH_MAX_ATTEMPTS; i++) {
      await repo.markDispatchFailed(a.automationId, {
        failedAt: NOW + i,
        error: "反复超时",
        kind: "transient",
        nextRunAt: nextNormal,
      });
    }
    const got = await repo.get(a.automationId);
    expect(got?.dispatchStatus).toBe("idle");
    expect(got?.dispatchAttempts).toBe(0);
    expect(got?.retryAt).toBeUndefined();
    expect(got?.nextRunAt).toBe(nextNormal);
    expect(got?.lifecycleStatus).toBe("active");
    expect(got?.enabled).toBe(true);
  });

  it("skipAndReschedule：写一条 skipped run + 前推 next_run_at + 复位认领", async () => {
    const a = await repo.create(makeParams(), {
      nextRunAt: NOW - 100 * MINUTE,
    });
    await repo.claimDue(NOW);
    const runId = `${a.automationId}:${NOW - 100 * MINUTE}`;
    await repo.skipAndReschedule({
      automationId: a.automationId,
      runId,
      workspaceKey: "/tmp/ws",
      scheduledAt: NOW - 100 * MINUTE,
      reason: "computer_asleep_or_app_not_running",
      nextRunAt: NOW + 24 * 60 * MINUTE,
    });
    const got = await repo.get(a.automationId);
    expect(got?.nextRunAt).toBe(NOW + 24 * 60 * MINUTE);
    expect(got?.dispatchStatus).toBe("idle");

    const runs = await repo.listRuns(a.automationId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.dispatchStatus).toBe("skipped");
    expect(runs[0]!.runId).toBe(runId);
  });

  it("skipAndReschedule（finalize）：一次性任务错过窗口即 completed 终态，不再被认领", async () => {
    // 相对时间任务（delayMinutes）落库为 minute scheduleRule；通用重算总能给出
    // anchorAt + k*interval 的未来周期，一次性提醒错过后绝不能借此复活。
    const a = await repo.create(
      makeParams({
        recurring: false,
        cronExpr: "47 14 28 7 *",
        scheduleRule: {
          unit: "minute",
          interval: 5,
          hour: 14,
          minute: 47,
          anchorAt: NOW - 100 * MINUTE,
        },
      }),
      { nextRunAt: NOW - 95 * MINUTE },
    );
    await repo.claimDue(NOW);
    const runId = `${a.automationId}:${NOW - 95 * MINUTE}`;
    await repo.skipAndReschedule({
      automationId: a.automationId,
      runId,
      workspaceKey: "/tmp/ws",
      scheduledAt: NOW - 95 * MINUTE,
      reason: "computer_asleep_or_app_not_running",
      nextRunAt: null,
      finalize: true,
    });

    const got = await repo.get(a.automationId);
    expect(got?.lifecycleStatus).toBe("completed");
    expect(got?.enabled).toBe(false);
    expect(got?.nextRunAt).toBeUndefined();

    // skipped run 台账保留，后续任意 tick 都不得再认领该任务。
    const runs = await repo.listRuns(a.automationId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.dispatchStatus).toBe("skipped");
    expect(await repo.claimDue(NOW + 24 * 60 * MINUTE)).toHaveLength(0);
  });

  it("upsertRunClaimed：同一 runId 幂等（不新建行，累加 attempts）", async () => {
    const a = await repo.create(makeParams(), { nextRunAt: NOW - 1 });
    const runId = `${a.automationId}:${NOW}`;
    const runParams = {
      runId,
      automationId: a.automationId,
      workspaceKey: "/tmp/ws",
      scheduledAt: NOW,
      trigger: "schedule" as const,
    };
    await repo.upsertRunClaimed(runParams);
    await repo.upsertRunClaimed(runParams);
    const runs = await repo.listRuns(a.automationId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.attempts).toBe(1);
  });

  it("markRunDispatch + markRunOutcome：回填 session_id 与运行结果", async () => {
    const a = await repo.create(makeParams(), { nextRunAt: NOW - 1 });
    const runId = `${a.automationId}:${NOW}`;
    await repo.upsertRunClaimed({
      runId,
      automationId: a.automationId,
      workspaceKey: "/tmp/ws",
      scheduledAt: NOW,
      trigger: "schedule",
    });
    await repo.markRunDispatch({
      runId,
      dispatchStatus: "dispatched",
      sessionId: "sess-1",
    });
    await repo.markRunOutcome(runId, "succeeded");
    const runs = await repo.listRuns(a.automationId);
    expect(runs[0]!.dispatchStatus).toBe("dispatched");
    expect(runs[0]!.sessionId).toBe("sess-1");
    expect(runs[0]!.outcome).toBe("succeeded");
  });

  it("同一 run 首次形成的 Submission Selection 在失败重试后保持不变", async () => {
    const a = await repo.create(makeParams(), { nextRunAt: NOW - 1 });
    const runId = `${a.automationId}:${NOW}`;
    const fixedSelection = {
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "high" },
    } as const;
    await repo.upsertRunClaimed({
      runId,
      automationId: a.automationId,
      workspaceKey: "/tmp/ws",
      scheduledAt: NOW,
      trigger: "schedule",
    });
    await expect(repo.fixRunModelSelection(runId, fixedSelection)).resolves.toEqual(fixedSelection);

    await repo.upsertRunClaimed({
      runId,
      automationId: a.automationId,
      workspaceKey: "/tmp/ws",
      scheduledAt: NOW,
      trigger: "schedule",
    });

    await expect(
      repo.fixRunModelSelection(runId, {
        providerId: "provider-b",
        modelId: "model-b",
      }),
    ).resolves.toEqual(fixedSelection);

    await expect(repo.getRun(runId)).resolves.toMatchObject({
      modelSelection: fixedSelection,
      attempts: 1,
    });
  });

  it("手动认领只保存执行台账，账号选择由目标 Host 首次解析后固定且不改长期配置", async () => {
    const original = {
      providerId: "old-account",
      modelId: "model",
      options: { reasoningLevel: "high" },
    };
    const automation = await repo.create(makeParams({ modelSelection: original }), {
      nextRunAt: NOW + MINUTE,
    });
    const claimed = await repo.runNow(automation.automationId, { now: NOW });
    expect(claimed?.run.modelSelection).toBeUndefined();
    expect((await repo.getRun(claimed!.run.runId))?.modelSelection).toBeUndefined();
    const effective = { ...original, providerId: "current-account" };
    expect(await repo.fixRunModelSelection(claimed!.run.runId, effective)).toEqual(effective);
    expect((await repo.get(automation.automationId))?.modelSelection).toEqual(original);
  });

  it("setEnabled：暂停后不参与调度", async () => {
    const a = await repo.create(makeParams(), { nextRunAt: NOW - 1 });
    await repo.setEnabled(a.automationId, false);
    const got = await repo.get(a.automationId);
    expect(got?.enabled).toBe(false);
    expect(got?.lifecycleStatus).toBe("paused");
    expect(await repo.claimDue(NOW)).toHaveLength(0);
  });

  it("restart：终态任务重跑 → 回 active、清计数、按新 next_run_at 重排", async () => {
    const a = await repo.create(makeParams({ recurring: false, maxRuns: 1 }), {
      nextRunAt: NOW - 1,
    });
    await repo.claimDue(NOW);
    await repo.markDispatched(a.automationId, {
      dispatchedAt: NOW,
      nextRunAt: null,
    });
    expect((await repo.get(a.automationId))?.lifecycleStatus).toBe("completed");

    await repo.restart(a.automationId, { nextRunAt: NOW + MINUTE });
    const got = await repo.get(a.automationId);
    expect(got?.lifecycleStatus).toBe("active");
    expect(got?.enabled).toBe(true);
    expect(got?.runCount).toBe(0);
    expect(got?.nextRunAt).toBe(NOW + MINUTE);
  });

  it("service restart：completed 任务不再被复活", async () => {
    const service = new AutomationService(repo);
    const a = await service.create(makeParams({ recurring: false, maxRuns: 1 }));
    await repo.claimDue(NOW);
    await repo.markDispatched(a.automationId, {
      dispatchedAt: NOW,
      nextRunAt: null,
    });
    expect((await repo.get(a.automationId))?.lifecycleStatus).toBe("completed");

    await service.restart(a.automationId);

    const got = await repo.get(a.automationId);
    expect(got?.lifecycleStatus).toBe("completed");
    expect(got?.enabled).toBe(false);
    expect(got?.runCount).toBe(1);
  });

  it("service：刚错过目标分钟的一次性日历任务立即派发一次后 completed", async () => {
    const now = new Date(2026, 6, 16, 17, 31, 30).getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const service = new AutomationService(repo);
      const automation = await service.create(
        makeParams({
          title: "1分钟后发送对话总结",
          cronExpr: "31 17 16 7 *",
          recurring: false,
          maxRuns: 1,
        }),
      );

      expect(automation.nextRunAt).toBe(now);
      expect(await repo.claimDue(now)).toHaveLength(1);
      await repo.markDispatched(automation.automationId, {
        dispatchedAt: now,
        nextRunAt: new Date(2027, 6, 16, 17, 31, 0).getTime(),
      });

      const completed = await repo.get(automation.automationId);
      expect(completed).toMatchObject({
        enabled: false,
        lifecycleStatus: "completed",
        nextRunAt: undefined,
        runCount: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("service：每 N 分钟在创建和修改时写入新锚点", async () => {
    const createdAt = new Date(2026, 6, 20, 11, 46, 15).getTime();
    vi.useFakeTimers();
    vi.setSystemTime(createdAt);
    try {
      const service = new AutomationService(repo);
      const automation = await service.create(
        makeParams({ cronExpr: "*/10 * * * *", title: "每10分钟问候" }),
      );

      expect(automation.scheduleRule).toMatchObject({
        unit: "minute",
        interval: 10,
        anchorAt: createdAt,
      });
      expect(automation.nextRunAt).toBe(createdAt + 10 * MINUTE);

      const updatedAt = createdAt + 2 * MINUTE;
      vi.setSystemTime(updatedAt);
      const updated = await service.update(automation.automationId, {
        cronExpr: "*/5 * * * *",
      });
      expect(updated?.scheduleRule).toMatchObject({
        unit: "minute",
        interval: 5,
        anchorAt: updatedAt,
      });
      expect(updated?.nextRunAt).toBe(updatedAt + 5 * MINUTE);

      const titleOnlyUpdatedAt = updatedAt + MINUTE;
      vi.setSystemTime(titleOnlyUpdatedAt);
      const titleOnly = await service.update(automation.automationId, {
        title: "每5分钟问候",
        scheduleRule: updated!.scheduleRule,
      });
      expect(titleOnly?.scheduleRule?.anchorAt).toBe(updatedAt);

      const ruleUpdatedAt = titleOnlyUpdatedAt + MINUTE;
      vi.setSystemTime(ruleUpdatedAt);
      const ruleUpdated = await service.update(automation.automationId, {
        cronExpr: "*/2 * * * *",
        scheduleRule: { ...titleOnly!.scheduleRule!, interval: 2 },
      });
      expect(ruleUpdated?.scheduleRule?.anchorAt).toBe(ruleUpdatedAt);
      expect(ruleUpdated?.nextRunAt).toBe(ruleUpdatedAt + 2 * MINUTE);
    } finally {
      vi.useRealTimers();
    }
  });

  it("runNow：只创建 manual run，不修改原 cron 计划和生命周期", async () => {
    const a = await repo.create(makeParams({ recurring: false, maxRuns: 1 }), {
      nextRunAt: NOW + 10 * MINUTE,
    });
    await repo.setEnabled(a.automationId, false);

    const claimed = await repo.runNow(a.automationId, { now: NOW });

    const got = await repo.get(a.automationId);
    expect(got?.nextRunAt).toBe(NOW + 10 * MINUTE);
    expect(got?.runCount).toBe(0);
    expect(got?.enabled).toBe(false);
    expect(got?.lifecycleStatus).toBe("paused");
    expect(await repo.claimDue(NOW)).toHaveLength(0);

    const runs = await repo.listRuns(a.automationId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe("manual");
    expect(runs[0]!.runId).toContain(`${a.automationId}:manual:`);
    expect(runs[0]!.scheduledAt).toBe(NOW);
    expect(runs[0]!.attempts).toBe(1);
    expect(claimed?.automation.automationId).toBe(a.automationId);
    expect(claimed?.run.runId).toBe(runs[0]!.runId);
  });

  it("manual run 首次派发成功累计一次，重复回报幂等且不推进有限计划", async () => {
    const a = await repo.create(makeParams({ recurring: false, maxRuns: 1 }), {
      nextRunAt: NOW + 10 * MINUTE,
    });
    await repo.setEnabled(a.automationId, false);
    const claimed = await repo.runNow(a.automationId, { now: NOW });

    await repo.markManualRunDispatched({
      runId: claimed!.run.runId,
      sessionId: "manual-task",
      dispatchedAt: NOW + 1,
    });
    await repo.markManualRunDispatched({
      runId: claimed!.run.runId,
      sessionId: "manual-task",
      dispatchedAt: NOW + 2,
    });

    const got = await repo.get(a.automationId);
    expect(got?.runCount).toBe(1);
    expect(got?.lastRunAt).toBe(NOW + 1);
    expect(got?.nextRunAt).toBe(NOW + 10 * MINUTE);
    expect(got?.enabled).toBe(false);
    expect(got?.lifecycleStatus).toBe("paused");
    // prompt accepted/queued 后 claim 仍由真实 turn 终态释放，不能因计数提前解锁。
    expect(await repo.runNow(a.automationId, { now: NOW + 3 })).toBeNull();

    const runs = await repo.listRuns(a.automationId);
    expect(runs[0]).toMatchObject({
      dispatchStatus: "dispatched",
      sessionId: "manual-task",
    });
  });

  it("manual run 不消耗有限计划的定时派发次数", async () => {
    const a = await repo.create(makeParams({ recurring: false, maxRuns: 3 }), {
      nextRunAt: NOW + 10 * MINUTE,
    });

    for (let index = 0; index < 2; index += 1) {
      const manual = await repo.runNow(a.automationId, { now: NOW + index });
      await repo.markManualRunDispatched({
        runId: manual!.run.runId,
        sessionId: `manual-task-${index}`,
        dispatchedAt: NOW + index,
      });
      await repo.releaseManualClaim(a.automationId, a.workspaceKey);
    }

    for (let scheduledCount = 1; scheduledCount <= 3; scheduledCount += 1) {
      const scheduledAt = NOW + (9 + scheduledCount) * MINUTE;
      expect(await repo.claimDue(scheduledAt)).toHaveLength(1);
      await repo.markDispatched(a.automationId, {
        dispatchedAt: scheduledAt,
        nextRunAt: scheduledAt + MINUTE,
      });

      const got = await repo.get(a.automationId);
      expect(got?.runCount).toBe(2 + scheduledCount);
      expect(got?.lifecycleStatus).toBe(scheduledCount === 3 ? "completed" : "active");
      expect(got?.enabled).toBe(scheduledCount !== 3);
    }
  });

  it("编辑有限次数时只按定时派发次数重算生命周期", async () => {
    const service = new AutomationService(repo);
    const a = await repo.create(makeParams({ recurring: false, maxRuns: 3 }), {
      nextRunAt: NOW + 10 * MINUTE,
    });

    for (let index = 0; index < 2; index += 1) {
      const manual = await repo.runNow(a.automationId, { now: NOW + index });
      await repo.markManualRunDispatched({
        runId: manual!.run.runId,
        dispatchedAt: NOW + index,
      });
      await repo.releaseManualClaim(a.automationId, a.workspaceKey);
    }

    await service.update(a.automationId, { maxRuns: 2 });

    await expect(repo.get(a.automationId)).resolves.toMatchObject({
      runCount: 2,
      maxRuns: 2,
      lifecycleStatus: "active",
      enabled: true,
    });
  });

  it("manual run 派发失败不累计运行次数", async () => {
    const a = await repo.create(makeParams(), {
      nextRunAt: NOW + 10 * MINUTE,
    });
    const claimed = await repo.runNow(a.automationId, { now: NOW });

    await repo.markRunDispatch({
      runId: claimed!.run.runId,
      dispatchStatus: "failed_to_dispatch",
      error: "dispatch failed",
    });

    const got = await repo.get(a.automationId);
    expect(got?.runCount).toBe(0);
    expect(got?.lastRunAt).toBeUndefined();
  });

  it("runNow：连续立即运行只认领一次，释放后才能再次创建 manual run", async () => {
    const a = await repo.create(makeParams(), {
      nextRunAt: NOW + 10 * MINUTE,
    });

    const first = await repo.runNow(a.automationId, { now: NOW });
    const second = await repo.runNow(a.automationId, { now: NOW + 1 });

    expect(first?.automation.automationId).toBe(a.automationId);
    expect(second).toBeNull();
    expect(await repo.listRuns(a.automationId)).toHaveLength(1);
    expect(await repo.claimDue(NOW)).toHaveLength(0);
    expect(await repo.claimManualRuns(NOW + 1)).toHaveLength(0);

    // sendPrompt accepted/queued 只回写 dispatched；在 turn 终态前仍必须持有 claim。
    await repo.markManualRunDispatched({
      runId: first!.run.runId,
      sessionId: "busy-task",
      dispatchedAt: NOW + 2,
    });
    expect(await repo.runNow(a.automationId, { now: NOW + 3 })).toBeNull();

    await repo.releaseManualClaim(a.automationId, a.workspaceKey);
    const third = await repo.runNow(a.automationId, { now: NOW + 4 });

    expect(third?.automation.automationId).toBe(a.automationId);
    expect(await repo.listRuns(a.automationId)).toHaveLength(2);
  });

  it("touchManualClaim：长时间 queued manual run 续租后不会被 stale 回收", async () => {
    const a = await repo.create(makeParams(), {
      nextRunAt: NOW + 20 * MINUTE,
    });
    expect(await repo.runNow(a.automationId, { now: NOW })).not.toBeNull();

    vi.useFakeTimers();
    vi.setSystemTime(NOW + CLAIM_STALE_MS - MINUTE);
    try {
      await repo.touchManualClaim(a.automationId, a.workspaceKey);
    } finally {
      vi.useRealTimers();
    }

    expect(await repo.runNow(a.automationId, { now: NOW + CLAIM_STALE_MS + 1 })).toBeNull();
    expect(await repo.listRuns(a.automationId)).toHaveLength(1);
  });

  it("claimManualRuns：正常路径不认领 host 直派任务，仅在超时后崩溃恢复", async () => {
    const a = await repo.create(makeParams(), {
      nextRunAt: NOW + 10 * MINUTE,
    });
    await repo.runNow(a.automationId, { now: NOW });

    expect(await repo.claimManualRuns(NOW + 1)).toHaveLength(0);

    const claimed = await repo.claimManualRuns(NOW + CLAIM_STALE_MS + 1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.automation.automationId).toBe(a.automationId);
    expect(claimed[0]!.run.trigger).toBe("manual");
    expect(claimed[0]!.run.attempts).toBe(2);
    expect(await repo.claimManualRuns(NOW + CLAIM_STALE_MS + 2)).toHaveLength(0);

    await repo.markManualRunDispatched({
      runId: claimed[0]!.run.runId,
      sessionId: "task-1",
      dispatchedAt: NOW + CLAIM_STALE_MS + 2,
    });
    await repo.releaseManualClaim(a.automationId, a.workspaceKey);

    const got = await repo.get(a.automationId);
    expect(got?.runCount).toBe(1);
    expect(got?.lastRunAt).toBe(NOW + CLAIM_STALE_MS + 2);
    expect(got?.nextRunAt).toBe(NOW + 10 * MINUTE);
    expect(got?.lifecycleStatus).toBe("active");

    const runs = await repo.listRuns(a.automationId);
    expect(runs[0]!.dispatchStatus).toBe("dispatched");
    expect(runs[0]!.sessionId).toBe("task-1");
  });

  it("claimDue：僵尸认领（持有者崩溃）超过 CLAIM_STALE 后被回收重认领", async () => {
    const a = await repo.create(makeParams(), { nextRunAt: NOW - 1 });
    await repo.claimDue(NOW); // 认领后 running=1、claimed_at=NOW
    // 未超时前不回收（仍 running）。
    expect(await repo.claimDue(NOW + CLAIM_STALE_MS - 1)).toHaveLength(0);
    // 超过 CLAIM_STALE 后回收并重新认领。
    const reclaimed = await repo.claimDue(NOW + CLAIM_STALE_MS + 1);
    expect(reclaimed.map((x) => x.automationId)).toEqual([a.automationId]);
  });

  it("delete + deleteRun：删除 automation 与单条运行记录", async () => {
    const a = await repo.create(makeParams(), { nextRunAt: NOW - 1 });
    const runId = `${a.automationId}:${NOW}`;
    await repo.upsertRunClaimed({
      runId,
      automationId: a.automationId,
      workspaceKey: "/tmp/ws",
      scheduledAt: NOW,
      trigger: "schedule",
    });
    await repo.deleteRun(runId);
    expect(await repo.listRuns(a.automationId)).toHaveLength(0);
    await repo.delete(a.automationId);
    expect(await repo.get(a.automationId)).toBeNull();
  });
});

describe("automation workspace 隔离", () => {
  let tempDir: string | null = null;
  let dbPath: string;
  let repo: AutomationRepo;

  const KEY_A = "/tmp/ws-a";
  const KEY_B = "/tmp/ws-b";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-automation-iso-"));
    dbPath = buildTempDbPath(tempDir);
    repo = new AutomationRepo(dbPath);
  });

  afterEach(() => {
    repo.close();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("repo：跨 workspace 的 get/update/delete/setEnabled/restart/runNow 均不生效且不改原记录", async () => {
    const a = await repo.create(makeParams({ workspacePath: KEY_A }), {
      nextRunAt: NOW + MINUTE,
    });

    // 错误 workspace 读不到；正确 workspace 读得到。
    expect(await repo.get(a.automationId, KEY_B)).toBeNull();
    expect((await repo.get(a.automationId, KEY_A))?.automationId).toBe(a.automationId);

    // update：错误 workspace 返回 null，字段不变。
    expect(await repo.update(a.automationId, { title: "hacked" }, undefined, KEY_B)).toBeNull();
    expect((await repo.get(a.automationId, KEY_A))?.title).toBe(a.title);

    // setEnabled：错误 workspace 不改 enabled。
    await repo.setEnabled(a.automationId, false, KEY_B);
    expect((await repo.get(a.automationId, KEY_A))?.enabled).toBe(true);

    // restart：先在正确 workspace 置 paused，再用错误 workspace restart 应无效（仍 paused）。
    await repo.setEnabled(a.automationId, false, KEY_A);
    await repo.restart(a.automationId, { nextRunAt: NOW + 2 * MINUTE }, KEY_B);
    expect((await repo.get(a.automationId, KEY_A))?.lifecycleStatus).toBe("paused");

    // runNow：错误 workspace 返回 null 且不落 run。
    expect(await repo.runNow(a.automationId, { now: NOW }, KEY_B)).toBeNull();
    expect(await repo.listRuns(a.automationId, KEY_A)).toHaveLength(0);

    // delete：错误 workspace 不删；正确 workspace 可删。
    await repo.delete(a.automationId, KEY_B);
    expect(await repo.get(a.automationId, KEY_A)).not.toBeNull();
    await repo.delete(a.automationId, KEY_A);
    expect(await repo.get(a.automationId, KEY_A)).toBeNull();
  });

  it("repo：run 的 listRuns/deleteRun 也按 workspace 隔离", async () => {
    const a = await repo.create(makeParams({ workspacePath: KEY_A }), {
      nextRunAt: NOW + MINUTE,
    });
    const claimed = await repo.runNow(a.automationId, { now: NOW }, KEY_A);
    expect(claimed).not.toBeNull();
    const runId = claimed!.run.runId;

    expect(await repo.listRuns(a.automationId, KEY_B)).toHaveLength(0);
    await repo.deleteRun(runId, KEY_B);
    expect(await repo.listRuns(a.automationId, KEY_A)).toHaveLength(1);
    await repo.deleteRun(runId, KEY_A);
    expect(await repo.listRuns(a.automationId, KEY_A)).toHaveLength(0);
  });

  it("repo：getRun 可按 runId 找回 manual run 的 workspaceKey", async () => {
    const a = await repo.create(makeParams({ workspacePath: KEY_A }), {
      nextRunAt: NOW + MINUTE,
    });
    const claimed = await repo.runNow(a.automationId, { now: NOW }, KEY_A);

    const run = await repo.getRun(claimed!.run.runId);

    expect(run?.automationId).toBe(a.automationId);
    expect(run?.workspaceKey).toBe(KEY_A);
  });

  it("repo：releaseManualClaim 只释放同 workspace 的立即运行锁", async () => {
    const a = await repo.create(makeParams({ workspacePath: KEY_A }), {
      nextRunAt: NOW + MINUTE,
    });
    expect(await repo.runNow(a.automationId, { now: NOW }, KEY_A)).not.toBeNull();

    await repo.releaseManualClaim(a.automationId, KEY_B);

    expect(await repo.runNow(a.automationId, { now: NOW + 1 }, KEY_A)).toBeNull();
    await repo.releaseManualClaim(a.automationId, KEY_A);
    expect(await repo.runNow(a.automationId, { now: NOW + 2 }, KEY_A)).not.toBeNull();
  });

  it("repo：相同 workspacePath 但不同 workspaceIdentity 互相隔离", async () => {
    // workspaceKey = workspaceIdentity?.trim() || workspacePath。
    const a = await repo.create(
      makeParams({ workspacePath: "/tmp/shared", workspaceIdentity: "remote-A" }),
      { nextRunAt: NOW + MINUTE },
    );
    expect(await repo.get(a.automationId, "remote-B")).toBeNull();
    expect((await repo.get(a.automationId, "remote-A"))?.automationId).toBe(a.automationId);
    await repo.delete(a.automationId, "remote-B");
    expect(await repo.get(a.automationId, "remote-A")).not.toBeNull();
  });

  it("service：scope 为 workspace B 时无法操作 workspace A 的任务", async () => {
    const service = new AutomationService(repo);
    const a = await service.create(makeParams({ workspacePath: KEY_A }));
    const scopeB = { workspacePath: KEY_B };

    expect(await service.get(a.automationId, scopeB)).toBeNull();
    expect(await service.update(a.automationId, { title: "x" }, scopeB)).toBeNull();
    await service.delete(a.automationId, scopeB);
    await service.setEnabled(a.automationId, false, scopeB);
    await service.restart(a.automationId, scopeB);
    expect(await service.runNow(a.automationId, scopeB)).toBeNull();

    // A 仍存在且未被改动。
    const stillA = await service.get(a.automationId, { workspacePath: KEY_A });
    expect(stillA?.title).toBe(a.title);
    expect(stillA?.enabled).toBe(true);
  });
});
