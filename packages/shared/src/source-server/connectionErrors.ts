import { sanitizeRemoteConnectionLog } from "./connectionLog.js";
import { isPublicZCodeErrorCode, type PublicZCodeErrorCode } from "./errorCodes.js";

export interface RemoteConnectionFailure {
  code: PublicZCodeErrorCode;
  message: string;
  retryable?: boolean;
}

const systemCodes: Record<string, PublicZCodeErrorCode> = {
  ECONNREFUSED: "remote-host-unreachable",
  EHOSTUNREACH: "remote-host-unreachable",
  ENETUNREACH: "remote-host-unreachable",
  // Bug 原因：在线断连后的自动恢复经懒连接 probe 抛出 ECONNRESET；码表缺它时被
  // probe 的阶段兜底改写成 remote-preflight-failed，UI 误报“设备环境不满足安装要求”。
  ECONNRESET: "remote-host-unreachable",
  ETIMEDOUT: "remote-connection-timeout",
  ENOTFOUND: "remote-host-not-found",
  EAI_AGAIN: "remote-host-not-found",
  ENOSPC: "remote-space-insufficient",
  EACCES: "remote-permission-denied",
  EPERM: "remote-permission-denied",
  ABORT_ERR: "remote-connection-canceled",
  ERR_SSH_HOST_KEY_MISMATCH: "remote-host-key-changed",
};
const phaseCodes: Record<string, PublicZCodeErrorCode> = {
  download: "remote-download-failed",
  upload: "remote-upload-failed",
  preflight: "remote-preflight-failed",
  extract: "remote-install-failed",
  "verify-archive": "remote-install-failed",
  verify: "remote-install-failed",
  restart: "remote-install-failed",
  install: "remote-install-failed",
};

/** 空 AggregateError 曾生成空响应，被 Main schema 丢弃后 UI 永久等待。 */
export function normalizeRemoteConnectionError(
  error: unknown,
  phase?: string,
): RemoteConnectionFailure {
  const seen = new Set<unknown>();
  function visit(value: unknown, applyPhaseFallback = false): RemoteConnectionFailure {
    if (seen.has(value))
      return { code: "remote-connection-unknown", message: "Remote connection failed" };
    seen.add(value);
    const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const message =
      typeof record.message === "string"
        ? record.message.trim()
        : typeof value === "string"
          ? value.trim()
          : "";
    const rawCode = typeof record.code === "string" ? record.code : "";
    const explicitCode = isPublicZCodeErrorCode(rawCode) ? rawCode : undefined;
    // 适配器已确认的领域原因优先于 cause 的文本猜测；阶段包装仍继续寻找更具体的内层原因。
    if (
      explicitCode &&
      explicitCode !== "remote-connection-unknown" &&
      !Object.values(phaseCodes).includes(explicitCode)
    ) {
      return {
        code: explicitCode,
        message: sanitizeRemoteConnectionLog(message) || "Remote connection failed",
        ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
      };
    }
    for (const child of [
      ...(Array.isArray(record.errors) ? record.errors : []),
      record.cause,
      record.error,
    ]) {
      if (child === undefined) continue;
      const nested = visit(child);
      if (nested.code !== "remote-connection-unknown")
        return { ...nested, message: sanitizeRemoteConnectionLog(message) || nested.message };
    }
    let code = explicitCode ?? systemCodes[rawCode];
    if (!code && record.name === "AbortError") code = "remote-connection-canceled";
    if (
      !code &&
      /all configured authentication methods failed|authentication failed|SSH\s*认证失败/iu.test(
        message,
      )
    )
      code = "remote-authentication-failed";
    if (
      !code &&
      /\b(?:ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET)\b|connection refused|no route to host/i.test(
        message,
      )
    )
      code = "remote-host-unreachable";
    if (!code && /\bETIMEDOUT\b|timed? out|timeout/i.test(message))
      code = "remote-connection-timeout";
    if (!code && /\b(?:ENOTFOUND|EAI_AGAIN)\b|could not resolve hostname/i.test(message))
      code = "remote-host-not-found";
    if (!code && /no space left on device|\bENOSPC\b/i.test(message))
      code = "remote-space-insufficient";
    if (!code && /permission denied|read-only file system/i.test(message))
      code = "remote-permission-denied";
    // 仅接受 SSH 明确的密钥校验失败，不从普通 handshake/authentication 失败猜测身份变化。
    if (
      !code &&
      /REMOTE HOST IDENTIFICATION HAS CHANGED|host key verification failed/i.test(message)
    )
      code = "remote-host-key-changed";
    return {
      code:
        code ??
        (message && applyPhaseFallback && phase ? phaseCodes[phase] : undefined) ??
        "remote-connection-unknown",
      message: sanitizeRemoteConnectionLog(message) || "Remote connection failed",
      ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
    };
  }
  // 未识别的内层 cause 不是阶段失败事实，不能提前覆盖外层已确认的认证等领域码。
  return visit(error, true);
}
