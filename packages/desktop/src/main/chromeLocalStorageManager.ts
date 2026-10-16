/* eslint-disable max-lines -- Chrome helper、CDP 传输和 Electron 目标写入必须共享同一套敏感数据边界。 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep as pathSeparator } from "node:path";
import { BrowserWindow } from "electron";
import type { Session, WebContents } from "electron";
import type { ChromeBrowserDataImportError } from "@zcode/shared";
import { WebSocket, type RawData } from "ws";
import { resolveChromeExecutablePath } from "./chromeProfileDiscovery.js";
import type { LinuxChromePasswordStore } from "./chromeInstallationCandidates.js";

const MAX_LOCAL_STORAGE_ORIGINS = 1_000;
const MAX_LOCAL_STORAGE_BYTES = 128 * 1024 * 1024;
const CDP_TIMEOUT_MS = 15_000;
const CHROME_HELPER_TEMP_CLEANUP_MAX_RETRIES = 5;
const CHROME_HELPER_TEMP_CLEANUP_RETRY_DELAY_MS = 100;
const BLANK_DOCUMENT_BODY = Buffer.from("<!doctype html><meta charset=utf-8>").toString("base64");

export interface ChromeLocalStorageImportStats {
  originsImported: number;
  entriesImported: number;
  originsSkipped: number;
  originsFailed: number;
  error?: ChromeBrowserDataImportError;
}

export interface ChromeHelperCookie {
  domain: string;
  expires: number;
  httpOnly: boolean;
  name: string;
  path: string;
  sameSite?: "Strict" | "Lax" | "None";
  secure: boolean;
  session: boolean;
  value: string;
}

interface BrowserDataLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

type RecursiveDirectoryRemover = (
  path: string,
  options: {
    force: true;
    maxRetries: number;
    recursive: true;
    retryDelay: number;
  },
) => Promise<void>;

interface LocalStorageRecord {
  origin: string;
  entries: Array<[string, string]>;
}

interface CdpTransport {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  onMessage(listener: (method: string, params: Record<string, unknown>) => void): () => void;
  close(): void;
}

function toLocalStorageFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown_error";
  if (message === "local_storage_origin_mismatch" || message.endsWith("_timeout")) {
    return message;
  }
  // CDP 原始错误可能包含 URL 或站点细节，日志中只保留稳定分类。
  return "cdp_command_failed";
}

function toLocalStorageImportError(error: unknown): ChromeBrowserDataImportError {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  if (code === "EBUSY" || code === "EACCES" || code === "EPERM") {
    return "chrome_profile_locked";
  }
  return "chrome_local_storage_import_failed";
}

function toSafeFileSystemError(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: "UnknownError" };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { name: error.name || "Error", ...(code ? { code } : {}) };
}

export async function cleanupChromeHelperTempRoot(options: {
  logger: BrowserDataLogger;
  remover?: RecursiveDirectoryRemover;
  tempRoot: string;
}): Promise<void> {
  try {
    await (options.remover ?? rm)(options.tempRoot, {
      recursive: true,
      force: true,
      maxRetries: CHROME_HELPER_TEMP_CLEANUP_MAX_RETRIES,
      retryDelay: CHROME_HELPER_TEMP_CLEANUP_RETRY_DELAY_MS,
    });
  } catch (error) {
    // Linux Chrome 的 crashpad/子进程可能在主 helper 退出后短暂继续写临时 Profile，
    // 使 rm 返回 ENOTEMPTY。清理失败不能覆盖已经通过 CDP 读取成功的 Cookie/LocalStorage 结果。
    options.logger.warn(
      "[browser-data] Chrome helper 临时目录清理失败",
      toSafeFileSystemError(error),
    );
  }
}

export function emptyChromeLocalStorageImportStats(): ChromeLocalStorageImportStats {
  return {
    originsImported: 0,
    entriesImported: 0,
    originsSkipped: 0,
    originsFailed: 0,
  };
}

function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export async function discoverChromeLocalStorageOrigins(
  localStoragePath: string,
): Promise<string[]> {
  const levelDbPath = join(localStoragePath, "leveldb");
  if (!(await pathExists(levelDbPath))) return [];

  const origins = new Set<string>();
  const files = await readdir(levelDbPath, { withFileTypes: true });
  // Chrome LocalStorage LevelDB 的 metadata key 使用 `META:<origin>`。这里只提取 origin，
  // 不解析或输出任何 entry value；真实值由隔离 Chrome helper 通过同源 API 读取。
  const originPattern = /META:(https?:\/\/(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?)/g;
  for (const file of files) {
    if (!file.isFile()) continue;
    const content = (await readFile(join(levelDbPath, file.name))).toString("latin1");
    for (const match of content.matchAll(originPattern)) {
      const candidate = match[1];
      if (!candidate) continue;
      try {
        const url = new URL(candidate);
        if (url.origin === candidate && (url.protocol === "https:" || url.protocol === "http:")) {
          origins.add(candidate);
        }
      } catch {
        // LevelDB 历史记录或二进制邻接字节可能形成无效候选，直接忽略。
      }
    }
  }
  return [...origins].sort();
}

class WebSocketCdpTransport implements CdpTransport {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Set<(method: string, params: Record<string, unknown>) => void>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data: RawData) => this.handleMessage(data));
    socket.on("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("cdp_socket_closed"));
      }
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<WebSocketCdpTransport> {
    const socket = new WebSocket(url);
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", reject);
      }),
      CDP_TIMEOUT_MS,
      "cdp_connect",
    );
    return new WebSocketCdpTransport(socket);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    return withTimeout(
      new Promise<T>((resolve, reject) => {
        this.pending.set(id, {
          resolve: (value) => resolve(value as T),
          reject,
        });
        this.socket.send(JSON.stringify({ id, method, params }));
      }),
      CDP_TIMEOUT_MS,
      `cdp_${method}`,
    );
  }

  onMessage(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.socket.close();
  }

  private handleMessage(data: RawData): void {
    const message = JSON.parse(data.toString()) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message?: string };
    };
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "cdp_command_failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!message.method) return;
    for (const listener of this.listeners) {
      listener(message.method, message.params ?? {});
    }
  }
}

function createElectronCdpTransport(webContents: WebContents): CdpTransport {
  const listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  webContents.debugger.attach("1.3");
  const handleMessage = (
    _event: Electron.Event,
    method: string,
    params: Record<string, unknown>,
  ) => {
    for (const listener of listeners) listener(method, params);
  };
  webContents.debugger.on("message", handleMessage);
  return {
    send: (method, params = {}) => webContents.debugger.sendCommand(method, params),
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      webContents.debugger.off("message", handleMessage);
      if (webContents.debugger.isAttached()) webContents.debugger.detach();
    },
  };
}

async function initializeLocalStoragePage(transport: CdpTransport): Promise<() => void> {
  const unsubscribe = transport.onMessage((method, params) => {
    if (method !== "Fetch.requestPaused") return;
    const requestId = params.requestId;
    if (typeof requestId !== "string") return;
    const command =
      params.resourceType === "Document"
        ? transport.send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "Content-Type", value: "text/html; charset=utf-8" },
              { name: "Cache-Control", value: "no-store" },
            ],
            body: BLANK_DOCUMENT_BODY,
          })
        : transport.send("Fetch.failRequest", { requestId, errorReason: "Aborted" });
    void command.catch(() => undefined);
  });
  await transport.send("Page.enable");
  await transport.send("Runtime.enable");
  await transport.send("Fetch.enable", {
    patterns: [{ urlPattern: "http*", requestStage: "Request" }],
  });
  return unsubscribe;
}

async function navigateToStorageOrigin(transport: CdpTransport, origin: string): Promise<void> {
  let unsubscribe = () => {};
  const loaded = new Promise<void>((resolve) => {
    unsubscribe = transport.onMessage((method) => {
      if (method !== "Page.loadEventFired") return;
      resolve();
    });
  });
  try {
    await transport.send("Page.navigate", { url: `${origin}/` });
    await withTimeout(loaded, 5_000, "local_storage_navigation");
  } finally {
    unsubscribe();
  }
  const evaluated = await transport.send<{
    result?: { value?: string };
  }>("Runtime.evaluate", {
    expression: "location.origin",
    returnByValue: true,
  });
  if (evaluated.result?.value !== origin) {
    throw new Error("local_storage_origin_mismatch");
  }
}

async function waitForChromeDebuggerUrl(child: ChildProcessWithoutNullStreams): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve, reject) => {
      let stderr = "";
      const handleData = (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_384);
        const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
        if (match?.[1]) {
          cleanup();
          resolve(match[1]);
        }
      };
      const handleError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const handleExit = () => {
        cleanup();
        reject(new Error("chrome_helper_exited"));
      };
      const cleanup = () => {
        child.stderr.off("data", handleData);
        child.off("error", handleError);
        child.off("exit", handleExit);
      };
      child.stderr.on("data", handleData);
      child.once("error", handleError);
      child.once("exit", handleExit);
    }),
    CDP_TIMEOUT_MS,
    "chrome_helper_start",
  );
}

async function findChromePageTarget(browserDebuggerUrl: string): Promise<string> {
  const browserUrl = new URL(browserDebuggerUrl);
  const listUrl = `http://${browserUrl.host}/json/list`;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const targets = (await fetch(listUrl).then((response) => response.json())) as Array<{
      type?: string;
      webSocketDebuggerUrl?: string;
    }>;
    const page = targets.find(
      (target) => target.type === "page" && typeof target.webSocketDebuggerUrl === "string",
    );
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("chrome_helper_page_missing");
}

async function stopChromeHelper(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  try {
    await withTimeout(exited, 3_000, "chrome_helper_exit");
  } catch {
    child.kill("SIGKILL");
  }
}

async function runChromeHelper<T>(options: {
  executablePath: string;
  passwordStore?: LinuxChromePasswordStore;
  userDataPath: string;
  run: (transport: CdpTransport) => Promise<T>;
}): Promise<T> {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${options.userDataPath}`,
    "--profile-directory=Default",
    "--remote-debugging-port=0",
    ...(options.passwordStore ? [`--password-store=${options.passwordStore}`] : []),
    "about:blank",
  ];
  const child = spawn(options.executablePath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let transport: WebSocketCdpTransport | null = null;
  try {
    const debuggerUrl = await waitForChromeDebuggerUrl(child);
    transport = await WebSocketCdpTransport.connect(await findChromePageTarget(debuggerUrl));
    return await options.run(transport);
  } finally {
    transport?.close();
    await stopChromeHelper(child);
  }
}

async function readChromeLocalStorage(options: {
  userDataPath: string;
  origins: string[];
  executablePath: string;
}): Promise<{
  records: LocalStorageRecord[];
  skipped: number;
  failed: number;
  failureReasons: Record<string, number>;
}> {
  return runChromeHelper({
    executablePath: options.executablePath,
    userDataPath: options.userDataPath,
    run: async (transport) => {
      const unsubscribe = await initializeLocalStoragePage(transport);
      const records: LocalStorageRecord[] = [];
      let skipped = 0;
      let failed = 0;
      const failureReasons: Record<string, number> = {};
      let totalBytes = 0;
      try {
        for (const origin of options.origins.slice(0, MAX_LOCAL_STORAGE_ORIGINS)) {
          try {
            await navigateToStorageOrigin(transport, origin);
            const evaluated = await transport.send<{
              result?: { value?: unknown };
            }>("Runtime.evaluate", {
              expression: "Object.entries(localStorage)",
              returnByValue: true,
            });
            const rawEntries = evaluated.result?.value;
            const entries = Array.isArray(rawEntries)
              ? rawEntries.filter(
                  (entry): entry is [string, string] =>
                    Array.isArray(entry) &&
                    entry.length === 2 &&
                    typeof entry[0] === "string" &&
                    typeof entry[1] === "string",
                )
              : [];
            if (entries.length === 0) {
              skipped += 1;
              continue;
            }
            const bytes = entries.reduce(
              (sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value),
              0,
            );
            if (totalBytes + bytes > MAX_LOCAL_STORAGE_BYTES) {
              skipped += 1;
              continue;
            }
            totalBytes += bytes;
            records.push({ origin, entries });
          } catch (error) {
            failed += 1;
            const reason = toLocalStorageFailureReason(error);
            failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
          }
        }
        skipped += Math.max(0, options.origins.length - MAX_LOCAL_STORAGE_ORIGINS);
        return { records, skipped, failed, failureReasons };
      } finally {
        unsubscribe();
      }
    },
  });
}

async function copyFileIfPresent(source: string, target: string): Promise<void> {
  if (!(await pathExists(source))) return;
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

async function copyChromeProfileMetadata(
  profilePath: string,
  targetProfilePath: string,
  userDataPath: string,
): Promise<void> {
  await copyFileIfPresent(join(profilePath, "Preferences"), join(targetProfilePath, "Preferences"));
  await copyFileIfPresent(
    join(dirname(profilePath), "Local State"),
    join(userDataPath, "Local State"),
  );
}

/**
 * Windows App-Bound Cookie 与 Linux 系统密钥环 Cookie 只能由匹配的 Chrome/Chromium
 * 安全解密。这里把数据库复制到一次性 Profile，再由已安装浏览器通过 CDP 读取；
 * Cookie 值和密钥环材料不会进入 renderer 或日志。
 */
export async function readChromeCookiesWithHelper(options: {
  cookieDatabasePath: string;
  cookieDatabaseRelativePath?: string;
  executablePath: string;
  logger: BrowserDataLogger;
  passwordStore?: LinuxChromePasswordStore;
  profilePath: string;
}): Promise<ChromeHelperCookie[]> {
  const relativeDatabasePath =
    options.cookieDatabaseRelativePath ?? relative(options.profilePath, options.cookieDatabasePath);
  if (
    !relativeDatabasePath ||
    isAbsolute(relativeDatabasePath) ||
    relativeDatabasePath === ".." ||
    relativeDatabasePath.startsWith(`..${pathSeparator}`)
  ) {
    throw new Error("chrome_cookie_database_outside_profile");
  }
  const tempRoot = await mkdtemp(join(tmpdir(), "zcode-chrome-cookie-helper-"));
  const userDataPath = join(tempRoot, "User Data");
  const targetProfilePath = join(userDataPath, "Default");
  const targetDatabasePath = join(targetProfilePath, relativeDatabasePath);
  try {
    await mkdir(dirname(targetDatabasePath), { recursive: true });
    await copyFile(options.cookieDatabasePath, targetDatabasePath);
    for (const suffix of ["-wal", "-shm"]) {
      await copyFileIfPresent(
        `${options.cookieDatabasePath}${suffix}`,
        `${targetDatabasePath}${suffix}`,
      );
    }
    await copyChromeProfileMetadata(options.profilePath, targetProfilePath, userDataPath);
    return await runChromeHelper({
      executablePath: options.executablePath,
      passwordStore: options.passwordStore,
      userDataPath,
      run: async (transport) => {
        await transport.send("Network.enable");
        const response = await transport.send<{ cookies?: ChromeHelperCookie[] }>(
          "Storage.getCookies",
        );
        return (response.cookies ?? []).filter(
          (cookie) =>
            typeof cookie.name === "string" &&
            typeof cookie.value === "string" &&
            typeof cookie.domain === "string" &&
            typeof cookie.path === "string",
        );
      },
    });
  } finally {
    await cleanupChromeHelperTempRoot({ tempRoot, logger: options.logger });
  }
}

async function writeElectronLocalStorage(
  targetSession: Session,
  records: LocalStorageRecord[],
): Promise<{ importedOrigins: number; importedEntries: number; failedOrigins: number }> {
  if (records.length === 0) {
    return { importedOrigins: 0, importedEntries: 0, failedOrigins: 0 };
  }
  const window = new BrowserWindow({
    show: false,
    width: 1,
    height: 1,
    webPreferences: {
      session: targetSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  // 未加载任何文档的 WebContents 尚未创建可用 renderer，直接发送 CDP
  // 导航/存储命令会一直不返回。先初始化 about:blank，再附加 debugger。
  await window.loadURL("about:blank");
  const transport = createElectronCdpTransport(window.webContents);
  const unsubscribe = await initializeLocalStoragePage(transport);
  let importedOrigins = 0;
  let importedEntries = 0;
  let failedOrigins = 0;
  try {
    for (const record of records) {
      try {
        await navigateToStorageOrigin(transport, record.origin);
        const serializedEntries = JSON.stringify(JSON.stringify(record.entries));
        const evaluated = await transport.send<{
          result?: { value?: number };
        }>("Runtime.evaluate", {
          expression: `(() => { const entries = JSON.parse(${serializedEntries}); for (const [key, value] of entries) localStorage.setItem(key, value); return entries.length; })()`,
          returnByValue: true,
        });
        const written = evaluated.result?.value;
        if (typeof written !== "number" || written !== record.entries.length) {
          throw new Error("local_storage_write_incomplete");
        }
        importedOrigins += 1;
        importedEntries += written;
      } catch {
        failedOrigins += 1;
      }
    }
    targetSession.flushStorageData();
    return { importedOrigins, importedEntries, failedOrigins };
  } finally {
    unsubscribe();
    transport.close();
    if (!window.isDestroyed()) window.destroy();
  }
}

export async function importChromeLocalStorage(options: {
  profilePath: string;
  targetSession: Session;
  logger: BrowserDataLogger;
  platform?: NodeJS.Platform;
  chromeExecutablePath?: string;
}): Promise<ChromeLocalStorageImportStats> {
  const sourceLocalStoragePath = join(options.profilePath, "Local Storage");
  if (!(await pathExists(sourceLocalStoragePath))) {
    return emptyChromeLocalStorageImportStats();
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "zcode-chrome-local-storage-"));
  const userDataPath = join(tempRoot, "User Data");
  const targetProfilePath = join(userDataPath, "Default");
  let originCount = 0;
  try {
    await mkdir(targetProfilePath, { recursive: true });
    // Windows 上 Chrome 可能持续写入 LevelDB。必须先复制快照，再扫描 metadata；
    // 直接扫描源目录会把锁冲突和写入竞态误报为“没有 LocalStorage”。
    await cp(sourceLocalStoragePath, join(targetProfilePath, "Local Storage"), {
      recursive: true,
      force: true,
    });
    const origins = await discoverChromeLocalStorageOrigins(
      join(targetProfilePath, "Local Storage"),
    );
    originCount = origins.length;
    if (origins.length === 0) return emptyChromeLocalStorageImportStats();

    const executablePath =
      options.chromeExecutablePath ??
      (await resolveChromeExecutablePath({ platform: options.platform ?? process.platform }));
    if (!executablePath) {
      options.logger.warn("[browser-data] Chrome LocalStorage helper 不可用");
      return {
        ...emptyChromeLocalStorageImportStats(),
        originsFailed: origins.length,
        error: "chrome_executable_not_found",
      };
    }
    await copyChromeProfileMetadata(options.profilePath, targetProfilePath, userDataPath);

    const source = await readChromeLocalStorage({ userDataPath, origins, executablePath });
    if (source.failed > 0) {
      options.logger.warn("[browser-data] Chrome LocalStorage 源读取存在失败", {
        failureReasons: source.failureReasons,
      });
    }
    const target = await writeElectronLocalStorage(options.targetSession, source.records);
    const result: ChromeLocalStorageImportStats = {
      originsImported: target.importedOrigins,
      entriesImported: target.importedEntries,
      originsSkipped: source.skipped,
      originsFailed: source.failed + target.failedOrigins,
    };
    options.logger.info("[browser-data] Chrome LocalStorage 导入完成", result);
    return result;
  } catch (error) {
    const importError = toLocalStorageImportError(error);
    options.logger.warn("[browser-data] Chrome LocalStorage 导入失败", {
      originCount,
      reason: importError,
    });
    return {
      ...emptyChromeLocalStorageImportStats(),
      originsFailed: originCount,
      error: importError,
    };
  } finally {
    await cleanupChromeHelperTempRoot({ tempRoot, logger: options.logger });
  }
}
