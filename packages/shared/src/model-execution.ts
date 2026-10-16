import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";

/**
 * 执行 Selection 退回 Session Selection 的原因。由发起方在 selectionFallback 规则里声明，
 * CLI 只透传命中规则的原因，不自行解释 provider 错误码。
 */
export const modelExecutionSelectionFallbackReasonSchema = z.enum([
  "highspeed_card_expired",
  "highspeed_request_failed",
]);

/** 文本与附件发送共用执行约束，凭据只属于单次执行，不进入 Session 配置。 */
export const modelExecutionSchema = z
  .object({
    memoryExtraction: z.literal("skip").optional(),
    selectionScope: z.literal("execution"),
    requestAuth: z
      .object({
        apiKey: z.string().min(1).optional(),
        apiKeyId: z.string().trim().min(1).optional(),
        accountScope: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        headers: z.record(z.string().min(1), z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    subagents: z
      .object({
        foregroundModel: z.literal("submission"),
        background: z.literal("deny"),
      })
      .strict()
      .optional(),
    /**
     * 本次执行的 Selection 失败时，同一 Turn 内退回原模型继续跑完，而不是让整轮失败。
     * 触发条件由发起方声明：`providerId` 限定只匹配本轮 execution Selection 指向的 provider；
     * `rules` 按声明顺序匹配，首个命中的规则决定退回原因，`providerErrorCode` 缺省表示该 provider
     * 的任何失败（用户取消与上下文超窗除外）。CLI 不按 provider id 前缀、模型名或错误文案硬编码。
     * 退回目标先取 `target`（发起方抽卡时的提交选择，即会话原模型），再取 runtime 会话常驻 Selection：
     * execution 作用域从不改写会话选择，但常驻选择只在 runtime 内存里，冷恢复竞态下可能未绑定，
     * 所以发起方必须声明 `target`（docs/highspeed/highspeed-card-spec.md §2.2）。
     */
    selectionFallback: z
      .object({
        providerId: z.string().min(1),
        rules: z
          .array(
            z
              .object({
                reason: modelExecutionSelectionFallbackReasonSchema,
                providerErrorCode: z.string().min(1).optional(),
              })
              .strict(),
          )
          .min(1),
        target: modelSelectionSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ModelExecution = z.infer<typeof modelExecutionSchema>;
export type ModelExecutionSelectionFallback = NonNullable<ModelExecution["selectionFallback"]>;
export type ModelExecutionSelectionFallbackRule = ModelExecutionSelectionFallback["rules"][number];
export type ModelExecutionSelectionFallbackReason = z.infer<
  typeof modelExecutionSelectionFallbackReasonSchema
>;
