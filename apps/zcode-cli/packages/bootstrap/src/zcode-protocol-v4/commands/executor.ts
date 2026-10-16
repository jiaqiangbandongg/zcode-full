// v4 命令原生执行器。
//
// 逐命令原生化的推进方式：handlers/ 注册表列出已原生的命令；binder 只在 supports
// 命中时走本执行器，未命中回落旧桥（binder 侧回落，随每条命令原生化逐条消失）。
// 完成定义：原生 handler + L2 闭环 + L3 e2e，且写路径不经旧协议代码。
import type { CommandEnvelope, CommandResult } from "@zcode/shared/zcode-protocol-v4";
import { NATIVE_HANDLERS } from "./handlers/index.js";
import type { V4CommandCoreHost } from "./types.js";

const SELECTION_SIDE_CHAT_RESTRICTED_COMMANDS = new Set<CommandEnvelope["type"]>([
  "sendGoalCommand",
  "pauseGoal",
  "resumeGoal",
  "editUserQuery",
  "retryTurn",
  "forkAssistant",
  "discardSharedContext",
]);

export class V4SelectionSideChatRestrictedCommandError extends Error {
  readonly reasonCode = "guard.selectionSideChatRestrictedCommand";

  constructor(command: CommandEnvelope["type"]) {
    super(`selection_side_chat 不允许执行 ${command}`);
    this.name = "V4SelectionSideChatRestrictedCommandError";
  }
}

export { V4SessionNotFoundError } from "./record-access.js";

export class V4CommandExecutor {
  constructor(private readonly host: V4CommandCoreHost) {}

  /** 已原生化的命令集（binder 据此分流；全部命中后旧桥整体删除）。 */
  supports(type: CommandEnvelope["type"]): boolean {
    return type in NATIVE_HANDLERS;
  }

  async execute(
    envelope: CommandEnvelope,
    admission?: V4CommandAdmission,
    executionContext?: V4CommandExecutionContext,
  ): Promise<CommandResult | undefined> {
    if (
      envelope.sessionId &&
      SELECTION_SIDE_CHAT_RESTRICTED_COMMANDS.has(envelope.type) &&
      this.host.getRecord(envelope.sessionId)?.taskType === "selection_side_chat"
    ) {
      throw new V4SelectionSideChatRestrictedCommandError(envelope.type);
    }
    const handler = NATIVE_HANDLERS[envelope.type as keyof typeof NATIVE_HANDLERS];
    if (!handler) {
      throw new Error(`v4 native executor does not support: ${envelope.type}`);
    }
    return handler(this.host, {
      ...envelope,
      ...(admission ? { __v4Admission: admission } : {}),
      ...(executionContext ? { __v4ExecutionContext: executionContext } : {}),
    });
  }
}

export interface V4CommandAdmission {
  admissionSeq: number;
  admittedAt: number;
  queueItemId: string;
}

export interface V4CommandExecutionContext {
  /** 内部 auto-drain 必须在 reserve 前由 handler 原子校验 Core idle。 */
  autoDrainPromotion?: true;
}

export type V4AdmittedCommandEnvelope = CommandEnvelope & {
  __v4Admission?: V4CommandAdmission;
  __v4ExecutionContext?: V4CommandExecutionContext;
};

export function commandAdmissionOf(envelope: CommandEnvelope): V4CommandAdmission {
  return (
    (envelope as V4AdmittedCommandEnvelope).__v4Admission ?? {
      admissionSeq: 0,
      admittedAt: Date.now(),
      queueItemId: `queue_${envelope.commandId}`,
    }
  );
}

export function commandExecutionContextOf(
  envelope: CommandEnvelope,
): V4CommandExecutionContext | undefined {
  return (envelope as V4AdmittedCommandEnvelope).__v4ExecutionContext;
}
