// 依赖与 architecture-policy.yaml 同步；新增文件必须属于此 managed 边界。
export const webRemoteRelayModule = {
  id: "web-remote-relay",
  requires: [],
  provides: ["web-remote-relay"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
