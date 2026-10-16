import type { McpAppsContentBlock } from "./hostContract.js";

/** 把 content 块里的 text 拼成一段纯文本；非 text 块跳过。 */
export function concatMcpAppsTextContent(content: readonly McpAppsContentBlock[]): string {
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}
