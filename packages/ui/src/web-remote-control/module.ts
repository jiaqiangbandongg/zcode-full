// 依赖与 architecture-policy.yaml 同步；新增文件必须属于此 managed 边界。
export const webRemoteControlUiModule = {
  id: "web-remote-control-ui",
  requires: ["mobile-ui", "services", "shared", "ui"],
  provides: ["web-remote-control-ui"],
  publicEntrypoints: [
    "index.ts",
    "contract.ts",
    "WebRemoteControlDeviceHeader.tsx",
    "app/useWebRemoteControlAuthSync.ts",
  ],
} as const;
