// ============================================================
// workflow actor 的模型面（run 选择 / journal pin → AgentRuntime 模型配置）
// ============================================================
//
// persona 的模型档位（`model?: "main" | "lite"`）已退场。宿主在 provider 重构后没有 lite 模型来源，
// "lite" 与 "main" 早已同路——继承父会话当前模型。
//
// 于是本模块只回答一个问题：**这个 actor 的会话该跑在哪个模型上**。四个来源按优先级排：
// persona 点名的模型（脚本里的 `agent(…, { model })`，经 run-launched 的绑定表解析；
// docs/dynamic-workflow/authoring.md「Choosing a model per subagent」）> 本 run 的 `subagentModel`
// （`CreateWorkflow` / `AmendWorkflow` 的 `subagent_model`，docs/dynamic-workflow/launch.md）>
// resume pin（journal 里上一次实际跑的模型）> 父会话当前模型。
//
// 2026-09-26 追记：persona 的模型回来了，但不是退场的那个档位——脚本写的是具体模型名，launch 时已
// 对着模型目录解析成绑定表，这里只查表（{@link resolveActorPersonaModel}）。
// 与 workflow-actor-tools.ts 是同一个接缝上的姊妹模块：一个给出工具面，一个给出模型面，
// 都由 driver 侧的 runtime 工厂在造 AgentRuntime 时展开。

import type { ModelSelection } from "@zcode/shared/model-selection";
import { parseModelPickerValue } from "@zcode/shared/model-selection";
import { parseProviderQualifiedModelSelection } from "./provider-registry-selection.js";

/** 解析模型面需要的宿主侧事实。 */
interface WorkflowActorModelHost {
  /**
   * 父会话**当前**的模型选择（`runtime.getSessionModelSelection()`）。只在没有 run 级选择时
   * 有用：与 pin 比对（判断「钉住的模型是否就是现在的主模型」，从而决定 pin 分支要不要真的
   * 覆盖）。父会话尚无选择时缺席。
   */
  parentSelection?: ModelSelection | undefined;
  /**
   * 本 run 自己的子代理模型（`CreateWorkflow` / `AmendWorkflow` 的 `subagent_model`，从 journal
   * 的 `run-launched` 事件读回）。**整条选择**，含 reasoning
   * 档位——用户说「子代理跑 GLM-5.3-Flash$high」时那个档位是选择的一部分，不能在这里掉。
   *
   * 位置：**最高**。它是用户对这一次 run 的显式表态；在场时 pin 与父模型都只是它本来要替换的
   * 缺省（见下面的函数注释）。主代理不受它影响——它只描述子代理。
   */
  runSelection?: ModelSelection | undefined;
  /**
   * 这个 actor 的 persona 点名的模型，已按本 run 的绑定表解析成整条选择（含 reasoning 档位；
   * {@link resolveActorPersonaModel}）。位置：**最高**——它是为这一个子代理写下、且用户在确认窗里
   * 批准过绑定的选择，比「整个 run 的子代理默认模型」更具体。
   */
  actorSelection?: ModelSelection | undefined;
}

/** AgentRuntimeConfig 的模型面切片。 */
interface WorkflowActorModelPolicy {
  /**
   * 展开进 AgentRuntimeConfig 的覆盖项。**空对象即「不覆盖」**：child runtime 的基线本就是
   * 父会话的模型选择（script-workflow-child-runtime.ts），所以没有 run 选择也没有 pin 时什么
   * 都不写，就是继承父模型。
   */
  configOverrides: {
    modelSelection?: ModelSelection;
  };
}

/**
 * 钉住的模型无法构造时抛出。带上 pin 本身：排查的人需要知道 journal 里钉的是哪个模型，
 * 而不是从一条「模型引用非法」的通用消息里猜。
 */
export class WorkflowActorPinnedModelError extends Error {
  readonly pinnedModel: string;

  constructor(pinnedModel: string, cause?: unknown) {
    super(`Cannot construct the model pinned for this subagent: ${pinnedModel}`);
    this.name = "WorkflowActorPinnedModelError";
    this.pinnedModel = pinnedModel;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * persona 点名了一个本 run 的绑定表里没有的名字。只有绕过编译器 9010 规则的类型断言走得到这里
 * （编译期保证名字集合封闭、launch 时整张表解析过）；带上名字与表里有的名字，排查的人才知道是哪一行
 * 脚本、差了什么。宁可大声失败——悄悄退回 run 的子代理模型，就是跑一个用户没批准过的模型。
 */
export class WorkflowActorModelUnboundError extends Error {
  readonly modelName: string;

  constructor(modelName: string, bound: readonly string[]) {
    super(
      `This subagent's persona names the model "${modelName}", which the run did not resolve at launch` +
        (bound.length === 0
          ? " (the script named no models)."
          : ` (it resolved: ${bound.map((name) => `"${name}"`).join(", ")}).`),
    );
    this.name = "WorkflowActorModelUnboundError";
    this.modelName = modelName;
  }
}

/**
 * persona 的模型名 → 整条选择（docs/dynamic-workflow/launch.md「Models the script names」）。纯函数。
 *
 * 名字按**逐字**查表：lowering 把 `model("x")` 抹成 `"x"`，persona 里带的就是脚本写下的那个串，
 * 而表的键也是它。persona 没点名模型时回 undefined（交给 run 选择 / pin / 父模型）。
 */
export function resolveActorPersonaModel(
  personaModel: string | undefined,
  bindings: Readonly<Record<string, string>> | undefined,
): ModelSelection | undefined {
  if (personaModel === undefined) return undefined;
  const canonical = bindings?.[personaModel];
  if (canonical === undefined) {
    throw new WorkflowActorModelUnboundError(personaModel, Object.keys(bindings ?? {}));
  }
  return parseModelPickerValue(canonical);
}

/**
 * 把 persona 的模型、run 选择与 journal 里的 pin 映射成 AgentRuntime 的模型配置。纯函数。
 *
 * `pinnedModel` 是这个 actor 在 journal 里记下的 `resolvedModel`（`providerId/modelId`），
 * 只有 resume（含 amend-resume 从前驱承袭的种子）会带上它。
 *
 * 优先级：**persona 点名的模型 > 本 run 的 `subagentModel` > resume pin > 父会话当前模型**。
 *
 * | run 选择 | pin | 解析结果 |
 * |---|---|---|
 * | 有 | 任意（含畸形，不解析） | 覆盖成 run 选择（整条，含 reasoning 档位） |
 * | 无 | 无 | 不覆盖（父会话当前模型） |
 * | 无 | = 父会话当前模型 | 不覆盖（钉的就是现在的主模型） |
 * | 无 | ≠ 父会话当前模型 | 覆盖成 pin 解析出的选择 |
 * | 无 | 畸形（缺 provider 段） | {@link WorkflowActorPinnedModelError} |
 *
 * **省略即继承，显式值即替换。** resume / amend 的 `resolveInput` 对 `subagentModel` 与
 * `max_concurrency` 已经是这条规则；pin 是同一条规则用在**隐式缺省**上：一个没有 `subagentModel`
 * 的 run，其子代理的缺省不是「父会话此刻的模型」，而是「这个子代理上次实际跑的模型」。run 有了
 * `subagentModel`，就没有缺省可继承，pin 便无话可说。所以 pin 排在 run 选择之下——它守的是
 * 静默漂移，而 `AmendWorkflow` 带 `subagent_model` 恰是那个显式、用户看得见的决定（确认窗与
 * 工具输出都写着「Subagents run on …」）。之前 pin 排在 run 选择之上，结果每个
 * 带 live 工作的续跑子代理都跑在前驱的模型上，而 `run-launched` 与确认窗说的是另一个。
 * 换模型这段历史不会丢：新 run 自己的 `dwf_actor` 行记下新选择，前驱的行仍是旧模型，lineage
 * 因此保留了「在哪一次 run 换过」。
 *
 * 为什么要有 pin——它是 **persona 冻结不变式的持久化那一半**：persona 在 `agent()` 时冻结，
 * 而 resume 会从 journal 重建 actor。没有 pin，父会话在两次运行之间换了主模型，就会在一条
 * actor transcript 中途**悄悄改掉一个已冻结的身份**：前半段的 ask 由模型 X 产出、resume 之后的
 * 由模型 Y 产出，而没有任何地方记下身份变过。
 *
 * **v1 的 pin-miss 策略（无 run 选择的路径）：宁可失败，绝不静默换模型。** pin 指向宿主再也
 * 构造不出的模型时（provider 没了、模型下线），本函数**不回退**到父会话模型——那恰好就是 pin
 * 要防的那次静默身份变更。畸形的 pin 在这里就以 {@link WorkflowActorPinnedModelError} 失败；
 * 而一个「格式合法但宿主已经没有」的模型在建会话这一刻查不出来（要查得动宿主的 Registry，那是
 * 本纯函数刻意不引入的机器），它会在**第一次 ask** 的模型调用上以 node 级错误浮出来——这是有意
 * 接受的：晚一点大声失败，也好过悄悄换一个模型继续跑。要在 resume 时换模型，路只有一条：
 * `AmendWorkflow` 带上 `subagent_model`，那正是 run 选择这一支。
 *
 * 本函数**不产出**「最终跑在哪个模型上」这条事实：它要落 journal，而权威是造出来的 child
 * runtime 自己（`runtime.getSessionModelSelection()`）。让 runtime 来说，就不会出现「策略以为
 * 选了 A、runtime 实际跑着 B」这类两处各算一遍才会有的偏差。落库见
 * dynamic-workflow-run-launch.ts 的 `journalActorResolvedModel`。
 */
export function workflowActorModelPolicy(
  host: WorkflowActorModelHost,
  pinnedModel?: string,
): WorkflowActorModelPolicy {
  // persona 点名了模型：它就是这个子代理的显式选择，run 选择与 pin 都只是它要替换的缺省。
  if (host.actorSelection !== undefined) {
    return { configOverrides: { modelSelection: host.actorSelection } };
  }
  // run 选择在场：整条覆盖，pin 连解析都不解析——它只是本 run 要替换掉的那个缺省。
  if (host.runSelection !== undefined) {
    return { configOverrides: { modelSelection: host.runSelection } };
  }
  if (pinnedModel === undefined) return { configOverrides: {} };
  const pinned = parsePinnedModel(pinnedModel);
  // 钉的就是父会话现在的模型：交给 child runtime 的基线自己表达。「不覆盖」是**更强**的
  // 表达——基线连 reasoning 选项一起继承，而按身份覆盖会把选项换成一个少了 options 的等价物。
  if (host.parentSelection !== undefined && sameModelIdentity(pinned, host.parentSelection)) {
    return { configOverrides: {} };
  }
  // 父会话在两次运行之间换了主模型。仍然钉住 pin——静默换模型正是 pin 要防的事；要换，
  // 走 AmendWorkflow 的 subagent_model（上面那一支）。
  // reasoning 选项在这条路径上不重算：pin 守的是**模型身份**（providerId/modelId），journal 里也只记这两段。
  return { configOverrides: { modelSelection: pinned } };
}

/** pin 比对只看身份两段：journal 只记 `providerId/modelId`，options 不是身份的一部分。 */
function sameModelIdentity(a: ModelSelection, b: ModelSelection): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

/**
 * 解析 journal 里的 pin。**不带默认 provider**：pin 是本机写出的 `providerId/modelId`，
 * 缺了 provider 段就说明这条记录不是这个格式写的（或被改过），此时拿父会话的 provider 去补
 * 等于猜出一个新身份——正是 pin 要防的事。宁可大声失败。
 */
function parsePinnedModel(pinnedModel: string): ModelSelection {
  const parsed = parseProviderQualifiedModelSelection(pinnedModel);
  if (parsed === undefined) throw new WorkflowActorPinnedModelError(pinnedModel);
  return parsed;
}
