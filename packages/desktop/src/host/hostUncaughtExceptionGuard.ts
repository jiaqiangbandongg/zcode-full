export interface HostUncaughtExceptionGuardOptions {
  onRecovered: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void;
  onFatal: (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => void;
}

export function isRecoverableHostAllocationError(error: unknown): error is RangeError {
  return error instanceof RangeError && error.message === "Failed to allocate memory";
}

export function createHostUncaughtExceptionHandler({
  onRecovered,
  onFatal,
}: HostUncaughtExceptionGuardOptions): (
  error: Error,
  origin: NodeJS.UncaughtExceptionOrigin,
) => void {
  return (error, origin) => {
    if (!isRecoverableHostAllocationError(error)) {
      onFatal(error, origin);
      return;
    }

    try {
      // Electron 内置 Node 在 TLS 握手中把 peer certificate 投影成 JS 对象时，
      // native Buffer 分配失败会逃出 socket 回调；Utility Process 默认直接 abort。
      // 同类分配错误在普通 Promise 链里可被请求超时/重试回收，因此这里只隔离该明确错误，
      // 不能把日志上报失败再次升级成进程级未捕获异常。
      onRecovered(error, origin);
    } catch {
      // 内存紧张时诊断日志本身也可能分配失败，保护边界必须保持无抛出。
    }
  };
}
