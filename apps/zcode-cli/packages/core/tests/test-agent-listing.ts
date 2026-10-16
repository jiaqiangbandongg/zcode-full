import { modelMessageContentToText } from "@zcode/contracts";

/** 队列/trace fixture 按任务正文匹配响应；目录的原始请求由 agent-listing 专项测试验收。 */
export function withoutAgentListingMessages<T extends { content?: unknown; role?: string }>(
  messages: readonly T[],
): T[] {
  return messages.filter((message) => {
    if (message.role !== "user") return true;
    const text = modelMessageContentToText(message.content as never);
    return !/^<system-reminder>\n(?:Available agent types for the Agent tool:|New agent types are now available for the Agent tool:|The following agent types are no longer available:)/u.test(
      text,
    );
  });
}
