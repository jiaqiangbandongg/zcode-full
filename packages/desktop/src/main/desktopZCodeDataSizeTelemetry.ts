import armsRum from "@arms/rum-electron";
import type { ArmsRumEnv, FinalArmsCustomEventPayload } from "@zcode/shared";

import type { ZCodeDataSizeScanResult } from "./zcodeDataSizeScanner.js";
import {
  readZCodeDataSizeTelemetryState,
  writeZCodeDataSizeTelemetryState,
  type ZCodeDataSizeTelemetryState,
} from "./zcodeDataSizeTelemetryState.js";
import { scanZCodeDataDirectoryInWorker } from "./zcodeDataSizeWorkerClient.js";

export type { ZCodeDataSizeTelemetryState } from "./zcodeDataSizeTelemetryState.js";

export const ZCODE_DATA_SIZE_SCAN_MAX_DURATION_MS = 30_000;
export const ZCODE_DATA_SIZE_SCAN_MAX_FILES = 200_000;
export const ZCODE_DATA_SIZE_DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const ZCODE_DATA_SIZE_IDLE_POLL_MS = 5 * 60 * 1000;
export const ZCODE_DATA_SIZE_IDLE_WAIT_FALLBACK_MS = 6 * 60 * 60 * 1000;
export const ZCODE_DATA_SIZE_MINIMUM_IDLE_SECONDS = 5 * 60;
export const ZCODE_DATA_SIZE_STARTUP_MIN_DELAY_MS = 2 * 60 * 1000;
export const ZCODE_DATA_SIZE_STARTUP_JITTER_MAX_MS = 8 * 60 * 1000;
export const ZCODE_DATA_SIZE_DAILY_JITTER_MAX_MS = 60 * 60 * 1000;
export const ZCODE_DATA_SIZE_ABORTED_RETRY_MS = 30 * 60 * 1000;
export const ZCODE_DATA_SIZE_FAILURE_RETRY_MS = 6 * 60 * 60 * 1000;
export const ZCODE_DATA_SIZE_ACTIVITY_POLL_MS = 1_000;

interface ZCodeDataSizeTelemetryTiming {
  abortedRetryMs: number;
  activityPollMs: number;
  dailyIntervalMs: number;
  dailyJitterMaxMs: number;
  failureRetryMs: number;
  idlePollMs: number;
  idleWaitFallbackMs: number;
  minimumIdleSeconds: number;
  startupJitterMaxMs: number;
  startupMinDelayMs: number;
}

const DEFAULT_TIMING: ZCodeDataSizeTelemetryTiming = {
  abortedRetryMs: ZCODE_DATA_SIZE_ABORTED_RETRY_MS,
  activityPollMs: ZCODE_DATA_SIZE_ACTIVITY_POLL_MS,
  dailyIntervalMs: ZCODE_DATA_SIZE_DAILY_INTERVAL_MS,
  dailyJitterMaxMs: ZCODE_DATA_SIZE_DAILY_JITTER_MAX_MS,
  failureRetryMs: ZCODE_DATA_SIZE_FAILURE_RETRY_MS,
  idlePollMs: ZCODE_DATA_SIZE_IDLE_POLL_MS,
  idleWaitFallbackMs: ZCODE_DATA_SIZE_IDLE_WAIT_FALLBACK_MS,
  minimumIdleSeconds: ZCODE_DATA_SIZE_MINIMUM_IDLE_SECONDS,
  startupJitterMaxMs: ZCODE_DATA_SIZE_STARTUP_JITTER_MAX_MS,
  startupMinDelayMs: ZCODE_DATA_SIZE_STARTUP_MIN_DELAY_MS,
};

interface ZCodeDataSizeTelemetryLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface ZCodeDataSizeTelemetrySchedulerDependencies {
  deviceMid: string;
  getSystemIdleTimeSeconds: () => number;
  isAppBackground: () => boolean;
  isZCodeBusy: () => boolean;
  logger: ZCodeDataSizeTelemetryLogger;
  readState: () => Promise<ZCodeDataSizeTelemetryState | null>;
  report: (result: ZCodeDataSizeScanResult) => Promise<void> | void;
  scan: (options: { signal: AbortSignal }) => Promise<ZCodeDataSizeScanResult>;
  timing?: Partial<ZCodeDataSizeTelemetryTiming>;
  writeState: (state: ZCodeDataSizeTelemetryState) => Promise<void>;
}

function normalizeOsCategory(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

function stringifyProperties(
  properties: Record<string, string | number | boolean | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(properties)
      .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
      .map(([key, value]) => [key, String(value)]),
  );
}

export function buildZCodeDataSizeArmsPayload(params: {
  context: {
    appVersion: string;
    armsEnv: ArmsRumEnv;
    dataRootKind: "custom" | "default";
    deviceMid: string;
    platform: NodeJS.Platform;
  };
  result: ZCodeDataSizeScanResult;
}): FinalArmsCustomEventPayload {
  const eventName = "perf_resource_zcode_data_size";
  return {
    group: "resource",
    name: eventName,
    properties: stringifyProperties({
      app_version: params.context.appVersion,
      arms_env: params.context.armsEnv,
      data_root_kind: params.context.dataRootKind,
      device_mid: params.context.deviceMid,
      directories_scanned: params.result.directoriesScanned,
      event_name: eventName,
      files_scanned: params.result.filesScanned,
      metric_kind: "zcode_data_bytes",
      metric_value: params.result.bytes,
      partial_reason: params.result.partialReason,
      platform: normalizeOsCategory(params.context.platform),
      scan_duration_ms: params.result.durationMs,
      scan_error_count: params.result.scanErrorCount,
      scan_status: params.result.status,
      schema_version: 1,
      zcode_data_bytes: params.result.bytes,
    }),
    type: "custom",
    value: params.result.bytes,
  };
}

function stableJitterMs(deviceMid: string, bucketAt: number, maxMs: number): number {
  if (maxMs <= 0) {
    return 0;
  }
  const key = `${deviceMid}:${Math.floor(bucketAt / ZCODE_DATA_SIZE_DAILY_INTERVAL_MS)}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % (Math.floor(maxMs) + 1);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof timer === "object") {
    timer.unref?.();
  }
}

export function createZCodeDataSizeTelemetryScheduler(
  dependencies: ZCodeDataSizeTelemetrySchedulerDependencies,
): { start: () => Promise<void>; stop: () => void } {
  const timing = { ...DEFAULT_TIMING, ...dependencies.timing };
  let scheduledTimer: ReturnType<typeof setTimeout> | null = null;
  let activityTimer: ReturnType<typeof setInterval> | null = null;
  let activeAbortController: AbortController | null = null;
  let idleWaitingSince: number | null = null;
  let persistedState: ZCodeDataSizeTelemetryState | null = null;
  let stopped = true;

  function clearScheduledTimer(): void {
    if (scheduledTimer) {
      clearTimeout(scheduledTimer);
      scheduledTimer = null;
    }
  }

  function clearActivityTimer(): void {
    if (activityTimer) {
      clearInterval(activityTimer);
      activityTimer = null;
    }
  }

  function schedule(delayMs: number, callback = evaluateDueCollection): void {
    if (stopped) {
      return;
    }
    clearScheduledTimer();
    scheduledTimer = setTimeout(
      () => {
        scheduledTimer = null;
        void callback();
      },
      Math.max(0, delayMs),
    );
    unrefTimer(scheduledTimer);
  }

  function isPreferredIdleWindow(): boolean {
    try {
      return (
        dependencies.getSystemIdleTimeSeconds() >= timing.minimumIdleSeconds &&
        dependencies.isAppBackground()
      );
    } catch {
      return false;
    }
  }

  function collectionEligibilityLost(relaxedIdle: boolean): boolean {
    try {
      return dependencies.isZCodeBusy() || (!relaxedIdle && !isPreferredIdleWindow());
    } catch {
      return true;
    }
  }

  async function persistSuccess(reportedAt: number): Promise<void> {
    try {
      const nextState = { lastReportedAt: reportedAt };
      await dependencies.writeState(nextState);
      persistedState = nextState;
    } catch (error) {
      dependencies.logger.warn("[zcode-data-size] failed to persist report state", error);
    }
  }

  async function reserveReport(reservedAt: number): Promise<ZCodeDataSizeTelemetryState | null> {
    const previousState = persistedState;
    const reservation = { ...previousState, reportReservedAt: reservedAt };
    // Bug 根因：旧实现先发送再落盘，落盘失败后重启会再次发送，绕过 24 小时限流。
    // 发送前先原子写入 reservation；即使进程随后退出，也只会少一个样本，不会重复上报。
    await dependencies.writeState(reservation);
    persistedState = reservation;
    return previousState;
  }

  async function rollbackReportReservation(
    previousState: ZCodeDataSizeTelemetryState | null,
  ): Promise<void> {
    try {
      const restoredState = previousState ?? {};
      await dependencies.writeState(restoredState);
      persistedState = previousState;
    } catch (error) {
      dependencies.logger.warn("[zcode-data-size] failed to roll back report reservation", error);
    }
  }

  async function collectAndReport(relaxedIdle: boolean): Promise<void> {
    const abortController = new AbortController();
    activeAbortController = abortController;
    activityTimer = setInterval(
      () => {
        if (collectionEligibilityLost(relaxedIdle)) {
          // 修复原因：开始扫描后用户可能恢复操作或新任务开始；仅在启动前检查会让 30 秒扫描
          // 继续和用户工作争抢 IO，因此直接终止 Worker 并延后重试。
          abortController.abort();
        }
      },
      Math.max(1, timing.activityPollMs),
    );
    unrefTimer(activityTimer);

    try {
      const result = await dependencies.scan({ signal: abortController.signal });
      if (stopped) {
        return;
      }
      if (abortController.signal.aborted || collectionEligibilityLost(relaxedIdle)) {
        // Bug 根因：Worker 可能在下一次 activity poll 前结束；若任务恰在这个窗口启动，
        // 旧实现会跳过 busy 检查直接上报。发送前同步复查，关闭该 TOCTOU 窗口。
        abortController.abort();
        throw new DOMException("ZCode data size scan eligibility lost", "AbortError");
      }
      const reportReservedAt = Date.now();
      const previousState = await reserveReport(reportReservedAt);
      if (stopped) {
        await rollbackReportReservation(previousState);
        return;
      }
      if (abortController.signal.aborted || collectionEligibilityLost(relaxedIdle)) {
        await rollbackReportReservation(previousState);
        abortController.abort();
        throw new DOMException("ZCode data size report eligibility lost", "AbortError");
      }
      try {
        await dependencies.report(result);
      } catch (error) {
        await rollbackReportReservation(previousState);
        throw error;
      }
      const reportedAt = Date.now();
      await persistSuccess(reportedAt);
      idleWaitingSince = null;
      dependencies.logger.info(
        `[zcode-data-size] reported status=${result.status} bytes=${result.bytes}`,
      );
      schedule(
        timing.dailyIntervalMs +
          stableJitterMs(
            dependencies.deviceMid,
            reportedAt + timing.dailyIntervalMs,
            timing.dailyJitterMaxMs,
          ),
      );
    } catch (error) {
      if (stopped) {
        return;
      }
      const aborted = abortController.signal.aborted || isAbortError(error);
      dependencies.logger.warn(
        `[zcode-data-size] ${aborted ? "scan aborted" : "scan/report failed"}`,
        error,
      );
      schedule(aborted ? timing.abortedRetryMs : timing.failureRetryMs);
    } finally {
      clearActivityTimer();
      if (activeAbortController === abortController) {
        activeAbortController = null;
      }
    }
  }

  async function evaluateDueCollection(): Promise<void> {
    if (stopped || activeAbortController) {
      return;
    }
    const now = Date.now();
    idleWaitingSince ??= now;
    const relaxedIdle = now - idleWaitingSince >= timing.idleWaitFallbackMs;
    if (dependencies.isZCodeBusy()) {
      schedule(timing.idlePollMs);
      return;
    }
    if (!relaxedIdle && !isPreferredIdleWindow()) {
      schedule(timing.idlePollMs);
      return;
    }
    await collectAndReport(relaxedIdle);
  }

  async function initializeFromPersistedState(): Promise<void> {
    let state: ZCodeDataSizeTelemetryState | null;
    try {
      state = await dependencies.readState();
    } catch (error) {
      // Bug 根因：状态读取失败不等于没有历史状态；按首次启动继续采集会绕过持久化限流。
      // 无法确认配额时保持 fail-closed，并且只重试状态读取，不进入采集调度。
      dependencies.logger.warn("[zcode-data-size] failed to read report state", error);
      schedule(timing.failureRetryMs, initializeFromPersistedState);
      return;
    }
    if (stopped) {
      return;
    }
    persistedState = state;

    const now = Date.now();
    const rateLimitAnchor = Math.max(
      state?.lastReportedAt ?? Number.NEGATIVE_INFINITY,
      state?.reportReservedAt ?? Number.NEGATIVE_INFINITY,
    );
    if (Number.isFinite(rateLimitAnchor)) {
      const baseDueAt = rateLimitAnchor + timing.dailyIntervalMs;
      // Bug 根因：旧实现先用未加 jitter 的 baseDueAt 判断是否到期；应用在 jitter
      // 窗口内重启时会改走 startup jitter，破坏跨重启的稳定错峰。
      const dueAt =
        baseDueAt + stableJitterMs(dependencies.deviceMid, baseDueAt, timing.dailyJitterMaxMs);
      if (dueAt > now) {
        schedule(dueAt - now);
        return;
      }
    }
    schedule(
      timing.startupMinDelayMs +
        stableJitterMs(dependencies.deviceMid, now, timing.startupJitterMaxMs),
    );
  }

  return {
    async start() {
      if (!stopped) {
        return;
      }
      stopped = false;
      await initializeFromPersistedState();
    },

    stop() {
      stopped = true;
      clearScheduledTimer();
      clearActivityTimer();
      activeAbortController?.abort();
      activeAbortController = null;
    },
  };
}

let desktopScheduler: ReturnType<typeof createZCodeDataSizeTelemetryScheduler> | null = null;

export function registerDesktopZCodeDataSizeTelemetry(options: {
  context: Parameters<typeof buildZCodeDataSizeArmsPayload>[0]["context"];
  getSystemIdleTimeSeconds: () => number;
  isAppBackground: () => boolean;
  isZCodeBusy: () => boolean;
  logger: ZCodeDataSizeTelemetryLogger;
  rootPath: string;
  stateFile: string;
}): void {
  stopDesktopZCodeDataSizeTelemetry();
  desktopScheduler = createZCodeDataSizeTelemetryScheduler({
    deviceMid: options.context.deviceMid,
    getSystemIdleTimeSeconds: options.getSystemIdleTimeSeconds,
    isAppBackground: options.isAppBackground,
    isZCodeBusy: options.isZCodeBusy,
    logger: options.logger,
    readState: () => readZCodeDataSizeTelemetryState(options.stateFile),
    report: (result) => {
      const payload = buildZCodeDataSizeArmsPayload({ context: options.context, result });
      armsRum.sendCustom({
        group: payload.group,
        name: payload.name,
        properties: payload.properties,
        type: payload.type,
        value: payload.value,
      });
    },
    scan: ({ signal }) =>
      scanZCodeDataDirectoryInWorker(
        {
          maxDurationMs: ZCODE_DATA_SIZE_SCAN_MAX_DURATION_MS,
          maxFiles: ZCODE_DATA_SIZE_SCAN_MAX_FILES,
          rootPath: options.rootPath,
        },
        signal,
      ),
    writeState: (state) => writeZCodeDataSizeTelemetryState(options.stateFile, state),
  });
  void desktopScheduler.start().catch((error) => {
    options.logger.warn("[zcode-data-size] scheduler start failed", error);
  });
}

export function stopDesktopZCodeDataSizeTelemetry(): void {
  desktopScheduler?.stop();
  desktopScheduler = null;
}
