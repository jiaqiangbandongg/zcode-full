import { describe, expect, it } from "vitest";
import { createOfficialMcpIssuanceAudit } from "../src/official-mcp/officialMcpIssuanceAudit.js";

describe("official MCP issuance audit", () => {
  it("dedupes by plugin, MCP, and real workspace identity", () => {
    const audit = createOfficialMcpIssuanceAudit(4);
    expect(audit.markFirst("plugin", "search", "remote:ssh:a:/repo")).toBe(true);
    expect(audit.markFirst("plugin", "search", "remote:ssh:a:/repo")).toBe(false);
    expect(audit.markFirst("plugin", "search", "remote:ssh:b:/repo")).toBe(true);
  });

  it("evicts the oldest key at capacity", () => {
    const audit = createOfficialMcpIssuanceAudit(2);
    expect(audit.markFirst("p", "m", "w1")).toBe(true);
    expect(audit.markFirst("p", "m", "w2")).toBe(true);
    expect(audit.markFirst("p", "m", "w3")).toBe(true);
    expect(audit.markFirst("p", "m", "w1")).toBe(true);
  });
});
