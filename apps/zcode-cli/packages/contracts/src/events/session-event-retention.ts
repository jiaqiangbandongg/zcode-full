import type { SessionEvent } from "./session.events.js";
import { SessionEventType } from "./session.events.js";

/**
 * 与消息流同频的瞬态事件。
 * 它们仍经 event store 分配 seq 并交给 live sink，但 turn 结束并被下一 turn 取代后即可从内存淘汰：
 * 已完成 turn 的文本由持久化消息重新合成，reducer / rewind / fork / checkpoint 不消费这些类型。
 */
export const TRANSIENT_SESSION_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set([
  SessionEventType.ModelStreaming,
  SessionEventType.ToolCallProgress,
  SessionEventType.StreamingToolLedgerUpdated,
  SessionEventType.ModelNetworkStatus,
]);

/**
 * sealed turn 没有后继 turn 时的时间兜底。
 * subagent 子 session 只有一个 turn，永远等不到下一个 turn_started，
 * 真机上一次子 session 留下约 1 万条 delta 直到 record 被池子回收；
 * 由 60s 采样节拍调用 `collectExpired`，超过 grace 的 sealed turn 一并淘汰。
 */
export const SEALED_TURN_TRANSIENT_GRACE_MS = 120_000;

export function isTransientSessionEvent(event: Pick<SessionEvent, "type">): boolean {
  return TRANSIENT_SESSION_EVENT_TYPES.has(event.type);
}

/**
 * sealed turn 淘汰时 `model_request` 驻留副本的元数据瘦身（spec 同上"model_request 元数据瘦身"）。
 * Bug 根因：`messages` 是每次模型请求的完整上下文，每个工具迭代一条且作为非瞬态永久驻留；
 * compact 只截断后续请求，不回收已驻留事件，长会话实测 event store 驻留随轮次线性涨约 150MB。
 * 内存 store 的读者只用 `messages.length`，live sink（debug JSONL）拿的是 append 返回的完整对象，
 * 因此只把驻留副本换成 `messageCount`，事件 id / seq / 其它 payload 字段保持不变。
 */
export function slimRetainedModelRequest(event: SessionEvent): SessionEvent {
  if (event.type !== SessionEventType.ModelRequest) {
    return event;
  }
  const payload = event.payload as { messages?: unknown } | null | undefined;
  if (!payload || !Array.isArray(payload.messages)) {
    return event;
  }
  const { messages, ...metadata } = payload;
  return { ...event, payload: { ...metadata, messageCount: messages.length } } as SessionEvent;
}

export type SessionEventRetentionMode = "unbounded" | "turn-window";

export interface SessionEventRetentionPolicy {
  /**
   * 每次 append 后调用一次。返回值是应从内存淘汰其瞬态事件的 turnId 列表；空数组表示不淘汰。
   * 策略只看事件序列本身，不依赖持久化结果。
   */
  onAppend(event: Pick<SessionEvent, "type" | "turnId">, nowMs: number): readonly string[];
  /**
   * 时间兜底：返回在 `nowMs - graceMs` 之前就已结束、且至今没有后继 turn 的 sealed turnId 列表，
   * 并把它们从待淘汰集合移除。由低频 tick 调用。
   */
  collectExpired(nowMs: number, graceMs: number): readonly string[];
}

const NO_EVICTION: readonly string[] = [];

function createUnboundedRetention(): SessionEventRetentionPolicy {
  return { onAppend: () => NO_EVICTION, collectExpired: () => NO_EVICTION };
}

/**
 * turn 窗口策略：`turn_complete` / `turn_error` 只把 turn 标为已结束（sealed），
 * 等下一个 `turn_started` 到达时再一次性淘汰所有 sealed turn 的瞬态事件（一 turn 滞后）。
 * 滞后的原因：turn 刚结束时消息可能尚未落盘，冷恢复仍要靠内存瞬态事件拼文本；
 * 下一 turn 开始意味着用户又发了消息，上一 turn 必定已持久化。
 */
function createTurnWindowRetention(): SessionEventRetentionPolicy {
  const openTurns = new Set<string>();
  const sealedAt = new Map<string, number>();
  return {
    onAppend(event, nowMs) {
      const turnId = event.turnId;
      if (!turnId) {
        return NO_EVICTION;
      }
      switch (event.type) {
        case SessionEventType.TurnStarted: {
          const evict = [...sealedAt.keys()].filter((sealed) => sealed !== turnId);
          sealedAt.clear();
          openTurns.add(turnId);
          return evict;
        }
        case SessionEventType.TurnComplete:
        case SessionEventType.TurnError: {
          openTurns.delete(turnId);
          if (!sealedAt.has(turnId)) {
            sealedAt.set(turnId, nowMs);
          }
          return NO_EVICTION;
        }
        default:
          return NO_EVICTION;
      }
    },
    collectExpired(nowMs, graceMs) {
      const expired: string[] = [];
      for (const [turnId, at] of sealedAt) {
        if (nowMs - at >= graceMs) {
          expired.push(turnId);
        }
      }
      for (const turnId of expired) {
        sealedAt.delete(turnId);
      }
      return expired;
    },
  };
}

export function createSessionEventRetentionPolicy(
  mode: SessionEventRetentionMode,
): SessionEventRetentionPolicy {
  return mode === "unbounded" ? createUnboundedRetention() : createTurnWindowRetention();
}
