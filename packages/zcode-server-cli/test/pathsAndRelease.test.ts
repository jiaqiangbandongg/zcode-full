import { describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, readdir, realpath, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createDaemonServiceDescriptor } from "../src/platform/serviceManager.js";
import { resolveCanonicalServerLayout, resolveServerLayout, validateUninstallTarget } from "../src/runtime/paths.js";
import { ReleaseManager } from "../src/runtime/releaseManager.js";

describe("server runtime layout", () => {
  it("derives one layout identity from symlink aliases, including missing roots", async () => {
    const physicalParent = await mkdtemp(join(tmpdir(), "zcode-r2-canonical-parent-"));
    const aliasParent = `${physicalParent}-alias`;
    await symlink(physicalParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
    const physicalRoot = join(physicalParent, "missing", "server");
    const aliasRoot = join(aliasParent, "missing", "server");

    const physicalLayout = await resolveCanonicalServerLayout(physicalRoot);
    const aliasLayout = await resolveCanonicalServerLayout(aliasRoot);

    expect(aliasLayout.serverRoot).toBe(physicalLayout.serverRoot);
    expect(aliasLayout.controlEndpoint).toBe(physicalLayout.controlEndpoint);
    expect(createDaemonServiceDescriptor({ platform: "linux", layout: aliasLayout }).name)
      .toBe(createDaemonServiceDescriptor({ platform: "linux", layout: physicalLayout }).name);
  });

  it("keeps release switching under server data root and writes atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-layout-"));
    const layout = resolveServerLayout(root);
    const releases = new ReleaseManager(layout);
    await releases.ensure();
    await mkdir(join(layout.releasesDir, "1.0.0"));
    await releases.writePending({ version: "1.0.0", releaseDir: join(layout.releasesDir, "1.0.0") });
    await releases.applyPending();
    expect(JSON.parse(await readFile(layout.currentFile, "utf8"))).toMatchObject({ version: "1.0.0" });
    await releases.restoreCurrent(null);
    await expect(readFile(layout.currentFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(validateUninstallTarget(layout.serverRoot, layout.serverRoot)).toMatchObject({ ok: true });
    expect(validateUninstallTarget(layout.serverRoot, join(dirname(root), "workspace"))).toMatchObject({
      ok: false,
    });
  });

  it("uses unique temporary files for concurrent JSON writes in one process", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-atomic-write-"));
    const layout = resolveServerLayout(root);
    const releases = new ReleaseManager(layout);
    await releases.ensure();
    await Promise.all([
      mkdir(join(layout.releasesDir, "a")),
      mkdir(join(layout.releasesDir, "b")),
    ]);
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      await expect(Promise.all([
        releases.writePending({ version: "a", releaseDir: join(layout.releasesDir, "a") }),
        releases.writePending({ version: "b", releaseDir: join(layout.releasesDir, "b") }),
      ])).resolves.toHaveLength(2);
    } finally {
      now.mockRestore();
    }
    expect((await releases.readPending())?.version).toMatch(/^[ab]$/u);
    expect((await readdir(layout.serverRoot)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("recovers an interrupted release transaction before the next daemon start", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-release-recovery-"));
    const layout = resolveServerLayout(root);
    const releases = new ReleaseManager(layout);
    await releases.ensure();
    const oldDir = join(layout.releasesDir, "old");
    const newDir = join(layout.releasesDir, "new");
    await mkdir(oldDir);
    await mkdir(newDir);
    await releases.writePending({ version: "old", releaseDir: oldDir });
    await releases.applyPending();
    const previous = await releases.readCurrent();
    await releases.writePending({ version: "new", releaseDir: newDir });
    await releases.applyPendingWithTransaction(previous);

    await releases.recoverInterruptedUpdate();

    expect((await releases.readCurrent())?.version).toBe("old");
    await expect(readFile(layout.updateTransactionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes one complete ownership marker under concurrent ensure calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-ownership-race-"));
    const layout = resolveServerLayout(root);

    await expect(Promise.all(
      Array.from({ length: 50 }, async () => await new ReleaseManager(layout).ensure()),
    )).resolves.toHaveLength(50);

    expect(JSON.parse(await readFile(layout.installFile, "utf8"))).toMatchObject({
      product: "zcode-server",
      schemaVersion: 1,
      canonicalServerRoot: await realpath(layout.serverRoot),
    });
  });
});
