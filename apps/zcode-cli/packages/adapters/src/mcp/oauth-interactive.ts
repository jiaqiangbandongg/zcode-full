import { createHash, randomBytes } from "node:crypto";
import {
  auth,
  type FetchLike,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
} from "@modelcontextprotocol/client";
import type { Logger, McpOAuthConfig } from "@zcode/contracts";
import {
  createLocalhostOAuthCallbackServer,
  type LocalhostOAuthCallbackServer,
} from "../auth/localhost-callback.js";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import {
  loadCanonicalCredentials,
  publishCanonicalCredentials,
  type CanonicalCredentialSnapshot,
} from "./oauth-credentials.js";
import {
  deletePendingAuthorizationIfOwned,
  loadPendingAuthorization,
  publishPendingAuthorization,
  tryAcquireAuthorizationLease,
} from "./oauth-lease.js";
import {
  loadDiscoveryRecord,
  saveDiscoveryRecord,
  type McpOAuthAuthorizationContext,
} from "./oauth-shared.js";
import { withTimeout } from "./timeout.js";

type McpAuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

/** 授权事务的全局寿命。与 caller 等待预算（session 15s）无关，由 caller 侧独立收口。 */
export const MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS = 5 * 60 * 1000;
const FOLLOWER_POLL_INTERVAL_MS = 500;

export type McpInteractiveAuthorizationOutcome =
  /** 本次调用完成了授权，凭据已发布。 */
  | { status: "authorized" }
  /** 另一个事务已完成授权（generation 已换代），直接回 Phase 1 重连即可。 */
  | { status: "already-authorized" }
  /** 事务仍在进行（本调用是 follower 或已达事务 TTL），授权 URL 可供展示。 */
  | { status: "pending"; authorizationUrl?: string }
  | { status: "failed"; error: unknown };

export interface McpInteractiveAuthorizationInput {
  adapterInstanceId?: string;
  config: McpAuthorizationCodeOAuthConfig;
  credentialStore: SharedZCodeCredentialStore;
  fetchFn?: FetchLike;
  /** 403 step-up：unionScope 是 requiredScope 的严格超集时，refresh 无法扩权，必须强制重新授权。 */
  forceReauthorization?: boolean;
  keyPrefix: string;
  logger?: Logger;
  onAuthorizationRequired?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
  openAuthorizationUrl?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
  /** 编排层算好的最终 scope（config scope ∪ token.scope ∪ challenge scope）。 */
  requestedScope?: string;
  resourceMetadataUrl?: URL;
  serverName: string;
  serverUrl: string;
  signal?: AbortSignal;
  transactionTtlMs?: number;
}

/**
 * Phase 2：交互授权事务。
 *
 * 不创建任何 MCP transport。直接用 SDK 导出的 `auth()` 驱动 discovery → DCR → authorize →
 * code exchange，因此不存在「Phase 2 transport 必须销毁」的隐患：授权成功后调用方直接用
 * Phase 1 的纯 AuthProvider 重新建连即可。
 */
export async function runMcpInteractiveAuthorization(
  input: McpInteractiveAuthorizationInput,
): Promise<McpInteractiveAuthorizationOutcome> {
  const transactionTtlMs = input.transactionTtlMs ?? MCP_OAUTH_AUTHORIZATION_TRANSACTION_TTL_MS;
  const baseline = await loadCanonicalCredentials(input.credentialStore, input.keyPrefix);
  const baselineGeneration = baseline?.generation;

  const lease = await tryAcquireAuthorizationLease({
    credentialsFilePath: input.credentialStore.filePath,
    keyPrefix: input.keyPrefix,
  });
  if (!lease) {
    return await followAuthorization(input, baselineGeneration, transactionTtlMs);
  }

  try {
    // 锁内重读：等待 lease 期间别人可能已经完成授权。
    const current = await loadCanonicalCredentials(input.credentialStore, input.keyPrefix);
    if (hasNewerCredentials(current, baselineGeneration)) {
      return { status: "already-authorized" };
    }
    return await leadAuthorization(input, {
      attemptId: lease.attemptId,
      baselineGeneration,
      transactionTtlMs,
    });
  } finally {
    await deletePendingAuthorizationIfOwned(
      input.credentialStore,
      input.keyPrefix,
      lease.attemptId,
    ).catch(() => undefined);
    await lease.release();
  }
}

async function leadAuthorization(
  input: McpInteractiveAuthorizationInput,
  context: {
    attemptId: string;
    baselineGeneration?: string;
    transactionTtlMs: number;
  },
): Promise<McpInteractiveAuthorizationOutcome> {
  const state = randomBytes(24).toString("base64url");
  const callbackPath = normalizeCallbackPath(input.config.redirectPath, input.serverName);
  // 每次授权都重新 listen(0)。彻底放弃端口复用：listener 在整个连接期长期存活，复用必撞；
  // fresh DCR 会把当前存活 listener 的 URL 写进 redirect_uris，端口变化不再导致失配。
  let callbackServer: LocalhostOAuthCallbackServer;
  try {
    callbackServer = await createLocalhostOAuthCallbackServer({ callbackPath, state });
  } catch (error) {
    // EACCES/EMFILE/ENFILE/EADDRNOTAVAIL 等一律按 leader 失败处理，不特殊处理 EADDRINUSE。
    input.logger?.warn("MCP OAuth callback listener failed", {
      event: "mcp.oauth.callback_listener.failed",
      ...logContext(input, state),
      error: error instanceof Error ? error.message : String(error),
      status: "failed",
    });
    return { status: "failed", error };
  }

  const provider = new InteractiveAuthorizationProvider({
    attemptId: context.attemptId,
    baselineGeneration: context.baselineGeneration,
    callbackServer,
    config: input.config,
    credentialStore: input.credentialStore,
    keyPrefix: input.keyPrefix,
    logger: input.logger,
    onAuthorizationRequired: input.onAuthorizationRequired,
    openAuthorizationUrl: input.openAuthorizationUrl,
    requestedScope: input.requestedScope,
    serverName: input.serverName,
    state,
    transactionTtlMs: context.transactionTtlMs,
  });

  try {
    const redirected = await auth(provider, {
      serverUrl: input.serverUrl,
      ...(input.requestedScope ? { scope: input.requestedScope } : {}),
      ...(input.resourceMetadataUrl ? { resourceMetadataUrl: input.resourceMetadataUrl } : {}),
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
      ...(input.forceReauthorization ? { forceReauthorization: true } : {}),
    });
    if (redirected === "AUTHORIZED") {
      // 静态配置 client 且服务器直接放行时可能不经过浏览器。
      return { status: "authorized" };
    }

    // 只有「等人点授权」这一段有超时。code exchange 一律等到 settle，不与超时竞速：
    // 否则可能在 token response 已返回、saveTokens 仍在进行时放锁，fencing 就漏了。
    const callback = await withTimeout(
      callbackServer.waitForCallback(),
      context.transactionTtlMs,
      `MCP server ${input.serverName} OAuth authorization timed out`,
      input.signal,
    );
    const callbackParams = new URL(callback.url).searchParams;
    const authorizationCode = callbackParams.get("code") ?? callback.code;
    const issuerParam = callbackParams.get("iss");
    await auth(provider, {
      serverUrl: input.serverUrl,
      authorizationCode,
      ...(issuerParam ? { iss: issuerParam } : {}),
      ...(input.requestedScope ? { scope: input.requestedScope } : {}),
      ...(input.resourceMetadataUrl ? { resourceMetadataUrl: input.resourceMetadataUrl } : {}),
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    });
    input.logger?.info("MCP OAuth authorization completed", {
      event: "mcp.oauth.authorization.completed",
      ...logContext(input, state),
      status: "completed",
    });
    return { status: "authorized" };
  } catch (error) {
    // 事务 TTL 到点时授权仍可能在浏览器里进行，但本 leader 已经放弃：把 listener 关掉，
    // 让下一次连接重新成为 leader，而不是留下一个不会被消费的回调端口。
    const published = await loadCanonicalCredentials(input.credentialStore, input.keyPrefix);
    if (hasNewerCredentials(published, context.baselineGeneration)) {
      return { status: "already-authorized" };
    }
    input.logger?.warn("MCP OAuth authorization failed", {
      event: "mcp.oauth.authorization.failed",
      ...logContext(input, state),
      error: error instanceof Error ? error.message : String(error),
      status: "failed",
    });
    return { status: "failed", error };
  } finally {
    await callbackServer.close().catch(() => undefined);
  }
}

async function followAuthorization(
  input: McpInteractiveAuthorizationInput,
  baselineGeneration: string | undefined,
  transactionTtlMs: number,
): Promise<McpInteractiveAuthorizationOutcome> {
  const deadline = Date.now() + transactionTtlMs;
  let projectedUrl: string | undefined;
  input.logger?.info("MCP OAuth authorization is already in progress elsewhere", {
    event: "mcp.oauth.authorization.following",
    ...logContext(input),
    status: "waiting",
  });

  while (Date.now() < deadline && !input.signal?.aborted) {
    const current = await loadCanonicalCredentials(input.credentialStore, input.keyPrefix);
    if (hasNewerCredentials(current, baselineGeneration)) return { status: "already-authorized" };

    const pending = await loadPendingAuthorization(input.credentialStore, input.keyPrefix);
    if (pending && pending.authorizationUrl !== projectedUrl) {
      // 设置页与 session 是独立 lease，leader 的 onAuthorizationRequired 回调对 follower
      // 不可见；follower 必须从共享 pending 键把同一个授权 URL 投影到自己的状态。
      projectedUrl = pending.authorizationUrl;
      await input.onAuthorizationRequired?.({
        authorizationUrl: pending.authorizationUrl,
        redirectUrl: "",
        serverName: input.serverName,
      });
    }
    await sleep(FOLLOWER_POLL_INTERVAL_MS, input.signal);
  }

  return { status: "pending", ...(projectedUrl ? { authorizationUrl: projectedUrl } : {}) };
}

/**
 * Phase 2 专用 OAuthClientProvider。
 *
 * 与 Phase 1 的纯 AuthProvider 相反，这里必须是完整 `OAuthClientProvider` 才能驱动 `auth()`；
 * 但它只在授权事务内存活，且：
 * - `clientInformation()` 只认静态配置 clientId，其余一律返回 undefined，强制 fresh DCR；
 * - `saveClientInformation()` 只写事务内存，绝不落盘；
 * - `tokens()` 恒为 undefined，绝不触发 refresh（refresh 是 Phase 1 的唯一职责）；
 * - PKCE verifier 只存内存：整个事务在同一进程、同一 lease 内完成，不存在 provider 重建。
 */
class InteractiveAuthorizationProvider implements OAuthClientProvider {
  private readonly attemptId: string;
  private readonly baselineGeneration?: string;
  private readonly callbackServer: LocalhostOAuthCallbackServer;
  private readonly config: McpAuthorizationCodeOAuthConfig;
  private readonly credentialStore: SharedZCodeCredentialStore;
  private readonly keyPrefix: string;
  private readonly logger?: Logger;
  private readonly onAuthorizationRequired?: (
    context: McpOAuthAuthorizationContext,
  ) => Promise<void> | void;
  private readonly openAuthorizationUrl?: (
    context: McpOAuthAuthorizationContext,
  ) => Promise<void> | void;
  /** 编排层算好的最终 scope（step-up 时为并集）；DCR 与 authorize 请求必须用同一个值。 */
  private readonly requestedScope?: string;
  private readonly serverName: string;
  private readonly stateValue: string;
  private readonly transactionId: string;
  private readonly transactionTtlMs: number;
  private issuer?: string;
  private memoryCodeVerifier?: string;
  private memoryDiscoveryState?: OAuthDiscoveryState;
  private transactionClientInformation?: OAuthClientInformationMixed;

  constructor(input: {
    attemptId: string;
    baselineGeneration?: string;
    callbackServer: LocalhostOAuthCallbackServer;
    config: McpAuthorizationCodeOAuthConfig;
    credentialStore: SharedZCodeCredentialStore;
    keyPrefix: string;
    logger?: Logger;
    onAuthorizationRequired?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
    openAuthorizationUrl?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
    requestedScope?: string;
    serverName: string;
    state: string;
    transactionTtlMs: number;
  }) {
    this.attemptId = input.attemptId;
    this.baselineGeneration = input.baselineGeneration;
    this.callbackServer = input.callbackServer;
    this.config = input.config;
    this.credentialStore = input.credentialStore;
    this.keyPrefix = input.keyPrefix;
    this.logger = input.logger;
    this.onAuthorizationRequired = input.onAuthorizationRequired;
    this.openAuthorizationUrl = input.openAuthorizationUrl;
    this.requestedScope = input.requestedScope;
    this.serverName = input.serverName;
    this.stateValue = input.state;
    this.transactionId = createHash("sha256").update(input.state).digest("hex");
    this.transactionTtlMs = input.transactionTtlMs;
  }

  get redirectUrl(): string {
    return this.callbackServer.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.config.clientName ?? `ZCode ${this.serverName}`,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [this.redirectUrl],
      response_types: ["code"],
      ...(this.config.clientSecret ? { token_endpoint_auth_method: "client_secret_basic" } : {}),
      // DCR 注册的 scope 与 authorize 请求的 scope 必须是同一个并集结果。
      // 若 DCR 只写 config scope，注册的 client 与后续按并集发起的授权请求不一致，
      // 严格授权服务器会拒绝或静默按注册值收敛。
      ...((this.requestedScope ?? this.config.scope)
        ? { scope: this.requestedScope ?? this.config.scope }
        : {}),
    };
  }

  state(): string {
    return this.stateValue;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
      };
    }
    // 过去这里优先返回持久化的 DCR client，而它的 redirect_uris 锁死在
    // 注册当时的随机端口。授权请求随后带「旧 client_id + 新 redirect_uri」，授权服务器按
    // RFC 6749 §4.1.2.1 禁止回跳、就地渲染错误页，回调永不到达且重试永不自愈。
    // 返回 undefined 让 SDK 用当前存活 listener 的 URL 重新注册，失配从根上消除。
    return this.transactionClientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    // 只写事务内存。DCR client 只有与本次授权换到的 token 组成一对才有意义；单独落盘
    // 也会污染其他事务的 canonical pair。
    this.transactionClientInformation = clientInformation;
  }

  tokens(): undefined {
    return undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const clientInformation = this.clientInformation();
    if (!clientInformation) {
      throw new Error(`Missing MCP OAuth client information for ${this.serverName}`);
    }
    const published = await publishCanonicalCredentials(this.credentialStore, this.keyPrefix, {
      clientInformation,
      ...(this.issuer ? { issuer: this.issuer } : {}),
      publishedBy: this.transactionId,
      tokens,
    });
    this.logger?.info("MCP OAuth credentials published", {
      event: "mcp.oauth.credentials.published",
      ...this.logContext(),
      clientIdHash: hashIdentifier(clientInformation.client_id),
      grantKind: "authorization_code",
      hasRefreshToken: Boolean(tokens.refresh_token),
      publishedGeneration: published.generation.slice(0, 12),
      status: "completed",
      tokenExpiresInSeconds: tokens.expires_in,
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const context: McpOAuthAuthorizationContext = {
      authorizationUrl: authorizationUrl.toString(),
      redirectUrl: this.redirectUrl,
      serverName: this.serverName,
    };
    // pending 与 attempt 绑定：删除按 attempt CAS，旧 leader 的 finally 不会抹掉新 leader 的
    // pending。TTL 只用于展示过期判断，不承担锁所有权语义。
    await publishPendingAuthorization(this.credentialStore, this.keyPrefix, {
      attemptId: this.attemptId,
      authorizationUrl: context.authorizationUrl,
      ...(this.baselineGeneration ? { baselineGeneration: this.baselineGeneration } : {}),
      expiresAt: Date.now() + this.transactionTtlMs,
      state: this.stateValue,
    });
    this.logger?.info("MCP OAuth authorization required", {
      event: "mcp.oauth.authorization.required",
      ...this.logContext(),
      callbackPort: Number(new URL(this.redirectUrl).port),
      status: "waiting",
    });
    await this.onAuthorizationRequired?.(context);
    // 默认只暴露 URL，等用户在设置页点击授权；自动拉起浏览器会打断当前操作。
    await this.openAuthorizationUrl?.(context);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.memoryCodeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.memoryCodeVerifier) {
      throw new Error(`Missing MCP OAuth PKCE verifier for ${this.serverName}`);
    }
    return this.memoryCodeVerifier;
  }

  saveAuthorizationServerUrl(authorizationServerUrl: string): void {
    this.issuer = authorizationServerUrl;
  }

  authorizationServerUrl(): string | undefined {
    return this.issuer;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    // 事务内也留一份内存副本：code exchange 那一腿需要能读回 authorize 腿记录的
    // issuer，否则 SDK 抛 AuthorizationServerMismatchError。共享记录可能被别的进程改写或过期，
    // 内存副本保证同一事务内的 issuer 绑定稳定。
    this.memoryDiscoveryState = state;
    await saveDiscoveryRecord(this.credentialStore, this.keyPrefix, state);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    if (this.memoryDiscoveryState) return this.memoryDiscoveryState;
    return await loadDiscoveryRecord(this.credentialStore, this.keyPrefix);
  }

  private logContext(): Record<string, unknown> {
    return {
      credentialKeyPrefix: this.keyPrefix,
      mcpServerName: this.serverName,
      oauthAttemptId: this.attemptId.slice(0, 12),
      oauthStateId: this.transactionId.slice(0, 16),
      processId: process.pid,
    };
  }
}

function hasNewerCredentials(
  current: CanonicalCredentialSnapshot | undefined,
  baselineGeneration: string | undefined,
): boolean {
  return Boolean(current?.tokens && current.generation !== baselineGeneration);
}

function normalizeCallbackPath(value: string | undefined, serverName: string): string {
  const fallback = `/oauth/callback/mcp/${encodeURIComponent(serverName)}`;
  if (!value) return fallback;
  return value.startsWith("/") ? value : `/${value}`;
}

function logContext(
  input: McpInteractiveAuthorizationInput,
  state?: string,
): Record<string, unknown> {
  return {
    adapterInstanceId: input.adapterInstanceId,
    credentialKeyPrefix: input.keyPrefix,
    mcpServerName: input.serverName,
    ...(state
      ? { oauthStateId: createHash("sha256").update(state).digest("hex").slice(0, 16) }
      : {}),
    processId: process.pid,
  };
}

function hashIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function sleep(durationMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
