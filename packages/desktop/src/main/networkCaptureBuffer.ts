import {
  NETWORK_CAPTURE_LIMIT,
  sanitizeNetworkCaptureUrl,
  type NetworkCaptureBatch,
  type NetworkCaptureSnapshot,
} from "@zcode/shared";

/** Main 仅保存有界观测元数据；captureId 隔离关闭后迟到的 IPC。 */
export class NetworkCaptureBuffer {
  private captureId: string | null = null;
  private records: NetworkCaptureSnapshot["records"] = [];
  private dropped = 0;
  private nextId = 0;
  start(captureId: string): void {
    this.clear();
    this.captureId = captureId;
  }
  stop(): void {
    this.captureId = null;
    this.clear();
  }
  clear(): void {
    this.records = [];
    this.dropped = 0;
  }
  ingest(batch: NetworkCaptureBatch): void {
    if (!this.captureId || batch.captureId !== this.captureId) return;
    this.dropped += batch.dropped;
    for (const record of batch.records) {
      const url = sanitizeNetworkCaptureUrl(record.url);
      if (url) this.records.push({ ...record, url, id: ++this.nextId });
    }
    const overflow = this.records.length - NETWORK_CAPTURE_LIMIT;
    if (overflow > 0) {
      this.records.splice(0, overflow);
      this.dropped += overflow;
    }
  }
  snapshot(): NetworkCaptureSnapshot {
    if (!this.captureId) throw new Error("Network capture is inactive");
    return { captureId: this.captureId, records: [...this.records], dropped: this.dropped };
  }
}
