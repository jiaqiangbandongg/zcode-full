import type { SessionEventStorePort, SessionEventStoreStats } from "../interfaces/session.port.js";
import type { SessionId } from "../interfaces/shared.js";
import type { SessionEvent } from "./session.events.js";
import {
  createSessionEventRetentionPolicy,
  isTransientSessionEvent,
  SEALED_TURN_TRANSIENT_GRACE_MS,
  slimRetainedModelRequest,
  type SessionEventRetentionMode,
  type SessionEventRetentionPolicy,
} from "./session-event-retention.js";

export interface InMemorySessionEventStoreOptions {
  /** 默认 `turn-window`；`unbounded` 供回滚与对照测试。也可注入自定义策略工厂（按 session 创建）。 */
  retention?: SessionEventRetentionMode | (() => SessionEventRetentionPolicy);
  /** 供测试注入的时钟；生产用 Date.now。 */
  now?: () => number;
}

interface SessionEventState {
  events: SessionEvent[];
  latestSequenceNumber: number;
  policy: SessionEventRetentionPolicy;
  evictedEvents: number;
}

/**
 * 进程内 session event store。
 *
 * 它是 live / replay / snapshot 序号的唯一来源，因此所有事件都经 `append` 分配 seq；
 * 但瞬态事件只按 turn 窗口驻留，已完成并被下一 turn 取代的桶会从内存淘汰。
 * append 若每次全量拷贝数组且永不淘汰，长会话内存就会按 token 线性增长。
 */
export class InMemorySessionEventStore implements SessionEventStorePort {
  private readonly sessions = new Map<SessionId, SessionEventState>();
  private readonly createPolicy: () => SessionEventRetentionPolicy;
  private readonly now: () => number;

  constructor(options: InMemorySessionEventStoreOptions = {}) {
    const retention = options.retention ?? "turn-window";
    this.createPolicy =
      typeof retention === "function"
        ? retention
        : () => createSessionEventRetentionPolicy(retention);
    this.now = options.now ?? (() => Date.now());
  }

  private stateFor(sessionId: SessionId): SessionEventState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        events: [],
        latestSequenceNumber: 0,
        policy: this.createPolicy(),
        evictedEvents: 0,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  async append(event: SessionEvent): Promise<SessionEvent> {
    const state = this.stateFor(event.sessionId);
    const sequenceNumber =
      event.sequenceNumber > 0 ? event.sequenceNumber : state.latestSequenceNumber + 1;
    // 计数器只增不减：淘汰不能让后续 getLatestSequenceNumber()+1 生成重复 seq。
    state.latestSequenceNumber = Math.max(state.latestSequenceNumber, sequenceNumber);
    const storedEvent = { ...event, sequenceNumber };
    state.events.push(storedEvent);
    const evictTurnIds = state.policy.onAppend(storedEvent, this.now());
    if (evictTurnIds.length > 0) {
      this.evictTransientEvents(state, new Set(evictTurnIds));
    }
    return storedEvent;
  }

  /**
   * 时间兜底（由 60s 低频 tick 调用）：淘汰结束超过 grace 且没有后继 turn 的 sealed turn 的瞬态事件。
   * 覆盖 subagent 子 session 这类一次性 session。返回本次淘汰条数。
   */
  pruneTransientEvents(
    nowMs: number = this.now(),
    graceMs: number = SEALED_TURN_TRANSIENT_GRACE_MS,
  ): number {
    let evicted = 0;
    for (const state of this.sessions.values()) {
      const expired = state.policy.collectExpired(nowMs, graceMs);
      if (expired.length === 0) {
        continue;
      }
      const before = state.evictedEvents;
      this.evictTransientEvents(state, new Set(expired));
      evicted += state.evictedEvents - before;
    }
    return evicted;
  }

  private evictTransientEvents(state: SessionEventState, turnIds: ReadonlySet<string>): void {
    const retained: SessionEvent[] = [];
    for (const event of state.events) {
      if (isTransientSessionEvent(event) && event.turnId && turnIds.has(event.turnId)) {
        state.evictedEvents += 1;
        continue;
      }
      // 同一淘汰节拍：已 sealed 且已持久化的 turn，其 model_request 只需保留元数据。
      retained.push(
        event.turnId && turnIds.has(event.turnId) ? slimRetainedModelRequest(event) : event,
      );
    }
    state.events = retained;
  }

  async getEvents(sessionId: SessionId): Promise<SessionEvent[]> {
    return [...(this.sessions.get(sessionId)?.events ?? [])];
  }

  async getEventsAfter(sessionId: SessionId, sequenceNumber: number): Promise<SessionEvent[]> {
    return (this.sessions.get(sessionId)?.events ?? []).filter(
      (event) => event.sequenceNumber > sequenceNumber,
    );
  }

  async getLatestSequenceNumber(sessionId: SessionId): Promise<number> {
    return this.sessions.get(sessionId)?.latestSequenceNumber ?? 0;
  }

  async deleteSession(sessionId: SessionId): Promise<void> {
    this.sessions.delete(sessionId);
  }

  /** 供内存诊断日志读取驻留规模；只数长度，不拷贝。 */
  getStats(): SessionEventStoreStats {
    let events = 0;
    let evictedEvents = 0;
    let retainedTransient = 0;
    for (const state of this.sessions.values()) {
      events += state.events.length;
      evictedEvents += state.evictedEvents;
      for (const event of state.events) {
        if (isTransientSessionEvent(event)) {
          retainedTransient += 1;
        }
      }
    }
    return { sessions: this.sessions.size, events, evictedEvents, retainedTransient };
  }
}

export function createInMemorySessionEventStore(
  options?: InMemorySessionEventStoreOptions,
): InMemorySessionEventStore {
  return new InMemorySessionEventStore(options);
}
