import {
  conversationTopicFrameSchema,
  TopicWireFrameAssembler,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type SessionControl,
  type ConversationTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService, ZCodeAgentSessionTarget } from "#src/zcode-agent/zcodeAgent.js";

/** Bot 控制操作临时读取 CLI 权威快照，不建立第二份输入队列。 */
export function readBotGroupRuntimeSnapshot(
  agent: IZCodeAgentService,
  target: ZCodeAgentSessionTarget,
): Promise<ConversationSnapshot> {
  return observeRuntime(agent, target, (frame) =>
    frame.payload.kind === "snapshot" ? frame.payload.snapshot : undefined,
  );
}

/** 只观察同一订阅的连续控制状态；停止 ACK 不是终态证据。 */
export function waitBotGroupExecutionEnd(
  agent: IZCodeAgentService,
  target: ZCodeAgentSessionTarget,
  executionId: string,
  signal?: AbortSignal,
): Promise<SessionControl> {
  let seq: number | undefined;
  let control: SessionControl | undefined;
  return observeRuntime(
    agent,
    target,
    (frame) => {
      if (frame.payload.kind === "snapshot") {
        seq = frame.toSeq;
        control = frame.payload.snapshot.control;
      } else {
        if (seq === undefined || frame.fromSeq !== seq) throw new Error("Topic stop control gap");
        seq = frame.toSeq;
        for (const delta of frame.payload.deltas) {
          if (delta.op === "state.updated" && delta.patch.control) control = delta.patch.control;
        }
      }
      if (!control || control.stopState === "stopping") return undefined;
      const active = control.activeWorks;
      const stillRunning = active.some((work) => work.foregroundExecutionId === executionId);
      const identityKnown = active.length > 0 && active.every((work) => work.foregroundExecutionId);
      return !stillRunning && (control.stopState === "idle" || identityKnown) ? control : undefined;
    },
    signal,
  );
}

async function observeRuntime<T>(
  agent: IZCodeAgentService,
  target: ZCodeAgentSessionTarget,
  select: (frame: ConversationTopicFrame) => T | undefined,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
  const early: ConversationTopicWireCandidate[] = [];
  let subscriptionId: string | undefined;
  let resolveSnapshot!: (snapshot: T) => void;
  let rejectSnapshot!: (reason: unknown) => void;
  const snapshot = new Promise<T>((resolve, reject) => {
    resolveSnapshot = resolve;
    rejectSnapshot = reject;
  });
  // 订阅 ACK 可能晚于首帧送达；先注册监听，取得 ownership 后才解析缓存帧。
  void snapshot.catch(() => undefined);
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  void aborted.catch(() => undefined);
  const abort = () => rejectAbort(signal?.reason ?? new Error("Topic observation aborted"));
  signal?.addEventListener("abort", abort, { once: true });
  const accept = (wire: ConversationTopicWireCandidate): void => {
    if (wire.topic !== `conversation/${target.sessionId}`) return;
    if (!subscriptionId) {
      if (early.length < 128) early.push(wire);
      return;
    }
    if (wire.subscriptionId !== subscriptionId) return;
    for (const event of assembler.accept(wire)) {
      if (event.kind === "fault") rejectSnapshot(new Error(event.fault.reasonCode));
      else {
        try {
          const selected = select(event.frame);
          if (selected !== undefined) resolveSnapshot(selected);
        } catch (error) {
          rejectSnapshot(error);
        }
      }
    }
  };
  const listener = agent.onDynamicConversationFrame(target)(accept);
  let closed = false;
  let timeout!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("Group runtime snapshot timed out")), 15_000);
  });
  const release = (id: string) => {
    void agent.unsubscribeConversationV4({ ...target, subscriptionId: id }).catch(() => undefined);
  };
  try {
    // 超时必须覆盖订阅 ACK 本身；迟到的 ACK 仍要释放，不留下后台订阅。
    const subscribing = agent
      .subscribeConversationV4({ ...target, visibility: "background" })
      .then((result) => {
        if (closed) release(result.ack.subscriptionId);
        return result;
      });
    const result = await Promise.race([subscribing, deadline, aborted]);
    subscriptionId = result.ack.subscriptionId;
    for (const frame of early.splice(0)) accept(frame);
    return await Promise.race([snapshot, deadline, aborted]);
  } finally {
    closed = true;
    signal?.removeEventListener("abort", abort);
    clearTimeout(timeout);
    listener.dispose();
    if (subscriptionId) release(subscriptionId);
  }
}
