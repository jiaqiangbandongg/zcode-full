import { z } from "zod";
import { toolResultDisplaySchema } from "./zcode-protocol-v4/toolDisplay.js";

// 从正式 display 的严格成员派生公开白名单，不另造工具结果协议。
const OMIT = new Set(["outputPath", "input", "targetApp", "media", "ui", "permissionStatus"]);
// 工作流专用成员沿用既有公开 workflow 块；这里承载其余终态 display。
const PUBLIC_KINDS = new Set([
  "bash_output",
  "file_diff",
  "local_agent_message",
  "task_stop",
  "task_output",
  "respond_to_coordinator",
  "mcp_tool",
  "cua",
]);
export const shareToolDisplaySchema = z.union(
  toolResultDisplaySchema.options
    .filter((schema) => PUBLIC_KINDS.has(schema.shape.kind.value))
    .map((schema) =>
      z
        .object(Object.fromEntries(Object.entries(schema.shape).filter(([key]) => !OMIT.has(key))))
        .strict(),
    ) as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]],
);
export const shareToolPresentationPayloadSchema = z
  .object({
    display: shareToolDisplaySchema.optional(),
    agent_type: z.string().trim().min(1).max(256).optional(),
    app_name: z.string().trim().min(1).max(512).optional(),
    images: z
      .array(
        z
          .object({
            resource_id: z.string().regex(/^share-artifact-[1-9]\d*$/u),
            mime_type: z.string().regex(/^image\/[a-z0-9.+-]+$/iu),
          })
          .strict(),
      )
      .max(32)
      .optional(),
  })
  .strict();
export type ShareToolPresentationPayload = z.infer<typeof shareToolPresentationPayloadSchema>;

/** 来源可能含旧协议字段；只复制正式 schema 的公开键，图片由 artifact 通道承载。 */
export function projectShareToolDisplay(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const schema = toolResultDisplaySchema.options.find(
    (option) => option.shape.kind.value === record.kind,
  );
  if (!schema || !PUBLIC_KINDS.has(String(record.kind))) return undefined;
  const publicFields = Object.fromEntries(
    Object.keys(schema.shape)
      .filter((key) => !OMIT.has(key) && record[key] !== undefined)
      .map((key) => [key, record[key]]),
  );
  const parsed = shareToolDisplaySchema.safeParse(publicFields);
  return parsed.success ? parsed.data : undefined;
}
