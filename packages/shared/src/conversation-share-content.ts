import { z } from "zod";
import { shareToolPresentationPayloadSchema } from "./conversation-share-tool-presentation.js";
import { toolCallCreateWorkflowDisplaySchema } from "./zcode-protocol-v4/create-workflow-display.js";
import {
  workflowRunActorSchema,
  workflowRunNodeSchema,
  workflowRunSchema,
} from "./zcode-protocol-v4/workflow-runs.js";

export const CONVERSATION_SHARE_CONTENT_VERSIONS = { workflow: 2, "tool-presentation": 1 } as const;
export const SHARE_CONTENT_LIMITS = {
  blocks: 200,
  artifacts: 32,
  items: 256,
  jsonDepth: 16,
  jsonBytes: 32768,
} as const;
const text = z.string().min(1).max(512);
const count = z.number().int().nonnegative();
const field = z.object({ field: text, label: text.optional(), unit: text.optional() }).strict();
const options = { title: text.optional(), description: text.optional() };
export const shareArtifactSpecSchemas = {
  board: z
    .object({
      ...options,
      key: text,
      status: text,
      columns: z.array(text).min(1).max(64),
      cardTitle: text.optional(),
      detail: z.array(field).max(64).optional(),
    })
    .strict(),
  table: z
    .object({ ...options, columns: z.array(field).min(1).max(64), key: text.optional() })
    .strict(),
  metrics: z.object({ ...options, metrics: z.array(field).min(1).max(64) }).strict(),
  chart: z
    .object({
      ...options,
      type: z.enum(["line", "bar", "scatter"]).optional(),
      x: field,
      y: z.union([field, z.array(field).min(1).max(64)]),
      scale: z.enum(["linear", "log"]).optional(),
      baseline: field.optional(),
    })
    .strict(),
};

// report 的业务字段开放，但值只能是有界 JSON；不接受执行代码、原型键或内部 URI。
function safeJson(value: unknown, depth = 0): boolean {
  if (depth > SHARE_CONTENT_LIMITS.jsonDepth) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string")
    return value.length <= 32768 && !/^(?:file|data|javascript|zcode-artifact):/iu.test(value);
  if (Array.isArray(value))
    return value.length <= 1024 && value.every((entry) => safeJson(entry, depth + 1));
  if (value && typeof value === "object")
    return Object.entries(value).every(
      ([key, entry]) =>
        !["__proto__", "prototype", "constructor"].includes(key) &&
        key.length <= 512 &&
        safeJson(entry, depth + 1),
    );
  return false;
}
const jsonValue = z
  .unknown()
  .refine(
    (value) =>
      safeJson(value) &&
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= SHARE_CONTENT_LIMITS.jsonBytes,
    "Unsafe or oversized share JSON",
  );
const item = z
  .object({ sequence: count, siteId: z.string().min(1).max(64), ordinal: count, item: jsonValue })
  .strict();
const artifactFields = {
  id: z.string().min(1).max(128),
  title: text,
  version: z.number().int().positive().max(16),
  primary: z.literal(true).optional(),
  description: text.optional(),
  unavailable: z.enum(["source_unavailable", "unsupported", "limit_exceeded"]).optional(),
};
export const shareWorkflowArtifactSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...artifactFields,
      kind: z.literal("file"),
      resource_id: z.string().min(1).max(128).optional(),
      content_type: text.optional(),
      preview_text: z
        .string()
        .max(65536)
        .refine((text) => new TextEncoder().encode(text).byteLength <= 65536)
        .optional(),
      bytes: count.optional(),
    })
    .strict(),
  z
    .object({
      ...artifactFields,
      kind: z.literal("markdown"),
      resource_id: z.string().min(1).max(128).optional(),
      content_type: text.optional(),
      preview_text: z
        .string()
        .max(65536)
        .refine((text) => new TextEncoder().encode(text).byteLength <= 65536)
        .optional(),
      bytes: count.optional(),
    })
    .strict(),
  ...(["board", "table", "metrics", "chart"] as const).map((kind) =>
    z
      .object({
        ...artifactFields,
        kind: z.literal(kind),
        spec: shareArtifactSpecSchemas[kind].optional(),
        items: z.array(item).max(SHARE_CONTENT_LIMITS.items).optional(),
      })
      .strict(),
  ),
]);

// 复用执行态词汇与算法，但公开面仅允许绘图所需事实，不携带子会话/执行授权/原始工具输入。
export const shareWorkflowRunSchema = workflowRunSchema
  .pick({
    status: true,
    usage: true,
    phases: true,
    currentPhase: true,
    phaseNames: true,
    phaseAlongside: true,
    lastEventSequence: true,
    truncated: true,
  })
  .extend({
    actors: z.array(workflowRunActorSchema.omit({ sessionId: true }).strict()).max(256),
    nodes: z
      .array(
        workflowRunNodeSchema
          .pick({
            siteId: true,
            ordinal: true,
            kind: true,
            phase: true,
            outcome: true,
            cached: true,
            actorSiteId: true,
            actorOrdinal: true,
            phaseName: true,
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
export const shareWorkflowPayloadSchema = z
  .object({
    name: text,
    summary: z.string().max(2048).optional(),
    completion: z.boolean(),
    run: shareWorkflowRunSchema.optional(),
    graph: toolCallCreateWorkflowDisplaySchema.shape.causalityGraph,
    duration_ms: count.optional(),
    artifacts: z.array(shareWorkflowArtifactSchema).max(SHARE_CONTENT_LIMITS.artifacts),
    unavailable: z.enum(["source_unavailable", "unsupported", "limit_exceeded"]).optional(),
  })
  .strict();
const conversationShareContentBlockBaseSchema = z
  .object({
    id: z.string().regex(/^share-content-[1-9]\d*$/u),
    type: z.literal("workflow"),
    version: z.union([z.literal(1), z.literal(2)]),
    product_turn_id: z.string().regex(/^share-product-turn-[1-9]\d*$/u),
    fallback_row_id: z.number().int().positive(),
    captured_at: count,
    resource_ids: z.array(z.string().regex(/^share-artifact-[1-9]\d*$/u)).max(32),
    payload: shareWorkflowPayloadSchema,
  })
  .strict();
export const conversationShareWorkflowContentBlockSchema =
  conversationShareContentBlockBaseSchema.superRefine((block, context) => {
    if (
      block.version === 1 &&
      block.payload.artifacts.some(
        (artifact) => "preview_text" in artifact && artifact.preview_text !== undefined,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Text previews require workflow content version 2",
        path: ["payload", "artifacts"],
      });
    }
  });
export const conversationShareToolContentBlockSchema = conversationShareContentBlockBaseSchema
  .extend({
    type: z.literal("tool-presentation"),
    version: z.literal(1),
    payload: shareToolPresentationPayloadSchema,
  })
  .superRefine((block, context) => {
    const used = new Set(block.payload.images?.map((image) => image.resource_id) ?? []);
    if (
      used.size !== new Set(block.resource_ids).size ||
      block.resource_ids.length !== used.size ||
      block.resource_ids.some((id) => !used.has(id))
    )
      context.addIssue({
        code: "custom",
        message: "Tool media references must match resource_ids",
        path: ["resource_ids"],
      });
  });
export const conversationShareContentBlockSchema = z.union([
  conversationShareWorkflowContentBlockSchema,
  conversationShareToolContentBlockSchema,
]);
export type ConversationShareWorkflowContentBlock = z.infer<
  typeof conversationShareWorkflowContentBlockSchema
>;
export type ConversationShareContentBlock = z.infer<typeof conversationShareContentBlockSchema>;
export type ShareWorkflowPayload = z.infer<typeof shareWorkflowPayloadSchema>;
export type ShareWorkflowArtifact = z.infer<typeof shareWorkflowArtifactSchema>;

/** 稳定外壳先识别锚点；新类型或坏 payload 仍须保持正文与原位摘要的顺序。 */
export const conversationShareContentEnvelopeSchema = conversationShareContentBlockBaseSchema
  .extend({
    type: z.string().min(1).max(128),
    version: z.number().int().positive(),
    payload: z.unknown(),
  })
  .strip();

/** 读端独立解码：认不出的块不认领 fallback Row，原位文字仍然保留。 */
export function decodeConversationShareContentBlocks(
  blocks: readonly unknown[] | undefined,
): ConversationShareContentBlock[] {
  return (blocks ?? []).flatMap((block) => {
    const parsed = conversationShareContentBlockSchema.safeParse(block);
    return parsed.success ? [parsed.data] : [];
  });
}
export function supportsConversationShareContent(
  capabilities: { content_block_versions?: Record<string, number> },
  type: string = "workflow",
  version = 1,
): boolean {
  return (capabilities.content_block_versions?.[type] ?? 0) >= version;
}
