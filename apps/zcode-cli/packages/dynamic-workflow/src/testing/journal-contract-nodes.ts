/**
 * 修复原因：journal-contract.ts 顶到 oxlint max-lines 上限（400 行），把actor 记录与节点记录（ask / world / report 行、缺席键、messageBoundary 回填）的用例拆到本文件；
 * 公开面仍从 journal-contract.ts 导出（`runJournalStoreContract` 按原顺序调用各主题的注册函数）。
 *
 * 注意：这里只登记 `it(...)`，不另开 describe——套件的分组与用例顺序必须与拆分前逐字相同。
 */

import { expect, it } from "vitest";
import type { ActorRecord, JournalStorePort, NodeRecord } from "../engine/index.js";
import { baseRun } from "./journal-contract-helpers.js";

export function registerNodeCases(factory: () => JournalStorePort): void {
  it("puts, gets and lists actors keyed by (siteId, ordinal)", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.putActor({ runId: "r1", siteId: "actor#1", ordinal: 1, name: "planner" });
    store.putActor({ runId: "r1", siteId: "actor#1", ordinal: 2, name: "planner" });
    expect(store.getActor("r1", "actor#1", 1)?.name).toBe("planner");
    expect(store.getActor("r1", "actor#1", 3)).toBeUndefined();
    expect(store.listActors("r1", { withPersona: true })).toHaveLength(2);
    // 幂等覆盖：同键再写更新 sessionId。
    store.putActor({
      runId: "r1",
      siteId: "actor#1",
      ordinal: 1,
      name: "planner",
      sessionId: "s1",
    });
    expect(store.getActor("r1", "actor#1", 1)?.sessionId).toBe("s1");
    expect(store.listActors("r1", { withPersona: true })).toHaveLength(2);
  });

  it("round-trips the frozen persona and the driver-resolved model on an actor", () => {
    // persona 是冻结身份，resolvedModel 是宿主事实（子代理实际跑在哪个模型上）。两者分列存放：
    // persona 是引擎在 createActor 时同步写下的，那一刻宿主还没造出会话、也就没有模型可记。
    const store = factory();
    store.createRun(baseRun("r1"));
    const record: ActorRecord = {
      runId: "r1",
      siteId: "actor#1",
      ordinal: 1,
      name: "judge",
      persona: { name: "judge", system: "You judge." },
      sessionId: "s1",
      resolvedModel: "provider/small-model",
    };
    store.putActor(record);
    expect(store.getActor("r1", "actor#1", 1)).toEqual(record);
  });

  it("keeps an absent resolvedModel absent (not a null / undefined key)", () => {
    // 0021 之前的历史行与「宿主还没解析过」的行都走这条路径：缺席必须解成缺席的键，
    // 否则对整条记录做 toEqual 的调用方（与上一条用例）在升级后全线失败。
    const store = factory();
    store.createRun(baseRun("r1"));
    store.putActor({ runId: "r1", siteId: "actor#1", ordinal: 1, name: "judge" });
    const record = store.getActor("r1", "actor#1", 1)!;
    expect(record.resolvedModel).toBeUndefined();
    expect(record).toEqual({ runId: "r1", siteId: "actor#1", ordinal: 1, name: "judge" });
  });

  it("puts, gets and lists nodes", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const node: NodeRecord = {
      runId: "r1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: "abc",
      status: "completed",
      result: { ok: true },
    };
    store.putNode(node);
    expect(store.getNode("r1", "ask#1", 1)).toEqual(node);
    expect(store.getNode("r1", "ask#1", 2)).toBeUndefined();
    expect(store.listNodes("r1", { kinds: "all", withResult: true })).toHaveLength(1);
  });

  it("round-trips a world-read node's bounded input and keeps it absent elsewhere", () => {
    // 工作区 transcript 要说 *what ran*（docs/dynamic-workflow/transcript-and-notifications.md）：
    // `{op, args}` 与 inputHash 同一次准入写下，结算的整条替换必须原样带回；ask 行没有它，
    // 而且是**缺席的键**（不是 undefined 值），否则 toEqual 与读面的 `"input" in row` 都会说谎。
    const store = factory();
    store.createRun(baseRun("r1"));
    const node: NodeRecord = {
      runId: "r1",
      siteId: "world-read#1",
      ordinal: 1,
      kind: "world-run",
      inputHash: "wh",
      input: { op: "run", args: ["pnpm", ["vitest", "run"], { timeoutMs: 60_000 }] },
      status: "running",
    };
    store.putNode(node);
    expect(store.getNode("r1", "world-read#1", 1)).toEqual(node);
    const settled: NodeRecord = {
      ...node,
      status: "completed",
      result: { exitCode: 1, stdout: "", stderr: "boom" },
    };
    store.putNode(settled);
    expect(store.getNode("r1", "world-read#1", 1)).toEqual(settled);
    const truncated: NodeRecord = {
      ...node,
      siteId: "world-read#2",
      input: { op: "run", args: ["node", "-e …"], truncated: true },
    };
    store.putNode(truncated);
    expect(store.getNode("r1", "world-read#2", 1)?.input).toEqual(truncated.input);
    const ask = store.getNode("r1", "ask#1", 1);
    expect(ask === undefined || !("input" in ask)).toBe(true);
  });

  it("stores a report node: one write, already completed, no actor coordinates", () => {
    // report 节点是「准入 running → 结算」两次写规则唯一的例外（准入与结算之间没有 driver
    // 调用）。落库形状因此是可断言的：单次 putNode、status 恒 completed、actor 三列缺席、
    // result 即被报告的 item。两个实现都必须原样回读，否则 Results 面板与完成通知
    // 会显示存储层的加工品。
    const store = factory();
    store.createRun(baseRun("r1"));
    const report: NodeRecord = {
      runId: "r1",
      siteId: "report#1",
      ordinal: 2,
      kind: "report",
      inputHash: "rh",
      status: "completed",
      result: { finding: "duplicate impl", paths: ["a.ts", "b.ts"] },
    };
    store.putNode(report);

    const stored = store.getNode("r1", "report#1", 2);
    expect(stored).toEqual(report);
    expect(stored !== undefined && "actorSeq" in stored).toBe(false);
    expect(stored !== undefined && "actorSiteId" in stored).toBe(false);
    expect(
      store.listNodes("r1", { kinds: "all", withResult: true }).filter((n) => n.kind === "report"),
    ).toHaveLength(1);
  });

  it("keeps a null node result distinguishable from an absent one", () => {
    // result 的类型是 unknown：`ask<T | null>` 返回的 null 是真结果，不是"还没有结果"。
    // 落库实现若把 undefined 和 null 一起压成 SQL NULL，这个区别会在 round-trip 里消失。
    const store = factory();
    store.createRun(baseRun("r1"));
    const nulled: NodeRecord = {
      runId: "r1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      inputHash: "h",
      status: "completed",
      result: null,
    };
    const absent: NodeRecord = {
      runId: "r1",
      siteId: "ask#2",
      ordinal: 1,
      kind: "ask",
      inputHash: "h",
      status: "running",
    };
    store.putNode(nulled);
    store.putNode(absent);

    expect(store.getNode("r1", "ask#1", 1)).toEqual(nulled);
    const stored = store.getNode("r1", "ask#2", 1);
    expect(stored).toEqual(absent);
    // 缺席的可选字段要原样缺席地回来（而不是变成 result: null / result: undefined）。
    expect(stored !== undefined && "result" in stored).toBe(false);
  });

  // messageBoundary 是 ask 结算后 actor 会话消息 log 的长度（count offset），driver 在
  // settle 之后补写（docs/execution-engine.md「Amend-resume」）。属于契约：
  // 它是修订续跑做全保真转录截断时唯一的截断依据，SQLite 若漏写这一列，前驱就成了
  // 「无 marker 前驱」——整个 amend 被结构化拒绝。
  it("round-trips an ask node's messageBoundary and keeps it absent when unrecorded", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const bounded: NodeRecord = {
      runId: "r1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: "h1",
      status: "completed",
      result: "done",
      stats: { tokens: 120, toolCalls: 2, turns: 3 },
      messageBoundary: 9,
    };
    // 0 是合法边界（复制零条消息），必须与「没记过边界」可分辨——这正是缺席键语义
    // 在这一列上的实际用处。
    const zero: NodeRecord = {
      ...bounded,
      siteId: "ask#2",
      actorSeq: 1,
      inputHash: "h2",
      messageBoundary: 0,
    };
    const unrecorded: NodeRecord = {
      runId: "r1",
      siteId: "ask#3",
      ordinal: 1,
      kind: "ask",
      inputHash: "h3",
      status: "running",
    };
    store.putNode(bounded);
    store.putNode(zero);
    store.putNode(unrecorded);

    expect(store.getNode("r1", "ask#1", 1)).toEqual(bounded);
    expect(store.getNode("r1", "ask#2", 1)?.messageBoundary).toBe(0);
    const bare = store.getNode("r1", "ask#3", 1);
    expect(bare).toEqual(unrecorded);
    expect(bare !== undefined && "messageBoundary" in bare).toBe(false);
  });

  // driver 的补写形状：getNode 读回引擎刚落的结算行，原样铺开再补边界列。与 stats 回填
  // 同族，所以同一条风险——putNode 是整条替换，实现若在 round-trip 里丢掉任何一列
  // （result / stats / actor 三列 / inputHash），这次补写就会把它抹掉。
  it("preserves every other field when backfilling messageBoundary read-modify-write", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const settled: NodeRecord = {
      runId: "r1",
      siteId: "ask#1",
      ordinal: 2,
      kind: "ask",
      actorSiteId: "actor#3",
      actorOrdinal: 1,
      actorSeq: 4,
      inputHash: "abc",
      status: "completed",
      result: { verdict: "ship it", notes: [1, 2, 3] },
      stats: { tokens: 512, toolCalls: 7, turns: 5 },
    };
    store.putNode(settled);

    const recorded = store.getNode("r1", "ask#1", 2)!;
    store.putNode({ ...recorded, messageBoundary: 14 });

    expect(store.getNode("r1", "ask#1", 2)).toEqual({ ...settled, messageBoundary: 14 });
  });
}
