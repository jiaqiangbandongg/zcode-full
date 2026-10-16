import type { ZCodeStreamEvent } from "@zcode/shared";

const CONTINUOUS_CHUNK_FLUSH_DELAY_MS = 16;
const CONTINUOUS_CHUNK_MAX_CHARS = 4096;
const CONTINUOUS_CHUNK_MAX_EVENTS = 128;
const CONTINUOUS_CHUNK_KEY_SEPARATOR = "\u0000";

type ContinuousCoalescibleChunk =
  | Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }>
  | Extract<ZCodeStreamEvent, { type: "agent_thought_chunk" }>;

type ContinuousCoalescibleState =
  | Extract<ZCodeStreamEvent, { type: "usage_update" }>
  | Extract<ZCodeStreamEvent, { type: "session_info_update" }>;

interface PendingContinuousChunkItem {
  kind: "chunk";
  event: ContinuousCoalescibleChunk;
  chunkCount: number;
  charCount: number;
}

interface PendingContinuousStateItem {
  kind: "state";
  event: ContinuousCoalescibleState;
  stateKey: string;
}

type PendingContinuousItem = PendingContinuousChunkItem | PendingContinuousStateItem;

interface ContinuousStreamCoalescer {
  accept(event: ZCodeStreamEvent): void;
  flush(): void;
  dispose(): void;
}

function isContinuousCoalescibleChunk(event: ZCodeStreamEvent): event is ContinuousCoalescibleChunk {
  return (
    event.type === "agent_thought_chunk" ||
    (event.type === "agent_message_chunk" && !event.zcodeTimeline)
  );
}

function isContinuousCoalescibleState(event: ZCodeStreamEvent): event is ContinuousCoalescibleState {
  if (event.type === "usage_update") {
    return true;
  }

  // Bugfix: api_retry 会以 session_info_update 高频推送，但 title/target 是会话元信息变更。
  // 这里只合并纯重试状态，避免标题或目标补丁被延迟后影响任务列表/目标展示的一致性。
  return (
    event.type === "session_info_update" &&
    event.title === undefined &&
    event.target === undefined &&
    "apiRetry" in event
  );
}

function normalizeChunkParentToolUseId(event: ContinuousCoalescibleChunk): string {
  return event.parentToolUseId ?? "";
}

function getContinuousChunkMergeKey(event: ContinuousCoalescibleChunk): string {
  return [
    event.type,
    event.taskId,
    event.traceId,
    normalizeChunkParentToolUseId(event),
    event.type === "agent_message_chunk" ? event.messageId ?? "" : "",
  ].join(CONTINUOUS_CHUNK_KEY_SEPARATOR);
}

function getContinuousStateMergeKey(event: ContinuousCoalescibleState): string {
  return [
    event.type,
    event.taskId,
    event.traceId,
  ].join(CONTINUOUS_CHUNK_KEY_SEPARATOR);
}

function mergeContinuousChunks(
  current: ContinuousCoalescibleChunk,
  next: ContinuousCoalescibleChunk,
): ContinuousCoalescibleChunk {
  return {
    ...current,
    content: `${current.content}${next.content}`,
  };
}

export function createContinuousStreamCoalescer(params: {
  emit: (event: ZCodeStreamEvent) => void;
  flushDelayMs?: number;
  maxChars?: number;
  maxEvents?: number;
}): ContinuousStreamCoalescer {
  const flushDelayMs = params.flushDelayMs ?? CONTINUOUS_CHUNK_FLUSH_DELAY_MS;
  const maxChars = params.maxChars ?? CONTINUOUS_CHUNK_MAX_CHARS;
  const maxEvents = params.maxEvents ?? CONTINUOUS_CHUNK_MAX_EVENTS;
  let pendingItems: PendingContinuousItem[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function clearFlushTimer(): void {
    if (!flushTimer) {
      return;
    }
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function flushPending(): void {
    if (pendingItems.length === 0) {
      clearFlushTimer();
      return;
    }
    const events = pendingItems.map((item) => item.event);
    pendingItems = [];
    clearFlushTimer();
    for (const event of events) {
      params.emit(event);
    }
  }

  function scheduleFlush(): void {
    if (flushTimer || disposed || flushDelayMs <= 0) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushPending();
    }, flushDelayMs);
  }

  function startPendingChunk(event: ContinuousCoalescibleChunk): void {
    pendingItems.push({
      kind: "chunk",
      event,
      chunkCount: 1,
      charCount: event.content.length,
    });
    if (event.content.length >= maxChars || pendingItems.length >= maxEvents || flushDelayMs <= 0) {
      flushPending();
      return;
    }
    scheduleFlush();
  }

  function acceptPendingState(event: ContinuousCoalescibleState): void {
    const stateKey = getContinuousStateMergeKey(event);
    const existingItem = pendingItems.find(
      (item): item is PendingContinuousStateItem =>
        item.kind === "state" && item.stateKey === stateKey,
    );
    if (existingItem) {
      existingItem.event = event;
      return;
    }

    // Bugfix: usage/apiRetry 这类状态事件会跟正文流同频到达。逐条透给桌面 continuous
    // 会让 renderer 反复写 store 并触发 React 同步渲染；按帧只保留最新状态即可保持 UI 语义。
    pendingItems.push({ kind: "state", event, stateKey });
    if (pendingItems.length >= maxEvents || flushDelayMs <= 0) {
      flushPending();
      return;
    }
    scheduleFlush();
  }

  return {
    accept(event: ZCodeStreamEvent): void {
      if (disposed) {
        return;
      }

      if (isContinuousCoalescibleState(event)) {
        acceptPendingState(event);
        return;
      }

      if (!isContinuousCoalescibleChunk(event)) {
        // Bugfix: 桌面 continuous 之前把几千个 1-5 字符 chunk 逐条塞进 RPC，
        // terminal 和 sendPrompt 返回会排在这些小包后面。这里在结构化事件前先 flush，
        // 保持工具、权限、快照和终态事件的相对顺序，同时把普通正文流收敛到帧级别。
        flushPending();
        params.emit(event);
        return;
      }

      const lastItem = pendingItems[pendingItems.length - 1];
      if (!lastItem) {
        startPendingChunk(event);
        return;
      }

      if (
        lastItem.kind !== "chunk" ||
        getContinuousChunkMergeKey(lastItem.event) !== getContinuousChunkMergeKey(event)
      ) {
        startPendingChunk(event);
        return;
      }

      const nextItem: PendingContinuousChunkItem = {
        kind: "chunk",
        event: mergeContinuousChunks(lastItem.event, event),
        chunkCount: lastItem.chunkCount + 1,
        charCount: lastItem.charCount + event.content.length,
      };
      pendingItems[pendingItems.length - 1] = nextItem;
      if (nextItem.charCount >= maxChars || nextItem.chunkCount >= maxEvents) {
        flushPending();
      }
    },

    flush(): void {
      flushPending();
    },

    dispose(): void {
      disposed = true;
      pendingItems = [];
      clearFlushTimer();
    },
  };
}
