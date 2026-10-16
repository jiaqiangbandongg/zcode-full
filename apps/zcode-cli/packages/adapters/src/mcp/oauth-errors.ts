import { InsufficientScopeError, SdkErrorCode, UnauthorizedError } from "@modelcontextprotocol/client";

/**
 * 交互授权需求的稳定标识。
 *
 * 用 `Symbol.for` 注册到全局 symbol registry：bundler 双装或版本偏斜导致同进程存在两份
 * adapter 代码时，两份都解析到同一个 symbol，`instanceof` 做不到这一点。SDK 在 transport
 * auth seam 上用同样的手法（`Symbol.for("mcp.authSeamEscape")`），并且 `markAuthSeamEscape()`
 * 是 identity-preserving 的，所以我们的品牌能原样穿过 SDK 冒泡到编排层。
 */
const INTERACTIVE_REQUIRED_BRAND = Symbol.for("zcode.mcp.oauth.interactiveAuthorizationRequired");
const TEMPORARY_REFRESH_FAILURE_BRAND = Symbol.for("zcode.mcp.oauth.temporaryRefreshFailure");

export const MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE = "MCP_OAUTH_INTERACTIVE_REQUIRED";
export const MCP_OAUTH_TEMPORARY_REFRESH_FAILURE_ERROR_CODE =
  "MCP_OAUTH_TEMPORARY_REFRESH_FAILURE";

export type McpOAuthInteractiveRequiredReason =
  | "no_credentials"
  | "no_refresh_token"
  | "invalid_grant"
  | "invalid_client"
  | "insufficient_scope"
  | "unauthorized"
  | "legacy_provider_seam";

export interface McpOAuthInteractiveRequiredError extends Error {
  code: typeof MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE;
  reason: McpOAuthInteractiveRequiredReason;
  requiredScope?: string;
  resourceMetadataUrl?: string;
}

export interface McpOAuthTemporaryRefreshFailureError extends Error {
  code: typeof MCP_OAUTH_TEMPORARY_REFRESH_FAILURE_ERROR_CODE;
}

export function createInteractiveAuthorizationRequiredError(input: {
  cause?: unknown;
  reason: McpOAuthInteractiveRequiredReason;
  requiredScope?: string;
  resourceMetadataUrl?: string;
  serverName: string;
}): McpOAuthInteractiveRequiredError {
  const error = new Error(
    `MCP server ${input.serverName} requires interactive OAuth authorization (${input.reason})`,
    input.cause === undefined ? undefined : { cause: input.cause },
  ) as McpOAuthInteractiveRequiredError;
  Object.defineProperty(error, INTERACTIVE_REQUIRED_BRAND, {
    configurable: true,
    value: true,
  });
  error.code = MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE;
  error.reason = input.reason;
  if (input.requiredScope) error.requiredScope = input.requiredScope;
  if (input.resourceMetadataUrl) error.resourceMetadataUrl = input.resourceMetadataUrl;
  return error;
}

/**
 * reactive refresh 的网络 / 5xx 失败。
 *
 * 与 `interactiveRequired` 必须区分：临时 AS 故障不代表 grant 已失效，把它误转成交互授权会
 * 无谓打断用户；而返回已被资源服务器拒绝的旧 token 又必然产生第二次 401。
 */
export function createTemporaryRefreshFailureError(input: {
  cause?: unknown;
  serverName: string;
}): McpOAuthTemporaryRefreshFailureError {
  const error = new Error(
    `MCP server ${input.serverName} OAuth token refresh failed temporarily`,
    input.cause === undefined ? undefined : { cause: input.cause },
  ) as McpOAuthTemporaryRefreshFailureError;
  Object.defineProperty(error, TEMPORARY_REFRESH_FAILURE_BRAND, {
    configurable: true,
    value: true,
  });
  error.code = MCP_OAUTH_TEMPORARY_REFRESH_FAILURE_ERROR_CODE;
  return error;
}

export function isInteractiveAuthorizationRequiredError(
  error: unknown,
): error is McpOAuthInteractiveRequiredError {
  return hasBrand(error, INTERACTIVE_REQUIRED_BRAND);
}

export function isTemporaryRefreshFailureError(
  error: unknown,
): error is McpOAuthTemporaryRefreshFailureError {
  return hasBrand(error, TEMPORARY_REFRESH_FAILURE_BRAND);
}

export interface InteractiveAuthorizationTrigger {
  reason: McpOAuthInteractiveRequiredReason;
  requiredScope?: string;
  resourceMetadataUrl?: string;
}

/**
 * 把连接期 / 运行期错误归类为「需要交互授权」。
 *
 * 纯 AuthProvider 下 SDK 只可能给出这几种确定性认证错误：
 * - 我们自己抛的 `interactiveRequired`（token 缺失、invalid_grant、invalid_client）；
 * - 重试后仍 401 的 `SdkHttpError(ClientHttpAuthentication)`；
 * - 没有 `onUnauthorized` 时的 `UnauthorizedError`（防御路径）；
 * - Streamable HTTP 403 的 `InsufficientScopeError`（带 requiredScope）。
 *
 * `temporaryRefreshFailure` 显式不在此列：它必须保留凭据并原样失败。
 */
export function classifyInteractiveAuthorizationTrigger(
  error: unknown,
): InteractiveAuthorizationTrigger | undefined {
  if (isTemporaryRefreshFailureError(error)) return undefined;
  if (isInteractiveAuthorizationRequiredError(error)) {
    return {
      reason: error.reason,
      ...(error.requiredScope ? { requiredScope: error.requiredScope } : {}),
      ...(error.resourceMetadataUrl ? { resourceMetadataUrl: error.resourceMetadataUrl } : {}),
    };
  }
  if (error instanceof InsufficientScopeError) {
    return {
      reason: "insufficient_scope",
      ...(error.requiredScope ? { requiredScope: error.requiredScope } : {}),
      ...(error.resourceMetadataUrl
        ? { resourceMetadataUrl: String(error.resourceMetadataUrl) }
        : {}),
    };
  }
  if (error instanceof UnauthorizedError) return { reason: "unauthorized" };
  if (isSdkAuthenticationHttpError(error)) return { reason: "unauthorized" };
  // cause 链：SDK 在若干 seam 上包裹错误，分类不能只看最外层。
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  if (cause !== undefined && cause !== error) {
    return classifyInteractiveAuthorizationTrigger(cause);
  }
  return undefined;
}

/** 重试后仍 401：`SdkHttpError(SdkErrorCode.ClientHttpAuthentication)`。按 code 比较，不依赖 instanceof。 */
function isSdkAuthenticationHttpError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === SdkErrorCode.ClientHttpAuthentication;
}

function hasBrand(error: unknown, brand: symbol): boolean {
  return (
    (typeof error === "object" && error !== null) ||
    typeof error === "function"
      ? (error as Record<symbol, unknown>)[brand] === true
      : false
  );
}
