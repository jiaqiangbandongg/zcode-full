import type { OffPeakLifecycleEvent, OffPeakLifecycleState, OffPeakOutcome } from "@zcode/shared";
export type { OffPeakLifecycleEvent, OffPeakLifecycleState, OffPeakOutcome } from "@zcode/shared";

/** 工作事实由 Runtime 登记表、CommandInbox 与通知队列提供；此处不再维护副本。 */
export interface OffPeakWorkSnapshot {
  mainRunning: boolean;
  backgroundRunning: boolean;
  pendingNotifications: boolean;
  pendingInputs: boolean;
}

type WithoutIdentity<T> = T extends unknown ? Omit<T, "executionId" | "offPeakTaskId"> : never;
type LifecycleEffect = WithoutIdentity<OffPeakLifecycleEvent>;

class OffPeakLifecycleError extends Error {
  constructor(
    readonly code: "off_peak_user_takeover" | "off_peak_cancelled" | "off_peak_completed",
  ) {
    super(code);
    this.name = "OffPeakLifecycleError";
  }
}

interface TicketWaiter {
  resolve(ticketId: string): void;
  reject(error: unknown): void;
}

/** 仅管理闲时归属和票据寿命，不调度模型、Bash 或 Agent。 */
export class OffPeakLifecycle {
  private phase: OffPeakLifecycleState = "running_idle";
  private userOwned = false;
  private ticketId: string | undefined;
  private ticketAvailable = true;
  private renewalSequence = 0;
  private pendingRenewal: number | undefined;
  private appliedRenewal: { renewalId: number; ticketId: string } | undefined;
  private idleModelRounds = 0;
  private outcome: OffPeakOutcome = "succeeded";
  private readonly waiters = new Set<TicketWaiter>();
  private readonly releasedTickets = new Set<string>();

  constructor(
    private readonly deps: {
      executionId: string;
      offPeakTaskId: string;
      ticketId: string;
      readWork(): OffPeakWorkSnapshot;
      emit(event: OffPeakLifecycleEvent): void;
    },
  ) {
    this.ticketId = deps.ticketId;
  }

  get state(): OffPeakLifecycleState {
    return this.phase;
  }
  get ownedByUser(): boolean {
    return this.userOwned;
  }
  get terminal(): boolean {
    return this.phase === "completed" || this.phase === "cancelled";
  }

  retainIdleModelRound(): { release(): void } {
    if (this.terminal || this.userOwned) throw this.unavailableError();
    this.idleModelRounds++;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.idleModelRounds--;
        this.releaseUnusedTicket();
        this.workChanged();
      },
    };
  }

  mainEnded(outcome: OffPeakOutcome): void {
    if (this.terminal) return;
    this.outcome = outcome;
    this.workChanged();
  }

  workChanged(): void {
    if (this.terminal) return;
    const work = this.deps.readWork();
    // 票据等待也是未完成工作；后台终态到通知入队的过渡由 readWork 的通知事实覆盖。
    if (
      !work.mainRunning &&
      !work.backgroundRunning &&
      !work.pendingNotifications &&
      !work.pendingInputs &&
      this.pendingRenewal === undefined &&
      this.idleModelRounds === 0
    ) {
      this.changeState("completed");
      this.rejectWaiters(this.unavailableError());
      this.releaseUnusedTicket();
      this.emit({ type: "completed", outcome: this.outcome });
      return;
    }
    this.changeState(
      this.userOwned
        ? "running_user"
        : this.pendingRenewal !== undefined
          ? "waiting_ticket"
          : work.mainRunning
            ? "running_idle"
            : "waiting_background",
    );
  }

  ticketExpired(ticketId: string): number | undefined {
    if (this.terminal || this.userOwned || this.ticketId !== ticketId) return undefined;
    if (this.pendingRenewal !== undefined) return this.pendingRenewal;
    this.pendingRenewal = ++this.renewalSequence;
    this.ticketAvailable = false;
    this.changeState("waiting_ticket");
    this.emit({ type: "ticket_needed", renewalId: this.pendingRenewal, expiredTicketId: ticketId });
    return this.pendingRenewal;
  }

  replaceTicket(renewalId: number, ticketId: string): boolean {
    // 控制回执可能丢失；只确认最近一次已经安装的票，不能让旧重试覆盖更新的凭据。
    if (this.appliedRenewal?.renewalId === renewalId && this.appliedRenewal.ticketId === ticketId)
      return true;
    if (
      this.terminal ||
      this.userOwned ||
      this.pendingRenewal !== renewalId ||
      ticketId === this.ticketId
    )
      return false;
    const previousTicket = this.ticketId;
    this.appliedRenewal = { renewalId, ticketId };
    this.ticketId = ticketId;
    this.ticketAvailable = true;
    this.pendingRenewal = undefined;
    // 旧票已过期。换票不会重建工作，也不会重复执行 Bash；等待方继续消费原来的结果。
    if (previousTicket) this.releaseTicket(previousTicket);
    for (const waiter of this.waiters) waiter.resolve(ticketId);
    this.waiters.clear();
    this.workChanged();
    return true;
  }

  waitForTicket(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.terminal) return Promise.reject(this.unavailableError());
    if (
      this.ticketAvailable &&
      this.pendingRenewal === undefined &&
      this.ticketId &&
      (!this.userOwned || this.idleModelRounds > 0)
    ) {
      return Promise.resolve(this.ticketId);
    }
    if (this.userOwned) return Promise.reject(this.unavailableError());
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.waiters.delete(waiter);
        signal?.removeEventListener("abort", onAbort);
      };
      const waiter: TicketWaiter = {
        resolve: (ticketId) => {
          cleanup();
          resolve(ticketId);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const onAbort = () => waiter.reject(signal?.reason);
      this.waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  takeOver(): void {
    if (this.terminal || this.userOwned) return;
    this.userOwned = true;
    this.pendingRenewal = undefined;
    this.rejectWaiters(this.unavailableError());
    this.emit({ type: "user_takeover" });
    this.releaseUnusedTicket();
    this.workChanged();
  }

  cancel(): void {
    if (this.terminal) return;
    this.pendingRenewal = undefined;
    this.changeState("cancelled");
    this.rejectWaiters(this.unavailableError());
    this.releaseUnusedTicket();
    this.emit({ type: "completed", outcome: "stopped" });
  }

  private unavailableError(): OffPeakLifecycleError {
    return new OffPeakLifecycleError(
      this.phase === "cancelled"
        ? "off_peak_cancelled"
        : this.phase === "completed"
          ? "off_peak_completed"
          : "off_peak_user_takeover",
    );
  }

  private rejectWaiters(error: unknown): void {
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
  }

  private releaseUnusedTicket(): void {
    if ((!this.userOwned && !this.terminal) || this.idleModelRounds > 0 || !this.ticketId) return;
    const ticketId = this.ticketId;
    this.ticketId = undefined;
    this.releaseTicket(ticketId);
  }

  private releaseTicket(ticketId: string): void {
    if (this.releasedTickets.has(ticketId)) return;
    this.releasedTickets.add(ticketId);
    this.emit({ type: "ticket_released", ticketId });
  }

  private changeState(state: OffPeakLifecycleState): void {
    if (state === this.phase) return;
    this.phase = state;
    this.emit({ type: "state_changed", state });
  }

  private emit(effect: LifecycleEffect): void {
    this.deps.emit({
      ...effect,
      executionId: this.deps.executionId,
      offPeakTaskId: this.deps.offPeakTaskId,
    });
  }
}
