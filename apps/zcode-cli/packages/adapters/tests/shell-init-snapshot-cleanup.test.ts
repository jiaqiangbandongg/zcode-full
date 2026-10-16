import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHELL_INIT_SNAPSHOT_RETENTION_DAYS,
  ShellInitSnapshotCleanupRegistry,
  cleanupStaleShellInitSnapshots,
  shellInitSnapshotsDir,
} from "../src/exec/shell-init-snapshot.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("shell init snapshot cleanup", () => {
  it("unlinks snapshots registered by the current adapter process", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-shell-init-cleanup-"));
    const registry = new ShellInitSnapshotCleanupRegistry();
    const snapshotPath = join(shellInitSnapshotsDir(rootDir), "snapshot-bash.sh");

    try {
      await mkdir(shellInitSnapshotsDir(rootDir), { recursive: true });
      await writeFile(snapshotPath, "# snapshot\n");
      registry.register(snapshotPath);

      const result = await registry.cleanupAll();

      expect(result).toEqual({ deleted: 1, errors: 0 });
      await expect(stat(snapshotPath)).rejects.toHaveProperty("code", "ENOENT");
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("treats already-missing registered snapshots as cleaned", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-shell-init-cleanup-"));
    const registry = new ShellInitSnapshotCleanupRegistry();
    const snapshotPath = join(shellInitSnapshotsDir(rootDir), "missing.sh");

    try {
      registry.register(snapshotPath);

      const first = await registry.cleanupAll();
      const second = await registry.cleanupAll();

      expect(first).toEqual({ deleted: 0, errors: 0 });
      expect(second).toEqual({ deleted: 0, errors: 0 });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("removes stale top-level .sh files under shell-snapshots and keeps fresh or non-sh files", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "zcode-shell-init-retention-"));
    const snapshotsDir = shellInitSnapshotsDir(rootDir);
    const staleSnapshot = join(snapshotsDir, "stale.sh");
    const freshSnapshot = join(snapshotsDir, "fresh.sh");
    const staleTextFile = join(snapshotsDir, "stale.txt");
    const staleNestedSnapshot = join(snapshotsDir, "nested", "stale.sh");
    const now = new Date("2026-06-26T00:00:00.000Z");
    const staleTime = new Date(
      now.getTime() - (DEFAULT_SHELL_INIT_SNAPSHOT_RETENTION_DAYS + 1) * DAY_MS,
    );

    try {
      await mkdir(snapshotsDir, { recursive: true });
      await mkdir(join(snapshotsDir, "nested"), { recursive: true });
      await writeFile(staleSnapshot, "# stale\n");
      await writeFile(freshSnapshot, "# fresh\n");
      await writeFile(staleTextFile, "not a shell snapshot\n");
      await writeFile(staleNestedSnapshot, "# nested stale\n");
      await utimes(staleSnapshot, staleTime, staleTime);
      await utimes(staleTextFile, staleTime, staleTime);
      await utimes(staleNestedSnapshot, staleTime, staleTime);

      const result = await cleanupStaleShellInitSnapshots({ now, rootDir });

      expect(result).toEqual({ deleted: 1, errors: 0 });
      await expect(stat(staleSnapshot)).rejects.toHaveProperty("code", "ENOENT");
      await expect(stat(freshSnapshot)).resolves.toBeDefined();
      await expect(stat(staleTextFile)).resolves.toBeDefined();
      await expect(stat(staleNestedSnapshot)).resolves.toBeDefined();
      await expect(readdir(snapshotsDir)).resolves.toEqual([
        "fresh.sh",
        "nested",
        "stale.txt",
      ]);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
