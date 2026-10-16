import {
  SessionEventType,
  createEventId,
  type HighspeedMessageMetadata,
  type SessionEvent,
  type SessionEventStorePort,
  type SessionId,
  type SessionStorePort,
  type TraceId,
} from "@zcode/contracts";
import { highspeedMessageMetaSchema } from "@zcode/shared";

export interface PersistHighspeedMetricsInput {
  sessionStore: SessionStorePort;
  eventStore: SessionEventStorePort;
  sessionId: string;
  messageId: string;
  entityId: string;
  metrics: {
    regularTps: number;
    outputTokens: number;
    durationMs: number;
    highspeedTps: number;
    savedDurationMs: number;
    modelDurationMs?: number;
    toolDurationMs?: number;
    otherDurationMs?: number;
  };
  traceId: string;
  now?: () => number;
  onPersistedEvent(event: SessionEvent): void;
  onLiveProjectionError?(error: unknown): void;
}

export interface PersistHighspeedTimingInput {
  sessionStore: SessionStorePort;
  eventStore: SessionEventStorePort;
  sessionId: string;
  sourceCommandId: string;
  timing: {
    modelDurationMs: number;
    toolDurationMs: number;
    otherDurationMs: number;
  };
  outputTokens?: number;
  durationMs?: number;
  /**
   * live 投影中该 Turn 已产生的卡失效降级时刻。它只存在于 live 投影，终态持久化若不把它一并写入
   * transcript，HighspeedMetricsUpdated 与 cold hydration 都会丢掉它（spec §5）。
   */
  fallbackAt?: number;
  /** 与 fallbackAt 同源的降级原因；同一规则只增不删，缺省时冷恢复按卡过期文案处理。 */
  fallbackReason?: HighspeedMessageMetadata["fallbackReason"];
  traceId: string;
  now?: () => number;
  onPersistedEvent(event: SessionEvent): void;
  onLiveProjectionError?(error: unknown): void;
}

/**
 * turn 终态由 CLI 自己把真实拆分落到 transcript，renderer 不在场也不会丢失耗时。
 * 该阶段不要求 healthy TPS；卡到期后 renderer/后续 CLI 流程再补齐卡级指标。
 */
export async function persistHighspeedTiming(input: PersistHighspeedTimingInput): Promise<void> {
  const sessionId = input.sessionId as SessionId;
  const messages = await input.sessionStore.messages({ sessionID: sessionId });
  const user = messages.find((message) => {
    if (message.info.role !== "user") return false;
    const intent = message.info.metadata?.conversationInputIntent as
      | Record<string, unknown>
      | undefined;
    return (
      intent &&
      typeof intent === "object" &&
      !Array.isArray(intent) &&
      intent.sourceCommandId === input.sourceCommandId
    );
  });
  if (!user || user.info.role !== "user") return;
  const current = highspeedMessageMetaSchema.safeParse(user.info.metadata?.highspeed);
  if (!current.success) return;
  const highspeed = highspeedMessageMetaSchema.parse({
    ...current.data,
    ...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...input.timing,
    // 只增不删：transcript 已持久化的 fallbackAt 优先；缺失时才补写 live 投影的值。
    ...(current.data.fallbackAt === undefined && input.fallbackAt !== undefined
      ? { fallbackAt: input.fallbackAt }
      : {}),
    ...(current.data.fallbackReason === undefined && input.fallbackReason !== undefined
      ? { fallbackReason: input.fallbackReason }
      : {}),
  });
  const metadata: Record<string, unknown> = {
    ...(user.info.metadata as Record<string, unknown>),
    highspeed,
  };
  if (
    metadata.conversationInputIntent &&
    typeof metadata.conversationInputIntent === "object" &&
    !Array.isArray(metadata.conversationInputIntent)
  ) {
    metadata.conversationInputIntent = {
      ...metadata.conversationInputIntent,
      highspeed,
    };
  }
  const { metadata: _previousMetadata, ...userInfoWithoutMetadata } = user.info;
  await input.sessionStore.saveMessage({ ...userInfoWithoutMetadata, metadata });
  const event: SessionEvent = {
    id: createEventId(),
    sessionId,
    type: SessionEventType.HighspeedMetricsUpdated,
    timestamp: new Date((input.now ?? Date.now)()),
    traceId: input.traceId as TraceId,
    sequenceNumber: (await input.eventStore.getLatestSequenceNumber(sessionId)) + 1,
    payload: { entityId: String(user.info.id), highspeed },
  };
  try {
    input.onPersistedEvent(await input.eventStore.append(event));
  } catch (error) {
    try {
      await input.sessionStore.saveMessage(user.info);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "highspeed timing rollback failed");
    }
    throw error;
  }
}

/** transcript 是 Highspeed 完成态统计的持久权威；event 只推进 live/replayable 投影。 */
export async function persistHighspeedMetrics(input: PersistHighspeedMetricsInput): Promise<void> {
  const sessionId = input.sessionId as SessionId;
  const messages = await input.sessionStore.messages({ sessionID: sessionId });
  const user = messages.find((message) => String(message.info.id) === input.messageId);
  if (!user || user.info.role !== "user") throw new Error("proto.staleTarget");

  const metadata = { ...user.info.metadata };
  const currentHighspeed = highspeedMessageMetaSchema.safeParse(metadata.highspeed);
  if (!currentHighspeed.success) throw new Error("guard.actionUnavailable");
  const highspeed = highspeedMessageMetaSchema.parse({
    ...currentHighspeed.data,
    ...input.metrics,
  });
  metadata.highspeed = highspeed;
  if (
    metadata.conversationInputIntent &&
    typeof metadata.conversationInputIntent === "object" &&
    !Array.isArray(metadata.conversationInputIntent)
  ) {
    metadata.conversationInputIntent = {
      ...metadata.conversationInputIntent,
      highspeed,
    };
  }
  const { metadata: _previousMetadata, ...userInfoWithoutMetadata } = user.info;
  const nextUserInfo = { ...userInfoWithoutMetadata, metadata };
  await input.sessionStore.saveMessage(nextUserInfo);

  const event: SessionEvent = {
    id: createEventId(),
    sessionId,
    type: SessionEventType.HighspeedMetricsUpdated,
    timestamp: new Date((input.now ?? Date.now)()),
    traceId: input.traceId as TraceId,
    sequenceNumber: (await input.eventStore.getLatestSequenceNumber(sessionId)) + 1,
    payload: { entityId: input.entityId, highspeed },
  };
  let persisted: SessionEvent;
  try {
    persisted = await input.eventStore.append(event);
  } catch (error) {
    try {
      await input.sessionStore.saveMessage(user.info);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "highspeed metrics event append failed and transcript rollback failed",
      );
    }
    throw error;
  }
  try {
    input.onPersistedEvent(persisted);
  } catch (error) {
    input.onLiveProjectionError?.(error);
  }
}
