/**
 * Resume e2e：先把脚本跑到完成、落一份 journal；再以**全新子进程** + 同一 journal + 一个
 * "任何 startAsk 都算失败"的 driver 重跑——必须纯 replay 完成，零 driver 派发（journal 命中短路）。
 * 见 docs/execution-engine.md 的 "Resume" 与 "Journal-write timing"。
 */

import { describe, expect, it } from "vitest";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import { runScript } from "./helpers.js";

const RUN = "run";

const SCRIPT = [
  "interface Verdict { approved: boolean; reason: string; }",
  'const paths = await files.glob("src/**/*.ts");',
  "const verdicts = await Promise.all(",
  // 逐元素名：fan-out 里每个元素都是一个新 actor，共用一个静态名会撞运行期的
  // DuplicateActorName（编译期另有 9005 的 fan-out 子句，见 analysis/actor-names.ts）。
  '  paths.map((p) => agent(`reviewer-${p}`).ask<Verdict>(`Review ${p}`)),',
  ");",
  'const lead = agent("lead");',
  "const summary = await lead.ask(`Reviewed ${paths.length} files`);",
  "return { reviewed: paths.length, summary, rejected: verdicts.filter((v) => !v.approved).length };",
].join("\n");

describe("e2e — resume by pure replay", () => {
  it("re-runs over a populated journal with a fresh child and zero driver dispatches", async () => {
    const paths = ["src/a.ts", "src/b.ts"];
    const journal = new InMemoryJournalStore();

    // 第一趟：live 执行，落 journal。
    const first = await runScript(SCRIPT, {
      journal,
      worldReads: () => paths,
      asks: {
        "ask#1": ({ message }) => ({
          type: "submit",
          payload: { approved: !message.instructions.includes("src/b.ts"), reason: "r" },
        }),
        "ask#2": () => ({ type: "text", finalText: "all reviewed" }),
      },
    });
    expect(first.settlement).toEqual({
      status: "completed",
      artifact: { reviewed: 2, summary: "all reviewed", rejected: 1 },
    });
    expect(first.driver.startAskCount()).toBe(3); // 2 review + 1 summary

    // 第二趟：全新子进程 + 同一 journal；driver 任何 live 效应都视为失败（应纯 replay）。
    const second = await runScript(SCRIPT, {
      journal,
      worldReads: () => {
        throw new Error("resume 不应触发 world-read（应 journal 命中）");
      },
      onStartAsk: (instance) => {
        throw new Error(`resume 不应 startAsk：${instance.siteId}@${instance.ordinal}`);
      },
    });

    // 逐字节相同的 artifact，且零派发。
    expect(second.settlement).toEqual(first.settlement);
    expect(second.driver.startAskCount()).toBe(0);
    expect(second.driver.sessionCreations).toHaveLength(0);
    // replay 命中以 cached 结算事件呈现。
    const cached = second.driver.eventsOfType("node-settled").filter((e) => e.cached === true);
    expect(cached.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps the first run's journaled node results intact on resume", async () => {
    const journal = new InMemoryJournalStore();
    await runScript(SCRIPT, {
      journal,
      worldReads: () => ["only.ts"],
      asks: {
        "ask#1": () => ({ type: "submit", payload: { approved: true, reason: "clean" } }),
        "ask#2": () => ({ type: "text", finalText: "done" }),
      },
    });
    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.result).toEqual({ approved: true, reason: "clean" });

    await runScript(SCRIPT, {
      journal,
      worldReads: () => {
        throw new Error("no world-read on resume");
      },
      onStartAsk: () => {
        throw new Error("no dispatch on resume");
      },
    });
    // resume 后节点结果不变。
    expect(journal.getNode(RUN, "ask#1", 1)?.result).toEqual({ approved: true, reason: "clean" });
  });

  it("re-dispatches the interrupted ask on a re-created actor session after a cancel", async () => {
    // cancel & resume 特性的端到端形态：首趟在 ask#2 执行中被取消（journal 留 running 记录 +
    // actor 带 sessionId），第二趟必须（a）短路 ask#1、（b）经 driver **重建** actor 会话、
    // （c）重新派发 ask#2 并跑完。断言 (b) 是本用例的存在理由：registerActor 若从 journal
    // 短路会话，生产 driver 的 sessions map 为空，重派发在真实 driver 上必以「未知会话」失败。
    const TWO_ASKS = [
      'const worker = agent("worker");',
      'const first = await worker.ask("first task");',
      "const second = await worker.ask(`second after ${first}`);",
      "return { first, second };",
    ].join("\n");

    const journal = new InMemoryJournalStore();
    const controller = new AbortController();

    // 首趟：ask#1 完成；ask#2 一派发就取消整个 run。
    const first = await runScript(TWO_ASKS, {
      journal,
      signal: controller.signal,
      asks: { "ask#1": () => ({ type: "text", finalText: "R1" }) },
      onStartAsk: (instance) => {
        if (instance.siteId === "ask#2") controller.abort();
      },
    });
    expect(first.settlement).toEqual({ status: "stopped", reason: "user" });
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("completed");
    expect(journal.getNode(RUN, "ask#2", 1)?.status).toBe("running"); // 准入记录保留
    expect(journal.getActor(RUN, "actor#1", 1)?.sessionId).toBeDefined();

    // 第二趟：同一 journal 恢复。
    const second = await runScript(TWO_ASKS, {
      journal,
      asks: { "ask#2": () => ({ type: "text", finalText: "R2" }) },
      onStartAsk: (instance) => {
        if (instance.siteId !== "ask#2") {
          throw new Error(`只允许重派发 ask#2，收到 ${instance.siteId}@${instance.ordinal}`);
        }
      },
    });
    expect(second.settlement).toEqual({
      status: "completed",
      artifact: { first: "R1", second: "R2" },
    });
    // ask#1 短路（零派发），ask#2 恰好重派发一次。
    expect(second.driver.startAskCount()).toBe(1);
    // 会话经 driver 重建——不是从 journal 短路出来的裸引用。
    expect(second.driver.sessionCreations).toEqual([{ siteId: "actor#1", ordinal: 1 }]);
  });
});

/**
 * 扇出分支在 await 之后 `report`：那些 report 的 ordinal 按**完成顺序**落库。这一份端到端
 * 用例把事故跑在真沙箱子进程上——第一条 review 走一轮 repair，因此比第二条**晚**结算，
 * journal 里的 report#1@1 是第二个文件。resume 必须按记录的结算次序释放命中，否则第一条
 * 分支的续体先跑，report#1@1 拿到另一条分支的 item，run 以 InputHashMismatch 死掉。
 * 见 docs/execution-engine.md「Replaying the settle order」。
 */
describe("e2e — resume of a fan-out that reports after the join", () => {
  const FAN_OUT = [
    "interface Verdict { approved: boolean; reason: string; }",
    'const paths = await files.glob("src/**/*.ts");',
    "const verdicts = await Promise.all(",
    "  paths.map(async (p) => {",
    "    const v = await agent(`reviewer-${p}`).ask<Verdict>(`Review ${p}`);",
    "    report({ path: p, approved: v.approved });",
    "    return v;",
    "  }),",
    ");",
    "return { reviewed: verdicts.length };",
  ].join("\n");

  const PATHS = ["src/a.ts", "src/b.ts"];

  it("resumes without an InputHashMismatch and never re-reports an item", async () => {
    const journal = new InMemoryJournalStore();

    // 首趟：src/a.ts 先交一份不合 schema 的答案，修好要多一个来回，于是它**后**结算。
    // 修复那一步压在真定时器之后（delayMs）而不只是多一个微任务：两个 ask 的请求行偶尔会落在
    // 子进程 stdout 的两个 chunk 里、被父进程在两个 tick 里准入（量到的准入间隔从 0.03ms 跳到
    // 0.15ms），那时 a 的整条修复链会在 b 的请求到达之前跑完，「多一个来回」就不再意味着「晚结算」。
    // 只有真时间差能让这条「完成顺序 ≠ 数组顺序」的前提在任何 chunk 切分下都成立。
    const first = await runScript(FAN_OUT, {
      journal,
      worldReads: () => PATHS,
      asks: {
        "ask#1": ({ message }) =>
          message.instructions.includes("src/a.ts")
            ? [
                { type: "submit", payload: { approved: true } }, // 缺 reason → 引擎判违规并要求修复
                { type: "submit", payload: { approved: true, reason: "fixed" }, delayMs: 30 },
              ]
            : { type: "submit", payload: { approved: false, reason: "nit" } },
      },
    });
    expect(first.settlement).toEqual({ status: "completed", artifact: { reviewed: 2 } });

    const reportRows = journal
      .listNodes(RUN, { kinds: "all", withResult: true })
      .filter((n) => n.kind === "report")
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((n) => n.result);
    // 完成顺序 ≠ 数组顺序：晚结算的 src/a.ts 排在第二位。
    expect(reportRows).toEqual([
      { path: "src/b.ts", approved: false },
      { path: "src/a.ts", approved: true },
    ]);

    // 第二趟：全新子进程 + 同一 journal，零 driver 效应。
    const second = await runScript(FAN_OUT, {
      journal,
      worldReads: () => {
        throw new Error("resume 不应触发 world-read（应 journal 命中）");
      },
      onStartAsk: (instance) => {
        throw new Error(`resume 不应 startAsk：${instance.siteId}@${instance.ordinal}`);
      },
    });

    expect(second.settlement).toEqual(first.settlement);
    expect(journal.getRun(RUN)?.failure).toBeUndefined();
    expect(second.driver.startAskCount()).toBe(0);
    // 命中按记录的结算次序释放。
    expect(
      second.driver
        .eventsOfType("node-settled")
        .filter((e) => e.cached === true)
        .map((e) => `${e.instance.siteId}@${e.instance.ordinal}`),
    ).toEqual(["world-read#1@1", "ask#1@2", "ask#1@1"]);
    // report 命中静默跳过：一条都不重发，行也一行没动。
    expect(second.driver.eventsOfType("report")).toEqual([]);
    expect(
      journal
        .listNodes(RUN, { kinds: "all", withResult: true })
        .filter((n) => n.kind === "report")
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((n) => n.result),
    ).toEqual(reportRows);
  });
});
