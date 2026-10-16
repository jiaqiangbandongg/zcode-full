// ============================================================
// workflow actor 的工具面（AgentRuntime 工具配置）
// ============================================================
//
// 子代理的工具面必须落到 child runtime 的工具注册上，否则实盘 transcript
// 里裁判 actor 也拿到了整套交互工具。两类风险：
//   1. 悬挂：AskUserQuestion / EnterPlanMode 在 headless child 里没有人可问，turn 永远不结束；
//      2026-09-23 起 AskUserQuestion 经父会话送达用户，已还给子代理（见减法表注释）；
//   2. 越权与递归：CreateWorkflow 让 actor 能再提交一条工作流，ReadSessionContext 越界读父会话。
// 本模块是那个缺失的映射，由 driver 侧的 runtime 工厂在造 AgentRuntime 时展开。
//
// persona 无工具档位：每个 actor 都拿完整工作工具集减去下面这份减法表；
// 「裁判不要改文件」由 ask 文本说清——普通子代理也是这么做的（Explore 保留 Bash，
// 只读靠提示）。

import {
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  READ_SESSION_CONTEXT_TOOL_NAME,
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
} from "@zcode/contracts";

/** AgentRuntimeConfig 的工具面切片。 */
interface WorkflowActorToolPolicy {
  toolDisallowlist: readonly string[];
}

/**
 * 从全集里减掉的工具：plan 两件套——子代理不做待批准的计划；CreateWorkflow 会让 actor 递归
 * 提交工作流；ReadSessionContext 越界读父会话。其余（Bash / Edit / Write / 搜索 / web）照常
 * 保留——actor 就是要干活的。
 *
 * AskUserQuestion 不在表里：它走 PermissionRequested，经父 runtime 派生的 broker 与父会话镜像
 * 送达确认窗（docs/dynamic-workflow/launch.md「Permissions inside a run」），不再悬挂。
 */
const ACTOR_DISALLOWED_TOOLS: readonly string[] = [
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  "CreateWorkflow",
  // 修订入口与 CreateWorkflow 同一种嵌套编排，同一个根因入列。
  "AmendWorkflow",
  READ_SESSION_CONTEXT_TOOL_NAME,
  // 子代理不许替主代理回答升级问题（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Escalation」）。
  // 与上面几条的根因不同：这不是越权读，而是**身份**——升级的整个意义是把判断权
  // 交给创建这条工作流的那一方；让另一个 actor 顺手作答，等于把它悄悄退化成 actor 之间的
  // 互相说服。actor 提问用 `escalate`（恒注册），作答只属于主会话。
  RESOLVE_WORKFLOW_QUESTION_TOOL_NAME,
];

/**
 * workflow actor 的 AgentRuntime 工具配置。纯函数，供 driver 侧 runtime 工厂展开进
 * AgentRuntimeConfig：不收窄，只减掉 plan 与越权的元工具。
 *
 * 只覆盖内建工具；MCP / plugin 工具的过滤留待生产接线时处理（同一个工厂 seam）。
 */
export function workflowActorToolPolicy(): WorkflowActorToolPolicy {
  return { toolDisallowlist: ACTOR_DISALLOWED_TOOLS };
}
