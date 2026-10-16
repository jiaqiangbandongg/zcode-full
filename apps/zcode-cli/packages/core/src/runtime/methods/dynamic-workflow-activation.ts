// ============================================================
// 动态工作流工具面的按需激活（docs/dynamic-workflow/launch.md「On demand: activation」）
// ============================================================
// 灰度 mode 为 `onDemand` 的会话出生时不注册十个工作流工具（Agent / Task 描述里也没有那行
// CreateWorkflow），直到本会话第一次真的要用到它们：用户敲 `/workflow`、GUI 对本会话的 run 按下
// Resume / 配置、从中枢直接启动一个保存的工作流，或恢复一条记录里已有工作流的会话。激活只加不减：
// 会话里一旦有了 run，模型此后一直需要 GetWorkflowRun 等工具去接通知——compaction 不关它
// （对比技能门：那个问的是「模型此刻还看得见吗」，这个问的是「本会话有没有过工作流」）。
//
// 状态 owner 是 runtime（dynamicWorkflowToolsActivated），不是 config：AgentRuntime 构造时把
// config 拷了一份，装配层闭包里那个 runtimeConfig 对象看不到运行期的翻转。

import {
  SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
  type MessageWithParts,
  type SessionEntryInfo,
  type SessionId,
  type TraceContext,
} from "@zcode/contracts";
import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { AgentRuntimeConfig } from "../types.js";
import { isDynamicWorkflowToolName } from "../../tool/index.js";
import { refreshBranchAwareBuiltInTools } from "./embedded-search-branch.js";

/** 激活的来源，落进 session entry 供排查；行为上四者等价。 */
export type DynamicWorkflowActivationSource =
  | "command"
  | "run_control"
  | "resume_entry"
  | "resume_history";

export interface DynamicWorkflowActivationEntryData {
  activated: true;
  source: DynamicWorkflowActivationSource;
}

/**
 * 内置 `/workflow` 命令名（bootstrap/src/builtin-workflow-command.ts 的 BUILTIN_WORKFLOW_COMMAND_NAME）。
 * core 不依赖 bootstrap，这里按保留字表里的字面量写；用户消息持久化的是 `displayInput`——命令原文。
 */
const WORKFLOW_COMMAND_TEXT_PATTERN = /^\/workflow(?:\s|$)/i;

/** 出生即激活的会话：非 onDemand（alwaysOn、TUI / headless / 子代理未设该字段）。 */
export function resolveInitialDynamicWorkflowToolsActivated(config: AgentRuntimeConfig): boolean {
  return config.dynamicWorkflowToolsOnDemand !== true;
}

/**
 * 激活本会话的工作流工具面。已激活（含出生即激活）时是 no-op 并返回 false。
 * 顺序：先翻状态、再重注册（两处注册入口共用的门读的就是这个状态）、再落 entry——重注册同步完成，
 * 所以调用方在它返回后发出的第一个模型请求必然带着十个工具。
 */
export async function activateDynamicWorkflowTools(
  this: AgentRuntimeInternal,
  input: { source: DynamicWorkflowActivationSource; traceContext?: TraceContext },
): Promise<boolean> {
  if (this.dynamicWorkflowToolsActivated) return false;
  markDynamicWorkflowToolsActivated(this, input.source);
  // entry 写失败只记 warn、不向上抛。原因：过去抛出会让 `/workflow` / Resume 报错，而工具面已经
  // 激活（只加不减），此后的调用因已激活直接 no-op，形成「操作失败但状态已生效」。entry 只是冷恢复
  // 历史扫描的捷径——每个激活来源都会在记录里留下 `/workflow` 或 CreateWorkflow 调用，
  // restoreDynamicWorkflowActivationOnResume 缺 entry 时按历史判出激活并补写。
  try {
    await persistDynamicWorkflowActivation(this);
  } catch (error) {
    this.logger?.warn("Dynamic workflow activation entry write failed", {
      ...traceContextToLogContext(input.traceContext ?? this.rootTraceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.activation_entry_write_failed",
      module: "core.runtime",
      sessionId: this.sessionId,
    });
  }
  this.logger?.info("Dynamic workflow tools activated", {
    ...traceContextToLogContext(input.traceContext ?? this.rootTraceContext),
    event: "dynamic_workflow.tools_activated",
    module: "core.runtime",
    sessionId: this.sessionId,
    source: input.source,
  });
  return true;
}

/**
 * 冷恢复：按 entry 或历史判定本会话有没有过工作流（launch.md「What activates」第三行）。
 * 历史判据兜住两类会话：出生在 alwaysOn、后来 Host 翻成 onDemand 的；以及本规则之前落盘的。
 * 只在 runtime 尚未激活时有事可做；messages 是 session store 里的全部持久化消息（含 rewind 前的——
 * 「有没有过」不随分支变化）。
 */
export async function restoreDynamicWorkflowActivationOnResume(
  this: AgentRuntimeInternal,
  messages: readonly MessageWithParts[],
): Promise<void> {
  if (this.dynamicWorkflowToolsActivated) return;
  const entries = await this.sessionStore?.sessionEntries?.({
    sessionID: this.sessionId,
    type: SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
  });
  const source: DynamicWorkflowActivationSource | undefined =
    entries !== undefined && entries.length > 0
      ? "resume_entry"
      : persistedMessagesShowDynamicWorkflow(messages)
        ? "resume_history"
        : undefined;
  if (source === undefined) return;
  markDynamicWorkflowToolsActivated(this, source);
  // entry 已在场时不重写；从历史判出来的补一条，下次恢复不必再扫。直接写而不经
  // persistDynamicWorkflowActivation：resume 里 sessionPersisted 要到收尾才置位，而恢复中的会话
  // 在 store 里必然已经存在。
  if (source === "resume_history") await writeDynamicWorkflowActivationEntryIfActivated(this);
}

/** 持久化的消息里有没有一次 `/workflow` 命令，或十个工具中任一次调用。 */
export function persistedMessagesShowDynamicWorkflow(
  messages: readonly MessageWithParts[],
): boolean {
  for (const message of messages) {
    const role = message.info.role;
    for (const part of message.parts) {
      if (
        role === "user" &&
        part.type === "text" &&
        WORKFLOW_COMMAND_TEXT_PATTERN.test(part.text.trim())
      )
        return true;
      if (role === "assistant" && part.type === "tool" && isDynamicWorkflowToolName(part.tool))
        return true;
    }
  }
  return false;
}

/**
 * 首次持久化时（events.ts 的 ensureSessionPersisted）补写 entry：`/workflow` 作为会话首轮到来时，
 * 激活先于会话落盘，那一刻 persistDynamicWorkflowActivation 无处可写。
 */
export async function writeDynamicWorkflowActivationEntryIfActivated(
  runtime: AgentRuntimeInternal,
): Promise<void> {
  if (runtime.config.dynamicWorkflowToolsOnDemand !== true) return;
  if (
    !runtime.dynamicWorkflowToolsActivated ||
    runtime.dynamicWorkflowActivationSource === undefined
  )
    return;
  await runtime.sessionStore?.saveSessionEntry?.(
    buildDynamicWorkflowActivationEntry(runtime.sessionId, runtime.dynamicWorkflowActivationSource),
  );
}

export function buildDynamicWorkflowActivationEntry(
  sessionId: SessionId,
  source: DynamicWorkflowActivationSource,
): SessionEntryInfo {
  const timestamp = Date.now();
  const data: DynamicWorkflowActivationEntryData = { activated: true, source };
  return {
    id: `${sessionId}:runtime-dynamic-workflow-activation`,
    sessionID: sessionId,
    type: SESSION_ENTRY_DYNAMIC_WORKFLOW_ACTIVATION,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data,
  };
}

function markDynamicWorkflowToolsActivated(
  runtime: AgentRuntimeInternal,
  source: DynamicWorkflowActivationSource,
): void {
  runtime.dynamicWorkflowToolsActivated = true;
  runtime.dynamicWorkflowActivationSource = source;
  // 与分支刷新同一个入口：它已经会按共用的门重注册全部内置工具（Agent / Task 描述随之换回带
  // CreateWorkflow 的那版）并清 cachedTools。
  refreshBranchAwareBuiltInTools(runtime);
}

async function persistDynamicWorkflowActivation(runtime: AgentRuntimeInternal): Promise<void> {
  if (!runtime.sessionPersisted) return;
  await writeDynamicWorkflowActivationEntryIfActivated(runtime);
}
