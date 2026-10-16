import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type {
  ApplicationIconInfo,
  ApplicationIconRequest,
  ApplicationIconLocator,
} from "@zcode/shared";
import { app } from "electron";
import { getAppIconDataUrl } from "./editors.js";
import { logger } from "./logger.js";
import { readWindowsAumidIcon } from "./windowsAumidIcon.js";

const applicationIconCache = new Map<string, Promise<ApplicationIconInfo | null>>();
const SAFE_BUNDLE_ID = /^[A-Za-z0-9.-]+$/;
const SAFE_WINDOWS_FIXED_DRIVE_PATH = /^[A-Za-z]:[\\/][^\\/]/u;
const FALLBACK_SCAN_BUDGET_MS = 3_000;
const PLIST_READ_TIMEOUT_MS = 1_000;
const FALLBACK_SCAN_CONCURRENCY = 8;

interface ApplicationPathDependencies {
  execute: (command: string, args: readonly string[], timeoutMs: number) => Promise<string>;
  listDirectory: (path: string) => Promise<string[]>;
  homeDirectory: string;
  now: () => number;
}

const defaultApplicationPathDependencies: ApplicationPathDependencies = {
  execute: (command, args, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(command, [...args], { encoding: "utf8", timeout: timeoutMs }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    }),
  listDirectory: (path) => readdir(path),
  homeDirectory: homedir(),
  now: () => Date.now(),
};

let defaultApplicationPathIndex: Promise<Map<string, string>> | undefined;

function isSafeWindowsExecutablePath(value: string): boolean {
  // win32.isAbsolute 同时接受 UNC 与设备路径，把不可信 locator 交给
  // app.getFileIcon 会触发主进程网络文件访问。图标读取只允许本机固定盘符路径。
  return SAFE_WINDOWS_FIXED_DRIVE_PATH.test(value) && win32.isAbsolute(value);
}

async function buildApplicationPathIndex(
  dependencies: ApplicationPathDependencies,
): Promise<Map<string, string>> {
  const deadline = dependencies.now() + FALLBACK_SCAN_BUDGET_MS;
  // darwin 路径拼接固定用 posix 分隔符：node:path 的 join 会跟随运行平台，
  // Windows 上跑单测时产出反斜杠路径，导致兜底索引与 Spotlight 的 POSIX 口径不一致。
  const roots = [
    "/Applications",
    posix.join(dependencies.homeDirectory, "Applications"),
    "/System/Applications",
    "/System/Applications/Utilities",
  ];
  const appPaths: string[] = [];
  for (const root of roots) {
    try {
      const entries = await dependencies.listDirectory(root);
      appPaths.push(
        ...entries
          .filter((entry) => entry.endsWith(".app"))
          .map((entry) => posix.join(root, entry)),
      );
    } catch {
      // 标准目录可能不存在或不可读，继续扫描其余目录。
    }
  }

  const index = new Map<string, string>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < appPaths.length) {
      const appPath = appPaths[cursor++];
      const remainingMs = deadline - dependencies.now();
      if (remainingMs <= 0) return;
      try {
        const bundleId = (
          await dependencies.execute(
            "/usr/libexec/PlistBuddy",
            ["-c", "Print :CFBundleIdentifier", posix.join(appPath, "Contents", "Info.plist")],
            Math.min(PLIST_READ_TIMEOUT_MS, remainingMs),
          )
        ).trim();
        // 索引按小写 bundle id 建键：CUA producer 的 appKey 是 `darwin:<bundleId.toLowerCase()>`，
        // 而 Info.plist 里是原始大小写（com.apple.Notes）。Spotlight 主路径用的是
        // 大小写不敏感查询（`"..."c`），兜底索引若保持精确匹配，就会只在 Spotlight 不可用的
        // 机器上取不到图标 —— 两条路径必须同一套大小写语义。
        const key = bundleId.toLowerCase();
        if (SAFE_BUNDLE_ID.test(bundleId) && !index.has(key)) index.set(key, appPath);
      } catch {
        // 单个损坏或超时的 plist 不能中断整个索引。
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FALLBACK_SCAN_CONCURRENCY, appPaths.length) }, worker),
  );
  return index;
}

function readFallbackApplicationPath(
  bundleId: string,
  dependencies: ApplicationPathDependencies,
): Promise<string | null> {
  // 逐 bundle id 同步扫描会冻结 Electron main；默认链路共享一次异步索引构建。
  const indexPromise =
    dependencies === defaultApplicationPathDependencies
      ? (defaultApplicationPathIndex ??= buildApplicationPathIndex(dependencies))
      : buildApplicationPathIndex(dependencies);
  return indexPromise.then((index) => index.get(bundleId.toLowerCase()) ?? null);
}

export async function resolveDarwinApplicationPath(
  bundleId: string,
  dependencies: ApplicationPathDependencies = defaultApplicationPathDependencies,
): Promise<string | null> {
  if (!SAFE_BUNDLE_ID.test(bundleId)) return null;
  try {
    const query = `kMDItemCFBundleIdentifier == "${bundleId}"c`;
    const spotlightPath = (await dependencies.execute("/usr/bin/mdfind", [query], 3_000))
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.endsWith(".app"));
    if (spotlightPath) return spotlightPath;
  } catch (error) {
    logger.warn("[application-icons] 查询应用路径失败", {
      bundleId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return readFallbackApplicationPath(bundleId, dependencies);
}

interface NativeImageLike {
  isEmpty(): boolean;
  toDataURL(): string;
}

interface ApplicationIconLoaderDependencies {
  platform: NodeJS.Platform;
  getFileIcon: (path: string, options: { size: "normal" }) => Promise<NativeImageLike>;
  resolveDarwinApplicationPath: (bundleId: string) => Promise<string | null>;
  readWindowsAumidIcon?: (aumid: string) => Promise<ApplicationIconInfo | null>;
}

const defaultApplicationIconLoaderDependencies: ApplicationIconLoaderDependencies = {
  platform: process.platform,
  getFileIcon: (path, options) => app.getFileIcon(path, options),
  resolveDarwinApplicationPath,
  readWindowsAumidIcon,
};

function normalizedRequest(
  request: string | ApplicationIconRequest,
  platform: NodeJS.Platform,
): ApplicationIconRequest | null {
  if (typeof request !== "string") {
    if (!request || !Array.isArray(request.locators) || request.locators.length > 3) return null;
    const locators = request.locators.flatMap((locator) => {
      if (
        !locator ||
        (locator.kind !== "darwin-bundle-id" &&
          locator.kind !== "windows-executable-path" &&
          locator.kind !== "windows-aumid") ||
        typeof locator.value !== "string" ||
        !locator.value.trim()
      ) {
        return [];
      }
      const value = locator.value.trim();
      if (locator.kind === "windows-executable-path" && !isSafeWindowsExecutablePath(value)) {
        return [];
      }
      return [{ kind: locator.kind, value }];
    });
    return locators.length === request.locators.length && locators.length > 0 ? { locators } : null;
  }
  const value = request.trim();
  if (!value) return null;
  if (platform === "darwin" && SAFE_BUNDLE_ID.test(value)) {
    return { locators: [{ kind: "darwin-bundle-id", value }] };
  }
  // Legacy string 仅兼容历史 macOS bundle id。Windows exe 必须来自 official CUA
  // authority 的结构化 locator，不能把模型 input 当作本地文件路径。
  return null;
}

function locatorCacheKey(locator: ApplicationIconLocator): string {
  return `${locator.kind}:${locator.value.trim().toLowerCase()}`;
}

async function readFileIcon(
  path: string,
  dependencies: ApplicationIconLoaderDependencies,
): Promise<ApplicationIconInfo | null> {
  const image = await dependencies.getFileIcon(path, { size: "normal" });
  if (image.isEmpty()) return null;
  const iconDataUrl = image.toDataURL();
  return iconDataUrl ? { iconDataUrl } : null;
}

export function createApplicationIconLoader(dependencies: ApplicationIconLoaderDependencies) {
  return async (request: string | ApplicationIconRequest): Promise<ApplicationIconInfo | null> => {
    const normalized = normalizedRequest(request, dependencies.platform);
    if (!normalized) return null;
    const locators = [...normalized.locators].sort(
      (left, right) =>
        Number(right.kind === "windows-aumid") - Number(left.kind === "windows-aumid"),
    );
    for (const locator of locators) {
      const value = locator.value.trim();
      try {
        if (
          locator.kind === "darwin-bundle-id" &&
          dependencies.platform === "darwin" &&
          SAFE_BUNDLE_ID.test(value)
        ) {
          const appPath = await dependencies.resolveDarwinApplicationPath(value);
          if (!appPath) continue;
          const iconDataUrl = await getAppIconDataUrl(value, appPath);
          if (iconDataUrl) return { iconDataUrl };
        }
        if (
          locator.kind === "windows-aumid" &&
          dependencies.platform === "win32" &&
          dependencies.readWindowsAumidIcon
        ) {
          const icon = await dependencies.readWindowsAumidIcon(value);
          if (icon) return icon;
        }
        if (
          locator.kind === "windows-executable-path" &&
          dependencies.platform === "win32" &&
          isSafeWindowsExecutablePath(value) &&
          win32.basename(value).toLowerCase() !== "applicationframehost.exe"
        ) {
          const icon = await readFileIcon(value, dependencies);
          if (icon) return icon;
        }
      } catch (error) {
        logger.warn("[application-icons] 读取应用图标失败", {
          locatorKind: locator.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return null;
  };
}

const loadApplicationIcon = createApplicationIconLoader(defaultApplicationIconLoaderDependencies);

export function getApplicationIcon(
  request: string | ApplicationIconRequest,
): Promise<ApplicationIconInfo | null> {
  const normalized = normalizedRequest(request, process.platform);
  if (!normalized) return Promise.resolve(null);
  const cacheKey = normalized.locators.map(locatorCacheKey).join("|");
  const cached = applicationIconCache.get(cacheKey);
  if (cached) return cached;
  const pending = loadApplicationIcon(normalized);
  applicationIconCache.set(cacheKey, pending);
  return pending;
}
