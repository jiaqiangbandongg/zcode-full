import type { WebContents } from "electron";

/**
 * autoInject 在 dom-ready 才 executeJavaScript init，Vite 场景下 window.load 往往更早结束，
 * perf-collector 的 onLoad/sendPerf 不会跑（webvitals 仍可上报，故 beforeReport 里 perf=0）。
 * 在 did-finish-load 与 dom-ready 后补发 load，且等待 RumSDK 就绪。
 */
export const ARMS_BROWSER_PERF_LOAD_NUDGE_SCRIPT = `(function () {
  function dispatchLoad() {
    try {
      window.dispatchEvent(new Event("load"));
    } catch (e) {}
  }
  function tryNudge(attempt) {
    if (typeof window.RumSDK !== "undefined" && window.RumSDK.default) {
      if (document.readyState === "complete") {
        dispatchLoad();
      }
      return;
    }
    if (attempt < 80) {
      setTimeout(function () {
        tryNudge(attempt + 1);
      }, 25);
    }
  }
  if (document.readyState === "complete") {
    tryNudge(0);
  } else {
    window.addEventListener(
      "load",
      function () {
        tryNudge(0);
      },
      { once: true }
    );
  }
})();`;

export function scheduleArmsBrowserPerfLoadNudge(webContents: WebContents): void {
  const nudge = (): void => {
    if (webContents.isDestroyed()) {
      return;
    }
    void webContents.executeJavaScript(ARMS_BROWSER_PERF_LOAD_NUDGE_SCRIPT, true).catch(() => {
      // 非主窗口或注入失败时忽略
    });
  };

  webContents.on("did-finish-load", nudge);
  // 与 SDK autoInject 同挂在 dom-ready，延迟一拍等待 RumSDK.default.init 完成
  webContents.on("dom-ready", () => {
    setTimeout(nudge, 0);
    setTimeout(nudge, 150);
  });
}
