import type { ConnectionFlowControl, Event, IMessagePassingProtocol } from "@zcode/rpc";
import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  type WebRemoteControlRpcTransportFault,
  type WebRemoteControlRpcTransportFramePayload,
  type WebRemoteControlRpcTransportIdentity,
  type WebRemoteControlRpcTransportPayload,
} from "@zcode/shared";

export const ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS = {
  saturationHighWaterMarkBytes: 1024 * 1024,
  saturationLowWaterMarkBytes: 256 * 1024,
  replayBufferMaxBytes: 8 * 1024 * 1024,
  replayBufferGraceMs: 45_000,
  assemblyTimeoutMs: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.assemblyTimeoutMs,
} as const;

export interface AcknowledgedWebRemoteControlRelayProtocolOptions
  extends WebRemoteControlRpcTransportIdentity {
  sendFrame(payload: WebRemoteControlRpcTransportPayload): boolean | void;
  measureFrameBytes?(payload: WebRemoteControlRpcTransportFramePayload): number;
  saturationHighWaterMarkBytes?: number;
  saturationLowWaterMarkBytes?: number;
  replayBufferMaxBytes?: number;
  replayBufferGraceMs?: number;
  assemblyTimeoutMs?: number;
  now?: () => number;
}

export interface AcknowledgedWebRemoteControlRelayProtocolAdapter
  extends ConnectionFlowControl {
  readonly protocol: IMessagePassingProtocol;
  readonly onDegraded: Event<WebRemoteControlRpcTransportFault>;
  acceptPayload(payload: unknown): boolean;
  flushPendingFrames(): boolean;
  replayUnacknowledged(): boolean;
  getBridgeSessionId(): string;
  isDegraded(): boolean;
  markDegraded(reasonCode?: string): void;
  dispose(): void;
}

export interface AcknowledgedRelayOutboundBatch {
  readonly messageSeq: number;
  readonly frames: readonly WebRemoteControlRpcTransportFramePayload[];
  readonly outerBytes: number;
  readonly queuedAt: number;
  nextFrameIndex: number;
}

export function requirePositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

export function requireNonnegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer`);
  }
  return value;
}

export function rawIdentityMatches(
  identity: WebRemoteControlRpcTransportIdentity,
  candidate: unknown,
): boolean {
  if (typeof candidate !== "object" || candidate === null) return false;
  const value = candidate as Record<string, unknown>;
  return (
    value.bridgeSessionId === identity.bridgeSessionId &&
    value.bridgeGeneration === identity.bridgeGeneration &&
    value.recoveryId === identity.recoveryId
  );
}

export function isRawTransportCandidate(candidate: unknown): boolean {
  if (typeof candidate !== "object" || candidate === null) return false;
  const type = (candidate as { zcode_type?: unknown }).zcode_type;
  return type === "rpc-frame" || type === "rpc-frame-ack";
}

export function measureAcknowledgedRelayBatchBytes(
  frames: readonly WebRemoteControlRpcTransportFramePayload[],
  measureFrameBytes: (frame: WebRemoteControlRpcTransportFramePayload) => number,
): number {
  let total = 0;
  for (const frame of frames) {
    const frameBytes = measureFrameBytes(frame);
    if (
      !Number.isSafeInteger(frameBytes) ||
      frameBytes <= 0 ||
      frameBytes > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
    ) {
      throw new Error("invalid final envelope byte count");
    }
    total += frameBytes;
  }
  return total;
}

export interface AcknowledgedRelayResolvedLimits {
  highWaterMarkBytes: number;
  lowWaterMarkBytes: number;
  replayBufferMaxBytes: number;
  replayBufferGraceMs: number;
  assemblyTimeoutMs: number;
}

export function resolveAcknowledgedRelayLimits(
  options: AcknowledgedWebRemoteControlRelayProtocolOptions,
): AcknowledgedRelayResolvedLimits {
  const highWaterMarkBytes = requirePositiveSafeInteger(
    options.saturationHighWaterMarkBytes ??
      ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS.saturationHighWaterMarkBytes,
    "saturationHighWaterMarkBytes",
  );
  const lowWaterMarkBytes = requireNonnegativeSafeInteger(
    options.saturationLowWaterMarkBytes ??
      ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS.saturationLowWaterMarkBytes,
    "saturationLowWaterMarkBytes",
  );
  if (lowWaterMarkBytes > highWaterMarkBytes) {
    throw new Error("saturationLowWaterMarkBytes must not exceed high watermark");
  }
  return {
    highWaterMarkBytes,
    lowWaterMarkBytes,
    replayBufferMaxBytes: Math.min(
      requirePositiveSafeInteger(
        options.replayBufferMaxBytes ??
          ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS.replayBufferMaxBytes,
        "replayBufferMaxBytes",
      ),
      ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS.replayBufferMaxBytes,
    ),
    replayBufferGraceMs: Math.min(
      requirePositiveSafeInteger(
        options.replayBufferGraceMs ??
          ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS.replayBufferGraceMs,
        "replayBufferGraceMs",
      ),
      ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS.replayBufferGraceMs,
    ),
    assemblyTimeoutMs: Math.min(
      requirePositiveSafeInteger(
        options.assemblyTimeoutMs ??
          ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS.assemblyTimeoutMs,
        "assemblyTimeoutMs",
      ),
      ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS.assemblyTimeoutMs,
    ),
  };
}
