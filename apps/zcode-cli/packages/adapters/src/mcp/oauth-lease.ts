import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { acquireFileLock } from "@zcode/shared/node";
import { ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE } from "@zcode/shared";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import { isRecord, mcpOAuthCredentialKey } from "./oauth-credentials.js";

export const MCP_OAUTH_PENDING_AUTHORIZATION_KEY = "pending_authorization";

/**
 * 授权 lease 的竞争等待预算。
 *
 * 不能用 0：`acquireFileLock` 在竞争时先判断 `elapsed >= maxWaitMs`，之后才尝试回收
 * abandoned lock。零等待会直接超时、永远不执行 owner-dead 检查；持锁进程崩溃后授权功能
 * 将永久不可用。给一个短预算即可保证「失败前至少做一次 owner-dead 回收」，同时把 follower
 * 的额外延迟限制在人机授权流程里无感的量级。
 */
const AUTHORIZATION_LEASE_MAX_WAIT_MS = 250;
const AUTHORIZATION_LEASE_RETRY_DELAYS_MS = [25] as const;
const AUTHORIZATION_LEASE_OWNERLESS_GRACE_MS = 100;

export interface McpOAuthAuthorizationLease {
  attemptId: string;
  release(): Promise<void>;
}

/**
 * lease 文件路径。
 *
 * basename 只允许 hash 与连字符：credential key prefix 形如 `mcp:oauth:<hash>`，冒号在
 * Windows 文件名中非法，直接拼进路径会让整个授权流程在 Windows 上失败。
 */
export function resolveAuthorizationLeasePath(
  credentialsFilePath: string,
  keyPrefix: string,
): string {
  return join(dirname(credentialsFilePath), `${sanitizeKeyPrefix(keyPrefix)}.authz`);
}

export function sanitizeKeyPrefix(keyPrefix: string): string {
  return keyPrefix.replaceAll(/[^a-zA-Z0-9-]/g, "-");
}

/**
 * 尝试成为授权 leader。抢不到返回 `undefined`（调用方转 follower），不阻塞等待。
 *
 * 同进程竞争同样由 `mkdir` 的互斥保证：第二个 caller 的 `mkdir` 收到 EEXIST，随后读到的
 * owner PID 是本进程自己且存活，因此不会误回收，正确降级为 follower。所以不需要额外的
 * 进程内注册表。
 */
export async function tryAcquireAuthorizationLease(input: {
  credentialsFilePath: string;
  keyPrefix: string;
}): Promise<McpOAuthAuthorizationLease | undefined> {
  const leasePath = resolveAuthorizationLeasePath(input.credentialsFilePath, input.keyPrefix);
  try {
    const release = await acquireFileLock(
      leasePath,
      AUTHORIZATION_LEASE_RETRY_DELAYS_MS,
      AUTHORIZATION_LEASE_OWNERLESS_GRACE_MS,
      AUTHORIZATION_LEASE_MAX_WAIT_MS,
    );
    return {
      attemptId: randomBytes(16).toString("hex"),
      release,
    };
  } catch (error) {
    if (getErrorCode(error) === ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE) return undefined;
    // EACCES/EPERM 等表示凭据目录不可写，交互授权无论如何都不可能成功，必须上报而不是静默降级。
    throw error;
  }
}

export interface PendingAuthorizationRecord {
  attemptId: string;
  authorizationUrl: string;
  baselineGeneration?: string;
  expiresAt: number;
  state: string;
}

interface StoredPendingAuthorization {
  attempt_id: string;
  authorization_url: string;
  baseline_generation?: string;
  expires_at: number;
  state: string;
}

export async function publishPendingAuthorization(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  record: PendingAuthorizationRecord,
): Promise<void> {
  const stored: StoredPendingAuthorization = {
    attempt_id: record.attemptId,
    authorization_url: record.authorizationUrl,
    ...(record.baselineGeneration === undefined
      ? {}
      : { baseline_generation: record.baselineGeneration }),
    expires_at: record.expiresAt,
    state: record.state,
  };
  await credentialStore.save(pendingKey(keyPrefix), JSON.stringify(stored));
}

/** 读取 pending；已过期视为不存在（TTL 只用于展示判断，不承担锁所有权语义）。 */
export async function loadPendingAuthorization(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  now = Date.now(),
): Promise<PendingAuthorizationRecord | undefined> {
  const raw = await credentialStore.load(pendingKey(keyPrefix));
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.attempt_id !== "string" ||
    typeof parsed.authorization_url !== "string" ||
    typeof parsed.state !== "string" ||
    typeof parsed.expires_at !== "number"
  ) {
    return undefined;
  }
  if (parsed.expires_at <= now) return undefined;
  return {
    attemptId: parsed.attempt_id,
    authorizationUrl: parsed.authorization_url,
    ...(typeof parsed.baseline_generation === "string"
      ? { baselineGeneration: parsed.baseline_generation }
      : {}),
    expiresAt: parsed.expires_at,
    state: parsed.state,
  };
}

/**
 * 只删除本 attempt 发布的 pending。
 *
 * 删除必须按 attempt CAS：旧 leader 的 `finally` 若无条件删除，会抹掉新 leader 刚发布的
 * pending，follower 随即失去授权 URL。先读当前值确认归属，再按原始值 compare-and-delete。
 */
export async function deletePendingAuthorizationIfOwned(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  attemptId: string,
): Promise<boolean> {
  const key = pendingKey(keyPrefix);
  const raw = await credentialStore.load(key);
  if (!raw) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 无法解析的残留值只有在确实是当前值时才清理。
    return await credentialStore.deleteIfValue(key, raw);
  }
  if (!isRecord(parsed) || parsed.attempt_id !== attemptId) return false;
  return await credentialStore.deleteIfValue(key, raw);
}

function pendingKey(keyPrefix: string): string {
  return mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_PENDING_AUTHORIZATION_KEY);
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
