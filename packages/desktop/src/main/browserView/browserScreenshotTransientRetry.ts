/** Chromium 在 Viz surface 建立前执行 CopyFromSurface 会抛 UnknownVizError；surface
 * 一旦建立，同样的请求立即成功。除此之外的失败（guest 销毁、跨窗口等）都是致命的。 */
export function isTransientScreenshotCaptureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("UnknownVizError");
}

export interface ScreenshotTransientRetryContext {
  target: "owner" | "guest";
  windowId: number;
  webContentsId: number;
}

const TRANSIENT_CAPTURE_RETRY_DELAY_MS = 100;
// 预算必须小于 surface prepare 的 3s 超时（BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS），
// 给 renderer 握手留出余量。
const TRANSIENT_CAPTURE_RETRY_BUDGET_MS = 2_000;

/**
 * prepare 阶段探测的瞬态重试预算：UnknownVizError 归为瞬态、由调用方串行退避重试，
 * 连续失败累计超过预算即放弃（回到快败 invalidate 语义）；任一次成功后 reset 重新计。
 */
export class DesktopBrowserScreenshotTransientRetry {
  private startedAt: number | undefined;
  private attempts = 0;

  constructor(
    private readonly options: {
      delayMs?: number;
      budgetMs?: number;
      log?(message: string): void;
    } = {},
  ) {}

  retryDelayMs(): number {
    return this.options.delayMs ?? TRANSIENT_CAPTURE_RETRY_DELAY_MS;
  }

  /** 记录一次瞬态失败；返回 false 表示预算耗尽，不再重试。 */
  schedule(context: ScreenshotTransientRetryContext): boolean {
    this.startedAt ??= Date.now();
    this.attempts += 1;
    if (
      Date.now() - this.startedAt >=
      (this.options.budgetMs ?? TRANSIENT_CAPTURE_RETRY_BUDGET_MS)
    ) {
      this.options.log?.(
        `[browser-screenshot-activity] transient capture retry budget exhausted target=${context.target} windowId=${context.windowId} webContentsId=${context.webContentsId} attempts=${this.attempts}`,
      );
      return false;
    }
    this.options.log?.(
      `[browser-screenshot-activity] transient capture retry scheduled target=${context.target} windowId=${context.windowId} webContentsId=${context.webContentsId} attempt=${this.attempts} delayMs=${this.retryDelayMs()}`,
    );
    return true;
  }

  reset(): void {
    this.startedAt = undefined;
    this.attempts = 0;
  }
}
