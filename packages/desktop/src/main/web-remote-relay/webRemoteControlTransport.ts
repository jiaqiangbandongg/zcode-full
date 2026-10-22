import { WebSocket, type RawData } from "ws";
import {
  WebRemoteControlRelayPayloadSerializer,
  type WebRemoteControlPayloadSendResult,
} from "@zcode/client";
import {
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  parseWebRemoteControlAppPayload,
  type WebRemoteControlAppPayload,
} from "@zcode/shared";
import {
  WEB_REMOTE_CONTROL_V2_HEARTBEAT_ACK_TIMEOUT_MS,
  WebRemoteControlV2ConnectionError,
  WebRemoteControlV2Heartbeat,
  WebRemoteControlV2RetryPolicy,
  webRemoteControlV2PairState,
  parseWebRemoteControlRelayV2IncomingMessage,
  type WebRemoteControlRelayV2IncomingMessage,
  type WebRemoteControlRelayV2OutgoingMessage,
} from "@zcode/shared/web-remote-relay";
import {
  noteWebRemoteRelayConnectAttempt,
  noteWebRemoteRelayReconnect,
} from "#src/main/desktopNetworkTelemetry.js";

import type {
  WebRemoteControlDeviceTransportState,
  WebRemoteControlDeviceTransportOptions,
} from "#src/main/web-remote-relay/contract.js";

function rawBytes(raw: RawData): Buffer {
  return Array.isArray(raw)
    ? Buffer.concat(raw)
    : Buffer.from(raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw);
}

export class WebRemoteControlDeviceTransport {
  private socket?: WebSocket;
  private state: WebRemoteControlDeviceTransportState = "idle";
  private controller?: AbortController;
  private generation = 0;
  private pairedGeneration = 0;
  private connectStartedAt = 0;
  private connectAttempt = 0;
  private deviceSid?: string;
  private authenticated = false;
  private registrationRetried = false;
  private registrationPending = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private readonly retry = new WebRemoteControlV2RetryPolicy();
  private readonly heartbeat = new WebRemoteControlV2Heartbeat(
    () => this.send({ type: "pair_status_query", client_ts: Math.floor(Date.now() / 1000) }),
    () => this.scheduleReconnect(),
  );
  private readonly serializer = new WebRemoteControlRelayPayloadSerializer();

  constructor(private readonly options: WebRemoteControlDeviceTransportOptions) {}

  start(): void {
    if (this.controller) return;
    this.controller = new AbortController();
    void this.connect();
  }

  dispose(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.closeSocket();
    this.controller?.abort();
    this.controller = undefined;
    this.setState("idle");
  }

  measurePayloadBytes(payload: WebRemoteControlAppPayload): number {
    return this.serializer.prepare(payload, Math.floor(Date.now() / 1000)).bytes;
  }

  sendPayload(payload: WebRemoteControlAppPayload): boolean {
    return this.sendPayloadResult(payload).kind === "sent";
  }

  sendPayloadResult(payload: WebRemoteControlAppPayload): WebRemoteControlPayloadSendResult {
    const prepared = this.serializer.prepare(payload, Math.floor(Date.now() / 1000));
    if (this.serializer.isOversize(prepared)) {
      return {
        kind: "oversize",
        bytes: prepared.bytes,
        maxBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
      };
    }
    if (this.state !== "paired" || this.socket?.readyState !== WebSocket.OPEN)
      return { kind: "unavailable" };
    this.socket.send(prepared.json);
    return { kind: "sent", bytes: prepared.bytes };
  }

  private async connect(): Promise<void> {
    const signal = this.controller?.signal;
    if (!signal || signal.aborted) return;
    this.closeSocket();
    const generation = this.generation;
    this.connectStartedAt = Date.now();
    this.connectAttempt += 1;
    this.setState("connecting");
    try {
      // 首次注册和失效后的重注册共用连接尝试，网络失败均由此处退避，不能在 manager 裸 await。
      if (!this.deviceSid || this.registrationPending) {
        const sid = await this.options.resolveDeviceSid(signal, this.registrationPending);
        if (signal.aborted || generation !== this.generation) return;
        this.deviceSid = sid;
        this.registrationPending = false;
      }
      const deviceSid = this.deviceSid;
      const token = await this.options.getToken(signal);
      if (signal.aborted || generation !== this.generation) return;
      const url = new URL(this.options.relayWsUrl);
      url.searchParams.set("token", token);
      url.searchParams.set("mid", this.options.deviceMid);
      const socket = new WebSocket(url, { perMessageDeflate: true });
      this.socket = socket;
      this.handshakeTimer = setTimeout(
        () => this.scheduleReconnect(),
        WEB_REMOTE_CONTROL_V2_HEARTBEAT_ACK_TIMEOUT_MS,
      );
      socket.on("open", () => {
        if (socket !== this.socket) return;
        this.setState("authenticating");
        this.send({
          type: "auth_init",
          device_sid: deviceSid,
          meta: this.options.meta,
          client_ts: Math.floor(Date.now() / 1000),
        });
      });
      socket.on("message", (raw, isBinary) => {
        if (socket !== this.socket || isBinary) return;
        // 在拼接/解码前检查未压缩字节数，保留 raw frame 的内存边界。
        const byteLength = Array.isArray(raw)
          ? raw.reduce((sum, part) => sum + part.byteLength, 0)
          : raw.byteLength;
        if (byteLength > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
          this.options.onRawTransportFault?.("remote.rpcFrame.envelopeTooLarge");
          return;
        }
        let value: unknown;
        try {
          value = JSON.parse(rawBytes(raw).toString("utf8"));
        } catch {
          return;
        }
        const message = parseWebRemoteControlRelayV2IncomingMessage(value);
        if (message) void this.handleMessage(message);
      });
      socket.on("error", () => {
        // WS 错误可能包含一次性 token URL，日志和对外错误只暴露固定原因。
        if (socket === this.socket)
          this.options.logger.warn("[web-remote-control] V2 socket error");
      });
      socket.on("close", () => {
        if (socket !== this.socket) return;
        if (this.state !== "paired") {
          noteWebRemoteRelayConnectAttempt(Date.now() - this.connectStartedAt, false, {
            attempt: this.connectAttempt,
          });
        }
        this.scheduleReconnect();
      });
    } catch (error) {
      if (signal.aborted || generation !== this.generation) return;
      this.handleConnectionError(error);
    }
  }

  private async handleMessage(message: WebRemoteControlRelayV2IncomingMessage): Promise<void> {
    if (message.type === "error") {
      if (message.code === "KICKED") {
        const delay = this.retry.kickedDelay();
        if (delay === null) {
          this.closeSocket();
          this.setState("kicked");
        } else this.scheduleReconnect(delay);
      } else if (
        message.code === "AUTH_FAILED" &&
        this.state === "authenticating" &&
        !this.registrationRetried
      ) {
        this.registrationRetried = true;
        // 注册遇到网络错误时必须重试注册，不能带已失效 SID 再次握手。
        this.registrationPending = true;
        this.scheduleReconnect(0);
      } else if (message.code === "INTERNAL" || message.code === "DEVICE_OFFLINE") {
        this.scheduleReconnect();
      } else {
        this.handleConnectionError(new WebRemoteControlV2ConnectionError("relay-unavailable"));
      }
      return;
    }
    if (message.type === "auth_ack") {
      if (this.state !== "authenticating" || message.device_sid !== this.deviceSid) return;
      clearTimeout(this.handshakeTimer);
      this.authenticated = true;
      this.retry.acknowledged();
    }
    if (!this.authenticated) return;
    if (message.type === "auth_ack" || message.type === "pair_status_ack") {
      const previousGeneration = this.pairedGeneration;
      this.heartbeat.acknowledged();
      this.setState(webRemoteControlV2PairState(message.pair_status));
      if (message.pair_status === "matched") {
        this.pairedGeneration = this.generation;
        if (previousGeneration)
          this.options.onSendReady?.({
            kind: previousGeneration === this.generation ? "same-socket" : "reconnected-socket",
          });
      }
    } else if (message.type === "data" && this.state === "paired") {
      const value = message.payload;
      if (
        value &&
        typeof value === "object" &&
        "zcode_type" in value &&
        (value.zcode_type === "rpc-frame" || value.zcode_type === "rpc-frame-ack") &&
        this.options.onRawTransportPayload?.(value)
      )
        return;
      const payload = parseWebRemoteControlAppPayload(value);
      if (payload) this.options.onPayload(payload);
    }
  }

  private closeSocket(): void {
    // 先撤销当前代，再关闭；旧 close/ACK 及异步 token 结果均不能推进下一代。
    this.generation += 1;
    this.authenticated = false;
    this.heartbeat.stop();
    clearTimeout(this.handshakeTimer);
    const socket = this.socket;
    this.socket = undefined;
    if (socket?.readyState === WebSocket.CONNECTING) socket.terminate();
    else socket?.close();
  }

  private scheduleReconnect(delay = this.retry.nextDelay()): void {
    if (!this.controller || this.controller.signal.aborted) return;
    this.closeSocket();
    clearTimeout(this.reconnectTimer);
    this.setState("connecting");
    noteWebRemoteRelayReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  private handleConnectionError(error: unknown): void {
    if (!(error instanceof WebRemoteControlV2ConnectionError) || error.retryable) {
      this.options.logger.warn("[web-remote-control] V2 connection retry");
      this.scheduleReconnect();
      return;
    }
    this.closeSocket();
    clearTimeout(this.reconnectTimer);
    this.setState("error");
    this.options.onError(error);
  }

  private send(message: WebRemoteControlRelayV2OutgoingMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private setState(state: WebRemoteControlDeviceTransportState): void {
    if (this.state === state) return;
    this.state = state;
    if (state === "paired") {
      noteWebRemoteRelayConnectAttempt(Date.now() - this.connectStartedAt, true, {
        attempt: this.connectAttempt,
      });
    }
    this.options.logger.info("[web-remote-control] V2 device state", { state });
    this.options.onStateChange(state);
  }
}
