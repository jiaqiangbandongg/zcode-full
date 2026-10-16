/**
 * harness 的活体控制面接线（`RunControlBinding`，docs/dynamic-workflow/concurrency.md
 * 「Two bounds on a run」）：引擎构造好之后交给调用方的那个句柄，必须指向**这一世的**引擎，
 * 且在子进程真的跑起来之后仍然管用。
 *
 * 这里不测命令的语义（那在 @zcode/dynamic-workflow 的引擎用例里），只测接线：绑没绑、
 * 绑的是不是活着的那个引擎、句柄发出的改动有没有落到这个 run 的 journal 行上。
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  validate,
  type JsonSchema,
  type RunEvent,
  type ValidateFn,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript, type RunControlBinding } from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";
import { askSpecsFor, TEST_CWD } from "./helpers.js";

const validateFn: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

const RUN = "run-control";

const SCRIPT = [
  'const worker = agent("worker", "You answer questions.");',
  'const answer = await worker.ask("What is the answer?");',
  "return answer;",
].join("\n");

/** 捕获 harness 交下来的句柄；`retune` 在句柄未绑时大声失败，而不是静默通过。 */
function captureControl(): RunControlBinding & { retune: (n: number) => boolean } {
  let bound: { setMaxConcurrency(n: number): boolean } | undefined;
  return {
    bind(engine) {
      bound = engine;
    },
    retune(n) {
      if (bound === undefined) throw new Error("control was never bound to an engine");
      return bound.setMaxConcurrency(n);
    },
  };
}

describe("harness — 活体控制面绑定", () => {
  it("在子进程跑起来之后，句柄仍指向这一世的引擎：改动落到 journal 行与事件轨", async () => {
    const journal = new InMemoryJournalStore();
    const control = captureControl();
    // 子代理的 ask 一开始执行就说明引擎已经在跑；此刻用句柄改上界，然后才让它作答。
    const retunes: boolean[] = [];
    const driver = new AutoDriver(journal, {
      asks: { "ask#1": () => ({ type: "text", finalText: "42" }) },
      onStartAsk: () => {
        retunes.push(control.retune(3));
      },
    });

    const settlement = await runWorkflowScript({
      scriptText: SCRIPT,
      cwd: TEST_CWD,
      runId: RUN,
      caps: { maxConcurrency: 8 },
      askSpecs: askSpecsFor(SCRIPT),
      validate: validateFn,
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      control,
      timeoutMs: 20000,
    });

    expect(settlement).toEqual({ status: "completed", artifact: "42" });
    expect(retunes).toEqual([true]);
    expect(journal.getRun(RUN)?.caps).toEqual({ maxConcurrency: 3 });

    const changed = driver.events.filter(
      (e): e is Extract<RunEvent, { type: "run-caps-changed" }> => e.type === "run-caps-changed",
    );
    expect(changed).toEqual([
      {
        type: "run-caps-changed",
        runId: RUN,
        caps: { maxConcurrency: 3 },
        previous: { maxConcurrency: 8 },
      },
    ]);
  });

  it("run 结算之后句柄是 no-op：返回 false，行与事件轨都不再变", async () => {
    const journal = new InMemoryJournalStore();
    const control = captureControl();
    const driver = new AutoDriver(journal, {
      asks: { "ask#1": () => ({ type: "text", finalText: "42" }) },
    });

    await runWorkflowScript({
      scriptText: SCRIPT,
      cwd: TEST_CWD,
      runId: RUN,
      caps: { maxConcurrency: 8 },
      askSpecs: askSpecsFor(SCRIPT),
      validate: validateFn,
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      control,
      timeoutMs: 20000,
    });

    const eventsAtSettlement = driver.events.length;
    expect(control.retune(2)).toBe(false);
    expect(journal.getRun(RUN)?.caps).toEqual({ maxConcurrency: 8 });
    expect(driver.events.length).toBe(eventsAtSettlement);
  });
});
