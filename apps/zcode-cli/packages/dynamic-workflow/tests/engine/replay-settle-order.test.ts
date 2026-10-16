/**
 * Replay 的结算次序（docs/execution-engine.md「Replaying the settle order」）。
 *
 * 复现的是生产事故：扇出分支在 await 之后调 `report`，于是那些 report 的 ordinal 按**完成
 * 顺序**落库；resume 若按准入顺序释放缓存结算，同一个 ordinal 会落到另一条分支的 item 上，
 * run 以 InputHashMismatch 死在自己的防御性校验里，而脚本本身是纯的。
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  refToString,
  type AskSpec,
  type InstanceRef,
  type WorkflowDriver,
} from "../../src/engine/index.js";
import { ReplaySettleOrder, recoverSettleOrder } from "../../src/engine/replay-order.js";
import { FakeDriver, flush } from "./fake-driver.js";

const RUN = "run";
const DIMS = ["alpha", "beta", "gamma"] as const;

function inst(siteId: string, ordinal = 1): InstanceRef {
  return { siteId, ordinal };
}

const untypedSpecs = (...siteIds: string[]): Map<string, AskSpec> =>
  new Map(siteIds.map((id) => [id, { typed: false } as AskSpec]));

function engineOver(journal: InMemoryJournalStore, driver: WorkflowDriver): WorkflowEngine {
  return new WorkflowEngine({
    runId: RUN,
    driver,
    caps: { maxConcurrency: 16 },
    askSpecs: untypedSpecs("ask#1", "ask#2"),
    validate: () => [],
  });
}

/**
 * 测试扮演沙箱脚本。一条扇出分支：建 actor、问一次、答案回来后报一条——`report#2` 的
 * ordinal 因此由**这条分支什么时候拿到答案**决定，正是事故的形状。
 */
async function branch(engine: WorkflowEngine, dim: string): Promise<unknown> {
  const actor = engine.createActor("actor#1", `researcher-${dim}`);
  engine.report("report#1", { dim, status: "researching" });
  const answer = await engine.ask("ask#1", actor, `research ${dim}`);
  engine.report("report#2", { dim, status: "done" });
  return answer;
}

const fanOut = (engine: WorkflowEngine): Promise<unknown[]> =>
  Promise.all(DIMS.map((dim) => branch(engine, dim)));

/** journal 里某个站点的行，按 ordinal 升序取结果。 */
function rowsAt(journal: InMemoryJournalStore, siteId: string): unknown[] {
  return journal
    .listNodes(RUN, { kinds: "all", withResult: true })
    .filter((n) => n.siteId === siteId)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((n) => n.result);
}

describe("replay settle order — the fan-out report bug", () => {
  it("replays the journaled settle order, so ordinals after a join land where the journal has them", async () => {
    const journal = new InMemoryJournalStore();

    // ——— 第一世：三条分支并行，答案按 3、1 的顺序回来，第 2 条还在飞时进程被打断。———
    const driver1 = new FakeDriver(journal);
    const e1 = engineOver(journal, driver1);
    void fanOut(e1).catch(() => {}); // stop() 会以 Cancelled 拒绝这一世的扇出
    await flush();
    expect(driver1.startAskCount()).toBe(3);

    e1.askTurnEnded(inst("ask#1", 3), "r3");
    await flush();
    e1.askTurnEnded(inst("ask#1", 1), "r1");
    await flush();
    e1.stop("interrupted");
    await flush();

    // 完成顺序 = 3、1，report#2 的 ordinal 因此不是数组顺序。
    expect(rowsAt(journal, "report#2")).toEqual([
      { dim: "gamma", status: "done" },
      { dim: "alpha", status: "done" },
    ]);
    // report#1 在 await 之前，恒按数组顺序。
    expect(rowsAt(journal, "report#1")).toEqual([
      { dim: "alpha", status: "researching" },
      { dim: "beta", status: "researching" },
      { dim: "gamma", status: "researching" },
    ]);

    // ——— 第二世：同一份脚本、同一份 journal。———
    const driver2 = new FakeDriver(journal);
    const e2 = engineOver(journal, driver2);
    const replayed = fanOut(e2);
    await flush();

    // 缓存结算按记录的完成顺序释放，而不是准入顺序。
    expect(driver2.cachedSettleOrder()).toEqual(["ask#1@3", "ask#1@1"]);
    // 在飞的那一条重新 live 派发，其余零派发。
    expect(driver2.startedInstanceKeys()).toEqual(new Set(["ask#1@2"]));

    e2.askTurnEnded(inst("ask#1", 2), "r2");
    await expect(replayed).resolves.toEqual(["r1", "r2", "r3"]);

    // run 没有因为 InputHashMismatch 死掉，journal 里的 report 行一行没动。
    expect(journal.getRun(RUN)?.failure).toBeUndefined();
    expect(rowsAt(journal, "report#2")).toEqual([
      { dim: "gamma", status: "done" },
      { dim: "alpha", status: "done" },
      { dim: "beta", status: "done" },
    ]);
    // 重放命中的 report 静默跳过，只有这一世新跑到的那条发事件。
    expect(driver2.eventsOfType("report").map((e) => e.item)).toEqual([
      { dim: "beta", status: "done" },
    ]);

    e2.complete("done");
    await expect(e2.settled).resolves.toMatchObject({ status: "completed" });
  });

  it("keeps the same schedule on a third life", async () => {
    const journal = new InMemoryJournalStore();

    const driver1 = new FakeDriver(journal);
    const e1 = engineOver(journal, driver1);
    void fanOut(e1).catch(() => {}); // stop() 会以 Cancelled 拒绝这一世的扇出
    await flush();
    e1.askTurnEnded(inst("ask#1", 2), "r2");
    await flush();
    e1.askTurnEnded(inst("ask#1", 3), "r3");
    await flush();
    e1.stop("interrupted");
    await flush();

    // 第二世：两条命中、一条重跑并结算，再次被打断。
    const driver2 = new FakeDriver(journal);
    const e2 = engineOver(journal, driver2);
    void fanOut(e2).catch(() => {});
    await flush();
    expect(driver2.cachedSettleOrder()).toEqual(["ask#1@2", "ask#1@3"]);
    e2.askTurnEnded(inst("ask#1", 1), "r1");
    await flush();
    e2.stop("interrupted");
    await flush();

    // 第三世：三条全命中。首生次序（2、3）仍在前，第二世才跑完的 1 排在其后。
    const driver3 = new FakeDriver(journal);
    const e3 = engineOver(journal, driver3);
    const replayed = fanOut(e3);
    await flush();
    expect(driver3.cachedSettleOrder()).toEqual(["ask#1@2", "ask#1@3", "ask#1@1"]);
    expect(driver3.startAskCount()).toBe(0);
    await expect(replayed).resolves.toEqual(["r1", "r2", "r3"]);
    expect(journal.getRun(RUN)?.failure).toBeUndefined();
    expect(driver3.eventsOfType("report")).toEqual([]);
  });

  it("never leaves a parked hit hanging when the run settles mid-replay", async () => {
    // 闸门的兜底：队首那条还没被认领时 run 就被停了——挂着的命中必须照常兑现（否则脚本那侧
    // 的 promise 永不落地），而且它的 cached 事件要排在 `run-settled` **之前**。
    const journal = new InMemoryJournalStore();

    const driver1 = new FakeDriver(journal);
    const e1 = engineOver(journal, driver1);
    const one = e1.createActor("actor#1", "one");
    const two = e1.createActor("actor#1", "two");
    const p1 = e1.ask("ask#1", one, "A");
    const p2 = e1.ask("ask#1", two, "B");
    await flush();
    // 第二条先结算，于是记录的次序是 [ask#1@2, ask#1@1]。
    e1.askTurnEnded(inst("ask#1", 2), "rB");
    await flush();
    e1.askTurnEnded(inst("ask#1", 1), "rA");
    await expect(Promise.all([p1, p2])).resolves.toEqual(["rA", "rB"]);
    e1.stop("interrupted");
    await flush();

    // 第二世只跑到第一条就被停：它在等 ask#1@2 让位，谁也不会来认领了。
    const driver2 = new FakeDriver(journal);
    const e2 = engineOver(journal, driver2);
    const actor = e2.createActor("actor#1", "one");
    const replayed = e2.ask("ask#1", actor, "A");
    await flush();
    expect(driver2.cachedSettleOrder()).toEqual([]);

    e2.stop("user");
    await expect(replayed).resolves.toBe("rA");
    const types = driver2.events.map((e) => e.type);
    expect(types.indexOf("node-settled")).toBeLessThan(types.indexOf("run-settled"));
  });

  it("still fails loudly when the script really is nondeterministic", async () => {
    const journal = new InMemoryJournalStore();

    const driver1 = new FakeDriver(journal);
    const e1 = engineOver(journal, driver1);
    const actor1 = e1.createActor("actor#1", "one");
    const p1 = e1.ask("ask#1", actor1, "first instructions");
    await flush();
    e1.askTurnEnded(inst("ask#1"), "r1");
    await p1;
    e1.stop("interrupted");
    await flush();

    // 同一个站点、同一个 ordinal，指令变了——闸门放行之前的防御性校验照旧大声失败。
    const driver2 = new FakeDriver(journal);
    const e2 = engineOver(journal, driver2);
    const actor2 = e2.createActor("actor#1", "one");
    await expect(e2.ask("ask#1", actor2, "other instructions")).rejects.toMatchObject({
      code: "InputHashMismatch",
    });
    await expect(e2.settled).resolves.toMatchObject({ status: "errored" });
  });
});

describe("replay settle order — world reads and artifacts", () => {
  it("releases cached world reads in the journaled order", async () => {
    const journal = new InMemoryJournalStore();
    const seen: string[] = [];

    const script = async (engine: WorkflowEngine): Promise<void> => {
      await Promise.all(
        ["a", "b"].map(async (name) => {
          const files = await engine.worldRead("world#1", "glob", [name]);
          seen.push(String(files));
          engine.report("report#1", { name, files });
        }),
      );
    };

    const driver1 = new FakeDriver(journal);
    const e1 = engineOver(journal, driver1);
    void script(e1).catch(() => {});
    await flush();
    // 第二个 glob 先返回。
    driver1.worldReads[1]?.deferred.resolve("files-b");
    await flush();
    driver1.worldReads[0]?.deferred.resolve("files-a");
    await flush();
    expect(rowsAt(journal, "report#1")).toEqual([
      { name: "b", files: "files-b" },
      { name: "a", files: "files-a" },
    ]);
    e1.stop("interrupted");

    seen.length = 0;
    const driver2 = new FakeDriver(journal);
    const e2 = engineOver(journal, driver2);
    await script(e2);
    expect(driver2.worldReads).toEqual([]);
    expect(seen).toEqual(["files-b", "files-a"]);
    expect(journal.getRun(RUN)?.failure).toBeUndefined();
    expect(driver2.eventsOfType("report")).toEqual([]);
  });

  it("gates content artifacts and never waits on a preset declaration", async () => {
    const journal = new InMemoryJournalStore();

    const script = async (engine: WorkflowEngine): Promise<void> => {
      // 预置声明是同步 void：它落 journal 行、发 artifact-published，却永远不会来认领闸门。
      engine.declareArtifact("artifact#0", "board", [
        "board-1",
        { key: "dim", status: "status", columns: ["doing", "done"] },
      ]);
      await Promise.all(
        ["a", "b"].map(async (name) => {
          await engine.publishArtifact("artifact#1", "markdown", [`doc-${name}`, `# ${name}`]);
          engine.report("report#1", { name });
        }),
      );
    };

    const driver1 = new FakeDriver(journal, { deferArtifactPublishes: true });
    const e1 = engineOver(journal, driver1);
    void script(e1).catch(() => {});
    await flush();
    const [first, second] = driver1.artifactDeferrals;
    // 第二个发布先完成。
    second?.resolve(driver1.artifactStore.get("doc-b@1")!);
    await flush();
    first?.resolve(driver1.artifactStore.get("doc-a@1")!);
    await flush();
    expect(rowsAt(journal, "report#1")).toEqual([{ name: "b" }, { name: "a" }]);
    e1.stop("interrupted");

    const driver2 = new FakeDriver(journal, { deferArtifactPublishes: true });
    const e2 = engineOver(journal, driver2);
    await script(e2);
    expect(driver2.artifactPublishes).toEqual([]);
    expect(journal.getRun(RUN)?.failure).toBeUndefined();
    expect(driver2.eventsOfType("report")).toEqual([]);
  });
});

describe("ReplaySettleOrder", () => {
  const key = (siteId: string, ordinal: number): string => refToString({ siteId, ordinal });

  it("releases parked entries in the recorded order, never inside the call that parked one", async () => {
    const gate = new ReplaySettleOrder([key("ask#1", 2), key("ask#1", 1)]);
    const released: string[] = [];
    gate.hold(inst("ask#1", 1), () => released.push("1"));
    expect(released).toEqual([]);
    // 轮到了也**不在这次调用里**投递：调用方的 await 还没挂上去（见 enqueue 的说明）。
    gate.hold(inst("ask#1", 2), () => released.push("2"));
    expect(released).toEqual([]);
    await flush();
    expect(released).toEqual(["2", "1"]);
  });

  it("passes through instances it has no entry for", () => {
    const gate = new ReplaySettleOrder([key("ask#1", 1)]);
    const released: string[] = [];
    gate.hold(inst("ask#9", 7), () => released.push("unknown"));
    expect(released).toEqual(["unknown"]);
  });

  it("opens for good on settlement, draining what is parked in recorded order", () => {
    const gate = new ReplaySettleOrder([key("ask#1", 1), key("ask#1", 2), key("ask#1", 3)]);
    const released: string[] = [];
    gate.hold(inst("ask#1", 3), () => released.push("3"));
    gate.hold(inst("ask#1", 2), () => released.push("2"));
    expect(released).toEqual([]);
    gate.open();
    expect(released).toEqual(["2", "3"]);
    gate.hold(inst("ask#1", 1), () => released.push("1"));
    expect(released).toEqual(["2", "3", "1"]);
  });
});

describe("recoverSettleOrder", () => {
  function seed(): InMemoryJournalStore {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 4 },
      spentTokens: 0,
      status: "running",
    });
    return journal;
  }

  it("takes the first settle of each instance and keeps only terminal, promise-returning rows", () => {
    const journal = seed();
    const put = (
      siteId: string,
      ordinal: number,
      kind: "ask" | "report",
      status: "completed" | "running",
      result?: unknown,
    ): void => {
      journal.putNode({
        runId: RUN,
        siteId,
        ordinal,
        kind,
        inputHash: "h",
        status,
        ...(result === undefined ? {} : { result }),
      });
    };
    put("ask#1", 1, "ask", "completed");
    put("ask#1", 2, "ask", "completed");
    put("ask#1", 3, "ask", "running"); // 被打断，重跑而不是释放
    put("report#1", 1, "report", "completed"); // void，不进次序表

    journal.appendEvent(RUN, { type: "node-settled", instance: inst("ask#1", 2), outcome: "ok" });
    journal.appendEvent(RUN, { type: "report", instance: inst("report#1", 1), item: {} });
    journal.appendEvent(RUN, { type: "node-settled", instance: inst("ask#1", 1), outcome: "ok" });
    journal.appendEvent(RUN, {
      type: "node-settled",
      instance: inst("ask#1", 3),
      outcome: "cancelled",
    });
    // 第二世重放同样发事件：首生次序优先，重复不再入表。
    journal.appendEvent(RUN, {
      type: "node-settled",
      instance: inst("ask#1", 1),
      outcome: "ok",
      cached: true,
    });

    expect(recoverSettleOrder(journal, RUN).recorded()).toEqual(["ask#1@2", "ask#1@1"]);
  });

  it("keeps content artifacts and drops preset declarations", () => {
    const journal = seed();
    journal.putNode({
      runId: RUN,
      siteId: "artifact#1",
      ordinal: 1,
      kind: "artifact",
      inputHash: "h",
      status: "completed",
      artifactId: "doc",
      result: { id: "doc", kind: "markdown", version: 1 },
    });
    journal.putNode({
      runId: RUN,
      siteId: "artifact#0",
      ordinal: 1,
      kind: "artifact",
      inputHash: "h",
      status: "completed",
      artifactId: "board",
      result: { id: "board", kind: "board", version: 1 },
    });
    journal.appendEvent(RUN, {
      type: "artifact-published",
      instance: inst("artifact#0", 1),
      artifact: { id: "board", kind: "board", version: 1 },
    });
    journal.appendEvent(RUN, {
      type: "artifact-published",
      instance: inst("artifact#1", 1),
      artifact: { id: "doc", kind: "markdown", version: 1 },
    });

    expect(recoverSettleOrder(journal, RUN).recorded()).toEqual(["artifact#1@1"]);
  });

  it("is empty for a journal whose events predate the rule", () => {
    const journal = seed();
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      inputHash: "h",
      status: "completed",
      result: "r",
    });
    expect(recoverSettleOrder(journal, RUN).recorded()).toEqual([]);
  });
});
