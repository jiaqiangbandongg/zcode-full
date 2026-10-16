import type { FetchLike, AuthProvider } from "@modelcontextprotocol/client";
import type { Logger, McpOAuthConfig } from "@zcode/contracts";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import { isCanonicalTokenNearExpiry, loadCredentialPair } from "./oauth-credentials.js";
import { createInteractiveAuthorizationRequiredError } from "./oauth-errors.js";
import { refreshMcpOAuthTokensUnderLock } from "./oauth-refresh.js";

type McpAuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

export interface CreateMcpOAuthTokenProviderInput {
  config: McpAuthorizationCodeOAuthConfig;
  credentialStore: SharedZCodeCredentialStore;
  fetchFn?: FetchLike;
  keyPrefix: string;
  logger?: Logger;
  serverName: string;
  serverUrl: string;
}

/**
 * Phase 1 运行期 AuthProvider。
 *
 * 只实现 `token()` 与 `onUnauthorized()`，**不是** `OAuthClientProvider`：transport 的
 * `isOAuthClientProvider()` 判定因此为 false，`_oauthProvider` 保持为空
 * （client@2.0.0 `index.mjs:4977-4980`），于是：
 *
 * - 建连不做 discovery、不做 DCR、不开 callback listener；
 * - 401 只调用我们的 `onUnauthorized()` 并自动重试一次，SDK 的 `auth()` 完全不参与，
 *   所有 refresh 都被强制汇入我们的跨进程单飞锁。
 *
 * 绝不要把 `OAuthClientProvider` 传给运行期 transport：它会被 `adaptOAuthProvider` 包裹，
 * 401 走 SDK 的 `handleOAuthUnauthorized()` → `auth()`，绕过 refresh 锁，并发刷新问题立即复发。
 */
export function createMcpOAuthTokenProvider(
  input: CreateMcpOAuthTokenProviderInput,
): AuthProvider {
  const refreshInput = {
    credentialStore: input.credentialStore,
    ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    keyPrefix: input.keyPrefix,
    ...(input.logger ? { logger: input.logger } : {}),
    serverName: input.serverName,
    serverUrl: input.serverUrl,
    ...(input.config.clientId ? { staticClientId: input.config.clientId } : {}),
  };

  return {
    async token(): Promise<string | undefined> {
      const pair = await loadCredentialPair(input.credentialStore, input.keyPrefix);
      // 没有 token 时返回 undefined：请求照发、拿到 401，再由 onUnauthorized 统一分类。
      if (!pair?.tokens) return undefined;
      if (!isCanonicalTokenNearExpiry(pair)) return pair.tokens.access_token;
      // 临期主动刷新。没有 refresh token 就直接用现值撑到 401，不虚构刷新。
      if (!pair.tokens.refresh_token) return pair.tokens.access_token;
      return await refreshMcpOAuthTokensUnderLock({ ...refreshInput, reactive: false });
    },

    async onUnauthorized(): Promise<void> {
      const pair = await loadCredentialPair(input.credentialStore, input.keyPrefix);
      if (!pair?.tokens?.refresh_token) {
        throw createInteractiveAuthorizationRequiredError({
          reason: pair?.tokens ? "no_refresh_token" : "no_credentials",
          serverName: input.serverName,
        });
      }
      // 契约是「让下一次 token() 返回可用 token」，返回值本身被 SDK 忽略；刷新结果已发布到
      // canonical，下一次 token() 会重新读取。
      await refreshMcpOAuthTokensUnderLock({ ...refreshInput, reactive: true });
    },
  };
}
