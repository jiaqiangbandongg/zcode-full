// ============================================================
// dwf run 的发起锚点
// ============================================================
// 子代理的 agent_step 要归到「发起这次 run 的那一轮」下面。锚点是一个 inputId，
// 零 SQL 地活在 journal 事件 `run-launched` 里（只在建 run 那一世记一次）：
//   - 提交时由本文件解析出来（活动轮 / 直接启动铸的值 / 前驱 run 的锚点 / 兜底铸值）
//     交给引擎落库；
//   - resume 与进度事件派生字段从 journal 读回，同一个 run 的锚点因此跨生命周期唯一。
//
// 同一条事件还捎着几件同规的宿主元数据：脚本声明的阶段表（`phaseNames`）、本 run 子代理的
// 选型（`subagentModel`）与权限模式（`subagentPermissionMode`，docs/dynamic-workflow/launch.md
// 「Permissions inside a run」）、脚本点名的模型绑定表（`modelBindings`）、脚本来自哪个文件
// （`scriptPath`，docs/dynamic-workflow/launch.md「Script files」）。它们都只在建 run 那一世写一次、
// 引擎一概不读、都零 SQL——`dwf_run` 上
// 没有对应的列。

import type { TraceContext } from "@zcode/contracts";
import type { JournalStorePort, RunEvent } from "@zcode/dynamic-workflow";
import { uuidv7 } from "@zcode/shared";
import {
  parseWorkflowSubagentPermissionMode,
  type WorkflowSubagentPermissionMode,
} from "./workflow-actor-permission.js";

export interface RunLaunchAnchor {
  /** 发起 run 那一轮的 inputId（中枢直接启动为铸出的 UUID v7）。 */
  inputId: string;
}

/**
 * 交给引擎记进 `run-launched` 的全部内容：锚点 + 脚本声明的阶段表 + 本 run 子代理的选型（`subagentModel`，规范 picker 串
 * `providerId/modelId[$reasoningLevel]`）。
 *
 * 后两者**都不是**锚点的一部分：修订续跑沿用前驱的 inputId，却用新脚本的阶段表，也绝不沿用
 * 前驱的模型（「省略即沿用前驱」是工具面的三态，由 AmendWorkflow 的 resolveInput 归一）——
 * 所以它们在 submit 里与锚点并列合入，而不是塞进 {@link resolveLaunchAnchor}。
 */
export interface RunLaunch extends RunLaunchAnchor {
  phaseNames?: string[];
  subagentModel?: string;
  /**
   * 脚本点名的模型 → 规范串（docs/dynamic-workflow/launch.md「Models the script names」）。与子代理
   * 选型同规地不属于锚点：修订的绑定表由 AmendWorkflow 的 resolveInput 归一（同名沿用前驱），端口不继承。
   */
  modelBindings?: Record<string, string>;
  /**
   * 本 run 脚本文件的绝对路径。与阶段表、
   * 子代理选型同规地不属于锚点：修订记的是**这一次修订**的脚本来自哪个文件，绝不沿用前驱的。
   */
  scriptPath?: string;
  /**
   * 本 run 子代理的权限模式（docs/dynamic-workflow/launch.md「Permissions inside a run」）：
   * 发起会话的权限模式（plan 不带入）。同样不属于锚点：修订是新 run，取修订那一刻
   * 会话的模式，绝不沿用前驱的。
   */
  subagentPermissionMode?: WorkflowSubagentPermissionMode;
  /** 与 `phaseNames` 按位置对齐的「同时在跑」表（下标指向同一张表）；同样只在建 run 那一世落 journal。 */
  phaseAlongside?: number[][];
}

/**
 * 本 run 的首条 `run-launched`（只在建 run 那一世落 journal）。类型过滤与 `limit: 1` 都下推
 * 存储层（docs/execution-engine.md「Reading the journal」）：一条查询、一行，不必像原先那样读
 * journal 的头 8 条再在内存里找。
 */
function firstRunLaunched(
  journal: JournalStorePort,
  runId: string,
): Extract<RunEvent, { type: "run-launched" }> | undefined {
  const [stored] = journal.listEvents(runId, {
    types: ["run-launched"],
    reportItems: { limit: 0 },
    limit: 1,
  });
  return stored?.event.type === "run-launched" ? stored.event : undefined;
}

/**
 * 从 journal 读回 run 的锚点：首条 `run-launched`。升级前发起的 run 没有这条事件 → `undefined`，
 * 调用方据此不派生 `launchInputId`（事实层随之不发 `workflow.lifecycle`，子代理不上报，不补造）。
 */
export function readRunLaunchAnchor(
  journal: JournalStorePort,
  runId: string,
): RunLaunchAnchor | undefined {
  const launched = firstRunLaunched(journal, runId);
  return launched === undefined ? undefined : { inputId: launched.inputId };
}

/**
 * 从 journal 读回本 run 子代理的选型：同一条 `run-launched` 上的 `subagentModel`。resume、两条读面与冷回放都据此还原同一个规范串——
 * 零 SQL，`dwf_run` 上没有这一列。缺席即子代理跑在会话模型上（绝大多数 run，升级前发起的
 * run 亦然）。
 *
 * 与锚点同一条读，却**刻意不挂在** {@link RunLaunchAnchor} 上：
 * {@link resolveLaunchAnchor} 会让修订续跑沿用前驱的锚点，而模型绝不能这样被继承——那是
 * 工具面的三态（省略 = 沿用前驱、null = 回到会话模型、串 = 设定），归一发生在
 * `AmendWorkflow` 的 resolveInput 里，与 `max_concurrency` 同一条论证。
 */
export function readRunSubagentModel(journal: JournalStorePort, runId: string): string | undefined {
  return firstRunLaunched(journal, runId)?.subagentModel;
}

/**
 * 从 journal 读回本 run 脚本点名的模型：同一条 `run-launched` 上的 `modelBindings`
 * （docs/dynamic-workflow/launch.md「Models the script names」）。建子代理会话（含 resume）、两条读面与
 * 冷回放都据此把 persona 里的模型名映射到规范串——名字在 launch 时解析过一次，此后不再对着目录重解，
 * 所以一个 resume 的 run 跑的仍是用户批准时的那几个模型。缺席即脚本没点名任何模型。
 *
 * 与 {@link readRunSubagentModel} 同一条读、同一个理由不挂在锚点上。
 */
export function readRunModelBindings(
  journal: JournalStorePort,
  runId: string,
): Record<string, string> | undefined {
  return firstRunLaunched(journal, runId)?.modelBindings;
}

/**
 * 从 journal 读回本 run 子代理的权限模式：同一条 `run-launched` 上的 `subagentPermissionMode`
 * （docs/dynamic-workflow/launch.md「Permissions inside a run」）。resume 据此让子代理继续跑在
 * 建 run 时的模式上，与会话此刻的模式无关。缺席或未知值即 YOLO（本特性之前发起的 run 亦然）。
 */
export function readRunSubagentPermissionMode(
  journal: JournalStorePort,
  runId: string,
): WorkflowSubagentPermissionMode | undefined {
  const launched = firstRunLaunched(journal, runId);
  return launched === undefined
    ? undefined
    : parseWorkflowSubagentPermissionMode(launched.subagentPermissionMode);
}

/**
 * 从 journal 读回本 run 的脚本文件：同一条 `run-launched` 上的 `scriptPath`
 * （docs/dynamic-workflow/launch.md「Script files」的 Provenance）。两条读面的冷路径据此
 * 还原同一个绝对路径——零 SQL，`dwf_run` 上没有这一列。缺席即这个 run 没有可编辑的脚本文件
 * （草稿写不下去的项目、本特性之前发起的 run）。
 *
 * 与 {@link readRunSubagentModel} 同一条读，同样**刻意不挂在**
 * {@link RunLaunchAnchor} 上：锚点会被修订续跑沿用，而前驱的脚本路径指向的是旧脚本，
 * 沿用它就是让模型下次去编辑一个已经不在跑的文件。
 */
export function readRunScriptPath(journal: JournalStorePort, runId: string): string | undefined {
  // 补全可以给一个没有草稿的 run 铸一份（docs/dynamic-workflow/launch.md「The draft after a fill」），
  // 路径随那条 `hole-filled` 落 journal；最后一条在场的胜过建 run 那一世的记录。一次有类型过滤
  // 的窄读：绝大多数 run 一条 hole-filled 都没有。
  let minted: string | undefined;
  for (const { event } of journal.listEvents(runId, {
    types: ["hole-filled"],
    reportItems: { limit: 0 },
  })) {
    if (event.type === "hole-filled" && event.scriptPath !== undefined) minted = event.scriptPath;
  }
  return minted ?? firstRunLaunched(journal, runId)?.scriptPath;
}

/**
 * 提交时解析锚点。优先级：
 *   1. 修订续跑（`resume_from`）沿用**前驱**的锚点——同一件工作的所有 step 挂同一个 message；
 *   2. 调用方显式给的 `launchInputId`（中枢直接启动：与 controlOnly 启动轮共用一个 UUID v7）；
 *   3. 父 runtime 活动轮的 inputId（聊天 CreateWorkflow：工具在那一轮里执行）；
 *   4. 兜底铸一个 UUID v7（CLI、无活动轮的宿主、前驱没有锚点的修订）。
 */
export function resolveLaunchAnchor(input: {
  requested?: string;
  trace: TraceContext;
  resolveLaunchInputId?: (trace: TraceContext) => string | undefined;
  predecessor?: RunLaunchAnchor;
  mint?: () => string;
}): RunLaunchAnchor {
  if (input.predecessor !== undefined) return input.predecessor;
  const inputId =
    input.requested ?? input.resolveLaunchInputId?.(input.trace) ?? (input.mint ?? uuidv7)();
  return { inputId };
}
