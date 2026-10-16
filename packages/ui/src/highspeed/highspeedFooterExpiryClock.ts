/**
 * Highspeed 组尾 footer 的到期显隐时钟。
 *
 * 背景（spec §9.3）：footer「以上由 Highspeed 生成」的显隐由 ConversationTimeline 的
 * `liveNowMs` 越过卡片 `expiresAt` 驱动。到期唤醒基于 renderer `setTimeout`，窗口隐藏/被
 * 遮挡时会被 Chromium 冻结停摆——定时器不再触发，`liveNowMs` 停在到期前，footer 直到用户
 * 再发一条消息（运行态时钟把 `liveNowMs` 跳到当前时间）才出现，违反「不要求用户再发送一条
 * 消息」。
 *
 * 因此这里在到期 `setTimeout` 之外，同时监听窗口恢复可见（`visibilitychange`）与获得焦点
 * （`focus`），窗口回到前台时立即补偿一次刷新，把 `liveNowMs` 追平当前时间。与 SessionPane
 * 的聚合链路窗口唤醒补偿（`highspeedAutoShareClock`）分工：那条刷新分享入口/查看按钮的
 * 完成态数据，这条刷新组尾 footer 的显隐时钟；两者都不依赖新消息或 snapshot 事件。
 */

type ExpiryClockWindow = Pick<
  Window & typeof globalThis,
  "setTimeout" | "clearTimeout" | "addEventListener" | "removeEventListener"
>;

type ExpiryClockDocument = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

export interface HighspeedFooterExpiryClockDeps {
  windowTarget?: ExpiryClockWindow;
  documentTarget?: ExpiryClockDocument;
  now?: () => number;
}

/**
 * 在下一张卡的到期边界唤醒一次 `onExpire`，并在窗口恢复可见/获得焦点时补偿唤醒。
 * 返回 dispose，用于清理定时器与监听（供 React effect 的 cleanup 调用）。
 */
export function armHighspeedFooterExpiryClock(
  nextExpiryMs: number,
  onExpire: () => void,
  deps: HighspeedFooterExpiryClockDeps = {},
): () => void {
  const windowTarget = deps.windowTarget ?? window;
  const documentTarget = deps.documentTarget ?? document;
  const now = deps.now ?? Date.now;

  // +20ms 缓冲确保触发时确实已越过 expiresAt，避免边界抖动导致 footer 判定仍为未到期。
  const delayMs = Math.max(0, nextExpiryMs - now()) + 20;
  const timer = windowTarget.setTimeout(onExpire, delayMs);

  const catchUpFromWindowWake = () => {
    // 切到隐藏态不补偿（与 SessionPane 同口径）；只在回到前台时追平时钟。
    if (documentTarget.visibilityState === "hidden") return;
    onExpire();
  };
  documentTarget.addEventListener("visibilitychange", catchUpFromWindowWake);
  windowTarget.addEventListener("focus", catchUpFromWindowWake);

  return () => {
    windowTarget.clearTimeout(timer);
    documentTarget.removeEventListener("visibilitychange", catchUpFromWindowWake);
    windowTarget.removeEventListener("focus", catchUpFromWindowWake);
  };
}
