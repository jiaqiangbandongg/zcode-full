import { MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES } from "@zcode/shared/mcp-apps";

/** `ui/message` 的 structuredContent 序列化后允许的最大 UTF-8 字节数（与工具结果同一上限）。 */
export const PLUGIN_UI_FOLLOW_UP_STRUCTURED_MAX_BYTES = MCP_APPS_STRUCTURED_CONTENT_MAX_BYTES;

export type PluginUiFollowUpPromptResult =
  | { ok: true; prompt: string }
  | { ok: false; reason: "empty_prompt" | "structured_too_large"; bytes?: number };

/**
 * 发出去的消息 = 插件文本原样 + structuredContent 的 JSON（```json 块），
 * 不加任何"来自插件 / 不可信"的明文提示；来源只进消息 metadata（`source.kind = "pluginUi"`）。
 * 无法序列化的 structuredContent（循环引用等）按缺省处理。
 */
export function buildPluginUiFollowUpPrompt(
  prompt: string,
  structuredContent: unknown,
): PluginUiFollowUpPromptResult {
  const text = prompt.trim();
  if (!text) return { ok: false, reason: "empty_prompt" };
  if (structuredContent === undefined) return { ok: true, prompt: text };
  let json: string;
  try {
    json = JSON.stringify(structuredContent, null, 2);
  } catch {
    return { ok: true, prompt: text };
  }
  if (json === undefined) return { ok: true, prompt: text };
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > PLUGIN_UI_FOLLOW_UP_STRUCTURED_MAX_BYTES) {
    return { ok: false, reason: "structured_too_large", bytes };
  }
  return { ok: true, prompt: `${text}\n\n\`\`\`json\n${json}\n\`\`\`` };
}
