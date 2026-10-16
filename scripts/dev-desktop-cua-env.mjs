import { join } from "node:path";

export const WINDOWS_CUA_DEV_ROOT_ENV = "ZCODE_CUA_DEV_ROOT";

/**
 * 已安装 producer 相对仓库根的位置。Windows runtime 解析要求 DEV_ROOT 是物理目录
 * （root 不能是 symlink/junction），因此这里依赖仓库 .npmrc 的 node-linker=hoisted；
 * 换成 isolated linker 时该路径会变成 symlink，解析会以 development-root-not-found
 * fail closed，而不是悄悄换用别的运行时。
 */
export const WINDOWS_CUA_PRODUCER_SEGMENTS = ["node_modules", "@zcode", "zcode-cua"];

/**
 * 标准 dev 启动在 Windows 上要绑定的 CUA runtime 根。
 *
 * 2026-08-18 修复原因：macOS 的 `pnpm dev:desktop` 会把 ZCODE_CUA_BUNDLED_HELPER_APP_PATH
 * 绑到本 checkout 构建出的 Helper.app，开箱即用；Windows 之前什么都不注入，于是 host 落到
 * 产品分支去读 process.resourcesPath——dev 下那是 node_modules/electron/dist/resources，
 * 里面只有 default_app.asar，没有 tools/cua-helper，解析必然以 invalid-runtime-manifest
 * 失败。结果标准 dev 启动的 Windows computer use 恒不可用，且要靠开发者自己记得设
 * ZCODE_CUA_DEV_ROOT。这里补齐 macOS 已有的同一条原则：缺省绑定到本 checkout 已安装的
 * producer（即 pnpm-workspace catalog pin 指向的那一版，与产品 staging 同源）。
 *
 * 开发者显式设置 ZCODE_CUA_DEV_ROOT（例如指向自己的 zcode-cua source checkout）时永远尊重
 * 其取值，不覆盖；这里只补缺省，不改变 runtime 侧「只认 ZCODE_CUA_DEV_ROOT」的既有边界。
 */
export function resolveDevDesktopWindowsCuaEnv({ platform, repoRoot, env }) {
  if (platform !== "win32") return {};
  if (typeof repoRoot !== "string" || !repoRoot.trim()) {
    throw new Error("[dev-desktop-cua-env] repoRoot is required to resolve the Windows CUA root");
  }
  if (!env || typeof env !== "object") {
    throw new Error("[dev-desktop-cua-env] env is required to resolve the Windows CUA root");
  }
  // runtime 侧同样把纯空白视为未配置，这里保持一致，避免 "   " 既不启用覆盖也不给缺省。
  if (env[WINDOWS_CUA_DEV_ROOT_ENV]?.trim()) return {};
  return { [WINDOWS_CUA_DEV_ROOT_ENV]: join(repoRoot, ...WINDOWS_CUA_PRODUCER_SEGMENTS) };
}
