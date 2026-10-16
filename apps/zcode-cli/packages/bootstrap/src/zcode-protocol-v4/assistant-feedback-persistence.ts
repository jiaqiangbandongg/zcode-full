import {
  SessionEventType,
  createEventId,
  type SessionEvent,
  type SessionEventStorePort,
  type SessionId,
  type SessionStorePort,
  type TraceId,
} from "@zcode/contracts";

export interface PersistAssistantFeedbackInput {
  sessionStore: SessionStorePort;
  eventStore: SessionEventStorePort;
  sessionId: string;
  messageId: string;
  entityId: string;
  feedback: "like" | "dislike" | null;
  traceId: string;
  now?: () => number;
  onPersistedEvent(event: SessionEvent): void;
  onLiveProjectionError?(error: unknown): void;
}

/** transcript 是反馈持久权威；event 只负责把同一写入推进 live/cold projection。 */
export async function persistAssistantFeedback(
  input: PersistAssistantFeedbackInput,
): Promise<void> {
  const sessionId = input.sessionId as SessionId;
  const messages = await input.sessionStore.messages({ sessionID: sessionId });
  const assistant = messages.find((message) => String(message.info.id) === input.messageId);
  if (!assistant || assistant.info.role !== "assistant") {
    throw new Error("proto.staleTarget");
  }
  const metadata = { ...assistant.info.metadata };
  if (input.feedback === null) {
    delete metadata.assistantFeedback;
  } else {
    metadata.assistantFeedback = input.feedback;
  }
  const { metadata: _previousMetadata, ...assistantInfoWithoutMetadata } = assistant.info;
  const nextAssistantInfo = {
    ...assistantInfoWithoutMetadata,
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
  await input.sessionStore.saveMessage(nextAssistantInfo);

  const event: SessionEvent = {
    id: createEventId(),
    sessionId,
    type: SessionEventType.AssistantFeedbackUpdated,
    timestamp: new Date((input.now ?? Date.now)()),
    traceId: input.traceId as TraceId,
    sequenceNumber: (await input.eventStore.getLatestSequenceNumber(sessionId)) + 1,
    payload: {
      entityId: input.entityId,
      feedback: input.feedback,
    },
  };
  let persisted: SessionEvent;
  try {
    persisted = await input.eventStore.append(event);
  } catch (error) {
    // transcript 先成功、event append 后失败时，renderer 会按失败 ACK 回滚，
    // 但重开又从半提交 metadata 恢复反馈。append 失败必须补偿回原始 message info。
    try {
      await input.sessionStore.saveMessage(assistant.info);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "assistant feedback event append failed and transcript rollback failed",
      );
    }
    throw error;
  }

  try {
    input.onPersistedEvent(persisted);
  } catch (error) {
    // event 已 durable 后不能再给 renderer 失败 ACK，否则 UI 回滚会与持久事实相反；
    // live projection 失败留给 resync/hydration 收敛，并只走诊断回调。
    input.onLiveProjectionError?.(error);
  }
}
