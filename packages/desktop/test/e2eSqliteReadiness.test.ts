import { describe, expect, it, vi } from "vitest";

import { waitForSqliteTable } from "./e2e/helpers/e2e-sqlite-readiness.js";

describe("desktop e2e SQLite readiness", () => {
  it("waits until the database exists and the requested migration table is visible", async () => {
    let clock = 0;
    let attempt = 0;
    const close = vi.fn();
    const openDatabase = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("unable to open database file");
      }
      return {
        close,
        prepare: vi.fn(() => ({
          get: vi.fn(() => (attempt >= 3 ? { ready: 1 } : undefined)),
        })),
      };
    });

    await waitForSqliteTable("/e2e/cli/db/db.sqlite", "local_setting", {
      delay: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      openDatabase,
      pollIntervalMs: 10,
      timeoutMs: 100,
    });

    expect(openDatabase).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("reports the database path, table, and last readiness error on timeout", async () => {
    let clock = 0;
    const openDatabase = vi.fn(() => {
      throw new Error("database is locked");
    });

    await expect(
      waitForSqliteTable("/e2e/cli/db/db.sqlite", "local_setting", {
        delay: async (ms) => {
          clock += ms;
        },
        now: () => clock,
        openDatabase,
        pollIntervalMs: 10,
        timeoutMs: 20,
      }),
    ).rejects.toThrow(
      "SQLite fixture 等待超时: path=/e2e/cli/db/db.sqlite, table=local_setting, lastError=database is locked",
    );
  });
});
