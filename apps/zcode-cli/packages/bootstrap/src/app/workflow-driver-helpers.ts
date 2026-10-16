// ============================================================
// AgentRuntime-backed WorkflowDriver：纯辅助
// ============================================================
// workflow-driver.ts 顶到 oxlint max-lines 上限（400 行），把不碰 driver 状态的纯函数与
// 常量（deferred、actor 会话 id 铸造、升级预算与 qid 片段、nudge / schema 尾注、裁决与统计的
// 映射、turn 失败归一）拆到本文件；公开面（mintActorSessionId）仍从 workflow-driver.ts 导出。

import {
  CoreErrorType,
  createSessionId,
  type SessionId,
  type SubmitVerdict as ContractsSubmitVerdict,
  type SubmitViolation,
} from "@zcode/contracts";
import type { TurnResult } from "@zcode/core";
import {
  refToString,
  WorkflowError,
  type ActorRef,
  type AskStats,
  type InstanceRef,
  type PersonaSpec,
  type Violation,
  type WorkflowReportSink,
} from "@zcode/dynamic-workflow";
import type { ActorToolCounts } from "./workflow-driver-tool-activity.js";
import type { Deferred, SessionState } from "./workflow-driver-types.js";

export function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * actor 会话 id：run 作用域 + 字符集安全。
 *
 * 旧方案 `createSessionId("wf-actor-" + refToString(actor))` 有两个缺陷：不含 runId，所以
 * 并发两个 run 的同 site×ordinal actor 撞成同一个 id；且带 `#`/`@`（refToString 的形态是
 * `actor#1@1`），而会话 id 会进 URL、文件路径与日志。
 */
/**
 * actor 会话 id：run 作用域且字符集安全。
 *
 * **导出是有意的**：进度投影要在 `actor-created` 事件上带出会话 id（Boundary C 不带它），
 * 而"按 (runId, actorRef) 算会话 id"必须只有一个实现——两处各算一次，就会有一天不相等，
 * 表现是详情页打开一个不存在的会话。run service 调用的就是这个函数（测试钉住两边相等）。
 */
export function mintActorSessionId(runId: string, actor: ActorRef): SessionId {
  return createSessionId(
    `dwf-${sanitizeIdSegment(runId)}-${sanitizeIdSegment(refToString(actor))}`,
  );
}

/**
 * 把任意串折叠进 `[A-Za-z0-9.\-_]`，其中 `_` 只作为转义输出出现。
 *
 * **两步，顺序是契约**：先把字面 `_` 转义成 `__`，再把 `[A-Za-z0-9.-]` 之外的字符映射成单个 `_`。
 * 顺序反了转义就失效（第二步产出的 `_` 会被第一步再翻一遍）。第一步产出的 `_` 落到第二步的
 * 映射上是恒等的，所以两步可以安全串联。
 *
 * 为什么要转义那一步：没有它，`my_actor#1` 与 `my#actor#1` 都折叠成 `my_actor_1`——一次真实碰撞。
 * 单纯的白名单只在「站点 id 词汇表里没有 `_`」这个前提下无碰撞，而那个词汇表由分析器拥有、
 * 不由本文件拥有。转义把「靠别人的词汇表保持某种形状」换成了本地可证的性质。
 *
 * 残留的（更小的）假设：两个**不同**的特殊字符仍都映射成 `_`，所以假想的 `a#b` 与 `a@b` 会撞。
 * 今天与可预见的站点 id 里，特殊字符出现在固定位置（`actor#N@M`、站点特化的 `kind#N/M`），
 * 不存在这种同形异构对；真要消除，就得给每个特殊字符一个独立编码。
 */
function sanitizeIdSegment(value: string): string {
  return value.replace(/_/g, "__").replace(/[^A-Za-z0-9.-]/g, "_");
}

/**
 * 一次 ask 内的升级次数上限（与 nudge 预算同族）。
 *
 * 上限之外**不是错误而是一条纪律**：第 4 次调用拿到「自行以最佳判断推进」的普通结果。
 * 升级不写 dwf_node 行（等待不是工作量），所以这个计数是唯一的界。
 */
export const MAX_ESCALATIONS_PER_ASK = 3;

/** 预算耗尽时回给模型的工具结果文案（普通结果，不是错误）。 */
export const ESCALATION_BUDGET_EXHAUSTED =
  `Escalation budget exhausted: at most ${MAX_ESCALATIONS_PER_ASK} escalations per task. ` +
  "Do not call escalate again. Proceed on your best judgement with the information you have, " +
  "and state in your final result the assumptions you relied on and the doubts that remain.";

/** actor 会话 id 片段之外，qid 片段的候选序列（由短到长，最后一个是完整 runId）。 */
export function questionIdFragments(runId: string): string[] {
  // `dwfrun-` 前缀对每个 run 都一样，留着只会把 qid 变长而不增加辨识度。
  const body = runId.startsWith("dwfrun-") ? runId.slice("dwfrun-".length) : runId;
  const full = sanitizeIdSegment(body);
  const candidates = [full.slice(0, 8), full.slice(0, 16), full];
  // 短 runId 上三个候选会退化成同一个串；去重只为不做无谓的重复查表。
  return [...new Set(candidates)];
}

/**
 * actor 的**有效名**：直接取 `persona.name`，缺席或空串即匿名。
 *
 * 不需要在这里重跑规范化——driver 收到的 persona 已经是引擎 `normalizePersona` 的产物
 * （scheduler 把 `actor.persona` 原样递进 `createActorSession`），所以 `spec.name` 就是
 * 引擎认定的那一个有效名：`actor-created` 事件上的名字、amend-resume 的缓存身份键、
 * DuplicateActorName 查重的键，全都是它。
 *
 * **刻意不 trim**，与 {@link normalizeEscalationContext} 相反：引擎的匿名判据是
 * `name !== undefined && name !== ""`（engine.ts 的 createActor），一个叫 `"  "` 的 actor
 * 对引擎是**具名的**、占着缓存身份键。这里若 trim 成匿名，同一个 actor 就会在「有没有名字」
 * 这件事上给出两个答案——而那正是升级记录要拿来标识提问者的东西。跟着引擎走。
 */
export function effectiveActorName(persona: PersonaSpec): string | undefined {
  const name = persona.name;
  return name === undefined || name === "" ? undefined : name;
}

/** `escalate` 的可选 context：空白等同缺席（模型常传空串，落进事件里只是噪音）。 */
export function normalizeEscalationContext(context: string | undefined): string | undefined {
  const trimmed = context?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/** turn 结束未提交时促模型提交的 nudge 提示。 */
export const NUDGE_PROMPT =
  "You ended your turn without submitting a result. Call the submit_result tool now with a payload conforming to the required schema.";

/**
 * typed ask 的 schema 尾注：追加到指令正文，告诉模型用 submit_result 提交符合 schema 的结果。
 * 格式（本注释即契约）：分隔线 + 一句话要求调用工具 + 缩进 2 空格的 JSON Schema + 一句 result 约束。
 * 措辞不含「exactly once」——修复回合里模型会合法地多次调用 submit_result。
 */
export function schemaEpilogue(schema: unknown): string {
  const rendered = schema === undefined ? "(any JSON value)" : JSON.stringify(schema, null, 2);
  return [
    "",
    "",
    "---",
    "When you have finished, call the `submit_result` tool to submit your final result. Its `result` argument must be a JSON value conforming to this JSON Schema:",
    "",
    rendered,
    "",
    "Pass the conforming JSON as the `result` argument — do not wrap it or add commentary.",
  ].join("\n");
}

/**
 * mono 子代理的 typed ask 尾注：schema 已在工具声明里，这里只剩一句「做完就调工具」。与 {@link schemaEpilogue}
 * 同一格式骨架（两个空行 + 分隔线），GUI 的尾注折叠按边界索引而不是文本，不受影响。
 */
export const TYPED_TOOL_EPILOGUE = [
  "",
  "",
  "---",
  "When you have finished, call the `submit_result` tool to submit your final result. Its `result` argument must match the tool's declared schema — pass the conforming JSON directly, do not wrap it or add commentary.",
].join("\n");

/** 引擎 Violation → contracts SubmitViolation（结构同构，1:1）。 */
export function mapViolations(violations: readonly Violation[]): SubmitViolation[] {
  return violations.map((v) => ({ path: v.path, expected: v.expected, got: v.got }));
}

/** 合成一条二值 rejection（driver 本地拦截用，不经引擎）。 */
export function rejectWith(message: string): ContractsSubmitVerdict {
  return {
    accept: false,
    violations: [{ path: "$", expected: message, got: "submit_result call" }],
  };
}

/**
 * 从 TurnResult + 工具活动面的观察提炼 AskStats。tokens 是引擎唯一强依赖字段（扣预算）；turns 与两个
 * 工具计数供 journal 记录，其中 `toolCalls === 0` 让这条 ask 成为导入缓存关门后仍可命中的**纯** ask，`worldToolCalls`
 * 是「它看过或动过外部世界」的记账——协议工具（`submit_result` / `escalate`）不计入，否则每条 typed ask
 * 都会因为交结果而不再是纯的。
 *
 * 计数曾从 `result.events` 里数 `ToolCallStarted`，而 TurnResult 的事件数组
 * 不含工具事件——生产 journal 的 2097 条 ask 行 `toolCalls` 全是 0，包括明明写过文件的子代理。若纯 ask
 * 的判定压在这个 0 上，关门之后每条缓存条目都会被当成纯的照常命中，恰好放掉关门要防的那一类。计数因此
 * 改由 driver 的工具活动面从**会话事件流**数（那里是工具调用真正现身的地方），按 ask 累加后传进来。
 */
export function statsFromTurn(result: TurnResult, toolCounts: ActorToolCounts): AskStats {
  const usage = result.usage;
  return {
    tokens: usage?.totalTokens ?? 0,
    toolCalls: toolCounts.toolCalls,
    turns: usage?.modelRequestCount ?? 1,
    worldToolCalls: toolCounts.worldToolCalls,
  };
}

/** 判断 executeTurn 的 reject 是否为「用户/引擎取消」（正常结束，不算 driver 失败）。 */
export function isTurnCancelled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { type?: unknown }).type === CoreErrorType.TurnCancelled
  );
}

/** 把任意（非模型层的）turn 失败归一成 node 级 WorkflowError（DriverError），保留原始 cause。 */
export function toWorkflowError(error: unknown): WorkflowError {
  if (error instanceof WorkflowError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new WorkflowError("DriverError", `Subagent turn failed: ${message}`, { cause: error });
}

// ——————————— 模型侧失败的收容：常量与纯辅助 ———————————

/** ProviderStop 明细里 provider 原文的上界（通知与 journal 都带它，不能无界）。 */
export const PROVIDER_STOP_RAW_MESSAGE_MAX_CHARS = 2000;

/** 瞬态重驱的续跑提示（与 nudge 同一机制：同一持久 runtime 上的一轮新 turn）。 */
export const TRANSIENT_CONTINUE_PROMPT =
  "The previous model request failed transiently and was abandoned; continue from where you left off.";

const TRANSIENT_BACKOFF_BASE_MS = 2_000;
const TRANSIENT_BACKOFF_MAX_MS = 60_000;

/** runner 同一条曲线：2s 起翻倍到 60s 封顶，乘 [0.5, 1] 的抖动。 */
export function transientBackoffMs(attempt: number, random: () => number = Math.random): number {
  const raw = Math.min(TRANSIENT_BACKOFF_MAX_MS, TRANSIENT_BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.round(raw * (0.5 + 0.5 * random()));
}

/** adapter 错误上的 Retry-After（`context.retryAfterMs`，一层 cause 之内），按形状读。 */
export function readRetryAfterMs(error: unknown): number | undefined {
  for (const candidate of [error, (error as { cause?: unknown } | undefined)?.cause]) {
    const context = (candidate as { context?: { retryAfterMs?: unknown } } | undefined)?.context;
    const value = context?.retryAfterMs;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/** 通知文案里子代理的称呼：有名字用名字，否则 `site@ordinal`。 */
export function subagentLabel(state: Pick<SessionState, "actor" | "actorName">): string {
  return state.actorName ?? refToString(state.actor);
}

export const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};

/**
 * 一次 turn 解析向引擎回报的两条事实，顺序是载荷性的：
 *   1. `askProgress` → `node-progress`：这个 ask 跑到第几轮、用了几次工具、最近在动哪儿；
 *   2. `askStats` → `usage-updated`：这一轮花了多少 token（无论 accept / text / nudge 都报一次）。
 * 进度在前，于是读到新用量的人一定已经读到了挣来它的那次进度。两条合在一个函数里，正是为了
 * 让这个顺序有一个能被指着看的地方，而不是散在调用点的两行。
 */
export function reportTurnObservations(
  sink: WorkflowReportSink,
  state: SessionState,
  instance: InstanceRef,
  result: TurnResult,
): void {
  sink.askProgress(instance, state.modelActivity.noteTurnResolved());
  sink.askStats(instance, statsFromTurn(result, state.modelActivity.toolCounts()));
}
