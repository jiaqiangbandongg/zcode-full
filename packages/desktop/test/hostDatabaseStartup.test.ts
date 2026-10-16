import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({ host: vi.fn(), session: vi.fn(), mark: vi.fn() }));
vi.mock("@zcode/services/storage-startup", () => ({
  getTasksIndexDatabasePath: () => "/isolated/tasks.sqlite",
  resolveZCodeAgentSpawnCwd: async (...args: unknown[]) =>
    (
      await import("../../services/src/zcode-agent/zcodeAgentSpawnCwd.js")
    ).resolveZCodeAgentSpawnCwd(...(args as [never])),
  markTasksStoragePrepared: fixtures.mark,
}));
vi.mock("../src/host/storagePreparationProcesses.js", () => ({
  prepareHostStorage: fixtures.host,
  prepareSessionStorage: fixtures.session,
}));
import { createHostDatabaseStartup } from "../src/host/hostDatabaseStartup.js";

it("prepares actual restored working directories before publishing services, without a fake workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-startup-cwd-"));
  const sequence: string[] = [];
  fixtures.host.mockImplementation(async () => {
    sequence.push("host");
  });
  fixtures.session.mockImplementation(async ({ cwd }) => {
    sequence.push(cwd);
  });
  const startup = createHostDatabaseStartup({
    startupId: "host-startup-test",
    cwd: tmpdir(),
    workingDirectories: [dir, dir],
    initializeServices: async () => {
      sequence.push("services");
    },
    publish: () => {},
    onFailure: () => {},
  });
  try {
    await startup.coordinator.start();
    expect(sequence).toEqual(["host", dir, "services"]);
    expect(startup.coordinator.snapshot.startupId).toBe("host-startup-test");
    expect(startup.coordinator.snapshot.phase).toBe("ready");
  } finally {
    startup.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("uses the normal Agent fallback for ENOTDIR and preserves actual database failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-startup-invalid-cwd-"));
  const parent = join(dir, "former-directory");
  await writeFile(parent, "now a file");
  const cwd = join(parent, "old-project");
  const initialized = vi.fn();
  const primary = Object.assign(new Error("real database full"), { code: "ENOSPC" });
  fixtures.host.mockResolvedValue(undefined);
  fixtures.session.mockRejectedValue(primary);
  const failure = vi.fn();
  const startup = createHostDatabaseStartup({
    cwd: dir,
    workingDirectories: [cwd],
    initializeServices: initialized,
    publish: () => {},
    onFailure: failure,
  });
  try {
    await startup.coordinator.start();
    expect(fixtures.session).toHaveBeenLastCalledWith(expect.objectContaining({ cwd: dir }));
    expect(failure).toHaveBeenCalledWith(primary);
    expect(startup.coordinator.snapshot).toMatchObject({
      phase: "failed",
      errorCode: "storage_full",
    });
    expect(initialized).not.toHaveBeenCalled();
    const oldPaths = fixtures.session.mock.calls.at(-1)?.[0].preparedPaths as Set<string>;
    oldPaths.add("previous-attempt-only");
    fixtures.session.mockResolvedValue(undefined);
    await startup.coordinator.retry(startup.coordinator.snapshot.attemptId);
    expect(initialized).toHaveBeenCalledOnce();
    expect(fixtures.session.mock.calls.at(-1)?.[0].preparedPaths).not.toBe(oldPaths);
    expect(fixtures.session.mock.calls.at(-1)?.[0].preparedPaths.size).toBe(0);
    expect(startup.coordinator.snapshot.phase).toBe("ready");
  } finally {
    startup.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it("only marks the last session database as eligible for global saving/finishing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-startup-final-db-"));
  const states: import("@zcode/shared").DatabaseStartupState[] = [];
  const migration = { kind: "upgrade", executedCount: 1, committedCount: 0 };
  fixtures.host.mockImplementation(async (_path, report) => report("committing", migration));
  fixtures.session.mockImplementation(async ({ cwd, report }) => {
    report("committing", { databaseId: cwd, migration });
    report("ready", { databaseId: cwd, migration: { ...migration, committedCount: 1 } });
  });
  const startup = createHostDatabaseStartup({
    cwd: dir,
    workingDirectories: [dir, tmpdir()],
    initializeServices: async () => {},
    publish: (state) => states.push(state),
    onFailure: () => {},
  });
  try {
    await startup.coordinator.start();
    const commits = states.filter((state) => state.databasePhase === "committing");
    expect(commits.map((state) => state.finalDatabase)).toEqual([undefined, false, true]);
    expect(states.at(-1)?.phase).toBe("ready");
  } finally {
    startup.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
