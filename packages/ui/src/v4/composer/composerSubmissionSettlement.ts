// Bug 根因（R3A-B-07）：ACK 丢失时远端 ChannelClient dispose 会先 reject 在途 sendText，
// ConversationComposer 把提交正文恢复回草稿；同一时刻 tab 失去 remoteSessionId，
// V4PaneConversationProvider 返回 null，整棵 SessionPane 连同 composer 一起卸载。
// 原实现里"命令被权威接管后清空 composer"的订阅只活在组件闭包里，卸载即丢失；
// 重连后新 composer 从草稿回填原文，权威 projection 到达时已无人监听，正文残留，
// 用户再点发送就产生第二次归属。
//
// 修复：把"已恢复到草稿、但命令尚未结算"的提交交给这个模块级账本持有，对 registry 的
// 订阅不随组件实例消亡；任意一次挂载的 composer 回填草稿后向本模块认领结算。
// 账本只存在 renderer 内存中（与 composerDraftRevision 同级），不进入草稿持久化或协议，
// 也不重放命令；它只负责把 registry 已给出的权威结论送达到当前持有该正文的 composer。
import {
  pendingCommandRegistry,
  type PendingCommandResolution,
} from "@/v4/pendingCommandRegistry.js";

export interface UnsettledComposerSubmission {
  commandId: string;
  /** 提交时冻结的完整正文；消费方据此确认回填的草稿仍是这次提交，而非用户新输入。 */
  text: string;
}

type SettledListener = (submission: UnsettledComposerSubmission) => void;

interface TrackedSubmission extends UnsettledComposerSubmission {
  settled: boolean;
  unsubscribe: () => void;
}

const trackedByScope = new Map<string, TrackedSubmission>();
const listenersByScope = new Map<string, Set<SettledListener>>();

function isAuthoritativeResolution(resolution: PendingCommandResolution): boolean {
  return resolution === "accepted" || resolution === "duplicate" || resolution === "authoritative";
}

function deliver(scopeKey: string, tracked: TrackedSubmission): void {
  const listeners = listenersByScope.get(scopeKey);
  if (!listeners || listeners.size === 0) return;
  // 一次结算只消费一次：投递给当前挂载的 composer 后即从账本移除。
  trackedByScope.delete(scopeKey);
  const submission = { commandId: tracked.commandId, text: tracked.text };
  for (const listener of listeners) listener(submission);
}

/**
 * 登记一条"正文已恢复回草稿、命令仍在等待权威结论"的提交。
 * 同一 scope 只保留最近一次提交：更早的提交若仍未结算，其正文已被后一次提交覆盖或消费。
 */
export function trackUnsettledComposerSubmission(
  scopeKey: string,
  submission: UnsettledComposerSubmission,
): void {
  trackedByScope.get(scopeKey)?.unsubscribe();
  const tracked: TrackedSubmission = {
    ...submission,
    settled: false,
    unsubscribe: () => undefined,
  };
  trackedByScope.set(scopeKey, tracked);
  tracked.unsubscribe = pendingCommandRegistry.subscribeResolution(
    submission.commandId,
    (resolution) => {
      if (trackedByScope.get(scopeKey) !== tracked) return;
      if (!isAuthoritativeResolution(resolution)) {
        // failed/unknown/discarded：原文应继续留在草稿里，交给既有的恢复 UI 处理。
        trackedByScope.delete(scopeKey);
        return;
      }
      tracked.settled = true;
      deliver(scopeKey, tracked);
    },
  );
}

/**
 * composer 回填草稿后调用：若该 scope 的提交已被权威接管则同步投递，否则等待结算。
 * 返回取消订阅函数；组件卸载时取消，账本中的提交继续等待下一次挂载。
 */
export function subscribeComposerSubmissionSettled(
  scopeKey: string,
  listener: SettledListener,
): () => void {
  const listeners = listenersByScope.get(scopeKey) ?? new Set<SettledListener>();
  listeners.add(listener);
  listenersByScope.set(scopeKey, listeners);
  const tracked = trackedByScope.get(scopeKey);
  if (tracked?.settled) deliver(scopeKey, tracked);
  return () => {
    const current = listenersByScope.get(scopeKey);
    current?.delete(listener);
    if (current?.size === 0) listenersByScope.delete(scopeKey);
  };
}
