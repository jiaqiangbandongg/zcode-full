import { describe, expect, it } from "vitest";
import { classifyDatabaseStartupError } from "@zcode/shared";
import { DatabaseStartupCoordinator } from "../src/host/databaseStartupCoordinator.js";

describe("global database startup", () => {
  it.each([
    [{ code: "ENOSPC" }, "storage_full"],
    [{ code: "EDQUOT" }, "storage_full"],
    [{ code: "ERR_SQLITE_ERROR", errcode: 13 + 256 }, "storage_full"],
    [{ cause: { errcode: 10 + 256 } }, "io_error"],
    [{ errcode: 14 }, "open_failed"],
    [{ errcode: 7 }, "out_of_memory"],
    [{ code: "EACCES" }, "permission_denied"],
    [{ errcode: 11 }, "corrupt"],
    [new Error("disk full out of memory"), "sql_failed"],
  ])("classifies structured causes without guessing from text", (error, expected) => {
    expect(classifyDatabaseStartupError(error)).toBe(expected);
  });

  it("retains failure until manual retry; ignores stale and concurrent retries", async () => {
    let runs = 0;
    let release!: () => void;
    const states: string[] = [];
    const coordinator = new DatabaseStartupCoordinator({
      prepare: async (report) => {
        runs++;
        report("preparing_host_storage");
        if (runs === 1) throw Object.assign(new Error("full"), { errcode: 13 });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        report("starting_services");
      },
      publish: (state) => states.push(state.phase),
    });
    await coordinator.start();
    const failed = coordinator.snapshot;
    expect(failed.phase).toBe("failed");
    expect(failed.errorCode).toBe("storage_full");
    await coordinator.retry("stale");
    expect(runs).toBe(1);
    const retry = coordinator.retry(failed.attemptId);
    await coordinator.retry(failed.attemptId);
    expect(runs).toBe(2);
    expect(coordinator.snapshot.phase).toBe("preparing_host_storage");
    release();
    await retry;
    expect(coordinator.snapshot.phase).toBe("ready");
    expect(states.filter((phase) => phase === "ready")).toHaveLength(1);
  });

  it("does not publish ready before service assembly and survives telemetry failure", async () => {
    const coordinator = new DatabaseStartupCoordinator({
      prepare: async (report) => {
        report("starting_services");
        throw new Error("service assembly failed");
      },
      publish: () => {
        throw new Error("telemetry unavailable");
      },
    });
    await coordinator.start();
    expect(coordinator.snapshot.phase).toBe("failed");
    expect(coordinator.snapshot.failedPhase).toBe("starting_services");
  });
});

it("preserves structured failure details through the startup snapshot", async () => {
  const coordinator = new DatabaseStartupCoordinator({
    prepare: async () => {
      throw Object.assign(
        new Error("wrapper", { cause: { errcode: 778, code: "ERR_SQLITE_ERROR" } }),
        { migrationId: "0003_official_glm_selection" },
      );
    },
    publish: () => {},
  });
  await coordinator.start();
  expect(coordinator.snapshot).toMatchObject({
    errorCode: "io_error",
    sqliteCode: 778,
    migrationId: "0003_official_glm_selection",
  });
});

it("requires reopening the app after partial service assembly instead of creating duplicate services", async () => {
  let runs = 0;
  const coordinator = new DatabaseStartupCoordinator({
    prepare: async (report) => {
      runs++;
      report("starting_services");
      throw new Error("assembly failed");
    },
    publish: () => {},
  });
  await coordinator.start();
  await coordinator.retry(coordinator.snapshot.attemptId);
  expect(runs).toBe(1);
});

it("SILENTDB-05: Host keeps migration facts across databases, failure and retries without double counting", async () => {
  let run = 0;
  const coordinator = new DatabaseStartupCoordinator({
    prepare: async (report) => {
      run++;
      if (run === 2) {
        report("starting_services");
        return;
      }
      const facts = { kind: "upgrade" as const, executedCount: 2, committedCount: 2 };
      report("preparing_host_storage", "maintaining", { databaseId: "tasks", migration: facts });
      report("preparing_host_storage", "maintaining", { databaseId: "tasks", migration: facts });
      report("preparing_session_storage", "checking", {
        databaseId: "session",
        migration: { kind: "none", executedCount: 0, committedCount: 0 },
      });
      throw Object.assign(new Error("full"), { code: "ENOSPC" });
    },
    publish() {},
  });
  await coordinator.start();
  expect(coordinator.snapshot.migration).toEqual({
    kind: "upgrade",
    executedCount: 2,
    committedCount: 2,
  });
  await coordinator.retry(coordinator.snapshot.attemptId);
  expect(coordinator.snapshot.migration).toBeUndefined();
  expect(coordinator.snapshot.phase).toBe("ready");
});

it("SILENTDB-04: consumes terminal failure migration facts without pretending the transaction committed", async () => {
  const coordinator = new DatabaseStartupCoordinator({
    prepare: async (report) => {
      report("preparing_session_storage", "migrating", {
        databaseId: "session",
        migration: { kind: "upgrade", executedCount: 1, committedCount: 0 },
      });
      throw Object.assign(new Error("full"), {
        code: "ENOSPC",
        migrationUpdate: {
          databaseId: "session",
          migration: { kind: "upgrade", executedCount: 2, committedCount: 0 },
        },
      });
    },
    publish() {},
  });
  await coordinator.start();
  expect(coordinator.snapshot).toMatchObject({
    phase: "failed",
    errorCode: "storage_full",
    migration: { kind: "upgrade", executedCount: 2, committedCount: 0 },
  });
});

it("preserves per-database locked baselines through failure and clears them for retry", async () => {
  let run = 0;
  const coordinator = new DatabaseStartupCoordinator({
    publish: () => {},
    prepare: async (report) => {
      run++;
      report("preparing_host_storage", "checking", { databaseId: "tasks-index" });
      expect(coordinator.snapshot.migrationBaselines).toEqual([
        {
          databaseId: "tasks-index",
          databaseKind: "tasks-index",
          lastAppliedMigrationId: undefined,
        },
      ]);
      if (run > 1) return;
      const migration = {
        kind: "upgrade" as const,
        executedCount: 0,
        committedCount: 0,
        lastAppliedMigrationId: "0002_provider_selection",
      };
      report("preparing_host_storage", "migrating", { databaseId: "tasks-index", migration });
      report("preparing_session_storage", "checking", { databaseId: "session-hash" });
      report("preparing_session_storage", "committing", {
        databaseId: "session-hash",
        migration: { ...migration, lastAppliedMigrationId: null },
      });
      throw Object.assign(new Error("full"), { errcode: 13 });
    },
  });
  await coordinator.start();
  expect(coordinator.snapshot.migrationBaselines).toEqual([
    {
      databaseId: "tasks-index",
      databaseKind: "tasks-index",
      lastAppliedMigrationId: "0002_provider_selection",
    },
    { databaseId: "session-hash", databaseKind: "session", lastAppliedMigrationId: null },
  ]);
  await coordinator.retry(coordinator.snapshot.attemptId);
  expect(coordinator.snapshot.migrationBaselines).toHaveLength(1);
});
