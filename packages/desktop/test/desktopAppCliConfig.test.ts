import { afterEach, describe, expect, it, vi } from "vitest";

const originalDeferAppDataCleanup = process.env.ZCODE_E2E_DEFER_APP_DATA_CLEANUP;

afterEach(() => {
  process.env.ZCODE_E2E_DEFER_APP_DATA_CLEANUP = originalDeferAppDataCleanup;
  vi.resetModules();
});

describe("desktop e2e CLI config helpers", () => {
  it("defers app data cleanup to the WDIO afterSession owner", async () => {
    process.env.ZCODE_E2E_DEFER_APP_DATA_CLEANUP = "1";
    const { clearAppData } = await importDesktopAppHelper();

    await expect(clearAppData()).resolves.toBeUndefined();
  });
});

async function importDesktopAppHelper() {
  return import("./e2e/helpers/desktop-app.js");
}
