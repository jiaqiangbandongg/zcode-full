// ============================================================
// run-launched：发起 run 那一轮的宿主元数据 → 事件
// ============================================================
// 引擎不读这些元数据（锚点、阶段表、并行表、子代理选型），只在建 run 那一世紧跟首条
// `run-started` 逐字转录一次（engine.ts）。构造独立成模块，engine.ts 与 types.ts 才都留在
// 400 行的 lint 上限之内——它们是两侧同时增长的文件。

import type { RunEvent } from "./types.js";

/**
 * 发起 run 那一轮随 `run-launched` 同车的宿主元数据（EngineConfig.launch）：锚点 `inputId`、
 * 脚本声明的阶段表 `phaseNames`、与之按位置对齐的 `phaseAlongside`、本 run 子代理的选型
 * `subagentModel` 与权限模式 `subagentPermissionMode`、脚本点名的模型绑定表 `modelBindings`、脚本来自
 * 哪个文件 `scriptPath`，以及留白下标表 `holes`。八者引擎都不读——字段语义见 types.ts 里
 * `run-launched` 的注释。
 */
export interface RunLaunchConfig {
  inputId: string;
  phaseNames?: string[];
  subagentModel?: string;
  /** 脚本点名的模型名（逐字）→ 规范串（docs/dynamic-workflow/launch.md「Models the script names」）。 */
  modelBindings?: Record<string, string>;
  /**
   * 本 run 子代理的权限模式（docs/dynamic-workflow/launch.md「Permissions inside a run」）：
   * 发起会话的权限模式名。引擎不读，按不透明串记下；宿主读回时校验。
   */
  subagentPermissionMode?: string;
  /** 本 run 脚本文件的绝对路径（docs/dynamic-workflow/launch.md「Script files」）。 */
  scriptPath?: string;
  phaseAlongside?: number[][];
  /** `phaseNames` 里未补全留白的下标（docs/execution-engine.md「Holes」），同车同规。 */
  holes?: number[];
}

/**
 * 把 launch 元数据转录成 `run-launched`。未设的键**缺席**而不是落成 undefined 值：读侧
 * （AmendWorkflow 的三态、投影）把「没设」与「设了个空」当两件事。
 */
export function runLaunchedEvent(
  launch: RunLaunchConfig,
  origin: { toolCallId?: string | undefined; parentSessionId?: string | undefined },
): RunEvent {
  const {
    inputId,
    phaseNames,
    subagentModel,
    subagentPermissionMode,
    modelBindings,
    scriptPath,
    phaseAlongside,
    holes,
  } = launch;
  return {
    type: "run-launched",
    inputId,
    ...(origin.toolCallId === undefined ? {} : { toolCallId: origin.toolCallId }),
    ...(origin.parentSessionId === undefined ? {} : { parentSessionId: origin.parentSessionId }),
    ...(phaseNames === undefined ? {} : { phaseNames }),
    ...(subagentModel === undefined ? {} : { subagentModel }),
    ...(subagentPermissionMode === undefined ? {} : { subagentPermissionMode }),
    ...(modelBindings === undefined ? {} : { modelBindings }),
    ...(scriptPath === undefined ? {} : { scriptPath }),
    ...(phaseAlongside === undefined ? {} : { phaseAlongside }),
    ...(holes === undefined ? {} : { holes }),
  };
}
