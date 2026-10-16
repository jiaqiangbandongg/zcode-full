import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { session as electronSession } from "electron";
import type {
  ChromeBrowserDataImportError,
  ChromeBrowserDataImportResult,
  EmbeddedBrowserDataClearResult,
} from "@zcode/shared";
import {
  importChromeCookies,
  type ChromeCookieDatabaseBackup,
  type ChromeCookieHelper,
} from "./chromeCookieManager.js";
import {
  ChromeCookieAccessDeniedError,
  type MacChromeSafeStorageSecretReader,
} from "./chromeCredentialManager.js";
import {
  emptyChromeLocalStorageImportStats,
  importChromeLocalStorage,
  type ChromeLocalStorageImportStats,
} from "./chromeLocalStorageManager.js";
import {
  discoverChromeProfile,
  resolveChromeExecutablePath,
  type ChromeProfileDiscoveryResult,
} from "./chromeProfileDiscovery.js";
import type { LinuxChromePasswordStore } from "./chromeInstallationCandidates.js";
import type { WindowsChromeAppBoundKeyReader } from "./windowsChromeAppBoundKey.js";
import { clearEmbeddedBrowserSitePermissions } from "./embeddedBrowserSitePermissions.js";

export const EMBEDDED_BROWSER_PARTITION = "persist:zcode-embedded-browser";
const CACHE_STORAGE_TYPES: Electron.ClearStorageDataOptions["storages"] = [
  "shadercache",
  "serviceworkers",
  "cachestorage",
];

interface BrowserSessionLike {
  clearCache(): Promise<void>;
  clearStorageData(options?: Electron.ClearStorageDataOptions): Promise<void>;
  cookies: {
    set(details: Electron.CookiesSetDetails): Promise<void>;
    flushStore(): Promise<void>;
  };
}

interface BrowserDataLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

function toSafeBrowserDataError(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: "UnknownError" };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return { name: error.name || "Error", ...(code ? { code } : {}) };
}

function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** 兼容旧调用；实际导入使用 discoverChromeProfile 自动选择最近使用的 Profile。 */
export function resolveChromeDefaultProfilePath(
  options: {
    platform?: NodeJS.Platform;
    homeDir?: string;
    localAppData?: string;
  } = {},
): string {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  if (platform === "darwin") {
    return join(homeDir, "Library", "Application Support", "Google", "Chrome", "Default");
  }
  if (platform === "win32") {
    return join(
      options.localAppData ?? process.env.LOCALAPPDATA ?? join(homeDir, "AppData", "Local"),
      "Google",
      "Chrome",
      "User Data",
      "Default",
    );
  }
  return join(homeDir, ".config", "google-chrome", "Default");
}

function emptyImportResult(error?: ChromeBrowserDataImportError): ChromeBrowserDataImportResult {
  return {
    success: false,
    cookies: { imported: 0, skipped: 0, failed: 0 },
    localStorage: emptyChromeLocalStorageImportStats(),
    ...(error ? { error } : {}),
  };
}

export async function importChromeBrowserData(options: {
  allowElevatedChromeDecryption?: boolean;
  chromeCookieDatabaseBackup?: ChromeCookieDatabaseBackup;
  chromeCookieHelper?: ChromeCookieHelper;
  chromeExecutableDiscovery?: () => Promise<string | null>;
  chromeExecutablePath?: string;
  chromePasswordStore?: LinuxChromePasswordStore;
  chromeProfileDiscovery?: () => Promise<ChromeProfileDiscoveryResult>;
  logger: BrowserDataLogger;
  macChromeSafeStorageSecretReader?: MacChromeSafeStorageSecretReader;
  profilePath?: string;
  platform?: NodeJS.Platform;
  targetSession?: BrowserSessionLike;
  windowsChromeAppBoundKeyReader?: WindowsChromeAppBoundKeyReader;
  localStorageImporter?: (options: {
    profilePath: string;
    targetSession: Electron.Session;
    logger: BrowserDataLogger;
    platform?: NodeJS.Platform;
    chromeExecutablePath?: string;
  }) => Promise<ChromeLocalStorageImportStats>;
}): Promise<ChromeBrowserDataImportResult> {
  const platform = options.platform ?? process.platform;
  let detectedChromeExecutablePath = options.chromeExecutablePath;
  if (platform !== "win32" && !options.profilePath && !detectedChromeExecutablePath) {
    detectedChromeExecutablePath =
      (await (options.chromeExecutableDiscovery ??
        (() => resolveChromeExecutablePath({ platform })))()) ?? undefined;
    if (!detectedChromeExecutablePath) {
      // 过去会先扫描默认 Profile，导致“Chrome 未安装”被误报为 Profile 缺失，
      // 也无法识别注册在非默认目录的浏览器。先完成可执行文件发现，失败时不访问源数据。
      return emptyImportResult("chrome_executable_not_found");
    }
  }
  const discovered = options.profilePath
    ? null
    : await (options.chromeProfileDiscovery ?? (() => discoverChromeProfile({ platform })))();
  if (discovered && !discovered.success) return emptyImportResult(discovered.error);

  const profilePath = options.profilePath ?? discovered?.source.profilePath;
  if (!profilePath || !(await pathExists(profilePath))) {
    return emptyImportResult("chrome_profile_not_found");
  }
  const chromeExecutablePath =
    options.chromeExecutablePath ??
    discovered?.source.executablePath ??
    detectedChromeExecutablePath;
  const chromePasswordStore = options.chromePasswordStore ?? discovered?.source.passwordStore;
  const targetSession =
    options.targetSession ?? electronSession.fromPartition(EMBEDDED_BROWSER_PARTITION);
  const result: ChromeBrowserDataImportResult = {
    success: false,
    cookies: { imported: 0, skipped: 0, failed: 0 },
    localStorage: emptyChromeLocalStorageImportStats(),
  };
  const issues = new Set<ChromeBrowserDataImportError>();

  try {
    options.logger.info("[browser-data] 开始导入 Chrome 浏览器数据", {
      browser: discovered?.source.browser ?? "explicit-profile",
      profile: discovered?.source.profileDirectory ?? "explicit-profile",
    });
    const cookieImport = await importChromeCookies({
      allowElevatedChromeDecryption: options.allowElevatedChromeDecryption,
      databaseBackup: options.chromeCookieDatabaseBackup,
      chromeCookieHelper: options.chromeCookieHelper,
      chromeExecutablePath,
      chromePasswordStore,
      logger: options.logger,
      macChromeSafeStorageSecretReader: options.macChromeSafeStorageSecretReader,
      platform,
      profilePath,
      targetSession,
      windowsChromeAppBoundKeyReader: options.windowsChromeAppBoundKeyReader,
    });
    result.cookies = cookieImport.stats;
    for (const issue of cookieImport.issues) issues.add(issue);

    const localStorageImporter = options.localStorageImporter ?? importChromeLocalStorage;
    options.logger.info("[browser-data] 开始导入 Chrome LocalStorage");
    result.localStorage = await localStorageImporter({
      profilePath,
      targetSession: targetSession as Electron.Session,
      logger: options.logger,
      platform,
      chromeExecutablePath,
    });
    if (result.localStorage.error) issues.add(result.localStorage.error);

    result.success =
      (cookieImport.databaseFound && cookieImport.rowCount === 0) ||
      result.cookies.imported > 0 ||
      result.localStorage.originsImported > 0;
    if (!result.success) {
      result.error = [
        "chrome_cookie_elevation_required",
        "chrome_cookie_elevation_cancelled",
        "chrome_cookie_helper_verification_failed",
        "chrome_cookie_app_bound_decryption_failed",
        "chrome_cookie_protection_unsupported",
      ].find((issue) => issues.has(issue as ChromeBrowserDataImportError)) as
        | ChromeBrowserDataImportError
        | undefined;
      result.error ??= result.localStorage.error ?? "chrome_browser_data_import_unavailable";
    }
    if (issues.size > 0) result.issues = [...issues];
    options.logger.info("[browser-data] Chrome 数据导入完成", {
      importedCount: result.cookies.imported,
      skippedCount: result.cookies.skipped,
      failedCount: result.cookies.failed,
      importedLocalStorageOrigins: result.localStorage.originsImported,
      importedLocalStorageEntries: result.localStorage.entriesImported,
      skippedLocalStorageOrigins: result.localStorage.originsSkipped,
      failedLocalStorageOrigins: result.localStorage.originsFailed,
    });
    return result;
  } catch (error) {
    if (error instanceof ChromeCookieAccessDeniedError) {
      // macOS 用户拒绝钥匙串授权后，导入必须作为一个整体停止，不能再进入
      // LocalStorage 阶段；返回稳定错误码给 renderer 展示明确提示。
      options.logger.warn("[browser-data] Chrome 数据导入已取消：macOS 钥匙串授权被拒绝");
      return {
        ...result,
        error: "chrome_cookie_access_denied",
      };
    }
    // 只记录错误类型/错误码，不记录 Cookie、LocalStorage 值或绝对 Profile 路径。
    options.logger.warn("[browser-data] Chrome 数据导入失败", toSafeBrowserDataError(error));
    return {
      ...result,
      ...(issues.size > 0 ? { issues: [...issues] } : {}),
      error: "chrome_data_import_failed",
    };
  }
}

export async function clearEmbeddedBrowserData(options: {
  logger: BrowserDataLogger;
  mode: "cache" | "all";
  targetSession?: BrowserSessionLike;
}): Promise<EmbeddedBrowserDataClearResult> {
  const targetSession =
    options.targetSession ?? electronSession.fromPartition(EMBEDDED_BROWSER_PARTITION);
  try {
    await targetSession.clearCache();
    if (options.mode === "all") {
      await targetSession.clearStorageData();
      // 「全部清除」连站点权限同意记录一起清：登录态与权限授权同属用户可预期的清理范围。
      await clearEmbeddedBrowserSitePermissions();
    } else {
      // 普通缓存清理不能删除承载登录态的 LocalStorage/IndexedDB。
      await targetSession.clearStorageData({ storages: CACHE_STORAGE_TYPES });
    }
    options.logger.info("[browser-data] 内置浏览器数据清理完成", { mode: options.mode });
    return { success: true };
  } catch {
    options.logger.warn("[browser-data] 内置浏览器数据清理失败", { mode: options.mode });
    return { success: false, error: "embedded_browser_clear_failed" };
  }
}
