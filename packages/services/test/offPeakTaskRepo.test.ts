import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OffPeakTaskRepo,
  OFF_PEAK_CLAIM_STALE_MS,
  isOffPeakBoundSessionConflict,
} from "../src/session/offPeakTaskRepo.js";
import type { ZCodeOffPeakTaskCreateParams } from "@zcode/shared";

// 固定基准时间，保证认领 / 回收断言可复现。
const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function makeParams(
  overrides: Partial<ZCodeOffPeakTaskCreateParams> = {},
): ZCodeOffPeakTaskCreateParams {
  return {
    title: "夜间重构",
    prompt: "把 utils 目录的重复代码抽公共函数",
    permissionMode: "default",
    modelSelection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" },
    workspacePath: "/tmp/ws",
    ...overrides,
  };
}

// 修复原因：同 automationRepo.test.ts，此前用 setDataBaseDir(tempDir) 重定向全局 _dataBaseDir，
// 但 vitest threads 并发跑测试文件时全局值被互相覆盖，存在写进真实库的并发窗口。
// 改为依赖注入：repo 通过构造参数接收 dbPath，裸 SQL 用同一 dbPath，脱离全局单例。
function buildTempDbPath(tempDir: string): string {
  return join(tempDir, "tasks-index.sqlite");
}

describe("OffPeakTaskRepo 状态机与调度守卫", () => {
  let tempDir: string | null = null;
  let dbPath: string;
  let repo: OffPeakTaskRepo;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-off-peak-repo-"));
    dbPath = buildTempDbPath(tempDir);
    repo = new OffPeakTaskRepo(dbPath);
  });

  afterEach(() => {
    repo.close();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("create + list + get：新建即 queued，字段与 workspaceKey 规则正确", async () => {
    const created = await repo.create(
      makeParams({
        modelSelection: {
          providerId: "account:zai-offpeak-idle-plan",
          modelId: "GLM-5.2",
          options: { reasoningLevel: "high" },
        },
        workspaceIdentity: " remote-1 ",
      }),
      {
        now: NOW,
        serverTicketId: "ticket-1",
        queuePosition: 3,
        registeredAt: NOW,
      },
    );
    expect(created.status).toBe("queued");
    expect(created.title).toBe("夜间重构");
    expect(created.permissionMode).toBe("default");
    expect(created.modelSelection).toEqual({
      providerId: "account:zai-offpeak-idle-plan",
      modelId: "GLM-5.2",
      options: { reasoningLevel: "high" },
    });
    // workspaceKey = workspaceIdentity?.trim() || workspacePath
    expect(created.workspaceKey).toBe("remote-1");
    expect(created.serverTicketId).toBe("ticket-1");
    expect(created.queuePosition).toBe(3);
    expect(created.registeredAt).toBe(NOW);
    expect(created.queuedAt).toBe(NOW);
    expect(created.schedulable).toBe(false);
    expect(created.conversationId).toBeUndefined();
    expect(created.sessionId).toBeUndefined();

    expect(await repo.list()).toHaveLength(1);
    expect((await repo.get(created.offPeakTaskId))?.offPeakTaskId).toBe(created.offPeakTaskId);
    // Selection options 可稀疏编辑：round-trip 后删除 reasoning 叶子不会写回默认值。
    expect((await repo.get(created.offPeakTaskId))?.modelSelection?.options?.reasoningLevel).toBe(
      "high",
    );
    const edited = await repo.updateEditableFields(
      created.offPeakTaskId,
      {
        modelSelection: {
          providerId: "account:zai-offpeak-idle-plan",
          modelId: "GLM-5.2",
          options: { reasoningLevel: "max" },
        },
      },
      { now: NOW + 5 },
    );
    expect(edited?.modelSelection.options?.reasoningLevel).toBe("max");
    const cleared = await repo.updateEditableFields(
      created.offPeakTaskId,
      { modelSelection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" } },
      { now: NOW + 6 },
    );
    expect(cleared?.modelSelection.options?.reasoningLevel).toBeUndefined();
    // 未取号的 mock 先行创建同样允许
    const bare = await repo.create(makeParams(), { now: NOW + 1 });
    expect(bare.serverTicketId).toBeUndefined();
  });

  it.each([true, false])("编辑只更新新版选择，保留旧列回滚快照（存量=%s）", async (hasLegacy) => {
    const created = await repo.create(makeParams(), { now: NOW, serverTicketId: "bound-ticket" });
    const db = new DatabaseSync(dbPath);
    try {
      const legacy = {
        model: hasLegacy ? "GLM-5.2" : null,
        thought_level: hasLegacy ? "high" : null,
      };
      db.prepare(
        "UPDATE off_peak_tasks SET model = ?, thought_level = ? WHERE off_peak_task_id = ?",
      ).run(legacy.model, legacy.thought_level, created.offPeakTaskId);
      const readLegacy = () =>
        db
          .prepare("SELECT model, thought_level FROM off_peak_tasks WHERE off_peak_task_id = ?")
          .get(created.offPeakTaskId);

      const titleOnly = await repo.updateEditableFields(created.offPeakTaskId, { title: "新标题" });
      expect(readLegacy()).toEqual(legacy);
      expect(titleOnly).toMatchObject({
        title: "新标题",
        modelSelection: makeParams().modelSelection,
      });

      const selection = {
        providerId: "account:zai-offpeak-idle-plan",
        modelId: "GLM-5.3",
        options: { reasoningLevel: "max" },
      };
      await repo.updateEditableFields(created.offPeakTaskId, { modelSelection: selection });
      // 冻结 staging@790884b1ce 的 rowToTask 按旧列读取；不能用新版 codec 往返代替原值证据。
      expect(readLegacy()).toEqual(legacy);
      expect(
        await repo.updateEditableFields(created.offPeakTaskId, { modelSelection: null }),
      ).toBeNull();
      repo.close();
      repo = new OffPeakTaskRepo(dbPath);
      expect(await repo.get(created.offPeakTaskId)).toMatchObject({
        title: "新标题",
        modelSelection: selection,
        serverTicketId: "bound-ticket",
        status: "queued",
      });
      expect(readLegacy()).toEqual(legacy);
    } finally {
      db.close();
    }
  });

  it("旧 Selection 损坏时保留任务、隔离调度，且不拖垮其他记录", async () => {
    const legacy = await repo.create(makeParams({ title: "旧任务" }), {
      now: NOW,
      schedulable: true,
    });
    const healthy = await repo.create(
      makeParams({
        title: "正常任务",
        modelSelection: {
          providerId: "account:zai-offpeak-idle-plan",
          modelId: "GLM-5.2",
          options: { reasoningLevel: "max" },
        },
      }),
      { now: NOW + 1, schedulable: true },
    );
    repo.close();
    const db = new DatabaseSync(dbPath);
    db.prepare(
      `UPDATE off_peak_tasks
       SET model = 'GLM-5.2', thought_level = 'high', model_selection = NULL
       WHERE off_peak_task_id = ?`,
    ).run(legacy.offPeakTaskId);
    db.close();

    const listed = await repo.list();
    expect(listed).toHaveLength(2);
    const legacyTask = listed.find((task) => task.offPeakTaskId === legacy.offPeakTaskId);
    expect(legacyTask?.modelSelection).toBeUndefined();
    expect(legacyTask).toMatchObject({
      modelSelectionIssue: {
        code: "repair-required",
      },
    });
    expect((await repo.claimDue(NOW + MINUTE)).map((task) => task.offPeakTaskId)).toEqual([
      healthy.offPeakTaskId,
    ]);
  });

  it("D50 绑定会话：create 写 session_id、conversation_id 仍空；list 联查 tasks 表回填 sessionTitle", async () => {
    const bound = await repo.create(makeParams({ boundSessionId: "sess-bound" }), { now: NOW });
    expect(bound.sessionId).toBe("sess-bound");
    expect(bound.modelSelection).toEqual(makeParams().modelSelection);
    expect(bound.conversationId).toBeUndefined();
    expect(bound.sessionTitle).toBeUndefined();

    // 库级迁移已建空 tasks 表：尚无绑定行时不报错。
    expect((await repo.list())[0]?.sessionTitle).toBeUndefined();

    // 同库出现 tasks-index 的 tasks 表后，list 按 (workspace_key, task_id) 联出当前标题；get 单行不带。
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        `INSERT INTO tasks (workspace_key, task_id, title, workspace_path, created_at, updated_at) VALUES (?, ?, ?, '/tmp/ws', 1, 1)`,
      ).run("/tmp/ws", "sess-bound", "重构 utils 的工作会话");
    } finally {
      db.close();
    }
    const listed = await repo.list();
    expect(listed.find((task) => task.offPeakTaskId === bound.offPeakTaskId)?.sessionTitle).toBe(
      "重构 utils 的工作会话",
    );
    expect((await repo.get(bound.offPeakTaskId))?.sessionTitle).toBeUndefined();

    // 首跑 markRunning：conversation_id 回填为会话 id，session_id 保持绑定值。
    const running = await repo.markRunning(bound.offPeakTaskId, {
      startedAt: NOW + 1,
      conversationId: "sess-bound",
      sessionId: "sess-bound",
    });
    expect(running?.conversationId).toBe("sess-bound");
    expect(running?.sessionId).toBe("sess-bound");
  });

  it("D50-4 存储层兜底：同工作区同会话第二个未终态绑定任务被唯一索引拒绝，终态后可再建", async () => {
    const first = await repo.create(makeParams({ boundSessionId: "sess-a" }), { now: NOW });
    expect(await repo.hasActiveBoundTask("/tmp/ws", "sess-a")).toBe(true);
    expect(await repo.hasActiveBoundTask("/tmp/ws", "sess-b")).toBe(false);
    expect(await repo.hasActiveBoundTask("/other", "sess-a")).toBe(false);

    let conflict: unknown;
    try {
      await repo.create(makeParams({ boundSessionId: "sess-a" }), { now: NOW + 1 });
    } catch (error) {
      conflict = error;
    }
    expect(isOffPeakBoundSessionConflict(conflict)).toBe(true);
    expect(isOffPeakBoundSessionConflict(new Error("other"))).toBe(false);

    // 非绑定任务（session_id NULL）互不冲突。
    await repo.create(makeParams(), { now: NOW + 2 });
    await repo.create(makeParams(), { now: NOW + 3 });

    await repo.markTerminal(first.offPeakTaskId, { status: "cancelled", endedAt: NOW + 4 });
    expect(await repo.hasActiveBoundTask("/tmp/ws", "sess-a")).toBe(false);
    const again = await repo.create(makeParams({ boundSessionId: "sess-a" }), { now: NOW + 5 });
    expect(again.sessionId).toBe("sess-a");
  });

  it("claimDue：只认领 queued 且 schedulable=1；FIFO 按 queued_at；single-flight", async () => {
    const a = await repo.create(makeParams({ title: "A" }), { now: NOW });
    const b = await repo.create(makeParams({ title: "B" }), { now: NOW + 1 });
    const c = await repo.create(makeParams({ title: "C" }), { now: NOW + 2 });

    // schedulable=0 时一个都不认领（粗阀关，§7.6）
    expect(await repo.claimDue(NOW + MINUTE)).toHaveLength(0);

    await repo.updateSchedulingSnapshot(b.offPeakTaskId, { schedulable: true });
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, { schedulable: true });
    await repo.updateSchedulingSnapshot(c.offPeakTaskId, { schedulable: true });
    // paused 不认领
    await repo.setPaused(c.offPeakTaskId, true);

    const claimed = await repo.claimDue(NOW + MINUTE);
    expect(claimed.map((t) => t.title)).toEqual(["A", "B"]); // FIFO by queued_at
    // 已认领在途，二次认领为空（single-flight）
    expect(await repo.claimDue(NOW + MINUTE + 1)).toHaveLength(0);
  });

  it("claimDue：认领超时（持有者崩溃）后被回收并可重新认领", async () => {
    const a = await repo.create(makeParams(), { now: NOW });
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, { schedulable: true });
    await repo.claimDue(NOW);
    expect(await repo.claimDue(NOW + OFF_PEAK_CLAIM_STALE_MS - 1)).toHaveLength(0);
    const reclaimed = await repo.claimDue(NOW + OFF_PEAK_CLAIM_STALE_MS + 1);
    expect(reclaimed.map((t) => t.offPeakTaskId)).toEqual([a.offPeakTaskId]);
  });

  it("markRunning：queued→running 回填 conversation/session/ticket 并释放认领；续跑保留首段 started_at", async () => {
    const a = await repo.create(makeParams(), { now: NOW });
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, { schedulable: true });
    await repo.claimDue(NOW);

    const running = await repo.markRunning(a.offPeakTaskId, {
      startedAt: NOW + MINUTE,
      conversationId: "conv-1",
      sessionId: "sess-1",
      serverTicketId: "ticket-1",
    });
    expect(running?.status).toBe("running");
    expect(running?.startedAt).toBe(NOW + MINUTE);
    expect(running?.conversationId).toBe("conv-1");
    expect(running?.sessionId).toBe("sess-1");
    expect(running?.serverTicketId).toBe("ticket-1");
    // 认领已释放：running 状态本身挡住重复认领
    expect(await repo.claimDue(NOW + 2 * MINUTE)).toHaveLength(0);

    // 3h 到期自动续跑（D26）：running→queued→重新 markRunning，session 复用、started_at 保留首段
    const backToQueue = await repo.recoverInterrupted(NOW + 10 * MINUTE);
    expect(backToQueue).toBe(1);
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, {
      schedulable: true,
      serverTicketId: "ticket-2",
    });
    await repo.claimDue(NOW + 11 * MINUTE);
    const resumed = await repo.markRunning(a.offPeakTaskId, {
      startedAt: NOW + 12 * MINUTE,
    });
    expect(resumed?.startedAt).toBe(NOW + MINUTE); // 保留首段
    expect(resumed?.sessionId).toBe("sess-1"); // session 不丢
    expect(resumed?.serverTicketId).toBe("ticket-2"); // 新段新票
  });

  it("markRunning 守卫：paused/终态不可入 running（迟到派发结果作废）", async () => {
    const a = await repo.create(makeParams(), { now: NOW });
    await repo.setPaused(a.offPeakTaskId, true);
    expect(await repo.markRunning(a.offPeakTaskId, { startedAt: NOW })).toBeNull();

    await repo.setPaused(a.offPeakTaskId, false);
    await repo.markTerminal(a.offPeakTaskId, {
      status: "cancelled",
      endedAt: NOW,
    });
    expect(await repo.markRunning(a.offPeakTaskId, { startedAt: NOW })).toBeNull();
    expect((await repo.get(a.offPeakTaskId))?.status).toBe("cancelled");
  });

  it("markTerminal：终态不可逆出；迟到二次迁移被拒绝", async () => {
    const a = await repo.create(makeParams(), { now: NOW });
    const done = await repo.markTerminal(a.offPeakTaskId, {
      status: "completed",
      endedAt: NOW + MINUTE,
      filesChanged: 5,
    });
    expect(done?.status).toBe("completed");
    expect(done?.endedAt).toBe(NOW + MINUTE);
    expect(done?.filesChanged).toBe(5);
    expect(done?.schedulable).toBe(false);

    // 终态之间不可互迁（OffPeakRunResult 迟到兜底：返回 null 丢弃）
    expect(
      await repo.markTerminal(a.offPeakTaskId, {
        status: "failed",
        endedAt: NOW + 2 * MINUTE,
      }),
    ).toBeNull();
    expect((await repo.get(a.offPeakTaskId))?.status).toBe("completed");
    // 终态不再被认领
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, { schedulable: true });
    expect(await repo.claimDue(NOW + 3 * MINUTE)).toHaveLength(0);
  });

  it("markTerminal：permanent 派发错误原子记录失败原因与尝试次数", async () => {
    const task = await repo.create(makeParams(), { now: NOW });
    await repo.updateSchedulingSnapshot(task.offPeakTaskId, { schedulable: true });
    await repo.claimDue(NOW);

    const failed = await repo.markTerminal(task.offPeakTaskId, {
      status: "failed",
      endedAt: NOW + 1,
      failureReason: "workspace model unavailable",
      dispatchError: "workspace model unavailable",
    });

    expect(failed).toMatchObject({
      status: "failed",
      failureReason: "workspace model unavailable",
      schedulable: false,
    });
    expect(await repo.claimDue(NOW + 2)).toHaveLength(0);
  });

  it("初始化时把历史 awaiting_approval 行迁移为 running", async () => {
    const a = await repo.create(makeParams(), { now: NOW });
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, { schedulable: true });
    await repo.claimDue(NOW);
    await repo.markRunning(a.offPeakTaskId, { startedAt: NOW });
    repo.close();

    const db = new DatabaseSync(dbPath);
    db.prepare(
      `UPDATE off_peak_tasks SET status = 'awaiting_approval' WHERE off_peak_task_id = ?`,
    ).run(a.offPeakTaskId);
    db.close();

    repo = new OffPeakTaskRepo(dbPath);
    expect((await repo.get(a.offPeakTaskId))?.status).toBe("running");
  });

  it("setPaused：queued ⇄ paused；认领在途与非 queued 状态不可 Pause", async () => {
    const a = await repo.create(makeParams(), { now: NOW });
    const paused = await repo.setPaused(a.offPeakTaskId, true);
    expect(paused?.status).toBe("paused");
    // paused 重复 Pause 无效
    expect(await repo.setPaused(a.offPeakTaskId, true)).toBeNull();
    const continued = await repo.setPaused(a.offPeakTaskId, false);
    expect(continued?.status).toBe("queued");

    // 认领在途不可 Pause（派发窗口竞态）
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, { schedulable: true });
    await repo.claimDue(NOW);
    expect(await repo.setPaused(a.offPeakTaskId, true)).toBeNull();

    // running 不可 Pause（running 只有取消）
    await repo.markRunning(a.offPeakTaskId, { startedAt: NOW });
    expect(await repo.setPaused(a.offPeakTaskId, true)).toBeNull();
  });

  it("releaseClaim：派发失败释放锁、累计 attempt_count；任务留在 queued 可再认领（无 skip，D21）", async () => {
    const a = await repo.create(makeParams(), { now: NOW });
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, { schedulable: true });
    await repo.claimDue(NOW);
    await repo.releaseClaim(a.offPeakTaskId, {
      error: "no host available",
      now: NOW + 1,
    });

    const got = await repo.get(a.offPeakTaskId);
    expect(got?.status).toBe("queued");
    // 立即可重新认领（退避策略在 scheduler 层，仓库不做时间闸）
    const reclaimed = await repo.claimDue(NOW + 2);
    expect(reclaimed).toHaveLength(1);
  });

  it("recoverInterrupted：running 置回 queued，保留 session 供 resume；清理超时认领", async () => {
    const running = await repo.create(makeParams({ title: "R" }), { now: NOW });
    await repo.updateSchedulingSnapshot(running.offPeakTaskId, {
      schedulable: true,
    });
    await repo.claimDue(NOW);
    await repo.markRunning(running.offPeakTaskId, {
      startedAt: NOW,
      sessionId: "sess-r",
      conversationId: "conv-r",
    });

    const untouched = await repo.create(makeParams({ title: "Q" }), {
      now: NOW + 2,
    });
    const done = await repo.create(makeParams({ title: "D" }), {
      now: NOW + 3,
    });
    await repo.markTerminal(done.offPeakTaskId, {
      status: "completed",
      endedAt: NOW + 3,
    });

    const recovered = await repo.recoverInterrupted(NOW + 10 * MINUTE);
    expect(recovered).toBe(1);

    const r = await repo.get(running.offPeakTaskId);
    expect(r?.status).toBe("queued");
    expect(r?.queuedAt).toBe(NOW); // 保留原队列位置
    expect(r?.sessionId).toBe("sess-r"); // resume 续跑依赖
    expect((await repo.get(untouched.offPeakTaskId))?.status).toBe("queued");
    expect((await repo.get(done.offPeakTaskId))?.status).toBe("completed");
  });

  it("markSettled + listUnsettledTerminal：终态核销 outbox（D22）", async () => {
    const a = await repo.create(makeParams({ title: "A" }), { now: NOW });
    const b = await repo.create(makeParams({ title: "B" }), { now: NOW + 1 });
    // 非终态不可核销
    await repo.markSettled(a.offPeakTaskId, NOW + 1);
    expect((await repo.get(a.offPeakTaskId))?.settledAt).toBeUndefined();

    await repo.markTerminal(a.offPeakTaskId, {
      status: "completed",
      endedAt: NOW + MINUTE,
    });
    await repo.markTerminal(b.offPeakTaskId, {
      status: "failed",
      endedAt: NOW + 2 * MINUTE,
    });

    expect((await repo.listUnsettledTerminal()).map((t) => t.title)).toEqual(["A", "B"]);

    await repo.markSettled(a.offPeakTaskId, NOW + 3 * MINUTE);
    expect((await repo.get(a.offPeakTaskId))?.settledAt).toBe(NOW + 3 * MINUTE);
    expect((await repo.listUnsettledTerminal()).map((t) => t.title)).toEqual(["B"]);
  });

  it("markHistoryDeleted：只隐藏已启动任务的 History，且重复调用幂等（D37）", async () => {
    const queued = await repo.create(makeParams({ title: "Q" }), { now: NOW });
    const queuedResult = await repo.markHistoryDeleted(queued.offPeakTaskId, {
      now: NOW + 1,
    });
    expect(queuedResult?.historyDeletedAt).toBeUndefined();

    const running = await repo.create(makeParams({ title: "R" }), {
      now: NOW + 2,
    });
    await repo.updateSchedulingSnapshot(running.offPeakTaskId, {
      schedulable: true,
    });
    await repo.claimDue(NOW + 2);
    await repo.markRunning(running.offPeakTaskId, {
      startedAt: NOW + 2,
      conversationId: "conv-r",
      sessionId: "sess-r",
    });
    await repo.markTerminal(running.offPeakTaskId, {
      status: "completed",
      endedAt: NOW + MINUTE,
      filesChanged: 4,
    });

    const deleted = await repo.markHistoryDeleted(running.offPeakTaskId, {
      now: NOW + 2 * MINUTE,
    });
    expect(deleted?.historyDeletedAt).toBe(NOW + 2 * MINUTE);
    expect(deleted).toMatchObject({
      status: "completed",
      conversationId: "conv-r",
      sessionId: "sess-r",
      startedAt: NOW + 2,
      endedAt: NOW + MINUTE,
      filesChanged: 4,
    });

    const repeated = await repo.markHistoryDeleted(running.offPeakTaskId, {
      now: NOW + 3 * MINUTE,
    });
    expect(repeated?.historyDeletedAt).toBe(NOW + 2 * MINUTE);
  });

  it("countNonTerminal：终态与已删除不计入（创建上限本地预判）", async () => {
    const a = await repo.create(makeParams(), { now: NOW });
    const b = await repo.create(makeParams(), { now: NOW + 1 });
    await repo.setPaused(b.offPeakTaskId, true); // paused 计入（D30-2 额度含 Paused）
    const c = await repo.create(makeParams(), { now: NOW + 2 });
    expect(await repo.countNonTerminal()).toBe(3);

    await repo.markTerminal(a.offPeakTaskId, {
      status: "cancelled",
      endedAt: NOW + 3,
    });
    expect(await repo.countNonTerminal()).toBe(2);
    await repo.delete(c.offPeakTaskId);
    expect(await repo.countNonTerminal()).toBe(1);
    expect(await repo.get(c.offPeakTaskId)).toBeNull();
  });

  it("requeueForContinuation：3102 续跑回队保留 session；paused/终态拒绝", async () => {
    const a = await repo.create(makeParams(), {
      now: NOW,
      offPeakTaskId: "offpeak-fixed-id",
    });
    expect(a.offPeakTaskId).toBe("offpeak-fixed-id"); // 外部指定主键（先取号后落库）
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, {
      schedulable: true,
      queuePosition: 1,
    });
    await repo.claimDue(NOW);
    await repo.markRunning(a.offPeakTaskId, {
      startedAt: NOW,
      conversationId: "conv-1",
      sessionId: "sess-1",
      serverTicketId: "ticket-1",
    });

    const requeued = await repo.requeueForContinuation(a.offPeakTaskId, {
      now: NOW + 1,
    });
    expect(requeued?.status).toBe("queued");
    expect(requeued?.sessionId).toBe("sess-1"); // resume 依赖
    expect(requeued?.conversationId).toBe("conv-1");
    expect(requeued?.startedAt).toBe(NOW); // 首段开始时间保留
    expect(requeued?.schedulable).toBe(false); // 等重新取号后由轮询刷新
    expect(requeued?.queuePosition).toBeUndefined();

    // paused 不可回队
    await repo.setPaused(a.offPeakTaskId, true);
    expect(await repo.requeueForContinuation(a.offPeakTaskId)).toBeNull();
    await repo.setPaused(a.offPeakTaskId, false);
    // 终态不可回队
    await repo.markTerminal(a.offPeakTaskId, {
      status: "cancelled",
      endedAt: NOW + 2,
    });
    expect(await repo.requeueForContinuation(a.offPeakTaskId)).toBeNull();
  });

  it("listNonTerminal + create schedulable：取号即 ready 随建随派", async () => {
    const ready = await repo.create(makeParams({ title: "R" }), {
      now: NOW,
      serverTicketId: "t-1",
      schedulable: true,
    });
    const waiting = await repo.create(makeParams({ title: "W" }), {
      now: NOW + 1,
    });
    const done = await repo.create(makeParams({ title: "D" }), {
      now: NOW + 2,
    });
    await repo.markTerminal(done.offPeakTaskId, {
      status: "completed",
      endedAt: NOW + 3,
    });

    expect((await repo.listNonTerminal()).map((t) => t.title)).toEqual(["R", "W"]);
    // 取号即 ready 的任务无需等轮询即可被认领
    const claimed = await repo.claimDue(NOW + 4);
    expect(claimed.map((t) => t.offPeakTaskId)).toEqual([ready.offPeakTaskId]);
    expect(waiting.schedulable).toBe(false);
  });

  it("updateSchedulingSnapshot：只覆盖显式字段；重新取号更新 server_ticket_id", async () => {
    const a = await repo.create(makeParams(), {
      now: NOW,
      serverTicketId: "ticket-1",
      queuePosition: 5,
    });
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, {
      queuePosition: 2,
      nextPollAt: NOW + MINUTE,
    });
    let got = await repo.get(a.offPeakTaskId);
    expect(got?.serverTicketId).toBe("ticket-1"); // 未传字段不动
    expect(got?.queuePosition).toBe(2);
    expect(got?.nextPollAt).toBe(NOW + MINUTE);

    // 票过期重新取号（D26 同 task_id 新 ticket）
    await repo.updateSchedulingSnapshot(a.offPeakTaskId, {
      serverTicketId: "ticket-2",
      registeredAt: NOW + 2 * MINUTE,
      schedulable: false,
      queuePosition: null,
    });
    got = await repo.get(a.offPeakTaskId);
    expect(got?.serverTicketId).toBe("ticket-2");
    expect(got?.registeredAt).toBe(NOW + 2 * MINUTE);
    expect(got?.queuePosition).toBeUndefined();
  });
});
