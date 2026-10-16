import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OffPeakTaskRepo } from "../src/session/offPeakTaskRepo.js";
import { OffPeakTaskService } from "../src/session/offPeakTaskService.js";
import { classifyOffPeakCreateFailure } from "../src/session/offPeakTaskService.js";
import {
  OffPeakServerError,
  type OffPeakBatchStatusResult,
  type OffPeakServerClient,
  type OffPeakTakeTicketResult,
} from "../src/session/offPeakServerClient.js";
import { setDataBaseDir } from "../src/paths.js";
import { createServiceLogger } from "../src/logger/serviceLogger.js";

const NOW = 1_700_000_000_000;
const logger = createServiceLogger("off-peak-service-test", {
  isDebugEnabled: false,
});

/** 可编程假客户端：按序出票 / 定制批量状态应答。 */
class FakeClient implements OffPeakServerClient {
  takeCalls: string[] = [];
  settleCalls: string[] = [];
  statusCalls: string[][] = [];
  nextTicketState: OffPeakTakeTicketResult["state"] = "queued";
  takeError: Error | null = null;
  settleError: Error | null = null;
  statusResponse: OffPeakBatchStatusResult = { tickets: [] };
  private ticketSeq = 0;

  async getTakeNumberAvailability() {
    return { canTakeNumber: true };
  }

  async takeTicket(taskId: string): Promise<OffPeakTakeTicketResult> {
    this.takeCalls.push(taskId);
    if (this.takeError) throw this.takeError;
    this.ticketSeq += 1;
    return {
      ticketId: `t-${this.ticketSeq}`,
      state: this.nextTicketState,
      position: 3,
      nextPollAfterMs: 5000,
      registeredAt: NOW,
    };
  }

  async batchStatus(ticketIds: string[]): Promise<OffPeakBatchStatusResult> {
    this.statusCalls.push(ticketIds);
    return this.statusResponse;
  }

  async settle(ticketId: string): Promise<void> {
    this.settleCalls.push(ticketId);
    if (this.settleError) throw this.settleError;
  }
}

describe("OffPeakTaskService 编排", () => {
  let tempDir: string | null = null;
  let repo: OffPeakTaskRepo;
  let client: FakeClient;
  let service: OffPeakTaskService;
  let wakes: number;
  let stops: Array<{ conversationId: string }>;

  const makeService = () =>
    new OffPeakTaskService({
      repo,
      client,
      logger,
      resolveCodingPlanSupport: async () => ({
        supported: true,
        kind: "bigmodel-personal",
        providerFamily: "bigmodel",
        providerId: "account:bigmodel-individual-coding-plan",
        selectedConnectionKey: "coding-plan:account:bigmodel-individual-coding-plan",
      }),
      resolveTelemetryProviderName: async () => "api.example.com",
      resolveModelSelection: async ({ modelId, reasoningLevel }) => ({
        ok: true as const,
        selection: {
          providerId: "account:zai-offpeak-idle-plan",
          modelId: modelId ?? "GLM-5.2",
          ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
        },
      }),
      requestSchedulerWake: () => {
        wakes += 1;
      },
      stopRunningTask: async (params) => {
        stops.push({ conversationId: params.conversationId });
      },
      now: () => NOW,
    });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-off-peak-service-"));
    setDataBaseDir(tempDir);
    repo = new OffPeakTaskRepo();
    client = new FakeClient();
    wakes = 0;
    stops = [];
    service = makeService();
  });

  afterEach(() => {
    service.stopSync();
    repo.close();
    setDataBaseDir(null);
    vi.useRealTimers();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  const createParams = {
    title: "夜间重构",
    prompt: "抽取公共函数",
    permissionMode: "default",
    modelSelection: {
      providerId: "account:zai-offpeak-idle-plan",
      modelId: "GLM-5.2",
      options: { reasoningLevel: "max" },
    },
    workspacePath: "/tmp/ws",
  };

  const createTask = async () => {
    const result = await service.createTask(createParams);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected successful test fixture creation");
    return result.task;
  };

  const makeLegacySelectionRow = async (offPeakTaskId: string) => {
    repo.close();
    const db = new DatabaseSync(join(tempDir!, ".zcode", "v2", "tasks-index.sqlite"));
    db.prepare(
      `UPDATE off_peak_tasks
       SET model = 'GLM-5.2', thought_level = 'high', model_selection = NULL
       WHERE off_peak_task_id = ?`,
    ).run(offPeakTaskId);
    db.close();
  };

  it("DB109-13：list 不用当前账号补旧身份，保留正文和 Ticket", async () => {
    const created = await createTask();
    await makeLegacySelectionRow(created.offPeakTaskId);

    const listed = await service.list();
    expect(listed[0]?.modelSelection).toBeUndefined();
    expect(listed[0]).toMatchObject({
      prompt: created.prompt,
      serverTicketId: created.serverTicketId,
      modelSelectionIssue: { code: "repair-required" },
    });
    expect(listed[0]?.modelSelectionIssue).not.toHaveProperty("legacyModelId");
    expect((await repo.get(created.offPeakTaskId))?.modelSelection).toEqual(
      listed[0]?.modelSelection,
    );
  });

  it("list：损坏配置不影响内容，也不从旧字段恢复执行选择", async () => {
    const created = await createTask();
    repo.close();
    const db = new DatabaseSync(join(tempDir!, ".zcode", "v2", "tasks-index.sqlite"));
    db.prepare(
      `UPDATE off_peak_tasks
       SET model = 'GLM-5.2', thought_level = 'high', model_selection = '{invalid'
       WHERE off_peak_task_id = ?`,
    ).run(created.offPeakTaskId);
    db.close();

    const [task] = await service.list();
    expect(task?.modelSelection).toBeUndefined();
    expect(task?.prompt).toBe(created.prompt);
  });

  it("list：无法可靠恢复时保留任务为待修复，不影响列表", async () => {
    const created = await createTask();
    await makeLegacySelectionRow(created.offPeakTaskId);
    service = new OffPeakTaskService({
      repo,
      client,
      logger,
      resolveCodingPlanSupport: async () => ({ supported: false, reason: "no-active-plan" }),
      resolveTelemetryProviderName: async () => "",
      resolveModelSelection: async () => ({
        ok: false as const,
        validation: {
          ok: false as const,
          code: "model-not-found" as const,
          providerId: "account:zai-offpeak-idle-plan",
          modelId: "GLM-5.2",
        },
      }),
      now: () => NOW,
    });

    const listed = await service.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      modelSelectionIssue: {
        code: "repair-required",
      },
    });
  });

  it("list：暂时失效只返回诊断，保留原 Selection/Ticket，派发校验仍阻断且可恢复", async () => {
    const created = await createTask();
    await repo.updateSchedulingSnapshot(created.offPeakTaskId, {
      schedulable: true,
      now: NOW + 1,
    });
    service = new OffPeakTaskService({
      repo,
      client,
      logger,
      resolveCodingPlanSupport: async () => ({ supported: false, reason: "no-active-plan" }),
      resolveTelemetryProviderName: async () => "",
      resolveModelSelection: async () => ({
        ok: false as const,
        validation: {
          ok: false as const,
          code: "reasoning-level-not-supported" as const,
          providerId: createParams.modelSelection.providerId,
          modelId: createParams.modelSelection.modelId,
          reasoningLevel: "max",
          supportedLevels: ["low", "high"],
        },
      }),
    });

    const [listed] = await service.list();
    expect(listed?.modelSelection).toEqual(created.modelSelection);
    expect(listed?.modelSelectionIssue).toEqual({
      code: "repair-required",
      legacyModelId: "GLM-5.2",
      legacyReasoningLevel: "max",
    });
    expect(listed?.schedulable).toBe(false);
    expect((await repo.get(created.offPeakTaskId))?.modelSelection).toEqual(created.modelSelection);
    expect((await repo.get(created.offPeakTaskId))?.serverTicketId).toBe(created.serverTicketId);
    expect(await service.validateDispatchModelSelection(created.modelSelection!)).toBe(false);
    service = makeService();
    expect((await service.get(created.offPeakTaskId))?.modelSelection).toEqual(
      created.modelSelection,
    );
    expect((await service.get(created.offPeakTaskId))?.modelSelectionIssue).toBeUndefined();
  });

  it("派发窄校验只接受 resolver 所属的固定 Provider", async () => {
    await expect(
      service.validateDispatchModelSelection({
        providerId: "account:zai-offpeak-idle-plan",
        modelId: "GLM-5.2",
        options: { reasoningLevel: "high" },
      }),
    ).resolves.toBe(true);
    await expect(
      service.validateDispatchModelSelection({
        providerId: "other-provider",
        modelId: "GLM-5.2",
      }),
    ).resolves.toBe(false);
  });

  it("createTask：取号成功才落库；取号即 ready 置 schedulable 并唤醒 scheduler", async () => {
    client.nextTicketState = "ready";
    const result = await service.createTask(createParams);
    expect(result).toMatchObject({
      ok: true,
      ticketInitialState: "ready",
      queuePosition: 3,
      providerName: "api.example.com",
    });
    if (!result.ok) throw new Error("expected create success");
    const created = result.task;
    expect(client.takeCalls).toEqual([created.offPeakTaskId]);
    expect(created.serverTicketId).toBe("t-1");
    expect(created.queuePosition).toBe(3);
    expect(created.schedulable).toBe(true);
    expect(wakes).toBe(1);
  });

  it("createTask：绑定会话已有未终态任务 → session_bound，且不再取号（D50-4 / 机审 CR-02）", async () => {
    const first = await service.createTask({ ...createParams, boundSessionId: "sess-x" });
    expect(first.ok).toBe(true);
    const second = await service.createTask({ ...createParams, boundSessionId: "sess-x" });
    expect(second).toMatchObject({
      ok: false,
      failureStage: "client_validation",
      errorCategory: "client_validation",
      errorCode: "session_bound",
    });
    expect(client.takeCalls).toHaveLength(1);
    expect(await repo.list()).toHaveLength(1);
    // 他会话不受影响。
    expect((await service.createTask({ ...createParams, boundSessionId: "sess-y" })).ok).toBe(true);
  });

  it("createTask：预检被并发穿过时，INSERT 撞唯一索引同样映射为 session_bound", async () => {
    const original = repo.hasActiveBoundTask.bind(repo);
    const spy = vi.spyOn(repo, "hasActiveBoundTask").mockResolvedValue(false);
    try {
      expect((await service.createTask({ ...createParams, boundSessionId: "sess-z" })).ok).toBe(
        true,
      );
      await expect(
        service.createTask({ ...createParams, boundSessionId: "sess-z" }),
      ).resolves.toMatchObject({
        ok: false,
        errorCode: "session_bound",
      });
    } finally {
      spy.mockRestore();
    }
    expect(await original("/tmp/ws", "sess-z")).toBe(true);
    expect(await repo.list()).toHaveLength(1);
  });

  it("createTask：取号 3103 返回稳定分类和业务码，不落库", async () => {
    client.takeError = new OffPeakServerError("quota", 429, 3103, NOW + 1000);
    await expect(service.createTask(createParams)).resolves.toEqual({
      ok: false,
      failureStage: "ticket_request",
      errorCategory: "quota_3103",
      errorCode: "3103",
      providerName: "api.example.com",
    });
    expect(await repo.list()).toHaveLength(0);
  });

  it("createTask：客户端校验和本地持久化失败都返回结构化结果", async () => {
    await expect(service.createTask({ ...createParams, prompt: "" })).resolves.toMatchObject({
      ok: false,
      failureStage: "client_validation",
      errorCategory: "client_validation",
      errorCode: "",
    });
    vi.spyOn(repo, "create").mockRejectedValueOnce(new Error("private /tmp/path"));
    await expect(service.createTask(createParams)).resolves.toMatchObject({
      ok: false,
      failureStage: "local_persist",
      errorCategory: "local_persist",
      errorCode: "",
    });
  });

  it("稳定失败枚举覆盖 eligibility/quota/network/invalid_response/unknown", () => {
    const invalidResponse = (() => {
      try {
        z.string().parse(1);
      } catch (error) {
        return error;
      }
      throw new Error("expected zod failure");
    })();
    expect(
      classifyOffPeakCreateFailure(new OffPeakServerError("private", 403, 3101), "ticket_request"),
    ).toEqual({
      failureStage: "ticket_request",
      errorCategory: "eligibility_3101",
      errorCode: "3101",
    });
    expect(
      classifyOffPeakCreateFailure(new OffPeakServerError("private", 429, 3103), "ticket_request"),
    ).toMatchObject({ errorCategory: "quota_3103", errorCode: "3103" });
    expect(
      classifyOffPeakCreateFailure(new TypeError("private URL"), "ticket_request"),
    ).toMatchObject({ errorCategory: "network", errorCode: "" });
    expect(classifyOffPeakCreateFailure(invalidResponse, "ticket_request")).toMatchObject({
      errorCategory: "invalid_response",
      errorCode: "",
    });
    expect(
      classifyOffPeakCreateFailure(new OffPeakServerError("private", 500, 3999), "ticket_request"),
    ).toMatchObject({ errorCategory: "unknown", errorCode: "3999" });
  });

  it("cancelTask：先落 cancelled 再停 loop；迟到 stopped 回写被终态守卫丢弃", async () => {
    const created = await createTask();
    await repo.updateSchedulingSnapshot(created.offPeakTaskId, {
      schedulable: true,
    });
    await repo.claimDue(NOW);
    await repo.markRunning(created.offPeakTaskId, {
      startedAt: NOW,
      conversationId: "conv-1",
      sessionId: "sess-1",
    });

    const cancelled = await service.cancelTask(created.offPeakTaskId);
    expect(cancelled?.status).toBe("cancelled");
    expect(stops).toEqual([{ conversationId: "conv-1" }]);
    // 迟到的 loop 终态回写不可逆出终态
    expect(
      await repo.markTerminal(created.offPeakTaskId, {
        status: "failed",
        endedAt: NOW + 1,
      }),
    ).toBeNull();
    // settle outbox：取消即上报核销
    expect(client.settleCalls).toEqual(["t-1"]);
    expect((await repo.get(created.offPeakTaskId))?.settledAt).toBe(NOW);
  });

  it("pause/continue：票活着零成本恢复；票已废手动重取号回队尾", async () => {
    const created = await createTask();
    expect((await service.pauseTask(created.offPeakTaskId))?.status).toBe("paused");

    // 票活着（queued）：不重取号
    client.statusResponse = {
      tickets: [{ ticketId: "t-1", state: "queued", position: 2 }],
    };
    await service.continueTask(created.offPeakTaskId);
    expect(client.takeCalls).toHaveLength(1); // 仍只有创建那次
    expect((await repo.get(created.offPeakTaskId))?.queuePosition).toBe(2);

    // 票已废（expired）：Continue 触发重取号
    await service.pauseTask(created.offPeakTaskId);
    client.statusResponse = {
      tickets: [{ ticketId: "t-1", state: "expired" }],
    };
    await service.continueTask(created.offPeakTaskId);
    expect(client.takeCalls).toHaveLength(2);
    expect((await repo.get(created.offPeakTaskId))?.serverTicketId).toBe("t-2");
  });

  it("runSyncCycle：ready 翻 schedulable + 唤醒；queued 更新位次；expired（queued）自动重取号；paused 停在原地", async () => {
    const a = await createTask(); // t-1
    const b = await createTask(); // t-2
    const c = await createTask(); // t-3
    await service.pauseTask(c.offPeakTaskId);
    wakes = 0;

    client.statusResponse = {
      nextPollAfterMs: 7000,
      tickets: [
        { ticketId: "t-1", state: "ready" },
        { ticketId: "t-2", state: "queued", position: 5 },
        { ticketId: "t-3", state: "expired" }, // paused：不得重取号
      ],
    };
    await service.runSyncCycle();

    expect((await repo.get(a.offPeakTaskId))?.schedulable).toBe(true);
    expect((await repo.get(b.offPeakTaskId))?.queuePosition).toBe(5);
    expect((await repo.get(c.offPeakTaskId))?.serverTicketId).toBe("t-3"); // 未重取
    expect(client.takeCalls).toHaveLength(3); // 只有三次创建取号
    expect(wakes).toBe(1);

    // queued 的废票在下一轮自动重取号
    await service.continueTask(c.offPeakTaskId); // 票废 → 立即重取（第 4 次）
    expect(client.takeCalls).toHaveLength(4);
  });

  it("settle outbox：5xx 失败保持未核销随周期补报；4xx 按幂等 ack；无票直接标记", async () => {
    const a = await createTask();
    await repo.markTerminal(a.offPeakTaskId, {
      status: "completed",
      endedAt: NOW,
    });

    client.settleError = new OffPeakServerError("boom", 500);
    await service.runSyncCycle();
    expect((await repo.get(a.offPeakTaskId))?.settledAt).toBeUndefined();

    client.settleError = new OffPeakServerError("gone", 404);
    await service.runSyncCycle();
    expect((await repo.get(a.offPeakTaskId))?.settledAt).toBe(NOW);
  });

  it("handleTicketExpiredDuringRun：running 回队保 session 并同 task_id 重取号（§4.6）", async () => {
    const created = await createTask();
    await repo.updateSchedulingSnapshot(created.offPeakTaskId, {
      schedulable: true,
    });
    await repo.claimDue(NOW);
    await repo.markRunning(created.offPeakTaskId, {
      startedAt: NOW,
      conversationId: "conv-1",
      sessionId: "sess-1",
    });

    await service.handleTicketExpiredDuringRun(created.offPeakTaskId);
    const after = await repo.get(created.offPeakTaskId);
    expect(after?.status).toBe("queued");
    expect(after?.sessionId).toBe("sess-1");
    expect(after?.serverTicketId).toBe("t-2"); // 新票
    expect(client.takeCalls).toEqual([created.offPeakTaskId, created.offPeakTaskId]);

    // 已取消的任务不回队
    await service.cancelTask(created.offPeakTaskId);
    await service.handleTicketExpiredDuringRun(created.offPeakTaskId);
    expect((await repo.get(created.offPeakTaskId))?.status).toBe("cancelled");
  });

  it("updateTask：queued/paused 可编辑；running 拒绝（D30-7）", async () => {
    const created = await createTask();
    const edited = await service.updateTask(created.offPeakTaskId, {
      title: "改名",
      modelSelection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" },
    });
    expect(edited?.title).toBe("改名");
    expect(edited?.modelSelection).toEqual({
      providerId: "account:zai-offpeak-idle-plan",
      modelId: "GLM-5.2",
    });
    // Off-Peak 已经是 Submission，不能清空成“以后再选”。
    expect(await service.updateTask(created.offPeakTaskId, { modelSelection: null })).toBeNull();

    await repo.updateSchedulingSnapshot(created.offPeakTaskId, {
      schedulable: true,
    });
    await repo.claimDue(NOW);
    await repo.markRunning(created.offPeakTaskId, { startedAt: NOW });
    expect(await service.updateTask(created.offPeakTaskId, { title: "x" })).toBeNull();
  });

  it("deleteTask：非终态先取消（含核销）再删行", async () => {
    const created = await createTask();
    await service.deleteTask(created.offPeakTaskId);
    expect(await repo.get(created.offPeakTaskId)).toBeNull();
    expect(client.settleCalls).toEqual(["t-1"]);
  });

  it("deleteHistory：仅写隐藏标记，不删除任务或会话", async () => {
    const created = await createTask();
    await repo.updateSchedulingSnapshot(created.offPeakTaskId, {
      schedulable: true,
    });
    await repo.claimDue(NOW);
    await repo.markRunning(created.offPeakTaskId, {
      startedAt: NOW,
      conversationId: "conv-1",
      sessionId: "sess-1",
    });
    await repo.markTerminal(created.offPeakTaskId, {
      status: "completed",
      endedAt: NOW + 1,
      filesChanged: 2,
    });

    const updated = await service.deleteHistory(created.offPeakTaskId);
    expect(updated).toMatchObject({
      offPeakTaskId: created.offPeakTaskId,
      status: "completed",
      conversationId: "conv-1",
      sessionId: "sess-1",
      filesChanged: 2,
      historyDeletedAt: NOW,
    });
    expect(await service.get(created.offPeakTaskId)).not.toBeNull();
    expect(client.settleCalls).toEqual([]);
  });
});
