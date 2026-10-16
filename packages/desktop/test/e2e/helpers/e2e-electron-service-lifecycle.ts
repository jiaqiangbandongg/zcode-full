export interface E2EElectronServiceBridgeLifecycle {
  initialize: () => Promise<void>;
  probe: () => Promise<void>;
  reset: () => void | Promise<void>;
}

const reloadBridgeByBrowser = new WeakMap<WebdriverIO.Browser, () => Promise<void>>();

export function registerE2EElectronServiceBridgeReload(
  browser: WebdriverIO.Browser,
  reload: () => Promise<void>,
) {
  reloadBridgeByBrowser.set(browser, reload);
}

export async function reloadE2EElectronServiceBridge(browser: WebdriverIO.Browser) {
  const reload = reloadBridgeByBrowser.get(browser);
  if (!reload) {
    throw new Error("Electron service reload callback 未注册");
  }
  await reload();
}

export async function initializeE2EElectronServiceBridge(
  lifecycle: E2EElectronServiceBridgeLifecycle,
) {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await lifecycle.initialize();
      await lifecycle.probe();
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 0) {
        // Bug 根因：wdio-electron-service 会吞掉首次 ContextId 初始化异常并返回
        // 不可用的 API stub；只检查 before 已 resolve 会让 renderer preflight 继续超时。
        await lifecycle.reset();
      }
    }
  }

  throw new Error("Electron service bridge 两次初始化后仍不可用", {
    cause: lastError,
  });
}
