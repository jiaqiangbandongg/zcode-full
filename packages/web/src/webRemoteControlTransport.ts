/* eslint-disable max-lines -- 外部 relay terminal transport 需要集中维护握手、配对、请求等待和重连状态机。 */
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
  type WebRemoteControlFailure,
  type WebRemoteControlRelayIncomingMessage,
  type WebRemoteControlRelayOutgoingMessage,
} from "@zcode/shared";

export type WebRemoteControlTerminalTransportState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "waiting"
  | "paired"
  | "reconnecting"
  | "suspended"
  | "kicked"
  | "error";

export type WebRemoteControlTerminalTransportDiagnostic =
  | {
      type: "state-transition";
      previousState: WebRemoteControlTerminalTransportState;
      state: WebRemoteControlTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      type: "socket-close";
      code: number;
      reason: string;
      wasClean: boolean;
      wasPaired: boolean;
      state: WebRemoteControlTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      type: "socket-error" | "recover-start" | "recover-scheduled";
      state: WebRemoteControlTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      type: "pair-status";
      pairStatus: "waiting" | "matched";
      state: WebRemoteControlTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      type: "socket-extensions";
      state: WebRemoteControlTerminalTransportState;
      perMessageDeflate: boolean;
      extensions?: string;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    };

type WebRemoteControlTerminalTransportDiagnosticInput = {
  type: WebRemoteControlTerminalTransportDiagnostic["type"];
  previousState?: WebRemoteControlTerminalTransportState;
  state: WebRemoteControlTerminalTransportState;
  code?: number;
  reason?: string;
  wasClean?: boolean;
  wasPaired?: boolean;
  pairStatus?: "waiting" | "matched";
  perMessageDeflate?: boolean;
  extensions?: string;
};

interface WebRemoteControlTerminalTransportOptions {
  relayWsUrl: string;
  deviceSid: string;
  passHash: string;
  deviceMid?: string;
  appVersion?: string;
  WebSocketCtor?: typeof globalThis.WebSocket;
  heartbeatIntervalMs?: number;
  heartbeatJitterMs?: number;
  heartbeatAckTimeoutMs?: number;
  reconnectJitterMs?: number;
  healthCheckTimeoutMs?: number;
  desktopOfflineGraceMs?: number;
  staleWaitingRecoveryMs?: number;
  waitingTimeoutMs?: number;
  authProvider: {
    calculateProof(
      passHash: string,
      nonce: string,
      role: "terminal",
      deviceSid: string,
    ): Promise<string>;
  };
  onPayload(payload: WebRemoteControlAppPayload): void;
  onRawTransportPayload?(payload: unknown): boolean;
  onRawTransportFault?(reasonCode: string): void;
  onStateChange(state: WebRemoteControlTerminalTransportState): void;
  onFailure(failure: WebRemoteControlFailure): void;
  onError(error: Error): void;
  onDiagnostic?(diagnostic: WebRemoteControlTerminalTransportDiagnostic): void;
  onSendReady?(event: { kind: "same-socket" | "reconnected-socket" }): void;
  reloadPage(): void;
}

async function readWebSocketData(data: unknown): Promise<string | null> {
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

function webSocketDataByteLength(data: unknown): number {
  if (typeof data === "string") return new TextEncoder().encode(data).byteLength;
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  return new TextEncoder().encode(String(data)).byteLength;
}

async function parseRelayMessage(data: unknown): Promise<WebRemoteControlRelayIncomingMessage | null> {
  try {
    const text = await readWebSocketData(data);
    if (text === null) return null;
    const parsed = JSON.parse(text) as WebRemoteControlRelayIncomingMessage;
    return parsed && typeof parsed === "object" && "type" in parsed ? parsed : null;
  } catch {
    return null;
  }
}

function createFailure(reason: WebRemoteControlFailure["reason"], message?: string): WebRemoteControlFailure {
  return { reason, message };
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

export class WebRemoteControlTerminalTransport {
  private readonly WebSocketCtor: typeof globalThis.WebSocket;
  private socket?: WebSocket;
  private state: WebRemoteControlTerminalTransportState = "idle";
  private intentionallyClosed = false;
  private wasPaired = false;
  private hadPairedSession = false;
  private staleWaitingCount = 0;
  private reconnectAttempt = 0;
  private socketGeneration = 0;
  private lastPairedSocketGeneration = 0;
  private lastPairStatusAckAt = 0;
  private hiddenStartedAt?: number;
  private lastPairStatusDiagnostic?: string;
  private pairedWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private heartbeatAckWatchdogTimer?: ReturnType<typeof setTimeout>;
  private waitingTimer?: ReturnType<typeof setTimeout>;
  private staleWaitingRecoveryTimer?: ReturnType<typeof setTimeout>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private desktopOfflineFailureTimer?: ReturnType<typeof setTimeout>;
  private readonly traceRelayMessages = import.meta.env.DEV;
  private readonly payloadSerializer = new WebRemoteControlRelayPayloadSerializer();

  constructor(private readonly options: WebRemoteControlTerminalTransportOptions) {
    this.WebSocketCtor = options.WebSocketCtor ?? globalThis.WebSocket;
  }

  start(): void {
    this.intentionallyClosed = false;
    this.wasPaired = false;
    this.hadPairedSession = false;
    this.staleWaitingCount = 0;
    this.reconnectAttempt = 0;
    this.lastPairedSocketGeneration = 0;
    this.lastPairStatusAckAt = Date.now();
    this.setState("connecting");
    this.connect();
  }

  private connect(): void {
    this.socketGeneration += 1;
    const url = new URL(this.options.relayWsUrl);
    if (this.options.deviceMid?.trim()) {
      url.searchParams.set("mid", this.options.deviceMid);
    }
    const socket = new this.WebSocketCtor(url.toString());
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (socket !== this.socket) {
        return;
      }
      const negotiatedExtensions = typeof socket.extensions === "string" ? socket.extensions : "";
      // Bugfix: 手机端运行在浏览器 WebSocket API 下，无法主动传 perMessageDeflate 配置。
      // 只能通过标准 extensions 字段确认 relay 是否真的完成压缩协商，避免误以为业务代码可强制开启。
      this.emitDiagnostic({
        type: "socket-extensions",
        state: this.state,
        perMessageDeflate: negotiatedExtensions.includes("permessage-deflate"),
        ...(negotiatedExtensions ? { extensions: negotiatedExtensions } : {}),
      });
      this.setState("authenticating");
      this.send({
        type: "auth_init",
        role: "terminal",
        device_sid: this.options.deviceSid,
        meta: {
          platform: "web",
          version: this.options.appVersion ?? "web",
          name: "mobile-browser",
        },
        client_ts: Date.now(),
      });
    });

    socket.addEventListener("message", (event) => {
      if (socket !== this.socket) {
        return;
      }
      void this.handleMessage(event.data);
    });

    socket.addEventListener("error", () => {
      if (socket !== this.socket) {
        return;
      }
      const error = new Error("External relay terminal socket error");
      this.emitDiagnostic({ type: "socket-error", state: this.state });
      this.options.onError(error);
    });

    socket.addEventListener("close", (event) => {
      if (socket !== this.socket) {
        return;
      }
      this.emitDiagnostic({
        type: "socket-close",
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        wasPaired: this.wasPaired,
        state: this.state,
      });
      this.stopHeartbeat();
      this.clearWaitingTimer();
      this.clearStaleWaitingRecoveryTimer();
      if (this.intentionallyClosed) {
        return;
      }
      if (this.state === "suspended") {
        return;
      }
      if (this.hadPairedSession) {
        // Bugfix: 手机浏览器后台恢复、网络切换或 relay 短抖会关闭已配对 socket。
        // 旧逻辑直接刷新整页，导致用户丢失当前 workspace/task 视图；这里改为原地重连，
        // 让上层在重新 paired 后按 mobile view state 恢复。
        this.scheduleReconnect();
        return;
      }
      this.setState("error");
      this.options.onFailure(
        createFailure("relay-unavailable", "Web remote control relay connection closed."),
      );
    });
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

  suspend(): void {
    if (this.state !== "paired" && this.state !== "connecting" && this.state !== "reconnecting") {
      return;
    }
    this.hiddenStartedAt = Date.now();
    this.clearReconnectTimer();
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.setState("suspended");
  }

  async recoverConnection(timeoutMs = 15_000): Promise<void> {
    this.emitDiagnostic({ type: "recover-start", state: this.state });
    this.clearReconnectTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.staleWaitingCount = 0;
    if (
      this.state === "suspended" &&
      this.wasPaired &&
      this.socket?.readyState === this.WebSocketCtor.OPEN
    ) {
      // Bugfix: hidden/pagehide 只说明手机页面暂停过，不代表 WebSocket 一定坏了。
      // 先用原 socket 做一次 pair_status 探测，避免短暂切后台也强制断开重连。
      this.setState("reconnecting");
      if (this.sendPairStatusQuery()) {
        try {
          await this.waitForPaired(this.options.healthCheckTimeoutMs ?? 3_000);
          return;
        } catch {
          // 探测超时后再重建 socket；这里不直接失败，避免把短暂恢复慢误判为桌面断开。
        }
      }
    }
    this.reconnectAttempt = 0;
    this.reconnectNow();
    await this.waitForPaired(timeoutMs);
  }

  recoverInBackground(): void {
    if (this.intentionallyClosed || this.state === "paired" || this.state === "kicked") {
      return;
    }
    // Bugfix: 手机端长时间后台恢复可能超过 recoverConnection 的单次等待窗口。
    // 这里继续原地重连，不把当前页面切成错误页，保证用户正在输入的草稿不被卸载。
    this.clearReconnectTimer();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.clearDesktopOfflineFailureTimer();
    this.stopHeartbeat();
    this.staleWaitingCount = 0;
    this.reconnectNow();
  }

  dispose(): void {
    this.intentionallyClosed = true;
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.clearDesktopOfflineFailureTimer();
    this.clearReconnectTimer();
    this.rejectPairedWaiters(new Error("Web remote control transport disposed."));
    this.socket?.close();
    this.socket = undefined;
    this.setState("idle");
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (webSocketDataByteLength(data) > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
      this.options.onRawTransportFault?.("remote.rpcFrame.envelopeTooLarge");
      return;
    }
    const message = await parseRelayMessage(data);
    if (!message) {
      return;
    }
    this.logRelayTrace("recv", summarizeRelayMessageForTrace(message));

    switch (message.type) {
      case "auth_challenge":
        this.send({
          type: "auth_response",
          device_sid: this.options.deviceSid,
          proof: await this.options.authProvider.calculateProof(
            this.options.passHash,
            message.nonce,
            "terminal",
            this.options.deviceSid,
          ),
          client_ts: Date.now(),
        });
        break;
      case "auth_ack":
      case "pair_status_ack":
        this.applyPairStatus(message.pair_status);
        break;
      case "data":
        this.handleDataPayload(message.payload);
        break;
      case "error":
        this.handleRelayError(message.code, message.message);
        break;
    }
  }

  private applyPairStatus(status: "waiting" | "matched"): void {
    this.lastPairStatusAckAt = Date.now();
    this.armHeartbeatAckWatchdog();
    this.emitDiagnostic({ type: "pair-status", pairStatus: status, state: this.state });
    if (status === "waiting") {
      if (this.wasPaired) {
        // Bugfix: zcode-remote-hub 的 waiting 是合法配对状态，表示当前 device 不在 hub 里，
        // 不是 terminal WS 损坏信号。已配对后降级为 waiting 时保持同一条手机端 WS，
        // 继续轻量查询，避免把桌面端短暂重连放大成手机端反复踢旧连接。
        this.staleWaitingCount = 0;
        this.clearStaleWaitingRecoveryTimer();
        this.clearReconnectTimer();
        this.clearWaitingTimer();
        this.clearDesktopOfflineFailureTimer();
        this.setState("waiting");
        this.startHeartbeat();
        return;
      }
      this.stopHeartbeat();
      this.setState("waiting");
      this.startWaitingTimer();
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
      this.reconnectAttempt = 0;
      this.clearStaleWaitingRecoveryTimer();
      this.clearDesktopOfflineFailureTimer();
      this.clearReconnectTimer();
      this.clearWaitingTimer();
      this.setState("paired");
      this.wasPaired = true;
      this.hadPairedSession = true;
      this.lastPairedSocketGeneration = this.socketGeneration;
      this.startHeartbeat();
      if (sendReadyKind) this.options.onSendReady?.({ kind: sendReadyKind });
      return;
    }
  }

  private handleRelayError(
    code: "AUTH_FAILED" | "DEVICE_OFFLINE" | "KICKED" | "WRONG_PARAM" | "INTERNAL",
    message: string,
  ): void {
    if (code === "KICKED") {
      this.setState("kicked");
      this.enterTerminalFailure(createFailure("session-conflict", message || code));
      return;
    }
    if (code === "DEVICE_OFFLINE") {
      // Bugfix: 桌面端打开远控或 relay 短暂重连时，手机可能先收到一次 DEVICE_OFFLINE。
      // 旧逻辑会立刻渲染“电脑端离线”终态页，实际桌面 1~2 秒后就恢复 paired。
      // 这里先进入可恢复重连窗口，超过宽限时间仍未 paired 才认定桌面真正离线。
      this.recoverFromDeviceOffline(message || code);
      return;
    }
    if (code === "AUTH_FAILED" || code === "WRONG_PARAM") {
      this.enterTerminalFailure(createFailure("invalid-mobile-connection", message || code));
      return;
    }
    if (code === "INTERNAL") {
      if (this.state === "paired" || (this.hadPairedSession && this.state === "waiting")) {
        this.enterWaitingForDeviceAfterRelayError(message || code);
        return;
      }
      // Bugfix: relay 在桌面/手机快速重连切换时会短暂回 INTERNAL。
      // 这类错误大多可恢复，直接抛失败页会迫使用户手动重开远控；改为原地重连恢复。
      this.recoverFromRelayInternal(message || code);
      return;
    }
    this.enterTerminalFailure(createFailure("relay-unavailable", message || code));
  }

  private handleDataPayload(payload: unknown): void {
    if (isRawTransportCandidate(payload) && this.options.onRawTransportPayload?.(payload)) {
      return;
    }
    const parsed = parseWebRemoteControlAppPayload(payload);
    if (!parsed) {
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
        if (this.state !== "paired" && this.state !== "waiting") {
          return;
        }
        this.sendPairStatusQuery();
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
    if (this.state !== "paired" && this.state !== "waiting") {
      return;
    }
    if (this.heartbeatAckWatchdogTimer) {
      clearTimeout(this.heartbeatAckWatchdogTimer);
    }
    this.heartbeatAckWatchdogTimer = setTimeout(() => {
      this.heartbeatAckWatchdogTimer = undefined;
      if (this.state !== "paired" && this.state !== "waiting") {
        return;
      }
      // Bugfix: ACK deadline 必须独立于下一次 jittered heartbeat；否则随机间隔会把
      // 原本 30 秒的失联判定漂移到 32~36 秒，并在半开 WebSocket 上继续黑洞发送。
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

  private sendPairStatusQuery(): boolean {
    return this.send({
      type: "pair_status_query",
      device_sid: this.options.deviceSid,
      client_ts: Date.now(),
    });
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

  private startWaitingTimer(): void {
    this.clearWaitingTimer();
    this.waitingTimer = setTimeout(() => {
      if (this.state !== "waiting") {
        return;
      }
      this.enterTerminalFailure(
        createFailure(
          "invalid-mobile-connection",
          "Desktop did not match this mobile connection before the waiting timeout.",
        ),
      );
    }, this.options.waitingTimeoutMs ?? 30_000);
  }

  private clearWaitingTimer(): void {
    if (!this.waitingTimer) {
      return;
    }
    clearTimeout(this.waitingTimer);
    this.waitingTimer = undefined;
  }

  private scheduleStaleWaitingRecovery(): void {
    if (this.staleWaitingRecoveryTimer) {
      return;
    }
    this.staleWaitingRecoveryTimer = setTimeout(() => {
      this.staleWaitingRecoveryTimer = undefined;
      if (
        (
          this.state === "paired" ||
          this.state === "reconnecting" ||
          this.state === "connecting" ||
          this.state === "authenticating"
        ) &&
        this.staleWaitingCount > 0
      ) {
        this.reconnectAfterStaleWaiting();
      }
    }, this.options.staleWaitingRecoveryMs ?? 1_500);
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
    this.clearWaitingTimer();
    this.clearReconnectTimer();
    this.staleWaitingCount = 0;
    // Bugfix: 已配对手机在恢复时可能先拿到 auth_ack: waiting。
    // 这里不能清掉 wasPaired，否则下一跳 waiting 会被当成首次未匹配并进入失败页；
    // 保留已配对语义，让状态机继续按可恢复短断连重试到 matched。
    if (reconnectDelayMs > 0) {
      const staleSocket = this.socket;
      this.socket = undefined;
      staleSocket?.close();
      this.setState("reconnecting");
      this.lastPairStatusAckAt = Date.now();
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = undefined;
        if (this.intentionallyClosed || this.state === "suspended") {
          return;
        }
        this.connect();
      }, reconnectDelayMs);
      return;
    }
    this.reconnectNow();
  }

  private reconnectNow(): void {
    const staleSocket = this.socket;
    this.socket = undefined;
    staleSocket?.close();
    this.setState("reconnecting");
    this.lastPairStatusAckAt = Date.now();
    this.connect();
  }

  private scheduleReconnect(options?: { immediate?: boolean }): void {
    if (this.reconnectTimer) {
      return;
    }
    const delayMs = options?.immediate
      ? 0
      : Math.min(10_000, 500 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.setState("reconnecting");
    this.emitDiagnostic({ type: "recover-scheduled", state: this.state });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.intentionallyClosed || this.state === "suspended") {
        return;
      }
      this.staleWaitingCount = 0;
      this.wasPaired = false;
      const staleSocket = this.socket;
      this.socket = undefined;
      staleSocket?.close();
      this.connect();
    }, delayMs);
  }

  private recoverFromRelayInternal(message: string): void {
    this.options.onError(new Error(message));
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.staleWaitingCount = 0;
    this.wasPaired = false;
    const staleSocket = this.socket;
    this.socket = undefined;
    staleSocket?.close();
    this.scheduleReconnect({ immediate: true });
  }

  private recoverFromDeviceOffline(message: string): void {
    this.options.onError(new Error(message));
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.staleWaitingCount = 0;
    this.wasPaired = false;
    if (!this.desktopOfflineFailureTimer) {
      this.desktopOfflineFailureTimer = setTimeout(() => {
        this.desktopOfflineFailureTimer = undefined;
        this.enterTerminalFailure(createFailure("desktop-disconnected", message));
      }, this.options.desktopOfflineGraceMs ?? 15_000);
    }
    const staleSocket = this.socket;
    this.socket = undefined;
    staleSocket?.close();
    this.scheduleReconnect({ immediate: true });
  }

  private enterWaitingForDeviceAfterRelayError(message: string): void {
    // Bugfix: zcode-remote-hub 在已认证连接上转发 data 找不到 device 时只返回 INTERNAL，
    // 不会关闭当前 terminal WS。这里保持手机端 WS，降级为 waiting 并继续查询配对状态，
    // 避免把“桌面端暂时不在”放大成手机端反复重连。
    this.options.onError(new Error(message));
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.clearDesktopOfflineFailureTimer();
    this.clearReconnectTimer();
    this.staleWaitingCount = 0;
    this.setState("waiting");
    this.startHeartbeat();
  }

  private clearDesktopOfflineFailureTimer(): void {
    if (!this.desktopOfflineFailureTimer) {
      return;
    }
    clearTimeout(this.desktopOfflineFailureTimer);
    this.desktopOfflineFailureTimer = undefined;
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) {
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private waitForPaired(timeoutMs = 15_000): Promise<void> {
    if (this.state === "paired") {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pairedWaiters.delete(waiter);
          reject(new Error("Web remote control relay did not recover before timeout."));
        }, timeoutMs),
      };
      this.pairedWaiters.add(waiter);
    });
  }

  private resolvePairedWaiters(): void {
    for (const waiter of this.pairedWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.pairedWaiters.clear();
  }

  private rejectPairedWaiters(error: Error): void {
    for (const waiter of this.pairedWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pairedWaiters.clear();
  }

  private enterTerminalFailure(failure: WebRemoteControlFailure): void {
    this.intentionallyClosed = true;
    this.stopHeartbeat();
    this.clearWaitingTimer();
    this.clearStaleWaitingRecoveryTimer();
    this.clearDesktopOfflineFailureTimer();
    this.clearReconnectTimer();
    this.setState(failure.reason === "session-conflict" ? "kicked" : "error");
    this.rejectPairedWaiters(new Error(failure.message ?? failure.reason));
    this.options.onFailure(failure);
    this.socket?.close();
  }

  private setState(state: WebRemoteControlTerminalTransportState): void {
    if (this.state === state) {
      return;
    }
    const previousState = this.state;
    this.state = state;
    this.emitDiagnostic({
      type: "state-transition",
      previousState,
      state,
    });
    this.options.onStateChange(state);
    if (state === "paired") {
      this.resolvePairedWaiters();
    }
    if (state === "error" || state === "kicked") {
      this.rejectPairedWaiters(new Error(`Web remote control transport entered ${state}.`));
    }
  }

  private send(message: WebRemoteControlRelayOutgoingMessage): boolean {
    if (this.socket?.readyState !== this.WebSocketCtor.OPEN) {
      return false;
    }
    const serialized = JSON.stringify(message);
    if (
      new TextEncoder().encode(serialized).byteLength >
      WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes
    ) {
      return false;
    }
    return this.sendSerialized(message, serialized);
  }

  private sendSerialized(
    message: WebRemoteControlRelayOutgoingMessage,
    serialized: string,
  ): boolean {
    if (this.socket?.readyState !== this.WebSocketCtor.OPEN) {
      return false;
    }
    this.logRelayTrace("send", summarizeRelayMessageForTrace(message));
    this.socket.send(serialized);
    return true;
  }

  private logRelayTrace(direction: "send" | "recv", fields: Record<string, unknown>): void {
    if (!this.traceRelayMessages) {
      return;
    }
    // Bugfix: 远控 relay 消息量高，生产环境打印正文会快速放大日志体积并暴露敏感内容。
    // 这里只在开发态输出摘要字段，排查链路足够且不会污染线上日志。
    console.info("[web-remote-control][relay-message]", {
      direction,
      ...fields,
    });
  }

  private emitDiagnostic(diagnostic: WebRemoteControlTerminalTransportDiagnosticInput): void {
    if (diagnostic.type === "pair-status") {
      const nextPairStatusDiagnostic = `${diagnostic.state}:${diagnostic.pairStatus ?? "unknown"}`;
      if (this.lastPairStatusDiagnostic === nextPairStatusDiagnostic) {
        return;
      }
      this.lastPairStatusDiagnostic = nextPairStatusDiagnostic;
    }
    const visibilityState =
      typeof document === "undefined" ? "unknown" : document.visibilityState;
    const hiddenDurationMs =
      this.hiddenStartedAt && visibilityState !== "hidden"
        ? Date.now() - this.hiddenStartedAt
        : undefined;
    if (hiddenDurationMs !== undefined) {
      this.hiddenStartedAt = undefined;
    }
    this.options.onDiagnostic?.({
      ...diagnostic,
      timestamp: Date.now(),
      visibilityState,
      online: typeof navigator === "undefined" ? true : navigator.onLine,
      ...(hiddenDurationMs !== undefined ? { hiddenDurationMs } : {}),
    } as WebRemoteControlTerminalTransportDiagnostic);
  }
}

interface WebRemoteControlAppPayloadRequesterOptions {
  sendPayload(payload: WebRemoteControlAppPayload): boolean;
  timeoutMs?: number;
}

interface WebRemoteControlAppPayloadRequestOptions {
  timeoutMs?: number;
}

interface PendingAppPayloadRequest<TResponse extends WebRemoteControlAppPayload> {
  isMatch(payload: WebRemoteControlAppPayload): payload is TResponse;
  resolve(payload: TResponse): void;
  reject(error: WebRemoteControlFailure): void;
  timer: ReturnType<typeof setTimeout>;
}

interface WebRemoteControlRelayRequestRecoveryOptions {
  recoverTimeout?: boolean;
}

function isRecoverableRelayRequestFailure(
  error: unknown,
  options?: WebRemoteControlRelayRequestRecoveryOptions,
): boolean {
  const failure = error as Partial<WebRemoteControlFailure> | undefined;
  return (
    failure?.reason === "relay-unavailable" ||
    (options?.recoverTimeout === true && failure?.reason === "desktop-bootstrap-timeout")
  );
}

export function createWebRemoteControlRelayRequestRecovery(
  recoverConnection: () => Promise<void>,
) {
  let recoveryPromise: Promise<void> | undefined;

  async function recoverRelayRequestPath(): Promise<void> {
    if (!recoveryPromise) {
      // Bugfix: 多个请求同时撞上 relay suspect 窗口时必须共用一次恢复。
      // 否则每个请求都会触发 recoverConnection，容易把短暂抖动放大成连续重连。
      recoveryPromise = recoverConnection().finally(() => {
        recoveryPromise = undefined;
      });
    }
    await recoveryPromise;
  }

  return async function requestWithRelayRecovery<T>(
    request: () => Promise<T>,
    options?: WebRemoteControlRelayRequestRecoveryOptions,
  ): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (!isRecoverableRelayRequestFailure(error, options)) {
        throw error;
      }
      await recoverRelayRequestPath();
      return request();
    }
  };
}

export function createWebRemoteControlAppPayloadRequester({
  sendPayload,
  timeoutMs: defaultTimeoutMs = 10_000,
}: WebRemoteControlAppPayloadRequesterOptions) {
  const pending = new Map<string, PendingAppPayloadRequest<WebRemoteControlAppPayload>>();

  function rejectRequest(requestId: string, failure: WebRemoteControlFailure): boolean {
    const request = pending.get(requestId);
    if (!request) {
      return false;
    }
    clearTimeout(request.timer);
    pending.delete(requestId);
    request.reject(failure);
    return true;
  }

  return {
    requestAppPayload<TResponse extends WebRemoteControlAppPayload>(
      payload: WebRemoteControlAppPayload & { requestId: string },
      isMatch: (payload: WebRemoteControlAppPayload) => payload is TResponse,
      options?: WebRemoteControlAppPayloadRequestOptions,
    ): Promise<TResponse> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(payload.requestId);
          reject(createFailure("desktop-bootstrap-timeout", "Desktop did not respond in time."));
        }, options?.timeoutMs ?? defaultTimeoutMs);
        pending.set(payload.requestId, {
          isMatch,
          resolve: resolve as (payload: WebRemoteControlAppPayload) => void,
          reject,
          timer,
        });
        if (!sendPayload(payload)) {
          // Bugfix: 之前非 paired / suspect 状态下 sendPayload 会静默丢弃，
          // requester 仍等到超时并误报“桌面未响应”。这里立即按链路不可发送失败，
          // 让上层可以选择等待重连或重放幂等请求。
          clearTimeout(timer);
          pending.delete(payload.requestId);
          reject(
            createFailure(
              "relay-unavailable",
              "Web remote control transport is not ready to send payload.",
            ),
          );
        }
      });
    },

    acceptPayload(payload: WebRemoteControlAppPayload): boolean {
      if (
        (payload.zcode_type === "app-error" || payload.zcode_type === "workspace-bridge-error") &&
        payload.requestId
      ) {
        // Bugfix: remote session 关闭这类异步 bridge error 会带合成 requestId，
        // 但它不是某个 pending request 的响应。只有真正命中 pending 时才消费，
        // 否则交给上层按 bridge 失效事件触发重连/降级 UI。
        return rejectRequest(
          payload.requestId,
          createFailure(payload.reason, payload.error),
        );
      }

      for (const [requestId, request] of pending) {
        if (!request.isMatch(payload)) {
          continue;
        }
        clearTimeout(request.timer);
        pending.delete(requestId);
        request.resolve(payload);
        return true;
      }
      return false;
    },

    rejectAll(failure: WebRemoteControlFailure): void {
      for (const [requestId, request] of pending) {
        clearTimeout(request.timer);
        pending.delete(requestId);
        request.reject(failure);
      }
    },

    dispose(): void {
      this.rejectAll(createFailure("desktop-disconnected", "Web remote control transport closed."));
    },
  };
}
