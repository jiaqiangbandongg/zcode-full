import { mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireDreamLock,
  buildMemoryDreamPrompt,
  collectDreamTouchedPaths,
  evaluateAutoDreamTiming,
  restoreDreamLockAfterFailure,
} from "../src/memory/dream.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("Memory Dream prompt", () => {
  it("matches the frozen provider-visible fixture", () => {
    const fixture = readFileSync(
      new URL("./fixtures/memory/dream-prompt.md", import.meta.url),
      "utf8",
    ).trimEnd();

    expect(
      buildMemoryDreamPrompt({
        memoryRoot: "<MEMORY_ROOT>",
        sessionIds: Array.from({ length: 7 }, () => "<SESSION_ID>"),
        transcriptRoot: "<SESSION_TRANSCRIPT_ROOT>",
      }),
    ).toBe(fixture);
  });
});

describe("auto Dream timing gate", () => {
  const day = 24 * 60 * 60 * 1000;
  const tenMinutes = 10 * 60 * 1000;
  const now = Date.parse("2026-07-16T12:00:00.000Z");

  it("checks the 24 hour gate before scan throttling", () => {
    expect(
      evaluateAutoDreamTiming({
        lastConsolidatedAtMs: now - day + 1,
        lastScanAtMs: now - tenMinutes - 1,
        nowMs: now,
      }),
    ).toEqual({ decision: "skip", reason: "minimum-interval" });
  });

  it("throttles scans only after the 24 hour gate passes", () => {
    expect(
      evaluateAutoDreamTiming({
        lastConsolidatedAtMs: now - day,
        lastScanAtMs: now - tenMinutes + 1,
        nowMs: now,
      }),
    ).toEqual({ decision: "skip", reason: "scan-throttled" });
    expect(
      evaluateAutoDreamTiming({
        lastConsolidatedAtMs: now - day,
        lastScanAtMs: now - tenMinutes,
        nowMs: now,
      }),
    ).toEqual({ decision: "scan" });
  });
});

describe("Dream consolidation lock", () => {
  it("acquires a missing lock and removes it when the run fails", async () => {
    const root = await temporaryDirectory();

    const priorMtime = await acquireDreamLock({ memoryRoot: root, pid: process.pid });

    expect(priorMtime).toBe(0);
    expect((await readFile(join(root, ".consolidate-lock"), "utf8")).trim()).toBe(
      String(process.pid),
    );

    await restoreDreamLockAfterFailure({ memoryRoot: root, priorMtimeMs: priorMtime! });
    await expect(stat(join(root, ".consolidate-lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not take a fresh lock held by a live PID", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, ".consolidate-lock");
    await writeFile(lockPath, String(process.pid), "utf8");

    await expect(acquireDreamLock({ memoryRoot: root, pid: process.pid })).resolves.toBeNull();
    expect((await readFile(lockPath, "utf8")).trim()).toBe(String(process.pid));
  });

  it("takes a stale lock and restores empty content with its original mtime after failure", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, ".consolidate-lock");
    const oldMtime = Date.parse("2026-07-14T01:02:03.000Z");
    await writeFile(lockPath, "99999999", "utf8");
    await utimes(lockPath, oldMtime / 1000, oldMtime / 1000);

    const priorMtime = await acquireDreamLock({ memoryRoot: root, pid: process.pid });
    expect(priorMtime).toBe(oldMtime);

    await restoreDreamLockAfterFailure({ memoryRoot: root, priorMtimeMs: priorMtime! });
    expect(await readFile(lockPath, "utf8")).toBe("");
    expect((await stat(lockPath)).mtimeMs).toBeCloseTo(oldMtime, -1);
  });
});

describe("Dream touched paths", () => {
  const root = "/storage/memory";

  it("records canonical allowed Write/Edit and narrow rm targets in first-seen order", () => {
    const paths = new Set<string>();
    collectDreamTouchedPaths(paths, {
      rootDir: root,
      toolCall: {
        id: "write",
        name: "Write",
        input: { file_path: `${root}/fact.md` },
      },
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    });
    collectDreamTouchedPaths(paths, {
      rootDir: root,
      toolCall: {
        id: "remove",
        name: "Bash",
        input: { command: `rm -f ${root}/old.md ${root}/fact.md` },
      },
      workingDirectory: "/workspace",
      workspaceRoot: "/workspace",
    });

    expect([...paths]).toEqual([`${root}/fact.md`, `${root}/old.md`]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "zcode-memory-dream-"));
  temporaryDirectories.push(path);
  return path;
}
