import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  type WebRemoteControlFailure,
} from "@zcode/shared";
import {
  parseWebRemoteControlRelayV2IncomingMessage,
  type WebRemoteControlRelayV2IncomingMessage,
  type WebRemoteControlRelayV2OutgoingMessage,
} from "@zcode/shared/web-remote-relay";

export async function readWebSocketData(data: unknown): Promise<string | null> {
  if (typeof data === "string") {
    return new TextEncoder().encode(data).byteLength <=
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
      ? data
      : null;
  }
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
      return null;
    }
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    if (data.byteLength > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
      return null;
    }
    return new TextDecoder().decode(data as Uint8Array);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    if (data.size > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
      return null;
    }
    return data.text();
  }
  const text = String(data);
  return new TextEncoder().encode(text).byteLength <=
    WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
    ? text
    : null;
}

export function webSocketDataByteLength(data: unknown): number {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return new TextEncoder().encode(String(data)).byteLength;
}

export async function parseRelayMessage(
  data: unknown,
): Promise<WebRemoteControlRelayV2IncomingMessage | null> {
  try {
    const text = await readWebSocketData(data);
    if (text === null) return null;
    return parseWebRemoteControlRelayV2IncomingMessage(JSON.parse(text));
  } catch {
    return null;
  }
}

export function createFailure(
  reason: WebRemoteControlFailure["reason"],
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
}

export function safePayloadMetadata(payload: unknown): Record<string, string | undefined> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  return {
    zcode_type: typeof record.zcode_type === "string" ? record.zcode_type : undefined,
    requestId: typeof record.requestId === "string" ? record.requestId : undefined,
    bridgeSessionId:
      typeof record.bridgeSessionId === "string" ? record.bridgeSessionId : undefined,
  };
}

export function isRawTransportCandidate(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const type = (payload as { zcode_type?: unknown }).zcode_type;
  return type === "rpc-frame" || type === "rpc-frame-ack";
}

export function summarizeRelayMessageForTrace(
  message:
    | WebRemoteControlRelayV2IncomingMessage
    | WebRemoteControlRelayV2OutgoingMessage
    | { type: "data"; payload: unknown },
): Record<string, unknown> {
  if (message.type === "pair_status_ack") {
    return { type: message.type, pair_status: message.pair_status };
  }
  if (message.type === "auth_init") {
    return { type: message.type };
  }
  if (message.type === "data") {
    return {
      type: message.type,
      payload: safePayloadMetadata(message.payload),
    };
  }
  if (message.type === "error") {
    return { type: message.type, code: message.code };
  }
  return { type: message.type };
}
