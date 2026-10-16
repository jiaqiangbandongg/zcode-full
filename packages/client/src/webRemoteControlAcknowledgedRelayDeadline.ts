import type { WebRemoteControlRpcTransportFault } from "@zcode/shared";

interface PendingDeadlineEntry {
  queuedAt: number;
  messageSeq: number;
}

export interface AcknowledgedRelayDeadlineState {
  oldestData: PendingDeadlineEntry | null;
  pendingAck: PendingDeadlineEntry | null;
}

interface SelectedDeadline {
  deadline: number;
  fault: WebRemoteControlRpcTransportFault;
}

export class AcknowledgedRelayDeadline {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    private readonly graceMs: number,
    private readonly now: () => number,
    private readonly readState: () => AcknowledgedRelayDeadlineState,
    private readonly onExpired: (fault: WebRemoteControlRpcTransportFault) => void,
  ) {}

  check(): boolean {
    if (this.disposed) return false;
    const selected = this.select();
    if (!selected || this.now() < selected.deadline) return false;
    this.onExpired(selected.fault);
    return true;
  }

  refresh(): void {
    if (this.disposed) return;
    this.clear();
    const selected = this.select();
    if (!selected) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.check()) this.refresh();
    }, Math.max(0, selected.deadline - this.now()));
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private select(): SelectedDeadline | null {
    const state = this.readState();
    const data = state.oldestData;
    const ack = state.pendingAck;
    if (!data && !ack) return null;
    if (ack && (!data || ack.queuedAt <= data.queuedAt)) {
      return {
        deadline: ack.queuedAt + this.graceMs + 1,
        fault: {
          reasonCode: "remote.rpcFrame.ackGraceExceeded",
          terminal: true,
          messageSeq: ack.messageSeq,
        },
      };
    }
    return {
      deadline: data!.queuedAt + this.graceMs + 1,
      fault: {
        reasonCode: "remote.rpcFrame.replayGraceExceeded",
        terminal: true,
        messageSeq: data!.messageSeq,
      },
    };
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
