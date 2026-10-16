import { release as readPlatformRelease } from "node:os";
import type { DesktopWindowChromeState } from "@zcode/shared";

const WINDOWS_11_FIRST_BUILD = 22000;

export function resolveMacOSMajorVersion(
  platform: NodeJS.Platform,
  platformRelease: string,
): number | null {
  if (platform !== "darwin") return null;

  const darwinMajor = Number.parseInt(platformRelease.split(".")[0] ?? "", 10);
  if (!Number.isFinite(darwinMajor)) return null;

  // Tahoe 起产品版本从 15 跳到 26，不能继续套用旧的 Darwin - 9 映射。
  return darwinMajor >= 25 ? darwinMajor + 1 : darwinMajor - 9;
}

export function supportsNativeWindowsRoundedCorners(
  platform: NodeJS.Platform,
  platformRelease: string,
): boolean {
  if (platform !== "win32") return false;

  const build = Number.parseInt(platformRelease.split(".")[2] ?? "", 10);
  return Number.isFinite(build) && build >= WINDOWS_11_FIRST_BUILD;
}

export function resolveDesktopWindowChromeState(
  isMaximized: boolean,
  platform: NodeJS.Platform = process.platform,
  platformRelease: string = readPlatformRelease(),
): DesktopWindowChromeState {
  return {
    isMaximized,
    macOSMajorVersion: resolveMacOSMajorVersion(platform, platformRelease),
    supportsNativeRoundedCorners: supportsNativeWindowsRoundedCorners(platform, platformRelease),
  };
}
