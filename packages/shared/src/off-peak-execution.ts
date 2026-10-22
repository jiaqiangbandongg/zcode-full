import { z } from "zod";
import { modelExecutionSchema } from "./model-execution.js";

const identity = { executionId: z.string().min(1), offPeakTaskId: z.string().min(1) };
export const offPeakLifecycleStateSchema = z.enum([
  "running_idle",
  "waiting_background",
  "waiting_ticket",
  "running_user",
  "completed",
  "cancelled",
]);
export const offPeakOutcomeSchema = z.enum(["succeeded", "failed", "stopped"]);
export const offPeakLifecycleEventSchema = z.discriminatedUnion("type", [
  z
    .object({ ...identity, type: z.literal("state_changed"), state: offPeakLifecycleStateSchema })
    .strict(),
  z.object({ ...identity, type: z.literal("user_takeover") }).strict(),
  z
    .object({
      ...identity,
      type: z.literal("ticket_needed"),
      renewalId: z.number().int().positive(),
      expiredTicketId: z.string().min(1),
    })
    .strict(),
  z
    .object({ ...identity, type: z.literal("ticket_released"), ticketId: z.string().min(1) })
    .strict(),
  z.object({ ...identity, type: z.literal("completed"), outcome: offPeakOutcomeSchema }).strict(),
]);
const notificationOptions = offPeakLifecycleEventSchema.options.map((schema) =>
  schema.extend({ sessionId: z.string().min(1) }),
);
export const offPeakLifecycleNotificationSchema = z.discriminatedUnion("type", [
  notificationOptions[0]!,
  ...notificationOptions.slice(1),
]);
export const offPeakControlParamsSchema = z.discriminatedUnion("action", [
  z
    .object({
      sessionId: z.string().min(1),
      executionId: z.string().min(1),
      action: z.literal("replace_ticket"),
      renewalId: z.number().int().positive(),
      ticketId: z.string().min(1),
      requestAuth: modelExecutionSchema.shape.requestAuth.unwrap(),
    })
    .strict(),
  z
    .object({
      sessionId: z.string().min(1),
      executionId: z.string().min(1),
      action: z.literal("cancel"),
    })
    .strict(),
]);
export const offPeakControlResultSchema = z.object({ accepted: z.boolean() }).strict();
export type OffPeakLifecycleEvent = z.infer<typeof offPeakLifecycleEventSchema>;
export type OffPeakLifecycleNotification = z.infer<typeof offPeakLifecycleNotificationSchema>;
export type OffPeakLifecycleState = z.infer<typeof offPeakLifecycleStateSchema>;
export type OffPeakOutcome = z.infer<typeof offPeakOutcomeSchema>;
export type OffPeakControlParams = z.infer<typeof offPeakControlParamsSchema>;
export type OffPeakControlResult = z.infer<typeof offPeakControlResultSchema>;
/** 闲时允许 Agent/Bash/SendMessage；工作流运行器和递归派发尚不归本票据管理。 */
export const OFF_PEAK_EXECUTION_TOOL_DENYLIST = [
  "OffPeakCreate",
  "Workflow",
  "CreateWorkflow",
  "AmendWorkflow",
  "ResumeWorkflowRun",
  "EvalWorkflowSnippet",
] as const;
