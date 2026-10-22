import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { JsonSchema } from "../model/index.js";

export const DEFERRED_TOOL_CALL_NAME = "DeferredToolCall";
export const DeferredToolCallInputSchema = z
  .object({
    name: z.string().min(1),
    input: z.record(z.unknown()),
  })
  .strict();
export const DeferredToolCallInputJsonSchema = zodToJsonSchema(
  DeferredToolCallInputSchema,
) as JsonSchema;

// 原始目标名称与参数由调用本身保存；仅记录还原模型协议所需的包装标记。
export const ModelCallWrapperSchema = z.literal(DEFERRED_TOOL_CALL_NAME);
export type ModelCallWrapper = z.infer<typeof ModelCallWrapperSchema>;
