import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/client";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";

export const MCP_OAUTH_CANONICAL_CREDENTIALS_KEY = "authorization_credentials";
export const MCP_OAUTH_LEGACY_CLIENT_KEY = "client_information";
export const MCP_OAUTH_LEGACY_TOKENS_KEY = "tokens";
export const MCP_OAUTH_CREDENTIALS_VERSION = 2;
export const MCP_OAUTH_SUPPORTED_CREDENTIAL_VERSIONS = new Set([1, MCP_OAUTH_CREDENTIALS_VERSION]);

/**
 * canonical credential pair。
 *
 * `generation`、`obtained_at`、`expires_at`、`issuer` 都是**可选新增字段**，不 bump version：
 * 追加可选字段对旧 reader 向后兼容（旧 reader 忽略未知字段即可），bump version 反而会让未升级的
 * CLI/desktop 把新记录当未知版本整体忽略、退回 legacy 镜像，丢掉 pair 保证。
 */
export interface McpOAuthCanonicalCredentials {
  client_information: OAuthClientInformationMixed;
  /** 由 `expires_in` 与 `obtained_at` 推导的绝对过期点（epoch ms）。 */
  expires_at?: number;
  /**
   * 每次 publication 唯一的随机 id。
   *
   * 不能复用 `published_by`：它是 OAuth state 派生的事务 id，同一事务的多次 refresh 不会改变它，
   * 无法承担 follower 观察换代与失效 CAS 的职责。随机 id 同时消除 ABA。
   */
  generation?: string;
  /** 授权服务器 issuer。本次只留存字段，不参与 credential key 键控。 */
  issuer?: string;
  /** token 获取时间（epoch ms）。`OAuthTokens` 只有 `expires_in`，没有它无法跨进程算真实过期点。 */
  obtained_at?: number;
  published_by: string;
  tokens: OAuthTokens;
  version: 1 | typeof MCP_OAUTH_CREDENTIALS_VERSION;
}

export interface CanonicalCredentialSnapshot {
  clientInformation: OAuthClientInformationMixed;
  expiresAt?: number;
  generation: string;
  issuer?: string;
  obtainedAt?: number;
  /** 原始 JSON，供 compare-and-delete 使用。 */
  raw: string;
  tokens: OAuthTokens;
}

export function mcpOAuthCredentialKey(keyPrefix: string, name: string): string {
  return `${keyPrefix}:${name}`;
}

export function createCredentialGeneration(): string {
  return randomBytes(16).toString("hex");
}

/**
 * 迁移期 baseline：旧记录没有 `generation`，用 canonical 原始内容的稳定 hash 代替。
 * 内容变化即 generation 变化，足以支撑 follower 的「是否换代」判断。
 */
export function resolveCredentialGeneration(
  canonical: McpOAuthCanonicalCredentials,
  raw: string,
): string {
  if (typeof canonical.generation === "string" && canonical.generation.length > 0) {
    return canonical.generation;
  }
  return `legacy-${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}

export function isCanonicalCredentials(value: unknown): value is McpOAuthCanonicalCredentials {
  if (
    !isRecord(value) ||
    typeof value.version !== "number" ||
    !MCP_OAUTH_SUPPORTED_CREDENTIAL_VERSIONS.has(value.version)
  ) {
    return false;
  }
  if (typeof value.published_by !== "string" || value.published_by.length === 0) return false;
  if (!isRecord(value.client_information) || !isRecord(value.tokens)) return false;
  return (
    typeof value.client_information.client_id === "string" &&
    typeof value.tokens.access_token === "string" &&
    typeof value.tokens.token_type === "string"
  );
}

/**
 * 只读取 canonical pair，不做 legacy 兼容推导。
 *
 * Phase 2 的 baseline generation 与 Phase 1 的 refresh 都只需要 canonical；legacy 镜像的
 * 交错兼容逻辑仍留在 provider 内。
 */
export async function loadCanonicalCredentials(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
): Promise<CanonicalCredentialSnapshot | undefined> {
  const key = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_CANONICAL_CREDENTIALS_KEY);
  const raw = await credentialStore.load(key);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isCanonicalCredentials(parsed)) return undefined;
  return {
    clientInformation: parsed.client_information,
    ...(parsed.expires_at === undefined ? {} : { expiresAt: parsed.expires_at }),
    generation: resolveCredentialGeneration(parsed, raw),
    ...(parsed.issuer === undefined ? {} : { issuer: parsed.issuer }),
    ...(parsed.obtained_at === undefined ? {} : { obtainedAt: parsed.obtained_at }),
    raw,
    tokens: parsed.tokens,
  };
}

export interface PublishCanonicalCredentialsInput {
  clientInformation: OAuthClientInformationMixed;
  issuer?: string;
  obtainedAt?: number;
  publishedBy: string;
  tokens: OAuthTokens;
}

export interface PublishedCanonicalCredentials {
  canonical: McpOAuthCanonicalCredentials;
  generation: string;
  legacyClientRaw: string;
  legacyTokensRaw: string;
  raw: string;
}

/**
 * 原子发布 canonical pair 与 legacy 镜像。
 *
 * client 与 refresh token 必须来自同一次授权，因此三个 key 必须在共享凭据 store 的同一个
 * 跨进程 read-modify-write 临界区内一次写入；分开覆盖会让最后写入的 client 与 token 来自
 * 不同事务。兼容窗口内继续维护 legacy 镜像，使未升级的 CLI/Desktop 仍可读取。
 */
export async function publishCanonicalCredentials(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  input: PublishCanonicalCredentialsInput,
): Promise<PublishedCanonicalCredentials> {
  const obtainedAt = input.obtainedAt ?? Date.now();
  const expiresAt =
    typeof input.tokens.expires_in === "number" && Number.isFinite(input.tokens.expires_in)
      ? obtainedAt + input.tokens.expires_in * 1000
      : undefined;
  const generation = createCredentialGeneration();
  const canonical: McpOAuthCanonicalCredentials = {
    client_information: input.clientInformation,
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    generation,
    ...(input.issuer === undefined ? {} : { issuer: input.issuer }),
    obtained_at: obtainedAt,
    published_by: input.publishedBy,
    tokens: input.tokens,
    version: MCP_OAUTH_CREDENTIALS_VERSION,
  };
  const raw = JSON.stringify(canonical);
  const legacyClientRaw = JSON.stringify(input.clientInformation);
  const legacyTokensRaw = JSON.stringify(input.tokens);
  await credentialStore.saveMany({
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_CANONICAL_CREDENTIALS_KEY)]: raw,
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_CLIENT_KEY)]: legacyClientRaw,
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_TOKENS_KEY)]: legacyTokensRaw,
  });
  return { canonical, generation, legacyClientRaw, legacyTokensRaw, raw };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** access token 临期判定的安全余量。 */
export const MCP_OAUTH_EXPIRY_SKEW_MS = 30_000;

/**
 * 是否需要在把 token 交给请求头之前先刷新。
 *
 * 没有 `expires_at`（旧记录，或服务器未返回 `expires_in`）一律视为临期：`OAuthTokens` 不带获取
 * 时间，无法算出真实过期点，宁可进锁尝试一次刷新，也不要把一个可能已过期的 token 发出去。
 */
export function isCanonicalTokenNearExpiry(
  snapshot: Pick<CanonicalCredentialSnapshot, "expiresAt">,
  now = Date.now(),
  skewMs = MCP_OAUTH_EXPIRY_SKEW_MS,
): boolean {
  if (snapshot.expiresAt === undefined) return true;
  return now >= snapshot.expiresAt - skewMs;
}

export type CanonicalInvalidationScope = "tokens" | "all";

/**
 * 按 canonical 快照做条件失效。
 *
 * 只有 canonical 当前值仍等于 `expectedRaw` 时才删除，因此另一个事务已经发布新 pair 时本次
 * 失效整体放弃，不会误删 winner。`tokens` 保留 legacy client 作为重新授权的种子；`all` 用于
 * `invalid_client`，client 与 token 必须整对丢弃。
 */
export async function invalidateCanonicalCredentials(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  expectedRaw: string,
  scope: CanonicalInvalidationScope,
): Promise<boolean> {
  const canonicalKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_CANONICAL_CREDENTIALS_KEY);
  const keysToDelete = [
    canonicalKey,
    mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_TOKENS_KEY),
  ];
  if (scope === "all") {
    keysToDelete.push(mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_CLIENT_KEY));
  }
  return await credentialStore.deleteManyIfValue(canonicalKey, expectedRaw, keysToDelete);
}

export interface CredentialPairSnapshot {
  clientInformation?: OAuthClientInformationMixed;
  expiresAt?: number;
  /** canonical 可用时为其 generation；只有 legacy 时按内容派生，仍可用于观察换代。 */
  generation?: string;
  issuer?: string;
  obtainedAt?: number;
  /** canonical 原始 JSON；只有 legacy 时为 undefined（无法做 canonical CAS）。 */
  raw?: string;
  source: "canonical" | "legacy";
  tokens?: OAuthTokens;
}

/**
 * 读取 canonical 与 legacy 镜像并按兼容规则派生出一份可用 pair。
 */
export async function loadCredentialPair(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
): Promise<CredentialPairSnapshot | undefined> {
  const canonicalKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_CANONICAL_CREDENTIALS_KEY);
  const legacyClientKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_CLIENT_KEY);
  const legacyTokensKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_TOKENS_KEY);
  const values = await credentialStore.loadMany([canonicalKey, legacyClientKey, legacyTokensKey]);
  return deriveCredentialPair({
    canonicalRaw: values[canonicalKey] ?? undefined,
    legacyClientRaw: values[legacyClientKey] ?? undefined,
    legacyTokensRaw: values[legacyTokensKey] ?? undefined,
  });
}

/**
 * 兼容窗口内的 pair 派生规则（纯函数，不做 I/O）。
 *
 * 抽成纯函数是为了让「已经持有原始快照的调用方」（需要原始值做 compare-and-delete 的
 * provider）复用同一份规则，而不是再读一次凭据文件——两处各写一遍这套交错兼容分支必然发散。
 *
 * 规则背景：兼容窗口内 CLI 与 desktop 可能是不同版本，旧进程只写 legacy key，新进程写
 * canonical + 镜像。这里判断的就是「在没有 generation 的旧格式下，legacy 的变化能否被证明属于
 * 同一次授权」。
 */
export function deriveCredentialPair(input: {
  canonicalRaw?: string;
  legacyClientRaw?: string;
  legacyTokensRaw?: string;
}): CredentialPairSnapshot | undefined {
  const canonicalParsed = parseJson<unknown>(input.canonicalRaw);
  const canonical =
    canonicalParsed !== undefined && isCanonicalCredentials(canonicalParsed)
      ? canonicalParsed
      : undefined;
  const legacyClient = parseJson<OAuthClientInformationMixed>(input.legacyClientRaw);
  const legacyTokens = parseJson<OAuthTokens>(input.legacyTokensRaw);

  if (canonical && input.canonicalRaw) {
    const canonicalSnapshot: CredentialPairSnapshot = {
      clientInformation: canonical.client_information,
      ...(canonical.expires_at === undefined ? {} : { expiresAt: canonical.expires_at }),
      generation: resolveCredentialGeneration(canonical, input.canonicalRaw),
      ...(canonical.issuer === undefined ? {} : { issuer: canonical.issuer }),
      ...(canonical.obtained_at === undefined ? {} : { obtainedAt: canonical.obtained_at }),
      raw: input.canonicalRaw,
      source: "canonical",
      tokens: canonical.tokens,
    };
    if (canonical.version === 1) {
      const canAdoptLegacyTokens =
        legacyTokens !== undefined &&
        (!legacyClient || isDeepStrictEqual(legacyClient, canonical.client_information));
      if (canAdoptLegacyTokens) {
        return {
          clientInformation: legacyClient ?? canonical.client_information,
          source: "legacy",
          tokens: legacyTokens,
        };
      }
      // v1 发布后会删除 legacy 镜像，因此无镜像是正常稳态；若把它套用 v2 的
      // 镜像失效规则，会丢弃仍有效的 canonical token，并强制所有升级用户重新授权。
      return canonicalSnapshot;
    }
    if (!legacyTokens) {
      // 旧 provider invalidate tokens 后必须维持失效，不能从 canonical 复活旧 token。
      return { clientInformation: legacyClient, source: "legacy" };
    }
    if (isDeepStrictEqual(legacyTokens, canonical.tokens)) {
      return legacyClient ? canonicalSnapshot : { source: "legacy", tokens: legacyTokens };
    }
    if (legacyClient && isDeepStrictEqual(legacyClient, canonical.client_information)) {
      // client 未变化时可以确认 legacy token 是同一身份的旧 provider refresh 结果。
      return { clientInformation: legacyClient, source: "legacy", tokens: legacyTokens };
    }
    // client 与 token 都变化且无 generation 时无法证明来自同一事务：保留 client 重新授权，
    // 绝不猜测性拼接认证资产。
    return { clientInformation: legacyClient, source: "legacy" };
  }

  if (!legacyClient && !legacyTokens) return undefined;
  return {
    clientInformation: legacyClient,
    source: "legacy",
    ...(legacyTokens ? { tokens: legacyTokens } : {}),
  };
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
