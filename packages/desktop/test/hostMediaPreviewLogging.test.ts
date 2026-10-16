import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("local media preview authorization logging", () => {
  it("allows four concurrent Range requests per Window Host", () => {
    const source = readFileSync(new URL("../src/host/index.ts", import.meta.url), "utf8");
    expect(source).toContain("activeRemoteMediaRequests >= 4");
    expect(source).toContain("getState: () => ({ active: activeRemoteMediaRequests, limit: 4 })");
  });

  it("records a low-frequency success event after Main returns a canonical path", () => {
    const source = readFileSync(new URL("../src/host/index.ts", import.meta.url), "utf8");
    const resultHandlerStart = source.indexOf(
      "if (msg.type === HostMessageTypes.LocalMediaPreviewPathAuthorizeResult)",
    );
    const resultHandlerEnd = source.indexOf("\n  }", resultHandlerStart);
    const resultHandler = source.slice(resultHandlerStart, resultHandlerEnd);

    expect(resultHandlerStart).toBeGreaterThan(0);
    expect(resultHandler).toContain('logger.info("local media preview path authorization OK")');
  });
});
