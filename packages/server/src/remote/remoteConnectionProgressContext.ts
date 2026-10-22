import { sanitizeRemoteConnectionLog } from "@zcode/shared";
import { AsyncLocalStorage } from "node:async_hooks";

export type RemoteConnectionProgressLevel = "info" | "warn" | "error";

export interface RemoteConnectionProgressEvent {
  requestId: string;
  level: RemoteConnectionProgressLevel;
  args: unknown[];
}

interface RemoteConnectionProgressStore {
  requestId: string;
  active: boolean;
}

/**
 * 把共享 Host 内并发产生的远程连接日志绑定到各自 requestId。
 *
 * 把远程连接并入 window-scoped Host 后，进程 label 不再代表某一次远程连接，
 * Main 无法从共享 stdout 判断日志属于哪个连接。AsyncLocalStorage 保留异步调用链上下文，
 * 同时在连接 Promise settle 后关闭上报，避免长生命周期 stream 的迟到日志继续污染连接面板。
 */
export function createRemoteConnectionProgressContext(options: {
  emit: (event: RemoteConnectionProgressEvent) => void;
}) {
  const storage = new AsyncLocalStorage<RemoteConnectionProgressStore>();

  return {
    async run<T>(requestId: string, task: () => Promise<T>): Promise<T> {
      const store: RemoteConnectionProgressStore = { requestId, active: true };
      return storage.run(store, async () => {
        try {
          return await task();
        } finally {
          store.active = false;
        }
      });
    },

    report(level: RemoteConnectionProgressLevel, args: unknown[]): void {
      const store = storage.getStore();
      if (!store?.active) {
        return;
      }
      // 不序列化配置对象；只有流水线主动上报的可读文本允许越过用户日志边界。
      const message = args
        .filter((arg): arg is string => typeof arg === "string")
        .map((arg) => sanitizeRemoteConnectionLog(arg))
        .filter(Boolean)
        .join(" ");
      if (message) options.emit({ requestId: store.requestId, level, args: [message] });
    },
  };
}
