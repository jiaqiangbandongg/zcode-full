import { release } from "node:os";
import type { CuaOsSupport } from "@zcode/shared";

// 承诺地板 = max(Helper Info.plist LSMinimumSystemVersion 12.0, SEA 二进制 minos 11.0)。
// 2026-08 事故：地板检查缺位时，低版本 macOS 用户只看到授权反复无响应
// （真因是 LaunchServices -10825 拒启 Helper）。
export const CUA_MINIMUM_MACOS_VERSION = "12.0";
// 地板与上游 zcode-cua helperAppBundle.ts 的 Info.plist LSMinimumSystemVersion(12.0) 联动，
// bump 任一侧必须同步其余常量。
const CUA_MINIMUM_DARWIN_MAJOR = 21; // Darwin major - 9 = macOS major（21↔12, 22↔13）

export function darwinMajorToMacosMajor(major: number): number {
  return major - 9;
}

export function resolveCuaOsSupport(
  platform = process.platform,
  darwinRelease = release(),
): CuaOsSupport {
  if (platform !== "darwin") return { kind: "not-applicable" };
  const major = Number.parseInt(darwinRelease.split(".")[0] ?? "0", 10);
  if (Number.isNaN(major)) return { kind: "supported" };
  if (major < CUA_MINIMUM_DARWIN_MAJOR) {
    return {
      kind: "macos-below-minimum",
      minimumMacOs: CUA_MINIMUM_MACOS_VERSION,
      currentMacOs: String(darwinMajorToMacosMajor(major)),
    };
  }
  return { kind: "supported" };
}
