import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoArchiveInput } from "../src/project-storage/contract.js";
import type { ProjectTaskRef } from "../src/project/contract.js";
import {
  createTaskAutoArchiveScheduler,
  shouldRescanTaskAutoArchive,
} from "../src/project/autoArchiveScheduler.js";

const policy: AutoArchiveInput = { cutoff: 100, activeTasks: [] };
const stale: ProjectTaskRef = { workspacePath: "/cwd", taskId: "stale" };

function harness(overrides?: { readPolicy?: () => Promise<AutoArchiveInput | null> }) {
  const archiveInactive = vi.fn<(input: AutoArchiveInput) => ProjectTaskRef[]>(() => []);
  const afterChange = vi.fn(async () => {});
  const readPolicy = vi.fn(overrides?.readPolicy ?? (async () => policy));
  const scheduler = createTaskAutoArchiveScheduler({
    readPolicy,
    repository: async () => ({ archiveInactive }),
    afterChange,
    intervalMs: 1_000,
  });
  return { scheduler, archiveInactive, afterChange, readPolicy };
}

describe("task auto archive scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("scans once on start and then on every interval until disposed", async () => {
    const { scheduler, archiveInactive } = harness();
    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(archiveInactive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(archiveInactive).toHaveBeenCalledTimes(3);
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(archiveInactive).toHaveBeenCalledTimes(3);
    await expect(scheduler.scan()).resolves.toEqual([]);
    expect(archiveInactive).toHaveBeenCalledTimes(3);
  });

  it("skips the repository when the policy is disabled and broadcasts only actual changes", async () => {
    let enabled = false;
    const { scheduler, archiveInactive, afterChange } = harness({
      readPolicy: async () => (enabled ? policy : null),
    });
    await expect(scheduler.scan()).resolves.toEqual([]);
    expect(archiveInactive).not.toHaveBeenCalled();
    enabled = true;
    await expect(scheduler.scan()).resolves.toEqual([]);
    expect(archiveInactive).toHaveBeenCalledWith(policy);
    expect(afterChange).not.toHaveBeenCalled();
    archiveInactive.mockReturnValueOnce([stale]);
    await expect(scheduler.scan()).resolves.toEqual([stale]);
    expect(afterChange).toHaveBeenCalledTimes(1);
  });

  it("serializes overlapping scans and coalesces waiters into one follow-up scan", async () => {
    const release: Array<() => void> = [];
    const { scheduler, archiveInactive } = harness({
      readPolicy: () =>
        new Promise<AutoArchiveInput>((resolve) => release.push(() => resolve(policy))),
    });
    const first = scheduler.scan();
    const second = scheduler.scan();
    const third = scheduler.scan();
    expect(third).toBe(second);
    expect(release).toHaveLength(1);
    release[0]!();
    await first;
    expect(archiveInactive).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveLength(2);
    archiveInactive.mockReturnValueOnce([stale]);
    release[1]!();
    await expect(second).resolves.toEqual([stale]);
    expect(archiveInactive).toHaveBeenCalledTimes(2);
  });

  it("keeps the interval alive after a failed scan", async () => {
    const { scheduler, archiveInactive, readPolicy } = harness();
    readPolicy.mockRejectedValueOnce(new Error("settings unavailable"));
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(archiveInactive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(archiveInactive).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it("only rescans for the two auto archive setting keys", () => {
    expect(shouldRescanTaskAutoArchive(["taskAutoArchiveEnabled"])).toBe(true);
    expect(shouldRescanTaskAutoArchive(["theme", "taskAutoArchiveOlderThanDays"])).toBe(true);
    expect(shouldRescanTaskAutoArchive(["theme", "recentProjects"])).toBe(false);
    expect(shouldRescanTaskAutoArchive([])).toBe(false);
  });
});
