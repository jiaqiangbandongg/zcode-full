import { z } from "zod";
import { MCP_APPS_IMAGE_MAX_BYTES, MCP_APPS_IMAGE_MIME_TYPES } from "./contract.js";

export const MCP_APPS_SAMPLING_TIMEOUT_MS = 60_000;
export const MCP_APPS_SAMPLING_TRANSPORT_TIMEOUT_MS = 65_000;
export const MCP_APPS_SAMPLING_MAX_BYTES = 8 * 1024 * 1024;
export const MCP_APPS_SAMPLING_MAX_BLOCKS = 64;
export const MCP_APPS_SAMPLING_MAX_PER_SESSION = 4;
export const MCP_APPS_SAMPLING_MAX_PER_AGENT = 8;
export const MCP_APPS_SAMPLING_MAX_OPERATIONS = 4096;
const utf8Bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const annotations = z
  .object({
    audience: z.array(z.enum(["user", "assistant"])).optional(),
    priority: z.number().min(0).max(1).optional(),
    lastModified: z.string().optional(),
  })
  .strict()
  .optional();
const samplingBlockSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: z.string().max(MCP_APPS_SAMPLING_MAX_BYTES),
      annotations,
      _meta: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      mimeType: z.enum(MCP_APPS_IMAGE_MIME_TYPES),
      data: z
        .string()
        .min(1)
        .max(Math.ceil(MCP_APPS_IMAGE_MAX_BYTES / 3) * 4)
        // 重复四字符分组会在 MiB 级图片上耗尽 V8 正则栈；平坦字符检查保持线性。
        .refine((data) => data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(data))
        .refine((data) => decodedBytes(data) <= MCP_APPS_IMAGE_MAX_BYTES),
      annotations,
      _meta: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
]);
const priority = z.number().min(0).max(1).optional();
/** 只开放宿主确实实现的官方子集；不静默剥除 tools/audio/模型配置等字段。 */
export const mcpAppsSamplingParamsSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.union([
              samplingBlockSchema,
              z.array(samplingBlockSchema).min(1).max(MCP_APPS_SAMPLING_MAX_BLOCKS),
            ]),
          })
          .strict(),
      )
      .min(1)
      .max(MCP_APPS_SAMPLING_MAX_BLOCKS),
    systemPrompt: z.string().max(MCP_APPS_SAMPLING_MAX_BYTES).optional(),
    maxTokens: z.number().int().positive().safe(),
    includeContext: z.literal("none").optional(),
    modelPreferences: z
      .object({
        hints: z
          .array(z.object({ name: z.string().max(256).optional() }).strict())
          .max(16)
          .optional(),
        costPriority: priority,
        speedPriority: priority,
        intelligencePriority: priority,
      })
      .strict()
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((params, ctx) => {
    const blocks = params.messages.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [message.content],
    );
    let bytes = utf8Bytes(params.systemPrompt ?? "");
    for (const block of blocks)
      bytes += block.type === "image" ? decodedBytes(block.data) : utf8Bytes(block.text);
    // metadata 不转发给 provider，但仍计入边界预算，避免任意扩展字段绕过载荷限制。
    const metadataBytes = utf8Bytes(
      JSON.stringify({
        metadata: params.metadata,
        _meta: params._meta,
        blockMetadata: blocks.map((b) => ({ _meta: b._meta, annotations: b.annotations })),
      }),
    );
    if (
      blocks.length > MCP_APPS_SAMPLING_MAX_BLOCKS ||
      bytes + metadataBytes > MCP_APPS_SAMPLING_MAX_BYTES
    )
      ctx.addIssue({ code: "custom", message: "Sampling content exceeds host limits" });
  });
function decodedBytes(data: string): number {
  return (data.length * 3) / 4 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
}
export const mcpAppsSamplingResultSchema = z
  .object({
    role: z.literal("assistant"),
    model: z.string().min(1),
    content: z
      .object({ type: z.literal("text"), text: z.string().max(MCP_APPS_SAMPLING_MAX_BYTES) })
      .strict(),
    stopReason: z.string().min(1),
  })
  .strict();
export type McpAppsSamplingParams = z.infer<typeof mcpAppsSamplingParamsSchema>;
export type McpAppsSamplingResult = z.infer<typeof mcpAppsSamplingResultSchema>;
