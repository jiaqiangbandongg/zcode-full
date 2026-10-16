/* off-peak（闲时任务）排队协议的适配层特判。
   语义只对 Model Config 显式声明 off-peak-queue 协议的请求生效——业务码 3105/3102
   在其它 bigmodel API 可能另有含义，禁止写进全局 failure-provider-business-codes 映射表。

   - 429（含业务码 3105）= 排队应答：单次等待 min(Retry-After, 5min) 钳制 × 无限幂等探测；
     调用方冻结 attempt 预算（否则默认 11 次后被误判为 API 失败，D24 规则 2）；abort 贯穿 sleep。
   - 400/3102 = 票据不可用（active 3h 到期 / ready 废票）：立即以稳定标记落败，
     desktop 端识别标记改走"同 task_id 重取号 → resume 续跑"（§4.6），不是普通失败。
   - D24 规则 1（首派弃派）不在适配层实现：首派挂网关时 ready 5min TTL 到期自然触发
     3102 → 续跑回队，等待上界 ≈ TTL + 一次钳制探测 ≤ 10min，满足规则意图且少一套状态
     （该简化已回写 tech-design §4.3）。 */
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { isProviderBusinessError } from "./model-execution.js";

/**
 * ⚠ 与 desktop 侧 @zcode/shared/src/off-peak-types.ts 的同名常量跨包同值（wire 契约）：
 * providerId 随 per-turn runtimeModel 注入，错误标记随 task 终态错误文本回传，改动须两侧同步。
 */
export const OFF_PEAK_TICKET_EXPIRED_MARKER = "off-peak-ticket-expired";

/** 单次排队等待钳制（D24 规则 2）：min(Retry-After, 5min)；无 Retry-After 时保守 60s 探测。 */
export const OFF_PEAK_QUEUE_WAIT_CAP_MS = 5 * 60_000;
export const OFF_PEAK_QUEUE_WAIT_DEFAULT_MS = 60_000;

export type OffPeakFailureDecision =
  | { kind: "queued"; delayMs: number }
  | { kind: "ticketExpired" };

/**
 * 判定 off-peak 特有失败语义；非 idle plan provider 一律返回 null（零影响）。
 * error 需传 unwrapRetryError 之后的原始错误（ProviderBusinessError 才能读到业务码）。
 */
export function resolveOffPeakFailureDecision(params: {
  offPeak: boolean;
  failure: ClassifiedModelFailure;
  error: unknown;
}): OffPeakFailureDecision | null {
  if (!params.offPeak) return null;
  const businessCode = isProviderBusinessError(params.error)
    ? params.error.providerCode
    : undefined;
  // 服务端最新契约使用 3102；保留 3001 兼容滚动发布期间的旧网关响应。
  if (businessCode === "3102" || businessCode === "3001") {
    return { kind: "ticketExpired" };
  }
  // 排队真实信号 = HTTP 429（3105 带 Retry-After）；无业务码的裸 429 同样按排队处理。
  if (businessCode === "3105" || params.failure.statusCode === 429) {
    return {
      kind: "queued",
      delayMs: Math.min(
        params.failure.retryAfterMs ?? OFF_PEAK_QUEUE_WAIT_DEFAULT_MS,
        OFF_PEAK_QUEUE_WAIT_CAP_MS,
      ),
    };
  }
  return null;
}

export function offPeakTicketExpiredMessage(original: string): string {
  return `${OFF_PEAK_TICKET_EXPIRED_MARKER}: ${original}`;
}
