/**
 * resume 的 journal 读形状（docs/execution-engine.md「Reading the journal」）：
 *
 * - 报告行只数不读：一个 run 可以有 65,536 条 report，resume 恢复它们的计数与重放它们的去重，
 *   都不需要把任何一条 item 读进内存；
 * - 节点表只读一次：每个 actor 的已记录 ask 数从 resume 已读好的 ask 行建表，而不是每注册一个
 *   actor 就整表读一遍（修复前是 O(actor × 行) 次解码）；
 * - 事件只读结算次序与导入关门判定要的那几种类型。
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  type AskSpec,
  type GetNodeOptions,
  type InstanceRef,
  type JournalStorePort,
  type ListEventsOptions,
  type ListNodesOptions,
  type NodeKind,
} from "../../src/engine/index.js";
import { FakeDriver, flush } from "./fake-driver.js";

const RUN = "run";
const ACTORS = 5;
const REPORTS = 40;

function inst(siteId: string, ordinal = 1): InstanceRef {
  return { siteId, ordinal };
}

const specs = new Map<string, AskSpec>([["ask#1", { typed: false } as AskSpec]]);

/** 转发到真 store、并记下每一次读的形状的 journal。 */
class RecordingJournal extends InMemoryJournalStore {
  readonly nodeReads: ListNodesOptions[] = [];
  readonly eventReads: ListEventsOptions[] = [];
  readonly pointReads: Array<{ siteId: string; opts: GetNodeOptions | undefined }> = [];
  readonly counts: NodeKind[] = [];
  readonly byteSums: NodeKind[] = [];
  recording = false;

  override listNodes(runId: string, opts: ListNodesOptions) {
    if (this.recording) this.nodeReads.push(opts);
    return super.listNodes(runId, opts);
  }

  override listEvents(runId: string, opts: ListEventsOptions) {
    if (this.recording) this.eventReads.push(opts);
    return super.listEvents(runId, opts);
  }

  override getNode(runId: string, siteId: string, ordinal: number, opts?: GetNodeOptions) {
    if (this.recording) this.pointReads.push({ siteId, opts });
    return super.getNode(runId, siteId, ordinal, opts);
  }

  override countNodes(runId: string, kind: NodeKind) {
    if (this.recording) this.counts.push(kind);
    return super.countNodes(runId, kind);
  }

  override sumResultBytes(runId: string, kind: NodeKind) {
    if (this.recording) this.byteSums.push(kind);
    return super.sumResultBytes(runId, kind);
  }
}

function engineOn(journal: JournalStorePort) {
  const driver = new FakeDriver(journal);
  const engine = new WorkflowEngine({
    runId: RUN,
    driver,
    caps: { maxConcurrency: 16 },
    askSpecs: specs,
    validate: () => [],
  });
  return { driver, engine };
}

/** 同一段「脚本」：ACTORS 个 actor 各问一次，然后报 REPORTS 条。第一世逐个作答，第二世全部命中。 */
async function runScript(
  engine: WorkflowEngine,
  answer: (i: number) => void,
): Promise<Array<Promise<unknown>>> {
  const asks: Array<Promise<unknown>> = [];
  for (let i = 0; i < ACTORS; i += 1) {
    const actor = engine.createActor("actor#1");
    asks.push(engine.ask("ask#1", actor, `task ${i}`));
  }
  await flush();
  for (let i = 0; i < ACTORS; i += 1) answer(i);
  await Promise.all(asks);
  for (let i = 0; i < REPORTS; i += 1)
    engine.report("report#1", { finding: i, pad: "x".repeat(64) });
  return asks;
}

describe("resume reads only what it uses", () => {
  it("never loads a report item, and reads the node table once however many actors register", async () => {
    const journal = new RecordingJournal();
    const first = engineOn(journal);
    await runScript(first.engine, (i) =>
      first.engine.askTurnEnded(inst("ask#1", i + 1), `answer ${i}`),
    );
    first.engine.stop("user");
    await first.engine.settled;

    journal.recording = true;
    const resumed = engineOn(journal);
    await runScript(resumed.engine, () => {});
    journal.recording = false;

    // 节点表：恰好两次读（工作行不带结果 + 产物行），与 actor 个数无关；没有一次读报告行。
    expect(journal.nodeReads).toEqual([
      { kinds: ["ask", "world-read", "world-run"], withResult: false },
      { kinds: ["artifact"], withResult: true },
    ]);
    // 报告的条数与字节数都是聚合：count(*) 与 sum(octet_length(result_json))。
    expect(journal.counts).toEqual(["report"]);
    expect(journal.byteSums).toEqual(["report"]);
    // 事件：只读结算次序要的类型，且 report item 一条不读。
    expect(journal.eventReads.length).toBeGreaterThan(0);
    for (const read of journal.eventReads) {
      expect(read.types).not.toBe("all");
      expect(read.reportItems).toEqual({ limit: 0 });
    }
    // 报告的重放去重只比对哈希。
    const reportPoints = journal.pointReads.filter((read) => read.siteId === "report#1");
    expect(reportPoints).toHaveLength(REPORTS);
    for (const read of reportPoints) expect(read.opts).toEqual({ withResult: false });

    // 行为不变：全部命中、一条 report 都不重发、没有派发新的 ask。
    expect(resumed.driver.eventsOfType("report")).toEqual([]);
    expect(resumed.driver.startAskCount()).toBe(0);
  });

  it("still holds a live ask behind the actor's recorded asks after a resume", async () => {
    // recordedCount 从 resume 读好的 ask 行建表：一个 actor 在第一世答完两问，第二世多问一句——
    // 第三问必须排在两条命中之后才派发（hold 规则），而且只派发它自己。
    const journal = new InMemoryJournalStore();
    const first = engineOn(journal);
    const actor = first.engine.createActor("actor#1");
    const a = first.engine.ask("ask#1", actor, "one");
    await flush();
    first.engine.askTurnEnded(inst("ask#1", 1), "r1");
    await a;
    const b = first.engine.ask("ask#1", actor, "two");
    await flush();
    first.engine.askTurnEnded(inst("ask#1", 2), "r2");
    await b;
    first.engine.stop("user");
    await first.engine.settled;

    const resumed = engineOn(journal);
    const again = resumed.engine.createActor("actor#1");
    const hits = [
      resumed.engine.ask("ask#1", again, "one"),
      resumed.engine.ask("ask#1", again, "two"),
    ];
    const live = resumed.engine.ask("ask#1", again, "three");
    await expect(Promise.all(hits)).resolves.toEqual(["r1", "r2"]);
    await flush();
    expect(resumed.driver.startAskCount()).toBe(1);
    expect(resumed.driver.startAsks[0]?.instance).toEqual(inst("ask#1", 3));
    resumed.engine.askTurnEnded(inst("ask#1", 3), "r3");
    await expect(live).resolves.toBe("r3");
  });
});
