import { MCP_APPS_IMAGE_MAX_BYTES, MCP_APPS_IMAGE_MIME_TYPES } from "@zcode/shared/mcp-apps";

/** 一张已校验的图片块：base64 正文（无 data: 前缀）、mimeType 与解码后字节数。 */
export interface PluginUiImageBlock {
  mimeType: string;
  dataBase64: string;
  bytes: number;
}

export type PluginUiImageBlocksResult =
  | { ok: true; images: PluginUiImageBlock[] }
  | {
      ok: false;
      reason: "unsupported_mime" | "too_large" | "invalid_block";
      mimeType?: string;
      bytes?: number;
    };

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function base64ByteLength(dataBase64: string): number {
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  return Math.floor((dataBase64.length * 3) / 4) - padding;
}

/**
 * 从 MCP 内容块里挑出 `{ type: "image", data, mimeType }`（text 等其它块忽略）。
 * 任一图片不在白名单或超限 → 整个请求失败，不做部分接受；页面据此改传更小的图。
 */
export function readPluginUiImageBlocks(
  content: readonly Record<string, unknown>[] | undefined,
): PluginUiImageBlocksResult {
  const images: PluginUiImageBlock[] = [];
  for (const block of content ?? []) {
    if (block.type !== "image") continue;
    const data = block.data;
    const mimeType = typeof block.mimeType === "string" ? block.mimeType.trim().toLowerCase() : "";
    if (typeof data !== "string" || data.length === 0 || !BASE64_PATTERN.test(data)) {
      return { ok: false, reason: "invalid_block", ...(mimeType ? { mimeType } : {}) };
    }
    if (!(MCP_APPS_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
      return { ok: false, reason: "unsupported_mime", mimeType };
    }
    const bytes = base64ByteLength(data);
    if (bytes > MCP_APPS_IMAGE_MAX_BYTES)
      return { ok: false, reason: "too_large", mimeType, bytes };
    images.push({ mimeType, dataBase64: data, bytes });
  }
  return { ok: true, images };
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** 附件文件名：`plugin-<pluginId 安全段>-<序号>.<ext>`，模型与用户都能看出来源。 */
export function buildPluginUiImageFileName(
  pluginId: string,
  index: number,
  mimeType: string,
): string {
  const safe = pluginId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
  return `plugin-${safe}-${index + 1}.${EXTENSION_BY_MIME[mimeType] ?? "bin"}`;
}
