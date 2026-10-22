import type { WebRemoteControlWindowBootstrapResult } from "@zcode/shared";

interface WebRemoteControlVersionGuardOptions {
  /** 只读取响应；依赖当前连接的副作用由 onAccepted 同步提交。 */
  requestBootstrap(): Promise<WebRemoteControlWindowBootstrapResult>;
  onAccepted?(result: WebRemoteControlWindowBootstrapResult): void;
  getUrl(): string;
  isPageReady(): boolean;
  navigate(url: string): void;
  onMismatch(desktopVersion: string): void;
}

/** 只管理当前手机连接的版本校验；资源路由由服务端处理。 */
export function createWebRemoteControlVersionGuard(options: WebRemoteControlVersionGuardOptions) {
  let generation = 0;
  let disposed = false;
  let pendingUrl: string | undefined;
  let navigated = false;
  let inFlight: Promise<WebRemoteControlWindowBootstrapResult | undefined> | undefined;

  const confirm = () => {
    if (disposed || navigated || !pendingUrl) return;
    navigated = true;
    options.navigate(pendingUrl);
  };

  const invalidate = () => {
    generation += 1;
    inFlight = undefined;
  };

  return {
    isBlocked: () => pendingUrl !== undefined,
    confirm,
    invalidate,
    dispose() {
      disposed = true;
      invalidate();
    },
    check(): Promise<WebRemoteControlWindowBootstrapResult | undefined> {
      if (disposed || pendingUrl) return Promise.resolve(undefined);
      if (inFlight) return inFlight;
      const requestGeneration = generation;
      const request = Promise.resolve()
        .then(() => options.requestBootstrap())
        .then((result) => {
          // 重连可能让旧响应晚于新连接返回，不能用旧桌面的版本导航或初始化业务。
          if (disposed || requestGeneration !== generation) return undefined;
          const version = result.desktopAppVersion?.trim();
          if (version) {
            const url = new URL(options.getUrl());
            if (
              url.pathname.replace(/\/+$/, "") === "/remote/v4" &&
              url.searchParams.get("app_version") !== version
            ) {
              url.searchParams.set("app_version", version);
              pendingUrl = url.toString();
              if (options.isPageReady()) options.onMismatch(version);
              else confirm();
              return undefined;
            }
          }
          // 旧 bootstrap 曾先写入查看 epoch 再被丢弃；副作用必须和代际校验在同一同步段。
          options.onAccepted?.(result);
          return result;
        })
        .catch((error: unknown) => {
          if (disposed || requestGeneration !== generation) return undefined;
          throw error;
        })
        .finally(() => {
          if (inFlight === request) inFlight = undefined;
        });
      inFlight = request;
      return request;
    },
  };
}
