import { ProjectAccessTokenTransientError } from "@zcode/shared";

const REFRESH_LEAD_MS = 120_000;
const REFRESH_RETRY_BACKOFF_MS = 5_000;
const UNKNOWN_TTL_MS = 300_000;
const SECOND_MS = 1_000;

export interface ZaiBusinessToken {
  readonly token: string;
  readonly refreshAt: number;
  readonly expiresAt?: number;
}
interface Session {
  oauth: string;
  pending?: Promise<ZaiBusinessToken>;
  value?: ZaiBusinessToken;
  retryAt?: number;
}

/** 业务 JWT 与 PAT 生命周期不同；缓存只由 CLI 换证 adapter 持有。 */
export class ZaiBusinessTokenCache {
  #session?: Session;
  readonly #rejected = new WeakSet<ZaiBusinessToken>();

  constructor(private readonly onRefreshDeferred?: () => void) {}

  clear(): void {
    this.#session = undefined;
  }

  invalidate(value: ZaiBusinessToken): void {
    // 迟到的旧 401 不得清除其它请求已经换好的业务 JWT。
    this.#rejected.add(value);
    if (this.#session?.value === value) this.#session.value = undefined;
  }

  wasRejected(value: ZaiBusinessToken): boolean {
    return this.#rejected.has(value);
  }

  async resolve(oauth: string, exchange: () => Promise<unknown>): Promise<ZaiBusinessToken> {
    if (this.#session?.oauth !== oauth) this.#session = { oauth };
    const session = this.#session;
    if (session.pending) return session.pending;
    if (
      session.value &&
      Date.now() <
        Math.min(session.retryAt ?? session.value.refreshAt, session.value.expiresAt ?? Infinity)
    )
      return session.value;
    const startedAt = Date.now();
    const pending = Promise.resolve()
      .then(() => {
        if (this.#session !== session) throw new Error("project_token_scope_invalidated");
        return exchange();
      })
      .then((raw) => {
        if (this.#session !== session) throw new Error("project_token_scope_invalidated");
        const response = raw as {
          code?: unknown;
          data?: {
            access_token?: string;
            accessToken?: string;
            expires_in?: number;
            expiresIn?: number;
          };
        };
        if (response.code != null && ![0, 200, "0", "200"].includes(response.code as number))
          throw new Error("project_token_login_failed");
        const data = response.data;
        const token = data?.access_token?.trim() || data?.accessToken?.trim();
        if (!token) throw new Error("project_token_login_failed");
        const ttl = data?.expires_in ?? data?.expiresIn;
        const deadlines = [
          readJwtExpiry(token),
          typeof ttl === "number" && Number.isFinite(ttl) ? startedAt + ttl * SECOND_MS : undefined,
        ].filter((value): value is number => value !== undefined);
        const expiresAt = deadlines.length ? Math.min(...deadlines) : undefined;
        const cacheUntil = expiresAt ?? startedAt + UNKNOWN_TTL_MS;
        if (cacheUntil <= Date.now()) throw new Error("project_token_login_failed");
        const value = Object.freeze({ token, expiresAt, refreshAt: cacheUntil - REFRESH_LEAD_MS });
        session.value = value;
        session.retryAt = undefined;
        return value;
      })
      .catch((error: unknown) => {
        if (this.#session !== session) throw new Error("project_token_scope_invalidated");
        const value = session.value;
        // 真实有效期未知时不能降级；保留原对象身份，让迟到的 401 仍能拒绝这一代 JWT。
        if (
          error instanceof ProjectAccessTokenTransientError &&
          value &&
          !this.wasRejected(value) &&
          value.expiresAt !== undefined &&
          Date.now() < value.expiresAt
        ) {
          session.retryAt = Math.min(Date.now() + REFRESH_RETRY_BACKOFF_MS, value.expiresAt);
          this.onRefreshDeferred?.();
          return value;
        }
        session.value = undefined;
        session.retryAt = undefined;
        throw error;
      })
      .finally(() => {
        // 降级与清理属于共享 pending，所有并发调用必须获得同一个结果。
        if (session.pending === pending) session.pending = undefined;
      });
    session.pending = pending;
    return pending;
  }
}

function readJwtExpiry(token: string): number | undefined {
  try {
    const raw = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { exp?: unknown };
    return typeof raw.exp === "number" && Number.isFinite(raw.exp)
      ? raw.exp * SECOND_MS
      : undefined;
  } catch {
    return undefined;
  }
}
