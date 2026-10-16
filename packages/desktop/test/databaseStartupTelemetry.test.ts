import { expect, it, vi } from "vitest";
import type { DatabaseStartupState } from "@zcode/shared";
const sdk = vi.hoisted(() => ({ sendCustom: vi.fn(), getConfig: () => ({ env: "prod" }) }));
vi.mock("@arms/rum-electron", () => ({ default: sdk }));
vi.mock("../src/main/desktopDeviceMid.js", () => ({
  ensureDesktopDeviceMidSync: () => "test-device",
}));
vi.mock("../src/main/logger.js", () => ({ logger: { info: vi.fn() } }));
import { reportDatabaseStartupState } from "../src/main/databaseStartupTelemetry.js";

it("reports bounded terminal summaries, deduplicates terminal events, and keeps unknown out of the peak distribution", () => {
  const state: DatabaseStartupState = {
    schemaVersion: 1,
    startupId: "telemetry-startup",
    attemptId: "telemetry-attempt",
    sequence: 1,
    phase: "preparing_host_storage",
    startedAt: 100,
    updatedAt: 200,
    disk: [],
  };
  reportDatabaseStartupState(state);
  const count = sdk.sendCustom.mock.calls.length;
  reportDatabaseStartupState({ ...state, sequence: 2, updatedAt: 2200 });
  expect(sdk.sendCustom).toHaveBeenCalledTimes(count);
  const failed: DatabaseStartupState = {
    ...state,
    sequence: 3,
    phase: "failed",
    failedPhase: "preparing_host_storage",
    errorCode: "storage_full",
    sqliteCode: 13,
    updatedAt: 3000,
    disk: [
      {
        scopeId: "known",
        observedAvailableDropPeakBytes: 800,
        minAvailableBytes: 200,
        quality: "complete",
        sampledAt: 2000,
      },
      {
        scopeId: "unknown",
        observedAvailableDropPeakBytes: null,
        minAvailableBytes: null,
        quality: "unknown",
        sampledAt: null,
      },
    ],
  };
  reportDatabaseStartupState(failed);
  reportDatabaseStartupState(failed);
  const events = sdk.sendCustom.mock.calls.map(([event]) => event);
  expect(events.filter((event) => event.name === "database_startup_result")).toHaveLength(1);
  expect(
    events.filter((event) => event.name === "database_startup_disk").map((event) => event.value),
  ).toEqual([800]);
  expect(events.filter((event) => event.name === "database_startup_disk_unavailable")).toHaveLength(
    1,
  );
  expect(
    events.find((event) => event.name === "database_startup_result").properties.sqlite_code,
  ).toBe("13");
  for (const event of events) expect(Object.keys(event.properties).length).toBeLessThanOrEqual(20);
});

it("SILENTDB-07: includes observed migration kind and execution/commit facts in the database result", () => {
  for (const kind of ["none", "upgrade"] as const) {
    reportDatabaseStartupState({
      schemaVersion: 1,
      startupId: kind,
      attemptId: "silent-telemetry-" + kind,
      sequence: 1,
      startedAt: 1,
      updatedAt: 2,
      phase: "ready",
      disk: [],
      migration: {
        kind,
        executedCount: kind === "none" ? 0 : 2,
        committedCount: kind === "none" ? 0 : 2,
      },
    });
    const event = sdk.sendCustom.mock.calls
      .map(([event]) => event)
      .find(
        (e) =>
          e.name === "database_startup_result" &&
          e.properties.attempt_id === "silent-telemetry-" + kind,
      );
    expect(event.properties).toMatchObject({
      migration_kind: kind,
      migration_executed_count: kind === "none" ? "0" : "2",
      migration_committed_count: kind === "none" ? "0" : "2",
    });
  }
});

it.each(["failed", "starting_services"] as const)(
  "reports baseline events once at %s, including none and unknown",
  (resultPhase) => {
    const state: DatabaseStartupState = {
      schemaVersion: 1,
      startupId: "baseline",
      attemptId: "baseline-attempt-" + resultPhase,
      sequence: 1,
      phase: "preparing_host_storage",
      startedAt: 100,
      updatedAt: 200,
      disk: [],
      migrationBaselines: [
        {
          databaseId: "tasks-index",
          databaseKind: "tasks-index",
          lastAppliedMigrationId: "0002_provider_selection",
        },
        { databaseId: "session-a", databaseKind: "session", lastAppliedMigrationId: null },
        { databaseId: "session-b", databaseKind: "session" },
      ],
    };
    const events = () =>
      sdk.sendCustom.mock.calls
        .map(([e]) => e)
        .filter(
          (e) =>
            e.name === "database_startup_baseline" && e.properties.attempt_id === state.attemptId,
        );
    reportDatabaseStartupState(state);
    expect(events()).toHaveLength(0);
    const failed = {
      ...state,
      phase: resultPhase,
      failedPhase: "preparing_session_storage" as const,
      errorCode: "storage_full" as const,
      sequence: 2,
    };
    reportDatabaseStartupState(failed);
    reportDatabaseStartupState(failed);
    reportDatabaseStartupState({ ...failed, phase: "ready", sequence: 3 });
    expect(events().map((e) => e.properties.last_applied_migration_id)).toEqual([
      "0002_provider_selection",
      "none",
      "unknown",
    ]);
    expect(events().map((e) => e.properties.database_kind)).toEqual([
      "tasks-index",
      "session",
      "session",
    ]);
    expect(new Set(events().map((e) => e.properties.startup_event_id)).size).toBe(3);
    for (const event of events())
      expect(Object.keys(event.properties).length).toBeLessThanOrEqual(20);
  },
);
