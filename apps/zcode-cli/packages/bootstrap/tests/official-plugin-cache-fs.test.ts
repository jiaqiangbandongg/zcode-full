import { describe, expect, it, vi } from "vitest";
import {
  createOfficialPluginCacheRetryBudget,
  getOfficialPluginCacheRetryAttempts,
  isTransientOfficialPluginCacheFsError,
  retryOfficialPluginCacheFs,
} from "../src/app/official-plugin-cache-fs.js";

describe("official plugin cache fs helpers", () => {
  it("recognizes only transient cache contention errors", () => {
    for (const code of ["EACCES", "EBUSY", "EEXIST", "ENOTEMPTY", "EPERM"]) {
      expect(isTransientOfficialPluginCacheFsError(errno(code))).toBe(true);
    }

    expect(isTransientOfficialPluginCacheFsError(errno("ENOENT"))).toBe(false);
    expect(isTransientOfficialPluginCacheFsError(new Error("invalid manifest"))).toBe(false);
  });

  it("retries transient failures within the shared deadline", () => {
    let nowMs = 0;
    const sleep = vi.fn((delayMs: number) => {
      nowMs += delayMs;
    });
    const budget = createOfficialPluginCacheRetryBudget({
      durationMs: 1_500,
      now: () => nowMs,
      sleep,
    });
    let attempts = 0;

    const result = retryOfficialPluginCacheFs(
      () => {
        attempts += 1;
        if (attempts < 3) throw errno("EPERM");
        return "ok";
      },
      { budget },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(sleep.mock.calls).toEqual([[25], [50]]);
  });

  it("stops retrying when the shared deadline cannot fit the next delay", () => {
    let nowMs = 0;
    const budget = createOfficialPluginCacheRetryBudget({
      durationMs: 60,
      now: () => nowMs,
      sleep: (delayMs) => {
        nowMs += delayMs;
      },
    });
    const error = errno("EPERM");
    let attempts = 0;

    expect(() =>
      retryOfficialPluginCacheFs(
        () => {
          attempts += 1;
          throw error;
        },
        { budget },
      ),
    ).toThrow(error);

    expect(attempts).toBe(2);
    expect(getOfficialPluginCacheRetryAttempts(error)).toBe(2);
  });

  it("does not retry non-transient failures", () => {
    const operation = vi.fn(() => {
      throw new Error("invalid manifest");
    });

    expect(() => retryOfficialPluginCacheFs(operation)).toThrow("invalid manifest");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}
