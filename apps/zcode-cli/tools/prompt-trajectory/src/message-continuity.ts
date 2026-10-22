import { isDeepStrictEqual } from "node:util";
import { toolSearchComparisonMessages } from "./tool-search-comparison.js";
import type { JsonObject, OpenAiMessage, TrajectoryDerivationOptions } from "./types.js";

export function isAppendOnly(
  previous: readonly OpenAiMessage[],
  next: readonly OpenAiMessage[],
  options: TrajectoryDerivationOptions = {},
): boolean {
  if (options.ignoreToolSearchChanges) {
    previous = toolSearchComparisonMessages(previous);
    next = toolSearchComparisonMessages(next);
  }
  if (next.length < previous.length) return false;
  return previous.every(
    (message, index) =>
      isTrajectoryMessageEqual(message, next[index]) ||
      (index === previous.length - 1 && isUserContentAppend(message, next[index])),
  );
}

export function completeAssistantMessage(
  summary: OpenAiMessage,
  previous: readonly OpenAiMessage[],
  next: unknown,
  options: TrajectoryDerivationOptions,
): OpenAiMessage {
  if (!Array.isArray(next) || !next.every(isMessage)) return summary;
  const before = options.ignoreToolSearchChanges
    ? toolSearchComparisonMessages(previous)
    : previous;
  const after = options.ignoreToolSearchChanges ? toolSearchComparisonMessages(next) : next;
  if (!isAppendOnly(before, after)) return summary;
  const recorded = after[before.length];
  if (recorded?.role !== "assistant" || !Array.isArray(recorded.content)) return summary;
  // response 摘要没有 thinking/签名；公告过滤可能改变索引，必须在同一比较视图中定位回复。
  const comparable = {
    ...recorded,
    content: recorded.content.filter((block: unknown) => {
      if (!block || typeof block !== "object") return true;
      const { type } = block as JsonObject;
      return type !== "thinking" && type !== "redacted_thinking";
    }),
  };
  return isTrajectoryMessageEqual(summary, comparable) ? structuredClone(recorded) : summary;
}

function isMessage(value: unknown): value is OpenAiMessage {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as JsonObject).role === "string"
  );
}

function isUserContentAppend(previous: OpenAiMessage, next: OpenAiMessage): boolean {
  if (previous.role !== "user" || next.role !== "user") return false;
  const { content: before, ...previousFields } = previous;
  const { content: after, ...nextFields } = next;
  if (!Array.isArray(before) || !Array.isArray(after) || after.length <= before.length)
    return false;
  // 相邻 user 合并会扩展最后一条消息；仅接受旧 block 原样保留的追加，不能掩盖历史改写。
  return (
    isTrajectoryMessageEqual(previousFields, nextFields) &&
    isDeepStrictEqual(removeCacheControl(before), removeCacheControl(after.slice(0, before.length)))
  );
}

export function isTrajectoryMessageEqual(previous: OpenAiMessage, next: OpenAiMessage): boolean {
  // Anthropic 缓存标记会漂移；只在比较时忽略，输出仍保留最新请求的原始值。
  return isDeepStrictEqual(removeCacheControl(previous), removeCacheControl(next));
}

function removeCacheControl(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(removeCacheControl);
  const result: JsonObject = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key !== "cache_control") result[key] = removeCacheControl(nestedValue);
  }
  return result;
}
