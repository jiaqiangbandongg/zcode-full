import { zcodeProtocolTraceSchema } from "./zcode-protocol/trace.js";
import { z } from "zod";

export const channelMentionSchema = z
  .object({
    type: z.literal("channelMention"),
    refId: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    channel: z.enum(["feishu", "lark"]),
    targetId: z
      .string()
      .max(128)
      .regex(/^ou_[a-zA-Z0-9_-]+$/u),
    idType: z.literal("open_id"),
    entityType: z.enum(["user", "bot", "unknown"]),
  })
  .strict();
export const channelContentPartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string().max(100_000) }).strict(),
  channelMentionSchema,
]);
export const channelContentPartsSchema = z.array(channelContentPartSchema).max(200);
export type ChannelContentPart = z.infer<typeof channelContentPartSchema>;
export const channelReplyPartsSchema = z
  .array(
    z.union([
      z.object({ type: z.literal("text"), text: z.string().max(2000) }).strict(),
      z.object({ type: z.literal("mention"), refId: z.string().min(1).max(200) }).strict(),
      z
        .object({
          type: z.literal("mentionName"),
          name: z.string().trim().min(1).max(200),
          candidateRef: z.string().min(1).max(200).optional(),
        })
        .strict(),
    ]),
  )
  .min(1)
  .max(50);
export const channelReplyRequestSchema = z
  .object({
    taskId: z.string().min(1),
    inputId: z.string().min(1),
    authorizationId: z.string().min(1).optional(),
    toolCallId: z.string().min(1),
    parts: channelReplyPartsSchema,
  })
  .strict();
const channelDeliveryResultSchema = z
  .object({
    status: z.enum(["sent", "failed", "unknown", "invalidated"]),
    deliveryId: z.string(),
    providerMessageId: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
export const channelMentionClarificationSchema = z
  .object({
    status: z.literal("needs_clarification"),
    unresolved: z
      .array(
        z
          .object({
            name: z.string().max(200),
            reason: z.enum(["ambiguous", "not_found", "unavailable", "selection_expired"]),
            candidates: z
              .array(
                z
                  .object({
                    ref: z.string().max(200),
                    name: z.string().max(200),
                    label: z.string().max(250),
                    kind: z.enum(["user", "bot", "unknown"]),
                  })
                  .strict(),
              )
              .max(10),
            truncated: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export const channelReplyResultSchema = z.union([
  channelDeliveryResultSchema,
  channelMentionClarificationSchema,
]);
export type ChannelReplyRequest = z.infer<typeof channelReplyRequestSchema>;
export type ChannelReplyResult = z.infer<typeof channelReplyResultSchema>;
export function channelContentText(parts: readonly ChannelContentPart[]): string {
  return parts.map((part) => (part.type === "text" ? part.text : `@${part.name}`)).join("");
}
/** 只从 Host 已验证的会话输入解析 ref；模型不得直接提供平台 ID。 */
export function resolveChannelReplyParts(
  parts: z.infer<typeof channelReplyPartsSchema>,
  source: readonly ChannelContentPart[],
): ChannelContentPart[] {
  const targets = new Map<string, z.infer<typeof channelMentionSchema>>();
  for (const part of source) {
    if (part.type !== "channelMention") continue;
    const target = channelMentionSchema.parse(part);
    const previous = targets.get(target.refId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(target))
      throw new Error("Conflicting channel mention reference");
    targets.set(target.refId, target);
  }
  channelReplyPartsSchema.parse(parts);
  const resolved = parts.map((part) => {
    if (part.type === "text") return part;
    if (part.type === "mentionName")
      throw new Error("Channel mention name must be resolved by Host");
    const target = targets.get(part.refId);
    if (!target) throw new Error("Unknown channel mention reference");
    return target;
  });
  if (!channelContentText(resolved).trim() || channelContentText(resolved).length > 2000)
    throw new Error("Channel reply must contain 1–2000 characters");
  return resolved;
}

export const channelReplyHostRequestSchema = channelReplyRequestSchema
  .extend({
    trace: zcodeProtocolTraceSchema.optional(),
    workspacePath: z.string().min(1),
    workspaceIdentity: z.string().optional(),
    remoteSessionId: z.string().optional(),
  })
  .strict();
export type ChannelReplyHostRequest = z.infer<typeof channelReplyHostRequestSchema>;
