import type { ModelStreamingPayload, SessionEvent, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

const MODEL_STREAMING_EVENT_WRITE_HIGH_WATER_MARK = 128;

export interface ModelStreamingEventQueue {
  drain(): Promise<void>;
  enqueue(payload: ModelStreamingPayload): void;
  maybeApplyBackpressure(): Promise<void>;
}

export function createModelStreamingEventQueue(params: {
  events: SessionEvent[];
  highWaterMark?: number;
  runtime: AgentRuntimeInternal;
  traceContext: TraceContext;
}): ModelStreamingEventQueue {
  const highWaterMark =
    params.highWaterMark ?? MODEL_STREAMING_EVENT_WRITE_HIGH_WATER_MARK;
  let pendingWrites = 0;
  let tail: Promise<void> = Promise.resolve();
  let writeFailure: unknown;

  const assertNoWriteFailure = (): void => {
    if (writeFailure) {
      throw writeFailure;
    }
  };

  const drain = async (): Promise<void> => {
    await tail;
    assertNoWriteFailure();
  };

  return {
    async drain(): Promise<void> {
      await drain();
    },

    enqueue(payload: ModelStreamingPayload): void {
      assertNoWriteFailure();
      pendingWrites += 1;
      // 逐个 token 同步 append 会让 provider SSE reader 停在
      // iterator.next() 之外，已经到达的帧要等落库/通知完成后才被消费。
      // 这里把 append 串成有序写队列，读取侧继续 drain provider 队列；
      // finish / error / tool_call 边界再显式 drain，保持原有顺序语义。
      tail = tail
        .then(async () => {
          if (writeFailure) {
            return;
          }
          await params.runtime.emitModelStreamingEvent(
            payload,
            params.traceContext,
            params.events,
          );
        })
        .catch((error: unknown) => {
          writeFailure ??= error;
        })
        .finally(() => {
          pendingWrites -= 1;
        });
    },

    async maybeApplyBackpressure(): Promise<void> {
      assertNoWriteFailure();
      if (pendingWrites < highWaterMark) {
        return;
      }
      await drain();
    },
  };
}
