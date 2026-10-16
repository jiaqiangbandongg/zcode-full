import type { OffPeakPort, OffPeakTaskSummary } from "@zcode/contracts";
import {
  zcodeOffPeakCreateResultSchema,
  zcodeOffPeakListResultSchema,
  zcodeProtocolMethods,
  type ZCodeOffPeakTaskProtocolSnapshot,
} from "@zcode/shared";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";

export const OFF_PEAK_CREATE_FROM_OFF_PEAK_RUN_ERROR =
  "Cannot create an idle-time task while running an idle-time task.";
export const OFF_PEAK_CREATE_IN_BOUND_SESSION_ERROR =
  "This session already has a pending idle-time task. Wait for it to finish (or cancel it in Automations) before creating another one here.";
export const OFF_PEAK_CREATE_BOUND_SESSION_CHECK_ERROR =
  "Cannot verify whether this session already has a pending idle-time task; try again later.";

const OFF_PEAK_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * Off-Peak 协议端口。与 automation-port 的取舍：
 * - 只防「闲时轮递归创建」（activeOffPeakTaskId）；不查 activeAutomationId——cron 自动轮
 *   放行 OffPeakCreate（定时派生闲时任务）。
 * - 会话内创建绑定当前会话（对齐 CronCreate targetTaskId），派发时 resume 本会话执行。
 *   绑定守卫只拒「本会话已有未终态闲时任务」（两个无人值守 prompt 抢同一会话）；任务终结后可再建，
 *   与 cron 的一会话一任务永久拒绝不同。判定复用 offPeak/list 最小快照（含 sessionId/status），
 *   查询失败 fail-closed。放大防护的权威仍是服务端取号额度（POST /ticket 3103）。
 * - 不注入 runtimeModel/mode/thoughtLevel：缺省在 host 端解析
 *   （yolo / allowed_models 末位 / 最高推理档），会话运行态与闲时白名单无关。
 * - 不冻结会话标题：绑定的是用户的工作会话，标题不该被任务改写。
 */
export function createProtocolOffPeakPort(
  context: ZCodeProtocolAgentServerContext,
  resolveOwnSession?: () => ZCodeProtocolSessionRecord | undefined,
): OffPeakPort {
  return {
    async create(input, createContext) {
      const activeSession =
        resolveOwnSession?.() ??
        (createContext?.sessionId ? context.sessions.get(createContext.sessionId) : undefined);
      if (activeSession?.activeOffPeakTaskId?.trim()) {
        // 本 turn 已由闲时任务派发；闲时轮内再创建闲时任务 = 递归自我派生，直接拒绝。
        // 该判断是 turn denylist 与 handler offPeakTurn 之外的第三层纵深。
        throw new Error(OFF_PEAK_CREATE_FROM_OFF_PEAK_RUN_ERROR);
      }
      const boundSessionId = createContext?.sessionId ?? activeSession?.app.sessionId;
      if (boundSessionId) {
        let bound: boolean;
        try {
          const listed = await context.requestClient(
            zcodeProtocolMethods.offPeakList,
            {},
            zcodeOffPeakListResultSchema,
          );
          bound = listed.tasks.some(
            (task) => task.sessionId === boundSessionId && !OFF_PEAK_TERMINAL_STATUSES.has(task.status),
          );
        } catch (error) {
          context.logger?.warn("Failed to check bound idle-time tasks before OffPeakCreate", {
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "offpeak.create.bound_session_check.failed",
            sessionId: boundSessionId,
          });
          // 未知不能等同于未绑定：host/数据库短暂故障不得重新开放「同会话双任务」。
          throw new Error(OFF_PEAK_CREATE_BOUND_SESSION_CHECK_ERROR);
        }
        if (bound) throw new Error(OFF_PEAK_CREATE_IN_BOUND_SESSION_ERROR);
      }
      const result = await context.requestClient(
        zcodeProtocolMethods.offPeakCreate,
        {
          title: input.title,
          prompt: input.prompt,
          ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.thoughtLevel ? { thoughtLevel: input.thoughtLevel } : {}),
          // 绑定当前会话；workspace 仍由 host 端从当前 session 注入（对称 automation/create）。
          ...(boundSessionId ? { boundSessionId } : {}),
        },
        zcodeOffPeakCreateResultSchema,
      );
      if (!result.ok) {
        // 失败分类原样透传给 handler 翻译，禁止在端口层降级为 message 字符串。
        return {
          ok: false,
          failureStage: result.failureStage,
          errorCategory: result.errorCategory,
          errorCode: result.errorCode,
        };
      }
      return { ok: true, task: toOffPeakTaskSummary(result.task) };
    },
    async list() {
      const result = await context.requestClient(
        zcodeProtocolMethods.offPeakList,
        {},
        zcodeOffPeakListResultSchema,
      );
      return result.tasks.map(toOffPeakTaskSummary);
    },
  };
}

function toOffPeakTaskSummary(input: ZCodeOffPeakTaskProtocolSnapshot): OffPeakTaskSummary {
  return {
    offPeakTaskId: input.offPeakTaskId,
    title: input.title,
    status: input.status,
    queuePosition: input.queuePosition,
    sessionId: input.sessionId,
    createdAt: input.createdAt,
  };
}
