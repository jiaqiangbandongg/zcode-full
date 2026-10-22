import type { BrowserScreenshotActivityLease } from "./browserScreenshotSurfaceContracts.js";
import {
  DesktopBrowserScreenshotTransientRetry,
  isTransientScreenshotCaptureError,
} from "./browserScreenshotTransientRetry.js";
import {
  startBrowserScreenshotTransparentWindowBootstrap,
  TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS,
  type BrowserWindowForTransparentBootstrap,
  type TransparentWindowBootstrap,
} from "./browserTransparentWindowBootstrap.js";

interface BrowserWindowForActivity extends BrowserWindowForTransparentBootstrap {
  webContents: {
    id: number;
    isDestroyed(): boolean;
    capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<unknown>;
  };
}

interface GuestWebContentsForActivity {
  id: number;
  isDestroyed(): boolean;
  readonly hostWebContents: { id: number } | null;
  capturePage(rect: { x: number; y: number; width: number; height: number }): Promise<unknown>;
}

interface ScreenshotActivityState {
  key: string;
  windowId: number;
  webContentsId: number;
  tokens: Map<symbol, { prepared: boolean }>;
  restoreGeneration: number;
  active: boolean;
  invalidationController: AbortController;
  transparentWindowBootstrap?: TransparentWindowBootstrap;
  capturePumpsAllowed: boolean;
  capturePumpStartTimer?: ReturnType<typeof setTimeout>;
  pumps: Record<"owner" | "guest", CapturePumpRuntime>;
}

interface CapturePumpRuntime {
  running: boolean;
  wakeDelay?: () => void;
  transientRetry: DesktopBrowserScreenshotTransientRetry;
}

/** 1×1 探测结果：transient 表示 Viz surface 尚未建立这类可自愈的失败。 */
type CaptureProbeOutcome = { ok: true } | { ok: false; transient: boolean };

const CAPTURE_PROBE_SUCCEEDED: CaptureProbeOutcome = { ok: true };
const CAPTURE_PROBE_FATAL: CaptureProbeOutcome = { ok: false, transient: false };
const CAPTURE_PROBE_TRANSIENT: CaptureProbeOutcome = { ok: false, transient: true };

const ACTIVITY_CAPTURE_RECT = { x: 0, y: 0, width: 1, height: 1 };
const CAPTURING_GUEST_MIN_INTERVAL_MS = 200;

/**
 * 按 owner BrowserWindow 管理短生命周期后台活动租约。
 *
 * Electron 的 backgroundThrottling=false 会唤醒同一 BrowserWindow 内全部
 * WebContents。browser-use tab 又按进程生命周期保留，若在建窗时永久关闭节流，窗口退到后台后
 * renderer、所有 guest 与 GPU 仍会持续跑帧。动态改回 true 也不会重新触发 hidden 调度。
 * 这里在截图 preparation group 内同时为 owner renderer 和目标 guest 维持可逆的 capturer
 * count；结束后由 Chromium 原生 capture lifecycle 恢复后台节流，且同窗其他 guest 不被唤醒。
 */
export class DesktopBrowserScreenshotActivityController {
  private readonly states = new Map<string, ScreenshotActivityState>();

  constructor(
    private readonly options: {
      fromId(windowId: number): BrowserWindowForActivity | null;
      fromWebContentsId(webContentsId: number): GuestWebContentsForActivity | null;
      allowTransparentWindowBootstrap?: boolean;
      hideTaskbarDuringTransparentWindowBootstrap?: boolean;
      log?(message: string): void;
    },
  ) {}

  acquire(input: {
    windowId: number;
    webContentsId: number;
    requestId: string;
    reason: "browser-screenshot" | "plugin-execution";
  }): BrowserScreenshotActivityLease | undefined {
    const stateKey = this.getStateKey(input.windowId, input.webContentsId);
    let state = this.states.get(stateKey);
    if (state && !state.active) {
      this.states.delete(stateKey);
      state = undefined;
    }
    if (!state) {
      const targets = this.resolveActivityTargets(input.windowId, input.webContentsId);
      if (!targets) {
        this.options.log?.(
          `[browser-screenshot-activity] acquire skipped windowId=${input.windowId} webContentsId=${input.webContentsId} requestId=${input.requestId}`,
        );
        return undefined;
      }
      const transparentWindowBootstrap = startBrowserScreenshotTransparentWindowBootstrap({
        win: targets.window,
        enabled: this.options.allowTransparentWindowBootstrap === true,
        windowId: input.windowId,
        webContentsId: input.webContentsId,
        requestId: input.requestId,
        hideTaskbarDuringBootstrap:
          this.options.hideTaskbarDuringTransparentWindowBootstrap === true,
        log: this.options.log,
      });
      if (transparentWindowBootstrap === false) {
        return undefined;
      }
      state = {
        key: stateKey,
        windowId: input.windowId,
        webContentsId: input.webContentsId,
        tokens: new Map(),
        restoreGeneration: 0,
        active: true,
        invalidationController: new AbortController(),
        transparentWindowBootstrap,
        capturePumpsAllowed: !transparentWindowBootstrap,
        pumps: {
          owner: { running: false, transientRetry: this.createTransientRetry() },
          guest: { running: false, transientRetry: this.createTransientRetry() },
        },
      };
      this.states.set(stateKey, state);
      this.scheduleCapturePumpsAfterTransparentBootstrap(state);
    } else {
      // 取消上一份 lease 安排的 microtask 停泵，连续截图复用同一 capturer activity。
      state.restoreGeneration += 1;
      state.pumps.owner.transientRetry.reset();
      state.pumps.guest.transientRetry.reset();
    }

    const token = Symbol(input.requestId);
    state.tokens.set(token, { prepared: false });
    this.wakeCapturePumps(state);
    this.ensureCapturePumps(state);
    let released = false;
    return {
      invalidated: state.invalidationController.signal,
      markPrepared: () => {
        if (released) return;
        const leaseState = state.tokens.get(token);
        if (!leaseState || leaseState.prepared) return;
        leaseState.prepared = true;
        this.maybeReleaseTransparentWindowBootstrap(state);
        // Ready 后继续让 owner/guest 背靠背 CopyFromSurface，最坏会把 35s
        // watchdog 全部变成高频 GPU readback。owner 已完成 rAF 握手，应停泵；guest
        // 只需低频推进隐藏页面，切为单 in-flight 的 5Hz 脉冲。
        this.wakeCapturePumps(state);
        this.ensureCapturePumps(state);
      },
      release: () => {
        if (released) return;
        released = true;
        this.releaseToken(stateKey, state, token);
      },
    };
  }

  private releaseToken(stateKey: string, state: ScreenshotActivityState, token: symbol): void {
    if (this.states.get(stateKey) !== state || !state.tokens.delete(token)) return;
    this.wakeCapturePumps(state);
    if (state.tokens.size > 0) return;

    const restoreGeneration = ++state.restoreGeneration;
    queueMicrotask(() => {
      if (
        this.states.get(stateKey) !== state ||
        state.tokens.size > 0 ||
        state.restoreGeneration !== restoreGeneration
      ) {
        return;
      }
      state.active = false;
      this.releaseTransparentWindowBootstrap(state);
      this.wakeCapturePumps(state);
      if (this.states.get(stateKey) === state) {
        this.states.delete(stateKey);
      }
    });
  }

  private async runCapturePump(
    state: ScreenshotActivityState,
    target: "owner" | "guest",
  ): Promise<void> {
    const runtime = state.pumps[target];
    runtime.running = true;
    let pendingStartedAt = Date.now();
    let pending: Promise<CaptureProbeOutcome> | undefined = this.captureOnce(state, target);
    try {
      while (pending) {
        const mode = this.getPumpMode(state, target);
        if (mode === "stopped") {
          const completed = await pending;
          if (!completed.ok) this.invalidateActivity(state, target);
          pending = undefined;
          continue;
        }

        if (mode === "continuous") {
          // Prepare 阶段必须先启动下一份再等待前一份，保证 owner 的两帧稳定校验不会在
          // capturer count 归零时重新被 hidden 调度；每个 target 最多两份 in-flight。
          const nextStartedAt = Date.now();
          const next = this.captureOnce(state, target);
          const completed = await pending;
          if (!completed.ok) {
            if (!completed.transient) {
              // 致命错误保持快败：不等可能永远 pending 的并发探测（hidden window 下
              // capturePage 会挂死），立即失效；pending 已落定，循环顶按 stopped 分支
              // 排空退出，在飞那份由 captureOnce 内部消化，不会产生悬空 rejection。
              this.invalidateActivity(state, target);
              continue;
            }
            // 用对象包裹补发探测：async 函数直接 return Promise 会被吸收成
            // “等该探测落定才返回”，泵会停在串行探测上无法恢复重叠节奏。
            const recovered = await this.recoverFromPreparingCaptureFailure(
              state,
              runtime,
              target,
              next,
            );
            pending = recovered?.pending;
            continue;
          }
          runtime.transientRetry.reset();
          pending = next;
          pendingStartedAt = nextStartedAt;
          // hidden window 下 Electron 的 1×1 capturePage 可能立即 resolve。
          // 若这里直接续泵，Promise continuation 会无限占用 microtask 队列，连 Ready IPC、
          // timeout、watchdog 和 second-instance 事件都无法调度，表现为应用假死且打不开。
          // 保留“先启动下一份”的 capturer 重叠，但每轮必须让出一次 main event loop。
          await this.waitForContinuousCaptureTurn(state, runtime, target);
          continue;
        }

        const completed = await pending;
        if (!completed.ok) {
          this.invalidateActivity(state, target);
          pending = undefined;
          continue;
        }
        pending = undefined;
        await this.waitForGuestCaptureSlot(state, runtime, pendingStartedAt);
        if (this.getPumpMode(state, target) === "stopped") continue;
        pendingStartedAt = Date.now();
        pending = this.captureOnce(state, target);
      }
    } finally {
      runtime.wakeDelay = undefined;
      runtime.running = false;
      if (this.getPumpMode(state, target) !== "stopped") {
        this.ensureCapturePump(state, target);
      }
    }
  }

  /**
   * 刚激活的冷 guest 首帧尚未合成时，prepare 阶段的 1×1 探测在截图请求的
   * 同一 turn 就会撞上未建立的 Viz surface，Chromium 抛 UnknownVizError；把任何
   * 一次探测失败都当致命错误立即 invalidate 会让首张截图 45ms 内被判死，只能靠 agent
   * 整轮重试。
   * UnknownVizError 是瞬态的——surface 建立后同类请求立即成功。进入本函数的首份失败
   * 已确认瞬态；这里先等并发的下一份落定（失败处理期间不允许再并发 CopyFromSurface，
   * surface 未就绪时的并发读回曾在 smoke 中触发 SIGSEGV），再串行退避重试；预算耗尽
   * 或并发那份为致命错误时回到原有快败 invalidate 语义。Ready 后（paced 阶段）的
   * 失败仍立即失效，不放宽。
   */
  private async recoverFromPreparingCaptureFailure(
    state: ScreenshotActivityState,
    runtime: CapturePumpRuntime,
    target: "owner" | "guest",
    next: Promise<CaptureProbeOutcome>,
  ): Promise<{ pending: Promise<CaptureProbeOutcome> } | undefined> {
    const nextCompleted = await next;
    if (nextCompleted.ok) {
      // 并发那份已成功：surface 已出现，无需退避，直接恢复常规重叠节奏。
      runtime.transientRetry.reset();
      return { pending: this.captureOnce(state, target) };
    }
    if (
      !nextCompleted.transient ||
      !runtime.transientRetry.schedule({
        target,
        windowId: state.windowId,
        webContentsId: state.webContentsId,
      })
    ) {
      this.invalidateActivity(state, target);
      return undefined;
    }
    await this.waitForTransientCaptureRetry(state, runtime, target);
    if (this.getPumpMode(state, target) === "stopped") return undefined;
    return { pending: this.captureOnce(state, target) };
  }

  private async captureOnce(
    state: ScreenshotActivityState,
    target: "owner" | "guest",
  ): Promise<CaptureProbeOutcome> {
    const targets = this.resolveActivityTargets(state.windowId, state.webContentsId);
    if (!targets) return CAPTURE_PROBE_FATAL;
    try {
      await targets[target].capturePage(ACTIVITY_CAPTURE_RECT);
      return CAPTURE_PROBE_SUCCEEDED;
    } catch (error) {
      this.options.log?.(
        `[browser-screenshot-activity] capture failed target=${target} windowId=${state.windowId} webContentsId=${state.webContentsId} error=${error instanceof Error ? error.message : String(error)}`,
      );
      return isTransientScreenshotCaptureError(error)
        ? CAPTURE_PROBE_TRANSIENT
        : CAPTURE_PROBE_FATAL;
    }
  }

  private createTransientRetry(): DesktopBrowserScreenshotTransientRetry {
    return new DesktopBrowserScreenshotTransientRetry({ log: this.options.log });
  }

  private ensureCapturePumps(state: ScreenshotActivityState): void {
    if (!state.capturePumpsAllowed) return;
    this.ensureCapturePump(state, "owner");
    this.ensureCapturePump(state, "guest");
  }

  private ensureCapturePump(state: ScreenshotActivityState, target: "owner" | "guest"): void {
    const runtime = state.pumps[target];
    if (runtime.running || this.getPumpMode(state, target) === "stopped") return;
    void this.runCapturePump(state, target);
  }

  private getPumpMode(
    state: ScreenshotActivityState,
    target: "owner" | "guest",
  ): "continuous" | "paced" | "stopped" {
    if (!state.active || state.tokens.size === 0) return "stopped";
    const preparing = Array.from(state.tokens.values()).some((token) => !token.prepared);
    if (preparing) return "continuous";
    return target === "guest" ? "paced" : "stopped";
  }

  private async waitForGuestCaptureSlot(
    state: ScreenshotActivityState,
    runtime: CapturePumpRuntime,
    captureStartedAt: number,
  ): Promise<void> {
    const remainingMs = Math.max(
      0,
      CAPTURING_GUEST_MIN_INTERVAL_MS - (Date.now() - captureStartedAt),
    );
    if (remainingMs === 0 || this.getPumpMode(state, "guest") !== "paced") return;
    await this.waitForPumpTurn(runtime, remainingMs);
  }

  private async waitForContinuousCaptureTurn(
    state: ScreenshotActivityState,
    runtime: CapturePumpRuntime,
    target: "owner" | "guest",
  ): Promise<void> {
    if (this.getPumpMode(state, target) !== "continuous") return;
    await this.waitForPumpTurn(runtime, 0);
  }

  private async waitForTransientCaptureRetry(
    state: ScreenshotActivityState,
    runtime: CapturePumpRuntime,
    target: "owner" | "guest",
  ): Promise<void> {
    if (this.getPumpMode(state, target) === "stopped") return;
    await this.waitForPumpTurn(runtime, runtime.transientRetry.retryDelayMs());
  }

  /** 可被 wakeCapturePumps 提前唤醒的有界等待；pump 每轮续泵前必须让出 main event loop。 */
  private waitForPumpTurn(runtime: CapturePumpRuntime, delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (runtime.wakeDelay === finish) runtime.wakeDelay = undefined;
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      runtime.wakeDelay = finish;
    });
  }

  private wakeCapturePumps(state: ScreenshotActivityState): void {
    state.pumps.owner.wakeDelay?.();
    state.pumps.guest.wakeDelay?.();
  }

  private invalidateActivity(state: ScreenshotActivityState, target: "owner" | "guest"): void {
    if (!state.active || state.tokens.size === 0) return;
    state.active = false;
    this.releaseTransparentWindowBootstrap(state);
    this.wakeCapturePumps(state);
    if (this.states.get(state.key) === state) {
      this.states.delete(state.key);
    }
    if (!state.invalidationController.signal.aborted) {
      // 只停泵是不够的：coordinator 已拿到的 lease 仍显示有效，只能等完整的
      // surface 准备超时。显式失效让准备阶段立即失败，Ready 后也能拒绝迟到截图。
      state.invalidationController.abort(
        new Error(`browser screenshot activity capture failed for ${target}`),
      );
    }
  }

  private resolveActivityTargets(
    windowId: number,
    webContentsId: number,
  ):
    | {
        window: BrowserWindowForActivity;
        owner: BrowserWindowForActivity["webContents"];
        guest: GuestWebContentsForActivity;
      }
    | undefined {
    const win = this.options.fromId(windowId);
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return undefined;
    const guest = this.options.fromWebContentsId(webContentsId);
    if (
      !guest ||
      guest.isDestroyed() ||
      guest.id !== webContentsId ||
      guest.hostWebContents?.id !== win.webContents.id
    ) {
      return undefined;
    }
    return { window: win, owner: win.webContents, guest };
  }

  private releaseTransparentWindowBootstrap(state: ScreenshotActivityState): void {
    if (state.capturePumpStartTimer) {
      clearTimeout(state.capturePumpStartTimer);
      state.capturePumpStartTimer = undefined;
    }
    state.transparentWindowBootstrap?.release();
    state.transparentWindowBootstrap = undefined;
  }

  private scheduleCapturePumpsAfterTransparentBootstrap(state: ScreenshotActivityState): void {
    if (!state.transparentWindowBootstrap) return;
    state.capturePumpStartTimer = setTimeout(() => {
      state.capturePumpStartTimer = undefined;
      if (!state.active || this.states.get(state.key) !== state) return;
      state.capturePumpsAllowed = true;
      // showInactive 同一 turn 内并发 CopyFromSurface 时，Viz 尚未建立 surface，
      // Electron 会报 UnknownVizError，真实 smoke 甚至触发过 SIGSEGV。先给窗口一个有界
      // presentation grace，再启动 capturer；若 renderer 已 Ready，只启动 guest paced pump。
      this.ensureCapturePumps(state);
      this.maybeReleaseTransparentWindowBootstrap(state);
    }, TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS);
  }

  private maybeReleaseTransparentWindowBootstrap(state: ScreenshotActivityState): void {
    if (
      !state.capturePumpsAllowed ||
      Array.from(state.tokens.values()).some((candidate) => !candidate.prepared)
    ) {
      return;
    }
    this.releaseTransparentWindowBootstrap(state);
  }

  private getStateKey(windowId: number, webContentsId: number): string {
    return `${windowId}:${webContentsId}`;
  }
}
