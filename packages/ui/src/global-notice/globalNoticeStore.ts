import { logger } from "@/logger.js";

export type GlobalNoticePriority = "low" | "normal" | "high";
export type GlobalNoticeInterruptPolicy = "passive" | "replace-lower-priority";

export interface GlobalNoticeEnvelope {
  noticeId: string;
  dedupeKey: string;
  type: string;
  schemaVersion: number;
  scope: "user" | "workspace" | "task";
  priority: GlobalNoticePriority;
  interruptPolicy: GlobalNoticeInterruptPolicy;
  createdAt: number;
  expiresAt?: number;
  payload: Record<string, unknown>;
  actions: Array<{ id: string; label: string }>;
  dismissPolicy: { kind: "none" } | { kind: "cooldown"; cooldownMs: number };
  persistencePolicy: "memory" | "latest-only";
  source: string;
  revision: number;
}

interface PersistedGlobalNoticeState {
  version: 1;
  latest: GlobalNoticeEnvelope | null;
  dismissedUntilByKey: Record<string, number>;
  requiresPublishAfterDismissalByKey: Record<string, boolean>;
}

export interface GlobalNoticeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface GlobalNoticeStore {
  publish(notice: GlobalNoticeEnvelope): void;
  dismiss(noticeId: string): void;
  getVisible(): GlobalNoticeEnvelope | null;
  getSnapshot(): PersistedGlobalNoticeState;
  subscribe(listener: () => void): () => void;
}

const STORAGE_KEY = "zcode:global-notice:v1";

function emptyState(): PersistedGlobalNoticeState {
  return {
    version: 1,
    latest: null,
    dismissedUntilByKey: {},
    requiresPublishAfterDismissalByKey: {},
  };
}

function isLegacyHighspeedMockNotice(notice: GlobalNoticeEnvelope | null): boolean {
  if (notice?.type !== "highspeed-share") return false;
  const cardId = notice.payload.cardId;
  return typeof cardId === "string" && cardId.startsWith("hsc_mock_");
}

function readState(
  storage: GlobalNoticeStorage,
  onPersistError?: (error: unknown) => void,
): PersistedGlobalNoticeState {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw) as Partial<PersistedGlobalNoticeState>;
    if (parsed.version !== 1) return emptyState();
    const state: PersistedGlobalNoticeState = {
      version: 1,
      latest: parsed.latest ?? null,
      dismissedUntilByKey: parsed.dismissedUntilByKey ?? {},
      requiresPublishAfterDismissalByKey: parsed.requiresPublishAfterDismissalByKey ?? {},
    };
    if (!isLegacyHighspeedMockNotice(state.latest)) return state;

    // Bug 根因：早期 Highspeed mock 通知使用 latest-only 持久化，关闭 mock 后重启仍会恢复假分享数据。
    const cleaned = { ...state, latest: null };
    // 清理写失败不能把整份状态（含 24h 静默）打回空：内存态照常用 cleaned。
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
    } catch (error) {
      onPersistError?.(error);
    }
    return cleaned;
  } catch {
    return emptyState();
  }
}

export function createGlobalNoticeStore(options: {
  storage: GlobalNoticeStorage;
  now?: () => number;
  /** 持久化失败（QuotaExceeded、存储被禁用）的受控回调；缺省静默，浏览器入口接 logger.warn。 */
  onPersistError?: (error: unknown) => void;
}): GlobalNoticeStore {
  const now = options.now ?? Date.now;
  let state = readState(options.storage, options.onPersistError);
  const listeners = new Set<() => void>();

  const persist = () => {
    // Bug 根因：setItem 抛错会让 publish/dismiss 抛出，订阅者收不到已更新的内存态；而调用方
    // （SessionPane 自动分享）已先 claim 再 publish，异常会留下不可重试的 claim，用户看不到分享卡且
    // 当前 Renderer 生命周期内无法恢复。持久化只是展示增强：内存态先更新、写存储 best-effort、
    // 无论成败都通知订阅者（spec §6）。
    try {
      options.storage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
      options.onPersistError?.(error);
    }
    for (const listener of listeners) listener();
  };

  return {
    publish(notice) {
      const dismissedUntil = state.dismissedUntilByKey[notice.dedupeKey] ?? 0;
      state = {
        ...state,
        latest: notice.persistencePolicy === "latest-only" ? notice : state.latest,
        requiresPublishAfterDismissalByKey: {
          ...state.requiresPublishAfterDismissalByKey,
          [notice.dedupeKey]: dismissedUntil > now(),
        },
      };
      persist();
    },
    dismiss(noticeId) {
      const latest = state.latest;
      if (!latest || latest.noticeId !== noticeId) return;
      const cooldownMs =
        latest.dismissPolicy.kind === "cooldown" ? latest.dismissPolicy.cooldownMs : 0;
      state = {
        ...state,
        dismissedUntilByKey: {
          ...state.dismissedUntilByKey,
          [latest.dedupeKey]: now() + cooldownMs,
        },
        requiresPublishAfterDismissalByKey: {
          ...state.requiresPublishAfterDismissalByKey,
          [latest.dedupeKey]: true,
        },
      };
      persist();
    },
    getVisible() {
      const latest = state.latest;
      if (!latest) return null;
      const current = now();
      if (latest.expiresAt !== undefined && latest.expiresAt <= current) return null;
      if ((state.dismissedUntilByKey[latest.dedupeKey] ?? 0) > current) return null;
      if (state.requiresPublishAfterDismissalByKey[latest.dedupeKey]) return null;
      return latest;
    },
    getSnapshot() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function createMemoryNoticeStorage(): GlobalNoticeStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** localStorage 在隐私模式、被禁用或沙箱 iframe 中访问即抛 SecurityError；退回内存存储，通知在本次会话内仍可用。 */
function resolveBrowserNoticeStorage(): GlobalNoticeStorage {
  try {
    const storage = window.localStorage;
    if (storage) return storage;
  } catch (error) {
    logger.warn("[global-notice] localStorage 不可用，改用内存存储", {
      error: describeError(error),
    });
  }
  return createMemoryNoticeStorage();
}

export const browserGlobalNoticeStore =
  typeof window === "undefined"
    ? null
    : createGlobalNoticeStore({
        storage: resolveBrowserNoticeStorage(),
        onPersistError: (error) =>
          logger.warn("[global-notice] 通知持久化失败，仅保留内存态", {
            error: describeError(error),
          }),
      });
