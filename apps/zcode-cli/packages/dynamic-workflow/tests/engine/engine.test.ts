import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  WorkflowError,
  inputHash,
  refToString,
  type AskSpec,
  type Caps,
  type InstanceRef,
  type NodeKind,
  type NodeRecord,
  type PersonaSpec,
  type RunEvent,
  type StoredEvent,
  type ValidateFn,
} from "../../src/engine/index.js";
import { FakeDriver, flush } from "./fake-driver.js";
import { REPORT_CAPS } from "../../src/facade/report-caps.js";
import { validate } from "../../src/schema/validate.js";
import type { JsonSchema } from "../../src/schema/types.js";

const RUN = "run";

function inst(siteId: string, ordinal = 1): InstanceRef {
  return { siteId, ordinal };
}

/** 一个基于 schema.required 的最小校验器（模拟真实 validator 的违规输出）。 */
const requireFields: ValidateFn = (schema, value) => {
  const required = (schema as { required?: string[] } | undefined)?.required ?? [];
  const obj = (value ?? {}) as Record<string, unknown>;
  return required
    .filter((k) => obj[k] === undefined)
    .map((k) => ({ path: k, expected: "present", got: "undefined" }));
};

interface SetupOpts {
  journal?: InMemoryJournalStore;
  caps?: Caps;
  askSpecs?: Map<string, AskSpec>;
  validate?: ValidateFn;
  deferSessions?: boolean;
  name?: string;
  scriptText?: string;
  scriptHash?: string;
  parentSessionId?: string;
  cwd?: string;
  toolCallId?: string;
  resumedFrom?: string;
  /** 模拟 driver 侧的模型档位解析（会话创建时把解析结果写进 actor 记录）。 */
  resolveModel?: (persona: { model?: string }) => string;
}

function setup(opts: SetupOpts = {}) {
  const journal = opts.journal ?? new InMemoryJournalStore();
  const driver = new FakeDriver(journal, {
    deferSessions: opts.deferSessions,
    ...(opts.resolveModel === undefined ? {} : { resolveModel: opts.resolveModel, runId: RUN }),
  });
  const engine = new WorkflowEngine({
    runId: RUN,
    driver,
    caps: opts.caps ?? { maxConcurrency: 16 },
    // askSpecs 必须覆盖脚本里的每个 ask 站点（miss 是硬错误），fixture 默认把本文件
    // 用到的两个站点显式记为 untyped。
    askSpecs: opts.askSpecs ?? untypedSpecs("ask#1", "ask#2"),
    validate: opts.validate ?? (() => []),
    ...(opts.name === undefined ? {} : { name: opts.name }),
    ...(opts.scriptText === undefined ? {} : { scriptText: opts.scriptText }),
    ...(opts.scriptHash === undefined ? {} : { scriptHash: opts.scriptHash }),
    ...(opts.parentSessionId === undefined ? {} : { parentSessionId: opts.parentSessionId }),
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    ...(opts.toolCallId === undefined ? {} : { toolCallId: opts.toolCallId }),
    ...(opts.resumedFrom === undefined ? {} : { resumedFrom: opts.resumedFrom }),
  });
  return { journal, driver, engine };
}

/** 把若干 ask 站点显式记为 untyped（引擎不再把缺席当 untyped）。 */
const untypedSpecs = (...siteIds: string[]): Map<string, AskSpec> =>
  new Map(siteIds.map((id) => [id, { typed: false } as AskSpec]));

const typedSpecs = () =>
  new Map<string, AskSpec>([["ask#1", { typed: true, schema: { required: ["x"] } }]]);

describe("WorkflowEngine — happy path", () => {
  it("dispatches, accepts a valid submit, and journals the node", async () => {
    const { engine, driver, journal } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1", "planner");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    expect(driver.startAskCount()).toBe(1);
    expect(driver.startAsks[0]?.message.typed).toBe(true);
    expect(driver.startAsks[0]?.message.schema).toEqual({ required: ["x"] });

    engine.askStats(inst("ask#1"), { tokens: 10, toolCalls: 1, turns: 1 });
    engine.askSubmitAttempted(inst("ask#1"), { x: 1 });

    expect(driver.submitResponses.at(-1)?.verdict.kind).toBe("accept");
    await expect(p).resolves.toEqual({ x: 1 });

    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.status).toBe("completed");
    expect(node?.actorSeq).toBe(0);
    expect(node?.inputHash).toBe(inputHash("do it"));
    expect(node?.result).toEqual({ x: 1 });
    expect(node?.stats?.tokens).toBe(10);
    expect(node?.actorSiteId).toBe("actor#1");

    engine.complete("final artifact");
    await expect(engine.settled).resolves.toEqual({
      status: "completed",
      artifact: "final artifact",
    });
    expect(engine.status()).toBe("completed");
  });
});

describe("WorkflowEngine — validation + repair", () => {
  it("rejects invalid submits and fails after the 3 repair attempts are exhausted", async () => {
    const { engine, driver, journal } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    // 4 次无效提交：前 3 次拒绝（repair），第 4 次预算耗尽 → 失败。
    for (let i = 0; i < 4; i++) engine.askSubmitAttempted(inst("ask#1"), {});

    const rejects = driver.submitResponses.filter((r) => r.verdict.kind === "reject");
    expect(rejects).toHaveLength(3);
    expect(driver.cancels).toContainEqual(inst("ask#1"));

    await expect(p).rejects.toMatchObject({ code: "ValidationFailed" });
    const err = await p.catch((e: unknown) => e as { violations?: unknown[] });
    expect(err.violations?.length).toBeGreaterThan(0);

    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.status).toBe("failed");
    expect(node?.error?.code).toBe("ValidationFailed");
  });

  it("repairs successfully within the attempt limit", async () => {
    const { engine, driver } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();
    engine.askSubmitAttempted(inst("ask#1"), {}); // reject
    engine.askSubmitAttempted(inst("ask#1"), { x: 7 }); // accept
    await expect(p).resolves.toEqual({ x: 7 });
    expect(driver.submitResponses.map((r) => r.verdict.kind)).toEqual(["reject", "accept"]);
  });
});

describe("WorkflowEngine — nudge policy", () => {
  it("nudges once when the turn ends without a submit, then accepts", async () => {
    const { engine, driver } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "not yet");
    expect(driver.submitResponses.at(-1)?.verdict.kind).toBe("nudge");
    engine.askSubmitAttempted(inst("ask#1"), { x: 1 });
    await expect(p).resolves.toEqual({ x: 1 });
  });

  it("fails with ResultNotSubmitted + final text when nudge is exhausted", async () => {
    const { engine, driver } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "text one"); // nudge
    engine.askTurnEnded(inst("ask#1"), "final words"); // exhausted → fail
    await expect(p).rejects.toMatchObject({ code: "ResultNotSubmitted", finalText: "final words" });
    expect(driver.cancels).toContainEqual(inst("ask#1"));
  });
});

describe("WorkflowEngine — untyped ask", () => {
  it("settles on turn end with the final text and offers no submit tool", async () => {
    const { engine, driver, journal } = setup(); // 站点显式记为 untyped
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "summarize");
    await flush();
    expect(driver.startAsks[0]?.message.typed).toBe(false);
    engine.askTurnEnded(inst("ask#1"), "the answer");
    await expect(p).resolves.toBe("the answer");
    expect(journal.getNode(RUN, "ask#1", 1)?.result).toBe("the answer");
  });
});

describe("WorkflowEngine — per-actor FIFO", () => {
  it("serializes concurrent asks on one actor and journals actorSeq in admission order", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");
    const p1 = engine.ask("ask#1", actor, "A");
    const p2 = engine.ask("ask#2", actor, "B");
    await flush();

    // 只有队首派发，第二个 ask 等待第一个结算。
    expect(driver.startAskCount()).toBe(1);
    expect(driver.startAsks[0]?.instance).toEqual(inst("ask#1"));

    engine.askTurnEnded(inst("ask#1"), "ra");
    await flush();
    expect(driver.startAskCount()).toBe(2);
    expect(driver.startAsks[1]?.instance).toEqual(inst("ask#2"));

    engine.askTurnEnded(inst("ask#2"), "rb");
    await expect(Promise.all([p1, p2])).resolves.toEqual(["ra", "rb"]);

    expect(journal.getNode(RUN, "ask#1", 1)?.actorSeq).toBe(0);
    expect(journal.getNode(RUN, "ask#2", 1)?.actorSeq).toBe(1);
  });
});

describe("WorkflowEngine — replay", () => {
  it("short-circuits journaled nodes with zero startAsk calls", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("do it"),
      status: "completed",
      result: { x: 42 },
    });

    const { engine, driver } = setup({ journal });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    expect(driver.startAskCount()).toBe(0);
    await expect(p).resolves.toEqual({ x: 42 });
  });

  it("fails the run loudly on an inputHash mismatch", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: "deadbeef", // 与重放时计算出的 hash 不符
      status: "completed",
      result: { x: 1 },
    });

    const { engine } = setup({ journal });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await expect(p).rejects.toMatchObject({ code: "InputHashMismatch" });
    await expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "InputHashMismatch" },
    });

    // 两个哈希结构化随错误走（与 ScriptHashMismatch 同一个 mismatch 字段）：一个只在
    // 两种哈希不匹配错误之一上出现的结构化字段，对读端就是个陷阱。
    const err = await p.catch((e: unknown) => e as WorkflowError);
    expect(err.mismatch).toEqual({ expected: "deadbeef", got: inputHash("do it") });
    // 落 journal 的可序列化形态同样带着它（failure_json 是 app 侧读的持久记录）。
    expect(err.toJSON()).toMatchObject({
      code: "InputHashMismatch",
      mismatch: { expected: "deadbeef", got: inputHash("do it") },
    });
    expect(journal.getRun(RUN)?.failure?.mismatch).toEqual({
      expected: "deadbeef",
      got: inputHash("do it"),
    });
  });

  it("enforces the recorded actorSeq via the hold rule when arrivals are scrambled", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    // 记录顺序：ask#1@1 = seq0，ask#2@1 = seq1。
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("A"),
      status: "completed",
      result: "r1",
    });
    journal.putNode({
      runId: RUN,
      siteId: "ask#2",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 1,
      inputHash: inputHash("B"),
      status: "completed",
      result: "r2",
    });

    const { engine, driver } = setup({ journal });
    const actor = engine.createActor("actor#1");
    // 到达顺序与记录相反：先 ask#2（seq1，应被 hold），后 ask#1（seq0，触发释放）。
    const pB = engine.ask("ask#2", actor, "B");
    const pA = engine.ask("ask#1", actor, "A");
    await expect(Promise.all([pA, pB])).resolves.toEqual(["r1", "r2"]);

    // 释放顺序遵循记录的 actorSeq，而非到达顺序。
    expect(driver.cachedSettleOrder()).toEqual(["ask#1@1", "ask#2@1"]);
    expect(driver.startAskCount()).toBe(0);
  });

  it("turns the same-site nondeterministic-ordinal gap into a loud inputHash failure (not wrong results)", async () => {
    // v1 局限的设计后盾：同站点、被非确定前驱门控的 ask，其 ordinal 依到达顺序而非确定。
    // journal 记录了 ask#1@1=「plan A」、ask#1@2=「plan B」；replay 若把两者次序调换，
    // 第一个到达者拿到 ordinal 1 却带「plan B」→ 与记录的 hash 不符 → run 大声失败，绝不给出错误结果。
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("plan A"),
      status: "completed",
      result: "A",
    });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 2,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 1,
      inputHash: inputHash("plan B"),
      status: "completed",
      result: "B",
    });

    const { engine } = setup({ journal });
    const actor = engine.createActor("actor#1");
    const pB = engine.ask("ask#1", actor, "plan B"); // 得到 ordinal 1，但记录的是 plan A → mismatch
    await expect(pB).rejects.toMatchObject({ code: "InputHashMismatch" });
    await expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "InputHashMismatch" },
    });
  });
});

describe("WorkflowEngine — mid-run crash + resume", () => {
  it("resumes over the same journal, short-circuiting finished nodes and finishing the rest", async () => {
    const journal = new InMemoryJournalStore();

    // run1：结算 ask#1，随后"崩溃"（ask#2 未执行）。
    {
      const driver1 = new FakeDriver(journal);
      const e1 = new WorkflowEngine({
        runId: RUN,
        driver: driver1,
        caps: { maxConcurrency: 16 },
        askSpecs: untypedSpecs("ask#1", "ask#2"),
        validate: () => [],
      });
      const a = e1.createActor("actor#1");
      const p1 = e1.ask("ask#1", a, "A");
      await flush();
      e1.askTurnEnded(inst("ask#1"), "RA");
      await expect(p1).resolves.toBe("RA");
    }

    // run2：同一 journal 上重放。
    const driver2 = new FakeDriver(journal);
    const e2 = new WorkflowEngine({
      runId: RUN,
      driver: driver2,
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1", "ask#2"),
      validate: () => [],
    });
    const a2 = e2.createActor("actor#1");

    const r1 = await e2.ask("ask#1", a2, "A"); // journal 命中
    expect(r1).toBe("RA");
    expect(driver2.startAskCount(inst("ask#1"))).toBe(0); // 未重新执行

    const p2 = e2.ask("ask#2", a2, "B"); // 新节点，实际派发
    await flush();
    expect(driver2.startAskCount(inst("ask#2"))).toBe(1);
    e2.askTurnEnded(inst("ask#2"), "RB");
    await expect(p2).resolves.toBe("RB");

    e2.complete("done");
    await expect(e2.settled).resolves.toMatchObject({ status: "completed", artifact: "done" });
  });

  it("re-dispatches a crash-mid-flight node (status running) live, enforcing its recorded actorSeq", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    // ask#1 已完结（seq0），ask#2 崩溃于执行中（seq1, status running）。
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("A"),
      status: "completed",
      result: "RA",
    });
    journal.putNode({
      runId: RUN,
      siteId: "ask#2",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 1,
      inputHash: inputHash("B"),
      status: "running",
    });

    const { engine, journal: j, driver } = setup({ journal });
    const actor = engine.createActor("actor#1");
    const p1 = engine.ask("ask#1", actor, "A"); // 完结命中，短路
    const p2 = engine.ask("ask#2", actor, "B"); // running → 重新 live 派发
    await flush();

    expect(await p1).toBe("RA");
    expect(driver.startAskCount(inst("ask#1"))).toBe(0); // 完结节点未重跑
    expect(driver.startAskCount(inst("ask#2"))).toBe(1); // running 节点重新 live 执行

    engine.askTurnEnded(inst("ask#2"), "RB");
    expect(await p2).toBe("RB");
    // running 记录被更新为 completed，且 actorSeq 保持记录值。
    expect(j.getNode(RUN, "ask#2", 1)?.status).toBe("completed");
    expect(j.getNode(RUN, "ask#2", 1)?.actorSeq).toBe(1);
  });

  it("re-creates the actor session via the driver even when the journal records a sessionId", async () => {
    // Bug 根因（resume 重派发在生产 driver 上必炸）：registerActor 原先把 journal 里记录的
    // sessionId 预解析成 actor.sessionPromise，让 ensureSession 跳过 driver.createActorSession；
    // 而生产 driver 的 sessions map **只**在 createActorSession 里填充，startAsk 按 map 查会话
    // → 每个重新派发的 ask 都以 DriverError「未知会话」立即失败。纯 replay（零派发）与
    // fake driver（startAsk 不查 map）都测不出它，所以这里直接钉 createActorSession 的调用次数。
    // 会话身份是 driver 所有的（生产铸造函数按 (runId, actorRef) 纯确定），journal 值只是记录。
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1, sessionId: "session:actor#1@1" });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("A"),
      status: "running",
    });

    const { engine, journal: j, driver } = setup({ journal });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();

    // 关键断言：会话经 driver 重建（恰好一次），且派发用的是 driver 造出的会话。
    expect(driver.sessionCreations).toEqual([{ siteId: "actor#1", ordinal: 1 }]);
    expect(driver.startAskCount(inst("ask#1"))).toBe(1);
    expect(driver.startAsks[0]?.session.id).toBe("session:actor#1@1");

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
    // ensureSession 的 putActor 把（生产上必然相同的）sessionId 重新记录回去。
    expect(j.getActor(RUN, "actor#1", 1)?.sessionId).toBe("session:actor#1@1");
  });

  it("restores the tokens already spent by the crashed run instead of starting from zero", async () => {
    // 回归：用量原先只在 createRun(0) 落库一次，askStats 的累加从不回写，
    // 于是 resume 出来的引擎从零开始计数，run 级用量跨生命周期不连续。
    const caps: Caps = { maxConcurrency: 16 };
    const journal = new InMemoryJournalStore();

    {
      const e1 = new WorkflowEngine({
        runId: RUN,
        driver: new FakeDriver(journal),
        caps,
        askSpecs: untypedSpecs("ask#1", "ask#2"),
        validate: () => [],
      });
      const a = e1.createActor("actor#1");
      const p = e1.ask("ask#1", a, "A");
      await flush();
      e1.askStats(inst("ask#1"), { tokens: 300, toolCalls: 1, turns: 1 });
      e1.askTurnEnded(inst("ask#1"), "RA");
      await expect(p).resolves.toBe("RA");
    }

    expect(journal.getRun(RUN)?.spentTokens).toBe(300);

    const driver2 = new FakeDriver(journal);
    const e2 = new WorkflowEngine({
      runId: RUN,
      driver: driver2,
      caps,
      askSpecs: untypedSpecs("ask#1", "ask#2"),
      validate: () => [],
    });
    const b = e2.createActor("actor#2");
    void e2.ask("ask#2", b, "B").catch(() => {});
    await flush();
    e2.askStats(inst("ask#2"), { tokens: 100, toolCalls: 0, turns: 1 });
    // 事件载荷与列值在同一同步步骤产生：resume 后继续累计，而不是从 0 重来。
    expect(driver2.events.at(-1)).toEqual({ type: "usage-updated", spentTokens: 400 });
    expect(journal.getRun(RUN)?.spentTokens).toBe(400);
  });
});

describe("WorkflowEngine — cancellation", () => {
  it("cancels in-flight asks, settles cancelled, and keeps finished journal entries", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");

    const pDone = engine.ask("ask#1", actor, "A");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "RA"); // 结算完成，落 journal
    await expect(pDone).resolves.toBe("RA");

    const pInFlight = engine.ask("ask#2", actor, "B");
    await flush();
    expect(driver.startAskCount(inst("ask#2"))).toBe(1);

    engine.stop("user");
    expect(driver.cancels).toContainEqual(inst("ask#2"));
    await expect(pInFlight).rejects.toMatchObject({ code: "Cancelled" });
    await expect(engine.settled).resolves.toEqual({ status: "stopped", reason: "user" });
    expect(journal.getRun(RUN)).toMatchObject({ status: "stopped", stopReason: "user" });
    expect(driver.events.at(-1)).toEqual({
      type: "run-settled",
      status: "stopped",
      stopReason: "user",
    });

    // 完结节点保留为 completed；在飞节点停在准入时的 running 记录（非"完结"结果），resume 可据此重跑。
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("completed");
    expect(journal.getNode(RUN, "ask#2", 1)?.status).toBe("running");
  });
});

describe("WorkflowEngine — complete() with in-flight asks", () => {
  // 脚本可以在 ask 仍在飞时返回（Promise.race 的输家、没有 await 的 ask）。complete 对它们的处置
  // 必须与 cancel 逐字节同形，否则 scheduler 永远握着节点、driver 侧 turn 继续烧 token、事件
  // 日志里一个 node-dispatched 永远等不到 node-settled。见 docs/execution-engine.md。
  it("aborts the in-flight ask like stop() does, then settles completed with the artifact", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");

    const pDone = engine.ask("ask#1", actor, "A");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(pDone).resolves.toBe("RA");

    const pInFlight = engine.ask("ask#2", actor, "B");
    await flush();
    expect(driver.startAskCount(inst("ask#2"))).toBe(1);

    engine.complete("done");
    expect(driver.cancels).toContainEqual(inst("ask#2"));
    await expect(pInFlight).rejects.toMatchObject({ code: "Cancelled" });
    await expect(engine.settled).resolves.toEqual({ status: "completed", artifact: "done" });
    expect(engine.status()).toBe("completed");

    // 事件序列：在飞节点先 cancelled，再 run-settled(completed)。
    const types = driver.events.map((e) => e.type);
    const settledIdx = types.lastIndexOf("node-settled");
    const runIdx = types.lastIndexOf("run-settled");
    expect(driver.events[settledIdx]).toMatchObject({
      instance: inst("ask#2"),
      outcome: "cancelled",
    });
    expect(driver.events[runIdx]).toMatchObject({ status: "completed" });
    expect(settledIdx).toBeLessThan(runIdx);

    // journal 与 cancel 路径同形：完结节点 completed，在飞节点停在 running；run 带产物 completed。
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("completed");
    expect(journal.getNode(RUN, "ask#2", 1)?.status).toBe("running");
    expect(journal.getRun(RUN)?.status).toBe("completed");
    expect(journal.getRun(RUN)?.result).toBe("done");
  });

  it("does nothing extra when no ask is in flight (byte-for-byte the plain complete)", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");

    engine.complete("done");
    expect(driver.cancels).toEqual([]);
    expect(driver.eventsOfType("node-settled").map((e) => e.outcome)).toEqual(["ok"]);
    await expect(engine.settled).resolves.toEqual({ status: "completed", artifact: "done" });
  });

  it("persists straggler stats after complete() to the usage row without emitting events", async () => {
    const { engine, driver, journal } = setup();
    const winner = engine.createActor("actor#1");
    const loser = engine.createActor("actor#2");
    const pWin = engine.ask("ask#1", winner, "fast");
    void engine.ask("ask#2", loser, "slow").catch(() => {});
    await flush();
    engine.askTurnEnded(inst("ask#1"), "won");
    await expect(pWin).resolves.toBe("won");
    engine.complete("won");

    const eventCount = driver.events.length;
    // 真实 actor 的用量在 turn 解析后才知道：最后的 stats 常晚于 complete 到达。
    // 记账要保留（用量行 + 节点回填都是 journal 行更新），事件流不能再追加——run-settled 是最后一条。
    engine.askStats(inst("ask#2"), { tokens: 7, toolCalls: 0, turns: 1 });
    expect(driver.events.length).toBe(eventCount);
    expect(journal.getRun(RUN)?.spentTokens).toBe(7);
    expect(journal.getNode(RUN, "ask#2", 1)?.stats).toEqual({ tokens: 7, toolCalls: 0, turns: 1 });
  });
});

describe("WorkflowEngine — driver dispose at settlement", () => {
  // 引擎契约：三条终态路径各调 driver.dispose 恰好一次，晚于 run-settled；first-wins 下不重复。
  async function withInFlightAsk() {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    void p.catch(() => {});
    await flush();
    expect(driver.disposeCalls).toBe(0);
    return { engine, driver };
  }

  function expectDisposedOnceAfterRunSettled(driver: FakeDriver): void {
    expect(driver.disposeCalls).toBe(1);
    const runSettledIdx = driver.events.findIndex((e) => e.type === "run-settled");
    expect(runSettledIdx).toBeGreaterThanOrEqual(0);
    expect(driver.eventsAtDispose).toBe(runSettledIdx + 1);
  }

  it("complete(): once, after run-settled, and not again on a later stop()/fail()", async () => {
    const { engine, driver } = await withInFlightAsk();
    engine.complete("done");
    expectDisposedOnceAfterRunSettled(driver);
    engine.stop("user");
    engine.fail(new WorkflowError("DriverError", "late"));
    expect(driver.disposeCalls).toBe(1);
  });

  it("stop(): once, after run-settled", async () => {
    const { engine, driver } = await withInFlightAsk();
    engine.stop("user");
    expectDisposedOnceAfterRunSettled(driver);
    engine.complete("late");
    expect(driver.disposeCalls).toBe(1);
  });

  it("fail(): once, after run-settled", async () => {
    const { engine, driver } = await withInFlightAsk();
    engine.fail(new WorkflowError("DriverError", "boom"));
    expectDisposedOnceAfterRunSettled(driver);
    expect(driver.disposeCalls).toBe(1);
  });

  it("a driver without dispose is fine (the hook is optional)", async () => {
    const journal = new InMemoryJournalStore();
    const driver = new FakeDriver(journal);
    (driver as { dispose?: () => void }).dispose = undefined;
    const engine = new WorkflowEngine({
      runId: RUN,
      driver,
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
    });
    engine.complete("done");
    await expect(engine.settled).resolves.toEqual({ status: "completed", artifact: "done" });
  });
});

describe("WorkflowEngine — usage (no caps)", () => {
  it("never caps the node count: well past the old limit of 100 the run is still running", async () => {
    // docs/dynamic-workflow/authoring.md：节点上限整体移除，取消是唯一的停止手段。
    const { engine, driver, journal } = setup({ caps: { maxConcurrency: 200 } });
    for (let i = 1; i <= 120; i++) {
      const actor = engine.createActor(`actor#${i}`);
      void engine.ask("ask#1", actor, `job ${i}`).catch(() => {});
    }
    await flush();

    expect(journal.getRun(RUN)?.status).toBe("running");
    expect(driver.events.filter((e) => e.type === "node-dispatched")).toHaveLength(120);
    engine.stop("user");
  });

  it("emits usage-updated with the accumulated spentTokens and never fails the run on usage", async () => {
    const { engine, driver, journal } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "do it").catch(() => {});
    await flush();

    engine.askStats(inst("ask#1"), { tokens: 30, toolCalls: 0, turns: 1 });
    expect(driver.events.at(-1)).toEqual({ type: "usage-updated", spentTokens: 30 });
    expect(journal.getRun(RUN)?.spentTokens).toBe(30);

    engine.askStats(inst("ask#1"), { tokens: 80, toolCalls: 0, turns: 1 });
    expect(driver.events.at(-1)).toEqual({ type: "usage-updated", spentTokens: 110 });
    expect(journal.getRun(RUN)?.spentTokens).toBe(110);
    expect(journal.getRun(RUN)?.status).toBe("running");
    engine.stop("user");
  });
});

describe("WorkflowEngine — fail() (harness-driven run failure)", () => {
  it("settles failed, cancels in-flight asks, records failure_json, and is first-wins", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    void p.catch(() => {}); // run 失败会 reject 该 ask
    await flush();
    expect(driver.startAskCount(inst("ask#1"))).toBe(1);

    // harness 把子进程抛出/崩溃/超时归为 run 失败。
    const boom = new WorkflowError("DriverError", "child crashed");
    engine.fail(boom);

    expect(driver.cancels).toContainEqual(inst("ask#1")); // 在飞 ask driver 侧取消
    await expect(p).rejects.toBe(boom); // 在飞 ask 以 run 错误 reject
    await expect(engine.settled).resolves.toEqual({ status: "errored", error: boom });
    expect(engine.status()).toBe("errored");

    const run = journal.getRun(RUN);
    expect(run?.status).toBe("errored");
    expect(run?.failure).toEqual({ code: "DriverError", message: "child crashed" });
    expect(run?.stopReason).toBeUndefined();

    // first-wins：后续 complete()/再次 fail()/stop() 均为 no-op。
    engine.complete("late");
    engine.fail(new WorkflowError("Cancelled", "ignored"));
    engine.stop("interrupted", new WorkflowError("Interrupted", "late"));
    await expect(engine.settled).resolves.toEqual({ status: "errored", error: boom });
  });

  it("createActorSession rejection surfaces the cause text in the DriverError (journal + reject)", async () => {
    // 2026-09-03 实机：直接启动的首个 actor 在建 session_task_link 时撞 FOREIGN KEY，run 只留下
    // 「创建 actor 会话失败」——cause 不进 toJSON、也无人记日志，无从诊断。这里钉住 message 必须
    // 带上 cause 的文本。
    const { engine, journal, driver } = setup({ deferSessions: true });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    driver.sessionDeferrals[0]!.reject(new Error("FOREIGN KEY constraint failed"));
    // 钉的是 cause 文本（可变部分）在场，不钉整句措辞。
    await expect(p).rejects.toMatchObject({
      code: "DriverError",
      message: expect.stringContaining("FOREIGN KEY constraint failed"),
    });
    expect(journal.getNode(RUN, "ask#1", 1)?.error).toMatchObject({
      code: "DriverError",
      message: expect.stringContaining("FOREIGN KEY constraint failed"),
    });
  });

  it("complete() first wins over a later fail()", async () => {
    const { engine } = setup();
    engine.complete("ok");
    engine.fail(new WorkflowError("DriverError", "too late"));
    await expect(engine.settled).resolves.toEqual({ status: "completed", artifact: "ok" });
  });

  it("createActor throws synchronously once the run has failed (harness can catch → fail())", async () => {
    const { engine } = setup();
    engine.fail(new WorkflowError("DriverError", "boom"));
    // 同步抛出（无 async 泄漏），harness 的 try/catch 能直接兜住并转成 fail()。
    expect(() => engine.createActor("actor#1")).toThrow();
  });
});

describe("WorkflowEngine — stats backfill after settle", () => {
  it("backfills stats onto a typed ask journaled at settle when askStats arrives after the submit", async () => {
    // typed-accept 路径（主导路径）：submit 停 turn 并在 settle 时落库；真实 actor 的用量在
    // turn 解析后（submit 之后）才知道，故 askStats 在节点已离开 liveNodes 后才到达。引擎回填。
    const { engine, journal } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1", "planner");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), { x: 1 });
    await expect(p).resolves.toEqual({ x: 1 });

    const settled = journal.getNode(RUN, "ask#1", 1);
    expect(settled?.status).toBe("completed");
    expect(settled?.stats).toBeUndefined(); // settle 时 stats 尚未到达

    engine.askStats(inst("ask#1"), { tokens: 42, toolCalls: 2, turns: 1 });

    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.stats).toEqual({ tokens: 42, toolCalls: 2, turns: 1 });
    // 只新增 stats，其余字段保持不变（status/result/actorSeq/inputHash/actor 身份）。
    expect(node?.status).toBe("completed");
    expect(node?.result).toEqual({ x: 1 });
    expect(node?.actorSeq).toBe(0);
    expect(node?.inputHash).toBe(inputHash("do it"));
    expect(node?.actorSiteId).toBe("actor#1");
    expect(node?.actorOrdinal).toBe(1);
    expect(node?.kind).toBe("ask");
  });

  it("preserves the pre-settle path: stats reported before submit are present at settle without a backfill", async () => {
    const { engine, journal } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    engine.askStats(inst("ask#1"), { tokens: 10, toolCalls: 1, turns: 1 });
    engine.askSubmitAttempted(inst("ask#1"), { x: 1 });
    await expect(p).resolves.toEqual({ x: 1 });

    expect(journal.getNode(RUN, "ask#1", 1)?.stats).toEqual({ tokens: 10, toolCalls: 1, turns: 1 });
  });

  it("is a no-op when the node was never journaled (defensive, best-effort)", async () => {
    // 从未准入的实例上报 stats：既无 live 节点也无 journal 记录，回填静默跳过（不抛错、不建记录）。
    const { engine, journal } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    engine.createActor("actor#1");
    engine.askStats(inst("ask#404"), { tokens: 5, toolCalls: 0, turns: 1 });
    expect(journal.getNode(RUN, "ask#404", 1)).toBeUndefined();
  });
});

describe("WorkflowEngine — run metadata", () => {
  it("persists scriptText / scriptHash / parentSessionId / cwd / toolCallId through createRun", async () => {
    // 前四个字段 RunRecord 早就声明了，但 createRun 从不填——于是 resume 的 script_hash
    // 校验没有比对对象。落库是那条校验唯一的前提。toolCallId 是 cancel & resume 特性
    // 追加的第五个：重启后工具卡 join 与 resume 通知锚点的唯一持久来源。
    const { journal } = setup({
      scriptText: 'await agent("a").ask("hi");',
      scriptHash: "hash-a",
      parentSessionId: "sess_parent",
      cwd: "/tmp/project",
      toolCallId: "call-abc",
    });
    expect(journal.getRun(RUN)).toMatchObject({
      runId: RUN,
      status: "running",
      scriptText: 'await agent("a").ask("hi");',
      scriptHash: "hash-a",
      parentSessionId: "sess_parent",
      cwd: "/tmp/project",
      toolCallId: "call-abc",
    });
  });

  // name 走的是与上面四个字段**完全相同**的那条元数据路（EngineConfig → createRun，
  // 此后没有任何写入者碰它）。它纯展示：引擎不读，宿主的枚举面拿它当标签——缺了这一步，
  // 跨会话列出来的 run 只能是一串裸 runId（docs/dynamic-workflow/launch.md）。
  it("persists the run name through createRun", async () => {
    const { journal } = setup({ name: "nightly triage" });
    expect(journal.getRun(RUN)).toMatchObject({ runId: RUN, name: "nightly triage" });
  });

  it("omits the metadata fields entirely when the config carries none", async () => {
    // 缺省不得落成 undefined 键：存储实现按"字段缺席"与"字段为 null"区分（见契约测）。
    const { journal } = setup();
    const run = journal.getRun(RUN)!;
    expect("scriptText" in run).toBe(false);
    expect("scriptHash" in run).toBe(false);
    expect("parentSessionId" in run).toBe(false);
    expect("cwd" in run).toBe(false);
    // 未命名的 run 必须是**缺席的键**而不是 null/undefined 值：读侧据此走脚本首行兜底。
    expect("name" in run).toBe(false);
    expect("toolCallId" in run).toBe(false);
    // 绝大多数 run 不是修订：lineage 指针同样必须缺席，而不是落成空值
    // （docs/execution-engine.md）。
    expect("resumedFrom" in run).toBe(false);
  });

  // resumedFrom 走的也是这条只写一次的元数据路。引擎不读它：导入缓存的构建在 run service。
  // 它落库的意义在崩溃之后——修订 run 的 plain resume 靠读回这个指针重建 ImportedCache。
  it("persists the amend-resume lineage pointer through createRun", async () => {
    const { journal } = setup({ resumedFrom: "run-predecessor" });
    expect(journal.getRun(RUN)).toMatchObject({ runId: RUN, resumedFrom: "run-predecessor" });
  });
});

// 具名 actor 是修订续跑（amend-resume）缓存导入的身份键，而**任何** run 都是未来修订的
// 潜在前驱——所以这条唯一性规则对所有 run 生效，不只是修订 run
// （docs/execution-engine.md「Amend-resume」）。
describe("WorkflowEngine — actor name uniqueness", () => {
  it("fails the run when a non-empty name repeats (both sites via the name argument)", async () => {
    const { engine, journal } = setup();
    engine.createActor("actor#1", "planner");
    // createActor 是同步表面（无 promise 可拒），所以与 assertRunning 同姿态：抛。
    expect(() => engine.createActor("actor#2", "planner")).toThrow(
      expect.objectContaining({ code: "DuplicateActorName" }),
    );
    await expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: expect.objectContaining({ code: "DuplicateActorName" }),
    });
    expect(journal.getRun(RUN)?.failure?.code).toBe("DuplicateActorName");
  });

  it("compares the effective name, so persona.name collides with a plain name argument", async () => {
    // 有效名 = normalizePersona 后的 spec.name，persona.name 压过 name 实参。查重必须看
    // 那个值，否则「name 写 b、persona.name 写 a」能绕过规则并在前驱里造出两个 a。
    const { engine } = setup();
    engine.createActor("actor#1", "reviewer");
    expect(() => engine.createActor("actor#2", "second", { name: "reviewer" })).toThrow(
      expect.objectContaining({ code: "DuplicateActorName" }),
    );
  });

  it("does not collide when persona.name renames one of two identical name arguments", async () => {
    // 同一条规则的另一侧：name 实参相同但 persona.name 覆盖了其中一个，有效名就不同。
    const { engine, journal } = setup();
    engine.createActor("actor#1", "worker");
    engine.createActor("actor#2", "worker", { name: "worker-2" });
    expect(journal.getRun(RUN)?.status).toBe("running");
    expect(
      journal
        .listActors(RUN, { withPersona: true })
        .map((a) => a.persona?.name)
        .sort(),
    ).toEqual(["worker", "worker-2"]);
  });

  it("allows any number of anonymous actors (absent or empty names)", async () => {
    // 匿名合法且不查——代价已裁决：没有缓存资格。空串与缺席同属匿名。
    const { engine, journal } = setup();
    engine.createActor("actor#1");
    engine.createActor("actor#2");
    engine.createActor("actor#3", "");
    engine.createActor("actor#4", "", { name: "" });
    expect(journal.getRun(RUN)?.status).toBe("running");
    expect(journal.listActors(RUN, { withPersona: true })).toHaveLength(4);
  });

  it("allows distinct names", async () => {
    const { engine, journal } = setup();
    engine.createActor("actor#1", "planner");
    engine.createActor("actor#2", "reviewer");
    expect(journal.getRun(RUN)?.status).toBe("running");
  });

  it("does not false-positive on a byte-identical resume (fresh engine, names re-registered once)", async () => {
    // replay 安全性：查重表是纯内存的、随引擎实例而生。resume 在一个全新引擎里从头重跑
    // 同一串 createActor 调用，每个名字因此恰好被登记一次。这也是它不能落 journal 的理由。
    const journal = new InMemoryJournalStore();
    {
      const e1 = setup({ journal }).engine;
      e1.createActor("actor#1", "planner");
      e1.createActor("actor#2", "reviewer");
      e1.stop("user");
    }
    const { engine, journal: same } = setup({ journal });
    expect(() => {
      engine.createActor("actor#1", "planner");
      engine.createActor("actor#2", "reviewer");
    }).not.toThrow();
    expect(same.getRun(RUN)?.status).toBe("running");
  });
});

describe("WorkflowEngine — actor persona and resolved model", () => {
  // persona 对引擎是**纯透传数据**：引擎不解读它，但必须把它原样送到 driver、事件与 journal——
  // 它是冻结身份，resume 时按同一份重建。模型不在 persona 里（2026-09-11 起没有模型档位）：
  // 子代理跑在哪个模型上是宿主事实，由 driver 写进 resolvedModel。
  it("carries the persona through to the driver, the actor-created event and the journal", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1", "judge", {
      system: "You judge.",
    });
    const p = engine.ask("ask#1", actor, "judge it");
    await flush();

    expect(driver.sessionPersonas[0]).toEqual({
      name: "judge",
      system: "You judge.",
    });
    const created = driver.events.find((e) => e.type === "actor-created");
    expect(created).toMatchObject({
      persona: { name: "judge", system: "You judge." },
    });
    expect(journal.getActor(RUN, "actor#1", 1)?.persona).toEqual({
      name: "judge",
      system: "You judge.",
    });

    engine.askTurnEnded(inst("ask#1"), "ok");
    await expect(p).resolves.toBe("ok");
  });

  // docs/dynamic-workflow/authoring.md「Choosing a model per subagent」：persona 可以点名一个模型。
  // 引擎只记这个名字、原样交给 driver——查绑定表与建会话都是宿主的事。
  it("carries a persona model name verbatim to the driver, the event and the journal", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1", "judge", {
      system: "You judge.",
      model: "GLM-5.3-Flash$high",
    });
    const p = engine.ask("ask#1", actor, "judge it");
    await flush();

    const expected = { name: "judge", system: "You judge.", model: "GLM-5.3-Flash$high" };
    expect(driver.sessionPersonas[0]).toEqual(expected);
    expect(driver.events.find((e) => e.type === "actor-created")).toMatchObject({
      persona: expected,
    });
    expect(journal.getActor(RUN, "actor#1", 1)?.persona).toEqual(expected);
    // 派发重复出生事实，persona 的模型名也在其中（读面收回表的子代理要带着它）。
    expect(driver.events.find((e) => e.type === "node-dispatched")).toMatchObject({
      actorName: "judge",
      actorPersonaModel: "GLM-5.3-Flash$high",
    });

    engine.askTurnEnded(inst("ask#1"), "ok");
    await expect(p).resolves.toBe("ok");
  });

  it("a dispatch of a persona without a model carries no actorPersonaModel", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1", "judge", { system: "You judge." });
    const p = engine.ask("ask#1", actor, "judge it");
    await flush();
    const dispatched = driver.events.find((e) => e.type === "node-dispatched");
    expect(dispatched).toBeDefined();
    expect("actorPersonaModel" in dispatched!).toBe(false);
    engine.askTurnEnded(inst("ask#1"), "ok");
    await expect(p).resolves.toBe("ok");
  });

  it("keeps only the known string fields of an object persona off the wire", async () => {
    // 沙箱经类型断言塞进来的怪值不该一路搬进 journal 与宿主的建会话路径。
    const { engine, journal } = setup();
    engine.createActor("actor#1", "judge", {
      system: "You judge.",
      model: 42,
      tools: "none",
    } as unknown as PersonaSpec);
    expect(journal.getActor(RUN, "actor#1", 1)?.persona).toEqual({
      name: "judge",
      system: "You judge.",
    });
  });

  it("carries a string persona through unchanged (nothing invented)", async () => {
    const { engine, journal } = setup();
    engine.createActor("actor#1", "planner", "You plan.");
    const persona = journal.getActor(RUN, "actor#1", 1)?.persona;
    expect(persona).toEqual({ name: "planner", system: "You plan." });
  });

  it("does not clobber the driver-written resolvedModel when journaling the session", async () => {
    // resolvedModel 是 **driver 拥有**的字段：子代理跑在哪个模型上只有宿主知道，所以它在
    // createActorSession 内部才被写下。而 putActor 是整条记录的替换，引擎在会话创建返回后
    // 还要再写一次（补 sessionId）——那一次必须把它带过去，否则成本审计与 resume 的 pin
    // 依据在正常路径上就丢了。
    const { engine, journal } = setup({
      resolveModel: (persona) =>
        persona.name === "judge" ? "anthropic/haiku" : "anthropic/sonnet",
    });
    const actor = engine.createActor("actor#1", "judge", { system: "You judge." });
    const p = engine.ask("ask#1", actor, "judge it");
    await flush();

    const record = journal.getActor(RUN, "actor#1", 1);
    expect(record?.resolvedModel).toBe("anthropic/haiku");
    // 同一条记录上，引擎自己的字段照旧完整。
    expect(record?.sessionId).toBe("session:actor#1@1");
    expect(record?.persona).toEqual({ name: "judge", system: "You judge." });

    engine.askTurnEnded(inst("ask#1"), "ok");
    await expect(p).resolves.toBe("ok");
  });

  it("preserves a journaled resolvedModel across a replayed createActor", async () => {
    // resume 路径：同一个 (siteId, ordinal) 再次 createActor 时，引擎的 putActor 不得把上一次
    // run 解析出的模型抹掉——它正是「resume 重新附着到同一个模型」的依据。
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({
      runId: RUN,
      siteId: "actor#1",
      ordinal: 1,
      sessionId: "session:actor#1@1",
      resolvedModel: "anthropic/haiku",
    });

    const { engine } = setup({ journal });
    engine.createActor("actor#1", "judge", { system: "You judge." });

    expect(journal.getActor(RUN, "actor#1", 1)).toMatchObject({
      sessionId: "session:actor#1@1",
      resolvedModel: "anthropic/haiku",
      persona: { name: "judge", system: "You judge." },
    });
  });
});

describe("WorkflowEngine — resume script identity", () => {
  /** 造一个已存在的 run 记录（模拟前一次 run 留下的 journal）。 */
  function seedRun(journal: InMemoryJournalStore, scriptHash?: string): void {
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 7,
      status: "stopped",
      stopReason: "user",
      ...(scriptHash === undefined ? {} : { scriptHash }),
    });
  }

  it("refuses to resume when the journaled scriptHash differs from the config's", () => {
    // V1 的 resume 限制是「逐字节相同的脚本文本」。哈希不一致意味着调用方拿另一份脚本
    // 复用了同一个 runId：拒绝这次 resume，而不是接受后再让 run 失败。
    const journal = new InMemoryJournalStore();
    seedRun(journal, "hash-old");
    const driver = new FakeDriver(journal);

    const construct = () =>
      new WorkflowEngine({
        runId: RUN,
        driver,
        caps: { maxConcurrency: 16 },
        askSpecs: new Map(),
        validate: () => [],
        scriptHash: "hash-new",
      });
    expect(construct).toThrowError(expect.objectContaining({ code: "ScriptHashMismatch" }));

    // 两个哈希必须结构化随错误走：排查 resume 被拒的人要看出是哪一侧变了，
    // 而不是从 message 里正则抠值（流程判断不依赖错误文本）。
    let thrown: WorkflowError | undefined;
    try {
      construct();
    } catch (error) {
      thrown = error as WorkflowError;
    }
    expect(thrown?.mismatch).toEqual({ expected: "hash-old", got: "hash-new" });
    // 落 journal 的可序列化形态同样带着它（failure_json 是 app 侧读的持久记录）。
    expect(thrown?.toJSON()).toMatchObject({
      code: "ScriptHashMismatch",
      mismatch: { expected: "hash-old", got: "hash-new" },
    });
    expect(WorkflowError.fromJSON(thrown!.toJSON()).mismatch).toEqual({
      expected: "hash-old",
      got: "hash-new",
    });

    // 既有 journal 记录不得被这次拒绝改写——它仍可用正确的脚本 resume。
    expect(journal.getRun(RUN)).toMatchObject({
      status: "stopped",
      scriptHash: "hash-old",
      spentTokens: 7,
    });
    // 拒绝发生在任何事件之前：没有 run-started，也没有 run-settled。
    expect(driver.events).toEqual([]);
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })).toEqual([]);
  });

  it("resumes when the two hashes match", () => {
    const journal = new InMemoryJournalStore();
    seedRun(journal, "hash-same");
    const driver = new FakeDriver(journal);
    const engine = new WorkflowEngine({
      runId: RUN,
      driver,
      caps: { maxConcurrency: 16 },
      askSpecs: new Map(),
      validate: () => [],
      scriptHash: "hash-same",
    });
    expect(engine.status()).toBe("running");
    expect(journal.getRun(RUN)?.spentTokens).toBe(7); // 预算仍从记录恢复
  });

  it("resumes when either side has no hash (records predating run metadata)", () => {
    // 只有"两侧都有且不同"才拒绝：缺一侧就没有可比对的对象，此时不得凭空判定不匹配。
    const withoutRecordHash = new InMemoryJournalStore();
    seedRun(withoutRecordHash);
    expect(
      new WorkflowEngine({
        runId: RUN,
        driver: new FakeDriver(withoutRecordHash),
        caps: { maxConcurrency: 16 },
        askSpecs: new Map(),
        validate: () => [],
        scriptHash: "hash-new",
      }).status(),
    ).toBe("running");

    const withoutConfigHash = new InMemoryJournalStore();
    seedRun(withoutConfigHash, "hash-old");
    expect(
      new WorkflowEngine({
        runId: RUN,
        driver: new FakeDriver(withoutConfigHash),
        caps: { maxConcurrency: 16 },
        askSpecs: new Map(),
        validate: () => [],
      }).status(),
    ).toBe("running");
  });
});

describe("WorkflowEngine — askSpecs completeness", () => {
  it("fails the run loudly instead of degrading an unlisted ask site to untyped", async () => {
    // 站点表与 schema 合成来自同一次编译，所以 miss 只可能是接线错误。旧的
    // `?? { typed: false }` 兜底会把 typed ask 静默降级：不注册 submit_result、
    // 拿末轮文本当结果、schema 校验整个消失——「结果永远合法」的类型系统比没有更糟。
    const { engine, driver } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");

    const p = engine.ask("ask#2", actor, "unlisted site"); // askSpecs 里只有 ask#1
    await expect(p).rejects.toMatchObject({ code: "MissingAskSpec" });
    await flush();

    // 关键断言：绝不曾以 untyped 形态派发出去。
    expect(driver.startAsks).toEqual([]);
    await expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "MissingAskSpec" },
    });
  });

  it("still honours an explicit untyped entry", async () => {
    // untyped ask 依然是一等公民——它只是必须被显式记为 { typed: false }。
    const { engine, driver } = setup({ askSpecs: new Map([["ask#1", { typed: false }]]) });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "summarize");
    await flush();
    expect(driver.startAsks[0]?.message.typed).toBe(false);
    engine.askTurnEnded(inst("ask#1"), "the answer");
    await expect(p).resolves.toBe("the answer");
  });
});

describe("WorkflowEngine — world reads", () => {
  it("journals a world.run dispatch under kind world-run (effects are not reads)", async () => {
    // docs/dynamic-workflow/authoring.md「Running commands: `world.run`」：op "run" 与其余 world-read
    // 机制同构，但落 journal 的 kind 是 world-run——审计面不把效应伪装成读。
    const { engine, driver, journal } = setup();
    const p = engine.worldRead("world-read#1", "run", ["lean", ["a.lean"], { timeoutMs: 60000 }]);
    expect(driver.worldReads[0]?.op).toBe("run");
    driver.worldReads[0]?.deferred.resolve({ exitCode: 1, stdout: "", stderr: "boom" });
    await expect(p).resolves.toEqual({ exitCode: 1, stdout: "", stderr: "boom" });

    const node = journal.getNode(RUN, "world-read#1", 1);
    expect(node?.kind).toBe("world-run");
    expect(node?.inputHash).toBe(
      inputHash({ op: "run", args: ["lean", ["a.lean"], { timeoutMs: 60000 }] }),
    );
    // 事件流的 node-queued 同样携带 world-run。
    const queued = driver.events.find(
      (event) => event.type === "node-queued" && event.instance.siteId === "world-read#1",
    );
    expect(queued !== undefined && queued.type === "node-queued" ? queued.kind : undefined).toBe(
      "world-run",
    );
  });

  it("dispatches a live world read, journals it, and resolves", async () => {
    const { engine, driver, journal } = setup();
    const p = engine.worldRead("world-read#1", "glob", ["src/**"]);
    expect(driver.worldReads).toHaveLength(1);
    // 实参按位置原样送到 driver（引擎不看 op、不校验元数）。
    expect(driver.worldReads[0]?.args).toEqual(["src/**"]);
    driver.worldReads[0]?.deferred.resolve(["a.ts", "b.ts"]);
    await expect(p).resolves.toEqual(["a.ts", "b.ts"]);

    const node = journal.getNode(RUN, "world-read#1", 1);
    expect(node?.kind).toBe("world-read");
    expect(node?.result).toEqual(["a.ts", "b.ts"]);
    // inputHash 覆盖 {op, args}（此前是 {op, arg}）：载荷形变是有意的，早于此的 journal
    // 会在第一个 world-read 命中处以 InputHashMismatch 大声失败（见 engine.worldRead 的注释）。
    expect(node?.inputHash).toBe(inputHash({ op: "glob", args: ["src/**"] }));
    expect(node?.actorSeq).toBeUndefined();
  });

  it("hashes multi-argument world reads positionally (arg order is part of identity)", async () => {
    const { engine, driver, journal } = setup();
    // 用 glob 承载一个多参调用：引擎对 args 完全不解释，所以这条断言钉的是"位置数组进 hash"，
    // 而不是某个 op 的元数（元数归 driver）。
    const p = engine.worldRead("world-read#1", "glob", ["a", "b"]);
    expect(driver.worldReads[0]?.args).toEqual(["a", "b"]);
    driver.worldReads[0]?.deferred.resolve(["hit"]);
    await expect(p).resolves.toEqual(["hit"]);
    expect(journal.getNode(RUN, "world-read#1", 1)?.inputHash).toBe(
      inputHash({ op: "glob", args: ["a", "b"] }),
    );
    // 顺序敏感：交换实参就是另一次读取。
    expect(inputHash({ op: "glob", args: ["a", "b"] })).not.toBe(
      inputHash({ op: "glob", args: ["b", "a"] }),
    );
  });

  it("short-circuits a journaled world read with zero driver calls", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putNode({
      runId: RUN,
      siteId: "world-read#1",
      ordinal: 1,
      kind: "world-read",
      inputHash: inputHash({ op: "glob", args: ["src/**"] }),
      status: "completed",
      result: ["x.ts"],
    });
    const { engine, driver } = setup({ journal });
    const p = engine.worldRead("world-read#1", "glob", ["src/**"]);
    expect(driver.worldReads).toHaveLength(0);
    await expect(p).resolves.toEqual(["x.ts"]);
  });

  it("fails the run loudly when a journaled world read's args differ (arity/value change)", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putNode({
      runId: RUN,
      siteId: "world-read#1",
      ordinal: 1,
      kind: "world-read",
      inputHash: inputHash({ op: "glob", args: ["src/**"] }),
      status: "completed",
      result: ["x.ts"],
    });
    const { engine } = setup({ journal });
    // 同 op、实参不同：纯度契约被破坏，整个 run 大声失败而不是返回旧结果。
    await expect(
      engine.worldRead("world-read#1", "glob", ["src/**", "extra"]),
    ).rejects.toMatchObject({
      code: "InputHashMismatch",
    });
    expect(journal.getRun(RUN)?.status).toBe("errored");
  });

  it("journals a multi-arg op's inputHash over {op, args} and short-circuits its replay", async () => {
    // 多参 op 的完整往返：`files.grep(pattern, glob?)` 的 args 是位置数组，键就是
    // `{op, args}`。第二段证明 replay 命中零 driver 调用——journal 化世界读取正是这样让
    // resume 免疫于 run 与 resume 之间的磁盘变化。
    const hits = [{ path: "src/a.ts", line: 12, text: "// TODO" }];
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    const live = setup({ journal });
    const p = live.engine.worldRead("world-read#1", "grep", ["TODO", "*.ts"]);
    expect(live.driver.worldReads[0]?.op).toBe("grep");
    expect(live.driver.worldReads[0]?.args).toEqual(["TODO", "*.ts"]);
    live.driver.worldReads[0]?.deferred.resolve(hits);
    await expect(p).resolves.toEqual(hits);
    expect(journal.getNode(RUN, "world-read#1", 1)?.inputHash).toBe(
      inputHash({ op: "grep", args: ["TODO", "*.ts"] }),
    );

    // Replay over the same journal: hit, no dispatch.
    const replay = setup({ journal });
    const replayed = replay.engine.worldRead("world-read#1", "grep", ["TODO", "*.ts"]);
    expect(replay.driver.worldReads).toHaveLength(0);
    await expect(replayed).resolves.toEqual(hits);
  });

  it("distinguishes an omitted trailing optional from a present one (shorter args array)", async () => {
    // `grep("TODO")` 与 `grep("TODO", "*.ts")` 必须是两个不同的 journal 键。lowering 在
    // 缺省时打包**更短的数组**（不是 undefined 洞），而 canonicalJson 让长度进 hash，所以
    // 这条性质是自动的——钉住它是因为一旦丢掉，一次"加了 glob 的 grep"会命中一次
    // "没加 glob 的 grep"的记录，而故障点在 resume，离原因很远。
    expect(inputHash({ op: "grep", args: ["TODO"] })).not.toBe(
      inputHash({ op: "grep", args: ["TODO", "*.ts"] }),
    );
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putNode({
      runId: RUN,
      siteId: "world-read#1",
      ordinal: 1,
      kind: "world-read",
      inputHash: inputHash({ op: "grep", args: ["TODO"] }),
      status: "completed",
      result: [],
    });
    const { engine } = setup({ journal });
    await expect(engine.worldRead("world-read#1", "grep", ["TODO", "*.ts"])).rejects.toMatchObject({
      code: "InputHashMismatch",
    });
  });

  it("settles the node failed on a driver WorldReadCapExceeded, keeping the run alive", async () => {
    // 上限溢出是 **node 级**：脚本可以 catch 它并缩窄 pattern，所以 run 必须还活着，
    // 而且这个码绝不能被折成 DriverError——两者的可操作性不同（见 WorkflowErrorCode 注释）。
    const { engine, driver, journal } = setup();
    const p = engine.worldRead("world-read#1", "grep", [".", undefined]);
    driver.worldReads[0]?.deferred.reject(
      new WorkflowError(
        "WorldReadCapExceeded",
        "grep 命中超过 2000 条；请缩窄 pattern 或加一个 glob",
      ),
    );
    await expect(p).rejects.toMatchObject({ code: "WorldReadCapExceeded" });
    const node = journal.getNode(RUN, "world-read#1", 1);
    expect(node?.status).toBe("failed");
    expect(node?.error?.code).toBe("WorldReadCapExceeded");
    // run 未被这次拒绝拖死；脚本可以继续（这才是 node 级的意义）。
    expect(journal.getRun(RUN)?.status).toBe("running");
  });

  it("replays a journaled cap failure as the same structured rejection", async () => {
    // 失败节点也落 journal（replay 可靠性要求：脚本可能已经观察过这次拒绝并据此分支）。
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putNode({
      runId: RUN,
      siteId: "world-read#1",
      ordinal: 1,
      kind: "world-read",
      inputHash: inputHash({ op: "git-diff", args: [] }),
      status: "failed",
      error: { code: "WorldReadCapExceeded", message: "git.diff 超过 512KB" },
    });
    const { engine, driver } = setup({ journal });
    await expect(engine.worldRead("world-read#1", "git-diff", [])).rejects.toMatchObject({
      code: "WorldReadCapExceeded",
    });
    expect(driver.worldReads).toHaveLength(0);
  });
});

describe("WorkflowEngine — lenient submit decode (real-model stringifies tool args)", () => {
  // 用真实子集校验器：这些场景要真正的类型判定（object/number/anyOf），fake 的 required-only
  // 校验器表达不了。真实模型（实盘 GLM-5.3）常把 submit_result 的 result 传成 JSON 字符串而非对象，
  // 引擎需 schema-aware 地宽松解析——见 scheduler.normalizeSubmit。
  const realValidate: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

  const objectSchema: JsonSchema = {
    type: "object",
    required: ["title", "bullet_points"],
    properties: {
      title: { type: "string" },
      bullet_points: { type: "array", items: { type: "string" } },
    },
  };
  const specs = (schema: JsonSchema) =>
    new Map<string, AskSpec>([["ask#1", { typed: true, schema }]]);

  it("parses a stringified JSON object submit and journals the parsed OBJECT, not the string", async () => {
    const { engine, driver, journal } = setup({
      askSpecs: specs(objectSchema),
      validate: realValidate,
    });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), '{"title":"x","bullet_points":["a"]}');

    expect(driver.submitResponses.at(-1)?.verdict.kind).toBe("accept");
    await expect(p).resolves.toEqual({ title: "x", bullet_points: ["a"] });

    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.status).toBe("completed");
    // 落库的是解析后的对象，而非原始字符串。
    expect(node?.result).toEqual({ title: "x", bullet_points: ["a"] });
    expect(typeof node?.result).toBe("object");
  });

  it("repairs when a stringified submit parses to JSON of the wrong shape (not accepted)", async () => {
    const { engine, driver, journal } = setup({
      askSpecs: specs(objectSchema),
      validate: realValidate,
    });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    void p.catch(() => {}); // 最终会因 repair 耗尽而 reject
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), '{"unexpected":1}'); // 解析出对象但缺 required 字段

    const last = driver.submitResponses.at(-1)?.verdict;
    expect(last?.kind).toBe("reject");
    expect(last?.kind === "reject" && last.violations.length).toBeGreaterThan(0);
    // 尚未结算：仍是准入时的 running 记录。
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("running");
  });

  it("reports POST-parse violations when a stringified object misses a required field", async () => {
    // bug：JSON.parse 成功但解析值仍不过时，repair 曾上报解析前违规（`$: expected object, got string`），
    // 模型无从修起（再引号/双重编码/退化成 "{}"），3 次后 ValidationFailed 失败（dwfrun-60c20069）。
    const { engine, driver } = setup({ askSpecs: specs(objectSchema), validate: realValidate });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    void p.catch(() => {});
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), '{"title":"x"}'); // 解析出对象但缺 bullet_points

    const last = driver.submitResponses.at(-1)?.verdict;
    expect(last?.kind).toBe("reject");
    // 违规必须指向解析后对象的路径，而不是根级「expected object, got string」。
    expect(last?.kind === "reject" && last.violations).toContainEqual({
      path: "$.bullet_points",
      expected: "present",
      got: "missing",
    });
    expect(
      last?.kind === "reject" &&
        last.violations.some((v) => v.path === "$" && v.expected === "object"),
    ).toBe(false);
  });

  it("reports POST-parse violations on the nested path when a stringified array field has wrong item shape", async () => {
    // 镜像实盘 Critique/gaps 失败（dwfrun-bc01726f）：schema 要 string[]，模型提交嵌套数组，
    // 且整体被序列化成字符串。违规须落在嵌套路径 $.bullet_points[0]，而不是根级 string。
    const { engine, driver } = setup({ askSpecs: specs(objectSchema), validate: realValidate });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    void p.catch(() => {});
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), '{"title":"x","bullet_points":[["a"]]}');

    const last = driver.submitResponses.at(-1)?.verdict;
    expect(last?.kind).toBe("reject");
    expect(last?.kind === "reject" && last.violations).toContainEqual({
      path: "$.bullet_points[0]",
      expected: "string",
      got: "array(1)",
    });
    expect(
      last?.kind === "reject" &&
        last.violations.some((v) => v.path === "$" && v.expected === "object"),
    ).toBe(false);
  });

  it("repairs on a non-JSON string submit (JSON.parse throws → original violations)", async () => {
    const { engine, driver, journal } = setup({
      askSpecs: specs(objectSchema),
      validate: realValidate,
    });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    void p.catch(() => {});
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), "hello"); // JSON.parse 抛出

    const last = driver.submitResponses.at(-1)?.verdict;
    expect(last?.kind).toBe("reject");
    // 报的是原始 raw-value 违规（object 期望却拿到 string）。
    expect(last?.kind === "reject" && last.violations.some((v) => v.expected === "object")).toBe(
      true,
    );
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("running");
  });

  it("preserves a legitimately-string result: raw string that validates is NOT parsed", async () => {
    // anyOf string|null 接受裸字符串 → 直接过 → 不解析。"42" 必须留 "42"，绝不变成数字 42。
    const stringSchema: JsonSchema = { anyOf: [{ type: "string" }, { type: "null" }] };
    const { engine, driver, journal } = setup({
      askSpecs: specs(stringSchema),
      validate: realValidate,
    });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), "42");

    expect(driver.submitResponses.at(-1)?.verdict.kind).toBe("accept");
    await expect(p).resolves.toBe("42");
    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.result).toBe("42");
    expect(typeof node?.result).toBe("string");
  });

  it("parses a number-string when the schema expects a number", async () => {
    const numberSchema: JsonSchema = { type: "number" };
    const { engine, driver, journal } = setup({
      askSpecs: specs(numberSchema),
      validate: realValidate,
    });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), "42");

    expect(driver.submitResponses.at(-1)?.verdict.kind).toBe("accept");
    await expect(p).resolves.toBe(42);
    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.result).toBe(42);
    expect(typeof node?.result).toBe("number");
  });
});

// report（execution-engine.md 的 "Progressive results"）：即发即忘、无 driver 往返，但**落 journal**。
// 这一组钉住三件事：一次写的节点形状、replay 去重、两个上限。
describe("WorkflowEngine — report", () => {
  it("journals one already-settled node and emits one event", () => {
    const { engine, journal, driver } = setup();
    engine.report("report#1", { finding: "dup impl", paths: ["a.ts", "b.ts"] });

    const node = journal.getNode(RUN, "report#1", 1);
    // 一次写、已结算、无 actor 字段、result 即 item——「两次写」规则唯一的例外。
    expect(node).toMatchObject({
      kind: "report",
      status: "completed",
      result: { finding: "dup impl", paths: ["a.ts", "b.ts"] },
    });
    expect(node?.inputHash).toBe(inputHash({ finding: "dup impl", paths: ["a.ts", "b.ts"] }));
    expect(node !== undefined && "actorSeq" in node).toBe(false);
    expect(driver.eventsOfType("report")).toEqual([
      {
        type: "report",
        instance: inst("report#1"),
        item: { finding: "dup impl", paths: ["a.ts", "b.ts"] },
      },
    ]);
  });

  it("assigns per-site ordinals so one site reported twice is two nodes", () => {
    const { engine, journal, driver } = setup();
    engine.report("report#1", "first");
    engine.report("report#1", "second");
    engine.report("report#2", "other-site");

    expect(journal.getNode(RUN, "report#1", 1)?.result).toBe("first");
    expect(journal.getNode(RUN, "report#1", 2)?.result).toBe("second");
    expect(journal.getNode(RUN, "report#2", 1)?.result).toBe("other-site");
    expect(driver.eventsOfType("report")).toHaveLength(3);
  });

  it("ignores reports after the run settles (like log)", () => {
    const { engine, journal, driver } = setup();
    engine.complete("done");
    engine.report("report#1", "too late");

    expect(journal.getNode(RUN, "report#1", 1)).toBeUndefined();
    expect(driver.eventsOfType("report")).toEqual([]);
  });

  it("skips a journaled report on replay: no event, no re-append", () => {
    // 脚本重跑，所以每个 report 调用都会再执行一次。已 journal 的 (siteId, ordinal) 静默跳过——
    // 否则 resume 之后 Results 面板会把同一条发现显示两次，而那正是 report 要 journal 的理由。
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    first.engine.report("report#1", { n: 1 });
    first.engine.report("report#1", { n: 2 });
    first.engine.complete("ok");

    const before = journal.listEvents(RUN, { types: "all", reportItems: "all" }).length;
    const resumed = setup({ journal });
    resumed.engine.report("report#1", { n: 1 });
    resumed.engine.report("report#1", { n: 2 });

    expect(resumed.driver.eventsOfType("report")).toEqual([]);
    expect(
      journal.listNodes(RUN, { kinds: "all", withResult: true }).filter((n) => n.kind === "report"),
    ).toHaveLength(2);
    // resume 只多出一条 run-started，report 一条事件都没再 append。
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" }).length).toBe(before + 1);
  });

  it("fails the run with InputHashMismatch when a replayed item differs", () => {
    // 这条比对是**防御性的**（一条报告派生自 journal 已钉住的值），但这里的偏移意味着整个
    // replay 不可靠——Results 面板的读者绝不该在不知情的情况下看到那种东西。
    const journal = new InMemoryJournalStore();
    setup({ journal }).engine.report("report#1", { n: 1 });

    const resumed = setup({ journal });
    resumed.engine.report("report#1", { n: 999 });

    return expect(resumed.engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "InputHashMismatch" },
    });
  });

  it("hashes canonically, so key order in the item is not a mismatch", () => {
    // inputHash 走 canonicalJson（键按 code point 排序），所以脚本里字面量键序变化不会
    // 被当成纯度违约。这是"防御性而非承重"该有的松紧度。
    const journal = new InMemoryJournalStore();
    setup({ journal }).engine.report("report#1", { a: 1, b: 2 });

    const resumed = setup({ journal });
    resumed.engine.report("report#1", { b: 2, a: 1 });

    expect(resumed.driver.eventsOfType("report")).toEqual([]);
    expect(journal.getRun(RUN)?.status).toBe("running");
  });

  it("fails the run with ReportCapExceeded on the item past the cap (65,537th)", () => {
    const { engine, journal } = setup();
    expect(REPORT_CAPS.maxItemsPerRun).toBe(65_536);
    for (let i = 0; i < REPORT_CAPS.maxItemsPerRun; i += 1) engine.report("report#1", i);
    expect(journal.getRun(RUN)?.status).toBe("running");

    engine.report("report#1", "one too many");

    expect(journal.countNodes(RUN, "report")).toBe(REPORT_CAPS.maxItemsPerRun);
    return expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "ReportCapExceeded" },
    });
  });

  it("fails the run with ReportCapExceeded on an oversized item, journaling nothing", () => {
    const { engine, journal } = setup();
    engine.report("report#1", "x".repeat(REPORT_CAPS.maxItemSerializedBytes));

    // 上限先于落库：溢出的那条 item 一个字节都不该进 journal。
    expect(journal.getNode(RUN, "report#1", 1)).toBeUndefined();
    return expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "ReportCapExceeded" },
    });
  });

  it("accepts an item of exactly the per-item limit", () => {
    const { engine, journal } = setup();
    expect(REPORT_CAPS.maxItemSerializedBytes).toBe(1024 * 1024);
    // JSON 的两个引号也算在字节里：正文少两个字节，序列化后恰好等于上限。
    engine.report("report#1", "x".repeat(REPORT_CAPS.maxItemSerializedBytes - 2));

    expect(journal.getNode(RUN, "report#1", 1)?.status).toBe("completed");
    expect(journal.getRun(RUN)?.status).toBe("running");
  });

  it("fails the run with ReportCapExceeded when its reports would pass the per-run byte limit, counted across resume", () => {
    // 一个真正攒满 1 GiB 的 run 在单测里造不起，所以让 journal 在 resume 时报一个接近上限的
    // 字节和：这同时钉住两件事——计数从 sumResultBytes 恢复，以及上限按 run 累计、拦在落库之前。
    const nearlyFull = REPORT_CAPS.maxBytesPerRun - 50;
    class NearlyFullJournal extends InMemoryJournalStore {
      override sumResultBytes(runId: string, kind: NodeKind): number {
        return super.sumResultBytes(runId, kind) + nearlyFull;
      }
    }
    const journal = new NearlyFullJournal();
    const first = setup({ journal });
    first.engine.report("report#1", "a"); // 3 字节，第一世不读 sumResultBytes
    first.engine.stop("user");

    const resumed = setup({ journal });
    resumed.engine.report("report#1", "a"); // 命中，跳过
    // 3 + nearlyFull + 42 = 上限 - 5：放得下。
    resumed.engine.report("report#1", "x".repeat(40));
    expect(journal.getRun(RUN)?.status).toBe("running");
    // 再来 10 字节就超过：整个 run 失败，这一条不落库。
    resumed.engine.report("report#1", "y".repeat(8));

    expect(journal.countNodes(RUN, "report")).toBe(2);
    return expect(resumed.engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "ReportCapExceeded", message: expect.stringContaining("limit per run") },
    });
  });

  it("measures the cap in UTF-8 bytes, not characters", () => {
    // 一份中文 findings 的字符数只有字节数的三分之一；按字符计会让上限形同虚设。
    const { engine, journal } = setup();
    // 每个字符 3 字节，加上 JSON 的两个引号：刚好越界。
    const chars = Math.ceil(REPORT_CAPS.maxItemSerializedBytes / 3);
    engine.report("report#1", "结".repeat(chars));

    expect(journal.getNode(RUN, "report#1", 1)).toBeUndefined();
    return expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "ReportCapExceeded" },
    });
  });

  it("restores the report count across resume so the cap is run-level", () => {
    // 上限是 run 级的，所以计数必须跨 resume 连续——否则一个反复 resume 的 run 可以无限报告。
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    for (let i = 0; i < REPORT_CAPS.maxItemsPerRun; i += 1) first.engine.report("report#1", i);
    first.engine.stop("user");

    // resume：脚本重跑，前 65,536 条全部命中并跳过，下一条是**新**的——上限必须仍然拦住它。
    const resumed = setup({ journal });
    for (let i = 0; i < REPORT_CAPS.maxItemsPerRun; i += 1) resumed.engine.report("report#1", i);
    expect(resumed.driver.eventsOfType("report")).toEqual([]);
    resumed.engine.report("report#1", "one past the cap");

    return expect(resumed.engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "ReportCapExceeded" },
    });
  });

  it("fails the run loudly when the item is not a JSON value", () => {
    // 运行期护栏（编译期的可序列化诊断是 suspenders）。canonicalJson 是全函数的——它会把
    // undefined 静默折成 "null"，那会把一条残缺的 item 悄悄落进 journal。所以探针用
    // JSON.stringify：返回 undefined / 抛错都能被抓成一次大声的失败。
    const { engine, journal } = setup();
    engine.report("report#1", undefined);

    expect(journal.getNode(RUN, "report#1", 1)).toBeUndefined();
    return expect(engine.settled).resolves.toMatchObject({ status: "errored" });
  });

  it("fails the run loudly on a cyclic item instead of blowing the stack", () => {
    // canonicalJson 遇到环会无限递归爆栈——那是一次崩溃而不是一次可读的失败，所以探针
    // 必须先跑。这条用例就是那个顺序的证明。
    const { engine, journal } = setup();
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => engine.report("report#1", cyclic)).not.toThrow();

    expect(journal.getNode(RUN, "report#1", 1)).toBeUndefined();
    return expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "DriverError" },
    });
  });
});

// enterPhase（docs/dynamic-workflow/presentation.md）：控制流经过一个
// `phase("…")` 标记。与 log 同一副姿态——同步、无 driver 往返、结算后 no-op——但按名字计数。
describe("WorkflowEngine — enterPhase", () => {
  it("emits phase-entered with a per-name ordinal and writes no journal row", () => {
    const { engine, journal, driver } = setup();
    engine.enterPhase("plan");
    engine.enterPhase("verify");
    engine.enterPhase("plan");
    expect(driver.eventsOfType("phase-entered")).toEqual([
      { type: "phase-entered", name: "plan", ordinal: 1 },
      { type: "phase-entered", name: "verify", ordinal: 1 },
      // 同名再入就是第二轮：分析器也把第二个同名标记读成回边。
      { type: "phase-entered", name: "plan", ordinal: 2 },
    ]);
    // 标记不是站点：没有 dwf_node 行，也不消耗任何站点的序号。
    expect(journal.listNodes(RUN, { kinds: "all", withResult: true })).toEqual([]);
  });

  it("trims the name, drops an empty one, and does not share ordinals with sites", () => {
    const { engine, driver } = setup();
    engine.enterPhase("  plan  ");
    engine.enterPhase("   ");
    engine.report("report#1", "x");
    engine.enterPhase("report#1");
    expect(driver.eventsOfType("phase-entered")).toEqual([
      { type: "phase-entered", name: "plan", ordinal: 1 },
      // 一个恰好长得像 site id 的阶段名：它的计数从 1 起，report#1 的节点序号不受影响。
      { type: "phase-entered", name: "report#1", ordinal: 1 },
    ]);
  });

  it("is a no-op after the run settled", () => {
    const { engine, driver } = setup();
    engine.complete("done");
    engine.enterPhase("late");
    expect(driver.eventsOfType("phase-entered")).toEqual([]);
  });
});

/**
 * 一层薄包装：把 `appendEvent` 收到的**原始对象**留下引用（内存 journal 自己会 clone，
 * 存进去的那份已经不是引擎传的那个）。用于钉住「journal 与 emit 拿到同一个对象」——
 * bootstrap 的 createJournalSequenceCapture 正是按引用相等核对序号的。
 */
class CapturingJournal extends InMemoryJournalStore {
  readonly appended: RunEvent[] = [];

  override appendEvent(runId: string, event: RunEvent): StoredEvent {
    this.appended.push(event);
    return super.appendEvent(runId, event);
  }
}

// 出生阶段坐标（docs/dynamic-workflow/presentation.md）：实例在**铸造
// ordinal 的那一刻**记下当时的阶段，出生事件带 `phaseName`。铸造点与事件发出点可以隔开
// （hold 规则），所以戳只能取自铸造那一刻。
describe("WorkflowEngine — 出生阶段坐标（phaseName）", () => {
  it("stamps the actor and the nodes minted after a phase marker", async () => {
    const { engine, driver } = setup();
    engine.enterPhase("规划");
    const actor = engine.createActor("actor#1", "planner");
    void engine.ask("ask#1", actor, "do it");
    void engine.worldRead("world-read#1", "glob", ["src/**"]);
    await flush();

    expect(driver.eventsOfType("actor-created")[0]).toMatchObject({ phaseName: "规划" });
    // ask 与 world-read 走两条不同的准入路径（调度器 / 引擎自己），戳都出自同一个铸造点。
    expect(
      driver.eventsOfType("node-queued").map((e) => [refToString(e.instance), e.phaseName]),
    ).toEqual([
      ["ask#1@1", "规划"],
      ["world-read#1@1", "规划"],
    ]);
  });

  it("leaves instances born before any marker unstamped", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "do it");
    engine.enterPhase("规划");
    await flush();

    // 「无戳」是键整个缺席，不是 undefined：读端（schema / reducer）区分这两者。
    expect(driver.eventsOfType("actor-created")[0]).not.toHaveProperty("phaseName");
    expect(driver.eventsOfType("node-queued")[0]).not.toHaveProperty("phaseName");
  });

  it("carries the birth phase even when the queue event lands after a later marker", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    // 前一世只记下 seq0 = ask#2@1。本次重跑先发的 ask#1 是 fresh，被 hold 规则扣住，
    // 直到 seq0 被释放才入队——那时控制流已经走到 B 了。
    journal.putNode({
      runId: RUN,
      siteId: "ask#2",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("B"),
      status: "completed",
      result: "r2",
    });

    const { engine, driver } = setup({ journal });
    const actor = engine.createActor("actor#1");
    engine.enterPhase("A");
    const pA = engine.ask("ask#1", actor, "A"); // ordinal 铸于 A，但没有入队
    expect(driver.eventsOfType("node-queued")).toEqual([]);
    engine.enterPhase("B");
    const pB = engine.ask("ask#2", actor, "B"); // 命中 seq0 → 释放它，随后才轮到 ask#1
    await flush();

    const queued = driver.eventsOfType("node-queued");
    expect(queued).toHaveLength(1);
    expect(refToString(queued[0]!.instance)).toBe("ask#1@1");
    // 事件晚于 B 的标记发出，戳仍是出生时的 A：戳取自铸造点，不是发出点。
    expect(driver.events.indexOf(queued[0]!)).toBeGreaterThan(
      driver.events.findIndex((e) => e.type === "phase-entered" && e.name === "B"),
    );
    expect(queued[0]!.phaseName).toBe("A");
    // 同一次重跑里出生于 B 的命中节点，戳是 B。
    expect(driver.eventsOfType("node-settled")[0]).toMatchObject({
      cached: true,
      phaseName: "B",
    });

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(Promise.all([pA, pB])).resolves.toEqual(["RA", "r2"]);
  });

  it("stamps a replay-cached node-settled with the phase current at that point of the re-run", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("A"),
      status: "completed",
      result: "r1",
    });

    const { engine, driver } = setup({ journal });
    // 重跑沿同一轨迹重走标记，于是命中的节点在这一世拿到与前一世相同的戳。
    engine.enterPhase("规划");
    const actor = engine.createActor("actor#1");
    await expect(engine.ask("ask#1", actor, "A")).resolves.toBe("r1");

    expect(driver.startAskCount()).toBe(0);
    expect(driver.eventsOfType("actor-created")[0]).toMatchObject({ phaseName: "规划" });
    // 命中的节点没有 node-queued，这条 cached settle 就是它的出生事件。
    expect(driver.eventsOfType("node-queued")).toEqual([]);
    expect(driver.eventsOfType("node-settled")[0]).toMatchObject({
      cached: true,
      phaseName: "规划",
    });
  });

  it("a replayed ask's cached node-settled repeats its birth facts and names no predecessor session", async () => {
    // 普通 resume（没有导入缓存）：命中的行是本 run 自己跑出来的，交换在本 run 的会话里，
    // 所以不带 sourceSessionId；出生事实照带——读面据它把节点归到子代理名下
    // （docs/execution-engine.md「Events」）。失败的行同样短路复现，也同样带。
    const journal = new InMemoryJournalStore();
    journal.createRun({ runId: RUN, caps: { maxConcurrency: 16 }, spentTokens: 0, status: "running" });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    const row = (siteId: string, seq: number, instructions: string): NodeRecord => ({
      runId: RUN,
      siteId,
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: seq,
      inputHash: inputHash(instructions),
      status: "completed",
      result: `r-${siteId}`,
    });
    journal.putNode(row("ask#1", 0, "first task"));
    journal.putNode({
      ...row("ask#2", 1, "second task"),
      status: "failed",
      error: new WorkflowError("DriverError", "boom").toJSON(),
    });

    const { engine, driver } = setup({ journal });
    const actor = engine.createActor("actor#1");
    await expect(engine.ask("ask#1", actor, "first task")).resolves.toBe("r-ask#1");
    await expect(engine.ask("ask#2", actor, "second task")).rejects.toMatchObject({ code: "DriverError" });

    expect(driver.startAskCount()).toBe(0);
    const facts = { kind: "ask", actor: { siteId: "actor#1", ordinal: 1 } };
    expect(driver.eventsOfType("node-settled")).toEqual([
      {
        type: "node-settled",
        instance: { siteId: "ask#1", ordinal: 1 },
        outcome: "ok",
        cached: true,
        ...facts,
        actorSeq: 0,
        instructionsHead: "first task",
      },
      {
        type: "node-settled",
        instance: { siteId: "ask#2", ordinal: 1 },
        outcome: "failed",
        cached: true,
        error: expect.objectContaining({ code: "DriverError" }),
        ...facts,
        actorSeq: 1,
        instructionsHead: "second task",
      },
    ]);
  });

  it("stamps an ask's node-dispatched with its own birth phases, not a live node-settled", async () => {
    const { engine, driver } = setup();
    engine.enterPhase("规划");
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");

    // 派发重复出生事实，两个阶段名都在场（各自取自实例 / actor 的铸造点）。
    expect(driver.eventsOfType("node-dispatched")[0]).toMatchObject({
      phaseName: "规划",
      actorPhaseName: "规划",
    });
    // 其余 node-* 事件仍不带（reducer 沿用 actorSiteId 的先例向前携带）。
    expect(driver.eventsOfType("node-settled")[0]).not.toHaveProperty("phaseName");
  });

  it("dispatches with the birth phases even after the script walked into later phases", async () => {
    // 派发被会话创建扣住，其间脚本走过两个标记：戳必须还是出生时的那个，不是当前阶段。
    const { engine, driver } = setup({ deferSessions: true });
    engine.enterPhase("A");
    const actor = engine.createActor("actor#1", "planner");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();
    expect(driver.eventsOfType("node-dispatched")).toEqual([]);

    engine.enterPhase("B");
    engine.enterPhase("C");
    driver.sessionDeferrals[0]!.resolve({ id: "session:actor#1@1" });
    await flush();

    const dispatched = driver.eventsOfType("node-dispatched");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ phaseName: "A", actorPhaseName: "A" });
    // 派发确实晚于 C 的标记（否则上面的断言只是恰好成立）。
    expect(driver.events.indexOf(dispatched[0]!)).toBeGreaterThan(
      driver.events.findIndex((e) => e.type === "phase-entered" && e.name === "C"),
    );

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
  });

  it("leaves the dispatch of an unstamped instance and of a world read bare", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    void engine.worldRead("world-read#1", "glob", ["src/**"]);
    // 标记在两个实例出生之后：出生表里没有它们，两条派发都不该长出阶段名。
    engine.enterPhase("规划");
    await flush();

    // world-read 同步派发，ask 要等一轮微任务建会话，所以世界读取在前。
    const dispatched = driver.eventsOfType("node-dispatched");
    expect(dispatched.map((e) => refToString(e.instance))).toEqual(["world-read#1@1", "ask#1@1"]);
    for (const event of dispatched) {
      expect(event).not.toHaveProperty("phaseName");
      expect(event).not.toHaveProperty("actorPhaseName");
    }

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
  });

  it("hands the journal and the driver the same stamped object", async () => {
    const journal = new CapturingJournal();
    const { engine, driver } = setup({ journal });
    engine.enterPhase("规划");
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "do it");
    await flush();

    expect(journal.appended).toHaveLength(driver.events.length);
    journal.appended.forEach((event, i) => {
      expect(event).toBe(driver.events[i]);
    });
    // 被打戳的那条尤其要是同一个对象：打戳建的是新对象，两条路径必须共用它。
    // 三条：actor-created、node-queued，以及重复出生事实的 node-dispatched。
    expect(journal.appended.filter((e) => "phaseName" in e && e.phaseName === "规划")).toHaveLength(
      3,
    );
  });
});

/**
 * 派发重复出生事实（docs/execution-engine.md「Events」的 `node-dispatched` 行）：有界读面按
 * 「开跑」而不是「排队」收实例进表，这条事件因此必须自足——实例的出生事实 + 它那个子代理的。
 */
describe("WorkflowEngine — node-dispatched 重复出生事实", () => {
  it("repeats exactly what the instance's node-queued and its actor-created carried", async () => {
    const { engine, driver } = setup();
    engine.enterPhase("规划");
    const actor = engine.createActor("actor#1", "planner");
    const p = engine.ask("ask#1", actor, "  写一份调研大纲  ");
    await flush();

    const created = driver.eventsOfType("actor-created")[0]!;
    const queued = driver.eventsOfType("node-queued")[0]!;
    const dispatched = driver.eventsOfType("node-dispatched")[0]!;
    expect(dispatched).toEqual({
      type: "node-dispatched",
      instance: queued.instance,
      kind: queued.kind,
      actor: queued.actor,
      actorName: created.name,
      actorPhaseName: created.phaseName,
      phaseName: queued.phaseName,
      instructionsHead: queued.instructionsHead,
    });
    // 逐字相同，而不只是形状相同：指令开头是准入时刻算的那一份（去两端空白、无省略号）。
    expect(dispatched.instructionsHead).toBe("写一份调研大纲");
    expect(dispatched.actorName).toBe("planner");

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
  });

  it("omits the name of an anonymous subagent and keeps a world read's dispatch bare", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    void engine.worldRead("world-read#1", "glob", ["src/**"]);
    await flush();

    // 匿名 actor：`actor-created` 的 name 是空的（序列化后整个键不在），派发同样不许凭空造一个。
    expect(driver.eventsOfType("actor-created")[0]!.name).toBeUndefined();
    const [world, ask] = driver.eventsOfType("node-dispatched");
    expect(ask).toEqual({
      type: "node-dispatched",
      instance: inst("ask#1"),
      kind: "ask",
      actor: { siteId: "actor#1", ordinal: 1 },
      instructionsHead: "do it",
    });
    // world-read 的派发不带任何出生事实：它紧跟自己的 node-queued，也没有子代理。
    expect(world).toEqual({ type: "node-dispatched", instance: inst("world-read#1") });

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
  });

  it("carries the facts of the new life when a running row is re-queued on resume", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({ runId: RUN, caps: { maxConcurrency: 16 }, spentTokens: 0, status: "running" });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    // 上一世崩在执行中：这一行是 running，重跑要按记录的 actorSeq 重新派发。
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("do it"),
      status: "running",
    });

    const { engine, driver } = setup({ journal });
    engine.enterPhase("重跑");
    const actor = engine.createActor("actor#1", "planner");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    // 新的一世重新出生一次，派发带的就是这一世的 node-queued 带的那一份。
    const queued = driver.eventsOfType("node-queued")[0]!;
    const dispatched = driver.eventsOfType("node-dispatched")[0]!;
    expect(queued.phaseName).toBe("重跑");
    expect(dispatched).toMatchObject({
      kind: queued.kind,
      actor: queued.actor,
      actorName: "planner",
      actorPhaseName: "重跑",
      phaseName: "重跑",
      instructionsHead: queued.instructionsHead,
    });

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
  });
});

describe("run-launched：发起 run 那一轮的锚点（docs/execution-engine.md「Token telemetry for subagents」）", () => {
  const make = (journal: InMemoryJournalStore) =>
    new WorkflowEngine({
      runId: RUN,
      driver: new FakeDriver(journal),
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
      toolCallId: "tool-1",
      parentSessionId: "parent-1",
      launch: { inputId: "launch-input-1" },
    });

  it("建 run 那一世紧跟首条 run-started 记一条 run-launched，携 inputId / toolCallId / parentSessionId", () => {
    const journal = new InMemoryJournalStore();
    make(journal);
    expect(
      journal
        .listEvents(RUN, { types: "all", reportItems: "all" })
        .map((stored) => stored.event.type),
    ).toEqual(["run-started", "run-launched"]);
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-1",
      toolCallId: "tool-1",
      parentSessionId: "parent-1",
    });
  });

  it("同一 journal 上重放（resume）只再发 run-started，不再发第二条 run-launched", () => {
    const journal = new InMemoryJournalStore();
    make(journal);
    make(journal);
    expect(
      journal
        .listEvents(RUN, { types: "all", reportItems: "all" })
        .map((stored) => stored.event.type),
    ).toEqual(["run-started", "run-launched", "run-started"]);
  });

  it("没有 launch 入参就不记锚点（CLI / 旧宿主装配）", () => {
    const journal = new InMemoryJournalStore();
    new WorkflowEngine({
      runId: RUN,
      driver: new FakeDriver(journal),
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
    });
    expect(
      journal
        .listEvents(RUN, { types: "all", reportItems: "all" })
        .map((stored) => stored.event.type),
    ).toEqual(["run-started"]);
  });

  it("launch 携 phaseNames 时 run-launched 原样带上声明的阶段表（侧栏迷你轨道的站点来源）", () => {
    const journal = new InMemoryJournalStore();
    new WorkflowEngine({
      runId: RUN,
      driver: new FakeDriver(journal),
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
      launch: { inputId: "launch-input-2", phaseNames: ["Research", "Write"] },
    });
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-2",
      phaseNames: ["Research", "Write"],
    });
  });

  // 本 run 的子代理模型（docs/dynamic-workflow/launch.md）与锚点、阶段表同车：零 SQL，只在建 run
  // 那一世记进这条事件。引擎**不读它**——子代理会话的模型面整个在宿主侧（bootstrap 的
  // workflow-actor-model.ts），宿主从事件头读回同一个规范串，resume 与两条读面都据此还原。
  it("launch 携 subagentModel 时 run-launched 原样带上规范串（档位段在内），resume 不再记第二条", () => {
    const journal = new InMemoryJournalStore();
    const withModel = () =>
      new WorkflowEngine({
        runId: RUN,
        driver: new FakeDriver(journal),
        caps: { maxConcurrency: 16 },
        askSpecs: untypedSpecs("ask#1"),
        validate: () => [],
        launch: { inputId: "launch-input-3", subagentModel: "zhipu/glm-5.3-flash$high" },
      });
    withModel();
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-3",
      // 档位段原样带着走：`$high` 是用户说出口的那一半，引擎逐字转录、不解析。
      subagentModel: "zhipu/glm-5.3-flash$high",
    });

    // 续跑那一世不再记（与锚点同一道门）：同一个 run 的子代理模型因此跨生命周期唯一。
    withModel();
    expect(
      journal
        .listEvents(RUN, { types: "all", reportItems: "all" })
        .filter((stored) => stored.event.type === "run-launched"),
    ).toHaveLength(1);
  });

  // 脚本点名的模型绑定表（docs/dynamic-workflow/launch.md「Models the script names」）与子代理模型
  // 同车同规：提交方给出、建 run 那一世记一次、引擎不读；宿主建会话时按 persona 的名字查它。
  it("launch 携 modelBindings 时 run-launched 原样带上整张表，resume 不再记第二条", () => {
    const journal = new InMemoryJournalStore();
    const bindings = {
      "GLM-5.3-Flash": "zhipu/GLM-5.3-Flash$high",
      "GLM-5.3$high": "zhipu/GLM-5.3$high",
    };
    const withBindings = () =>
      new WorkflowEngine({
        runId: RUN,
        driver: new FakeDriver(journal),
        caps: { maxConcurrency: 16 },
        askSpecs: untypedSpecs("ask#1"),
        validate: () => [],
        launch: { inputId: "launch-input-4", modelBindings: bindings },
      });
    withBindings();
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-4",
      modelBindings: bindings,
    });
    withBindings();
    expect(
      journal
        .listEvents(RUN, { types: "all", reportItems: "all" })
        .filter((stored) => stored.event.type === "run-launched"),
    ).toHaveLength(1);
  });

  it("launch 不带 modelBindings 时整个键缺席", () => {
    const journal = new InMemoryJournalStore();
    make(journal);
    expect(
      "modelBindings" in journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]!.event,
    ).toBe(false);
  });

  it("launch 不带 subagentModel 时整个键缺席（缺席即子代理跑在会话模型上）", () => {
    const journal = new InMemoryJournalStore();
    make(journal);
    // 落成值为 undefined 的键会让读侧把「没设」读成「设了一个空模型」，两者在 AmendWorkflow
    // 的三态里是不同的意思。
    expect(
      "subagentModel" in journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]!.event,
    ).toBe(false);
  });

  // 本 run 的脚本文件（docs/dynamic-workflow/launch.md「Script files」的 Provenance）与子代理
  // 模型逐条同规：零 SQL、引擎不读、只在建 run 那一世记一次。宿主从事件头读回它交给模型面。
  it("launch 携 scriptPath 时 run-launched 原样带上绝对路径，resume 不再记第二条", () => {
    const journal = new InMemoryJournalStore();
    const withPath = () =>
      new WorkflowEngine({
        runId: RUN,
        driver: new FakeDriver(journal),
        caps: { maxConcurrency: 16 },
        askSpecs: untypedSpecs("ask#1"),
        validate: () => [],
        launch: {
          inputId: "launch-input-4",
          scriptPath: "/repo/.zcode/workflow-drafts/audit.dwf.ts",
        },
      });
    withPath();
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-4",
      scriptPath: "/repo/.zcode/workflow-drafts/audit.dwf.ts",
    });

    // 续跑那一世不再记（与锚点、子代理模型同一道门）：一个 run 的脚本文件跨生命周期唯一。
    withPath();
    expect(
      journal
        .listEvents(RUN, { types: "all", reportItems: "all" })
        .filter((stored) => stored.event.type === "run-launched"),
    ).toHaveLength(1);
  });

  it("launch 不带 scriptPath 时整个键缺席（缺席即这个 run 没有可编辑的脚本文件）", () => {
    const journal = new InMemoryJournalStore();
    make(journal);
    // 与 subagentModel 同一条论证：落成值为 undefined 的键会让读侧把「没有文件」读成
    // 「有文件但路径是空的」，而模型面据此决定说哪一句话。
    expect(
      "scriptPath" in journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]!.event,
    ).toBe(false);
  });

  it("scriptPath 与子代理模型、阶段表同车时四者共存于同一条 run-launched", () => {
    const journal = new InMemoryJournalStore();
    new WorkflowEngine({
      runId: RUN,
      driver: new FakeDriver(journal),
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
      launch: {
        inputId: "launch-input-5",
        phaseNames: ["Research"],
        subagentModel: "zhipu/glm-5.3-flash$high",
        scriptPath: "/repo/.zcode/workflow-drafts/audit.dwf.ts",
      },
    });
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-5",
      phaseNames: ["Research"],
      subagentModel: "zhipu/glm-5.3-flash$high",
      scriptPath: "/repo/.zcode/workflow-drafts/audit.dwf.ts",
    });
  });

  it("phaseAlongside 与阶段表同车落 journal，缺席时键不出现（引擎两者都不读）", () => {
    const journal = new InMemoryJournalStore();
    new WorkflowEngine({
      runId: RUN,
      driver: new FakeDriver(journal),
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
      launch: {
        inputId: "launch-input-3",
        phaseNames: ["A", "B", "C"],
        phaseAlongside: [[], [0], []],
      },
    });
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-3",
      phaseNames: ["A", "B", "C"],
      phaseAlongside: [[], [0], []],
    });

    const straight = new InMemoryJournalStore();
    new WorkflowEngine({
      runId: RUN,
      driver: new FakeDriver(straight),
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
      launch: { inputId: "launch-input-4", phaseNames: ["A"] },
    });
    expect(
      Object.hasOwn(
        straight.listEvents(RUN, { types: "all", reportItems: "all" })[1]!.event,
        "phaseAlongside",
      ),
    ).toBe(false);
  });
});

describe("用量沿 lineage 累计（docs/execution-engine.md「Usage across the lineage」）", () => {
  const eventTypes = (journal: InMemoryJournalStore) =>
    journal
      .listEvents(RUN, { types: "all", reportItems: "all" })
      .map((stored) => stored.event.type);
  const make = (
    journal: InMemoryJournalStore,
    opts: { inheritedTokens?: number; launch?: { inputId: string } } = {},
  ) => {
    const driver = new FakeDriver(journal);
    const engine = new WorkflowEngine({
      runId: RUN,
      driver,
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
      resumedFrom: "run-a",
      ...(opts.inheritedTokens === undefined ? {} : { inheritedTokens: opts.inheritedTokens }),
      ...(opts.launch === undefined ? {} : { launch: opts.launch }),
    });
    return { driver, engine };
  };

  it("inheritedTokens 是新 run 的起点：行值即前驱总量，run-started 之后紧跟一条同值的 usage-updated", () => {
    const journal = new InMemoryJournalStore();
    const { driver } = make(journal, { inheritedTokens: 300 });
    expect(journal.getRun(RUN)?.spentTokens).toBe(300);
    expect(eventTypes(journal)).toEqual(["run-started", "usage-updated"]);
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "usage-updated",
      spentTokens: 300,
    });
    // 投影靠 driver.emit 拿到同一条：run-started 把用量清零，这条紧跟着把继承值放回去。
    expect(driver.events.at(-1)).toEqual({ type: "usage-updated", spentTokens: 300 });
  });

  it("带 launch 时顺序是 run-started → run-launched → usage-updated（锚点仍紧跟首条 run-started）", () => {
    const journal = new InMemoryJournalStore();
    make(journal, { inheritedTokens: 300, launch: { inputId: "launch-1" } });
    expect(eventTypes(journal)).toEqual(["run-started", "run-launched", "usage-updated"]);
  });

  it("live turn 在继承值之上累加；事件载荷与行值始终相等", async () => {
    const journal = new InMemoryJournalStore();
    const { driver, engine } = make(journal, { inheritedTokens: 300 });
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "do it").catch(() => {});
    await flush();
    engine.askStats(inst("ask#1"), { tokens: 50, toolCalls: 0, turns: 1 });
    expect(driver.events.at(-1)).toEqual({ type: "usage-updated", spentTokens: 350 });
    expect(journal.getRun(RUN)?.spentTokens).toBe(350);
    engine.stop("user");
  });

  it("继承值为零或缺席时不发 post-start usage-updated（reset 已经说了零）", () => {
    const zero = new InMemoryJournalStore();
    make(zero, { inheritedTokens: 0 });
    expect(eventTypes(zero)).toEqual(["run-started"]);
    const absent = new InMemoryJournalStore();
    make(absent);
    expect(absent.getRun(RUN)?.spentTokens).toBe(0);
    expect(eventTypes(absent)).toEqual(["run-started"]);
  });

  it("resume 恢复行值后同样紧跟一条 usage-updated，让第二世的投影不从零起显示", () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 7,
      status: "stopped",
      stopReason: "user",
    });
    const { driver } = make(journal);
    expect(eventTypes(journal)).toEqual(["run-started", "usage-updated"]);
    expect(driver.events).toEqual([
      { type: "run-started", runId: RUN, caps: { maxConcurrency: 16 } },
      { type: "usage-updated", spentTokens: 7 },
    ]);
    expect(journal.getRun(RUN)?.spentTokens).toBe(7);
  });
});
