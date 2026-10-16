// ============================================================
// Dynamic Workflow Run Port - 留白（hole）的读面与补全面
// ============================================================
// 从 dynamic-workflow-run.port.ts 拆出（oxlint max-lines 400 行门），照 retune 的先例
// （dynamic-workflow-run-retune.port.ts）：快照上的留白条目、`fillHole` 的请求与结果住在这里，端口
// 方法本身仍在 DynamicWorkflowRunPort 上；公开名一个不改，主端口文件 `export type *` 再导出。
// spec：docs/dynamic-workflow/launch.md「The `FillWorkflowHole` tool」；
// apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Holes」。

import type { SessionId, ToolCallId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

/**
 * 一处留白在快照上的投影（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「The run snapshot」）：
 * 由 `hole-reached` / `hole-filled` 事件加引擎内存里的停驻表投影——**`waiting` 只在引擎说它在等时**
 * 成立（进程亡故后没有 promise 在等，单靠事件会把一个没人问的留白报成在等），`filled` 来自事件。
 * 零条时整字段缺席，≤32。
 *
 * `line` / `before` / `after` 是留白通知（core 的进度发射器）要念的三样：留白调用在草稿里的行、
 * 它前后的阶段名，都来自编译产物；读不到时缺席，通知随之省略那一句。草稿路径不在这里——它就是
 * 快照的 `scriptPath`。
 */
export interface DynamicWorkflowRunHole {
  /** 留白的站点 id（`hole#21b40fca`，名字键）；`fillHole` 只认它。 */
  siteId: string;
  /** 这一处的序号（同一站点在循环里可以到达多次）。 */
  ordinal: number;
  /** 留白的字面名。 */
  name: string;
  /** 类型实参原文（`Verdict`），照脚本写法。 */
  type: string;
  state: "waiting" | "filled";
  /** 到达时刻（epoch ms）；`waiting` 时在场。 */
  since?: number;
  /** 补全时刻（epoch ms）；`filled` 时在场。 */
  filledAt?: number;
  /** 补全它的会话（`fillHole` 请求的 `parentSessionId`）。 */
  filledBy?: string;
  /** 留白调用在 run 草稿里的行号（1 起）。 */
  line?: number;
  /** 留白之前的阶段名。 */
  before?: string;
  /** 留白之后的阶段名。 */
  after?: string;
}

/**
 * {@link DynamicWorkflowRunPort.fillHole} 的请求（docs/dynamic-workflow/launch.md「The `FillWorkflowHole`
 * tool」；引擎文档「The fill service's checks」）。`body` 是留白函数体的**语句**，逐字节；拼接、编译、
 * 站点稳定性检查与草稿改写都在端口实现侧。
 */
export interface DynamicWorkflowRunFillHoleRequest {
  runId: string;
  /** 留白的站点 id（`hole#21b40fca`，名字键）。 */
  holeId: string;
  body: string;
  /** 补全的会话，落进 `hole-filled.filledBy`。 */
  parentSessionId?: SessionId | string;
  /** 发起这次补全的 FillWorkflowHole 工具调用。 */
  toolCallId?: ToolCallId | string;
  trace: TraceContext;
}

/**
 * 补全被拒的结构化理由。四者对模型是四个不同的下一步：换 run id / 看 run 的状态（停了就先
 * ResumeWorkflowRun）/ 改 fill 文件再交 `path` / 什么都别改，这是宿主的故障。
 */
export type DynamicWorkflowRunFillHoleRefusalReason =
  /** journal 里没有这个 run。 */
  | "run_not_found"
  /** run 不在飞，或这个留白不是它正在等的（已补过、还没到、未知 id）；message 说明是哪一种。 */
  | "hole_not_waiting"
  /** 有效脚本编不过；`diagnostics` 在场。什么都没拼、没记、留白照旧在等。 */
  | "compile_failed"
  /** 编好的有效脚本给某个既有站点换了号：分析器的编号规则被打破，是宿主故障而非模型的错；留白照旧在等。 */
  | "fill_ids_unstable";

/**
 * 一条补全诊断。`inFill` 为真时 `line` / `column` 是**函数体内**的坐标（拼进去的那一段），否则是
 * 脚本坐标——工具层据此把它锚到 fill 文件或 run 的草稿。
 */
export interface DynamicWorkflowRunFillHoleDiagnostic {
  line: number;
  column: number;
  message: string;
  code: number;
  inFill: boolean;
}

/**
 * `fillHole` 的结构化结果。成功时 `scriptText` 是**有效脚本**（已拼入函数体、已落库的那一份），
 * 工具层据它铸 display；`scriptPath` 是 run 的草稿（已被就地改写成有效脚本；run 原本没有草稿时
 * 由实现侧铸一份）；`phasesAdded` 是函数体带来的阶段名。
 */
export type FillWorkflowHoleResult =
  | { ok: true; phasesAdded: string[]; scriptPath?: string; scriptText: string }
  | {
      ok: false;
      reason: DynamicWorkflowRunFillHoleRefusalReason;
      message: string;
      diagnostics?: DynamicWorkflowRunFillHoleDiagnostic[];
    };
