import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  type WebRemoteControlAppPayload,
  type WebRemoteControlRelayDataMessage,
} from "@zcode/shared";

export type WebRemoteControlPayloadSendResult =
  | { kind: "sent"; bytes: number }
  | { kind: "unavailable" }
  | { kind: "oversize"; bytes: number; maxBytes: number };

export interface SerializedWebRemoteControlRelayPayload {
  readonly message: WebRemoteControlRelayDataMessage<WebRemoteControlAppPayload>;
  readonly json: string;
  readonly bytes: number;
}

/**
 * 为同一个 immutable app payload 固定唯一 final relay JSON。
 *
 * Bugfix：旧路径在 meter 与 send 时分别调用 Date.now()/JSON.stringify，导致 replay accounting
 * 记录的并非 WebSocket 实际写入 bytes。WeakMap 让 cache 生命周期跟随 adapter 持有的 frame，
 * cumulative ACK 释放 frame 后即可被 GC，不形成第二个 replay owner。
 */
export class WebRemoteControlRelayPayloadSerializer {
  private readonly cache = new WeakMap<object, SerializedWebRemoteControlRelayPayload>();

  prepare(
    payload: WebRemoteControlAppPayload,
    clientTimestamp = Date.now(),
  ): SerializedWebRemoteControlRelayPayload {
    const cached = this.cache.get(payload);
    if (cached) return cached;
    const message: WebRemoteControlRelayDataMessage<WebRemoteControlAppPayload> = {
      type: "data",
      payload,
      client_ts: clientTimestamp,
    };
    const json = JSON.stringify(message);
    const prepared = Object.freeze({
      message,
      json,
      bytes: new TextEncoder().encode(json).byteLength,
    });
    this.cache.set(payload, prepared);
    return prepared;
  }

  isOversize(prepared: SerializedWebRemoteControlRelayPayload): boolean {
    return prepared.bytes > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes;
  }
}
