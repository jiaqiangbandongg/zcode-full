// ============================================================
// RunEvent → 会话事件载荷（有界化 + 派生字段）
// ============================================================
// 从 dynamic-workflow-run-launch.ts 拆出（max-lines 门）：启动体发事件、冷回放铸载荷，两条路都经
// 这里的同一个函数，两侧载荷因此逐字节相等（apps/zcode-cli/packages/dynamic-workflow/docs/
// execution-engine.md「Events」）。纯函数：不碰 journal、不碰 runtime。

import {
  boundDynamicWorkflowRunEventPayload,
  type DynamicWorkflowRunEvent,
  type DynamicWorkflowRunProgressPayload,
} from "@zcode/contracts";
import type { ActorRef, RunEvent } from "@zcode/dynamic-workflow";
import { isResumableSettlement } from "./dynamic-workflow-run-observation.js";
import { mintActorSessionId } from "./workflow-driver.js";

/**
 * RunEvent → 协议事件的映射（**本注释即契约**）：`type` 取事件的判别式，`payload` 是同一个
 * 事件对象去掉 `type` 后的其余字段，经 {@link boundDynamicWorkflowRunEventPayload} 有界化。
 * 刻意不重塑字段名——读端（详情页事件日志）按事件种类解释 payload，而引擎的词汇表就是那份 schema。
 *
 * 引擎实际发出的种类：run-started / actor-created / node-queued / node-dispatched /
 * node-repairing / node-nudged / node-settled / usage-updated / log / report / phase-entered /
 * run-settled。
 * （`executing` 不是可观察事件；`compaction` v1 从不发出。）另有两种由 **driver** 发出、
 * 走同样两条轨的事件：escalation-raised / escalation-resolved（workflow-driver.ts 的升级桥接）。
 *
 * 新增一个事件种类在**本函数**里是零改动的，这正是"不重塑字段名"买到的东西：`type` 取判别式、
 * payload 是其余字段，这里没有按种类的分支可漏。**但下游确实有一个按种类的 switch**：
 * `zcode-protocol-v4/product-projection.ts` 的 `applyWorkflowRunEvent` 逐种类归约，其
 * `eventType` 形参是 `string` 而不是 `RunEvent["type"]`，漏一支 tsc 不会报——加事件种类时
 * 要去读那个 switch，不能指望编译器。
 */
export function toProtocolEvent(sequence: number, event: RunEvent): DynamicWorkflowRunEvent {
  const { type, ...rest } = event;
  const { payload, truncated } = boundDynamicWorkflowRunEventPayload(
    rest as Record<string, unknown>,
  );
  return { sequence, type, payload, ...(truncated ? { truncated } : {}) };
}

/**
 * RunEvent → 会话事件载荷。`payload` 与 {@link toProtocolEvent} 使用同一次序列化，
 * 派生字段放在 payload 之外，保留引擎事件原文。
 *
 * 派生字段放在 payload **之外**是有意的：payload 必须保持"引擎发了什么"的原样，否则事件日志
 * 就在展示我们的加工品。两个字段各自都不是可观察事实，但缺了它们下游只能自己重造一份契约：
 *
 *   - `actorSessionId`：Boundary C 的事件不带会话 id（它由 driver 铸造）。让
 *     renderer 按 (runId, actorRef) 自己拼，等于把 sanitize 契约复制进 UI 层；这里调用
 *     铸造它的**同一个函数**，两边不可能漂移（测试钉住相等）。**凡是点名子代理的事件都补**
 *     （见 {@link actorSessionRefOf}）：actor-created，以及重复出生事实的 ask `node-dispatched`
 *     与缓存命中的 ask `node-settled`——读面据派发把一个正在跑的实例连同它的子代理收进有界的
 *     表，据这两条把子代理的 sessionId 指回本 run 的会话，那个 id 只能从这里来。
 *   （曾经还有第二个派生字段 `spentTokens`：老的 budget-updated 只发剩余量。现在 usage-updated
 *   自己携带已花总量，与 dwf_run.spent_tokens 在同一同步步骤产生，不再需要派生。）
 */
export function toProgressPayload(input: {
  event: RunEvent;
  runId: string;
  sequence: number;
  toolCallId?: string;
  /** run 的锚点 inputId；只在 actor-created / run-settled 上派生（子代理归属的两个时刻）。 */
  launchInputId?: string;
  /** 修订 run 的前驱；只在 `run-started` 上派生（卡片的「调整自 run X」）。 */
  resumedFrom?: string;
  /**
   * 铸造这条载荷那一刻的进程默认并发 D（键名早于「默认并发」这个概念，为兼容旧端保留）；在
   * `run-started` 与 `run-caps-changed` 两种事件上派生（docs/dynamic-workflow/concurrency.md
   * 「Two bounds on a run」）。
   *
   * 引擎事件只带它自己的 `caps.maxConcurrency`，而「这个数值不值得显示」要拿它和默认值比——
   * 默认值是宿主事实（机器核数），引擎既看不见也不该看见。投影侧据 `caps.maxConcurrency !==
   * concurrencyCeiling` 记下本 run 的自有上界（高于低于都算），UI 的并发 chip 再取
   * min(共享 cap, 本 run 上界)。
   *
   * 一次就地 retune 发的 `run-caps-changed` 带着**新的** caps，判据却是同一条：不等于默认就写下
   * 上界、等于默认就把它清掉（= 解除本 run 自己的界）。所以两种事件必须拿到同一个默认值，也就是这一个。
   */
  concurrencyCeiling?: number;
  /**
   * 本 run 的子代理模型（规范 picker 串）；只在 `run-started` 上派生，且**只在设过时**在场。
   * 与 `concurrencyCeiling` 不同，它不需要与任何默认值比对：
   * 引擎压根不知道有这件事（模型面整个在宿主侧），所以缺席即「子代理跑在会话模型上」。
   * 冷回放从同一条 `run-launched` 事件给出同一个键，两侧载荷因此逐字节相等。
   */
  subagentModel?: string;
  /**
   * 本 run 脚本点名的模型绑定表（名字 → 规范串）；只在 `actor-created`（派生 `model`）与 ask
   * `node-dispatched`（派生 `actorModel`）上用：persona 点名了模型时给出该子代理的规范串
   * （docs/dynamic-workflow/presentation.md「Reduction」）。与
   * `subagentModel` 同理：引擎只记名字、不知道它解析成什么，映射是宿主事实。
   */
  modelBindings?: Record<string, string>;
  /**
   * 留白的类型实参原文（站点 id → `Verdict`）；只在 `hole-reached` 上派生 `type`
   * （docs/execution-engine.md「Holes」）。引擎事件不带它——类型是编译期事实，引擎只认站点 id；
   * 读面（通知发射器、时间线的类型徽章）要在到达那一刻就念出它。查不到即不补，UI 退回展示
   * 载荷的 `holes[].type`。
   */
  holeTypeOf?: (siteId: string) => string | undefined;
  /**
   * 这条事件落库时盖的戳（epoch 毫秒）；只在 `hole-reached` 上派生 `reachedAt`。live 侧从
   * sequence 截取层读回刚 append 的那条的 `timeCreated`，冷回放直接是 `StoredEvent.timeCreated`
   * ——两侧同一个数，载荷因此逐字节相等。缺席（老 journal 没有这一列）即不补。
   */
  reachedAt?: number;
}): DynamicWorkflowRunProgressPayload {
  const {
    event,
    runId,
    sequence,
    toolCallId,
    launchInputId,
    resumedFrom,
    concurrencyCeiling,
    subagentModel,
    modelBindings,
    holeTypeOf,
    reachedAt,
  } = input;
  const protocolEvent = toProtocolEvent(sequence, event);
  const actorRef = actorSessionRefOf(event);
  return {
    runId,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    sequence,
    eventType: protocolEvent.type,
    // `run-settled` 多带一位 `resumable`：
    // resume 门的谓词只在 CLI 有，投影与 UI 只搬运这一位、绝不自行按 status 推导。
    // 谓词 = stopped ∧ 非 superseded；冷回放对孤儿收敛过的
    // 行给同一个键——两条链、一个谓词（isResumableSettlement）。stopReason / supersededBy 随事件载荷原样透出。
    // `run-started` 多带 `resumedFrom`：引擎事件不带它（引擎不读 lineage），但卡片要画这条边。
    // 同一条缝里还多带 `concurrencyCeiling`（= 默认并发）：引擎只发自己的 caps，而「这个上界是不是
    // 默认值」要拿它和宿主的默认值比（见上面的字段注释）。两者互不相关，各自缺席即各自不出。
    // `run-caps-changed` 走**同一条**缝、同一个默认值：一次就地 retune 之后读面要靠它判断新上界
    // 该写下还是该清掉，缺了它这条事件就只是两个没有标尺的数。
    payload:
      event.type === "run-settled" && isResumableSettlement(event.status, event.stopReason)
        ? { ...protocolEvent.payload, resumable: true }
        : event.type === "run-started"
          ? {
              ...protocolEvent.payload,
              ...(resumedFrom === undefined ? {} : { resumedFrom }),
              ...(concurrencyCeiling === undefined ? {} : { concurrencyCeiling }),
              ...(subagentModel === undefined ? {} : { subagentModel }),
            }
          : event.type === "run-caps-changed"
            ? {
                ...protocolEvent.payload,
                ...(concurrencyCeiling === undefined ? {} : { concurrencyCeiling }),
              }
            : event.type === "actor-created"
              ? withActorModel(protocolEvent.payload, "model", event.persona?.model, modelBindings)
              : event.type === "node-dispatched"
                ? withActorModel(
                    protocolEvent.payload,
                    "actorModel",
                    event.actorPersonaModel,
                    modelBindings,
                  )
                : event.type === "hole-reached"
                  ? withHoleFacts(
                      protocolEvent.payload,
                      holeTypeOf?.(event.instance.siteId),
                      reachedAt,
                    )
                  : protocolEvent.payload,
    ...(protocolEvent.truncated ? { truncated: true } : {}),
    ...(actorRef === undefined ? {} : { actorSessionId: mintActorSessionId(runId, actorRef) }),
    // 第三个派生字段（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Token telemetry for subagents」）：埋点事实层只在这两种事件上
    // 需要锚点——actor-created 登记子代理归属，run-settled 结算该 run 全部子代理。
    ...((event.type === "actor-created" || event.type === "run-settled") &&
    launchInputId !== undefined
      ? { launchInputId }
      : {}),
  };
}

/**
 * 载荷补上子代理的规范模型串：`actor-created` 写 `model`，重复出生事实的 ask `node-dispatched` 写
 * `actorModel`（读面据它把派发时收回表的子代理连模型一起建出来）。persona 点名了模型、且本 run 的
 * 绑定表认得它时才在场；查不到（只有绕过 9010 的断言做得到）就不补——建会话那一步会以 DriverError
 * 说清楚，这里不替它猜。
 */
function withActorModel(
  payload: Record<string, unknown>,
  key: "model" | "actorModel",
  personaModel: string | undefined,
  modelBindings: Record<string, string> | undefined,
): Record<string, unknown> {
  const model = personaModel === undefined ? undefined : modelBindings?.[personaModel];
  return model === undefined ? payload : { ...payload, [key]: model };
}

/**
 * `hole-reached` 载荷补上两个宿主派生字段（docs/execution-engine.md「Holes」；键名由 shared 的
 * v4 reducer 钉死）：`type` 是留白的类型实参原文，`reachedAt` 是到达时刻。各自缺席即各自不出。
 */
function withHoleFacts(
  payload: Record<string, unknown>,
  type: string | undefined,
  reachedAt: number | undefined,
): Record<string, unknown> {
  return {
    ...payload,
    ...(type === undefined ? {} : { type }),
    ...(reachedAt === undefined ? {} : { reachedAt }),
  };
}

/**
 * 这条事件点名了哪个子代理（要补 `actorSessionId` 的那个 ref），没点名即 undefined。
 *
 * 三种事件：`actor-created`（子代理的出生），以及两条重复出生事实、因而带 `actor` 的 ask 事件
 * （apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Events」）——派发，和
 * 缓存命中的结算。后者的答案若读自前驱，载荷自带 `sourceSessionId`，读面优先用它；这里补的是
 * 本 run 的那条，答案在本 run 里产生过时读面就指向它（docs/dynamic-workflow/presentation.md
 * 「Reduction」）。world-read 的派发与结算不带 `actor`，因此不补——它们没有转录可开；live 的
 * 结算不是出生事件、不带 `actor`，同样不补。
 */
function actorSessionRefOf(event: RunEvent): ActorRef | undefined {
  if (event.type === "actor-created") return event.actor;
  if (event.type === "node-dispatched") return event.actor;
  if (event.type === "node-settled" && event.cached === true) return event.actor;
  return undefined;
}
