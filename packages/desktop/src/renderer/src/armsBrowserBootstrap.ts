import { initArmsBrowserRumOnce } from "../../shared/armsBrowserInit.js";

/** renderer 入口兜底（主路径在 preload 已 init，避免 module 脚本晚于 load） */
export function bootstrapArmsBrowserRum(): void {
  initArmsBrowserRumOnce(import.meta.env.DEV ? "development" : "production");
}
