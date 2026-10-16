/**
 * 出生阶段坐标的两个打戳函数（docs/dynamic-workflow/presentation.md 追记 2026-09-09）。
 *
 * 拆分原因：engine.ts 顶到 oxlint max-lines 上限（400 行）。选中这两个而不是别的，是因为它们
 * 高度同族——同一张 `instancePhases` 表（实例 `siteId@ordinal` → 它**出生时**的阶段名）的仅有
 * 两个读者，一个给事件打戳、一个给 `ProviderStop` 明细补阶段，且都是纯函数：表由调用方（引擎）
 * 拥有并在铸造点写入，这里只读。公开面仍只有 engine.ts 在用。
 */

import type { RunEvent } from "./types.js";
import { refToString, WorkflowError } from "./types.js";

/** 实例键（`siteId@ordinal`）→ 它出生时的阶段名。引擎的 `instancePhases` 的只读视图。 */
export type InstancePhases = ReadonlyMap<string, string>;

/**
 * 给**出生事件**补上出生阶段：actor 的 `actor-created` 按 actor 查表，节点的 `node-queued`
 * 按 instance 查表，命中缓存的 `node-settled { cached: true }` 同样按 instance——命中的节点
 * 没有 queued，那条 settle 就是它的出生事件。其余事件**原样返回**：调度器的其余发射点零改动，
 * reducer 沿用 `actorSiteId` 的先例向前携带。
 *
 * ask 的 `node-dispatched` 是唯一的例外，它重复自己的出生事实（types.ts 的同名事件），于是
 * 两个阶段名在这里一并补上：`phaseName` 按 instance、`actorPhaseName` 按它的 actor，两次都查
 * 同一张出生表，所以与该实例的 `node-queued`、该 actor 的 `actor-created` 逐字相同。带 `actor`
 * 才补——world-read 的派发不带子代理，保持裸的。
 *
 * 它不是「发出这条事件时的当前阶段」：node-queued 可能被 hold 规则推迟到下一个标记之后才发出，
 * 而出生时刻在上一个阶段；派发更是可能卡在并发上界后面，等到脚本已走过好几个标记。
 */
export function stampBirthPhase(event: RunEvent, instancePhases: InstancePhases): RunEvent {
  if (event.type === "actor-created") {
    const phaseName = instancePhases.get(refToString(event.actor));
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  if (event.type === "node-queued") {
    const phaseName = instancePhases.get(refToString(event.instance));
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  if (event.type === "node-dispatched" && event.actor !== undefined) {
    const phaseName = instancePhases.get(refToString(event.instance));
    const actorPhaseName = instancePhases.get(refToString(event.actor));
    if (phaseName === undefined && actorPhaseName === undefined) return event;
    return {
      ...event,
      ...(phaseName === undefined ? {} : { phaseName }),
      ...(actorPhaseName === undefined ? {} : { actorPhaseName }),
    };
  }
  if (event.type === "node-settled" && event.cached === true) {
    const phaseName = instancePhases.get(refToString(event.instance));
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  // 留白的到达也是一次出生（docs/execution-engine.md「Holes」）：序号与节点同族铸造，出生
  // 阶段同一张表——没有行，事件是它唯一的坐标。
  if (event.type === "hole-reached") {
    const phaseName = instancePhases.get(refToString(event.instance));
    return phaseName === undefined ? event : { ...event, phaseName };
  }
  return event;
}

/**
 * 给 `ProviderStop` 补上触发停止的子代理的**出生阶段**（docs/execution-engine.md
 * 「通知文案」的 `phase=`）：driver 只知道 actor ref，阶段只有引擎知道（与事件流上 `phaseName`
 * 的同一张表）。没有 providerStop、没有 subagent、已带阶段、或该 ref 出生在任何 `phase()`
 * 标记之前 → 原样返回。
 */
export function enrichProviderStopPhase(
  error: WorkflowError,
  instancePhases: InstancePhases,
): WorkflowError {
  const details = error.providerStop;
  if (details === undefined || details.subagent === undefined || details.phase !== undefined) {
    return error;
  }
  const phase = instancePhases.get(details.subagent);
  if (phase === undefined) return error;
  return new WorkflowError(error.code, error.message, {
    providerStop: { ...details, phase },
    cause: (error as { cause?: unknown }).cause,
  });
}
