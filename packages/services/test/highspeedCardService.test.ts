import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { HighspeedDrawRequest, HighspeedDrawResponse } from "@zcode/shared";
import {
  buildHighspeedCodingPlanAuthHeaders,
  createHighspeedHttpTransport,
  HighspeedCardService,
  type HighspeedInferenceAuth,
  type HighspeedServiceTransport,
} from "../src/highspeed/highspeedCardService.js";
import { createHighspeedMockTransport } from "../src/highspeed/highspeedMockTransport.js";
import { HIGHSPEED_REQUEST_TIMEOUT_MS } from "../src/highspeed/highspeedHttpTransport.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/**
 * 排空微任务直到条件成立，避免测试绑定内部 await 数量；设上界防止实现回归时死循环空转
 * （纯微任务循环会饿死计时器，vitest 的用例超时也无法打断）。
 */
async function drainUntil(condition: () => boolean, label: string): Promise<void> {
  for (let turn = 0; turn < 1_000; turn += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error(`condition not reached: ${label}`);
}

const cardResponse = (taskId: string, now: number): HighspeedDrawResponse => ({
  code: 0,
  msg: "success",
  data: {
    card: {
      card_id: "hsc-1",
      task_id: taskId,
      provider: "zai",
      model: "glm-5",
      issued_at: now,
      expires_at: now + 15 * 60_000,
    },
    next_draw_at: now + 60 * 60_000,
  },
});

function createTransport(draw: (request: HighspeedDrawRequest) => Promise<HighspeedDrawResponse>) {
  const calls: HighspeedDrawRequest[] = [];
  const transport: HighspeedServiceTransport = {
    draw: async (request) => {
      calls.push(request);
      return draw(request);
    },
    healthy: async (cardId) => ({
      cardId,
      promptTokens: 0,
      completionTokens: 90,
      durationSeconds: 1,
    }),
  };
  return { calls, transport };
}

describe("HighspeedCardService", () => {
  it("skips draw for an automation turn without disabling the next manual turn", async () => {
    const now = 9_000;
    const { calls, transport } = createTransport(async (request) =>
      cardResponse(request.task_id, now),
    );
    const service = new HighspeedCardService({ transport, now: () => now });

    const automationResult = await service.prepareTurn({
      taskId: "task-1",
      providerId: "account:zai-team-coding-plan",
      model: "glm-5",
      automationId: "automation-1",
    });

    expect(automationResult).toMatchObject({ kind: "fallback", reason: "automation" });
    expect(calls).toHaveLength(0);

    const manualResult = await service.prepareTurn({
      taskId: "task-1",
      providerId: "account:zai-team-coding-plan",
      model: "glm-5",
    });
    expect(manualResult.kind).toBe("accelerated");
    expect(calls).toHaveLength(1);
  });

  it("sends the allowlisted builtin coding-plan id in the draw body instead of the provider id", async () => {
    const now = 10_000;
    const { calls, transport } = createTransport(async (request) =>
      cardResponse(request.task_id, now),
    );
    const service = new HighspeedCardService({ transport, now: () => now });

    const result = await service.prepareTurn({
      taskId: "task-1",
      providerId: "account:bigmodel-team-coding-plan",
      model: "GLM-5.3",
    });

    // 回归：曾把会话选择的完整 providerId 透传进 draw body，被服务端白名单
    // 以 3001 参数错误拒绝；契约要求 body 的 provider 是 builtin:*-coding-plan。
    expect(result.kind).toBe("accelerated");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      task_id: "task-1",
      provider: "builtin:bigmodel-coding-plan",
      model: "GLM-5.3",
    });
  });

  it("falls back without drawing when the provider has no allowlisted coding-plan id", async () => {
    const now = 10_000;
    const { calls, transport } = createTransport(async (request) =>
      cardResponse(request.task_id, now),
    );
    const service = new HighspeedCardService({ transport, now: () => now });

    // Start Plan 与自定义 Provider 都不在服务端 highspeed 白名单内。
    const startPlan = await service.prepareTurn({
      taskId: "task-1",
      providerId: "account:zai-start-plan",
      model: "GLM-5.3",
    });
    expect(startPlan).toMatchObject({ kind: "fallback", reason: "unavailable" });

    const custom = await service.prepareTurn({
      taskId: "task-1",
      providerId: "2b05e183-7ae4-46d6-aedb-4c8f750d9811",
      model: "GLM-5.3",
    });
    expect(custom).toMatchObject({ kind: "fallback", reason: "unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("gates draw on the coding-plan model catalog and keeps covered models accelerated", async () => {
    const now = 9_000;
    const { calls, transport } = createTransport(async (request) =>
      cardResponse(request.task_id, now),
    );
    let covered = false;
    const service = new HighspeedCardService({
      transport,
      now: () => now,
      resolveModelCovered: async () => covered,
    });

    // 回归：会话恢复出的陈旧 (coding-plan provider, 已下线模型) 组合曾照样发 draw；
    // 契约要求模型不在所选 Provider 模型目录内时不发接口（spec §3 规则 14）。
    const staleModel = await service.prepareTurn({
      taskId: "task-1",
      providerId: "account:bigmodel-team-coding-plan",
      model: "GLM-4.6",
    });
    expect(staleModel).toMatchObject({ kind: "fallback", reason: "unavailable" });
    expect(calls).toHaveLength(0);

    // 门禁不落冷却、不改卡状态；切回目录内模型后下一轮立即可抽。
    covered = true;
    const coveredModel = await service.prepareTurn({
      taskId: "task-1",
      providerId: "account:bigmodel-team-coding-plan",
      model: "GLM-5.3",
    });
    expect(coveredModel.kind).toBe("accelerated");
    expect(calls).toHaveLength(1);
  });

  it("treats a failing model catalog check as not covered without drawing", async () => {
    const now = 9_000;
    const { calls, transport } = createTransport(async (request) =>
      cardResponse(request.task_id, now),
    );
    const service = new HighspeedCardService({
      transport,
      now: () => now,
      resolveModelCovered: async () => {
        throw new Error("model selection view unavailable");
      },
    });

    const result = await service.prepareTurn({
      taskId: "task-1",
      providerId: "account:zai-team-coding-plan",
      model: "GLM-5.3",
    });
    expect(result).toMatchObject({ kind: "fallback", reason: "unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("gates draw on Coding Plan support and keeps entitled users accelerated", async () => {
    const now = 9_000;
    const { calls, transport } = createTransport(async (request) =>
      cardResponse(request.task_id, now),
    );
    let supported = false;
    const service = new HighspeedCardService({
      transport,
      now: () => now,
      resolveCodingPlanSupported: async () => supported,
    });

    const gatedResult = await service.prepareTurn({
      taskId: "task-1",
      providerId: "account:zai-team-coding-plan",
      model: "glm-5",
    });
    expect(gatedResult).toMatchObject({ kind: "fallback", reason: "no-coding-plan" });
    expect(calls).toHaveLength(0);

    // 门禁不落冷却，不改变卡状态；用户开通 Coding Plan 后下一轮立即可抽。
    supported = true;
    const entitledResult = await service.prepareTurn({
      taskId: "task-1",
      providerId: "account:zai-team-coding-plan",
      model: "glm-5",
    });
    expect(entitledResult.kind).toBe("accelerated");
    expect(calls).toHaveLength(1);
  });

  it("treats a failing Coding Plan probe as unsupported instead of drawing", async () => {
    const now = 9_000;
    const { calls, transport } = createTransport(async (request) =>
      cardResponse(request.task_id, now),
    );
    const service = new HighspeedCardService({
      transport,
      now: () => now,
      resolveCodingPlanSupported: async () => {
        throw new Error("credential store unavailable");
      },
    });

    const result = await service.prepareTurn({
      taskId: "task-1",
      providerId: "account:zai-team-coding-plan",
      model: "glm-5",
    });
    expect(result).toMatchObject({ kind: "fallback", reason: "no-coding-plan" });
    expect(calls).toHaveLength(0);
  });

  it.each(["model catalog", "Coding Plan support"] as const)(
    "falls back as unavailable without drawing when the %s check outlives the send budget",
    async (gate) => {
      const now = 9_000;
      const { calls, transport } = createTransport(async (request) =>
        cardResponse(request.task_id, now),
      );
      const waits: Array<() => void> = [];
      // 模拟 Provider Runtime 初始化阻塞：模型选择视图 / Coding Plan 判定迟迟不返回。
      const blocked = deferred<boolean>();
      const service = new HighspeedCardService({
        transport,
        now: () => now,
        wait: async () => new Promise<void>((resolve) => waits.push(resolve)),
        ...(gate === "model catalog"
          ? { resolveModelCovered: () => blocked.promise }
          : { resolveCodingPlanSupported: () => blocked.promise }),
      });
      const params = {
        taskId: "task-1",
        providerId: "account:zai-team-coding-plan",
        model: "glm-5",
        waitBudgetMs: 1,
      };

      // 回归（CR-02）：门禁 await 曾不受 1s 发送预算约束，Registry 未就绪时发送被无限期挂起。
      const first = service.prepareTurn(params);
      await drainUntil(() => waits.length > 0, "send budget timer registered");
      waits.shift()?.();
      expect(await first).toMatchObject({ kind: "fallback", reason: "unavailable" });
      expect(calls).toHaveLength(0);

      // 判定不取消，晚到的结果不补发 draw、不改变卡与冷却状态；下一轮判定命中即正常抽卡。
      blocked.resolve(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(calls).toHaveLength(0);
      expect(await service.getSnapshot()).toEqual({ card: null, nextDrawAt: null, drawing: false });
      expect((await service.prepareTurn(params)).kind).toBe("accelerated");
      expect(calls).toHaveLength(1);
    },
  );

  it("counts the draw wait against the budget already spent on the gates", async () => {
    const now = 9_000;
    const pending = deferred<HighspeedDrawResponse>();
    const { calls, transport } = createTransport(async () => pending.promise);
    const waits: Array<() => void> = [];
    const catalog = deferred<boolean>();
    const service = new HighspeedCardService({
      transport,
      now: () => now,
      wait: async () => new Promise<void>((resolve) => waits.push(resolve)),
      resolveModelCovered: () => catalog.promise,
    });

    const result = service.prepareTurn({
      taskId: "task-1",
      providerId: "account:zai-team-coding-plan",
      model: "glm-5",
      waitBudgetMs: 1000,
    });
    // 门禁在预算内通过后进入 draw 等待：两段共享进入 prepareTurn 时的同一截止时间，
    // draw 不得重新获得一整段 1s，否则总等待可达「门禁耗时 + 1s」。
    await drainUntil(() => waits.length > 0, "send budget timer registered");
    catalog.resolve(true);
    await drainUntil(() => calls.length > 0, "draw started");
    expect(waits).toHaveLength(1);
    waits.shift()?.();
    expect(await result).toMatchObject({ kind: "fallback", reason: "draw-timeout" });
    expect((await service.getSnapshot()).drawing).toBe(true);
  });

  it("falls back as draw-timeout but keeps the card when inference auth outlives the send budget", async () => {
    const now = 9_000;
    const { calls, transport } = createTransport(async (request) =>
      cardResponse(request.task_id, now),
    );
    const waits: Array<() => void> = [];
    const auth: HighspeedInferenceAuth = {
      zcodeJwt: "zcode-jwt",
      family: "zai",
      codingPlanAuthorization: "coding-plan-jwt",
      targetType: "PERSONAL",
    };
    let pendingAuth: ReturnType<typeof deferred<HighspeedInferenceAuth>> | null = null;
    const service = new HighspeedCardService({
      transport,
      now: () => now,
      wait: async () => new Promise<void>((resolve) => waits.push(resolve)),
      resolveInferenceAuth: async () => (pendingAuth ? pendingAuth.promise : auth),
    });
    const params = {
      taskId: "task-1",
      providerId: "account:zai-team-coding-plan",
      model: "glm-5",
      waitBudgetMs: 1000,
    };
    expect((await service.prepareTurn(params)).kind).toBe("accelerated");
    waits.length = 0;

    // 回归（CR-02）：复用卡时的加速鉴权解析曾在预算外单独 await，凭据解析卡住会让发送无限期挂起。
    pendingAuth = deferred<HighspeedInferenceAuth>();
    const blocked = service.prepareTurn(params);
    await drainUntil(() => waits.length > 0, "send budget timer registered");
    waits.shift()?.();
    expect(await blocked).toMatchObject({
      kind: "fallback",
      reason: "draw-timeout",
      card: { cardId: "hsc-1", taskId: "task-1" },
    });
    expect((await service.getSnapshot()).card?.cardId).toBe("hsc-1");

    // 卡保留：鉴权恢复后的下一轮直接复用该卡加速，不重新 draw。
    pendingAuth.resolve(auth);
    pendingAuth = null;
    const next = await service.prepareTurn(params);
    expect(next).toMatchObject({ kind: "accelerated", card: { cardId: "hsc-1" } });
    expect(calls).toHaveLength(1);
  });

  it("keeps mock card semantics but leaves inference on the normal session route", async () => {
    const now = 10_000;
    const { transport } = createTransport(async (request) => cardResponse(request.task_id, now));
    let resolveAuthCalls = 0;
    const service = new HighspeedCardService({
      transport,
      now: () => now,
      inferenceMode: "session-default",
      resolveInferenceAuth: async () => {
        resolveAuthCalls += 1;
        return {
          zcodeJwt: "must-not-be-used",
          family: "zai",
          codingPlanAuthorization: "must-not-be-used",
          targetType: "PERSONAL",
        };
      },
    });

    const result = await service.prepareTurn({
      taskId: "task-1",
      providerId: "account:zai-team-coding-plan",
      model: "glm-5",
    });

    expect(result).toMatchObject({
      kind: "accelerated",
      card: { taskId: "task-1", model: "glm-5" },
    });
    expect(result).not.toHaveProperty("execution");
    expect(resolveAuthCalls).toBe(0);
  });

  it("accelerates when the current task card arrives inside the wait budget", async () => {
    const now = 10_000;
    const { calls, transport } = createTransport(async (request) =>
      cardResponse(request.task_id, now),
    );
    const service = new HighspeedCardService({ transport, now: () => now });

    const result = await service.prepareTurn({
      taskId: "task-1",
      providerId: "account:zai-team-coding-plan",
      model: "glm-5",
      waitBudgetMs: 1000,
    });

    expect(result.kind).toBe("accelerated");
    expect(result.card?.taskId).toBe("task-1");
    // 加速轮通过标准 Selection 指向隐藏的加速卡内建 Provider；端点等静态事实来自 Provider
    // Config，只有卡 JWT 与卡 ID 作为本次执行的动态鉴权随 modelExecution 下发。
    expect(result.execution?.modelSelection).toEqual({
      providerId: "account:zai-highspeed-card",
      modelId: "glm-5",
    });
    expect(result.execution?.requestAuth.headers["X-Highspeed-Card-ID"]).toBe("hsc-1");
    // 加速请求任何失败都退回会话模型（spec §2.2）：卡过期按 3402 单独给原因，兜底规则不带错误码。
    // CLI 只按声明匹配，这里的声明就是降级覆盖面的唯一事实源；退回目标 = 本次提交的会话选择，
    // 不依赖 CLI 内存里的常驻选择（冷恢复竞态下它可能未绑定）。
    expect(result.execution?.selectionFallback).toEqual({
      providerId: "account:zai-highspeed-card",
      rules: [
        { reason: "highspeed_card_expired", providerErrorCode: "3402" },
        { reason: "highspeed_request_failed" },
      ],
      target: { providerId: "account:zai-team-coding-plan", modelId: "glm-5" },
    });
    expect(calls).toHaveLength(1);
  });

  it("carries the session reasoning level into the accelerated selection options", async () => {
    const now = 10_000;
    // 复现用户命中的 BigModel 场景：卡回显 GLM-5.3，加速 Provider 按账号 Family 落到 bigmodel。
    const { transport } = createTransport(async (request) => ({
      code: 0,
      msg: "success",
      data: {
        card: {
          card_id: "hsc-1",
          task_id: request.task_id,
          provider: "bigmodel",
          model: "GLM-5.3",
          issued_at: now,
          expires_at: now + 15 * 60_000,
        },
        next_draw_at: now + 60 * 60_000,
      },
    }));
    const service = new HighspeedCardService({
      transport,
      now: () => now,
      resolveInferenceAuth: async () => ({
        zcodeJwt: "zcode-jwt",
        family: "bigmodel",
        codingPlanAuthorization: "maas-jwt",
        targetType: "PERSONAL",
      }),
    });

    const result = await service.prepareTurn({
      taskId: "task-1",
      providerId: "account:bigmodel-team-coding-plan",
      model: "GLM-5.3",
      reasoningLevel: "enabled",
    });

    // 回归：加速卡曾丢掉会话思考档位，CLI Registry 因 execution 选择缺档位报
    // "Reasoning level is required" 让整轮发送失败。加速只换端点不换模型，档位必须一致。
    expect(result.kind).toBe("accelerated");
    expect(result.execution?.modelSelection).toEqual({
      providerId: "account:bigmodel-highspeed-card",
      modelId: "GLM-5.3",
      options: { reasoningLevel: "enabled" },
    });
    // 退回目标带同一份档位：降级后的原模型请求同样不能因缺档位被 Registry 拒绝。
    expect(result.execution?.selectionFallback.target).toEqual({
      providerId: "account:bigmodel-team-coding-plan",
      modelId: "GLM-5.3",
      options: { reasoningLevel: "enabled" },
    });
  });

  it("carries the Coding Plan dual-JWT and team identity into the accelerated request auth", async () => {
    const now = 10_000;
    const { transport } = createTransport(async (request) => ({
      code: 0,
      msg: "success",
      data: {
        card: {
          card_id: "hsc-1",
          task_id: request.task_id,
          provider: "bigmodel",
          model: "GLM-5.3",
          issued_at: now,
          expires_at: now + 15 * 60_000,
        },
        next_draw_at: now + 60 * 60_000,
      },
    }));
    const service = new HighspeedCardService({
      transport,
      now: () => now,
      // BigModel Team：加速推理与 draw 走同一 highspeed 网关，必须带上 Coding Plan 业务 JWT
      // 与 Team 身份头，来自同一次 selected connection 解析。
      resolveInferenceAuth: async () => ({
        zcodeJwt: "zcode-jwt",
        family: "bigmodel",
        codingPlanAuthorization: "maas-jwt",
        targetType: "TEAM",
        organizationId: "org-1",
        projectId: "project-1",
      }),
    });

    const result = await service.prepareTurn({
      taskId: "task-1",
      providerId: "account:bigmodel-team-coding-plan",
      model: "GLM-5.3",
    });

    // 回归：加速推理曾只发 zcode JWT + 卡 ID，缺 Coding Plan 双 JWT + Team 身份头，
    // 加速网关返回 401 auth_failed。必须与 draw 携带完全一致的 Coding Plan 头，再附加卡 ID。
    expect(result.kind).toBe("accelerated");
    expect(result.execution?.requestAuth.apiKey).toBe("zcode-jwt");
    expect(result.execution?.requestAuth.headers).toEqual({
      Authorization: "Bearer zcode-jwt",
      "X-Bigmodel-Authorization": "Bearer maas-jwt",
      "Bigmodel-Target-Type": "TEAM",
      "Bigmodel-Organization": "org-1",
      "Bigmodel-Project": "project-1",
      "X-Highspeed-Card-ID": "hsc-1",
    });
  });

  it("omits selection options when the session has no reasoning level", async () => {
    const now = 10_000;
    const { transport } = createTransport(async (request) => cardResponse(request.task_id, now));
    const service = new HighspeedCardService({ transport, now: () => now });

    const result = await service.prepareTurn({
      taskId: "task-1",
      providerId: "account:zai-team-coding-plan",
      model: "glm-5",
    });

    // 无档位模型不写 options，避免给 CLI 传空档位或非法值。
    expect(result.kind).toBe("accelerated");
    expect(result.execution?.modelSelection).toEqual({
      providerId: "account:zai-highspeed-card",
      modelId: "glm-5",
    });
  });

  it("falls back after one second but keeps the late hit for the next turn", async () => {
    let now = 20_000;
    const pending = deferred<HighspeedDrawResponse>();
    const { calls, transport } = createTransport(async () => pending.promise);
    const waits: Array<() => void> = [];
    const service = new HighspeedCardService({
      transport,
      now: () => now,
      wait: async () => new Promise<void>((resolve) => waits.push(resolve)),
    });

    const firstPromise = service.prepareTurn({
      taskId: "task-1",
      providerId: "account:zai-team-coding-plan",
      model: "glm-5",
      waitBudgetMs: 1000,
    });
    // 预算从进入 prepareTurn 起算并覆盖异步门禁（规则 11/14）；排空微任务直到 draw 真正发起
    // 再让预算到期，避免测试绑定内部 await 数量，也避免到期落在门禁阶段。
    await drainUntil(() => calls.length > 0, "draw started");
    waits.shift()?.();
    expect(await firstPromise).toMatchObject({ kind: "fallback", reason: "draw-timeout" });

    pending.resolve(cardResponse("task-1", now));
    await Promise.resolve();
    await Promise.resolve();
    now += 1;

    const second = await service.prepareTurn({
      taskId: "task-1",
      providerId: "account:zai-team-coding-plan",
      model: "glm-5",
      waitBudgetMs: 1000,
    });
    expect(second.kind).toBe("accelerated");
    expect(calls).toHaveLength(1);
  });

  it("releases the in-flight draw when the background request fails and draws again next turn", async () => {
    // CR-01 回归：draw 请求永不返回时，1s race 只结束「本次等待」，inFlightDraw 只能在 draw Promise
    // settle 的 finally 里释放。transport 必须让超时请求 reject；否则后续每次发送都复用同一个
    // 永久 pending Promise、等 1s 再降级，整个应用生命周期内不再发起新 draw，只能靠重启恢复。
    let now = 40_000;
    const pending = deferred<HighspeedDrawResponse>();
    let drawCalls = 0;
    const { calls, transport } = createTransport(async (request) => {
      drawCalls += 1;
      return drawCalls === 1 ? pending.promise : cardResponse(request.task_id, now);
    });
    const waits: Array<() => void> = [];
    const service = new HighspeedCardService({
      transport,
      now: () => now,
      wait: async () => new Promise<void>((resolve) => waits.push(resolve)),
    });
    const params = {
      taskId: "task-1",
      providerId: "account:zai-team-coding-plan",
      model: "glm-5",
      waitBudgetMs: 1000,
    };

    const first = service.prepareTurn(params);
    await drainUntil(() => calls.length > 0, "draw started");
    waits.shift()?.();
    expect(await first).toMatchObject({ kind: "fallback", reason: "draw-timeout" });
    expect((await service.getSnapshot()).drawing).toBe(true);

    // 模拟 transport 在后台生命期耗尽后 abort → reject（而不是永久 pending）。
    pending.reject(new Error("highspeed draw request timed out after 20000ms"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect((await service.getSnapshot()).drawing).toBe(false);

    now += 1;
    const second = await service.prepareTurn(params);
    expect(second.kind).toBe("accelerated");
    expect(calls).toHaveLength(2);
  });

  it("honors next_draw_at and silently falls back for a foreign task card", async () => {
    let now = 30_000;
    const { calls, transport } = createTransport(async () => cardResponse("task-a", now));
    const service = new HighspeedCardService({ transport, now: () => now });

    const taskA = await service.prepareTurn({
      taskId: "task-a",
      providerId: "account:zai-team-coding-plan",
      model: "glm-5",
    });
    expect(taskA.kind).toBe("accelerated");

    const taskB = await service.prepareTurn({
      taskId: "task-b",
      providerId: "account:zai-team-coding-plan",
      model: "glm-5",
    });
    expect(taskB).toMatchObject({ kind: "fallback", reason: "foreign-card" });
    expect(calls).toHaveLength(1);

    now += 16 * 60_000;
    const duringCooldown = await service.prepareTurn({
      taskId: "task-b",
      providerId: "account:zai-team-coding-plan",
      model: "glm-5",
    });
    expect(duringCooldown).toMatchObject({ kind: "fallback", reason: "cooldown" });
    expect(calls).toHaveLength(1);
  });
});

describe("Highspeed mock transport", () => {
  it("uses short draw cooldown and card lifetime for local verification", async () => {
    const now = 50_000;
    const hit = createHighspeedMockTransport({
      scenario: "hit-fast",
      now: () => now,
      delay: async () => undefined,
    });
    const miss = createHighspeedMockTransport({
      scenario: "miss",
      now: () => now,
      delay: async () => undefined,
    });

    const hitResponse = await hit.draw({ task_id: "task-1", provider: "zai", model: "glm-5" });
    const missResponse = await miss.draw({
      task_id: "task-1",
      provider: "zai",
      model: "glm-5",
    });

    expect(hitResponse.data.card?.expires_at).toBe(now + 5 * 60_000);
    expect(hitResponse.data.next_draw_at).toBe(now + 2 * 60_000);
    expect(missResponse.data.next_draw_at).toBe(now + 2 * 60_000);
  });
});

describe("Highspeed HTTP contract", () => {
  it("keeps the renderer-shared Highspeed entry free of Node logger initialization", async () => {
    const source = await readFile(
      new URL("../src/highspeed/highspeedHttpTransport.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("createServiceLogger");
  });

  it("builds the shared Coding Plan headers for personal and team plans", () => {
    expect(
      buildHighspeedCodingPlanAuthHeaders({
        zcodeJwt: "zcode-jwt",
        codingPlanAuthorization: "maas-jwt",
        targetType: "PERSONAL",
      }),
    ).toEqual({
      Authorization: "Bearer zcode-jwt",
      // 接口契约要求 X-Bigmodel-Authorization 带 Bearer 前缀；凭据库可能存裸 token。
      "X-Bigmodel-Authorization": "Bearer maas-jwt",
      "Bigmodel-Target-Type": "PERSONAL",
    });

    expect(
      buildHighspeedCodingPlanAuthHeaders({
        zcodeJwt: "Bearer zcode-jwt",
        codingPlanAuthorization: "team-maas-jwt",
        targetType: "TEAM",
        organizationId: "org-1",
        projectId: "project-1",
      }),
    ).toEqual({
      Authorization: "Bearer zcode-jwt",
      "X-Bigmodel-Authorization": "Bearer team-maas-jwt",
      "Bigmodel-Target-Type": "TEAM",
      "Bigmodel-Organization": "org-1",
      "Bigmodel-Project": "project-1",
    });

    // 已带前缀的凭据不能重复加 Bearer。
    expect(
      buildHighspeedCodingPlanAuthHeaders({
        zcodeJwt: "zcode-jwt",
        codingPlanAuthorization: "Bearer already-prefixed",
        targetType: "PERSONAL",
      }),
    ).toMatchObject({ "X-Bigmodel-Authorization": "Bearer already-prefixed" });
  });

  it("uses Coding Plan headers only for draw and login auth for healthy", async () => {
    const requests: Array<{
      url: string;
      method: string;
      headers: Headers;
      body: unknown;
    }> = [];
    const transport = createHighspeedHttpTransport({
      drawUrl: "https://example.test/api/v1/highspeed/draw",
      healthyBaseUrl: "https://example.test/api/v1/highspeed/",
      drawHeaders: async () => ({
        Authorization: "Bearer zcode-jwt",
        "X-Bigmodel-Authorization": "maas-jwt",
        "Bigmodel-Target-Type": "PERSONAL",
      }),
      healthyHeaders: async () => ({ Authorization: "Bearer zcode-jwt" }),
      logger: { warn: vi.fn() },
      fetchImpl: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        if (String(input).endsWith("/draw")) {
          return Response.json(cardResponse("task-1", 10_000));
        }
        if (String(input).endsWith("/hsc%2F1/healthy")) {
          return Response.json({
            code: 0,
            msg: "success",
            data: {
              card_id: "hsc/1",
              prompt_tokens: 120,
              completion_tokens: 90,
              duration_seconds: 1,
            },
          });
        }
        throw new Error("unexpected request");
      },
    });

    await transport.draw({ task_id: "task-1", provider: "zai", model: "glm-5" });
    const healthy = await transport.healthy("hsc/1");

    expect(requests[0]?.headers.get("X-Bigmodel-Authorization")).toBe("maas-jwt");
    expect(requests[1]).toMatchObject({
      url: "https://example.test/api/v1/highspeed/hsc%2F1/healthy",
      method: "GET",
      body: undefined,
    });
    expect(requests[1]?.headers.get("Authorization")).toBe("Bearer zcode-jwt");
    expect(healthy).toEqual({
      cardId: "hsc/1",
      promptTokens: 120,
      completionTokens: 90,
      durationSeconds: 1,
    });
  });

  it("logs draw HTTP failures with safe request diagnostics", async () => {
    const warn = vi.fn();
    let requestHeaders = new Headers();
    const transport = createHighspeedHttpTransport({
      drawUrl: "https://example.test/api/v1/highspeed/draw?credential=secret",
      healthyBaseUrl: "https://example.test/api/v1/highspeed/",
      shareUrl: "https://example.test/api/v1/highspeed/share",
      drawHeaders: async () => ({
        Authorization: "Bearer must-not-be-logged",
        "X-Bigmodel-Authorization": "must-not-be-logged",
      }),
      healthyHeaders: async () => ({ Authorization: "Bearer must-not-be-logged" }),
      shareHeaders: async () => ({ Authorization: "Bearer must-not-be-logged" }),
      logger: { warn },
      fetchImpl: async (_input, init) => {
        requestHeaders = new Headers(init?.headers);
        return Response.json(
          { code: 4290, msg: "too many requests", token: "must-not-be-logged" },
          {
            status: 429,
            statusText: "Too Many Requests",
            headers: {
              "x-request-id": "req-highspeed-draw",
              "x-trace-id": "trace-highspeed-draw",
            },
          },
        );
      },
    });

    await expect(
      transport.draw({ task_id: "task-1", provider: "zai", model: "glm-5" }),
    ).rejects.toThrow("highspeed draw failed: 429");

    expect(requestHeaders.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(warn).toHaveBeenCalledWith(
      undefined,
      "Highspeed 接口 HTTP 请求失败",
      expect.objectContaining({
        operation: "draw",
        method: "POST",
        url: "https://example.test/api/v1/highspeed/draw",
        status: 429,
        statusText: "Too Many Requests",
        responseHeaders: {
          "x-request-id": "req-highspeed-draw",
          "x-trace-id": "trace-highspeed-draw",
        },
        response: { code: 4290, message: "too many requests", fields: ["code", "msg", "token"] },
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("must-not-be-logged");
  });

  /* share endpoint removed: sharing is now generated entirely in the UI. */
  /*
    const warn = vi.fn();
    const transport = createHighspeedHttpTransport({
      drawUrl: "https://example.test/api/v1/highspeed/draw",
      healthyBaseUrl: "https://example.test/api/v1/highspeed/",
      shareUrl: "https://example.test/api/v1/highspeed/share",
      drawHeaders: async () => ({ Authorization: "Bearer draw-secret" }),
      healthyHeaders: async () => ({ Authorization: "Bearer healthy-secret" }),
      shareHeaders: async () => ({ Authorization: "Bearer share-secret" }),
      logger: { warn },
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    });

    await expect(
      transport.share({
        card_id: "hsc-1",
        token_usage: 100,
        highspeed_tps: 90,
        regular_tps: 45,
      }),
    ).rejects.toThrow("fetch failed");

    expect(warn).toHaveBeenCalledWith(
      undefined,
      "Highspeed 接口网络请求失败",
      expect.objectContaining({
        operation: "share",
        method: "POST",
        url: "https://example.test/api/v1/highspeed/share",
        error: "fetch failed",
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("share-secret");
  }); */

  it("logs healthy HTTP failures without logging authorization", async () => {
    const warn = vi.fn();
    const transport = createHighspeedHttpTransport({
      drawUrl: "https://example.test/api/v1/highspeed/draw",
      healthyBaseUrl: "https://example.test/api/v1/highspeed/",
      shareUrl: "https://example.test/api/v1/highspeed/share",
      drawHeaders: async () => ({ Authorization: "Bearer draw-secret" }),
      healthyHeaders: async () => ({ Authorization: "Bearer healthy-secret" }),
      shareHeaders: async () => ({ Authorization: "Bearer share-secret" }),
      logger: { warn },
      fetchImpl: async () =>
        Response.json(
          { code: 3402, msg: "highspeed card is invalid" },
          { status: 404, statusText: "Not Found" },
        ),
    });

    await expect(transport.healthy("hsc/secret")).rejects.toThrow("highspeed healthy failed: 404");

    expect(warn).toHaveBeenCalledWith(
      undefined,
      "Highspeed 接口 HTTP 请求失败",
      expect.objectContaining({
        operation: "healthy",
        method: "GET",
        url: "https://example.test/api/v1/highspeed/hsc%2Fsecret/healthy",
        status: 404,
        statusText: "Not Found",
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("healthy-secret");
  });

  /*
  it("logs invalid share response schemas", async () => {
    const warn = vi.fn();
    const transport = createHighspeedHttpTransport({
      drawUrl: "https://example.test/api/v1/highspeed/draw",
      healthyBaseUrl: "https://example.test/api/v1/highspeed/",
      shareUrl: "https://example.test/api/v1/highspeed/share",
      drawHeaders: async () => ({}),
      healthyHeaders: async () => ({}),
      shareHeaders: async () => ({}),
      logger: { warn },
      fetchImpl: async () =>
        Response.json(
          { code: 0, msg: "success", data: { share_id: "hss-1" } },
          { headers: { "x-request-id": "req-highspeed-share" } },
        ),
    });

    await expect(
      transport.share({
        card_id: "hsc-1",
        token_usage: 100,
        highspeed_tps: 90,
        regular_tps: 45,
      }),
    ).rejects.toThrow();

    expect(warn).toHaveBeenCalledWith(
      undefined,
      "Highspeed 接口响应结构校验失败",
      expect.objectContaining({
        operation: "share",
        status: 200,
        responseHeaders: { "x-request-id": "req-highspeed-share" },
        response: { code: 0, message: "success", fields: ["code", "data", "msg"] },
      }),
    );
  }); */

  it("rejects and logs Highspeed business envelope failures with response request id", async () => {
    const warn = vi.fn();
    const transport = createHighspeedHttpTransport({
      drawUrl: "https://example.test/api/v1/highspeed/draw",
      healthyBaseUrl: "https://example.test/api/v1/highspeed/",
      shareUrl: "https://example.test/api/v1/highspeed/share",
      drawHeaders: async () => ({}),
      healthyHeaders: async () => ({}),
      shareHeaders: async () => ({}),
      logger: { warn },
      fetchImpl: async () =>
        Response.json(
          { ...cardResponse("task-1", 10_000), code: 2007, msg: "dependency failed" },
          { headers: { "x-request-id": "req-highspeed-business" } },
        ),
    });

    await expect(
      transport.draw({ task_id: "task-1", provider: "zai", model: "glm-5" }),
    ).rejects.toThrow("highspeed draw failed: business code 2007");

    expect(warn).toHaveBeenCalledWith(
      undefined,
      "Highspeed 接口业务失败",
      expect.objectContaining({
        operation: "draw",
        status: 200,
        responseHeaders: { "x-request-id": "req-highspeed-business" },
        response: expect.objectContaining({ code: 2007, message: "dependency failed" }),
      }),
    );
  });

  it("aborts a request that never returns so the in-flight draw can be released", async () => {
    // CR-01 回归：fetch 过去没有任何 deadline；代理/服务端接受连接后永不返回时 Promise 永久 pending。
    // 请求生命期必须有界且明确大于 1s 发送等待预算，超时后 abort → reject，让调用方的 finally 得以执行。
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      let observedSignal: AbortSignal | null | undefined;
      const transport = createHighspeedHttpTransport({
        drawUrl: "https://example.test/api/v1/highspeed/draw",
        healthyBaseUrl: "https://example.test/api/v1/highspeed/",
        drawHeaders: async () => ({}),
        healthyHeaders: async () => ({}),
        logger: { warn },
        fetchImpl: (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            observedSignal = init?.signal;
            // 只有 abort 能结束这个 Promise，模拟永不返回的连接。
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      });

      const draw = transport.draw({ task_id: "task-1", provider: "zai", model: "glm-5" });
      const settled = draw.then(
        () => "resolved",
        () => "rejected",
      );
      expect(HIGHSPEED_REQUEST_TIMEOUT_MS).toBeGreaterThan(1000);
      await vi.advanceTimersByTimeAsync(HIGHSPEED_REQUEST_TIMEOUT_MS - 1);
      expect(observedSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(observedSignal?.aborted).toBe(true);
      await expect(draw).rejects.toThrow(/timed out after 20000ms/);
      expect(await settled).toBe("rejected");
      expect(warn).toHaveBeenCalledWith(
        undefined,
        "Highspeed 接口网络请求失败",
        expect.objectContaining({ operation: "draw", method: "POST" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
