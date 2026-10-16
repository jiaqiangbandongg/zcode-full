import { describe, expect, it, vi } from "vitest";

import { runE2EBeforeSessionSetup } from "./e2e/helpers/e2e-before-session.js";

describe("desktop e2e beforeSession setup", () => {
  it("waits for async HOME reset before resolving the hook setup", async () => {
    const events: string[] = [];
    let finishReset: (() => void) | null = null;
    const resetHome = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          events.push("reset-started");
          finishReset = () => {
            events.push("reset-finished");
            resolve();
          };
        }),
    );
    const configureCodingPlanTeamMockForSpecs = vi.fn(async () => {
      events.push("coding-plan-case-mode");
    });

    const setupPromise = runE2EBeforeSessionSetup({
      cid: "0-0",
      specs: ["./test/e2e/example.test.ts"],
      configureAgentServerEnv: () => events.push("configure-env"),
      recordBeforeSession: () => events.push("record-before-session"),
      resetHome,
      startCodingPlanTeamMockIfNeeded: async () => {
        events.push("coding-plan-team");
      },
      configureCodingPlanTeamMockForSpecs,
      startCodingPlanUpgradeMockIfNeeded: async () => {
        events.push("coding-plan-upgrade");
      },
      startUpstreamHttpIfNeeded: async () => {
        events.push("upstream-http");
      },
      startPluginCdnZipFixtureIfNeeded: async () => {
        events.push("plugin-cdn");
      },
      startOffPeakMockIfNeeded: async () => {
        events.push("off-peak-mock");
      },
    }).then(() => {
      events.push("setup-resolved");
    });

    await waitForResetStarted(resetHome);

    expect(events).toEqual([
      "record-before-session",
      "configure-env",
      "coding-plan-team",
      "coding-plan-case-mode",
      "upstream-http",
      "coding-plan-upgrade",
      "plugin-cdn",
      "off-peak-mock",
      "reset-started",
    ]);
    expect(configureCodingPlanTeamMockForSpecs).toHaveBeenCalledWith([
      "./test/e2e/example.test.ts",
    ]);
    expect(resetHome).toHaveBeenCalledWith(["./test/e2e/example.test.ts"]);

    finishReset?.();
    await setupPromise;

    expect(events.at(-2)).toBe("reset-finished");
    expect(events.at(-1)).toBe("setup-resolved");
  });
});

async function waitForResetStarted(resetHome: ReturnType<typeof vi.fn>) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (resetHome.mock.calls.length > 0) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("resetHome was not called");
}
