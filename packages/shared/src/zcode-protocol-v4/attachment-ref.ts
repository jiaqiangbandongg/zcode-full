import { z } from "zod";
import { attachmentSourceKindSchema } from "../attachment-source.js";

/** 仅承载已提交内容引用与展示元信息；内容本体不进入 command/topic frame。 */
export const attachmentRefSchema = z
  .object({
    ref: z.string(),
    fileName: z.string(),
    mime: z.string(),
    bytes: z.number(),
    sourceKind: attachmentSourceKindSchema.optional(),
    messageCount: z.number().int().nonnegative().optional(),
    previewRef: z.string().optional(),
  })
  .strict();

export type AttachmentRef = z.infer<typeof attachmentRefSchema>;
