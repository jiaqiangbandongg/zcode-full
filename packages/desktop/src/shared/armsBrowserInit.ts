import armsRum from "@arms/rum-electron/browser";
import type { ZCodeRuntimeEnv } from "@zcode/shared";
import { buildArmsBrowserInitConfig } from "./armsRumShared.js";

let bootstrapped = false;

/**
 * 在 preload 或 renderer 入口尽早初始化 Browser SDK。
 * 原因：Vite `type="module"` 的 main.tsx 往往在 window.load 之后才执行，perf-collector 只在 load 回调 sendPerf，
 * 仅放在 renderer 入口会导致 beforeReport 长期 perf=0；须在 preload 末尾（ARMS frame preload 已注入 Bridge 之后）调用。
 */
export function initArmsBrowserRumOnce(runtimeEnv: ZCodeRuntimeEnv): boolean {
  if (bootstrapped) {
    return true;
  }

  const bridge =
    typeof globalThis !== "undefined" &&
    (globalThis as { ArmsEventBridge?: { send?: unknown } }).ArmsEventBridge;
  const winBridge =
    typeof window !== "undefined" &&
    (window as { ArmsEventBridge?: { send?: (payload: string) => void } }).ArmsEventBridge;
  const resolved = bridge || winBridge;
  if (!resolved || typeof resolved.send !== "function") {
    return false;
  }

  bootstrapped = true;
  try {
    // Bugfix: Vite define 不会写入同名 globalThis 属性；由入口显式注入运行态，
    // 避免 production 产品环境下的本地开发事件误入 ARMS prod。
    armsRum.init(buildArmsBrowserInitConfig(runtimeEnv));
  } catch (error) {
    bootstrapped = false;
    console.warn("[arms] renderer RUM init failed:", error);
    return false;
  }

  // 极端竞态：init 时页面已 complete，补发 load 触发 sendPerf
  if (typeof document !== "undefined" && document.readyState === "complete") {
    window.dispatchEvent(new Event("load"));
  }
  return true;
}

/** preload 中 ARMS frame preload 可能晚于本脚本一帧，短重试避免 Bridge 尚未就绪 */
export function scheduleArmsBrowserRumInit(runtimeEnv: ZCodeRuntimeEnv, maxAttempts = 50): void {
  let attempts = 0;
  const tick = (): void => {
    if (initArmsBrowserRumOnce(runtimeEnv)) {
      return;
    }
    attempts += 1;
    if (attempts < maxAttempts) {
      setTimeout(tick, 0);
    } else {
      console.warn("[arms] ArmsEventBridge 不可用，跳过 renderer RUM 初始化");
    }
  };
  tick();
}
