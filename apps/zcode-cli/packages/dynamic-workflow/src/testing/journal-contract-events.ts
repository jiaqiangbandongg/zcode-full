/**
 * 修复原因：journal-contract.ts 顶到 oxlint max-lines 上限（400 行），把事件（追加序号、resume 续号、cursor 分页、按 run 隔离）的用例拆到本文件；
 * 公开面仍从 journal-contract.ts 导出（`runJournalStoreContract` 按原顺序调用各主题的注册函数）。
 *
 * 注意：这里只登记 `it(...)`，不另开 describe——套件的分组与用例顺序必须与拆分前逐字相同。
 */

import { expect, it } from "vitest";
import type { JournalStorePort } from "../engine/index.js";
import { baseRun, logs } from "./journal-contract-helpers.js";

export function registerEventCases(factory: () => JournalStorePort): void {
  it("appends events with monotonic sequence and lists them in order", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const a = store.appendEvent("r1", { type: "log", message: "one" });
    const b = store.appendEvent("r1", { type: "log", message: "two" });
    expect(a.sequence).toBe(0);
    expect(b.sequence).toBe(1);
    const events = store.listEvents("r1", { types: "all", reportItems: "all" });
    expect(events.map((e) => e.sequence)).toEqual([0, 1]);
    expect(events.map((e) => (e.event.type === "log" ? e.event.message : ""))).toEqual([
      "one",
      "two",
    ]);
  });

  it("stamps timeCreated on append and gives the same instant back on read", () => {
    // 事件日志里唯一的时钟（docs/execution-engine.md「The journal」）：日志行的年龄、子代理上一次
    // 动作的时刻都只能从它算。两个实现都必须填——让读者现取 Date.now() 兜底，会把一次冷重放里
    // 一周前的整段历史全标成「刚刚」。追加路径与读回路径必须给同一个数，否则同一条事件两面不一。
    const store = factory();
    store.createRun(baseRun("r1"));
    const before = Date.now();
    const appended = store.appendEvent("r1", { type: "log", message: "one" });
    const after = Date.now();
    expect(appended.timeCreated).toBeTypeOf("number");
    expect(appended.timeCreated!).toBeGreaterThanOrEqual(before);
    expect(appended.timeCreated!).toBeLessThanOrEqual(after);

    const [read] = store.listEvents("r1", { types: "all", reportItems: "all" });
    expect(read?.timeCreated).toBe(appended.timeCreated);
  });

  it("throws when appending an event to an unknown run", () => {
    // 孤儿事件写进去也永远读不回来（listEvents 按 runId 取），与 putActor/putNode 一样
    // 属于契约破坏，必须当场大声失败。SQLite 侧由 dwf_event 的 FK 保证同一语义。
    const store = factory();
    expect(() => store.appendEvent("nope", { type: "log", message: "orphan" })).toThrow();
  });

  it("continues event sequence monotonically over a pre-populated store (resume case)", () => {
    // resume 语义：新引擎接管一个已有事件的 store 时，appendEvent 必须从既有最大序号之后继续，
    // 既不重置也不复用序号。内存实现天然满足；此断言逼迫阶段二的 SQLite 实现走同一 MAX(sequence)+1 语义。
    const store = factory();
    store.createRun(baseRun("r1"));
    store.appendEvent("r1", { type: "log", message: "pre-0" });
    store.appendEvent("r1", { type: "log", message: "pre-1" });

    // 模拟 resume：同一 store 上继续追加（生产中是另一个引擎实例接管）。
    const resumed = store.appendEvent("r1", { type: "log", message: "post" });
    expect(resumed.sequence).toBe(2);

    const sequences = store
      .listEvents("r1", { types: "all", reportItems: "all" })
      .map((e) => e.sequence);
    expect(sequences).toEqual([0, 1, 2]);
    // 序号唯一（无复用）且单调递增。
    expect(new Set(sequences).size).toBe(sequences.length);
    for (let i = 1; i < sequences.length; i++)
      expect(sequences[i]!).toBeGreaterThan(sequences[i - 1]!);
  });

  it("pages events with afterSequence as a strictly-greater cursor", () => {
    // cursor 是"已读到的最后一个 sequence"，而不是偏移量：afterSequence: 0 必须跳过
    // sequence 0（它已被读过），而不是从第 0 个开始。sequence 从 0 起，所以把 cursor
    // 当偏移量的实现在这条断言上才会露馅——第一页会重复一条。
    const store = factory();
    store.createRun(baseRun("r1"));
    for (const message of ["e0", "e1", "e2"]) store.appendEvent("r1", { type: "log", message });

    expect(logs(store.listEvents("r1", { types: "all", reportItems: "all" }))).toEqual([
      "e0",
      "e1",
      "e2",
    ]);
    expect(
      logs(store.listEvents("r1", { types: "all", reportItems: "all", afterSequence: 0 })),
    ).toEqual(["e1", "e2"]);
    expect(
      logs(store.listEvents("r1", { types: "all", reportItems: "all", afterSequence: 1 })),
    ).toEqual(["e2"]);
    expect(store.listEvents("r1", { types: "all", reportItems: "all", afterSequence: 2 })).toEqual(
      [],
    );
  });

  it("returns an empty page for an out-of-range cursor instead of throwing", () => {
    // 详情页在 lastEventSequence 抬升时重取；投影与 journal 之间存在竞态窗口，
    // 客户端拿着一个尚未存在的 cursor 回来是正常时序，不是错误。
    const store = factory();
    store.createRun(baseRun("r1"));
    store.appendEvent("r1", { type: "log", message: "only" });
    expect(store.listEvents("r1", { types: "all", reportItems: "all", afterSequence: 99 })).toEqual(
      [],
    );
    // 未知 run 同样是空页：listEvents 全量形态今天就是这个语义，加 cursor 不改它。
    expect(
      store.listEvents("nope", { types: "all", reportItems: "all", afterSequence: 0 }),
    ).toEqual([]);
  });

  it("caps a page at limit and keeps it anchored at the cursor", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    for (let i = 0; i < 5; i++) store.appendEvent("r1", { type: "log", message: `e${i}` });

    expect(logs(store.listEvents("r1", { types: "all", reportItems: "all", limit: 2 }))).toEqual([
      "e0",
      "e1",
    ]);
    expect(
      logs(
        store.listEvents("r1", { types: "all", reportItems: "all", afterSequence: 1, limit: 2 }),
      ),
    ).toEqual(["e2", "e3"]);
    // limit 超过剩余条数时给出剩余全部，不补空位。
    expect(
      logs(
        store.listEvents("r1", { types: "all", reportItems: "all", afterSequence: 3, limit: 10 }),
      ),
    ).toEqual(["e4"]);
    expect(store.listEvents("r1", { types: "all", reportItems: "all", limit: 0 })).toEqual([]);
  });

  it("walks every event exactly once when paging by cursor (no overlap, no gap)", () => {
    // 分页的整体性质：逐页推进 cursor 走完整条 journal，结果必须与一次性全量读逐字相同。
    // 「差一」错误（>= 而非 >、或 limit 与 cursor 相互干扰）只会在这条断言上暴露。
    const store = factory();
    store.createRun(baseRun("r1"));
    const total = 7;
    for (let i = 0; i < total; i++) store.appendEvent("r1", { type: "log", message: `e${i}` });

    const walked: number[] = [];
    let cursor: number | undefined;
    for (let guard = 0; guard <= total; guard++) {
      const page = store.listEvents("r1", {
        types: "all",
        reportItems: "all",
        afterSequence: cursor,
        limit: 3,
      });
      if (page.length === 0) break;
      for (const stored of page) walked.push(stored.sequence);
      cursor = page[page.length - 1]!.sequence;
    }

    expect(walked).toEqual(
      store.listEvents("r1", { types: "all", reportItems: "all" }).map((e) => e.sequence),
    );
    expect(new Set(walked).size).toBe(total);
  });

  it("keeps the cursor valid across resume", () => {
    // resume 后 sequence 从既有最大值之后继续，所以 run 之前记下的 cursor 依然只
    // 取到新事件；若实现按"每 run 每次从 0 重编号"或按行 id 而非 sequence 排序，
    // 客户端会重收旧事件或漏掉新事件。
    const store = factory();
    store.createRun(baseRun("r1"));
    store.appendEvent("r1", { type: "log", message: "pre-0" });
    store.appendEvent("r1", { type: "log", message: "pre-1" });
    const cursor = store.listEvents("r1", { types: "all", reportItems: "all" }).at(-1)!.sequence;

    // 模拟 resume：另一个引擎实例接管同一个 store 继续追加。
    store.updateRunStatus("r1", "running");
    store.appendEvent("r1", { type: "log", message: "post-0" });
    store.appendEvent("r1", { type: "log", message: "post-1" });

    const tail = store.listEvents("r1", {
      types: "all",
      reportItems: "all",
      afterSequence: cursor,
    });
    expect(logs(tail)).toEqual(["post-0", "post-1"]);
    expect(tail.map((e) => e.sequence)).toEqual([cursor + 1, cursor + 2]);
  });

  it("scopes event pages per runId", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.createRun(baseRun("r2"));
    store.appendEvent("r1", { type: "log", message: "r1-0" });
    store.appendEvent("r2", { type: "log", message: "r2-0" });
    store.appendEvent("r2", { type: "log", message: "r2-1" });
    // 每个 run 的 sequence 各自从 0 起，因此 cursor 必须与 runId 一同过滤。
    expect(
      logs(store.listEvents("r1", { types: "all", reportItems: "all", afterSequence: 0 })),
    ).toEqual([]);
    expect(
      logs(store.listEvents("r2", { types: "all", reportItems: "all", afterSequence: 0 })),
    ).toEqual(["r2-1"]);
  });
}
