import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OffPeakTaskRepo } from "../src/session/offPeakTaskRepo.js";
import { OffPeakTaskService } from "../src/session/offPeakTaskService.js";
import { createOffPeakServerClient } from "../src/session/offPeakServerClient.js";
import {
  startOffPeakMockGateway,
  type OffPeakMockGatewayHandle,
} from "../src/session/offPeakMockGateway.js";
import { setDataBaseDir } from "../src/paths.js";
import { createServiceLogger } from "../src/logger/serviceLogger.js";

// 端到端集成（mock 网关 + server client + 编排服务 + repo 全链路真跑）：
// 覆盖 OP01/OP02/OP07 的服务层机制——取号排队 → 轮询晋级 ready → 派发 running →
// 3h 到期 400/3102 续跑重取号 → 完成 → settle 核销。WDIO GUI E2E（OP01-OP06）另行。

const logger = createServiceLogger("off-peak-e2e", { isDebugEnabled: false });

describe("off-peak 端到端集成（进程内 mock 网关全链路）", () => {
  let tempDir: string | null = null;
  let repo: OffPeakTaskRepo;
  let gateway: OffPeakMockGatewayHandle;
  let service: OffPeakTaskService;
  let wakes: number;

  async function boot(gatewayOptions: Parameters<typeof startOffPeakMockGateway>[1]) {
    gateway = await startOffPeakMockGateway(
      // resolveUpstream 返回 null → 网关回固定响应，不需要真实模型 key。
      { logger, resolveUpstream: async () => null },
      { port: 0, nextPollS: 0, ...gatewayOptions },
    );
    const client = createOffPeakServerClient({
      resolveOrigin: () => gateway.origin,
      resolveCredentials: async () => ({
        jwt: "jwt",
        codingPlanApiKey: "cp",
        kind: "bigmodel-personal",
        providerFamily: "bigmodel",
        providerId: "account:bigmodel-individual-coding-plan",
        selectedConnectionKey: "coding-plan:account:bigmodel-individual-coding-plan",
      }),
      logger,
    });
    service = new OffPeakTaskService({
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
      resolveTelemetryProviderName: async () => "127.0.0.1",
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
    });
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-off-peak-e2e-"));
    setDataBaseDir(tempDir);
    repo = new OffPeakTaskRepo();
    wakes = 0;
  });

  afterEach(async () => {
    service?.stopSync();
    await gateway?.close();
    repo.close();
    setDataBaseDir(null);
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  const createParams = {
    title: "集成夜跑",
    prompt: "整理 TODO",
    permissionMode: "build",
    workspacePath: "/tmp/ws",
    modelSelection: { providerId: "account:zai-offpeak-idle-plan", modelId: "GLM-5.2" },
  };

  const createTask = async () => {
    const result = await service.createTask(createParams);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected integrated task creation");
    return result.task;
  };

  it("OP02 机制：取号→轮询晋级 ready→scheduler 认领→网关准入(固定响应)→settle", async () => {
    // readyDelayMs=0：取号即 ready（低峰空闲直接晋级），createTask 随建随派唤醒 scheduler。
    await boot({ readyDelayMs: 0, activeMs: 60_000 });
    const created = await createTask();
    expect(created.status).toBe("queued");
    expect(created.schedulable).toBe(true); // 取号即 ready
    expect(wakes).toBe(1);

    // scheduler 认领（schedulable=1 的 queued）
    const claimed = await repo.claimDue(Date.now());
    expect(claimed.map((t) => t.offPeakTaskId)).toEqual([created.offPeakTaskId]);

    // 派发准入：直接打网关 messages（模拟 idle plan provider 首个请求）
    const sendMessage = async (ticketId: string) =>
      fetch(`${gateway.origin}/api/v1/off-peak/anthropic/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-off-peak-ticket-id": ticketId },
        body: JSON.stringify({ model: "GLM-5.2", messages: [{ role: "user", content: "go" }] }),
      });
    const admitted = await sendMessage(created.serverTicketId!);
    expect(admitted.status).toBe(200);
    const body = (await admitted.json()) as { stop_reason: string };
    expect(body.stop_reason).toBe("end_turn"); // 固定响应，loop 立即收尾

    // host 侧 markRunning → markTerminal(completed)
    await repo.markRunning(created.offPeakTaskId, {
      startedAt: Date.now(),
      conversationId: "conv-1",
      sessionId: "sess-1",
    });
    await repo.markTerminal(created.offPeakTaskId, { status: "completed", endedAt: Date.now() });

    // settle 核销 outbox（服务周期捎带）
    await service.runSyncCycle();
    const settled = await repo.get(created.offPeakTaskId);
    expect(settled?.status).toBe("completed");
    expect(settled?.settledAt).toBeDefined();
  });

  it("OP07 机制：active 到期 400/3102 → 同 task_id 续跑重取号 → 新票再准入", async () => {
    // activeMs 极短：首个 message 准入后立即过期，下个 message 收 3102。
    await boot({ readyDelayMs: 0, activeMs: 20 });
    const created = await createTask();
    const firstTicket = created.serverTicketId!;

    const sendMessage = async (ticketId: string) =>
      fetch(`${gateway.origin}/api/v1/off-peak/anthropic/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-off-peak-ticket-id": ticketId },
        body: JSON.stringify({ messages: [] }),
      });
    expect((await sendMessage(firstTicket)).status).toBe(200); // 准入 active

    await repo.markRunning(created.offPeakTaskId, {
      startedAt: Date.now(),
      conversationId: "conv-1",
      sessionId: "sess-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 40)); // 超过 activeMs
    const expired = await sendMessage(firstTicket);
    expect(expired.status).toBe(400);
    expect(((await expired.json()) as { code: number }).code).toBe(3102);

    // host 识别 3102 → handleTicketExpiredDuringRun 回队重取号
    await service.handleTicketExpiredDuringRun(created.offPeakTaskId);
    const requeued = await repo.get(created.offPeakTaskId);
    expect(requeued?.status).toBe("queued");
    expect(requeued?.sessionId).toBe("sess-1"); // session 保留供 resume 续跑
    expect(requeued?.serverTicketId).not.toBe(firstTicket); // 新票

    // 新票再次准入
    const resumed = await sendMessage(requeued!.serverTicketId!);
    expect(resumed.status).toBe(200);
  });

  it("OP04 机制：queued Pause 停派发→ready 过期停在 paused→Continue 重取号回队", async () => {
    // readyDelayMs 稍长，取号后仍 queued，可 Pause；readyTtl 短，paused 期间票自然过期。
    await boot({ readyDelayMs: 30, readyTtlMs: 20, activeMs: 60_000 });
    const created = await createTask();
    expect(created.schedulable).toBe(false); // 取号时未晋级

    const paused = await service.pauseTask(created.offPeakTaskId);
    expect(paused?.status).toBe("paused");

    // paused 期间轮询：票晋级 ready（晋级点起算 readyTtl），paused 不自动重取号（D29-3）
    await new Promise((resolve) => setTimeout(resolve, 40));
    await service.runSyncCycle();
    // 再等超过 readyTtl，让已 ready 的票自然过期
    await new Promise((resolve) => setTimeout(resolve, 40));
    const stillPaused = await repo.get(created.offPeakTaskId);
    expect(stillPaused?.status).toBe("paused");

    // Continue：票已废 → 手动重取号回队尾
    const firstTicket = created.serverTicketId;
    await service.continueTask(created.offPeakTaskId);
    const continued = await repo.get(created.offPeakTaskId);
    expect(continued?.status).toBe("queued");
    expect(continued?.serverTicketId).not.toBe(firstTicket);
  });
});
