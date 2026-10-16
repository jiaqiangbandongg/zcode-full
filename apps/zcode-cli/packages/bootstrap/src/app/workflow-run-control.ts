// ============================================================
// run 的活体控制面：一次命令同时落到引擎与座位闸门
// ============================================================
// docs/dynamic-workflow/concurrency.md「The control path」。一个在飞 run 的两个执行点住在不同的
// 层里——调度器在引擎（`@zcode/dynamic-workflow`），座位闸门在 driver 之下（本包）——而发命令的
// 那一侧（run service 的 `retuneConcurrency`）两个都够不着：引擎是 harness 在子进程装配起来之后
// 才存在的，闸门是 launch 造的。
//
// 所以 run service 先造一个**空的**句柄放进注册表条目，两边各自在自己出生的那一刻把自己接上去：
// harness 拿到 `bind(engine)`（与 `signal` 同一条缝递进去），launch 拿到 `bindSeatGate(gate)`。
// 句柄本身不判断任何事：存活判定、no-op 语义与落库全在引擎的 `setMaxConcurrency` 里，闸门只在
// 引擎说"这次真的改了"之后才跟着换上界——两个执行点因此不可能各执一词。
//
// 顺序是载荷性的：**引擎先**。引擎的布尔值就是这次命令的裁决（已结算 / 值没变 ⇒ false，什么也
// 没发生），闸门若抢在前面换了上界，一个已经结算的 run 就会留下一个与 journal 行不符的内存上界。

import type { FillHoleResult, HoleFill, OpenHole } from "@zcode/dynamic-workflow";
import type { RunControlBinding } from "@zcode/dynamic-workflow-runtime";
import type { WorkflowConcurrencyPort } from "./workflow-concurrency-governor.js";
import type { WorkflowRunSeatGate } from "./workflow-seat-gate.js";

export interface WorkflowRunControl extends RunControlBinding {
  /**
   * 就地改本 run 自己的并发上界。返回**这次是否真的改了**：`false` 即什么也没发生——引擎还没
   * 接上（launch 之前的那几个微任务）、run 已结算，或新值与当前值相同。调用方据此回落。
   */
  setMaxConcurrency(maxConcurrency: number): boolean;
  /**
   * launch 造好座位闸门之后接上去；缺席即这个 run 只有调度器一个执行点。launch 递进来的不是闸门
   * 本身，而是「换闸门上界 + 在治理器上重新登记本 run 的上界」这一手（docs/dynamic-workflow/
   * concurrency.md「The control path」），所以一次 retune 同时挪动闸门与增长上限。
   */
  bindSeatGate(gate: Pick<WorkflowRunSeatGate, "setLimit">): void;
  /**
   * 给一处正在等的留白送去有效脚本里它的函数体（docs/execution-engine.md「The engine's part」）。
   * 引擎还没接上时回 `undefined`——与 `setMaxConcurrency` 的 false 同义：这一刻没有引擎可命令，
   * 调用方（补全服务）据此报 `hole_not_waiting`。留白只有引擎一个执行点，闸门不参与。
   */
  fillHole(fill: HoleFill): FillHoleResult | undefined;
  /**
   * 引擎此刻停驻的留白（快照投影 `waiting` 的唯一来源，docs/execution-engine.md「The run
   * snapshot」）。引擎还没接上时回 `undefined`，与「没有引擎在等」对读面是同一件事。
   */
  openHoles(): readonly OpenHole[] | undefined;
}

/** 控制面握着的引擎切面：两条命令（上界、补全）与一条查询（停驻的留白）。 */
type BoundEngine = Parameters<RunControlBinding["bind"]>[0];

export function createWorkflowRunControl(): WorkflowRunControl {
  let engine: BoundEngine | undefined;
  let seatGate: Pick<WorkflowRunSeatGate, "setLimit"> | undefined;
  return {
    bind: (bound) => {
      engine = bound;
    },
    fillHole: (fill) => engine?.fillHole(fill),
    openHoles: () => engine?.openHoles(),
    bindSeatGate: (gate) => {
      seatGate = gate;
    },
    setMaxConcurrency: (maxConcurrency) => {
      if (engine === undefined) return false;
      if (!engine.setMaxConcurrency(maxConcurrency)) return false;
      seatGate?.setLimit(maxConcurrency);
      return true;
    },
  };
}

/**
 * launch 交给 {@link WorkflowRunControl.bindSeatGate} 的那一手：一次 retune 同时换座位闸门的上界，
 * 并在进程级治理器上重新登记本 run 的上界（它抬本 run 用过的 key 的增长上限，
 * docs/dynamic-workflow/concurrency.md「The governor」）。治理器缺席即只有闸门。
 */
export function runBoundTarget(
  seatGate: Pick<WorkflowRunSeatGate, "setLimit">,
  concurrency: Pick<WorkflowConcurrencyPort, "setRunBound"> | undefined,
  runId: string,
): Pick<WorkflowRunSeatGate, "setLimit"> {
  return {
    setLimit: (limit) => {
      seatGate.setLimit(limit);
      concurrency?.setRunBound(runId, limit);
    },
  };
}
