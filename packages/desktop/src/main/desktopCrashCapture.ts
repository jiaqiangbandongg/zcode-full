import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { app, crashReporter, type BrowserWindow, type WebContents } from "electron";
import { getAppConfigDir } from "@zcode/services/node";
import {
  type CrashDumpV8OomSummary,
  readCrashDumpAnnotationsFromFile,
  summarizeCrashDumpAnnotations,
} from "./crashDumpAnnotations.js";

const LOCAL_ONLY_CRASH_SUBMIT_URL = "https://zcode.invalid/local-crash-only";
const CRASH_DUMP_STABLE_AFTER_MS = 1_000;
const CRASH_ARCHIVE_RETRY_DELAYS_MS = [1_500, 5_000] as const;
const CRASH_ARCHIVE_MAX_FILES = 5;
const CRASH_ARCHIVE_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

interface CrashCaptureLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface CrashCapturePaths {
  rootDir: string;
  stagingDir: string;
  archiveDir: string;
}

interface CrashArchiveRetentionPolicy {
  maxFiles: number;
  maxTotalBytes: number;
}

interface CrashArchiveCleanupResult {
  deletedFiles: string[];
  failedFiles: string[];
}

export interface ArchivedCrashDumpRecord {
  dumpPath: string;
  archivedDumpPath: string;
  /** dump 里没有 V8 OOM 注解（例如 GPU / native 崩溃）时为 null。 */
  v8OomSummary: CrashDumpV8OomSummary | null;
}

function resolveCrashCapturePaths(): CrashCapturePaths {
  const rootDir = join(getAppConfigDir(), "crash");
  return {
    rootDir,
    stagingDir: join(rootDir, "live"),
    archiveDir: join(rootDir, "archive"),
  };
}

export function resolveCrashReporterSourceDirs(
  stagingDir: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const dirs = [join(stagingDir, platform === "win32" ? "reports" : "completed")];

  if (platform === "darwin") {
    dirs.push(join(stagingDir, "pending"));
  }

  return dirs;
}

function isStableCrashDump(path: string, nowMs: number): boolean {
  try {
    const stats = statSync(path);
    return nowMs - stats.mtimeMs >= CRASH_DUMP_STABLE_AFTER_MS;
  } catch {
    return false;
  }
}

function persistArchivedCrashDump(
  dumpPath: string,
  archiveDir: string,
  archivedAt: Date,
): ArchivedCrashDumpRecord | null {
  const fileName = basename(dumpPath);
  const archivedDumpPath = join(archiveDir, fileName);
  if (existsSync(archivedDumpPath)) {
    return null;
  }

  const sourceStats = statSync(dumpPath);
  copyFileSync(dumpPath, archivedDumpPath);
  // copyFileSync 会把归档 mtime 改成复制时间，启动批量恢复时会按遍历顺序误删较新的 crash。
  // 保留原始 dump 时间，使归档清理始终按实际 crash 先后排序。
  utimesSync(archivedDumpPath, sourceStats.atime, sourceStats.mtime);
  // 取证目的：白屏/崩溃排查只能拿到日志包，dump 本身要靠 crashpad 注解才能分辨
  // “JS 堆撞上限”还是“JIT 代码区耗尽”。解析失败只影响取证信息，绝不阻断归档。
  const annotations = readCrashDumpAnnotationsFromFile(archivedDumpPath, sourceStats.size);
  const v8OomSummary = summarizeCrashDumpAnnotations(annotations);
  writeFileSync(
    join(archiveDir, `${fileName}.json`),
    JSON.stringify(
      {
        archivedAt: archivedAt.toISOString(),
        originalPath: dumpPath,
        ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
        ...(v8OomSummary ? { v8OomSummary } : {}),
      },
      null,
      2,
    ),
    "utf-8",
  );
  return { dumpPath, archivedDumpPath, v8OomSummary };
}

function pruneCrashDumpArchive(
  archiveDir: string,
  policy: CrashArchiveRetentionPolicy,
): CrashArchiveCleanupResult {
  // 启动时必须先完成本地留档与清理，再让 ARMS 扫描并删除 live；这里保持与既有归档一致的
  // 同步临界区，避免异步 IO 改变 appCrashCaptureBootstrap -> appARMSBootstrap 的先后顺序。
  const deletedFiles: string[] = [];
  const failedFiles: string[] = [];
  const dumps: Array<{ entry: string; path: string; mtimeMs: number; size: number }> = [];
  const dumpEntries = new Set<string>();
  const metadataFiles: Array<{ dumpEntry: string; path: string }> = [];

  try {
    for (const entry of readdirSync(archiveDir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }

      if (entry.name.endsWith(".dmp.json")) {
        metadataFiles.push({
          dumpEntry: entry.name.slice(0, -".json".length),
          path: join(archiveDir, entry.name),
        });
        continue;
      }

      if (!entry.name.endsWith(".dmp")) {
        continue;
      }

      dumpEntries.add(entry.name);
      const path = join(archiveDir, entry.name);
      try {
        const stats = statSync(path);
        dumps.push({ entry: entry.name, path, mtimeMs: stats.mtimeMs, size: stats.size });
      } catch {
        failedFiles.push(path);
      }
    }
  } catch {
    return { deletedFiles, failedFiles: [archiveDir] };
  }

  dumps.sort(
    (left, right) => right.mtimeMs - left.mtimeMs || left.entry.localeCompare(right.entry),
  );

  const maxFiles = Math.max(1, policy.maxFiles);
  const maxTotalBytes = Math.max(0, policy.maxTotalBytes);
  let keptCount = dumps.length;
  let keptBytes = dumps.reduce((total, dump) => total + dump.size, 0);
  const dumpsToDelete: typeof dumps = [];

  while (keptCount > 1 && (keptCount > maxFiles || keptBytes > maxTotalBytes)) {
    const dump = dumps[keptCount - 1];
    dumpsToDelete.push(dump);
    keptCount -= 1;
    keptBytes -= dump.size;
  }

  for (const dump of dumpsToDelete) {
    // 本地 crash archive 必须有容量边界，否则历史 dump 会永久累积。
    // 清理只作用于已复制成功的 archive，绝不触碰仍由 Crashpad 管理的 live 文件。
    try {
      unlinkSync(dump.path);
      deletedFiles.push(dump.path);
    } catch {
      failedFiles.push(dump.path);
      continue;
    }

    const metadataPath = `${dump.path}.json`;
    if (existsSync(metadataPath)) {
      try {
        unlinkSync(metadataPath);
        deletedFiles.push(metadataPath);
      } catch {
        failedFiles.push(metadataPath);
      }
    }
  }

  for (const metadata of metadataFiles) {
    if (dumpEntries.has(metadata.dumpEntry)) {
      continue;
    }

    // 旧 dump 删除成功但元数据删除失败后，下一轮已无法从 dump 集合再次触达元数据。
    // 每轮重新扫描孤立的普通 .dmp.json，使暂时性删除失败能够继续收敛，同时不触碰其他 JSON。
    try {
      unlinkSync(metadata.path);
      deletedFiles.push(metadata.path);
    } catch {
      failedFiles.push(metadata.path);
    }
  }

  return { deletedFiles, failedFiles };
}

export function archiveCrashDumps(
  paths: CrashCapturePaths,
  options?: {
    platform?: NodeJS.Platform;
    now?: Date;
    retention?: CrashArchiveRetentionPolicy;
  },
): {
  archivedFiles: string[];
  archivedDumps: ArchivedCrashDumpRecord[];
  skippedFiles: string[];
  deletedArchiveFiles: string[];
  failedArchiveFiles: string[];
} {
  mkdirSync(paths.archiveDir, { recursive: true });

  const platform = options?.platform ?? process.platform;
  const now = options?.now ?? new Date();
  const nowMs = now.getTime();
  const archivedFiles: string[] = [];
  const archivedDumps: ArchivedCrashDumpRecord[] = [];
  const skippedFiles: string[] = [];

  for (const dir of resolveCrashReporterSourceDirs(paths.stagingDir, platform)) {
    if (!existsSync(dir)) {
      continue;
    }

    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".dmp")) {
        continue;
      }

      const dumpPath = join(dir, entry);
      if (!isStableCrashDump(dumpPath, nowMs)) {
        skippedFiles.push(dumpPath);
        continue;
      }

      try {
        const record = persistArchivedCrashDump(dumpPath, paths.archiveDir, now);
        if (record) {
          archivedFiles.push(dumpPath);
          archivedDumps.push(record);
        }
      } catch {
        skippedFiles.push(dumpPath);
      }
    }
  }

  const cleanupResult = pruneCrashDumpArchive(
    paths.archiveDir,
    options?.retention ?? {
      maxFiles: CRASH_ARCHIVE_MAX_FILES,
      maxTotalBytes: CRASH_ARCHIVE_MAX_TOTAL_BYTES,
    },
  );

  return {
    archivedFiles,
    archivedDumps,
    skippedFiles,
    deletedArchiveFiles: cleanupResult.deletedFiles,
    failedArchiveFiles: cleanupResult.failedFiles,
  };
}

let hasStartedLocalCrashReporter = false;
let registeredCrashEventMonitor = false;

function logCrashArchiveCleanup(
  logger: CrashCaptureLogger,
  result: { deletedArchiveFiles: string[]; failedArchiveFiles: string[] },
  source: string,
): void {
  if (result.deletedArchiveFiles.length > 0) {
    logger.info(
      `[crash-capture] pruned ${result.deletedArchiveFiles.length} archive file(s) source=${source}`,
    );
  }
  if (result.failedArchiveFiles.length > 0) {
    logger.warn(
      `[crash-capture] failed to prune ${result.failedArchiveFiles.length} archive file(s) source=${source}`,
      result.failedArchiveFiles,
    );
  }
}

function logArchivedCrashDumpSummaries(
  logger: CrashCaptureLogger,
  result: { archivedDumps: ArchivedCrashDumpRecord[] },
  source: string,
): void {
  for (const record of result.archivedDumps) {
    const dump = basename(record.archivedDumpPath);
    if (record.v8OomSummary) {
      // 一行看清是哪种 OOM：code_space_exhausted 说明 256MB JIT 代码区被占满，
      // js_heap_exhausted 才是普通的 JS 堆泄漏；具体数值同时落在 archive 的 .dmp.json 里。
      logger.warn(
        `[crash-capture] v8 oom annotations source=${source} dump=${dump}`,
        record.v8OomSummary,
      );
    } else {
      logger.info(`[crash-capture] archived dump has no v8 oom annotations dump=${dump}`);
    }
  }
}

function scheduleCrashArchive(
  logger: CrashCaptureLogger,
  paths: CrashCapturePaths,
  source: string,
) {
  for (const delayMs of CRASH_ARCHIVE_RETRY_DELAYS_MS) {
    const timer = setTimeout(() => {
      const result = archiveCrashDumps(paths);
      if (result.archivedFiles.length > 0) {
        logger.info(
          `[crash-capture] archived ${result.archivedFiles.length} dump(s) source=${source} delayMs=${delayMs}`,
        );
      }
      logArchivedCrashDumpSummaries(logger, result, source);
      logCrashArchiveCleanup(logger, result, source);
    }, delayMs);
    timer.unref?.();
  }
}

export function initializeCrashCapture(
  logger: CrashCaptureLogger,
  remoteCrashReporterEnabled: boolean,
): CrashCapturePaths {
  const paths = resolveCrashCapturePaths();
  mkdirSync(paths.rootDir, { recursive: true });
  mkdirSync(paths.stagingDir, { recursive: true });
  mkdirSync(paths.archiveDir, { recursive: true });
  app.setPath("crashDumps", paths.stagingDir);

  const startupArchiveResult = archiveCrashDumps(paths);
  logCrashArchiveCleanup(logger, startupArchiveResult, "startup");
  if (startupArchiveResult.archivedFiles.length > 0) {
    logger.info(
      `[crash-capture] restored ${startupArchiveResult.archivedFiles.length} local dump(s) from previous runs`,
    );
  }
  logArchivedCrashDumpSummaries(logger, startupArchiveResult, "startup");

  if (!remoteCrashReporterEnabled && !hasStartedLocalCrashReporter) {
    hasStartedLocalCrashReporter = true;
    crashReporter.start({
      companyName: "",
      productName: app.name || app.getName(),
      submitURL: LOCAL_ONLY_CRASH_SUBMIT_URL,
      uploadToServer: false,
      compress: true,
    });
    logger.info("[crash-capture] local crashReporter started without remote upload");
  }

  logger.info(
    `[crash-capture] configured remoteCrashReporterEnabled=${String(remoteCrashReporterEnabled)} stagingDir=${paths.stagingDir} archiveDir=${paths.archiveDir}`,
  );
  return paths;
}

export interface CrashEventMonitorHooks {
  onRenderProcessGone?: (
    webContents: WebContents,
    details: { reason: string; exitCode: number },
  ) => void;
  onChildProcessGone?: (details: {
    type: string;
    reason: string;
    exitCode: number;
    serviceName?: string;
    name?: string;
  }) => void;
  onBrowserWindowCreated?: (win: BrowserWindow) => void;
}

export function resolveProcessGoneLogLevel(reason: string): "info" | "warn" {
  // Bug 原因：Electron 也会为 clean-exit / killed 这类受控终止发送 gone 事件。
  // 原始 gone 回调只记录生命周期事实，最终是否为 crash 交给稳定性分类；旧实现无条件打
  // error，随后被 ARMS console collector 当作异常，污染错误统计。
  return reason === "clean-exit" || reason === "killed" ? "info" : "warn";
}

export function registerCrashEventMonitor(
  logger: CrashCaptureLogger,
  paths: CrashCapturePaths,
  hooks?: CrashEventMonitorHooks,
): void {
  if (registeredCrashEventMonitor) {
    return;
  }
  registeredCrashEventMonitor = true;

  app.on("render-process-gone", (_event, webContents, details) => {
    logger[resolveProcessGoneLogLevel(details.reason)]("[crash-capture] render-process-gone:", {
      webContentsId: webContents.id,
      reason: details.reason,
      exitCode: details.exitCode,
      name: webContents.getType(),
      url: webContents.getURL(),
    });
    hooks?.onRenderProcessGone?.(webContents, details);
    // 远端 crash SDK 可能会在处理后清理 live 目录里的原始 dmp。
    // 这里在事件后补两次延迟归档，把原始 dump 复制到 ~/.zcode/v2/crash/archive，
    // 这样既保留线上上报，又能在本地留下一份可供排查的副本。
    scheduleCrashArchive(logger, paths, "render-process-gone");
  });

  app.on("child-process-gone", (_event, details) => {
    logger[resolveProcessGoneLogLevel(details.reason)](
      "[crash-capture] child-process-gone:",
      details,
    );
    hooks?.onChildProcessGone?.(details);
    scheduleCrashArchive(logger, paths, "child-process-gone");
  });

  app.on("browser-window-created", (_, win) => {
    hooks?.onBrowserWindowCreated?.(win);
    if (!hooks?.onBrowserWindowCreated) {
      win.webContents.on("unresponsive", () => {
        logger.warn("[crash-capture] window became unresponsive:", {
          windowId: win.id,
          webContentsId: win.webContents.id,
          url: win.webContents.getURL(),
        });
      });
    }
  });
}
