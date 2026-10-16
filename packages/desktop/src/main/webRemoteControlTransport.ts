/* eslint-disable max-lines -- 外部 relay transport 需要集中维护握手、配对、心跳和重连状态机。 */
import { WebSocket, type RawData } from "ws";
import { createHash } from "node:crypto";
import {
  WebRemoteControlRelayPayloadSerializer,
  type WebRemoteControlPayloadSendResult,
} from "@zcode/client";
import {
  WEB_REMOTE_CONTROL_HEARTBEAT_ACK_TIMEOUT_MS,
  WEB_REMOTE_CONTROL_HEARTBEAT_INTERVAL_MS,
  WEB_REMOTE_CONTROL_RECONNECT_JITTER_MS,
  getWebRemoteControlHeartbeatDelayMs,
  getWebRemoteControlHeartbeatJitterMs,
  getWebRemoteControlReconnectJitterMs,
  WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS,
  parseWebRemoteControlAppPayload,
  type WebRemoteControlAppPayload,
  type WebRemoteControlRelayDeviceMeta,
  type WebRemoteControlRelayIncomingMessage,
  type WebRemoteControlRelayOutgoingMessage,
} from "@zcode/shared";
import type { WebRemoteControlRelayAuthProvider } from "./webRemoteControlRelayAuthProvider.js";
import {
  noteWebRemoteRelayConnectAttempt,
  noteWebRemoteRelayReconnect,
} from "./desktopNetworkTelemetry.js";

export type WebRemoteControlDeviceTransportState =
  | "idle"
  | "connecting"
  | "registering"
  | "authenticating"
  | "waiting_terminal"
  | "paired"
  | "kicked"
  | "error";

export type WebRemoteControlDeviceTransportAuth =
  | {
      mode: "register";
      passHash: string;
    }
  | {
      mode: "persisted";
      deviceSid: string;
      passHash: string;
    };

export interface WebRemoteControlDeviceTransportOptions {
  relayWsUrl: string;
  deviceMid: string;
  auth: WebRemoteControlDeviceTransportAuth;
  meta: WebRemoteControlRelayDeviceMeta;
  authProvider: WebRemoteControlRelayAuthProvider;
  heartbeatIntervalMs?: number;
  heartbeatJitterMs?: number;
  heartbeatAckTimeoutMs?: number;
  reconnectJitterMs?: number;
  reconnectDelayMs?: number;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  relayMessageLogger?: {
    info: (...args: unknown[]) => void;
  };
  onRegisteredAuth(auth: { deviceSid: string; passHash: string }): void;
  onStateChange(state: WebRemoteControlDeviceTransportState): void;
  onPayload(payload: WebRemoteControlAppPayload): void;
  onRawTransportPayload?(payload: unknown): boolean;
  onRawTransportFault?(reasonCode: string): void;
  onError(error: Error): void;
  onSendReady?(event: { kind: "same-socket" | "reconnected-socket" }): void;
  onInvalidPersistedAuth(): Promise<void>;
}

function parseRelayMessage(raw: RawData): WebRemoteControlRelayIncomingMessage | null {
  // Bugfix：必须在 JSON.parse/字符串复制前按未压缩 raw bytes 硬闸；WebSocket compression
  // 只影响线上字节，不能让解压后的超限 app payload 进入 parser。
  if (estimateRawDataBytes(raw) > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
    return null;
  }
  try {
    const bytes = Array.isArray(raw)
      ? Buffer.concat(raw)
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw)
        : ArrayBuffer.isView(raw)
          ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
          : Buffer.from(String(raw), "utf8");
    const parsed = JSON.parse(bytes.toString("utf8")) as WebRemoteControlRelayIncomingMessage;
    return parsed && typeof parsed === "object" && "type" in parsed ? parsed : null;
  } catch {
    return null;
  }
}

function safePayloadMetadata(payload: unknown): Record<string, string | undefined> {
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

function isRawTransportCandidate(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const type = (payload as { zcode_type?: unknown }).zcode_type;
  return type === "rpc-frame" || type === "rpc-frame-ack";
}

function estimateRawDataBytes(raw: RawData): number {
  if (Array.isArray(raw)) {
    return raw.reduce((total, part) => total + part.byteLength, 0);
  }
  if (typeof raw === "string") {
    return Buffer.byteLength(raw, "utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return raw.byteLength;
  }
  if (ArrayBuffer.isView(raw)) {
    return raw.byteLength;
  }
  return Buffer.byteLength(String(raw), "utf8");
}

function summarizeRelayMessageForTrace(
  message: WebRemoteControlRelayIncomingMessage | WebRemoteControlRelayOutgoingMessage,
): Record<string, unknown> {
  if (message.type === "pair_status_ack") {
    return { type: message.type, pair_status: message.pair_status };
  }
  if (message.type === "auth_init") {
    return { type: message.type, role: message.role };
  }
  if (message.type === "data") {
    const payload = message.payload;
    const seq =
      payload && typeof payload === "object" && !Array.isArray(payload) && "seq" in payload
        ? (payload as { seq?: unknown }).seq
        : undefined;
    return {
      type: message.type,
      payload: safePayloadMetadata(message.payload),
      ...(typeof seq === "number" ? { seq } : {}),
    };
  }
  if (message.type === "error") {
    return { type: message.type, code: message.code };
  }
  return { type: message.type };
}

function createMessageHashFromRaw(raw: RawData): string {
  const bytes =
    typeof raw === "string"
      ? Buffer.from(raw, "utf8")
      : raw instanceof ArrayBuffer
        ? Buffer.from(raw)
        : ArrayBuffer.isView(raw)
          ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
          : Buffer.from(String(raw), "utf8");
  return createHash("sha1").update(bytes).digest("hex").slice(0, 16);
}

function createMessageHashFromText(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex").slice(0, 16);
}

export class WebRemoteControlDeviceTransport {
  private socket?: WebSocket;
  private state: WebRemoteControlDeviceTransportState = "idle";
  private activeAuth: WebRemoteControlDeviceTransportAuth;
  private deviceSid?: string;
  private manuallyClosed = false;
  private terminalClose = false;
  private invalidPersistedRetryUsed = false;
  private suppressNextCloseReconnect = false;
  private wasPaired = false;
  private staleWaitingCount = 0;
  private lastPairStatusAckAt = 0;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private heartbeatAckWatchdogTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private staleWaitingRecoveryTimer?: ReturnType<typeof setTimeout>;
  // Bugfix: relay message trace 在开发态也会按消息流频率写入 logs/web-remote-control。
  // 当前默认完全关闭，避免本地排查时产生高频落盘和敏感摘要残留；如需恢复必须先更新日志 spec。
  private readonly traceRelayMessages = false;
  private connectStartedAt = 0;
  private connectAttempt = 0;
  private socketGeneration = 0;
  private lastPairedSocketGeneration = 0;
  private readonly payloadSerializer = new WebRemoteControlRelayPayloadSerializer();

  constructor(private readonly options: WebRemoteControlDeviceTransportOptions) {
    this.activeAuth = options.auth;
    this.deviceSid = options.auth.mode === "persisted" ? options.auth.deviceSid : undefined;
  }

  start(): void {
    this.manuallyClosed = false;
    this.terminalClose = false;
    this.wasPaired = false;
    this.lastPairedSocketGeneration = 0;
    this.staleWaitingCount = 0;
    this.lastPairStatusAckAt = 0;
    this.connect();
  }

  sendPayload(payload: WebRemoteControlAppPayload): boolean {
    return this.sendPayloadResult(payload).kind === "sent";
  }

  measurePayloadBytes(payload: WebRemoteControlAppPayload): number {
    return this.payloadSerializer.prepare(payload).bytes;
  }

  sendPayloadResult(payload: WebRemoteControlAppPayload): WebRemoteControlPayloadSendResult {
    const prepared = this.payloadSerializer.prepare(payload);
    if (this.payloadSerializer.isOversize(prepared)) {
      return {
        kind: "oversize",
        bytes: prepared.bytes,
        maxBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
      };
    }
    if (this.state !== "paired" || this.staleWaitingCount > 0) {
      return { kind: "unavailable" };
    }
    return this.sendSerialized(prepared.message, prepared.json)
      ? { kind: "sent", bytes: prepared.bytes }
      : { kind: "unavailable" };
  }

  dispose(): void {
    this.manuallyClosed = true;
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearStaleWaitingRecoveryTimer();
    this.socket?.close();
    this.socket = undefined;
    this.setState("idle");
  }

  private connect(): void {
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearStaleWaitingRecoveryTimer();
    this.connectAttempt += 1;
    this.socketGeneration += 1;
    this.connectStartedAt = Date.now();
    this.setState("connecting");
    this.lastPairStatusAckAt = Date.now();
    this.options.logger.info("[web-remote-control] external relay device connecting");

    const relayUrl = new URL(this.options.relayWsUrl);
    // Bugfix: 实测外部 relay 的边缘层可能只按 query.mid 做分片，单独依赖
    // X-Device-ID 会导致 desktop 和手机落到不同后端，双方都停在 waiting。
    relayUrl.searchParams.set("mid", this.options.deviceMid);

    const socket = new WebSocket(relayUrl.toString(), {
      // Bugfix: relay 支持时优先协商 permessage-deflate，降低大体积 rpc-frame 的网络传输开销。
      // 服务端不支持时会自动回退为未压缩，不影响协议语义和数据完整性。
      perMessageDeflate: true,
      headers: {
        "X-Device-ID": this.options.deviceMid,
      },
    });
    this.socket = socket;

    socket.on("open", () => {
      if (socket !== this.socket) {
        return;
      }
      const negotiatedExtensions =
        typeof socket.extensions === "string" ? socket.extensions : "";
      this.options.logger.info("[web-remote-control] external relay negotiated extensions", {
        perMessageDeflate: negotiatedExtensions.includes("permessage-deflate"),
        extensions: negotiatedExtensions || undefined,
      });
      if (this.activeAuth.mode === "register") {
        this.setState("registering");
        this.send({
          type: "device_register_init",
          device_mid: this.options.deviceMid,
          pass_hash: this.activeAuth.passHash,
          meta: this.options.meta,
          client_ts: Date.now(),
        });
        return;
      }

      this.sendAuthInit(this.activeAuth.deviceSid);
    });

    socket.on("message", (raw) => {
      // Bugfix: jitter 延迟重连期间旧 socket 仍可能投递排队事件；只处理当前 socket，
      // 避免 stale ACK/data 改写新连接状态或进入业务层。
      if (socket !== this.socket) {
        return;
      }
      if (estimateRawDataBytes(raw) > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
        this.options.logger.warn("[web-remote-control] oversize external relay message dropped", {
          bytes: estimateRawDataBytes(raw),
          maxBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
        });
        this.options.onRawTransportFault?.("remote.rpcFrame.envelopeTooLarge");
        return;
      }
      const message = parseRelayMessage(raw);
      if (!message) {
        this.options.logger.warn("[web-remote-control] invalid external relay message");
        return;
      }
      this.logRelayTrace("recv", {
        ...summarizeRelayMessageForTrace(message),
        bytes: estimateRawDataBytes(raw),
        // Bugfix: 之前仅靠 bytes 无法区分“同一帧重发”和“不同帧同大小”。
        // 这里在开发态加短 hash，便于快速定位重复传输来源。
        contentHash: createMessageHashFromRaw(raw),
      });
      void this.handleMessage(message);
    });

    socket.on("error", (error) => {
      if (socket !== this.socket) {
        return;
      }
      this.options.logger.warn("[web-remote-control] external relay device socket error", {
        message: error.message,
      });
      noteWebRemoteRelayConnectAttempt(Date.now() - this.connectStartedAt, false, {
        error,
        attempt: this.connectAttempt,
      });
      this.options.onError(error);
    });

    socket.on("close", () => {
      if (socket !== this.socket) {
        return;
      }
      this.stopHeartbeat();
      if (this.suppressNextCloseReconnect) {
        this.suppressNextCloseReconnect = false;
        return;
      }
      if (!this.manuallyClosed && !this.terminalClose) {
        this.options.logger.warn("[web-remote-control] external relay device disconnected");
        if (this.state !== "paired") {
          noteWebRemoteRelayConnectAttempt(Date.now() - this.connectStartedAt, false, {
            attempt: this.connectAttempt,
          });
        }
        noteWebRemoteRelayReconnect();
        this.scheduleReconnect();
      }
    });
  }

  private async handleMessage(message: WebRemoteControlRelayIncomingMessage): Promise<void> {
    switch (message.type) {
      case "device_register_ack": {
        this.deviceSid = message.device_sid;
        if (this.activeAuth.mode === "register") {
          this.options.onRegisteredAuth({
            deviceSid: message.device_sid,
            passHash: this.activeAuth.passHash,
          });
          // Bugfix: 首次注册成功后，后续同一 transport 内的 relay 重连不能继续走 register。
          // 否则已配对会话遇到短暂 waiting 后会重新注册 device，旧二维码里的 sid 失效，手机刷新也连不回来。
          this.activeAuth = {
            mode: "persisted",
            deviceSid: message.device_sid,
            passHash: this.activeAuth.passHash,
          };
        }
        this.sendAuthInit(message.device_sid);
        break;
      }
      case "auth_challenge": {
        if (!this.deviceSid) {
          this.enterError(new Error("External relay auth challenge arrived before device_sid"));
          return;
        }
        this.send({
          type: "auth_response",
          device_sid: this.deviceSid,
          proof: this.options.authProvider.calculateProof(
            this.activeAuth.passHash,
            message.nonce,
            "device",
            this.deviceSid,
          ),
          client_ts: Date.now(),
        });
        break;
      }
      case "auth_ack":
      case "pair_status_ack": {
        this.applyPairStatus(message.pair_status);
        break;
      }
      case "data": {
        this.handleDataPayload(message.payload);
        break;
      }
      case "error": {
        await this.handleRelayError(message.code, message.message);
        break;
      }
    }
  }

  private sendAuthInit(deviceSid: string): void {
    this.deviceSid = deviceSid;
    this.setState("authenticating");
    this.send({
      type: "auth_init",
      role: "device",
      device_sid: deviceSid,
      meta: this.options.meta,
      client_ts: Date.now(),
    });
  }

  private applyPairStatus(status: "waiting" | "matched"): void {
    // Bugfix: 休眠恢复后可能出现 WebSocket 半开（本地未 close、relay 端已回收）。
    // 只要还能收到 pair_status_ack，就更新最近心跳应答时间；后续由心跳超时守卫判断是否需要重连。
    this.lastPairStatusAckAt = Date.now();
    this.armHeartbeatAckWatchdog();
    if (status === "waiting") {
      if (this.wasPaired) {
        // Bugfix: relay 偶发把已配对会话的一次心跳 ACK 报成 waiting。
        // 首次 waiting 先进入“可恢复怀疑态”（staleWaitingCount>0，sendPayload 会暂停业务发送），
        // 避免桌面端立刻降级为 waiting_terminal，而手机端仍按 paired 继续请求造成两端状态撕裂。
        this.staleWaitingCount += 1;
        this.startHeartbeat();
        if (this.staleWaitingCount === 1) {
          this.scheduleStaleWaitingRecovery();
          return;
        }
        this.reconnectAfterStaleWaiting();
        return;
      }
      // Bugfix: relay 在 waiting_terminal 阶段同样可能按空闲连接超时回收。
      // 这里持续发送 pair_status_query 作为轻量保活，避免手机尚未扫码时桌面端每分钟被动断连。
      this.setState("waiting_terminal");
      this.startHeartbeat();
      return;
    }
    if (status === "matched") {
      const previousPairedGeneration = this.lastPairedSocketGeneration;
      const sendReadyKind =
        previousPairedGeneration === 0
          ? null
          : previousPairedGeneration === this.socketGeneration
            ? "same-socket"
            : "reconnected-socket";
      this.staleWaitingCount = 0;
      this.clearStaleWaitingRecoveryTimer();
      this.setState("paired");
      this.wasPaired = true;
      this.lastPairedSocketGeneration = this.socketGeneration;
      this.startHeartbeat();
      if (sendReadyKind) this.options.onSendReady?.({ kind: sendReadyKind });
      return;
    }
  }

  private async handleRelayError(
    code: "AUTH_FAILED" | "DEVICE_OFFLINE" | "KICKED" | "WRONG_PARAM" | "INTERNAL",
    message: string,
  ): Promise<void> {
    if (code === "KICKED") {
      // Bugfix: KICKED 的业务语义是同一远控链接只能有一个手机 terminal。
      // desktop device 端在心跳超时后重建 socket 时也可能短暂收到该错误，不能因此关闭桌面远控 runtime。
      this.options.logger.warn("[web-remote-control] external relay device KICKED, reconnecting", {
        message,
      });
      this.socket?.close();
      return;
    }

    if (
      code === "AUTH_FAILED" &&
      this.activeAuth.mode === "persisted" &&
      !this.invalidPersistedRetryUsed
    ) {
      this.invalidPersistedRetryUsed = true;
      await this.options.onInvalidPersistedAuth();
      this.activeAuth = {
        mode: "register",
        passHash: this.activeAuth.passHash,
      };
      this.deviceSid = undefined;
      this.suppressNextCloseReconnect = true;
      this.socket?.close();
      this.scheduleReconnect(0);
      return;
    }

    if (code === "INTERNAL") {
      if (this.state === "paired" || this.state === "waiting_terminal") {
        this.enterWaitingForPairAfterRelayError(new Error(message || code));
        return;
      }
      // Bugfix: 外部 relay 在 terminal 快速刷新/重连时可能短暂返回 INTERNAL。
      // 这类错误不代表用户主动结束配对，不能设置 terminalClose，否则 close 后不会自动重连。
      this.enterRecoverableError(new Error(message || code));
      return;
    }

    if (code === "WRONG_PARAM" && (this.state === "paired" || this.state === "waiting_terminal")) {
      this.options.onError(new Error(message || code));
      return;
    }

    this.enterError(new Error(message || code));
  }

  private handleDataPayload(payload: unknown): void {
    if (this.state !== "paired") {
      return;
    }

    if (isRawTransportCandidate(payload) && this.options.onRawTransportPayload?.(payload)) {
      return;
    }
    const parsed = parseWebRemoteControlAppPayload(payload);
    if (!parsed) {
      this.options.logger.warn("[web-remote-control] invalid external relay payload dropped", {
        ...safePayloadMetadata(payload),
      });
      return;
    }

    this.options.onPayload(parsed);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }
    this.armHeartbeatAckWatchdog();
    this.scheduleHeartbeat();
  }

  private scheduleHeartbeat(): void {
    this.heartbeatTimer = setTimeout(
      () => {
        this.heartbeatTimer = undefined;
        if (!this.deviceSid || (this.state !== "paired" && this.state !== "waiting_terminal")) {
          return;
        }
        this.send({
          type: "pair_status_query",
          device_sid: this.deviceSid,
          client_ts: Date.now(),
        });
        // Bugfix: 固定 setInterval 会让同一批同时配对的设备长期同相发送心跳；
        // 每次发送后重新抽样有界 jitter，只打散调度相位，不改变平均 10 秒周期。
        this.scheduleHeartbeat();
      },
      getWebRemoteControlHeartbeatDelayMs(
        this.options.heartbeatIntervalMs ?? WEB_REMOTE_CONTROL_HEARTBEAT_INTERVAL_MS,
        this.options.heartbeatJitterMs,
      ),
    );
  }

  private armHeartbeatAckWatchdog(): void {
    if (this.state !== "paired" && this.state !== "waiting_terminal") {
      return;
    }
    if (this.heartbeatAckWatchdogTimer) {
      clearTimeout(this.heartbeatAckWatchdogTimer);
    }
    this.heartbeatAckWatchdogTimer = setTimeout(() => {
      this.heartbeatAckWatchdogTimer = undefined;
      if (this.state !== "paired" && this.state !== "waiting_terminal") {
        return;
      }
      // Bugfix: ACK deadline 必须独立于下一次 jittered heartbeat；否则随机间隔会把
      // 原本 30 秒的失联判定漂移到 32~36 秒，并在半开 socket 上继续黑洞发送。
      const staleMs = Date.now() - this.lastPairStatusAckAt;
      this.options.logger.warn(
        "[web-remote-control] external relay heartbeat ack timeout, reconnecting",
        { state: this.state, staleMs },
      );
      this.reconnectAfterStaleWaiting(this.getReconnectJitterMs());
    }, this.options.heartbeatAckTimeoutMs ?? WEB_REMOTE_CONTROL_HEARTBEAT_ACK_TIMEOUT_MS);
  }

  private getReconnectJitterMs(): number {
    const baseIntervalMs =
      this.options.heartbeatIntervalMs ?? WEB_REMOTE_CONTROL_HEARTBEAT_INTERVAL_MS;
    const heartbeatJitterMs = getWebRemoteControlHeartbeatJitterMs(
      baseIntervalMs,
      this.options.heartbeatJitterMs,
    );
    return getWebRemoteControlReconnectJitterMs(
      this.options.reconnectJitterMs ??
        Math.min(heartbeatJitterMs, WEB_REMOTE_CONTROL_RECONNECT_JITTER_MS),
    );
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.heartbeatAckWatchdogTimer) {
      clearTimeout(this.heartbeatAckWatchdogTimer);
      this.heartbeatAckWatchdogTimer = undefined;
    }
  }

  private scheduleReconnect(delayMs = this.options.reconnectDelayMs ?? 1_000): void {
    if (this.manuallyClosed || this.terminalClose) {
      return;
    }
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private scheduleStaleWaitingRecovery(): void {
    if (this.staleWaitingRecoveryTimer) {
      return;
    }
    // Bugfix：生产心跳间隔是 10 秒，旧的 1.5 秒窗口会在下一次 matched 确认前强制重连，
    // 把 relay 的单次 waiting 抖动放大成手机断线。延长到 15 秒，至少覆盖一轮心跳和网络抖动。
    this.staleWaitingRecoveryTimer = setTimeout(() => {
      this.staleWaitingRecoveryTimer = undefined;
      if (this.state === "paired" && this.staleWaitingCount > 0) {
        this.reconnectAfterStaleWaiting();
      }
    }, 15_000);
  }

  private clearStaleWaitingRecoveryTimer(): void {
    if (!this.staleWaitingRecoveryTimer) {
      return;
    }
    clearTimeout(this.staleWaitingRecoveryTimer);
    this.staleWaitingRecoveryTimer = undefined;
  }

  private reconnectAfterStaleWaiting(reconnectDelayMs = 0): void {
    this.clearStaleWaitingRecoveryTimer();
    this.stopHeartbeat();
    this.clearReconnectTimer();
    this.staleWaitingCount = 0;
    this.wasPaired = false;
    const staleSocket = this.socket;
    this.socket = undefined;
    if (reconnectDelayMs > 0) {
      // Bugfix: 延迟重连期间旧 socket 已经不可用，必须先切出 paired 状态，避免
      // manager 继续把该 transport 当成可发送连接并接收旧 socket 的业务帧。
      this.setState("connecting");
    }
    staleSocket?.close();
    if (reconnectDelayMs > 0) {
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.manuallyClosed || this.terminalClose) {
          return;
        }
        this.connect();
      }, reconnectDelayMs);
      return;
    }
    this.connect();
  }

  private enterError(error: Error): void {
    this.terminalClose = true;
    this.stopHeartbeat();
    this.clearStaleWaitingRecoveryTimer();
    this.setState("error");
    this.options.onError(error);
    this.socket?.close();
  }

  private enterRecoverableError(error: Error): void {
    this.stopHeartbeat();
    this.clearStaleWaitingRecoveryTimer();
    this.setState("error");
    this.options.onError(error);
    this.socket?.close();
  }

  private enterWaitingForPairAfterRelayError(error: Error): void {
    // Bugfix: zcode-remote-hub 在已认证连接上转发 data 找不到对端时只返回 INTERNAL，
    // 不会关闭当前 device WS。这里不能把“手机端暂时不在”升级成桌面全局 WS 断开，
    // 只暂停业务发送并继续用 pair_status_query 等待 terminal 重新 matched。
    this.options.onError(error);
    this.clearStaleWaitingRecoveryTimer();
    this.staleWaitingCount = 0;
    this.wasPaired = false;
    this.startHeartbeat();
    this.setState("waiting_terminal");
  }

  private setState(state: WebRemoteControlDeviceTransportState): void {
    if (this.state === state) {
      return;
    }
    const previousState = this.state;
    this.state = state;
    if (state === "paired" && previousState !== "paired" && this.connectStartedAt > 0) {
      noteWebRemoteRelayConnectAttempt(Date.now() - this.connectStartedAt, true, {
        attempt: this.connectAttempt,
      });
    }
    this.options.onStateChange(state);
    if (
      state === "connecting" ||
      state === "registering" ||
      state === "authenticating" ||
      state === "waiting_terminal" ||
      state === "paired" ||
      state === "kicked"
    ) {
      this.options.logger.info("[web-remote-control] external relay device state", { state });
    }
  }

  private send(message: WebRemoteControlRelayOutgoingMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    const serialized = JSON.stringify(message);
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    if (serializedBytes > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
      this.options.logger.warn("[web-remote-control] outbound relay message exceeds hard limit", {
        type: message.type,
        bytes: serializedBytes,
        maxBytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
      });
      return false;
    }
    return this.sendSerialized(message, serialized);
  }

  private sendSerialized(
    message: WebRemoteControlRelayOutgoingMessage,
    serialized: string,
  ): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    // Bugfix: 之前 send 方向只记录消息摘要，缺少字节大小，无法和 recv 的 bytes 做对照排查。
    // 这里按实际写入 socket 的 UTF-8 文本长度记录 bytes，便于分析消息体膨胀与链路异常。
    this.logRelayTrace("send", {
      ...summarizeRelayMessageForTrace(message),
      bytes: Buffer.byteLength(serialized, "utf8"),
      contentHash: createMessageHashFromText(serialized),
    });
    this.socket.send(serialized);
    return true;
  }

  private logRelayTrace(direction: "send" | "recv", fields: Record<string, unknown>): void {
    if (!this.traceRelayMessages) {
      return;
    }
    const payload = {
      direction,
      ...fields,
    };
    this.options.logger.info("[web-remote-control][relay-message]", payload);
    this.options.relayMessageLogger?.info(payload);
  }
}
