import type { JsonObject, OpenAiMessage } from "./types.js";

const REMOVED_REFERENCE_TEXTS = new Set([
  "[Tool references removed - tools no longer available]",
  "[Tool references removed - tool search not enabled]",
]);
const ANNOUNCEMENT_PREFIX = "<system-reminder>\n";
const ANNOUNCEMENT_SUFFIX = "\n</system-reminder>";
const TOOL_SEARCH_LOADED_TEXT = "Tool loaded.";
// 当前公告不再推断连接原因；离线工具同时识别新旧文案，避免关闭搜索后误判历史断链。
const ANNOUNCEMENT_HEADINGS = [
  /^The following deferred tools are (?:now )?available via ToolSearch\./u,
  /^The following deferred tools are no longer available(?: \(their MCP server disconnected\))?\./u,
  /^\d+ deferred tools are no longer available(?: \(MCP server disconnected\))?:/u,
  /^\d+ deferred tools? (?:is|are) available again \((?:MCP server reconnected — )?names announced earlier in this conversation\):/u,
];

/** 仅创建离线比较视图；最终轨迹必须继续使用原始请求，不输出这里过滤后的内容。 */
export function toolSearchComparisonMessages(
  messages: readonly OpenAiMessage[],
): readonly OpenAiMessage[] {
  const searchCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (
        isObject(block) &&
        block.type === "tool_use" &&
        block.name === "ToolSearch" &&
        typeof block.id === "string"
      ) {
        searchCallIds.add(block.id);
      }
    }
  }
  let pendingLoaded = 0;
  return messages.flatMap((message) => {
    if (message.role !== "user" || !Array.isArray(message.content)) {
      pendingLoaded = 0;
      return [message];
    }
    const content = message.content
      .filter((block) => {
        if (isObject(block) && block.type === "tool_result") {
          if (
            typeof block.tool_use_id === "string" &&
            searchCallIds.has(block.tool_use_id) &&
            block.is_error !== true &&
            Array.isArray(block.content) &&
            block.content.some((item) => isObject(item) && item.type === "tool_reference")
          )
            pendingLoaded++;
          return true;
        }
        // 成功提示派生在整批结果之外；只按有效搜索结果计数忽略，不能全局删除同名正文。
        if (
          pendingLoaded > 0 &&
          isObject(block) &&
          block.type === "text" &&
          block.text === TOOL_SEARCH_LOADED_TEXT
        ) {
          pendingLoaded--;
          return false;
        }
        pendingLoaded = 0;
        return !isAnnouncement(block);
      })
      .map((block: unknown) => {
        if (
          !isObject(block) ||
          block.type !== "tool_result" ||
          typeof block.tool_use_id !== "string" ||
          !searchCallIds.has(block.tool_use_id) ||
          !Array.isArray(block.content)
        )
          return block;
        return {
          ...block,
          content: block.content.filter(
            (item: unknown) =>
              !isObject(item) ||
              (item.type !== "tool_reference" &&
                !(
                  item.type === "text" &&
                  typeof item.text === "string" &&
                  REMOVED_REFERENCE_TEXTS.has(item.text)
                )),
          ),
        };
      });
    // 公告独占一条 user 时，关闭/恢复会使消息数变化；普通空消息仍保留并参与比较。
    return content.length === 0 && message.content.length > 0 ? [] : [{ ...message, content }];
  });
}

function isAnnouncement(block: unknown): boolean {
  if (!isObject(block) || block.type !== "text" || typeof block.text !== "string") return false;
  const value = block.text;
  return (
    value.startsWith(ANNOUNCEMENT_PREFIX) &&
    value.endsWith(ANNOUNCEMENT_SUFFIX) &&
    ANNOUNCEMENT_HEADINGS.some((heading) => heading.test(value.slice(ANNOUNCEMENT_PREFIX.length)))
  );
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
