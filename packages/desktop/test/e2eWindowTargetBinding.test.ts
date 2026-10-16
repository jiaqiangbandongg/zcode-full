import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { collectE2EWebDriverPageHandleCandidates } from "./e2e/helpers/e2e-window-target.js";

describe("desktop e2e window target binding", () => {
  it("only admits page targets owned by the current ChromeDriver handle table", () => {
    expect(
      collectE2EWebDriverPageHandleCandidates(
        ["app-error-handle", "renderer-handle"],
        [
          {
            id: "app-error-handle",
            type: "app",
            url: "chrome-error://chromewebdata/",
          },
          {
            id: "renderer-handle",
            type: "page",
            url: "file:///repo/packages/desktop/out/renderer/index.html",
          },
          {
            id: "stale-cdp-target",
            type: "page",
            url: "file:///repo/packages/desktop/out/renderer/index.html",
          },
        ],
      ),
    ).toEqual([
      {
        handle: "renderer-handle",
        targetUrl: "file:///repo/packages/desktop/out/renderer/index.html",
      },
    ]);
  });

  it("does not promote a CDP-only page target to a WebDriver handle", () => {
    expect(
      collectE2EWebDriverPageHandleCandidates(
        ["app-error-handle"],
        [
          {
            id: "renderer-target",
            type: "page",
            url: "file:///repo/packages/desktop/out/renderer/index.html",
          },
        ],
      ),
    ).toEqual([]);
  });

  it("configures ChromeDriver to exclude Electron's chrome-error app target", () => {
    const wdioSource = readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");

    expect(wdioSource).toMatch(/windowTypes:\s*\["page"\]/u);
    expect(wdioSource).not.toMatch(/windowTypes:\s*\[[^\]]*"app"/u);
  });

  it("registers renderer preflight as a real Mocha root hook after service setup", () => {
    const wdioSource = readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");

    const beforeStart = wdioSource.indexOf("\n  async before(");
    const beforeTestStart = wdioSource.indexOf("\n  async beforeTest(");
    expect(beforeStart).toBeGreaterThan(-1);
    expect(beforeTestStart).toBeGreaterThan(beforeStart);

    const beforeSource = wdioSource.slice(beforeStart, beforeTestStart);
    expect(beforeSource).toContain("currentE2EWorkerSpecs = specs");
    expect(beforeSource).not.toContain("runE2ERendererBridgePreflight");
    expect(beforeSource).not.toMatch(/\bbrowser\./u);

    expect(wdioSource).not.toContain("\n  async beforeSuite(");
    expect(wdioSource).toContain("rootHooks: createE2ERendererBridgeRootHooks(");
    expect(wdioSource).toMatch(/measureE2ELifecyclePhase\(\s*"before-suite"/u);
    expect(wdioSource).toContain("runE2ERendererBridgePreflight(currentE2EWorkerSpecs)");
  });

  it("surfaces renderer preflight failure without reloading inside the worker hook", () => {
    const wdioSource = readFileSync(new URL("../wdio.conf.ts", import.meta.url), "utf8");
    const preflightStart = wdioSource.indexOf("async function runE2ERendererBridgePreflight");
    const preflightEnd = wdioSource.indexOf(
      "async function waitForE2ERendererBridgePreflight",
      preflightStart,
    );

    expect(preflightStart).toBeGreaterThan(-1);
    expect(preflightEnd).toBeGreaterThan(preflightStart);

    const preflightSource = wdioSource.slice(preflightStart, preflightEnd);
    expect(preflightSource).not.toContain("browser.reloadSession()");
    expect(preflightSource.match(/waitForE2ERendererBridgePreflight\(\)/gu)).toHaveLength(1);
  });
});
