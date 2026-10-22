const WEB_REMOTE_CONTROL_BRIDGE_RECOVERY_RETRY_DELAYS_MS = [1_000, 2_000, 5_000] as const;

export function getWebRemoteControlBridgeRecoveryRetryDelay(attempt: number): number | null {
  return WEB_REMOTE_CONTROL_BRIDGE_RECOVERY_RETRY_DELAYS_MS[attempt] ?? null;
}

/** 同一恢复 owner 串行重建 bridge；重连成功必须等旧离线快照收口后再核对目标并恢复。 */
export function createWebRemoteControlBridgeRecoveryRunner(
  recover: (reason: string) => Promise<void>,
) {
  let flight: Promise<void> | undefined;
  return async (reason: string, shouldRecoverAfterCurrent?: () => boolean): Promise<void> => {
    if (flight) {
      await flight;
      if (!shouldRecoverAfterCurrent) return;
    }
    if (shouldRecoverAfterCurrent && !shouldRecoverAfterCurrent()) return;
    if (!flight) {
      // 先登记 flight 再调用 recover，避免 markDegraded 同步回调再次进入恢复。
      const next = Promise.resolve()
        .then(() => recover(reason))
        .finally(() => {
          if (flight === next) flight = undefined;
        });
      flight = next;
    }
    await flight;
  };
}
