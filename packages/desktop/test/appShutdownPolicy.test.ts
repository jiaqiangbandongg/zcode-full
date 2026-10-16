import { describe, expect, it } from "vitest";
import {
  resolveAppShutdownPolicy,
  selectAppShutdownPolicy,
} from "../src/main/appShutdownPolicy.js";

describe("app shutdown policy", () => {
  it("shortens frequent normal Windows shutdowns", () => {
    expect(resolveAppShutdownPolicy("normal", "win32")).toEqual({
      forceKillDelayMs: 4_000,
      waitTimeoutMs: 4_500,
    });
  });

  it("keeps the strict Windows update-install barrier", () => {
    expect(resolveAppShutdownPolicy("update-install", "win32")).toEqual({
      forceKillDelayMs: 7_500,
      waitTimeoutMs: 9_000,
    });
  });

  it("does not change non-Windows shutdown budgets", () => {
    expect(resolveAppShutdownPolicy("normal", "darwin")).toEqual({
      forceKillDelayMs: 7_500,
      waitTimeoutMs: 9_000,
    });
    expect(resolveAppShutdownPolicy("normal", "linux")).toEqual({
      forceKillDelayMs: 7_500,
      waitTimeoutMs: 9_000,
    });
  });

  it("upgrades a running normal shutdown when update install arrives", () => {
    expect(selectAppShutdownPolicy("normal", "update-install", "win32")).toEqual({
      kind: "update-install",
      policy: { forceKillDelayMs: 7_500, waitTimeoutMs: 9_000 },
      upgraded: true,
    });
  });

  it("does not let a later before-quit downgrade update install", () => {
    expect(selectAppShutdownPolicy("update-install", "normal", "win32")).toEqual({
      kind: "update-install",
      policy: { forceKillDelayMs: 7_500, waitTimeoutMs: 9_000 },
      upgraded: false,
    });
  });
});
