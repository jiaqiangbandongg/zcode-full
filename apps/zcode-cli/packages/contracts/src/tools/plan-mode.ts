// ============================================================
// Plan Mode Tools - plan approval flow
// ============================================================

import { z } from "zod";
import type { CollaborationMode } from "../interfaces/session.port.js";
import type { TraceContext } from "../tracing/tracer.js";
import { toToolJsonSchema } from "./json-schema.js";

export const ENTER_PLAN_MODE_TOOL_NAME = "EnterPlanMode";
export const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";

export const PLAN_MODE_MAX_PLAN_CHARS = 20_000;

export const EnterPlanModeInputSchema = z.object({}).strict();
export type EnterPlanModeInput = z.infer<typeof EnterPlanModeInputSchema>;
export const EnterPlanModeInputJsonSchema = toToolJsonSchema(EnterPlanModeInputSchema);

export const EnterPlanModeOutputSchema = z
  .object({
    message: z.string().min(1).describe("Confirmation that plan mode was entered."),
    previousMode: z
      .enum(["plan", "build", "edit", "yolo", "guarded", "auto"])
      .describe("Session mode before EnterPlanMode ran."),
    mode: z
      .enum(["plan", "build", "edit", "yolo", "guarded", "auto"])
      .describe("Current permission mode."),
    planEnabled: z.boolean().optional(),
    previousPlanEnabled: z.boolean().optional(),
  })
  .strict();
export type EnterPlanModeOutput = z.infer<typeof EnterPlanModeOutputSchema>;
export const EnterPlanModeOutputJsonSchema = toToolJsonSchema(EnterPlanModeOutputSchema);

export const ExitPlanModeAllowedPromptSchema = z
  .object({
    tool: z.enum(["Bash"]).describe("The tool this prompt applies to"),
    prompt: z
      .string()
      .describe('Semantic description of the action, e.g. "run tests", "install dependencies"'),
  })
  .strict();
export type ExitPlanModeAllowedPrompt = z.infer<typeof ExitPlanModeAllowedPromptSchema>;

// plan file 需要保存最终批准的原始字符串；空白校验只看 trim 后内容，不在 schema transform 阶段改写 plan。
const ExitPlanModePlanSchema = z
  .string()
  .min(1)
  .max(PLAN_MODE_MAX_PLAN_CHARS)
  .refine((value) => value.trim().length > 0, {
    message: "String must contain at least 1 character(s)",
  })
  .describe("The implementation plan to present to the user for approval.");

export const ExitPlanModeInputSchema = z
  .object({
    plan: ExitPlanModePlanSchema,
    allowedPrompts: z
      .array(ExitPlanModeAllowedPromptSchema)
      .optional()
      .describe(
        "Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.",
      ),
  })
  .catchall(z.unknown());
export type ExitPlanModeInput = z.infer<typeof ExitPlanModeInputSchema>;
export const ExitPlanModeInputJsonSchema = toToolJsonSchema(ExitPlanModeInputSchema);

export const ExitPlanModeOutputSchema = z
  .object({
    plan: z.string().nullable().describe("The plan that was approved by the user."),
    approved: z.literal(true).describe("True when the user approved exiting plan mode."),
    previousMode: z
      .enum(["plan", "build", "edit", "yolo", "guarded", "auto"])
      .describe("Previous permission mode."),
    planEnabled: z.boolean().optional(),
    previousPlanEnabled: z.boolean().optional(),
    mode: z
      .enum(["build", "edit", "yolo", "guarded", "auto"])
      .describe("Current session mode after exiting plan mode."),
    allowedPrompts: z.array(ExitPlanModeAllowedPromptSchema).optional(),
  })
  .strict();
export type ExitPlanModeOutput = z.infer<typeof ExitPlanModeOutputSchema>;
export const ExitPlanModeOutputJsonSchema = toToolJsonSchema(ExitPlanModeOutputSchema);

export interface SessionModeTransitionInput {
  toolCallId?: string;
  traceContext?: TraceContext;
}

export interface EnterPlanModeTransitionResult {
  mode: CollaborationMode;
  previousMode: CollaborationMode;
  planEnabled?: boolean;
  previousPlanEnabled?: boolean;
}

export interface ExitPlanModeTransitionResult {
  mode: Exclude<CollaborationMode, "plan">;
  previousMode: CollaborationMode;
  planEnabled?: boolean;
  previousPlanEnabled?: boolean;
}

export interface SessionModePort {
  supportsPermissionFullAccess?(): boolean;
  isPlanEnabled?(): boolean;
  getMode(): CollaborationMode;
  getPrePlanMode(): Exclude<CollaborationMode, "plan"> | undefined;
  enterPlanMode(input?: SessionModeTransitionInput): Promise<EnterPlanModeTransitionResult>;
  exitPlanMode(input?: SessionModeTransitionInput): Promise<ExitPlanModeTransitionResult>;
}
