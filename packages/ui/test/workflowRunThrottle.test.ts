// dwf run 详情页的自适应并发观察面（docs/dynamic-workflow/concurrency.md「Protocol and UI」）：
// run 头的并发/冷却读数、事件日志的三条行、以及相位到图上四值的映射。
// 全部无 jsdom：这些是纯规则，时钟由参数注入。
import { describe, expect, it } from "vitest";
import type { WorkflowRunNode, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { workflowRunEventLines } from "@/app-shell/workflowRunPanel.js";
import {
  throttleReasonLabel,
  workflowRunConcurrencyChip,
  workflowRunConcurrencyView,
} from "@/app-shell/workflowRunThrottle.js";
import { statusOfRunNode } from "@/components/workflow-graph/run-status.js";

const format = (descriptor: { id: string }, values?: Record<string, string>) =>
  values ? `${descriptor.id}:${Object.values(values).join("/")}` : descriptor.id;

const T0 = 1_700_000_000_000;

function node(overrides: Partial<WorkflowRunNode> = {}): WorkflowRunNode {
  return {
    siteId: "ask#1",
    ordinal: 1,
    kind: "ask",
    phase: "executing",
    actorSiteId: "actor#1",
    actorOrdinal: 1,
    ...overrides,
  };
}

describe("原因标签（事件日志用）", () => {
  it("已知原因映射到短标签键，陌生原因原样显示", () => {
    expect(throttleReasonLabel("rate_limited", format)).toBe(
      "chat.toolCall.workflow.run.throttle.reason.rateLimited",
    );
    expect(throttleReasonLabel("provider_overloaded", format)).toBe(
      "chat.toolCall.workflow.run.throttle.reason.overloaded",
    );
    expect(throttleReasonLabel("offpeak_queued", format)).toBe(
      "chat.toolCall.workflow.run.throttle.reason.offpeak",
    );
    for (const reason of [
      "server_error",
      "network_error",
      "timeout",
      "stream_idle_timeout",
      "stale_connection",
    ]) {
      expect(throttleReasonLabel(reason, format)).toBe(
        "chat.toolCall.workflow.run.throttle.reason.transient",
      );
    }
    expect(throttleReasonLabel("something_new", format)).toBe("something_new");
  });
});

describe("workflowRunConcurrencyView：被压在自己的界之下，或有自己的界时在场", () => {
  it("跑在默认上 → undefined；被压下去 → cap/ceiling", () => {
    expect(workflowRunConcurrencyView({ cap: 14, ceiling: 14 }, T0)).toBeUndefined();
    expect(workflowRunConcurrencyView(undefined, T0)).toBeUndefined();
    expect(workflowRunConcurrencyView({ cap: 4, ceiling: 14 }, T0)).toEqual({
      cap: 4,
      ceiling: 14,
    });
  });

  // 两条界取小（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）：读数说的是这次 run
  // 此刻真能有几个子代理在飞，哪一条界在起作用不是它要回答的问题。
  it("有 limit 时显示两条界里小的那个", () => {
    expect(workflowRunConcurrencyView({ cap: 8, ceiling: 8, limit: 3 }, T0)).toEqual({
      cap: 3,
      ceiling: 8,
    });
    expect(workflowRunConcurrencyView({ cap: 2, ceiling: 8, limit: 3 }, T0)).toEqual({
      cap: 2,
      ceiling: 8,
    });
    // limit 缺席就是只有共享桶那一条界——与从前逐字相同。
    expect(workflowRunConcurrencyView({ cap: 8, ceiling: 8 }, T0)).toBeUndefined();
  });

  // `ceiling` 是默认并发 D，不是上限（docs/dynamic-workflow/concurrency.md「What the user sees」）：
  // 共享桶可以自动长到 2D，用户也可以把 run 调到 D 之上。
  it("默认 run 的共享 cap 长到 D 之上：读数是 min(cap, D) = D，没有可说的", () => {
    expect(workflowRunConcurrencyView({ cap: 12, ceiling: 8 }, T0)).toBeUndefined();
  });

  it("调到默认之上的 run：芯片恒在，读数是 min(cap, limit)", () => {
    expect(workflowRunConcurrencyView({ cap: 9, ceiling: 8, limit: 20 }, T0)).toEqual({
      cap: 9,
      ceiling: 8,
    });
    expect(workflowRunConcurrencyView({ cap: 24, ceiling: 8, limit: 20 }, T0)).toEqual({
      cap: 20,
      ceiling: 8,
    });
  });

  it("冷却按收到时刻推 deadline，过期即缺席", () => {
    const concurrency = { cap: 4, ceiling: 14, cooldownMs: 20_000 };
    expect(workflowRunConcurrencyView(concurrency, T0)).toEqual({
      cap: 4,
      ceiling: 14,
      cooldownUntil: T0 + 20_000,
    });
    expect(workflowRunConcurrencyView(concurrency, T0 + 10_000)?.cooldownUntil).toBe(T0 + 20_000);
    expect(workflowRunConcurrencyView(concurrency, T0 + 20_000)).toEqual({ cap: 4, ceiling: 14 });
  });
});

// 芯片在场 = 读数在场 ∧ run 能配置（docs/dynamic-workflow/concurrency.md「What the user sees」）。
// 芯片说的是一条界，界的控件是 Configure；控件走了芯片也走——完成的 run 上没有东西还在这条界下跑，
// 被替代的 run 的界归后继管，留一个数只会被读成一个过期的实时读数。
describe("workflowRunConcurrencyChip：与 Configure 同进同退", () => {
  function runWith(overrides: Partial<WorkflowRunState>): WorkflowRunState {
    return {
      runId: "run-a",
      toolCallId: "tool-a",
      status: "running",
      usage: { spentTokens: 0, nodesUsed: 0 },
      actors: [],
      nodes: [],
      lastEventSequence: 0,
      concurrency: { cap: 13, ceiling: 13, limit: 4 },
      ...overrides,
    };
  }

  it.each([
    ["running", runWith({ status: "running" })],
    ["pending", runWith({ status: "pending" })],
    ["stopped（可恢复，恢复后仍在这条界下跑）", runWith({ status: "stopped", stopReason: "user" })],
    ["errored（换设置重试的主场景）", runWith({ status: "errored" })],
  ])("%s 的 run 带着芯片", (_case, state) => {
    expect(workflowRunConcurrencyChip(state, T0)).toEqual({ cap: 4, ceiling: 13 });
  });

  it.each([
    ["completed", runWith({ status: "completed" })],
    [
      "superseded",
      runWith({ status: "stopped", stopReason: "superseded", supersededBy: "run-next" }),
    ],
  ])("%s 的 run 没有芯片，即便界仍在天花板之下", (_case, state) => {
    expect(workflowRunConcurrencyChip(state, T0)).toBeUndefined();
  });

  it("run 不在投影里、或跑在天花板上 → 没有芯片", () => {
    expect(workflowRunConcurrencyChip(undefined, T0)).toBeUndefined();
    expect(
      workflowRunConcurrencyChip(runWith({ concurrency: { cap: 13, ceiling: 13 } }), T0),
    ).toBeUndefined();
  });

  // 芯片的数是一条界，不是在跑的个数：字必须是界的字，两种语言都不能读成「此刻有几个」。
  it("两种语言都是「最大并发数 N」/「Max concurrency N」", () => {
    const key = "chat.toolCall.workflow.run.concurrency.label";
    expect((zhCN as Record<string, string>)[key]).toBe("最大并发数 {cap}");
    expect((enUS as Record<string, string>)[key]).toBe("Max concurrency {cap}");
  });
});

describe("相位 → 图上四值（决策 39）", () => {
  it("executing / repairing / nudged 是 running", () => {
    for (const phase of ["executing", "repairing", "nudged"] as const) {
      expect(statusOfRunNode(node({ phase }))).toBe("running");
    }
  });

  it("queued / dispatched / waiting 都是 pending：还没有请求在 provider 那里跑", () => {
    for (const phase of ["queued", "dispatched", "waiting"] as const) {
      expect(statusOfRunNode(node({ phase }))).toBe("pending");
    }
  });
});

describe("事件日志：三条自适应并发事件各有一行，其余仍走 unknown 兜底", () => {
  it("node-waiting(slot) / node-waiting(backoff) / node-executing / concurrency-changed", () => {
    const lines = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "node-waiting",
          payload: { instance: { siteId: "ask#1", ordinal: 1 }, cause: "slot" },
        },
        {
          sequence: 2,
          type: "node-waiting",
          payload: {
            instance: { siteId: "ask#1", ordinal: 1 },
            cause: "backoff",
            reason: "rate_limited",
            attempt: 2,
            delayMs: 20_500,
          },
        },
        {
          sequence: 3,
          type: "node-executing",
          payload: { instance: { siteId: "ask#1", ordinal: 1 } },
        },
        {
          sequence: 4,
          type: "concurrency-changed",
          payload: { key: "p/m", previous: 14, next: 7, reason: "rate_limited" },
        },
        { sequence: 5, type: "compaction", payload: { actor: { siteId: "a", ordinal: 1 } } },
      ],
      format,
    );
    expect(lines[0]).toMatchObject({
      label: "chat.toolCall.workflow.run.event.nodeWaitingSlot",
      detail: "ask#1@1",
      tone: "default",
    });
    expect(lines[1]).toMatchObject({
      label:
        "chat.toolCall.workflow.run.event.nodeWaitingBackoff:chat.toolCall.workflow.run.throttle.reason.rateLimited/21",
      detail: "ask#1@1",
      tone: "default",
    });
    expect(lines[2]).toMatchObject({
      label: "chat.toolCall.workflow.run.event.nodeExecuting",
      detail: "ask#1@1",
    });
    expect(lines[3]).toMatchObject({
      label: "chat.toolCall.workflow.run.event.concurrencyChanged:14/7",
      detail: "p/m",
    });
    expect(lines[4]?.label).toBe("chat.toolCall.workflow.run.event.unknown:compaction");
  });

  // run-caps-changed（docs/dynamic-workflow/concurrency.md）：只改 max_concurrency 的修订就地生效，
  // 引擎改完 caps 发这条。与 concurrency-changed 分两行说：那条是治理器压共享桶（「并发 13 → 9」），
  // 这条是用户改了这次 run 自己的上限。
  it("run-caps-changed 各有一行；caps 读不动时数字写「?」", () => {
    const lines = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "run-caps-changed",
          payload: {
            caps: { maxConcurrency: 2 },
            previous: { maxConcurrency: 8 },
            concurrencyCeiling: 8,
          },
        },
        { sequence: 2, type: "run-caps-changed", payload: { caps: "nope", previous: 8 } },
      ],
      format,
    );
    expect(lines[0]).toMatchObject({
      label: "chat.toolCall.workflow.run.event.runCapsChanged:8/2",
      tone: "default",
    });
    expect(lines[0]).not.toHaveProperty("detail");
    expect(lines[1]?.label).toBe("chat.toolCall.workflow.run.event.runCapsChanged:?/?");
  });

  it("两种语言各有一句：并发上限 8 → 2 / Concurrency limit 8 → 2", () => {
    expect(zhCN["chat.toolCall.workflow.run.event.runCapsChanged"]).toBe(
      "并发上限 {previous} → {next}",
    );
    expect(enUS["chat.toolCall.workflow.run.event.runCapsChanged"]).toBe(
      "Concurrency limit {previous} → {next}",
    );
  });

  it("node-waiting 缺 cause 时按 slot 处理（没有退避细节可说）", () => {
    const lines = workflowRunEventLines(
      [
        {
          sequence: 1,
          type: "node-waiting",
          payload: { instance: { siteId: "ask#1", ordinal: 1 } },
        },
      ],
      format,
    );
    expect(lines[0]?.label).toBe("chat.toolCall.workflow.run.event.nodeWaitingSlot");
  });
});
