// 动态工作流命令的拒绝词表与 fault 前缀：从 command.ts 拆出（该文件在 max-lines 上限），
// 由 command.ts 再导出，既有导入路径不变。
import { z } from "zod";

// startSavedWorkflow 拒绝词表（docs/dynamic-workflow/launch.md「On the agent」）：
// bootstrap handler 铸造 fault code，ui launcher 反查 i18n 文案，两侧共享此枚举避免漂移。
// invalid_name / not_found：解析阶段；invalid_args：实参校验；compile_failed：analyzeScript 诊断；
// session_busy：会话有活动 turn；start_failed：port.submit 之前的其它启动失败。
export const savedWorkflowStartRejectionReasonSchema = z.enum([
  "invalid_name",
  "not_found",
  "invalid_args",
  "compile_failed",
  "session_busy",
  "start_failed",
]);
export type SavedWorkflowStartRejectionReason = z.infer<
  typeof savedWorkflowStartRejectionReasonSchema
>;

// 完整 fault code = 前缀 + reason（如 fault.command.savedWorkflowStartRejected.not_found）。
// 与 workflowRunResumeRejected 命名空间同族；导出常量供 bootstrap 拼接、ui 前缀匹配。
export const SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX =
  "fault.command.savedWorkflowStartRejected." as const;

// resumeWorkflowRun 的拒绝：前缀 + 端口 reason（not_found / not_resumable / superseded /
// already_running / script_missing / script_mismatch / compile_failed）；`ack.message` 携带
// compile_failed 的有界诊断（docs/dynamic-workflow/presentation.md「The run pane」）。
export const WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX =
  "fault.command.workflowRunResumeRejected." as const;
