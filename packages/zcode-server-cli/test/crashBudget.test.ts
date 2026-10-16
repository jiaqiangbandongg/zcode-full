import { describe, expect, it } from "vitest";
import { CrashBudget } from "../src/supervisor/crashBudget.js";

describe("CrashBudget", () => {
  it("uses 1/2/4/8/16 second backoff and stops after the fifth retry", () => {
    const budget = new CrashBudget({ now: () => 10_000 });
    expect(budget.recordCrash()).toMatchObject({ shouldRestart: true, delayMs: 1_000 });
    expect(budget.recordCrash()).toMatchObject({ shouldRestart: true, delayMs: 2_000 });
    expect(budget.recordCrash()).toMatchObject({ shouldRestart: true, delayMs: 4_000 });
    expect(budget.recordCrash()).toMatchObject({ shouldRestart: true, delayMs: 8_000 });
    expect(budget.recordCrash()).toMatchObject({ shouldRestart: true, delayMs: 16_000 });
    expect(budget.recordCrash()).toMatchObject({ shouldRestart: false, exhausted: true });
  });

  it("forgets crashes outside the five minute window", () => {
    let now = 0;
    const budget = new CrashBudget({ now: () => now });
    budget.recordCrash();
    now = 5 * 60_000 + 1;
    expect(budget.recordCrash()).toMatchObject({ shouldRestart: true, delayMs: 1_000 });
  });
});
