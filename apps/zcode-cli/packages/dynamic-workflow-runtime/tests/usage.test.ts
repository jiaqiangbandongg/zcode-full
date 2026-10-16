/**
 * 用量事件：driver 每次 ask 结算回报 stats，引擎累计 run 级 spentTokens 并发 `usage-updated`。
 * 事件直接携带已花总量（docs/dynamic-workflow/authoring.md「Usage, not budget」），子进程协议不再搭载任何
 * 预算快照，脚本 facade 也没有 budget 全局量（不变式 3 / 4）。
 */

import { describe, expect, it } from "vitest";
import { runScript } from "./helpers.js";

describe("usage-updated — accumulated spentTokens", () => {
  it("emits the running total after each stats-carrying ask", async () => {
    const script = [
      'const a = agent("a");',
      'const r1 = await a.ask("first");',
      'const r2 = await a.ask("second");',
      "return { r1, r2 };",
    ].join("\n");

    const { settlement, driver, journal } = await runScript(script, {
      caps: { maxConcurrency: 16 },
      asks: {
        "ask#1": () => ({
          type: "text",
          finalText: "r1",
          stats: { tokens: 100, toolCalls: 0, turns: 1 },
        }),
        "ask#2": () => ({
          type: "text",
          finalText: "r2",
          stats: { tokens: 50, toolCalls: 0, turns: 1 },
        }),
      },
    });

    expect(settlement).toEqual({ status: "completed", artifact: { r1: "r1", r2: "r2" } });
    expect(driver.eventsOfType("usage-updated")).toEqual([
      { type: "usage-updated", spentTokens: 100 },
      { type: "usage-updated", spentTokens: 150 },
    ]);
    expect(journal.getRun("run")?.spentTokens).toBe(150);
  });

  it("rejects a script that reads budget at compile time (TS2304, not a runtime surprise)", async () => {
    await expect(
      runScript("return budget.remainingTokens();", { caps: { maxConcurrency: 16 }, asks: {} }),
    ).rejects.toThrow("Cannot find name 'budget'");
  });
});
