import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ReleaseManifest } from "../src/contracts.js";
import { resolveServerLayout } from "../src/runtime/paths.js";
import { ReleaseManager } from "../src/runtime/releaseManager.js";
import {
  createUpdateDaemonHandoff,
  type UpdateHandoffProcessBoundary,
} from "../src/runtime/updateHandoff.js";

async function createReleasePair(): Promise<{
  layout: ReturnType<typeof resolveServerLayout>;
  previous: ReleaseManifest;
  target: ReleaseManifest;
}> {
  const root = await mkdtemp(join(tmpdir(), "zcode-update-handoff-"));
  const layout = resolveServerLayout(join(root, "server"));
  const releases = new ReleaseManager(layout);
  await releases.ensure();
  const previous: ReleaseManifest = {
    version: "3.8.0",
    releaseDir: join(layout.releasesDir, "release-a"),
    releaseId: "release-a",
  };
  const target: ReleaseManifest = {
    version: "3.9.0",
    releaseDir: join(layout.releasesDir, "release-b"),
    releaseId: "release-b",
  };
  await Promise.all([
    mkdir(previous.releaseDir, { recursive: true }),
    mkdir(target.releaseDir, { recursive: true }),
  ]);
  await releases.writePending(previous);
  await releases.applyPending();
  await releases.writePending(target);
  await releases.applyPending();
  return { layout, previous, target };
}

describe("update daemon handoff", () => {
  it("returns only after the target Supervisor and Core identities converge", async () => {
    const { layout, previous, target } = await createReleasePair();
    const boundary: UpdateHandoffProcessBoundary = {
      stopDaemon: vi.fn(async () => undefined),
      startDaemon: vi.fn(async () => undefined),
      readRuntimeIdentity: vi.fn(async () => ({
        supervisorVersion: "3.9.0",
        supervisorReleaseId: "release-b",
        activeReleaseVersion: "3.9.0",
        activeReleaseId: "release-b",
        coreVersion: "3.9.0",
        coreReleaseId: "release-b",
      })),
    };

    await expect(
      createUpdateDaemonHandoff(boundary).converge({ layout, previous, target }),
    ).resolves.toBeUndefined();

    expect(boundary.startDaemon).toHaveBeenCalledOnce();
    expect(boundary.startDaemon).toHaveBeenCalledWith(layout, target);
  });

  it("restores and restarts the previous release when identity convergence fails", async () => {
    const { layout, previous, target } = await createReleasePair();
    const started: string[] = [];
    const boundary: UpdateHandoffProcessBoundary = {
      stopDaemon: vi.fn(async () => undefined),
      startDaemon: vi.fn(async (_layout, release) => {
        started.push(release.releaseId ?? release.version);
      }),
      readRuntimeIdentity: vi.fn(async () => ({
        supervisorVersion: "3.8.0",
        supervisorReleaseId: "release-a",
        activeReleaseVersion: "3.9.0",
        activeReleaseId: "release-b",
        coreVersion: "3.9.0",
        coreReleaseId: "release-b",
      })),
    };

    await expect(
      createUpdateDaemonHandoff(boundary).converge({ layout, previous, target }),
    ).rejects.toThrow("previous release was restored");

    expect(started).toEqual(["release-b", "release-a"]);
    expect(await new ReleaseManager(layout).readCurrent()).toEqual(previous);
  });
});
