import type { ZCodeSessionEvent } from "@zcode/shared";

const MAX_TRACKED_SESSION_EVENT_IDS = 10_000;

export interface ZCodeSessionEventGap {
  expectedSeq: number;
  receivedSeq: number;
}

export interface ZCodeSessionEventOrderResult {
  duplicate?: boolean;
  gap?: ZCodeSessionEventGap;
  readyEvents: ZCodeSessionEvent[];
}

export interface ZCodeSessionEventOrderGate {
  clearPendingAfterGap(): void;
  getGap(): ZCodeSessionEventGap | undefined;
  markSnapshotSeq(seq: number, options?: { preservePendingEvents?: boolean }): ZCodeSessionEvent[];
  push(event: ZCodeSessionEvent): ZCodeSessionEventOrderResult;
  releasePendingAfterGap(options?: {
    preserve?: (event: ZCodeSessionEvent) => boolean;
  }): ZCodeSessionEvent[];
}

function rememberBoundedId(ids: Set<string>, order: string[], id: string): boolean {
  if (ids.has(id)) {
    return false;
  }
  ids.add(id);
  order.push(id);
  while (order.length > MAX_TRACKED_SESSION_EVENT_IDS) {
    const removed = order.shift();
    if (removed) {
      ids.delete(removed);
    }
  }
  return true;
}

export function createZCodeSessionEventOrderGate(): ZCodeSessionEventOrderGate {
  const deliveredEventIds = new Set<string>();
  const deliveredEventIdOrder: string[] = [];
  const pendingEvents = new Map<number, ZCodeSessionEvent>();
  let nextSeq: number | null = null;

  const drainReadyEvents = (): ZCodeSessionEvent[] => {
    if (nextSeq === null) {
      return [];
    }
    const readyEvents: ZCodeSessionEvent[] = [];
    while (nextSeq !== null) {
      const event = pendingEvents.get(nextSeq);
      if (!event) {
        break;
      }
      pendingEvents.delete(nextSeq);
      readyEvents.push(event);
      nextSeq += 1;
    }
    return readyEvents;
  };

  const currentGap = (): ZCodeSessionEventGap | undefined => {
    if (nextSeq === null || pendingEvents.size === 0) {
      return undefined;
    }
    const receivedSeq = Math.min(...pendingEvents.keys());
    return receivedSeq > nextSeq
      ? {
          expectedSeq: nextSeq,
          receivedSeq,
        }
      : undefined;
  };

  return {
    clearPendingAfterGap() {
      pendingEvents.clear();
      nextSeq = null;
    },

    getGap() {
      return currentGap();
    },

    markSnapshotSeq(seq: number, options: { preservePendingEvents?: boolean } = {}) {
      if (seq < 0) {
        return [];
      }
      const nextSnapshotSeq = seq + 1;
      if (options.preservePendingEvents) {
        // Bugfix: running snapshot 的 eventSeq 只能说明控制状态追到这里，不代表
        // 流式正文/思考已经写入 snapshot。已到达但尚未放行的 delta 需要继续交给
        // UI 消费，否则切 session 时会吞掉快照水位之前的首段正文。
        const preservedEvents = Array.from(pendingEvents.values())
          .filter((event) => event.seq < nextSnapshotSeq)
          .sort((left, right) => left.seq - right.seq);
        for (const event of preservedEvents) {
          pendingEvents.delete(event.seq);
        }
        nextSeq = nextSeq === null ? nextSnapshotSeq : Math.max(nextSeq, nextSnapshotSeq);
        return [...preservedEvents, ...drainReadyEvents()];
      }
      nextSeq = nextSeq === null ? nextSnapshotSeq : Math.max(nextSeq, nextSnapshotSeq);
      for (const pendingSeq of pendingEvents.keys()) {
        if (pendingSeq < nextSeq) {
          pendingEvents.delete(pendingSeq);
        }
      }
      return drainReadyEvents();
    },

    push(event: ZCodeSessionEvent) {
      if (event.seq <= 0) {
        return { readyEvents: [event] };
      }
      if (!rememberBoundedId(deliveredEventIds, deliveredEventIdOrder, event.eventId)) {
        return { duplicate: true, readyEvents: [] };
      }
      if (nextSeq === null) {
        nextSeq = event.seq;
      }
      if (event.seq < nextSeq || pendingEvents.has(event.seq)) {
        return { duplicate: true, readyEvents: [] };
      }
      pendingEvents.set(event.seq, event);
      return {
        gap: currentGap(),
        readyEvents: drainReadyEvents(),
      };
    },

    releasePendingAfterGap(options = {}) {
      const pending = Array.from(pendingEvents.values()).sort(
        (left, right) => left.seq - right.seq,
      );
      pendingEvents.clear();
      nextSeq = null;
      return options.preserve ? pending.filter(options.preserve) : [];
    },
  };
}
