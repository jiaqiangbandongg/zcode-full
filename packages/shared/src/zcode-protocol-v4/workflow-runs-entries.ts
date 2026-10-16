// ============================================================
// 出生事实的读法：脚本作者写的那些字符串怎么按线上界落成一个 actor 条目
// ============================================================
// 从 workflow-runs-reducer.ts 拆出（主文件的 max-lines 门），与 -caps.ts / -eviction.ts /
// -started.ts 同一条先例，也同一条纪律：纯函数、无时钟、无 I/O。
//
// 这几个界不是展示预算而是**安全界**。名字与阶段名都是脚本作者任意拼出来的
// （`agent("reader-" + paths.join("+"))`、`phase("检查 " + file)`），而 CLI 不校验出站帧、
// 渲染端对每一帧做严格校验——2026-09-04 一个 131 字的子代理名让父会话在那个 actor 出现之后的
// 每一帧（online / recovery / initial 快照）全部被拒，订阅以 `fault.subscription.recoveryFailed`
// 永久失效。所以生产者按 schema 界裁剪，线上永远合法；完整值仍在 journal 里。

import { WORKFLOW_RUNS_LIMITS, type WorkflowRunActor } from "./workflow-runs.js";

/**
 * 一个 actor 条目的铸造。两处调用必须**逐字同形**：`actor-created`，以及带出生事实的
 * `node-dispatched`（workflow-runs-eviction.ts 的 activation）——同一个子代理按到达路径长出
 * 两种条目，就是两条会在冷回放里对不上的记录。
 *
 * `status` 落的是占位值：紧接着的 `withDerivedWorkflowActorStatuses` 会按节点与 run 终态重算。
 */
export function workflowActorEntry(
  ref: { siteId: string; ordinal: number },
  name: unknown,
  phaseName: string | undefined,
  sessionId: string | undefined,
  model: unknown,
): WorkflowRunActor {
  const bounded = boundedActorName(nonEmptyString(name));
  const canonical = boundedActorModel(nonEmptyString(model));
  return {
    siteId: ref.siteId,
    ordinal: ref.ordinal,
    ...(bounded === undefined ? {} : { name: bounded }),
    ...(sessionId ? { sessionId } : {}),
    ...(phaseName === undefined ? {} : { phaseName }),
    ...(canonical === undefined ? {} : { model: canonical }),
    status: "waiting",
  };
}

/**
 * 子代理模型的线上界：超界**整个丢掉**而不截断——截断的规范串是另一个（不存在的）模型，
 * 画出来就是一句假话；缺席只是退回「跑在 run 的子代理模型上」那一格。
 */
function boundedActorModel(model: string | undefined): string | undefined {
  return model === undefined || model.length > WORKFLOW_RUNS_LIMITS.maxSubagentModelLength
    ? undefined
    : model;
}

/** 子代理展示名的线上界（见文件头那次订阅失效）。 */
export function boundedActorName(name: string | undefined): string | undefined {
  return name === undefined ? undefined : name.slice(0, WORKFLOW_RUNS_LIMITS.maxActorNameLength);
}

/**
 * 实例出生阶段名的线上界（docs/dynamic-workflow/presentation.md）。与 {@link boundedActorName}
 * 同族、同理由，但**直接截断、不加省略号**——这个字段不是给人读的文本而是一个关联键，
 * UI 的 `phaseNameMatches` 正是按前缀把截断的名字关联回 display 阶段。
 */
export function boundedPhaseName(name: string | undefined): string | undefined {
  return name === undefined ? undefined : name.slice(0, WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
}

/**
 * 会话 id 的线上读法：界内的非空串原样收下，其余一律当缺席。**不截断**——与子代理模型串同理，
 * 一个被砍短的 id 指向的是另一条会话，宁可不认。
 */
export function boundedSessionId(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  return text !== undefined && text.length <= WORKFLOW_RUNS_LIMITS.maxSessionIdLength
    ? text
    : undefined;
}

/** 空串按缺席处理：协议线上只有「键在场」与「键缺席」两态。 */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 引擎的 `InstanceRef` / `ActorRef` 同构：站点 id × 序号。缺任一即无法定位，返回 null。 */
export function workflowInstanceRef(value: unknown): { siteId: string; ordinal: number } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const siteId = nonEmptyString(record.siteId);
  const ordinal = record.ordinal;
  if (siteId === undefined || typeof ordinal !== "number") return null;
  return { siteId, ordinal };
}
