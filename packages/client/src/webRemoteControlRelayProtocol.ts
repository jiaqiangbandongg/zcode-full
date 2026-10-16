import { Emitter, VSBuffer, type IMessagePassingProtocol } from "@zcode/rpc";
import type { WebRemoteControlAppPayload, WebRemoteControlRpcFramePayload } from "@zcode/shared";

export {
  ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS,
  createAcknowledgedWebRemoteControlRelayProtocol,
  type AcknowledgedWebRemoteControlRelayProtocolAdapter,
  type AcknowledgedWebRemoteControlRelayProtocolOptions,
} from "./webRemoteControlAcknowledgedRelayProtocol.js";

export interface WebRemoteControlRelayProtocolOptions {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  sendFrame(frame: WebRemoteControlRpcFramePayload): boolean | void;
  maxBufferedFrames?: number;
  bufferedFrameTimeoutMs?: number | null;
  onBufferedFrameTimeout?(count: number): void;
  onFrameGap?(gap: {
    bridgeSessionId: string;
    seq: number;
    expectedSeq: number;
  }): void;
}

export interface WebRemoteControlRelayProtocolAdapter {
  protocol: IMessagePassingProtocol;
  acceptPayload(payload: WebRemoteControlAppPayload): void;
  flushPendingFrames(): boolean;
  dropBufferedFrames(): number;
  getBridgeSessionId(): string;
  isDegraded(): boolean;
  markDegraded(): void;
  dispose(): void;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function createWebRemoteControlRelayProtocol({
  bridgeSessionId,
  bridgeGeneration,
  recoveryId,
  sendFrame,
  maxBufferedFrames = 50,
  bufferedFrameTimeoutMs = 5_000,
  onBufferedFrameTimeout,
  onFrameGap,
}: WebRemoteControlRelayProtocolOptions): WebRemoteControlRelayProtocolAdapter {
  const onMessage = new Emitter<VSBuffer>();
  let disposed = false;
  let degraded = false;
  let seq = 0;
  let inboundSeq = 0;
  let bufferedFrameTimer: ReturnType<typeof setTimeout> | undefined;
  const bufferedFrames: WebRemoteControlRpcFramePayload[] = [];

  function clearBufferedFrameTimer(): void {
    if (!bufferedFrameTimer) {
      return;
    }
    clearTimeout(bufferedFrameTimer);
    bufferedFrameTimer = undefined;
  }

  function startBufferedFrameTimer(): void {
    if (bufferedFrameTimer || bufferedFrames.length === 0) {
      return;
    }
    if (bufferedFrameTimeoutMs === null) {
      return;
    }
    bufferedFrameTimer = setTimeout(() => {
      bufferedFrameTimer = undefined;
      const timedOutCount = bufferedFrames.length;
      bufferedFrames.length = 0;
      onBufferedFrameTimeout?.(timedOutCount);
    }, bufferedFrameTimeoutMs);
  }

  function bufferFrame(frame: WebRemoteControlRpcFramePayload): void {
    if (bufferedFrames.length >= maxBufferedFrames) {
      const droppedCount = bufferedFrames.length + 1;
      bufferedFrames.length = 0;
      clearBufferedFrameTimer();
      onBufferedFrameTimeout?.(droppedCount);
      return;
    }
    bufferedFrames.push(frame);
    startBufferedFrameTimer();
  }

  function trySendFrame(frame: WebRemoteControlRpcFramePayload): boolean {
    if (degraded) {
      return false;
    }
    return sendFrame(frame) !== false;
  }

  function flushPendingFrames(): boolean {
    if (disposed || degraded || bufferedFrames.length === 0) {
      return false;
    }
    while (bufferedFrames.length > 0) {
      const frame = bufferedFrames[0];
      if (!frame) {
        clearBufferedFrameTimer();
        return true;
      }
      if (!trySendFrame(frame)) {
        startBufferedFrameTimer();
        return false;
      }
      bufferedFrames.shift();
    }
    clearBufferedFrameTimer();
    return true;
  }

  function dropBufferedFrames(): number {
    const droppedCount = bufferedFrames.length;
    bufferedFrames.length = 0;
    clearBufferedFrameTimer();
    return droppedCount;
  }

  function markDegraded(): void {
    if (degraded) {
      return;
    }
    degraded = true;
    // Bugfix: 手机硬恢复期间旧 bridge 的 RPC frame 已经无法判断幂等性。
    // 这里进入 degraded 后立即丢弃旧 buffer，避免 paired/send-ready 恢复时把旧请求刷到新状态里。
    dropBufferedFrames();
  }

  const protocol: IMessagePassingProtocol = {
    onMessage: onMessage.event,
    send(buffer) {
      if (disposed) {
        return;
      }
      if (degraded) {
        return;
      }
      seq += 1;
      const frame = {
        zcode_type: "rpc-frame",
        bridgeSessionId,
        ...(bridgeGeneration !== undefined ? { bridgeGeneration } : {}),
        ...(recoveryId ? { recoveryId } : {}),
        seq,
        dataBase64: bytesToBase64(buffer.buffer),
      } satisfies WebRemoteControlRpcFramePayload;
      if (bufferedFrames.length > 0) {
        bufferFrame(frame);
        flushPendingFrames();
        return;
      }
      // Bugfix: relay suspect 窗口内 sendFrame 可能返回 false。
      // RPC 帧不能静默丢弃，先短暂缓冲，等 transport 恢复 paired 后再按序 flush。
      if (!trySendFrame(frame)) {
        bufferFrame(frame);
      }
    },
    drain: () => Promise.resolve(),
  };

  return {
    protocol,
    flushPendingFrames,
    dropBufferedFrames,
    getBridgeSessionId: () => bridgeSessionId,
    isDegraded: () => degraded,
    markDegraded,
    acceptPayload(payload) {
      if (
        disposed ||
        degraded ||
        payload.zcode_type !== "rpc-frame" ||
        payload.bridgeSessionId !== bridgeSessionId
      ) {
        return;
      }
      const expectedSeq = inboundSeq + 1;
      if (payload.seq <= inboundSeq) {
        return;
      }
      if (payload.seq !== expectedSeq) {
        markDegraded();
        onFrameGap?.({
          bridgeSessionId,
          seq: payload.seq,
          expectedSeq,
        });
        return;
      }
      inboundSeq = payload.seq;
      onMessage.fire(VSBuffer.wrap(base64ToBytes(payload.dataBase64)));
    },
    dispose() {
      disposed = true;
      bufferedFrames.length = 0;
      clearBufferedFrameTimer();
      onMessage.dispose();
    },
  };
}
