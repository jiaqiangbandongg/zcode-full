/* eslint-disable max-lines -- 网络指标采集/聚合/ARMS 上报 */
import armsRum from "@arms/rum-electron";
import { mapZCodeEnvToArmsRumEnv } from "@zcode/shared";
import type { NetworkObservation } from "@zcode/rpc";
import {
  flushInterfaceNetworkStats,
  ingestArmsApiEvent,
  recordNetworkObservation,
  resetNetworkTelemetryAggregator,
  type InterfaceNetworkStats,
} from "./networkTelemetryAggregator.js";
import { desktopRuntimeEnv } from "./desktopRuntimeEnv.js";

/** 与资源指标对齐：开发 1min、生产 5min 聚合上报 */
export const NETWORK_REPORT_INTERVAL_MS = desktopRuntimeEnv === "development" ? 60_000 : 300_000;

interface NetworkLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface NetworkGlobalContext {
  deviceMid: string;
  platform: NodeJS.Platform;
  appVersion: string;
  armsEnv: ReturnType<typeof mapZCodeEnvToArmsRumEnv>;
}

let globalContext: NetworkGlobalContext | null = null;
let reportTimer: ReturnType<typeof setInterval> | null = null;

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
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value === undefined) {
      continue;
    }
    result[key] = String(value);
  }
  return result;
}

function reportNetworkCustom(
  name: string,
  metricValue: number,
  properties: Record<string, string | number | boolean | undefined>,
): void {
  if (!globalContext) {
    return;
  }

  const payload = stringifyProperties({
    platform: normalizeOsCategory(globalContext.platform),
    app_version: globalContext.appVersion,
    arms_env: globalContext.armsEnv,
    device_mid: globalContext.deviceMid,
    ...properties,
  });

  try {
    armsRum.sendCustom({
      name,
      type: "custom",
      group: "network",
      value: metricValue,
      properties: payload,
    });
  } catch (error) {
    console.warn("[network] sendCustom failed:", name, error);
  }
}

function reportInterfaceStats(stats: InterfaceNetworkStats): void {
  reportNetworkCustom("perf_network_window", stats.duration.mean, {
    transport: stats.transport,
    interface: stats.interface,
    request_total: stats.requestTotal,
    success_count: stats.successCount,
    fail_count: stats.failCount,
    retry_count: stats.retryCount,
    // value 已表达 duration mean；阶段耗时只保留 mean，给 counts 与主错误归因留固定预算。
    duration_ms_peak: stats.duration.peak,
    duration_ms_p95: stats.duration.p95,
    duration_ms_sample_count: stats.duration.sample_count,
    ...(stats.dns.sample_count > 0 ? { dns_ms_mean: stats.dns.mean } : {}),
    ...(stats.tcp.sample_count > 0 ? { tcp_ms_mean: stats.tcp.mean } : {}),
    ...(stats.tls.sample_count > 0 ? { tls_ms_mean: stats.tls.mean } : {}),
    ...(stats.ttfb.sample_count > 0 ? { ttfb_ms_mean: stats.ttfb.mean } : {}),
    ...(stats.download.sample_count > 0 ? { download_ms_mean: stats.download.mean } : {}),
    ...(stats.primaryErrorKind
      ? {
          primary_error_kind: stats.primaryErrorKind,
          primary_error_count: stats.primaryErrorCount,
        }
      : {}),
  });
}

function flushNetworkReports(logger: NetworkLogger): void {
  const stats = flushInterfaceNetworkStats();
  if (stats.length === 0) {
    return;
  }

  for (const item of stats) {
    reportInterfaceStats(item);
  }

  logger.info(`[network] perf_network flushed interfaces=${stats.length}`);
}

export function ingestArmsApiEventsFromBatch(
  events: Array<Record<string, unknown>> | undefined,
): void {
  if (!events?.length) {
    return;
  }
  for (const event of events) {
    ingestArmsApiEvent(event);
  }
}

export function ingestHostNetworkObservations(observations: NetworkObservation[]): void {
  for (const observation of observations) {
    recordNetworkObservation(observation);
  }
}

/** 远控 relay WebSocket：接口维度固定为 web_remote_control.relay */
export const WEB_REMOTE_RELAY_INTERFACE = "web_remote_control.relay";

export function noteWebRemoteRelayConnectAttempt(
  durationMs: number,
  ok: boolean,
  options?: { error?: unknown; attempt?: number },
): void {
  recordNetworkObservation({
    transport: "websocket",
    interface: WEB_REMOTE_RELAY_INTERFACE,
    durationMs: Math.max(0, Math.round(durationMs)),
    ok,
    errorKind: ok ? undefined : classifyWsError(options?.error),
    attempt: options?.attempt ?? 1,
  });
}

export function noteWebRemoteRelayReconnect(): void {
  recordNetworkObservation({
    transport: "websocket",
    interface: WEB_REMOTE_RELAY_INTERFACE,
    durationMs: 0,
    ok: false,
    errorKind: "connection_reset",
    attempt: 2,
  });
}

function classifyWsError(error: unknown): string {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("timeout") || message.includes("timed out")) {
    return "timeout";
  }
  if (message.includes("dns") || message.includes("getaddrinfo")) {
    return "dns_failure";
  }
  return "connection_reset";
}

export function configureDesktopNetworkTelemetry(context: NetworkGlobalContext): void {
  globalContext = context;
  armsRum.setConfig("properties", {
    device_mid: context.deviceMid,
    platform: normalizeOsCategory(context.platform),
    app_version: context.appVersion,
    arms_env: context.armsEnv,
  });
}

export function registerDesktopNetworkTelemetry(logger: NetworkLogger): void {
  stopDesktopNetworkTelemetry();
  resetNetworkTelemetryAggregator();

  reportTimer = setInterval(() => {
    try {
      flushNetworkReports(logger);
    } catch (error) {
      logger.warn("[network] report failed:", error);
    }
  }, NETWORK_REPORT_INTERVAL_MS);

  logger.info(`[network] reporting started interval=${NETWORK_REPORT_INTERVAL_MS}ms`);
}

export function stopDesktopNetworkTelemetry(): void {
  if (reportTimer) {
    clearInterval(reportTimer);
    reportTimer = null;
  }
}
