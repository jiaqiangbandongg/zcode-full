// ============================================================
// 故障矩阵 · 生命周期行（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md：B15–B19）
// ============================================================
// 这些行要的是 run service 的真实路径：Stop 集停下之后 `service.resume`（B15）、20 分钟无一次
// 成功的 stall 通知（B16）、退避中 `service.cancel`（B17）、在飞时宿主 `service.close()`（B18）、
// 在飞时别的进程写下终态行（B19）。装配是 createFaultServiceHarness：真
// createDynamicWorkflowRunService + 真 governor + 缩放时钟，assertCommonInvariants 从进度
// 载荷还原的 RunEvent 视图上断。

import { describe, expect, it } from "vitest";
import type { RunEvent } from "@zcode/dynamic-workflow";
import { startFakeProviderServer, type FaultProgram } from "./helpers/fake-provider-server.js";
import { AUTH_401, BUSY_3008, SERVE, always, healthy } from "./helpers/fault-programs.js";
import {
  FAULT_CELL_STALL_AFTER_MS,
  FAULT_CELL_TURNS,
  askNodes,
  assertCommonInvariants,
  createFaultServiceHarness,
  pause,
  statusCount,
  type FaultServiceHarness,
} from "./helpers/fault-matrix.js";
import {
  CELL_TIMEOUT_MS,
  POST_SETTLE_GRACE_MS,
  cellName,
  cells,
  type CellCoordinate,
} from "./helpers/fault-matrix-cells.js";
import { FAULT_MATRIX_SHAPES } from "./helpers/fault-matrix-scripts.js";

/** 轮询某个条件直到成立或超时。 */
async function waitFor(predicate: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(20);
  }
}

function settledEvents(harness: FaultServiceHarness, runId: string): Extract<RunEvent, { type: "run-settled" }>[] {
  return harness
    .eventsOf(runId)
    .filter((event): event is Extract<RunEvent, { type: "run-settled" }> => event.type === "run-settled");
}

// ————————————————————————————————————————————————————————————————
// B15：Stop 集停下 → 服务器翻转健康 → resume 完成
// ————————————————————————————————————————————————————————————————

describe("fault matrix · B15 flip — provider 停下后 resume 从断点续跑", () => {
  it.each(cells([{ shape: "W4" }], [{ shape: "S-phase" }]).map((cell) => [cellName(cell), cell] as const))(
    "%s：第一段 stopped(provider)；翻转后 resume 完成，已完结 ask 不再请求",
    async (_name, cell: CellCoordinate) => {
      // 先放行 K+1 个请求（恰好让一个子代理完整走完），之后一律 401：第一段停下时
      // journal 里既有已完结的 ask，也有被中止的。
      const turns = FAULT_CELL_TURNS;
      const firstSegment: FaultProgram = (request) =>
        request.ordinal <= turns + 1 ? SERVE : AUTH_401;
      const server = await startFakeProviderServer({ program: firstSegment });
      const harness = createFaultServiceHarness({
        server,
        apiFormat: cell.apiFormat ?? "anthropic-messages",
      });
      try {
        const runId = await harness.submit(cell.shape);
        const first = await harness.settle(runId);
        await pause(POST_SETTLE_GRACE_MS);
        expect(first?.runStatus).toBe("stopped");
        expect(first?.stopReason).toBe("provider");
        const settledAt = harness.settledAt(runId);
        expect(settledAt).toBeDefined();
        assertCommonInvariants(
          {
            runId,
            settlement: { status: "stopped", reason: "provider" },
            events: harness.eventsOf(runId),
            statusEvents: harness.statusEvents,
            journal: harness.journal,
            settledAt: settledAt!,
          },
          { status: "stopped", stopReason: "provider", server },
        );
        const completedBefore = askNodes(harness.journal, runId).filter(
          (node) => node.status === "completed",
        ).length;
        const requestsBefore = server.requests.length;
        const asks = FAULT_MATRIX_SHAPES[cell.shape].asks;
        expect(completedBefore).toBeGreaterThanOrEqual(0);
        expect(completedBefore).toBeLessThan(asks);

        // 翻转 → resume。
        server.setProgram(healthy());
        // resume 是端口上的可选能力；本装配的 service 恒有它，缺席即装配错了。
        const resume = harness.service.resume;
        expect(resume).toBeDefined();
        const resumed = await resume!(runId);
        expect(resumed).toMatchObject({ ok: true, runId });
        await waitFor(() => settledEvents(harness, runId).length >= 2, CELL_TIMEOUT_MS - 5_000, "second run-settled");
        await pause(POST_SETTLE_GRACE_MS);
        const second = await harness.service.getTask(runId);
        expect(second?.runStatus).toBe("completed");
        const settled = settledEvents(harness, runId);
        expect(settled).toHaveLength(2);
        expect(settled[1]).toMatchObject({ status: "completed" });

        // 第二段只重问未完结的 ask：已完结的从 journal 回放，一次请求都没有（决策 13）。
        const secondSegment = server.requests.length - requestsBefore;
        expect(secondSegment).toBe((asks - completedBefore) * (turns + 1));
        for (const node of askNodes(harness.journal, runId)) {
          expect(node.status).toBe("completed");
        }
        // 第二段零 provider 失败（第一段结算前后那几条 cancelled 是兄弟被 abort 的回声，不算）。
        const lateFailures = harness.statusEvents.filter(
          (event) =>
            event.type === "model_request_failed" &&
            event.reason !== "cancelled" &&
            Date.parse(event.timestamp) > settledAt!,
        );
        expect(lateFailures).toEqual([]);
      } finally {
        await harness.dispose();
        await server.close();
      }
    },
    CELL_TIMEOUT_MS,
  );
});

// ————————————————————————————————————————————————————————————————
// B16：stall——持续限流、无一次成功 → 恰好一条 run-stalled；翻转后完成
// ————————————————————————————————————————————————————————————————

describe("fault matrix · B16 stall — 无一次成功的重试段恰好通知一次", () => {
  it.each(cells([{ shape: "W4" }]).map((cell) => [cellName(cell), cell] as const))(
    "%s：一条 run-stalled（sinceMs ≥ 窗、reason rate_limited）；翻转后 completed 且不再 stall",
    async (_name, cell: CellCoordinate) => {
      const server = await startFakeProviderServer({ program: always(BUSY_3008) });
      const harness = createFaultServiceHarness({
        server,
        apiFormat: cell.apiFormat ?? "anthropic-messages",
      });
      try {
        const runId = await harness.submit(cell.shape);
        const stalled = () =>
          harness.eventsOf(runId).filter((event) => event.type === "run-stalled");
        await waitFor(() => stalled().length >= 1, 10_000, "run-stalled");
        // 再等一个窗：不能第二次通知（每个 stall 段一条）。
        await pause(FAULT_CELL_STALL_AFTER_MS + 100);
        expect(stalled()).toHaveLength(1);
        const info = stalled()[0] as Extract<RunEvent, { type: "run-stalled" }>;
        expect(info.reason).toBe("rate_limited");
        expect(info.cap).toBeDefined();
        // sinceMs 是 driver 时钟（虚拟毫秒）的量，≥ 虚拟窗；这里只钉「不小于配置的窗」。
        expect(info.sinceMs).toBeGreaterThan(0);
        // 从未成功过。
        expect(statusCount(harness.statusEvents, "model_request_completed")).toBe(0);
        expect(statusCount(harness.statusEvents, "model_retry_scheduled")).toBeGreaterThan(0);

        server.setProgram(healthy());
        const snapshot = await harness.settle(runId);
        await pause(POST_SETTLE_GRACE_MS);
        expect(snapshot?.runStatus).toBe("completed");
        expect(stalled()).toHaveLength(1);
        assertCommonInvariants(
          {
            runId,
            settlement: { status: "completed", artifact: undefined },
            events: harness.eventsOf(runId),
            statusEvents: harness.statusEvents,
            journal: harness.journal,
            settledAt: harness.settledAt(runId)!,
          },
          { status: "completed", server },
        );
      } finally {
        await harness.dispose();
        await server.close();
      }
    },
    CELL_TIMEOUT_MS,
  );
});

// ————————————————————————————————————————————————————————————————
// B17：退避中用户取消 → stopped(user)，立即结算，之后零请求
// ————————————————————————————————————————————————————————————————

describe("fault matrix · B17 cancel — 退避中取消立即停下", () => {
  it.each(cells([{ shape: "W8" }]).map((cell) => [cellName(cell), cell] as const))(
    "%s：stopped(user)，取消到结算 ≤ 1 s，结算后零请求",
    async (_name, cell: CellCoordinate) => {
      const server = await startFakeProviderServer({ program: always(BUSY_3008) });
      const harness = createFaultServiceHarness({
        server,
        apiFormat: cell.apiFormat ?? "anthropic-messages",
      });
      try {
        const runId = await harness.submit(cell.shape);
        await waitFor(
          () => statusCount(harness.statusEvents, "model_retry_scheduled") >= 1,
          10_000,
          "first retry_scheduled",
        );
        const cancelledAt = Date.now();
        expect(await harness.service.cancel(runId, "user")).toBe(true);
        const snapshot = await harness.settle(runId);
        const settledAt = harness.settledAt(runId);
        expect(settledAt).toBeDefined();
        expect(settledAt! - cancelledAt).toBeLessThanOrEqual(1_000);
        expect(snapshot?.runStatus).toBe("stopped");
        expect(snapshot?.stopReason).toBe("user");
        await pause(POST_SETTLE_GRACE_MS);
        assertCommonInvariants(
          {
            runId,
            settlement: { status: "stopped", reason: "user" },
            events: harness.eventsOf(runId),
            statusEvents: harness.statusEvents,
            journal: harness.journal,
            settledAt: settledAt!,
          },
          { status: "stopped", stopReason: "user", server },
        );
        expect(statusCount(harness.statusEvents, "model_request_completed")).toBe(0);
        // 退避定时器全部被撤：结算之后再等一段，仍然零请求。
        const after = server.requests.length;
        await pause(500);
        expect(server.requests.length).toBe(after);
      } finally {
        await harness.dispose();
        await server.close();
      }
    },
    CELL_TIMEOUT_MS,
  );
});

// ————————————————————————————————————————————————————————————————
// B18：在飞时宿主 close → stopped(interrupted)；关闭后零事件；新服务在同一份 journal 上 resume
// ————————————————————————————————————————————————————————————————

describe("fault matrix · B18 close — 宿主关闭停下自己拥有的 run，下一次激活可续跑", () => {
  it.each(cells([{ shape: "W4" }]).map((cell) => [cellName(cell), cell] as const))(
    "%s：stopped(interrupted) 在 close 解析前写完；之后零事件；同一份 journal 上 resume 完成",
    async (_name, cell: CellCoordinate) => {
      // 持续限流让 run 稳定地留在飞行中（同 B17），close 因此一定落在一个真活着的引擎上。
      const server = await startFakeProviderServer({ program: always(BUSY_3008) });
      const first = createFaultServiceHarness({
        server,
        apiFormat: cell.apiFormat ?? "anthropic-messages",
      });
      const journal = first.journal;
      let runId = "";
      try {
        runId = await first.submit(cell.shape);
        await waitFor(
          () => statusCount(first.statusEvents, "model_retry_scheduled") >= 1,
          10_000,
          "first retry_scheduled",
        );

        await first.service.close();

        // 1) close 解析时那一笔已经写完：引擎自己的 finishRun 尾巴，不是 service 补的。
        const snapshot = await first.service.getTask(runId);
        expect(snapshot?.runStatus).toBe("stopped");
        expect(snapshot?.stopReason).toBe("interrupted");
        expect(journal.getRun(runId)?.failure?.code).toBe("Interrupted");
        const settled = settledEvents(first, runId);
        expect(settled).toHaveLength(1);
        expect(settled[0]).toMatchObject({ status: "stopped", stopReason: "interrupted" });

        const settledAt = first.settledAt(runId);
        expect(settledAt).toBeDefined();
        assertCommonInvariants(
          {
            runId,
            settlement: { status: "stopped", reason: "interrupted" },
            events: first.eventsOf(runId),
            statusEvents: first.statusEvents,
            journal,
            settledAt: settledAt!,
          },
          { status: "stopped", stopReason: "interrupted", server },
        );

        // 2) 关闭之后零事件、零请求：退避定时器全被撤，没有落后的进度事件。
        const eventsAtClose = first.runEvents.length;
        const requestsAtClose = server.requests.length;
        await pause(POST_SETTLE_GRACE_MS);
        expect(first.runEvents.length).toBe(eventsAtClose);
        expect(server.requests.length).toBe(requestsAtClose);
        // 关闭之后的 launch 是接线错误，不是业务拒绝。
        await expect(first.service.resume!(runId)).rejects.toThrow(/service is closed/);
      } finally {
        await first.dispose();
      }

      // 3) 下一次激活：一台**新** service 在同一份 journal 上 resume，从断点跑完。
      server.setProgram(healthy());
      const second = createFaultServiceHarness({
        server,
        apiFormat: cell.apiFormat ?? "anthropic-messages",
        journal,
      });
      try {
        const resume = second.service.resume;
        expect(resume).toBeDefined();
        expect(await resume!(runId)).toMatchObject({ ok: true, runId });
        await waitFor(
          () => settledEvents(second, runId).length >= 1,
          CELL_TIMEOUT_MS - 5_000,
          "run-settled after resume",
        );
        await pause(POST_SETTLE_GRACE_MS);
        expect((await second.service.getTask(runId))?.runStatus).toBe("completed");
        // 续跑清掉了关闭留下的 Interrupted 残留：行不能既 completed 又带着失败。
        const record = journal.getRun(runId);
        expect(record?.status).toBe("completed");
        expect(record?.failure).toBeUndefined();
        expect(record?.stopReason).toBeUndefined();
        for (const node of askNodes(journal, runId)) {
          expect(node.status).toBe("completed");
        }
      } finally {
        await second.dispose();
        await server.close();
      }
    },
    CELL_TIMEOUT_MS,
  );
});

// ————————————————————————————————————————————————————————————————
// B19：活引擎下的外来终态行 → 不产生终态快照；真正的完成才算数，行不带陈旧失败
// ————————————————————————————————————————————————————————————————

describe("fault matrix · B19 foreign row — 别的进程写下的终态行压不过活着的引擎", () => {
  it.each(cells([{ shape: "W4" }]).map((cell) => [cellName(cell), cell] as const))(
    "%s：外来 stopped(interrupted) 不产生 run-settled；真正的 completed 才产生，且行不留失败",
    async (_name, cell: CellCoordinate) => {
      // 持续限流让 run 稳定地留在飞行中（同 B17 / B18），外来写入因此一定落在活引擎上。
      const server = await startFakeProviderServer({ program: always(BUSY_3008) });
      const harness = createFaultServiceHarness({
        server,
        apiFormat: cell.apiFormat ?? "anthropic-messages",
      });
      try {
        const runId = await harness.submit(cell.shape);
        await waitFor(
          () => statusCount(harness.statusEvents, "model_retry_scheduled") >= 1,
          10_000,
          "first retry_scheduled",
        );

        // 第二个实例的孤儿收敛：直接写 journal，本进程的注册表毫不知情。
        harness.journal.updateRunStatus(runId, "stopped", {
          stopReason: "interrupted",
          failure: { code: "Interrupted", message: "owning process exited" },
        });
        expect(harness.journal.getRun(runId)?.status).toBe("stopped");

        // 外来写入不是一次结算：它不经引擎，所以一条进度事件都不产生。
        await pause(POST_SETTLE_GRACE_MS);
        expect(settledEvents(harness, runId)).toHaveLength(0);
        expect(harness.settledAt(runId)).toBeUndefined();
        // 追踪器读到的仍然是「在跑」——正是这一点让它继续轮询而不是通知模型 run 已结束。
        expect((await harness.service.getTask(runId))?.status).toBe("running");

        // 引擎照常跑完，它自己的结算改写那一行。
        server.setProgram(healthy());
        const snapshot = await harness.settle(runId);
        await pause(POST_SETTLE_GRACE_MS);
        expect(snapshot?.runStatus).toBe("completed");
        const settled = settledEvents(harness, runId);
        expect(settled).toHaveLength(1);
        expect(settled[0]).toMatchObject({ status: "completed" });

        const record = harness.journal.getRun(runId);
        expect(record?.status).toBe("completed");
        // 陈旧失败不与产物并存（journal 契约的「clears a stale failure…」在真路径上的那一半）。
        expect(record?.failure).toBeUndefined();
        expect(record?.stopReason).toBeUndefined();

        const settledAt = harness.settledAt(runId);
        expect(settledAt).toBeDefined();
        assertCommonInvariants(
          {
            runId,
            settlement: { status: "completed", artifact: undefined },
            events: harness.eventsOf(runId),
            statusEvents: harness.statusEvents,
            journal: harness.journal,
            settledAt: settledAt!,
          },
          { status: "completed", server },
        );
      } finally {
        await harness.dispose();
        await server.close();
      }
    },
    CELL_TIMEOUT_MS,
  );
});
