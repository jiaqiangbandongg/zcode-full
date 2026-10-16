import { Emitter, VSBuffer, type IMessagePassingProtocol } from "@zcode/rpc";
import {
  WebRemoteControlRpcTransportAssembler,
  WebRemoteControlRpcTransportEncodingError,
  encodeWebRemoteControlRpcTransportMessage,
  measureWebRemoteControlRpcRelayEnvelopeBytes,
  parseWebRemoteControlRpcTransportPayload,
  type WebRemoteControlRpcTransportFault,
  type WebRemoteControlRpcTransportFramePayload,
  type WebRemoteControlRpcTransportIdentity,
  type WebRemoteControlRpcTransportPayload,
} from "@zcode/shared";
import { AcknowledgedRelayBatchQueue } from "./webRemoteControlAcknowledgedRelayBatchQueue.js";
import { AcknowledgedRelayDeadline } from "./webRemoteControlAcknowledgedRelayDeadline.js";
import {
  ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS,
  type AcknowledgedWebRemoteControlRelayProtocolAdapter,
  type AcknowledgedWebRemoteControlRelayProtocolOptions,
  isRawTransportCandidate,
  measureAcknowledgedRelayBatchBytes,
  rawIdentityMatches,
  resolveAcknowledgedRelayLimits,
} from "./webRemoteControlAcknowledgedRelayProtocolTypes.js";
export {
  ACKNOWLEDGED_WEB_REMOTE_CONTROL_RELAY_LIMITS,
  type AcknowledgedWebRemoteControlRelayProtocolAdapter,
  type AcknowledgedWebRemoteControlRelayProtocolOptions,
} from "./webRemoteControlAcknowledgedRelayProtocolTypes.js";
class AcknowledgedRelayProtocol implements AcknowledgedWebRemoteControlRelayProtocolAdapter {
  private readonly identity: WebRemoteControlRpcTransportIdentity;
  private readonly sendFrame: AcknowledgedWebRemoteControlRelayProtocolOptions["sendFrame"];
  private readonly measureFrameBytes: NonNullable<
    AcknowledgedWebRemoteControlRelayProtocolOptions["measureFrameBytes"]
  >;
  private readonly highWaterMarkBytes: number;
  private readonly lowWaterMarkBytes: number;
  private readonly replayBufferMaxBytes: number;
  private readonly assemblyTimeoutMs: number;
  private readonly now: () => number;
  private readonly deadline: AcknowledgedRelayDeadline;
  private readonly onMessageEmitter = new Emitter<VSBuffer>();
  private readonly saturatedEmitter = new Emitter<void>();
  private readonly drainedEmitter = new Emitter<void>();
  private readonly degradedEmitter = new Emitter<WebRemoteControlRpcTransportFault>();
  private assembler: WebRemoteControlRpcTransportAssembler | null;
  private readonly outboundBatches = new AcknowledgedRelayBatchQueue();
  private queuedInbound: unknown[] = [];
  private pendingAckMessageSeq: number | null = null;
  private pendingAckQueuedAt: number | null = null;
  private nextPhysicalSeq = 1;
  private nextMessageSeq = 1;
  private highestFullySentMessageSeq = 0;
  private lastAckedMessageSeq = 0;
  private unacknowledgedByteCount = 0;
  private saturated = false;
  private disposed = false;
  private degraded = false;
  private flushing = false;
  private outboundCallDepth = 0;
  private assemblyTimer: ReturnType<typeof setTimeout> | undefined;
  readonly onSaturated = this.saturatedEmitter.event;
  readonly onDrained = this.drainedEmitter.event;
  readonly onDegraded = this.degradedEmitter.event;
  readonly protocol: IMessagePassingProtocol = {
    onMessage: this.onMessageEmitter.event,
    send: (buffer) => this.reserveMessage(buffer.buffer),
    drain: () => Promise.resolve(),
  };
  constructor(options: AcknowledgedWebRemoteControlRelayProtocolOptions) {
    this.identity = {
      bridgeSessionId: options.bridgeSessionId,
      ...(options.bridgeGeneration === undefined
        ? {}
        : { bridgeGeneration: options.bridgeGeneration }),
      ...(options.recoveryId === undefined ? {} : { recoveryId: options.recoveryId }),
    };
    this.sendFrame = options.sendFrame;
    this.measureFrameBytes =
      options.measureFrameBytes ?? measureWebRemoteControlRpcRelayEnvelopeBytes;
    const limits = resolveAcknowledgedRelayLimits(options);
    this.highWaterMarkBytes = limits.highWaterMarkBytes;
    this.lowWaterMarkBytes = limits.lowWaterMarkBytes;
    this.replayBufferMaxBytes = limits.replayBufferMaxBytes;
    this.assemblyTimeoutMs = limits.assemblyTimeoutMs;
    this.now = options.now ?? Date.now;
    this.deadline = new AcknowledgedRelayDeadline(
      limits.replayBufferGraceMs,
      this.now,
      () => {
        const oldest = this.outboundBatches.oldest;
        return {
          oldestData: oldest
            ? { queuedAt: oldest.queuedAt, messageSeq: oldest.messageSeq }
            : null,
          pendingAck:
            this.pendingAckQueuedAt === null || this.pendingAckMessageSeq === null
              ? null
              : { queuedAt: this.pendingAckQueuedAt, messageSeq: this.pendingAckMessageSeq },
        };
      },
      (fault) => this.enterDegraded(fault),
    );
    this.assembler = this.createAssembler();
  }
  get unacknowledgedBytes(): number {
    return this.unacknowledgedByteCount;
  }
  getBridgeSessionId(): string {
    return this.identity.bridgeSessionId;
  }
  isDegraded(): boolean {
    return this.degraded;
  }
  markDegraded(reasonCode = "remote.rpcFrame.manuallyDegraded"): void {
    this.enterDegraded({ reasonCode, terminal: true });
  }
  private createAssembler(): WebRemoteControlRpcTransportAssembler {
    return new WebRemoteControlRpcTransportAssembler({
      identity: this.identity,
      timeoutMs: this.assemblyTimeoutMs,
      now: this.now,
    });
  }
  private reserveMessage(bytes: Uint8Array): void {
    if (this.disposed || this.degraded || this.deadline.check()) return;
    let frames: readonly WebRemoteControlRpcTransportFramePayload[];
    try {
      frames = encodeWebRemoteControlRpcTransportMessage(bytes, {
        ...this.identity,
        firstPhysicalSeq: this.nextPhysicalSeq,
        messageSeq: this.nextMessageSeq,
      });
    } catch (error) {
      this.enterDegraded({
        reasonCode:
          error instanceof WebRemoteControlRpcTransportEncodingError
            ? error.reasonCode
            : "remote.rpcFrame.encodingFailed",
        terminal: true,
      });
      return;
    }
    let outerBytes = 0;
    try {
      outerBytes = measureAcknowledgedRelayBatchBytes(frames, this.measureFrameBytes);
    } catch {
      this.enterDegraded({ reasonCode: "remote.rpcFrame.outerMeterFailed", terminal: true });
      return;
    }
    if (this.unacknowledgedByteCount + outerBytes > this.replayBufferMaxBytes) {
      // Bugfix：必须在首片发送前对整批 final outer bytes 做 admission，不能给对端留下半条 RPC。
      this.enterDegraded({
        reasonCode: "remote.rpcFrame.replayBufferExceeded",
        terminal: true,
        messageSeq: this.nextMessageSeq,
      });
      return;
    }
    const messageSeq = this.nextMessageSeq;
    const lastFrame = frames.at(-1)!;
    this.outboundBatches.append({
      messageSeq,
      frames,
      outerBytes,
      queuedAt: this.now(),
      nextFrameIndex: 0,
    });
    this.unacknowledgedByteCount += outerBytes;
    this.nextMessageSeq += 1;
    this.nextPhysicalSeq = lastFrame.seq + 1;
    this.updateSaturationAfterReserve();
    this.deadline.refresh();
    this.flushPendingFrames();
  }
  private updateSaturationAfterReserve(): void {
    if (!this.saturated && this.unacknowledgedByteCount > this.highWaterMarkBytes) {
      this.saturated = true;
      this.saturatedEmitter.fire();
    }
  }
  private invokeSend(payload: WebRemoteControlRpcTransportPayload): boolean {
    this.outboundCallDepth += 1;
    try {
      return this.sendFrame(payload) !== false;
    } catch {
      this.enterDegraded({ reasonCode: "remote.rpcFrame.sendFailed", terminal: true });
      return false;
    } finally {
      this.outboundCallDepth -= 1;
    }
  }
  flushPendingFrames(): boolean {
    if (this.disposed || this.degraded || this.deadline.check()) return false;
    if (this.flushing) return false;
    this.flushing = true;
    let locallyDrained = true;
    try {
      while (!this.disposed && !this.degraded) {
        if (this.deadline.check()) {
          locallyDrained = false;
          break;
        }
        if (this.pendingAckMessageSeq !== null) {
          const ackMessageSeq = this.pendingAckMessageSeq;
          const accepted = this.invokeSend({
            zcode_type: "rpc-frame-ack",
            ...this.identity,
            ackMessageSeq,
          });
          if (!accepted || this.degraded || this.disposed) {
            locallyDrained = false;
            break;
          }
          if (this.pendingAckMessageSeq === ackMessageSeq) {
            this.pendingAckMessageSeq = null;
            this.pendingAckQueuedAt = null;
            this.deadline.refresh();
          }
          this.drainQueuedInbound();
          continue;
        }
        const batch = this.outboundBatches.nextUnsent;
        if (!batch) break;
        const frame = batch.frames[batch.nextFrameIndex]!;
        const accepted = this.invokeSend(frame);
        if (!accepted || this.degraded || this.disposed) {
          locallyDrained = false;
          break;
        }
        batch.nextFrameIndex += 1;
        if (batch.nextFrameIndex === batch.frames.length) {
          this.highestFullySentMessageSeq = Math.max(
            this.highestFullySentMessageSeq,
            batch.messageSeq,
          );
          this.outboundBatches.advanceUnsent();
        }
        this.drainQueuedInbound();
      }
    } finally {
      this.flushing = false;
    }
    if (!this.disposed && !this.degraded) this.drainQueuedInbound();
    return locallyDrained && this.pendingAckMessageSeq === null;
  }
  replayUnacknowledged(): boolean {
    if (this.disposed || this.degraded || this.deadline.check()) return false;
    this.outboundBatches.resetReplay();
    return this.flushPendingFrames();
  }
  acceptPayload(payload: unknown): boolean {
    if (this.disposed || this.degraded || !isRawTransportCandidate(payload)) return false;
    if (!rawIdentityMatches(this.identity, payload)) return false;
    if (this.deadline.check()) return true;
    if (this.outboundCallDepth > 0) {
      this.queuedInbound.push(payload);
      return true;
    }
    this.processInbound(payload);
    return true;
  }
  private drainQueuedInbound(): void {
    if (this.outboundCallDepth > 0 || this.disposed || this.degraded) return;
    while (this.queuedInbound.length > 0 && !this.disposed && !this.degraded) {
      this.processInbound(this.queuedInbound.shift());
    }
  }

  private processInbound(candidate: unknown): void {
    const payload = parseWebRemoteControlRpcTransportPayload(candidate);
    if (!payload) {
      this.enterDegraded({ reasonCode: "remote.rpcFrame.invalidPayload", terminal: true });
      return;
    }
    if (payload.zcode_type === "rpc-frame-ack") {
      this.processAck(payload.ackMessageSeq);
      return;
    }
    const result = this.assembler?.accept(payload, this.now());
    if (!result) return;
    if (result.kind === "fault") {
      if (result.fault.terminal) this.enterDegraded(result.fault);
      return;
    }
    if (result.kind === "incomplete") {
      this.scheduleAssemblyTimer();
      return;
    }
    if (result.kind === "duplicate") {
      if (result.ackMessageSeq !== null) this.queueAck(result.ackMessageSeq);
      return;
    }
    this.clearAssemblyTimer();
    try {
      this.onMessageEmitter.fire(VSBuffer.wrap(result.bytes));
    } catch {
      this.enterDegraded({
        reasonCode: "remote.rpcFrame.deliveryFailed",
        terminal: true,
        messageSeq: result.messageSeq,
      });
      return;
    }
    this.queueAck(result.messageSeq);
  }
  private queueAck(messageSeq: number): void {
    if (this.disposed || this.degraded) return;
    if (this.pendingAckMessageSeq === null) {
      this.pendingAckMessageSeq = messageSeq;
      this.pendingAckQueuedAt = this.now();
      this.deadline.refresh();
    } else if (messageSeq > this.pendingAckMessageSeq) {
      this.pendingAckMessageSeq = messageSeq;
    }
    this.flushPendingFrames();
  }
  private processAck(ackMessageSeq: number): void {
    if (ackMessageSeq <= this.lastAckedMessageSeq) return;
    if (ackMessageSeq > this.highestFullySentMessageSeq) {
      this.enterDegraded({
        reasonCode: "remote.rpcFrame.futureAck",
        terminal: true,
        messageSeq: ackMessageSeq,
      });
      return;
    }
    const { releasedBytes } = this.outboundBatches.releaseThrough(ackMessageSeq);
    this.unacknowledgedByteCount = Math.max(0, this.unacknowledgedByteCount - releasedBytes);
    this.lastAckedMessageSeq = ackMessageSeq;
    this.deadline.refresh();
    if (this.saturated && this.unacknowledgedByteCount <= this.lowWaterMarkBytes) {
      this.saturated = false;
      this.drainedEmitter.fire();
    }
  }
  private scheduleAssemblyTimer(): void {
    if (this.assemblyTimer || !this.assembler?.nextExpiryAt) return;
    const deadline = this.assembler.nextExpiryAt;
    this.assemblyTimer = setTimeout(() => {
      this.assemblyTimer = undefined;
      const result = this.assembler?.expire(this.now());
      if (result?.kind === "fault") this.enterDegraded(result.fault);
    }, Math.max(0, deadline - this.now()));
  }
  private clearAssemblyTimer(): void {
    if (this.assemblyTimer) clearTimeout(this.assemblyTimer);
    this.assemblyTimer = undefined;
  }
  private enterDegraded(fault: WebRemoteControlRpcTransportFault): void {
    if (this.disposed || this.degraded) return;
    this.degraded = true;
    this.deadline.dispose();
    this.clearAssemblyTimer();
    this.outboundBatches.clear();
    this.queuedInbound = [];
    this.pendingAckMessageSeq = null;
    this.pendingAckQueuedAt = null;
    this.unacknowledgedByteCount = 0;
    this.saturated = false;
    this.assembler = null;
    this.degradedEmitter.fire(fault);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.deadline.dispose();
    this.clearAssemblyTimer();
    this.outboundBatches.clear();
    this.queuedInbound = [];
    this.pendingAckMessageSeq = null;
    this.pendingAckQueuedAt = null;
    this.unacknowledgedByteCount = 0;
    this.assembler = null;
    this.onMessageEmitter.dispose();
    this.saturatedEmitter.dispose();
    this.drainedEmitter.dispose();
    this.degradedEmitter.dispose();
  }
}
export function createAcknowledgedWebRemoteControlRelayProtocol(
  options: AcknowledgedWebRemoteControlRelayProtocolOptions,
): AcknowledgedWebRemoteControlRelayProtocolAdapter {
  return new AcknowledgedRelayProtocol(options);
}
