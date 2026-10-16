export const genUiModule = {
  id: "gen-ui",
  requires: [
    "ui",
    "services",
    "gen-ui-service",
    "gen-ui-protocol",
    "mcp-apps-protocol",
    "plugin-ui",
  ],
  provides: ["gen-ui-message"],
  publicEntrypoints: ["index.ts", "contract.ts", "host.ts"],
} as const;
