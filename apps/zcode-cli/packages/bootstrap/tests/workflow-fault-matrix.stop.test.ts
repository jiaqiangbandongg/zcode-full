// ============================================================
// 故障矩阵 · Stop 集行（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md：B10–B13）
// ============================================================
// 这些行的共同预期是 **stopped(provider)**：确定性的模型侧错误让 run 像 cancel 一样停下、
// 兄弟子代理立即被 abort、结算带齐 `providerStop` 载荷（通知文案是它的纯函数）。
// 与 terminal-states 策略表的对应：auth / quota / model_unavailable / invalid_request。

import type { ModelNetworkStatusEvent } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import {
  startFakeProviderServer,
  type FakeProviderServer,
} from "./helpers/fake-provider-server.js";
import {
  AUTH_401,
  INVALID_REQUEST_3001,
  MODEL_NOT_FOUND_3006,
  QUOTA_1308,
  always,
  type StatusVerdict,
} from "./helpers/fault-programs.js";
import {
  FAULT_CELL_DEFAULT_CONCURRENCY,
  assertCommonInvariants,
  pause,
  runFaultCell,
  type FaultCellObservation,
} from "./helpers/fault-matrix.js";
import {
  CELL_TIMEOUT_MS,
  POST_SETTLE_GRACE_MS,
  cellName,
  cells,
  type CellCoordinate,
} from "./helpers/fault-matrix-cells.js";
import { FAULT_MODEL_ID, FAULT_PROVIDER_ID } from "./helpers/fault-provider-model.js";

/** 从第一条 Stop 集应答到 run 结算的上限：兄弟 abort 必须是立即的，不是等退避。 */
const STOP_LATENCY_MS = 2_000;

interface StopRow {
  id: string;
  title: string;
  verdict: StatusVerdict;
  kind: "auth" | "quota" | "model_unavailable" | "invalid_request";
  quick: CellCoordinate[];
  fullOnly: CellCoordinate[];
}

const STOP_ROWS: StopRow[] = [
  {
    id: "B10",
    title: "认证失效 401/1006",
    verdict: AUTH_401,
    kind: "auth",
    quick: [{ shape: "W4" }, { shape: "W4", apiFormat: "openai-chat-completions" }],
    fullOnly: [{ shape: "W16" }],
  },
  {
    id: "B11",
    title: "五小时用量上限 429/1308（带 Retry-After）",
    verdict: QUOTA_1308,
    kind: "quota",
    quick: [{ shape: "W4" }],
    fullOnly: [],
  },
  {
    id: "B12",
    title: "模型不在套餐里 404/3006",
    verdict: MODEL_NOT_FOUND_3006,
    kind: "model_unavailable",
    quick: [{ shape: "W4" }],
    fullOnly: [],
  },
  {
    id: "B13",
    title: "请求不合法 400/3001",
    verdict: INVALID_REQUEST_3001,
    kind: "invalid_request",
    quick: [{ shape: "W4" }],
    fullOnly: [],
  },
];

async function runCell(server: FakeProviderServer, cell: CellCoordinate): Promise<FaultCellObservation> {
  const observation = await runFaultCell({
    server,
    shape: cell.shape,
    apiFormat: cell.apiFormat ?? "anthropic-messages",
  });
  await pause(POST_SETTLE_GRACE_MS);
  return observation;
}

for (const row of STOP_ROWS) {
  describe(`fault matrix · ${row.id} always(${row.verdict.status}/${row.verdict.code}) — ${row.title}`, () => {
    it.each(cells(row.quick, row.fullOnly).map((cell) => [cellName(cell), cell] as const))(
      "%s：stopped(provider)，providerStop 载荷齐全，兄弟立即被 abort，停下后零请求",
      async (_name, cell) => {
        const server = await startFakeProviderServer({ program: always(row.verdict) });
        try {
          const obs = await runCell(server, cell);
          assertCommonInvariants(obs, { status: "stopped", stopReason: "provider", server });

          // 结算载荷：ProviderStop + 通知文案需要的每个字段。
          expect(obs.settlement.status).toBe("stopped");
          if (obs.settlement.status !== "stopped") return;
          expect(obs.settlement.error?.code).toBe("ProviderStop");
          const details = obs.settlement.error?.providerStop;
          expect(details).toBeDefined();
          expect(details?.kind).toBe(row.kind);
          expect(details?.providerId).toBe(FAULT_PROVIDER_ID);
          expect(details?.modelId).toBe(FAULT_MODEL_ID);
          expect(details?.providerCode).toBe(row.verdict.code);
          expect(details?.subagent).toMatch(/^actor#/u);
          expect(details?.subagentName).toBeTruthy();
          expect(details?.rawMessage).toContain(row.verdict.message);
          if (row.kind === "quota") {
            // Retry-After: 120 → resetAt ≈ 第一条 429 的到达时刻 + 120 s。
            const firstAt = server.requests[0]?.at ?? 0;
            expect(details?.resetAt).toBeDefined();
            expect(details!.resetAt! - firstAt).toBeGreaterThanOrEqual(110_000);
            expect(details!.resetAt! - firstAt).toBeLessThanOrEqual(130_000);
          } else {
            expect(details?.resetAt).toBeUndefined();
          }

          // journal 与事件流说同一件事。
          const run = obs.journal.getRun(obs.runId);
          expect(run?.status).toBe("stopped");
          expect(run?.stopReason).toBe("provider");
          expect(run?.failure?.code).toBe("ProviderStop");
          const settled = obs.events.filter((event) => event.type === "run-settled");
          expect(settled).toHaveLength(1);
          expect(settled[0]).toMatchObject({ status: "stopped", stopReason: "provider" });

          // 兄弟立即被 abort：Stop 集应答数 ≤ 当时的在飞上界（同时到达的那一批），
          // 而不是每个子代理各撞一次；从第一条到结算 ≤ STOP_LATENCY_MS。
          const stopResponses = server.requests.filter(
            (entry) => entry.verdict.kind === "status" && entry.servedStatus === row.verdict.status,
          );
          expect(stopResponses.length).toBeGreaterThan(0);
          expect(stopResponses.length).toBeLessThanOrEqual(FAULT_CELL_DEFAULT_CONCURRENCY);
          expect(obs.settledAt - stopResponses[0]!.at).toBeLessThanOrEqual(STOP_LATENCY_MS);
          // 没有一个逻辑请求成功过：Stop 集在第一次请求就停下。
          expect(server.requests.every((entry) => entry.verdict.kind === "status")).toBe(true);
          // 每条 Stop 集应答都作为不可重试失败报出，且没有 retry_scheduled；被 abort 的兄弟
          // 报 `reason:"cancelled"`（取消的回声，不带业务码）。
          const failed = obs.statusEvents.filter(
            (event): event is Extract<ModelNetworkStatusEvent, { type: "model_request_failed" }> =>
              event.type === "model_request_failed",
          );
          // 同一批在飞的兄弟可能已经拿到 Stop 集应答却在 abort 之后才被 runner 看到，那时它
          // 报的是 cancelled——所以带业务码的失败数 ≥ 1 且 ≤ Stop 集应答数，不必相等。
          const providerFailed = failed.filter((event) => event.reason !== "cancelled");
          expect(providerFailed.length).toBeGreaterThan(0);
          expect(providerFailed.length).toBeLessThanOrEqual(stopResponses.length);
          expect(failed.every((event) => event.retryable === false)).toBe(true);
          expect(providerFailed.every((event) => event.providerErrorCode === row.verdict.code)).toBe(
            true,
          );
          expect(obs.statusEvents.some((event) => event.type === "model_retry_scheduled")).toBe(
            false,
          );
          expect(obs.governor.snapshot(obs.key)?.inFlight ?? 0).toBe(0);
        } finally {
          await server.close();
        }
      },
      CELL_TIMEOUT_MS,
    );
  });
}
