/**
 * 会话静默账本的单元测试（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md
 * 「Amend-resume」的「What is imported」行）。
 *
 * 被测的是一条有界等待：被取代的前驱刚被 abort，它的 turn 可能还在落最后几条消息；amend 只对
 * **已经写完**的会话谈在飞 ask 的接续。时钟注入，所以这里一毫秒都不真睡。
 */

import { describe, expect, it } from "vitest";
import {
  AMEND_TRANSCRIPT_QUIESCE_MS,
  createActorSessionQuiescence,
} from "../src/app/workflow-driver-quiescence.js";

/** 手动时钟：记下被排定的闹钟，测试自己决定它响不响。 */
function manualSchedule(): {
  clock: { schedule: (callback: () => void, delayMs: number) => () => void };
  /** 所有仍未撤销、未触发的闹钟延时。 */
  pending: () => number[];
  /** 触发全部在排闹钟（模拟「到点了」）。 */
  fire: () => void;
} {
  const alarms = new Map<number, { callback: () => void; delayMs: number }>();
  let next = 0;
  return {
    clock: {
      schedule(callback, delayMs) {
        const id = next++;
        alarms.set(id, { callback, delayMs });
        return () => alarms.delete(id);
      },
    },
    pending: () => [...alarms.values()].map((alarm) => alarm.delayMs),
    fire: () => {
      // 先快照再触发：回调会改动 alarms（撤闹钟），边遍历边改是未定义行为。
      const firing = [...alarms.values()];
      alarms.clear();
      for (const alarm of firing) alarm.callback();
    },
  };
}

/** 一个可由测试决定何时落地的 turn 收尾链。 */
function deferredTurn(): { promise: Promise<void>; settle: () => void } {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

describe("createActorSessionQuiescence", () => {
  it("没有在飞 turn 的会话立刻静默（一个闹钟都不排）", async () => {
    const timer = manualSchedule();
    const ledger = createActorSessionQuiescence({ clock: timer.clock });
    ledger.noteDisposed("sess-a", undefined);
    ledger.noteDisposed("sess-b", undefined);

    expect(await ledger.quietSessions()).toEqual(new Set(["sess-a", "sess-b"]));
    expect(timer.pending()).toEqual([]);
  });

  it("上界内落地的 turn 算静默，并撤掉闹钟", async () => {
    const timer = manualSchedule();
    const ledger = createActorSessionQuiescence({ clock: timer.clock });
    const turn = deferredTurn();
    ledger.noteDisposed("sess-a", turn.promise);

    const asked = ledger.quietSessions();
    expect(timer.pending()).toEqual([AMEND_TRANSCRIPT_QUIESCE_MS]);
    turn.settle();
    expect(await asked).toEqual(new Set(["sess-a"]));
    // 闹钟必须撤掉：一个还没响的 setTimeout 会把 CLI 的退出拖到上界。
    expect(timer.pending()).toEqual([]);
  });

  // turn 收尾链 reject 同样算静默：成败与「还写不写这个会话」无关。
  it("落地方式是 reject 也算静默", async () => {
    const timer = manualSchedule();
    const ledger = createActorSessionQuiescence({ clock: timer.clock });
    ledger.noteDisposed("sess-a", Promise.reject(new Error("turn blew up")));

    expect(await ledger.quietSessions()).toEqual(new Set(["sess-a"]));
  });

  // 到点仍未落地的会话**不**被当作静默继续用——它只是拿不到 inFlight（本特性之前的行为）。
  it("到点仍未落地 → 不静默，其余会话照常静默", async () => {
    const timer = manualSchedule();
    const ledger = createActorSessionQuiescence({ clock: timer.clock });
    const slow = deferredTurn();
    const quick = deferredTurn();
    ledger.noteDisposed("sess-slow", slow.promise);
    ledger.noteDisposed("sess-quick", quick.promise);
    ledger.noteDisposed("sess-idle", undefined);

    const asked = ledger.quietSessions();
    quick.settle();
    timer.fire();

    expect(await asked).toEqual(new Set(["sess-quick", "sess-idle"]));
  });

  // 交出去的是快照：到点之后才落地的会话不得在调用方背后把集合改大。
  it("交出的集合不随后续落地而变大", async () => {
    const timer = manualSchedule();
    const ledger = createActorSessionQuiescence({ clock: timer.clock });
    const slow = deferredTurn();
    ledger.noteDisposed("sess-slow", slow.promise);

    const asked = ledger.quietSessions();
    timer.fire();
    const quiet = await asked;
    expect(quiet).toEqual(new Set());

    slow.settle();
    await Promise.resolve();
    expect(quiet).toEqual(new Set());
  });

  it("从未登记过的会话不在静默集合里", async () => {
    const ledger = createActorSessionQuiescence({ clock: manualSchedule().clock });
    ledger.noteDisposed("sess-a", undefined);
    expect((await ledger.quietSessions()).has("sess-unknown")).toBe(false);
  });

  it("可重复询问（amend 之外没有别的读者，但账本不因一次询问而作废）", async () => {
    const timer = manualSchedule();
    const ledger = createActorSessionQuiescence({ clock: timer.clock });
    ledger.noteDisposed("sess-a", undefined);

    expect(await ledger.quietSessions()).toEqual(new Set(["sess-a"]));
    expect(await ledger.quietSessions()).toEqual(new Set(["sess-a"]));
  });
});
