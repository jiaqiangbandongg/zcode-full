import type { SessionEvent } from "@zcode/contracts";
import type { TuiCopy } from "@zcode/i18n";
import React from "react";
import { applySessionEventToState } from "./app-events.js";
import { describeSessionEvent } from "./state.js";
import { isSubagentToolMirror } from "./app-subagent-events.js";

type SessionEventHandlers = Parameters<typeof applySessionEventToState>[1];

/**
 * 已应用事件 id 的记忆窗。
 *
 * 为什么需要：跨回合常驻订阅与 per-turn `onEvent` 会**同时**投同一条事件。镜像本身对
 * 重复投递免疫（共享 reducer 对刚归约完的同一条事件返回 null），但转写不是——
 * `assistant_message` 之类是无条件 append，双投会让回复在屏幕上出现两次。
 *
 * 有界即够：两个 sink 是在同一次 emit 上先后触发的，重复永远紧邻，不需要记住整场会话。
 */
const MAX_REMEMBERED_EVENT_IDS = 2_048;

/**
 * 只让**主会话**的事件进转写。
 *
 * 为什么必须过滤：actor / 子会话的原始事件会经 `notifyExternalChildSessionEvent` 投进
 * **父 runtime 的同一个外部 sink 集**，并且**保留子自己的 sessionId**（协议层据此按
 * detached live session 路由给桌面）。TUI 的 sink 就挂在那个集合上，per-turn onEvent 也一样，
 * 所以不过滤的话 actor 的流式增量、工具调用、submit_result、turn_complete 会全部画进主转写。
 *
 * dwf 进度事件本身是**父会话**事件（`session.events.ts:134`「追加到父会话」），所以工具卡
 * 与结算后的完成回合不受影响——它们仍是工作流在 TUI 上的唯一两个表面。
 *
 * 拿不到主 sessionId 时放行：宁可多渲染一点，也不要因为缺一个 id 就让转写整片空白。
 */
export function isMainSessionEvent(
  event: SessionEvent,
  mainSessionId: string | undefined,
): boolean {
  // Tool mirrors deliberately carry the parent's sessionId. They are activity
  // metadata, not parent transcript/tool/usage facts.
  if (isSubagentToolMirror(event)) return false;
  if (!mainSessionId) return true;
  const eventSessionId = typeof event.sessionId === "string" ? event.sessionId : undefined;
  if (eventSessionId === undefined) return true;
  return eventSessionId === mainSessionId;
}

type SessionEventApplierInput = SessionEventHandlers & {
  subscribeSessionEvents?: (sink: (event: SessionEvent) => void) => () => void;
  observeSessionEvent?: (event: SessionEvent) => void;
  copy: TuiCopy;
  getMainSessionId?: () => string | undefined;
  setLastEvent: (event: string) => void;
};

/**
 * 完整的入口流水线：会话闸门 → 去重 → 应用到状态。
 *
 * 导出成纯函数（seen-set 由调用方持有）而不是只留在 hook 里，是为了让**效果**可测：
 * 「actor 的 turn_complete 不会经兜底追加进主转写」这种回归只能在流水线层面证明，
 * 在谓词层面证明不了。返回是否真的应用了。
 *
 * 闸门排在去重之前：外来事件不该占用去重窗口的名额（窗口有界，被 actor 事件挤掉
 * 会让主会话的重复投递漏过去）。
 */
export function applyMainSessionEvent(
  event: SessionEvent,
  applied: Set<string>,
  input: SessionEventApplierInput,
): boolean {
  if (!isMainSessionEvent(event, input.getMainSessionId?.())) return false;
  if (!rememberSessionEvent(applied, event)) return false;
  input.setLastEvent(describeSessionEvent(event));
  applySessionEventToState(event, input, input.copy);
  return true;
}

export function useSessionEventApplier(
  input: SessionEventApplierInput,
): (event: SessionEvent) => void {
  const appliedEventIdsRef = React.useRef<Set<string>>(new Set());
  const applyEvent = React.useCallback(
    (event: SessionEvent) => {
      input.observeSessionEvent?.(event);
      applyMainSessionEvent(event, appliedEventIdsRef.current, input);
    },
    [input],
  );
  useSessionEventSubscription(input.subscribeSessionEvents, applyEvent);
  return applyEvent;
}

/** A stable subscription survives renders; both event sources share the applier. */
export function useSessionEventSubscription(
  subscribe: ((sink: (event: SessionEvent) => void) => () => void) | undefined,
  applyEvent: (event: SessionEvent) => void,
): void {
  const latest = React.useRef(applyEvent);
  latest.current = applyEvent;
  React.useEffect(() => subscribe?.((event) => latest.current(event)), [subscribe]);
}

/**
 * 记下这条事件；返回 false 表示它已经被应用过（调用方应整条跳过）。
 *
 * 没有 id 的事件一律放行：宁可重复渲染一次，也不要因为缺一个 key 就把事件整条吞掉。
 */
export function rememberSessionEvent(applied: Set<string>, event: SessionEvent): boolean {
  const eventId = typeof event.id === "string" && event.id.length > 0 ? event.id : undefined;
  if (eventId === undefined) return true;
  if (applied.has(eventId)) return false;
  applied.add(eventId);
  if (applied.size > MAX_REMEMBERED_EVENT_IDS) {
    // Set 保持插入序，最旧的一批先出。
    const excess = applied.size - MAX_REMEMBERED_EVENT_IDS;
    let removed = 0;
    for (const id of applied) {
      applied.delete(id);
      removed += 1;
      if (removed >= excess) break;
    }
  }
  return true;
}
