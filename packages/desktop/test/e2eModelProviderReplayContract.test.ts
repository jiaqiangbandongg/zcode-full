import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shouldPrepareCodingPlanTeamMock } from "./e2e/helpers/coding-plan-mock-env.js";

it("连续切模回放隔离启动账号控制面，避免假 JWT 请求线上后遮挡模型菜单", () => {
  expect(
    shouldPrepareCodingPlanTeamMock([
      "./test/e2e/conversation-session/manual-review/pending/conversation-session-active-model-context.test.ts",
    ]),
  ).toBe(true);
});

interface ReplayFixtureFile {
  fixtures: Array<{
    id: string;
    match: { pathIncludes?: string };
    response: { body?: string; text?: unknown };
  }>;
}

function readReplayFixture(relativePath: string): ReplayFixtureFile {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  ) as ReplayFixtureFile;
}

describe("model provider E2E replay contract", () => {
  it.each([
    "conversation-session-model-provider-effective-selection.test.ts",
    "off-peak-create-manage.test.ts",
  ])("isolates account control-plane for %s", (spec) => {
    expect(shouldPrepareCodingPlanTeamMock([`./test/e2e/${spec}`])).toBe(true);
  });
  it("starts the Coding Plan mock for both split Turbo specs", () => {
    // Bug 根因：Coding Plan spec 判定已从 wdio.conf.ts 抽到独立 helper，继续扫描入口
    // 源码会在行为仍正确时误报。直接验证 matcher 才能约束实际的 mock 启动契约。
    expect(
      shouldPrepareCodingPlanTeamMock([
        "./test/e2e/conversation-session/conversation-session-model-provider-turbo-recovery.test.ts",
      ]),
    ).toBe(true);
    expect(
      shouldPrepareCodingPlanTeamMock([
        "./test/e2e/conversation-session/conversation-session-model-provider-turbo-switch.test.ts",
      ]),
    ).toBe(true);
  });

  it("covers both seeded OpenAI and startup Anthropic transports for restart cases", () => {
    const restart = readReplayFixture(
      "./e2e/fixtures/upstream/conversation-session/conversation-session-model-provider-restart-recovery.json",
    );
    const baseFixtureIds = ["model-provider-restart-title", "model-provider-restart-r01"];

    for (const id of baseFixtureIds) {
      const openai = restart.fixtures.find((fixture) => fixture.id === id);
      const anthropic = restart.fixtures.find((fixture) => fixture.id === `${id}-anthropic`);
      expect(openai?.match.pathIncludes).toBe("/chat/completions");
      expect(openai?.response.body).toBeDefined();
      expect(anthropic?.match.pathIncludes).toBe("/messages");
      expect(anthropic?.response.text).toBeDefined();
    }
  });
});
