import type { OAuthDiscoveryState } from "@modelcontextprotocol/client";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import { isRecord, mcpOAuthCredentialKey } from "./oauth-credentials.js";

export const MCP_OAUTH_DISCOVERY_STATE_KEY = "discovery_state";
export const MCP_OAUTH_DISCOVERY_FETCHED_AT_KEY = "discovery_state_fetched_at";

/** discovery metadata 缓存寿命。过期后重新发现，避免长期使用换过端点的旧 AS metadata。 */
export const MCP_OAUTH_DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

export interface McpOAuthAuthorizationContext {
  authorizationUrl: string;
  redirectUrl: string;
  serverName: string;
}

/**
 * discovery 记录的时间戳单独存一个 key，不包裹 `discovery_state` 本身。
 *
 * `discovery_state` 的值形态必须继续是裸 `OAuthDiscoveryState`：CLI 与 desktop 独立升级、
 * 共享同一个凭据文件，把它换成 `{fetched_at, state}` 包裹结构会让未升级的 reader 读到一个
 * 不含 `authorizationServerUrl` 的对象，静默失去 discovery 缓存。追加一个可选 key 才是
 * 向后兼容的做法。
 */
export async function saveDiscoveryRecord(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  state: OAuthDiscoveryState,
  now = Date.now(),
): Promise<void> {
  await credentialStore.saveMany({
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_STATE_KEY)]: JSON.stringify(state),
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_FETCHED_AT_KEY)]: String(now),
  });
}

/**
 * 读取未过期的 discovery 记录。
 *
 * 缺时间戳（旧版本写入）或已过期都返回 `undefined`，让调用方重新发现一次；下一次保存就会补上
 * 时间戳，自愈。
 */
export async function loadDiscoveryRecord(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  options: { expectedIssuer?: string; now?: number; ttlMs?: number } = {},
): Promise<OAuthDiscoveryState | undefined> {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? MCP_OAUTH_DISCOVERY_TTL_MS;
  const stateKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_STATE_KEY);
  const fetchedAtKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_FETCHED_AT_KEY);
  const values = await credentialStore.loadMany([stateKey, fetchedAtKey]);
  const raw = values[stateKey];
  if (!raw) return undefined;

  const fetchedAt = Number(values[fetchedAtKey]);
  if (!Number.isFinite(fetchedAt) || now - fetchedAt >= ttlMs) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.authorizationServerUrl !== "string") return undefined;

  const state = parsed as unknown as OAuthDiscoveryState;
  if (options.expectedIssuer && !issuersMatch(state, options.expectedIssuer)) {
    // canonical 记录的 issuer 与缓存不一致：授权服务器换了，缓存必须作废。
    return undefined;
  }
  return state;
}

function issuersMatch(state: OAuthDiscoveryState, expectedIssuer: string): boolean {
  const cachedIssuer = state.authorizationServerMetadata?.issuer ?? state.authorizationServerUrl;
  if (!cachedIssuer) return false;
  return normalizeIssuer(cachedIssuer) === normalizeIssuer(expectedIssuer);
}

function normalizeIssuer(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
