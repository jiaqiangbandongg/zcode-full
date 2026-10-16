import { describe, expect, it } from "vitest";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

describe("remote sync locale labels", () => {
  it("uses consistent technical-term capitalization for every sync action", () => {
    expect(zhCN["settings.skills.remoteSync.open"]).toBe("同步 Skill");
    expect(zhCN["settings.mcp.remoteSync.open"]).toBe("同步 MCP");
    expect(zhCN["settings.plugins.remoteSync.open"]).toBe("同步 Plugin");
    expect(enUS["settings.skills.remoteSync.open"]).toBe("Sync Skill");
    expect(enUS["settings.mcp.remoteSync.open"]).toBe("Sync MCP");
    expect(enUS["settings.plugins.remoteSync.open"]).toBe("Sync Plugin");
  });
});
