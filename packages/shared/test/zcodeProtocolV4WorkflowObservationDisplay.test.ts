// GetWorkflowRun 工具卡载荷的**线上** schema（docs/dynamic-workflow/launch.md「Their cards」）。
//
// 这一侧与 CLI 的 getWorkflowRunToolResultDisplayPayloadSchema 是两份独立的 zod，却必须逐字段
// 同步：两侧都是 strict，少一个字段整条 display 校验失败、工具卡退化成纯文本；枚举多一个值，
// 手机远控的 bundle 会拒收整帧（2026-09-04 曾因此让一条订阅永久失效）。所以这里钉的是
// 「CLI 真的会发出来的那个形状，这一侧收得下」。

import { describe, expect, it } from "vitest";
// toolCall 与 toolOutput 两条 union 共用同一个成员 schema，所以从导出的那一条进就够了。
import { toolCallDisplaySchema } from "../src/zcode-protocol-v4/index.js";

/** CLI 侧 createGetWorkflowRunDisplay 在一个情势完整的 run 上会发出的载荷。 */
const CARD = {
  kind: "get_workflow_run" as const,
  runId: "dwfrun-7f3a",
  label: "nightly triage",
  status: "running" as const,
  summary:
    "Running for 5m 40s, in phase 2 of 4 (judge). 5 of 7 dispatched steps settled, 2 running.",
  generatedAt: 1_755_000_000_000,
  usage: {
    spentTokens: 18_420,
    nodesObserved: 7,
    nodesRunning: 2,
    nodesCompleted: 5,
    nodesFailed: 0,
  },
  phases: [
    {
      name: "collect",
      state: "done" as const,
      rounds: 1,
      nodesSettled: 2,
      nodesRunning: 0,
      enteredAt: 1,
      exitedAt: 2,
    },
    {
      name: "judge",
      state: "current" as const,
      rounds: 1,
      nodesSettled: 3,
      nodesRunning: 2,
      enteredAt: 2,
    },
  ],
  subagents: [
    {
      siteId: "agent#2",
      ordinal: 2,
      name: "judge",
      state: "executing" as const,
      phaseName: "judge",
      instructionsHead: "Judge specs 1-7 for flakiness",
      startedAt: 3,
      turn: 4,
      toolCalls: 7,
      lastTool: { name: "Read", target: "packages/net/retry.spec.ts", at: 4 },
      stepsSettled: 1,
      stepsFailed: 0,
      tokens: 5_100,
      lastProgressAt: 4,
    },
    {
      siteId: "agent#3",
      ordinal: 1,
      state: "waiting" as const,
      waitCause: "backoff" as const,
      retryAfterMs: 20_000,
      waitSince: 5,
      parkedOn: "q-01",
      stepsSettled: 1,
      stepsFailed: 0,
      tokens: 2_130,
    },
  ],
  health: {
    lastProgressAt: 6,
    stalledSince: 7,
    concurrency: { effective: 2, cap: 3, reason: "rate_limited", since: 8 },
    consecutiveFailures: 0,
    cachedSteps: 0,
    leftoverRunning: 2,
    pendingQuestionsKnown: false,
  },
  actors: [{ siteId: "agent#2", ordinal: 2, name: "judge" }],
  logTail: [{ sequence: 19, message: "judge#1 finished" }],
};

describe("v4 get_workflow_run display payload", () => {
  it("accepts the situation report the CLI sends", () => {
    expect(toolCallDisplaySchema.parse(CARD)).toEqual(CARD);
  });

  it("takes an absent phase table and an empty roster", () => {
    const { phases: _phases, ...withoutPhases } = CARD;
    expect(toolCallDisplaySchema.parse({ ...withoutPhases, subagents: [] })).toBeTruthy();
  });

  // 情势上线**之前**持久化的载荷：没有 summary / generatedAt / subagents / health。本 schema
  // 是 strict 的，把这五件设成必填等于让升级后打开的每一条历史会话里这张卡整块被剥、
  // 退化成纯文本——而 spec 承诺的文本兜底只针对完全没有载荷的行。
  it("still accepts a payload persisted before the situation report existed", () => {
    const legacy = {
      kind: "get_workflow_run" as const,
      runId: "dwfrun-old",
      label: "yesterday's run",
      status: "completed" as const,
      usage: {
        spentTokens: 10,
        nodesObserved: 2,
        nodesRunning: 0,
        nodesCompleted: 2,
        nodesFailed: 0,
      },
      actors: [{ siteId: "agent#1", ordinal: 1 }],
      logTail: [{ sequence: 1, message: "done" }],
      result: "shipped",
    };
    expect(toolCallDisplaySchema.parse(legacy)).toEqual(legacy);
  });

  // 日志行的落库时刻是可选键：新载荷带它（卡上据它算年龄），旧载荷没有它，两者都要过。
  it("takes a log entry with or without its journal time", () => {
    const withTime = {
      ...CARD,
      logTail: [{ sequence: 19, message: "judge#1 finished", at: 1_700_000_000_000 }],
    };
    expect(toolCallDisplaySchema.parse(withTime)).toEqual(withTime);
    expect(toolCallDisplaySchema.parse(CARD)).toEqual(CARD);
  });

  // 枚举闭集：一个未知的相位词会让这一侧拒收整帧，所以两侧的词表永远一起改。
  it("keeps the subagent state, phase state and wait cause closed", () => {
    for (const patch of [
      { subagents: [{ ...CARD.subagents[1], state: "thinking" }] },
      { subagents: [{ ...CARD.subagents[1], waitCause: "quota" }] },
      { phases: [{ ...CARD.phases[1], state: "skipped" }] },
    ]) {
      expect(toolCallDisplaySchema.safeParse({ ...CARD, ...patch }).success).toBe(false);
    }
  });

  it("stays strict about unknown keys inside the roster", () => {
    expect(
      toolCallDisplaySchema.safeParse({
        ...CARD,
        subagents: [{ ...CARD.subagents[1], persona: "you are…" }],
      }).success,
    ).toBe(false);
  });

  it("bounds the roster at 64 rows and the instructions head at 240 chars", () => {
    expect(
      toolCallDisplaySchema.safeParse({
        ...CARD,
        subagents: Array.from({ length: 65 }, () => CARD.subagents[1]),
      }).success,
    ).toBe(false);
    expect(
      toolCallDisplaySchema.safeParse({
        ...CARD,
        subagents: [{ ...CARD.subagents[0], instructionsHead: "x".repeat(241) }],
      }).success,
    ).toBe(false);
  });
});
