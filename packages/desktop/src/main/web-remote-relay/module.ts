// 依赖与 architecture-policy.yaml 同步；新增文件必须属于此 managed 边界。
export const desktopWebRemoteRelayModule = {
  id: "desktop-web-remote-relay",
  requires: ["client", "desktop", "shared", "web-remote-relay"],
  provides: ["desktop-web-remote-relay"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
