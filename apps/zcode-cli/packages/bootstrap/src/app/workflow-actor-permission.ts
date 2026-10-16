// ============================================================
// workflow actor 的权限面（发起会话模式 → run 记录 → AgentRuntime 模式）
// ============================================================
// 见 docs/dynamic-workflow/launch.md「Permissions inside a run」。
//
// 子代理跑在发起 run 的会话的权限模式上（plan 不带入：run 总在执行）。该问时经父 runtime 派生的
// broker 请求用户。模式在建 run 那一世定下、记进 `run-launched`，resume 从事件读回——会话此后
// 换模式不影响在飞的 run。缺席或未知值即 YOLO：本特性之前的 run 与没接模式读取的宿主照旧。
// 与 workflow-actor-tools.ts / workflow-actor-model.ts 是同一个接缝上的姊妹模块，都由 driver
// 侧的 runtime 工厂在造 AgentRuntime 时展开。

import type { CollaborationMode } from "@zcode/contracts";
import { refToString, type ActorRef, type PersonaSpec } from "@zcode/dynamic-workflow";

/** run 记下的子代理权限模式：会话的基础权限模式，plan 除外。 */
export type WorkflowSubagentPermissionMode = Exclude<CollaborationMode, "plan">;

/** journal 里认得的值；引擎把它当不透明串，读回时按这张表校验。 */
const RECORDABLE_MODES: ReadonlySet<string> = new Set<WorkflowSubagentPermissionMode>([
  "build",
  "edit",
  "yolo",
  "guarded",
  "auto",
]);
/** 没有记录时子代理的模式：与本特性之前所有 run 一致。 */
const UNRECORDED_MODE = "yolo" satisfies CollaborationMode;
/** persona 没有名字时交互归属里的占位名。 */
const ANONYMOUS_ACTOR_NAME = "subagent";

/**
 * 发起会话的模式 → run 要记下的子代理权限模式。`getMode()` 给的是基础模式（plan 是独立开关，
 * 不在其中）；遗留的 `plan` 枚举值记为 build，与普通子代理拆分 plan 后的回退一致。
 */
export function workflowSubagentPermissionModeOf(
  sessionMode: CollaborationMode | undefined,
): WorkflowSubagentPermissionMode | undefined {
  if (sessionMode === undefined) return undefined;
  return sessionMode === "plan" ? "build" : sessionMode;
}

/**
 * 同一条映射落成 `run-launched` / RunLaunch 上的可选键：宿主没报模式时键**缺席**而不是
 * undefined 值（与 `run-launched` 其余同车字段同规）。
 */
export function workflowSubagentPermissionModeField(sessionMode: CollaborationMode | undefined): {
  subagentPermissionMode?: WorkflowSubagentPermissionMode;
} {
  const mode = workflowSubagentPermissionModeOf(sessionMode);
  return mode === undefined ? {} : { subagentPermissionMode: mode };
}

/**
 * journal 里的原始值 → 子代理权限模式。未知值（更新版本写下的新模式、损坏的事件）读成缺席，
 * 即 YOLO：旧版本不猜一个它不懂的模式的语义。
 */
export function parseWorkflowSubagentPermissionMode(
  raw: unknown,
): WorkflowSubagentPermissionMode | undefined {
  return typeof raw === "string" && RECORDABLE_MODES.has(raw)
    ? (raw as WorkflowSubagentPermissionMode)
    : undefined;
}

/** AgentRuntimeConfig 的权限面切片。 */
interface WorkflowActorPermissionPolicy {
  mode: CollaborationMode;
}

/** run 记下的模式 → actor runtime 的模式；缺席即 YOLO。 */
export function workflowActorPermissionPolicy(
  subagentPermissionMode: WorkflowSubagentPermissionMode | undefined,
): WorkflowActorPermissionPolicy {
  return { mode: subagentPermissionMode ?? UNRECORDED_MODE };
}

/**
 * 交互请求 origin 上的 `description`：`<persona 名> (<siteId>@<ordinal>)`。权限窗的来源徽标
 * 据此点名是哪个子代理在问；同一 persona 名的多个子代理靠实例坐标区分。
 */
export function workflowActorInteractionDescription(input: {
  actor: ActorRef;
  persona: Pick<PersonaSpec, "name">;
}): string {
  return `${input.persona.name ?? ANONYMOUS_ACTOR_NAME} (${refToString(input.actor)})`;
}
