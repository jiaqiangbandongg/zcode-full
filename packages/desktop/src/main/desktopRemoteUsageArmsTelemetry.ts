import type {
  ArmsCustomEventPayload,
  ArmsRumEnv,
  FinalArmsCustomEventPayload,
  RemoteUsageErrorCategory,
  RemoteUsageRemoteKind,
  RemoteUsageResult,
  RemoteWorkspaceConnectTrigger,
} from "@zcode/shared";
import {
  dispatchFinalArmsCustomEvent,
  type FinalArmsCustomEventE2EController,
} from "./desktopArmsCustomEvent.js";

export const REMOTE_USAGE_ARMS_GROUP = "remote_usage";
export const REMOTE_USAGE_ARMS_EVENT_CONNECT_RESULT = "remote_connect_result";
export const REMOTE_USAGE_ARMS_EVENT_ACTIVE_SESSION_COUNT =
  "remote_active_session_count";
export const REMOTE_USAGE_ARMS_EVENT_DISCONNECT = "remote_disconnect";
export const REMOTE_USAGE_GAUGE_INTERVAL_MS = 300_000;

export interface RemoteConnectionStats {
  activeSessionCount: number;
  activeTargetCount: number;
}

export type RemoteGaugeTransition =
  | "connected"
  | "connection-closed"
  | "disposed"
  | "window-closed"
  | "host-exit"
  | "app-shutdown"
  | "none";

export type RemoteDisconnectReason = Exclude<
  RemoteGaugeTransition,
  "connected" | "none"
>;

interface RemoteUsageArmsTelemetryConfig {
  armsCustomContext: {
    deviceMid: string;
    platform: NodeJS.Platform;
    appVersion: string;
    armsEnv: ArmsRumEnv;
  };
  getRemoteConnectionStats: () => RemoteConnectionStats;
  sendCustom: (payload: FinalArmsCustomEventPayload) => void;
  e2eController?: FinalArmsCustomEventE2EController | null;
  logger: { warn: (...args: unknown[]) => void };
  setInterval?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
}

let telemetryConfig: RemoteUsageArmsTelemetryConfig | null = null;
let periodicTimer: ReturnType<typeof setInterval> | null = null;
let lastGaugeRendererId: number | null = null;

export function buildRemoteConnectResultArmsPayload(params: {
  result: RemoteUsageResult;
  remoteKind: RemoteUsageRemoteKind;
  connectTrigger: RemoteWorkspaceConnectTrigger;
  errorCategory?: RemoteUsageErrorCategory;
}): ArmsCustomEventPayload {
  return {
    name: REMOTE_USAGE_ARMS_EVENT_CONNECT_RESULT,
    group: REMOTE_USAGE_ARMS_GROUP,
    value: 1,
    properties: {
      result: params.result,
      remote_kind: params.remoteKind,
      connect_trigger: params.connectTrigger,
      error_category:
        params.result === "success" ? "" : (params.errorCategory ?? "unknown"),
    },
  };
}

export function buildRemoteActiveSessionCountArmsPayload(
  params: {
    sampleReason: "state-change" | "periodic";
    transition: RemoteGaugeTransition;
    remoteKind?: RemoteUsageRemoteKind;
  },
  stats: RemoteConnectionStats,
): ArmsCustomEventPayload {
  return {
    name: REMOTE_USAGE_ARMS_EVENT_ACTIVE_SESSION_COUNT,
    group: REMOTE_USAGE_ARMS_GROUP,
    value: stats.activeSessionCount,
    properties: {
      sample_reason: params.sampleReason,
      transition: params.transition,
      remote_kind: params.remoteKind ?? "",
      active_target_count: stats.activeTargetCount,
    },
  };
}

export function buildRemoteDisconnectArmsPayload(params: {
  remoteKind: RemoteUsageRemoteKind;
  disconnectReason: RemoteDisconnectReason;
  durationMs: number;
}): ArmsCustomEventPayload {
  return {
    name: REMOTE_USAGE_ARMS_EVENT_DISCONNECT,
    group: REMOTE_USAGE_ARMS_GROUP,
    value: params.durationMs,
    properties: {
      remote_kind: params.remoteKind,
      disconnect_reason: params.disconnectReason,
      duration_ms: params.durationMs,
    },
  };
}

export function configureRemoteUsageArmsTelemetry(
  config: RemoteUsageArmsTelemetryConfig,
): void {
  stopRemoteUsageArmsPeriodicSampling();
  telemetryConfig = config;
  const schedule = config.setInterval ?? setInterval;
  periodicTimer = schedule(reportPeriodicGauge, REMOTE_USAGE_GAUGE_INTERVAL_MS);
  periodicTimer.unref?.();
}

function dispatchSafely(
  rendererId: number,
  payload: ArmsCustomEventPayload,
): void {
  const config = telemetryConfig;
  if (!config) return;
  try {
    dispatchFinalArmsCustomEvent({
      payload,
      context: { ...config.armsCustomContext, rendererId },
      e2eController: config.e2eController,
      sendCustom: config.sendCustom,
    });
  } catch (error) {
    config.logger.warn("[remote-usage-arms] dispatch failed", {
      eventName: payload.name,
      error,
    });
  }
}

export function reportRemoteConnectResultToArms(params: {
  rendererId: number;
  result: RemoteUsageResult;
  remoteKind: RemoteUsageRemoteKind;
  connectTrigger: RemoteWorkspaceConnectTrigger;
  errorCategory?: RemoteUsageErrorCategory;
}): void {
  dispatchSafely(
    params.rendererId,
    buildRemoteConnectResultArmsPayload(params),
  );
}

function reportGauge(params: {
  rendererId: number;
  sampleReason: "state-change" | "periodic";
  transition: RemoteGaugeTransition;
  remoteKind?: RemoteUsageRemoteKind;
}): void {
  const config = telemetryConfig;
  if (!config) return;
  try {
    const stats = config.getRemoteConnectionStats();
    dispatchSafely(
      params.rendererId,
      buildRemoteActiveSessionCountArmsPayload(params, stats),
    );
  } catch (error) {
    config.logger.warn("[remote-usage-arms] read stats failed", { error });
  }
}

function reportPeriodicGauge(): void {
  const config = telemetryConfig;
  if (!config || lastGaugeRendererId == null) return;
  try {
    const stats = config.getRemoteConnectionStats();
    if (stats.activeSessionCount <= 0) return;
    dispatchSafely(
      lastGaugeRendererId,
      buildRemoteActiveSessionCountArmsPayload(
        { sampleReason: "periodic", transition: "none" },
        stats,
      ),
    );
  } catch (error) {
    config.logger.warn("[remote-usage-arms] periodic stats failed", { error });
  }
}

export function reportRemoteConnectionStateChangedToArms(params: {
  rendererId: number;
  transition: Exclude<RemoteGaugeTransition, "none">;
  remoteKind: RemoteUsageRemoteKind;
}): void {
  if (!telemetryConfig) return;
  lastGaugeRendererId = params.rendererId;
  reportGauge({
    ...params,
    sampleReason: "state-change",
  });
}

export function reportRemoteDisconnectToArms(params: {
  rendererId: number;
  remoteKind: RemoteUsageRemoteKind;
  disconnectReason: RemoteDisconnectReason;
  durationMs: number;
}): void {
  dispatchSafely(params.rendererId, buildRemoteDisconnectArmsPayload(params));
}

export function stopRemoteUsageArmsPeriodicSampling(): void {
  const timer = periodicTimer;
  if (!timer) return;
  (telemetryConfig?.clearInterval ?? clearInterval)(timer);
  periodicTimer = null;
}

export function resetRemoteUsageArmsTelemetryForTest(): void {
  stopRemoteUsageArmsPeriodicSampling();
  telemetryConfig = null;
  lastGaugeRendererId = null;
}
