import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalDeferAppDataCleanup = process.env.ZCODE_E2E_DEFER_APP_DATA_CLEANUP;
const tempHomes: string[] = [];

afterEach(async () => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  process.env.ZCODE_E2E_DEFER_APP_DATA_CLEANUP = originalDeferAppDataCleanup;
  vi.resetModules();
  await Promise.all(tempHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("desktop e2e CLI config helpers", () => {
  it("defers app data cleanup to the WDIO afterSession owner", async () => {
    process.env.ZCODE_E2E_DEFER_APP_DATA_CLEANUP = "1";
    const { clearAppData } = await importDesktopAppHelper();

    await expect(clearAppData()).resolves.toBeUndefined();
  });

  it("restores an existing CLI config after a temporary seed", async () => {
    const home = await createTempHome();
    const cliConfigFile = join(home, ".zcode", "cli", "config.json");
    await mkdir(join(home, ".zcode", "cli"), { recursive: true });
    await writeFile(
      cliConfigFile,
      JSON.stringify({ provider: { existing: true } }, null, 2),
      "utf-8",
    );

    const { restoreCliConfig, seedCliConfig, snapshotCliConfig } = await importDesktopAppHelper();
    const snapshot = await snapshotCliConfig();
    await seedCliConfig({ network: { httpProxy: "http://127.0.0.1:4321" } });

    await restoreCliConfig(snapshot);

    expect(JSON.parse(await readFile(cliConfigFile, "utf-8"))).toEqual({
      provider: { existing: true },
    });
  });

  it("removes the CLI config when restoring a missing-file snapshot", async () => {
    const home = await createTempHome();
    const cliConfigFile = join(home, ".zcode", "cli", "config.json");

    const { restoreCliConfig, seedCliConfig, snapshotCliConfig } = await importDesktopAppHelper();
    const snapshot = await snapshotCliConfig();
    await seedCliConfig({ network: { httpProxy: "http://127.0.0.1:4321" } });

    await restoreCliConfig(snapshot);

    await expect(stat(cliConfigFile)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createTempHome() {
  const home = await mkdtemp(join(tmpdir(), "zcode-desktop-e2e-home-"));
  tempHomes.push(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  vi.resetModules();
  return home;
}

async function importDesktopAppHelper() {
  return import("./e2e/helpers/desktop-app.js");
}
