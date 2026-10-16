/**
 * ask 的**出生事实**：`node-queued` 带的那几样，以及缓存命中的 `node-settled` 重发的同一份
 * （types.ts 的 `node-settled`；docs/execution-engine.md「Events」）。
 *
 * 从 scheduler.ts 拆出（oxlint max-lines 上限 400 行）。任务摘要的规则也搬到这里：两条出生事件
 * 带的必须是逐字同一个串，同一个函数算就不会漂。
 */

import type { ImportedActorState } from "./imported-cache.js";
import { INSTRUCTIONS_HEAD_MAX_CHARS, type ActorRef } from "./types.js";

/** 缓存命中的 ask 结算在 `{type, instance, outcome, cached, error?}` 之外多带的键。 */
export interface CachedAskFacts {
  kind: "ask";
  actor: ActorRef;
  actorSeq: number;
  instructionsHead?: string;
  sourceSessionId?: string;
}

/**
 * 一次缓存命中的出生事实。**在命中判定的那一刻取**：`sourceSessionId` 读的是那一刻的导入消费态
 * （{@link ImportedActorState.sourceSessionAt}），而事件本身可能被结算次序闸推迟。
 */
export function cachedAskFacts(
  actor: ActorRef,
  seq: number,
  instructions: string,
  imported: ImportedActorState | undefined,
): CachedAskFacts {
  const instructionsHead = headOfInstructions(instructions);
  const sourceSessionId = imported?.sourceSessionAt(seq);
  return {
    kind: "ask",
    actor,
    actorSeq: seq,
    ...(instructionsHead === undefined ? {} : { instructionsHead }),
    ...(sourceSessionId === undefined ? {} : { sourceSessionId }),
  };
}

/**
 * 作者指令的开头（{@link INSTRUCTIONS_HEAD_MAX_CHARS} 个字符，去两端空白，**不加省略号**）。
 * 空指令返回 undefined：缺席的键比一个空串诚实——读面据此退回「不知道它被交代了什么」。
 */
export function headOfInstructions(instructions: string): string | undefined {
  const trimmed = instructions.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= INSTRUCTIONS_HEAD_MAX_CHARS
    ? trimmed
    : trimmed.slice(0, INSTRUCTIONS_HEAD_MAX_CHARS);
}
