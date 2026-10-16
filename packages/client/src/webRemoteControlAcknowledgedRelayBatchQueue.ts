import type { AcknowledgedRelayOutboundBatch } from "./webRemoteControlAcknowledgedRelayProtocolTypes.js";

const COMPACT_RELEASED_PREFIX_THRESHOLD = 1_024;

export class AcknowledgedRelayBatchQueue {
  private storage: Array<AcknowledgedRelayOutboundBatch | undefined> = [];
  private headIndex = 0;
  private nextUnsentIndex = 0;

  get oldest(): AcknowledgedRelayOutboundBatch | undefined {
    return this.storage[this.headIndex];
  }

  get nextUnsent(): AcknowledgedRelayOutboundBatch | undefined {
    return this.storage[this.nextUnsentIndex];
  }

  get activeCount(): number {
    return this.storage.length - this.headIndex;
  }

  /** 内部有界性测试观察点；不从 @zcode/client public entry 导出。 */
  get retainedStorageSlots(): number {
    return this.storage.length;
  }

  get retainedBatchReferenceCount(): number {
    let count = 0;
    for (const batch of this.storage) if (batch) count += 1;
    return count;
  }

  get retainedPayloadBytes(): number {
    let bytes = 0;
    for (const batch of this.storage) if (batch) bytes += batch.outerBytes;
    return bytes;
  }

  append(batch: AcknowledgedRelayOutboundBatch): void {
    this.storage.push(batch);
  }

  advanceUnsent(): void {
    if (this.nextUnsentIndex < this.storage.length) this.nextUnsentIndex += 1;
  }

  resetReplay(): void {
    for (let index = this.headIndex; index < this.storage.length; index += 1) {
      const batch = this.storage[index];
      if (batch) batch.nextFrameIndex = 0;
    }
    this.nextUnsentIndex = this.headIndex;
  }

  releaseThrough(ackMessageSeq: number): { releasedBytes: number; releasedCount: number } {
    let releasedBytes = 0;
    let releasedCount = 0;
    while (this.headIndex < this.storage.length) {
      const batch = this.storage[this.headIndex]!;
      if (batch.messageSeq > ackMessageSeq) break;
      releasedBytes += batch.outerBytes;
      releasedCount += 1;
      // ACK 后立刻断开 payload/frame 引用；compact 只负责压缩轻量空槽，不能成为释放大数据的前提。
      this.storage[this.headIndex] = undefined;
      this.headIndex += 1;
    }
    this.nextUnsentIndex = Math.max(this.nextUnsentIndex, this.headIndex);
    this.compactReleasedPrefix();
    return { releasedBytes, releasedCount };
  }

  clear(): void {
    this.storage = [];
    this.headIndex = 0;
    this.nextUnsentIndex = 0;
  }

  private compactReleasedPrefix(): void {
    // Bugfix：逐条 cumulative ACK 若每次 splice 队首，会在 tiny RPC 堆积后退化成 O(n²)。
    // 平时只推进 head，达到阈值且释放过半时才批量 compact，保证搬移成本摊销有界。
    if (
      this.headIndex < COMPACT_RELEASED_PREFIX_THRESHOLD ||
      this.headIndex * 2 < this.storage.length
    ) {
      return;
    }
    const releasedPrefix = this.headIndex;
    this.storage = this.storage.slice(releasedPrefix);
    this.nextUnsentIndex = Math.max(0, this.nextUnsentIndex - releasedPrefix);
    this.headIndex = 0;
  }
}
