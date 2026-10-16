export const genUiServiceModule = {
  id: "gen-ui-service",
  requires: ["services", "shared", "rpc", "gen-ui-protocol", "mcp-apps-protocol"],
  provides: ["gen-ui-service"],
  publicEntrypoints: ["index.ts", "contract.ts", "node.ts"],
} as const;
