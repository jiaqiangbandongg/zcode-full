/**
 * 读面选项的契约用例（docs/execution-engine.md「Reading the journal」）：kinds / withResult /
 * limit / maxResultBytes / countNodes / sumResultBytes / types / reportItems / 按名取子代理。两个实现（内存、SQLite）必须逐字同
 * 语义——读者按这些选项把过滤下推到存储层，任何一侧偷偷退回「读全表」或给出不同的顺序，
 * 冷回放与 GetWorkflowRun 就会在两种部署上归约出不同的状态。
 *
 * 注意：这里只登记 `it(...)`，不另开 describe（与兄弟模块同规）。
 */

import { expect, it } from "vitest";
import type { JournalStorePort, NodeRecord, RunEvent } from "../engine/index.js";
import { baseRun } from "./journal-contract-helpers.js";

function node(
  siteId: string,
  kind: NodeRecord["kind"],
  extra: Partial<NodeRecord> = {},
): NodeRecord {
  return {
    runId: "r1",
    siteId,
    ordinal: 1,
    kind,
    inputHash: `h-${siteId}`,
    status: "completed",
    result: { of: siteId },
    ...extra,
  };
}

/** 一条 run：ask、report×3（第二条带标签）、world-read、artifact，按这个顺序落库。 */
function seedNodes(store: JournalStorePort): void {
  store.createRun(baseRun("r1"));
  store.putNode(node("ask#1", "ask", { actorSiteId: "actor#1", actorOrdinal: 1, actorSeq: 0 }));
  store.putNode(node("report#1", "report"));
  store.putNode(node("report#2", "report", { artifactId: "chart" }));
  store.putNode(node("files.grep#1", "world-read", { input: { op: "grep", args: ["x"] } }));
  store.putNode(node("report#3", "report"));
  store.putNode(node("artifact#1", "artifact", { artifactId: "chart" }));
}

function report(siteId: string, item: unknown, artifactId?: string): RunEvent {
  return {
    type: "report",
    instance: { siteId, ordinal: 1 },
    item,
    ...(artifactId === undefined ? {} : { artifactId }),
  };
}

function reportItemOf(event: RunEvent): { has: boolean; item?: unknown } {
  if (event.type !== "report") throw new Error(`not a report: ${event.type}`);
  return "item" in event ? { has: true, item: event.item } : { has: false };
}

export function registerReadCases(factory: () => JournalStorePort): void {
  it('filters nodes by kind in insertion order, and "all" / [] mean everything / nothing', () => {
    const store = factory();
    seedNodes(store);
    const sites = (rows: NodeRecord[]): string[] => rows.map((row) => row.siteId);
    expect(sites(store.listNodes("r1", { kinds: ["report"], withResult: true }))).toEqual([
      "report#1",
      "report#2",
      "report#3",
    ]);
    expect(
      sites(store.listNodes("r1", { kinds: ["ask", "world-read"], withResult: true })),
    ).toEqual(["ask#1", "files.grep#1"]);
    expect(sites(store.listNodes("r1", { kinds: "all", withResult: true }))).toEqual([
      "ask#1",
      "report#1",
      "report#2",
      "files.grep#1",
      "report#3",
      "artifact#1",
    ]);
    expect(store.listNodes("r1", { kinds: [], withResult: true })).toEqual([]);
    expect(store.listNodes("nope", { kinds: "all", withResult: true })).toEqual([]);
  });

  it("keeps a row's place when it is upserted again", () => {
    // 准入 running → 结算 completed 是同一条 upsert：行的顺序（id）不能因为第二次写而挪到末尾，
    // 否则「按插入顺序」对每个结算过的节点都是假话。
    const store = factory();
    seedNodes(store);
    store.putNode(
      node("ask#1", "ask", { status: "failed", actorSiteId: "actor#1", actorOrdinal: 1 }),
    );
    const rows = store.listNodes("r1", { kinds: "all", withResult: false });
    expect(rows[0]?.siteId).toBe("ask#1");
    expect(rows[0]?.status).toBe("failed");
  });

  it("leaves result out without touching any other column when withResult is false", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const full: NodeRecord = {
      runId: "r1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: "h",
      status: "completed",
      result: { big: "x".repeat(100) },
      stats: { tokens: 12, toolCalls: 3, turns: 2 },
      messageBoundary: 4,
    };
    store.putNode(full);
    const { result: _result, ...rest } = full;
    void _result;
    const [slim] = store.listNodes("r1", { kinds: "all", withResult: false });
    expect(slim).toEqual(rest);
    expect(slim).not.toHaveProperty("result");
    expect(store.getNode("r1", "ask#1", 1, { withResult: false })).toEqual(rest);
    // 点查缺省读整行。
    expect(store.getNode("r1", "ask#1", 1)).toEqual(full);
    expect(store.getNode("r1", "ask#1", 1, { withResult: true })).toEqual(full);
  });

  it("keeps a null result as null when results are read", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.putNode(node("report#1", "report", { result: null }));
    const [row] = store.listNodes("r1", { kinds: ["report"], withResult: true });
    expect(row).toHaveProperty("result", null);
  });

  it("pages nodes with limit after the kind filter, in insertion order", () => {
    const store = factory();
    seedNodes(store);
    const rows = store.listNodes("r1", { kinds: ["report"], withResult: true, limit: 2 });
    expect(rows.map((row) => row.siteId)).toEqual(["report#1", "report#2"]);
    expect(rows[1]?.result).toEqual({ of: "report#2" });
    expect(store.listNodes("r1", { kinds: ["report"], withResult: true, limit: 0 })).toEqual([]);
  });

  it("counts nodes of one kind without listing them", () => {
    const store = factory();
    seedNodes(store);
    expect(store.countNodes("r1", "report")).toBe(3);
    expect(store.countNodes("r1", "ask")).toBe(1);
    expect(store.countNodes("r1", "world-run")).toBe(0);
    expect(store.countNodes("nope", "report")).toBe(0);
  });

  it("sums the UTF-8 bytes of one kind's results without listing them", () => {
    // resume 靠它恢复报告的 run 级字节计数：两个实现必须用同一把尺——`JSON.stringify(result)`
    // 的 UTF-8 字节（SQLite 侧就是 result_json 的长度），多字节字符按字节算，没有结果的行计 0。
    const store = factory();
    store.createRun(baseRun("r1"));
    const bytes = (value: unknown): number =>
      new TextEncoder().encode(JSON.stringify(value)).length;
    store.putNode(node("report#1", "report", { result: { text: "abc" } }));
    store.putNode(node("report#2", "report", { result: "中文" }));
    store.putNode(node("report#3", "report", { result: null }));
    store.putNode(node("ask#1", "ask", { status: "running", result: undefined }));
    expect(store.sumResultBytes("r1", "report")).toBe(
      bytes({ text: "abc" }) + bytes("中文") + bytes(null),
    );
    expect(store.sumResultBytes("r1", "ask")).toBe(0);
    expect(store.sumResultBytes("r1", "world-run")).toBe(0);
    expect(store.sumResultBytes("nope", "report")).toBe(0);
  });

  it("stops a node read before the row that would pass maxResultBytes, but always keeps the first", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const pad = "x".repeat(100);
    for (let index = 1; index <= 4; index += 1) {
      store.putNode(node(`report#${index}`, "report", { result: { index, pad } }));
    }
    const one = new TextEncoder().encode(JSON.stringify({ index: 1, pad })).length;
    const sites = (maxResultBytes: number, limit?: number): string[] =>
      store
        .listNodes("r1", {
          kinds: ["report"],
          withResult: true,
          maxResultBytes,
          ...(limit === undefined ? {} : { limit }),
        })
        .map((row) => row.siteId);
    // 两行半的预算放得下两行。
    expect(sites(one * 2 + one / 2)).toEqual(["report#1", "report#2"]);
    // 恰好两行也放得下（超过才收尾，等于不收）。
    expect(sites(one * 2)).toEqual(["report#1", "report#2"]);
    // 一行都放不下时第一行照样在：快照不会因为一条大报告而一条都不带。
    expect(sites(1)).toEqual(["report#1"]);
    // limit 与字节界同时生效，先到先停。
    expect(sites(one * 10, 3)).toEqual(["report#1", "report#2", "report#3"]);
    expect(
      store
        .listNodes("r1", { kinds: ["report"], withResult: true, maxResultBytes: one * 2 })
        .map((row) => row.result),
    ).toEqual([
      { index: 1, pad },
      { index: 2, pad },
    ]);
  });

  it("filters actors by name and leaves the persona out when asked", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const persona = { name: "judge", system: "You judge." };
    store.putActor({
      runId: "r1",
      siteId: "actor#1",
      ordinal: 1,
      name: "judge",
      persona,
      sessionId: "s1",
    });
    store.putActor({ runId: "r1", siteId: "actor#2", ordinal: 1, name: "scout", persona });
    store.putActor({ runId: "r1", siteId: "actor#1", ordinal: 2, name: "judge", persona });

    const judges = store.listActors("r1", { name: "judge", withPersona: false });
    expect(judges.map((actor) => `${actor.siteId}@${actor.ordinal}`)).toEqual([
      "actor#1@1",
      "actor#1@2",
    ]);
    expect(judges[0]).toEqual({
      runId: "r1",
      siteId: "actor#1",
      ordinal: 1,
      name: "judge",
      sessionId: "s1",
    });
    expect(judges[0]).not.toHaveProperty("persona");
    expect(store.listActors("r1", { name: "nobody", withPersona: true })).toEqual([]);
    const all = store.listActors("r1", { withPersona: true });
    expect(all).toHaveLength(3);
    expect(all[1]?.persona).toEqual(persona);
  });

  it("filters events by type in sequence order, before the cursor and the limit", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.appendEvent("r1", { type: "log", message: "a" }); // 0
    store.appendEvent("r1", { type: "usage-updated", spentTokens: 1 }); // 1
    store.appendEvent("r1", { type: "log", message: "b" }); // 2
    store.appendEvent("r1", {
      type: "import-cache-closed",
      instance: { siteId: "ask#1", ordinal: 1 },
      cause: "world-run",
    }); // 3
    store.appendEvent("r1", { type: "log", message: "c" }); // 4
    const seqs = (opts: Parameters<JournalStorePort["listEvents"]>[1]): number[] =>
      store.listEvents("r1", opts).map((stored) => stored.sequence);

    expect(seqs({ types: ["log"], reportItems: "all" })).toEqual([0, 2, 4]);
    expect(seqs({ types: ["import-cache-closed", "log"], reportItems: "all" })).toEqual([
      0, 2, 3, 4,
    ]);
    // limit 作用在过滤之后：前两条 log，而不是「前两条事件里的 log」。
    expect(seqs({ types: ["log"], reportItems: "all", limit: 2 })).toEqual([0, 2]);
    expect(seqs({ types: ["log"], reportItems: "all", afterSequence: 0, limit: 1 })).toEqual([2]);
    expect(seqs({ types: [], reportItems: "all" })).toEqual([]);
    expect(seqs({ types: "all", reportItems: "all" })).toEqual([0, 1, 2, 3, 4]);
  });

  it("strips the item from every report event after the Nth, keeping every other field", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.appendEvent("r1", report("report#1", { n: 1 })); // 0: rank 1
    store.appendEvent("r1", { type: "log", message: "between" }); // 1
    store.appendEvent("r1", report("report#1", null)); // 2: rank 2 — null 是合法 item
    store.appendEvent("r1", report("report#2", { n: 3 }, "chart")); // 3: rank 3
    store.appendEvent("r1", report("report#1", "four")); // 4: rank 4

    const events = store.listEvents("r1", { types: "all", reportItems: { limit: 2 } });
    expect(events.map((stored) => stored.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(reportItemOf(events[0]!.event)).toEqual({ has: true, item: { n: 1 } });
    expect(events[1]!.event).toEqual({ type: "log", message: "between" });
    expect(reportItemOf(events[2]!.event)).toEqual({ has: true, item: null });
    expect(reportItemOf(events[3]!.event)).toEqual({ has: false });
    expect(events[3]!.event).toEqual({
      type: "report",
      instance: { siteId: "report#2", ordinal: 1 },
      artifactId: "chart",
    });
    expect(reportItemOf(events[4]!.event)).toEqual({ has: false });
    expect(events[4]!.timeCreated).toBeTypeOf("number");

    const none = store.listEvents("r1", { types: ["report"], reportItems: { limit: 0 } });
    expect(none.map((stored) => reportItemOf(stored.event).has)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    const every = store.listEvents("r1", { types: ["report"], reportItems: "all" });
    expect(every.map((stored) => reportItemOf(stored.event).has)).toEqual([true, true, true, true]);
  });

  it("ranks report events over the whole run, not over the page being read", () => {
    // 「第几条报告」是 run 的事实：从 cursor 3 开始读，第 3 条报告仍然是第 3 条，
    // 不会因为它是这一页的第一条就把 item 带回来。
    const store = factory();
    store.createRun(baseRun("r1"));
    store.appendEvent("r1", report("report#1", 1)); // 0
    store.appendEvent("r1", report("report#1", 2)); // 1
    store.appendEvent("r1", { type: "log", message: "x" }); // 2
    store.appendEvent("r1", report("report#1", 3)); // 3
    store.appendEvent("r1", report("report#1", 4)); // 4

    const page = store.listEvents("r1", {
      types: ["report"],
      reportItems: { limit: 2 },
      afterSequence: 1,
    });
    expect(page.map((stored) => stored.sequence)).toEqual([3, 4]);
    expect(page.map((stored) => reportItemOf(stored.event).has)).toEqual([false, false]);
    const head = store.listEvents("r1", { types: ["report"], reportItems: { limit: 3 }, limit: 1 });
    expect(head.map((stored) => reportItemOf(stored.event))).toEqual([{ has: true, item: 1 }]);
  });
}
