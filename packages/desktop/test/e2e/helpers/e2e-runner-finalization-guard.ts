export interface E2ERunnerFinalizationGuard {
  arm(): void;
  disarm(): void;
  isArmed(): boolean;
}

export function createE2ERunnerFinalizationGuard(options: {
  onTimeout: () => void;
  timeoutMs: number;
}): E2ERunnerFinalizationGuard {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    arm() {
      if (timer) clearTimeout(timer);
      // 修复原因：最后一个 worker 结束后若没有 ref handle，Node 可能在 WDIO
      // onComplete continuation 前静默退出 0。这里故意保留默认 ref 语义。
      timer = setTimeout(() => {
        timer = null;
        options.onTimeout();
      }, options.timeoutMs);
    },
    disarm() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    isArmed() {
      return timer !== null;
    },
  };
}
