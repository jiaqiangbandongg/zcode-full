import { CREATE_WORKFLOW_TOOL_NAME, type TraceContext } from "@zcode/contracts";
import type { ExecutableToolCall } from "../../tool/types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { activateDynamicWorkflowTools } from "./dynamic-workflow-activation.js";

/**
 * 把一个**恢复的** dwf run 重新纳入后台追踪。
 *
 * submit 路径的追踪由 tool executor 在 CreateWorkflow 返回 backgrounded 时自动完成；resume
 * 是一条 v4 命令，没有在飞的工具调用，四件事因此无人做：runtime-task registry 登记（**会话
 * 回收护栏**——漏了它跑着 run 的会话被当空闲回收、完成通知无处投递）、BackgroundTaskStarted
 * （backgroundWorks 面板 + cancellable 标志）、轮询/终态 waiter、结算通知。本方法合成一个
 * 工具描述子走 executor 的同一条 trackBackgroundTask，四件事一次换回。
 *
 * 描述子字段的取舍：
 *   - `id` 用**原始 toolCallId**（dwf_run.tool_call_id 落库还原）——它是工具卡 → 详情页的
 *     关联键与 registry 的 parentToolCallId；老 run 缺席时合成一个 resume 前缀 id（可观测，
 *     不冒充任何真实工具行）。
 *   - `name` 恒为 CreateWorkflow：per-tool 生命周期分派（快照/等待/取消/通知格式）全按它查表。
 *   - `input.name` 喂展示名兜底链（workflowTaskSubject）——resume 命令可携带，缺席时
 *     tracker 兜底到 taskId，UI 侧按 fallbackName 处理（与 submit 路径同语义）。
 *
 * turnId 刻意缺席：resume 由 UI 命令发起，不属于任何模型回合（与 run 进度事件的
 * rootTraceContext 论证同源，见 dynamic-workflow-run-progress.ts）。
 */
export async function trackResumedDynamicWorkflowRun(
  this: AgentRuntimeInternal,
  input: { runId: string; toolCallId?: string; name?: string; traceContext?: TraceContext },
): Promise<void> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  const toolCall: ExecutableToolCall = {
    id: input.toolCallId ?? `resume-${input.runId}`,
    name: CREATE_WORKFLOW_TOOL_NAME,
    input: input.name === undefined ? {} : { name: input.name },
  };
  await this.executor.trackExternalBackgroundTask(
    toolCall,
    { backgroundTaskId: input.runId, status: "backgrounded" },
    traceContext,
    undefined,
  );
  // GUI Resume 成功即激活工具面（launch.md「On demand: activation」）：run 的终态通知会让模型
  // 去调 GetWorkflowRun，没有那个工具它就卡住。
  await activateDynamicWorkflowTools.call(this, { source: "run_control", traceContext });
}
