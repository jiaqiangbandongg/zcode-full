import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserViewportSize } from "@zcode/shared";

export const BROWSER_TAB_PAGE_STATE_MAX_RECORDS = 100;
export const BROWSER_TAB_PAGE_STATE_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
export const BROWSER_TAB_PAGE_STATE_MAX_HISTORY_ENTRIES = 500;

export interface BrowserTabShellRecord {
  schemaVersion: 1;
  tabId: string;
  /**
   * Electron windowId 跨重启无效；仅在当前进程认领后写入内存副本，落盘固定为 null。
   */
  windowBindingId: null;
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
  browserId?: string;
  browserGeneration?: number;
  origin: "agent" | "user";
  lifecycle: "active" | "deliverable" | "handoff";
  restoreUrl: string | null;
  title: string | null;
  faviconUrl: string | null;
  viewport: BrowserViewportSize | null;
  openedAt: number;
  lastSelectedAt: number | null;
  updatedAt: number;
}

export interface BrowserTabNavigationEntry {
  url: string;
  title?: string;
  pageState?: string;
}

export interface BrowserTabPageStateRecord {
  schemaVersion: 1;
  tabId: string;
  entries: BrowserTabNavigationEntry[];
  activeIndex: number;
  updatedAt: number;
}

export interface BrowserTabRecoverySnapshot {
  schemaVersion: 1;
  shells: BrowserTabShellRecord[];
  pageStates: BrowserTabPageStateRecord[];
}

interface BrowserTabRecoveryStoreOptions {
  maxPageStates?: number;
  maxTotalBytes?: number;
  maxHistoryEntries?: number;
  onWarning?: (message: string) => void;
}

const EMPTY_SNAPSHOT: BrowserTabRecoverySnapshot = {
  schemaVersion: 1,
  shells: [],
  pageStates: [],
};

export class BrowserTabRecoveryStore {
  private snapshot: BrowserTabRecoverySnapshot | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly maxPageStates: number;
  private readonly maxTotalBytes: number;
  private readonly maxHistoryEntries: number;
  private readonly onWarning?: (message: string) => void;

  constructor(
    private readonly filePath: string,
    options: BrowserTabRecoveryStoreOptions = {},
  ) {
    this.maxPageStates = options.maxPageStates ?? BROWSER_TAB_PAGE_STATE_MAX_RECORDS;
    this.maxTotalBytes = options.maxTotalBytes ?? BROWSER_TAB_PAGE_STATE_MAX_TOTAL_BYTES;
    this.maxHistoryEntries =
      options.maxHistoryEntries ?? BROWSER_TAB_PAGE_STATE_MAX_HISTORY_ENTRIES;
    this.onWarning = options.onWarning;
  }

  async readSnapshot(): Promise<BrowserTabRecoverySnapshot> {
    await this.mutationQueue;
    const snapshot = await this.ensureLoaded();
    return cloneSnapshot(snapshot);
  }

  async getShell(tabId: string): Promise<BrowserTabShellRecord | null> {
    const snapshot = await this.readSnapshot();
    return snapshot.shells.find((record) => record.tabId === tabId) ?? null;
  }

  async getPageState(tabId: string): Promise<BrowserTabPageStateRecord | null> {
    const snapshot = await this.readSnapshot();
    return snapshot.pageStates.find((record) => record.tabId === tabId) ?? null;
  }

  async listShells(scope: {
    workspaceKey: string;
    remoteSessionId?: string;
    sessionId?: string;
  }): Promise<BrowserTabShellRecord[]> {
    const snapshot = await this.readSnapshot();
    return snapshot.shells
      .filter(
        (record) =>
          record.workspaceKey === scope.workspaceKey &&
          (record.remoteSessionId ?? "") === (scope.remoteSessionId ?? "") &&
          (scope.sessionId === undefined || record.sessionId === scope.sessionId),
      )
      .sort(
        (left, right) => left.openedAt - right.openedAt || left.tabId.localeCompare(right.tabId),
      );
  }

  async upsert(record: BrowserTabShellRecord): Promise<void> {
    await this.mutate((snapshot) => {
      const normalized: BrowserTabShellRecord = {
        ...record,
        windowBindingId: null,
      };
      const index = snapshot.shells.findIndex((candidate) => candidate.tabId === record.tabId);
      if (index >= 0) snapshot.shells[index] = normalized;
      else snapshot.shells.push(normalized);
    });
  }

  async upsertPageState(record: BrowserTabPageStateRecord): Promise<void> {
    await this.mutate((snapshot) => {
      const normalized = normalizePageState(record, this.maxHistoryEntries);
      const index = snapshot.pageStates.findIndex((candidate) => candidate.tabId === record.tabId);
      if (index >= 0) snapshot.pageStates[index] = normalized;
      else snapshot.pageStates.push(normalized);
      snapshot.pageStates = prunePageStates(
        snapshot.pageStates,
        this.maxPageStates,
        this.maxTotalBytes,
      );
    });
  }

  async removePageState(tabId: string): Promise<void> {
    await this.mutate((snapshot) => {
      snapshot.pageStates = snapshot.pageStates.filter((record) => record.tabId !== tabId);
    });
  }

  async remove(tabId: string): Promise<void> {
    await this.mutate((snapshot) => {
      snapshot.shells = snapshot.shells.filter((record) => record.tabId !== tabId);
      snapshot.pageStates = snapshot.pageStates.filter((record) => record.tabId !== tabId);
    });
  }

  /** 等待所有已提交 mutation 完成，供应用正常退出建立持久化屏障。 */
  async whenIdle(): Promise<void> {
    await this.mutationQueue;
  }

  private async mutate(mutation: (snapshot: BrowserTabRecoverySnapshot) => void): Promise<void> {
    const task = this.mutationQueue.then(async () => {
      const snapshot = await this.ensureLoaded();
      mutation(snapshot);
      await this.writeSnapshot(snapshot);
    });
    this.mutationQueue = task.catch(() => undefined);
    await task;
  }

  private async ensureLoaded(): Promise<BrowserTabRecoverySnapshot> {
    if (this.snapshot) return this.snapshot;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      this.snapshot = parseSnapshot(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
        try {
          await rename(this.filePath, corruptPath);
          this.onWarning?.(`browser tab recovery 文件损坏，已隔离到 ${corruptPath}`);
        } catch (renameError) {
          if ((renameError as NodeJS.ErrnoException).code !== "ENOENT") {
            this.onWarning?.(
              `browser tab recovery 损坏文件隔离失败: ${
                renameError instanceof Error ? renameError.message : String(renameError)
              }`,
            );
          }
        }
      }
      this.snapshot = cloneSnapshot(EMPTY_SNAPSHOT);
    }
    return this.snapshot;
  }

  private async writeSnapshot(snapshot: BrowserTabRecoverySnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporaryPath, JSON.stringify(snapshot), "utf8");
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

function normalizePageState(
  record: BrowserTabPageStateRecord,
  maxHistoryEntries: number,
): BrowserTabPageStateRecord {
  const entries = record.entries.map((entry) => ({ ...entry }));
  const clampedIndex =
    entries.length === 0
      ? 0
      : Math.max(0, Math.min(Math.trunc(record.activeIndex), entries.length - 1));
  if (entries.length <= maxHistoryEntries) {
    return { ...record, entries, activeIndex: clampedIndex };
  }

  const maximumStart = entries.length - maxHistoryEntries;
  const start = Math.max(0, Math.min(clampedIndex, maximumStart));
  return {
    ...record,
    entries: entries.slice(start, start + maxHistoryEntries),
    activeIndex: clampedIndex - start,
  };
}

function prunePageStates(
  records: BrowserTabPageStateRecord[],
  maxPageStates: number,
  maxTotalBytes: number,
): BrowserTabPageStateRecord[] {
  const candidates = [...records]
    .sort(
      (left, right) => right.updatedAt - left.updatedAt || left.tabId.localeCompare(right.tabId),
    )
    .map((record) => ({
      record,
      serialized: JSON.stringify(record),
    }))
    .filter(({ serialized }) => {
      // 先把超大新记录放到 LRU 头部、再从尾部逐条删除会让所有正常旧快照
      // 先被淘汰，最后才删掉超大记录；同时每次 pop 都全量 stringify，放大主进程开销。
      return Buffer.byteLength(`[${serialized}]`, "utf8") <= maxTotalBytes;
    })
    // 单条超限记录不应占用数量预算，否则一个无效新快照仍会挤掉最旧的正常快照。
    .slice(0, Math.max(0, maxPageStates));
  const retained: BrowserTabPageStateRecord[] = [];
  let totalBytes = 2; // JSON 数组的 []。
  for (const [index, candidate] of candidates.entries()) {
    const nextBytes = Buffer.byteLength(candidate.serialized, "utf8") + (index === 0 ? 0 : 1);
    if (totalBytes + nextBytes > maxTotalBytes) break;
    retained.push(candidate.record);
    totalBytes += nextBytes;
  }
  return retained;
}

function parseSnapshot(value: unknown): BrowserTabRecoverySnapshot {
  if (!value || typeof value !== "object") throw new TypeError("invalid browser recovery snapshot");
  const candidate = value as Partial<BrowserTabRecoverySnapshot>;
  if (
    candidate.schemaVersion !== 1 ||
    !Array.isArray(candidate.shells) ||
    !Array.isArray(candidate.pageStates)
  ) {
    throw new TypeError("unsupported browser recovery snapshot");
  }
  return {
    schemaVersion: 1,
    shells: candidate.shells.map((record) => ({
      ...record,
      windowBindingId: null,
    })),
    pageStates: candidate.pageStates.map((record) => ({
      ...record,
      entries: record.entries.map((entry) => ({ ...entry })),
    })),
  };
}

function cloneSnapshot(snapshot: BrowserTabRecoverySnapshot): BrowserTabRecoverySnapshot {
  return {
    schemaVersion: 1,
    shells: snapshot.shells.map((record) => ({ ...record })),
    pageStates: snapshot.pageStates.map((record) => ({
      ...record,
      entries: record.entries.map((entry) => ({ ...entry })),
    })),
  };
}
