// 依赖与 architecture-policy.yaml 同步；新增文件必须属于此 managed 边界。
export const mobileUiModule = {
  id: "mobile-ui",
  requires: ["ui"],
  provides: ["mobile-ui"],
  publicEntrypoints: [
    "index.ts",
    "contract.ts",
    "DevicePlatformIcon.tsx",
    "ZCodeAppLogo.tsx",
    "bottom-sheet.tsx",
  ],
} as const;
