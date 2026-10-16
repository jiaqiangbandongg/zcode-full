/**
 * 流水线原语 channel / future 与停滞检测在**真沙箱**里的行为（docs/dynamic-workflow/authoring.md
 * 「Streams」、execution-engine.md「The vm cell」）。跑真子进程而不是桩：channel 的实现、
 * `__checkStalled` 的调度点（setImmediate）与 error-complete 的收尾都只在这条链上成立。
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  collectSitePhases,
  collectSites,
  createWorkflowProgram,
  interpret,
  type RunSettlement,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";
import { askSpecsFor, runScript, TEST_CWD } from "./helpers.js";

/** 直接投喂手写 lowered 体（自由标识符仅 `__host`），返回结算。 */
async function runLowered(lowered: string): Promise<RunSettlement> {
  const journal = new InMemoryJournalStore();
  const driver = new AutoDriver(journal);
  return runWorkflowScript({
    cwd: TEST_CWD,
    lowered,
    caps: { maxConcurrency: 4 },
    askSpecs: new Map(),
    validate: () => [],
    makeDriver: (sink) => {
      driver.attach(sink);
      return driver;
    },
    timeoutMs: 15000,
  });
}

function failureMessage(settlement: RunSettlement): string {
  expect(settlement.status).toBe("errored");
  return (settlement as { status: "errored"; error: { message: string } }).error.message;
}

describe("channel — a pipeline in the sandbox", () => {
  it("streams every item from three producers through two consumers exactly once", async () => {
    const script = [
      'const facts = channel<string>("facts");',
      "const seen: string[] = [];",
      "const research = future(async () => {",
      "  try {",
      '    await Promise.all(["a", "b", "c"].map(async (angle) => {',
      "      const found = await agent(`researcher-${angle}`).ask<string[]>(`find ${angle}`);",
      "      for (const fact of found) facts.send(fact);",
      "    }));",
      "  } finally {",
      "    facts.close();",
      "  }",
      "});",
      "const verify = future(async () => {",
      "  await Promise.all([1, 2].map(async () => {",
      "    for await (const fact of facts) {",
      "      seen.push(await agent(`verifier-${fact}`).ask(`verify ${fact}`));",
      "    }",
      "  }));",
      "});",
      "await Promise.all([research, verify]);",
      "return seen.sort();",
    ].join("\n");
    const { settlement, journal } = await runScript(script, {
      asks: {
        "ask#1": ({ message }) => {
          const angle = message.instructions.slice("find ".length);
          return { type: "submit", payload: [`${angle}1`, `${angle}2`] };
        },
        "ask#2": ({ message }) => ({
          type: "text",
          finalText: message.instructions.slice("verify ".length),
        }),
      },
    });
    expect(settlement).toEqual({
      status: "completed",
      artifact: ["a1", "a2", "b1", "b2", "c1", "c2"],
    });
    // 六个 fact，六个 verifier ask；每个 fact 恰好被一个消费者拿到。
    expect(
      journal
        .listNodes("run", { kinds: "all", withResult: true })
        .filter((node) => node.siteId === "ask#2"),
    ).toHaveLength(6);
  });

  it("drains buffered items after close, then ends every receiver", async () => {
    const settlement = await runLowered(`
      const ch = __host.channel("buffered");
      for (let i = 0; i < 5000; i++) ch.send(i);
      ch.close();
      let sum = 0;
      let count = 0;
      for await (const n of ch) { sum += n; count += 1; }
      // 关闭后再迭代：立即结束，不挂起。
      for await (const n of ch) { sum += n; }
      return [count, sum];
    `);
    expect(settlement).toEqual({ status: "completed", artifact: [5000, (4999 * 5000) / 2] });
  });

  it("wakes parked receivers in arrival order and hands each item to exactly one of them", async () => {
    const settlement = await runLowered(`
      const ch = __host.channel("fifo");
      const got = [[], []];
      const consumers = [0, 1].map((w) => __host.future(async () => {
        for await (const n of ch) got[w].push(n);
      }));
      // 两个接收者都已停在空通道上；逐个 send 应轮流唤醒 0、1、0、1。
      await Promise.resolve();
      for (let i = 0; i < 4; i++) ch.send(i);
      ch.close();
      await Promise.all(consumers);
      return got;
    `);
    expect(settlement).toEqual({
      status: "completed",
      artifact: [
        [0, 2],
        [1, 3],
      ],
    });
  });

  it("send after close throws a catchable ChannelClosed naming the channel", async () => {
    const settlement = await runLowered(`
      const ch = __host.channel("facts");
      ch.close();
      ch.close();
      try { ch.send(1); return "NO-THROW"; } catch (e) { return [e.name, e.code, e.message]; }
    `);
    expect(settlement.status).toBe("completed");
    const [name, code, message] = (settlement as { status: "completed"; artifact: string[] })
      .artifact;
    expect(name).toBe("ChannelClosed");
    expect(code).toBe("ChannelClosed");
    expect(message).toContain('"facts"');
  });
});

describe("future — a named async IIFE", () => {
  it("runs the body to its first await before returning, and turns a sync throw into a rejection", async () => {
    const settlement = await runLowered(`
      const order = [];
      const f = __host.future(async () => { order.push("body"); await null; order.push("after"); return 7; });
      order.push("returned");
      const value = await f;
      let rejected = "no";
      try { await __host.future(() => { throw new Error("boom"); }); } catch (e) { rejected = e.message; }
      return [order, value, rejected];
    `);
    expect(settlement).toEqual({
      status: "completed",
      artifact: [["body", "returned", "after"], 7, "boom"],
    });
  });
});

describe("stall detection — a stuck run fails instead of hanging", () => {
  it("names the channel and the waiting receivers when nobody can send again", async () => {
    const settlement = await runLowered(`
      const facts = __host.channel("facts");
      const consumers = [1, 2].map(() => __host.future(async () => { for await (const f of facts) {} }));
      await Promise.all(consumers);
      return "unreachable";
    `);
    const message = failureMessage(settlement);
    expect(message).toContain("Deadlock");
    expect(message).toContain('2 on "facts"');
    expect(message).toContain("close()");
  });

  it("fires only once the last in-flight request has been answered", async () => {
    // 生产者的 ask 在飞时不能误报；它结算、发送、却忘了 close 之后，消费者停在空通道上——
    // 那一刻（最后一条 response 投递之后）才是死锁。
    const script = [
      'const facts = channel<string>("facts");',
      "const seen: string[] = [];",
      "const research = future(async () => {",
      '  const found = await agent("researcher").ask<string[]>("find");',
      "  for (const fact of found) facts.send(fact);",
      "  // forgot facts.close()",
      "});",
      "const verify = future(async () => {",
      "  for await (const fact of facts) seen.push(fact);",
      "});",
      "await Promise.all([research, verify]);",
      "return seen;",
    ].join("\n");
    const { settlement, journal } = await runScript(script, {
      asks: { "ask#1": () => ({ type: "submit", payload: ["x", "y"] }) },
    });
    const message = failureMessage(settlement);
    expect(message).toContain('1 on "facts"');
    // 生产者的 ask 正常结算了：检测没有抢在 response 前面。
    expect(journal.getNode("run", "ask#1", 1)?.status).toBe("completed");
  });

  it("reports a promise that can never settle as a stall", async () => {
    const settlement = await runLowered(`await new Promise(() => {}); return 1;`);
    expect(failureMessage(settlement)).toContain("Stalled");
  });

  it("rests on the cell having no timers of its own", async () => {
    const settlement = await runLowered(
      `return [typeof setTimeout, typeof setImmediate, typeof setInterval, typeof queueMicrotask];`,
    );
    expect(settlement).toEqual({
      status: "completed",
      artifact: ["undefined", "undefined", "undefined", "undefined"],
    });
  });
});

describe("lexical phases end to end", () => {
  it("stamps a producer's post-await ask with its own stage although the consumer's marker ran last", async () => {
    const script = [
      'const facts = channel<string>("facts");',
      "const seen: string[] = [];",
      "const research = future(async () => {",
      '  phase("Gather facts");',
      "  try {",
      '    const first = await agent("scout").ask<string[]>("scout");',
      "    // 首次 await 之后再发一个 ask：动态戳会说 Verify（它的标记最后跑过），词法戳说 Gather。",
      '    const more = await agent("digger").ask<string[]>(`dig ${first.length}`);',
      "    for (const fact of [...first, ...more]) facts.send(fact);",
      "  } finally {",
      "    facts.close();",
      "  }",
      "});",
      "const verify = future(async () => {",
      '  phase("Verify facts");',
      "  for await (const fact of facts) seen.push(await agent(`verifier-${fact}`).ask(`verify ${fact}`));",
      "});",
      "await Promise.all([research, verify]);",
      "return seen;",
    ].join("\n");
    const workflow = createWorkflowProgram(script);
    const sitePhases = collectSitePhases(interpret(workflow, collectSites(workflow)));
    expect(sitePhases.get("ask#2")).toBe("Gather facts");
    expect(sitePhases.get("ask#3")).toBe("Verify facts");

    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, {
      asks: {
        "ask#1": () => ({ type: "submit", payload: ["a"] }),
        "ask#2": () => ({ type: "submit", payload: ["b"] }),
        "ask#3": ({ message }) => ({ type: "text", finalText: message.instructions }),
      },
    });
    const settlement = await runWorkflowScript({
      scriptText: script,
      cwd: TEST_CWD,
      runId: "run",
      caps: { maxConcurrency: 16 },
      askSpecs: askSpecsFor(script),
      sitePhases,
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
    });
    expect(settlement.status).toBe("completed");
    const phaseOf = new Map(
      driver
        .eventsOfType("node-queued")
        .map((e) => [`${e.instance.siteId}@${e.instance.ordinal}`, e.phaseName]),
    );
    expect(phaseOf.get("ask#1@1")).toBe("Gather facts");
    expect(phaseOf.get("ask#2@1")).toBe("Gather facts");
    expect(phaseOf.get("ask#3@1")).toBe("Verify facts");
    expect(phaseOf.get("ask#3@2")).toBe("Verify facts");
  });
});
