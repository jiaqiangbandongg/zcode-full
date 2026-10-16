import type { ZCodeEnv } from "@zcode/shared";

export function resolveMarketingTouchPollIntervalMs(
  isProductionBuild: boolean,
  env: ZCodeEnv,
): number {
  return isProductionBuild && env === "production" ? 10 * 60_000 : 30_000;
}

/** 唯一串行调度器；用户触发在途刷新合并为一次后续查询。 */
export function createMarketingTouchPoller(options: {
  query: () => Promise<void>;
  visible: () => boolean;
  intervalMs: number;
}) {
  let disposed = false;
  let running = false;
  let requested = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  function refresh() {
    if (disposed) return;
    stopTimer();
    if (!options.visible()) return;
    if (running) {
      requested = true;
      return;
    }
    running = true;
    void options
      .query()
      .then(
        () => {
          failures = 0;
        },
        () => {
          failures++;
        },
      )
      .finally(() => {
        running = false;
        if (disposed || !options.visible()) return;
        if (requested) {
          requested = false;
          refresh();
          return;
        }
        const delay = failures
          ? Math.min(600_000, 30_000 * 2 ** Math.min(failures - 1, 5))
          : // 迁移时曾丢失正式/测试环境频率；由入口显式注入，避免统一随机间隔。
            options.intervalMs;
        timer = setTimeout(refresh, delay);
      });
  }
  return {
    refresh,
    visibilityChanged() {
      if (options.visible()) refresh();
      else {
        stopTimer();
        requested = false;
      }
    },
    dispose() {
      disposed = true;
      stopTimer();
    },
  };
}
