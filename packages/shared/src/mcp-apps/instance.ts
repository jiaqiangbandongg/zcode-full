import { z } from "zod";

/** Agent 签发的内存凭证；Main 的 initId 只用于端口握手。 */
export const mcpAppInstanceSchema = z
  .object({
    runtimeId: z.string().min(1),
    generation: z.number().int().positive(),
    appIdentity: z.string().regex(/^[a-f0-9]{64}$/),
    token: z.string().min(1),
  })
  .strict();
export type McpAppInstance = z.infer<typeof mcpAppInstanceSchema>;
