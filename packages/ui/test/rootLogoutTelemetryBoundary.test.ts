import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("logout telemetry boundary", () => {
  it("does not await auxiliary telemetry before the logout business flow", () => {
    const source = readFileSync(
      new URL("../src/root/useRootWorkspaceActions.ts", import.meta.url),
      "utf8",
    );
    const logoutFlow = source.match(
      /const handleLogout[\s\S]*?services\.oauthService\.logout\(\)/u,
    )?.[0];

    expect(logoutFlow).toBeDefined();
    expect(logoutFlow).toMatch(/void reportAppTelemetryEvent\(/u);
    expect(logoutFlow).not.toMatch(/await reportAppTelemetryEvent\(/u);
  });
});
