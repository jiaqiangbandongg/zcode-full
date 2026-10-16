/**
 * 预制故障程序（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Verification」）。
 *
 * 全是纯函数：只看到达序号、在飞数、对话进度，不引入随机。矩阵行名（B1–B17）与这里的
 * 程序一一对应；翻转类行为（B15/B16）不在这里——测试直接 `server.setProgram(healthy())`。
 */

import type { FaultProgram, Verdict } from "./fake-provider-server.js";

/** 带状态码的判决；预制常量都用它标注，好让 `{ ...BUSY_3008, code }` 这类改写保持类型收窄。 */
export type StatusVerdict = Extract<Verdict, { kind: "status" }>;

/** 429 上的 Retry-After 缺省钉成 20ms：runner 会优先采用「合理」的 retry-after-ms，把限流等待变成已知小数。 */
const DEFAULT_RETRY_AFTER_MS = 20;

export const SERVE: Verdict = { kind: "serve" };

/** Start Plan 用户级并发上限：在 workflow 内是重试，不是终止。 */
export const BUSY_3008: StatusVerdict = {
  kind: "status",
  status: 429,
  code: "3008",
  message: "user concurrency limit exceeded",
  headers: { "retry-after-ms": String(DEFAULT_RETRY_AFTER_MS) },
};

/** Stop 集：认证失效。 */
export const AUTH_401: StatusVerdict = {
  kind: "status",
  status: 401,
  code: "1006",
  message: "token expired",
};

/** Stop 集：五小时用量上限，带 120s 的 Retry-After（通知里的 resetAt 由它算）。 */
export const QUOTA_1308: StatusVerdict = {
  kind: "status",
  status: 429,
  code: "1308",
  message: "usage cap reached for the current 5-hour window",
  headers: { "retry-after": "120" },
};

/** Stop 集：模型不在套餐里。 */
export const MODEL_NOT_FOUND_3006: StatusVerdict = {
  kind: "status",
  status: 404,
  code: "3006",
  message: "model not available in current plan",
};

/** Stop 集：请求本身不合法。 */
export const INVALID_REQUEST_3001: StatusVerdict = {
  kind: "status",
  status: 400,
  code: "3001",
  message: "invalid request parameters",
};

/** 分类器判不可重试的未知业务码：策略表决策 10——不在 Stop 集就在内重试。 */
export const UNKNOWN_1314: StatusVerdict = {
  kind: "status",
  status: 429,
  code: "1314",
  message: "unknown business condition",
  headers: { "retry-after-ms": String(DEFAULT_RETRY_AFTER_MS) },
};

/** B1：一律放行。 */
export function healthy(): FaultProgram {
  return () => SERVE;
}

/** 并发闸门放行的请求在服务器里停留的时长：罐头应答本身是瞬时的，不停留就永远没有重叠。 */
const DEFAULT_GATE_HOLD_MS = 30;

/**
 * B2：在飞数（不含自己）达到 limit 就拒绝——真实并发上限的语义。放行的请求先停留 holdMs
 * 再应答（在飞数从到达起算），否则瞬时应答让并发子代理之间几乎不重叠、闸门形同虚设。
 */
export function gate(
  limit: number,
  options: { code?: string; holdMs?: number } = {},
): FaultProgram {
  const verdict: StatusVerdict = { ...BUSY_3008, code: options.code ?? "3008" };
  const served: Verdict = { kind: "delay", ms: options.holdMs ?? DEFAULT_GATE_HOLD_MS, next: SERVE };
  return (request) => (request.inFlight >= limit ? verdict : served);
}

/** B3/B4/B14：前 n 个到达的请求回该状态码，之后放行。 */
export function failFirst(
  n: number,
  status: number,
  options: { code?: string; message?: string; retryAfterMs?: number } = {},
): FaultProgram {
  const retryAfterMs = options.retryAfterMs ?? (status === 429 ? DEFAULT_RETRY_AFTER_MS : undefined);
  const verdict: Verdict = {
    kind: "status",
    status,
    ...(options.code === undefined ? {} : { code: options.code }),
    ...(options.message === undefined ? {} : { message: options.message }),
    ...(retryAfterMs === undefined ? {} : { headers: { "retry-after-ms": String(retryAfterMs) } }),
  };
  return (request) => (request.ordinal <= n ? verdict : SERVE);
}

/** B5–B9：序号能被 k 整除的请求吃这个判决。 */
export function everyKth(k: number, verdict: Verdict): FaultProgram {
  return (request) => (request.ordinal % k === 0 ? verdict : SERVE);
}

/** B8b：前 n 个流式请求都在可见输出之后切断，之后放行。 */
export function cutVisibleUntil(n: number): FaultProgram {
  const verdict: Verdict = { kind: "cut", after: "visible" };
  return (request) => (request.ordinal <= n && request.stream ? verdict : SERVE);
}

/** B10–B13 / B16 / B17：每个请求都吃同一个判决。 */
export function always(verdict: Verdict): FaultProgram {
  return () => verdict;
}
