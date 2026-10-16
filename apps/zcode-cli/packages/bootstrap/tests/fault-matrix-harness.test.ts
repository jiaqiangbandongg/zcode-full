// ============================================================
// 故障矩阵装配的自证（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Verification」）
// ============================================================
// 矩阵格本身住在 workflow-fault-matrix.*.test.ts；这里只钉三件事：
//   1. 八个脚本形状都能过真编译（形状表的 asks 计数与站点表一致）；
//   2. driver 级装配跑通 B1 healthy @ W2：completed，请求数 = 2 × (K + 1)，闸门与时钟都接上了；
//   3. run service 级装配跑通同一格：走真 submit / waitForTask，观察面同形。

import { describe, expect, it } from "vitest";
import { collectSites, createWorkflowProgram } from "@zcode/dynamic-workflow";
import { startFakeProviderServer } from "./helpers/fake-provider-server.js";
import { healthy } from "./helpers/fault-programs.js";
import {
  FAULT_CELL_TURNS,
  assertCommonInvariants,
  createFaultServiceHarness,
  pause,
  runFaultCell,
  statusCount,
} from "./helpers/fault-matrix.js";
import { FAULT_MATRIX_SHAPES, FAULT_MATRIX_SHAPE_IDS } from "./helpers/fault-matrix-scripts.js";

describe("fault matrix harness — 脚本形状", () => {
  it.each(FAULT_MATRIX_SHAPE_IDS)("%s 过真编译，ask 站点数与形状表一致", (shape) => {
    const spec = FAULT_MATRIX_SHAPES[shape];
    const program = createWorkflowProgram(spec.script);
    const table = collectSites(program);
    // 每个站点在脚本里只出现一次（map 回调里的 ask 是一个站点、多个实例），所以站点数
    // 与实例数不等；这里只钉「至少一个 ask 站点、且形状表的实例数 ≥ 站点数」。
    expect(table.asks.length).toBeGreaterThan(0);
    expect(spec.asks).toBeGreaterThanOrEqual(table.asks.length);
  });
});

describe("fault matrix harness — B1 healthy @ W2", () => {
  it(
    "driver 级：completed，请求数 = 逻辑请求数，闸门与时钟接上",
    async () => {
      const server = await startFakeProviderServer({ program: healthy() });
      try {
        const cell = await runFaultCell({
          server,
          shape: "W2",
          apiFormat: "anthropic-messages",
        });
        await pause(200);
        assertCommonInvariants(cell, { status: "completed", server });
        expect(cell.logicalRequests).toBe(2 * (FAULT_CELL_TURNS + 1));
        expect(server.requests.length).toBe(cell.logicalRequests);
        expect(statusCount(cell.statusEvents, "model_request_completed")).toBe(cell.logicalRequests);
        expect(statusCount(cell.statusEvents, "model_request_failed")).toBe(0);
        // 闸门真的在管事：governor 见过这个 key（桶已建）。
        expect(cell.governor.snapshot(cell.key)).toBeDefined();
        expect(cell.governor.snapshot(cell.key)?.inFlight).toBe(0);
      } finally {
        await server.close();
      }
    },
    30_000,
  );

  it(
    "run service 级：同一格走真 submit / waitForTask，观察面同形",
    async () => {
      const server = await startFakeProviderServer({ program: healthy() });
      const harness = createFaultServiceHarness({ server, apiFormat: "anthropic-messages" });
      try {
        const runId = await harness.submit("W2");
        const snapshot = await harness.settle(runId);
        await pause(200);
        expect(snapshot?.status).toBe("completed");
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
        expect(server.requests.length).toBe(2 * (FAULT_CELL_TURNS + 1));
        expect(harness.eventsOf(runId).some((event) => event.type === "run-settled")).toBe(true);
      } finally {
        await harness.dispose();
        await server.close();
      }
    },
    30_000,
  );
});
