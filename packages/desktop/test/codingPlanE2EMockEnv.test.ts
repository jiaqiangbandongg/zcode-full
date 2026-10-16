import { describe, expect, it } from "vitest";

import {
  CODING_PLAN_TEAM_MOCK_BASE_URL_ENV,
  CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV,
  applyCodingPlanTeamMockEnv,
  applyCodingPlanUpgradeMockEnv,
  clearCodingPlanTeamMockEnv,
  clearCodingPlanUpgradeMockEnv,
  shouldPrepareCodingPlanTeamMock,
} from "./e2e/helpers/coding-plan-mock-env.js";

describe("Coding Plan E2E mock env", () => {
  it("定时任务创建遥测回归隔离账号控制面", () => {
    expect(shouldPrepareCodingPlanTeamMock([
      "./test/e2e/conversation-session/conversation-session-automation-run-title-stable.test.ts",
    ])).toBe(true);
  });
  it.each([
    "conversation-session-create-telemetry.test.ts",
    "conversation-session-offpeak-create.test.ts",
    "conversation-session-offpeak-create-existing-session.test.ts",
    "conversation-session-offpeak-subagent-model-inheritance.test.ts",
    "conversation-session-off-peak-invalid-ticket.test.ts",
  ])("prepares account facts as well as the off-peak gateway for %s", (spec) => {
    expect(shouldPrepareCodingPlanTeamMock([
      `./test/e2e/conversation-session/manual-review/pending/${spec}`,
    ])).toBe(true);
  });
  it("prepares account APIs for the formal real-app provider responsive case", () => {
    expect(
      shouldPrepareCodingPlanTeamMock([
        "./test/e2e/provider-family-responsive.test.ts",
      ]),
    ).toBe(true);
  });
  it.each([
    "conversation-session-highspeed-card.test.ts",
    "conversation-session-highspeed-card-draw-timeout.test.ts",
    "conversation-session-highspeed-card-draw-miss.test.ts",
  ])("prepares Coding Plan entitlement for highspeed draw case %s", (spec) => {
    expect(shouldPrepareCodingPlanTeamMock([`./test/e2e/conversation-session/${spec}`])).toBe(true);
  });
  it("keeps both prepared mock addresses while a team worker activates only the team mock", () => {
    const environment: Record<string, string | undefined> = {};
    const teamBaseUrl = "http://127.0.0.1:41001";
    const upgradeBaseUrl = "http://127.0.0.1:41002";

    applyCodingPlanTeamMockEnv(environment, teamBaseUrl);
    applyCodingPlanUpgradeMockEnv(environment, upgradeBaseUrl);

    expect(environment[CODING_PLAN_TEAM_MOCK_BASE_URL_ENV]).toBe(teamBaseUrl);
    expect(environment[CODING_PLAN_UPGRADE_MOCK_BASE_URL_ENV]).toBe(upgradeBaseUrl);

    applyCodingPlanTeamMockEnv(environment, teamBaseUrl);
    clearCodingPlanUpgradeMockEnv(environment, upgradeBaseUrl);

    expect(environment.ZCODE_BASE_URL).toBe(teamBaseUrl);
    expect(environment.ZCODE_ENDPOINT_ORIGIN).toBe(teamBaseUrl);
    expect(environment.ZCODE_E2E_CODING_PLAN_MOCK_URL).toBe(teamBaseUrl);
  });

  it("does not clear an active upgrade mock when a non-team worker drops the prepared team mock", () => {
    const environment: Record<string, string | undefined> = {};
    const teamBaseUrl = "http://127.0.0.1:42001";
    const upgradeBaseUrl = "http://127.0.0.1:42002";

    applyCodingPlanTeamMockEnv(environment, teamBaseUrl);
    applyCodingPlanUpgradeMockEnv(environment, upgradeBaseUrl);
    clearCodingPlanTeamMockEnv(environment, teamBaseUrl);

    expect(environment.ZCODE_BASE_URL).toBe(upgradeBaseUrl);
    expect(environment.ZCODE_ENDPOINT_ORIGIN).toBe(upgradeBaseUrl);
    expect(environment.ZCODE_E2E_CODING_PLAN_MOCK_URL).toBe(upgradeBaseUrl);
  });

  it("prepares the team mock when the default full-suite glob can select team specs", () => {
    expect(shouldPrepareCodingPlanTeamMock(["./test/e2e/**/*.test.ts"])).toBe(true);
    expect(
      shouldPrepareCodingPlanTeamMock([
        "./test/e2e/subagents/subagent-coding-plan-login-catalog-stale.test.ts",
      ]),
    ).toBe(true);
    expect(
      shouldPrepareCodingPlanTeamMock([
        "./test/e2e/conversation-session/conversation-session-model-provider-settings-transition.test.ts",
      ]),
    ).toBe(true);
    expect(
      shouldPrepareCodingPlanTeamMock([
        "./test/e2e/conversation-session/manual-review/pending/conversation-session-off-peak-team-plan.test.ts",
      ]),
    ).toBe(true);
    expect(
      shouldPrepareCodingPlanTeamMock([
        "./test/e2e/conversation-session/conversation-session-background.test.ts",
      ]),
    ).toBe(false);
  });
});
