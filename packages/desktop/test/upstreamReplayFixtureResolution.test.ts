import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  hasUpstreamCaseLocalReplayFixtureForWorker,
  resolveUpstreamE2EHttpMode,
  resolveUpstreamE2EHttpModeForWorker,
  resolveUpstreamReplayFixturePaths,
} from "./e2e/helpers/upstream-replay-fixture-resolution.js";

const root = join("repo", "packages", "desktop", "test", "e2e", "fixtures");
const commonFixturePath = join(root, "upstream", "common.json");
const caseFixtureDir = join(root, "upstream", "conversation-session");
const caseManifestDir = join(root, "cases", "conversation-session");
const legacyFixturePaths = [
  join(root, "upstream", "provider-conversation-tool-cross-product.json"),
  join(root, "upstream", "provider-basic.json"),
];
const formalSpec = join(
  "repo",
  "packages",
  "desktop",
  "test",
  "e2e",
  "conversation-session",
  "conversation-session-v4-edit.test.ts",
);
const manualSpec = join(
  "repo",
  "packages",
  "desktop",
  "test",
  "e2e",
  "conversation-session",
  "manual-review",
  "pending",
  "conversation-session-agent-step-message-scope.test.ts",
);

function createOptions(existingPaths: string[]) {
  return {
    caseFixtureDir,
    caseManifestDir,
    commonFixturePath,
    configuredFixturePaths: null,
    legacyFixturePaths,
    pathExists: (path: string) => existingPaths.includes(path),
    pluginFixturePaths: [],
    specs: [formalSpec],
  };
}

describe("Upstream replay fixture resolution", () => {
  it("keeps manual-review on capture without an explicit replay fixture", () => {
    expect(
      resolveUpstreamE2EHttpMode({
        explicitReplayFixture: false,
        manualReview: true,
      }),
    ).toBe("capture");
  });

  it("keeps formal replay and manual-review capture isolated inside one combined run", () => {
    expect(
      resolveUpstreamE2EHttpModeForWorker({
        explicitReplayFixture: false,
        specs: ["./test/e2e/conversation-session/conversation-session-v4-edit.test.ts"],
      }),
    ).toBe("replay");
    expect(
      resolveUpstreamE2EHttpModeForWorker({
        explicitReplayFixture: false,
        specs: [
          "./test/e2e/conversation-session/manual-review/pending/conversation-session-edit.test.ts",
        ],
      }),
    ).toBe("capture");
  });

  it("keeps the real Upstream provider smoke in capture mode inside a combined run", () => {
    expect(
      resolveUpstreamE2EHttpModeForWorker({
        explicitReplayFixture: false,
        specs: ["./test/e2e/upstream-provider.test.ts"],
      }),
    ).toBe("capture");
  });

  it("replays a manual-review worker when its deterministic case-local fixture exists", () => {
    const caseFixture = join(
      caseFixtureDir,
      "conversation-session-agent-step-message-scope.json",
    );
    expect(
      hasUpstreamCaseLocalReplayFixtureForWorker({
        caseFixtureDir,
        pathExists: (path) => path === caseFixture,
        specs: [manualSpec],
      }),
    ).toBe(true);
    expect(
      resolveUpstreamE2EHttpModeForWorker({
        caseLocalReplayFixtureAvailable: true,
        explicitReplayFixture: false,
        specs: [manualSpec],
      }),
    ).toBe("replay");
  });

  it("rejects a worker that mixes formal and manual-review specs", () => {
    expect(() =>
      resolveUpstreamE2EHttpModeForWorker({
        explicitReplayFixture: false,
        specs: [
          "./test/e2e/conversation-session/conversation-session-v4-edit.test.ts",
          "./test/e2e/conversation-session/manual-review/pending/conversation-session-edit.test.ts",
        ],
      }),
    ).toThrow(/cannot mix replay and capture/i);
  });

  it("allows pending manual-review to replay an explicit fixture", () => {
    expect(
      resolveUpstreamE2EHttpMode({
        explicitReplayFixture: true,
        manualReview: true,
      }),
    ).toBe("replay");
  });

  it("rejects conflicting capture mode and explicit replay fixture", () => {
    expect(() =>
      resolveUpstreamE2EHttpMode({
        explicitReplayFixture: true,
        manualReview: true,
        requestedMode: "capture",
      }),
    ).toThrow(/cannot be combined/);
  });

  it("keeps legacy fallback in compatible mode", () => {
    const caseFixture = join(caseFixtureDir, "conversation-session-v4-edit.json");
    const paths = resolveUpstreamReplayFixturePaths({
      ...createOptions([commonFixturePath, caseFixture]),
      mode: "compatible",
    });

    expect(paths).toEqual([commonFixturePath, caseFixture, ...legacyFixturePaths]);
  });

  it("includes an existing manual-review case-local fixture in replay paths", () => {
    const caseFixture = join(
      caseFixtureDir,
      "conversation-session-agent-step-message-scope.json",
    );
    const paths = resolveUpstreamReplayFixturePaths({
      ...createOptions([commonFixturePath, caseFixture]),
      mode: "compatible",
      specs: [manualSpec],
    });

    expect(paths).toEqual([commonFixturePath, caseFixture, ...legacyFixturePaths]);
  });

  it("uses only common and case-local fixtures in strict case-local mode", () => {
    const caseFixture = join(caseFixtureDir, "conversation-session-v4-edit.json");
    const caseManifest = join(caseManifestDir, "conversation-session-v4-edit.json");
    const paths = resolveUpstreamReplayFixturePaths({
      ...createOptions([commonFixturePath, caseFixture, caseManifest]),
      mode: "strict-case-local",
    });

    expect(paths).toEqual([commonFixturePath, caseFixture]);
  });

  it("ignores plugin fixture paths in strict case-local mode", () => {
    const caseFixture = join(caseFixtureDir, "conversation-session-v4-edit.json");
    const caseManifest = join(caseManifestDir, "conversation-session-v4-edit.json");
    const pluginFixture = join(root, "upstream", "plugin-mcp-skill");
    const paths = resolveUpstreamReplayFixturePaths({
      ...createOptions([commonFixturePath, caseFixture, caseManifest, pluginFixture]),
      mode: "strict-case-local",
      pluginFixturePaths: [pluginFixture],
    });

    expect(paths).toEqual([commonFixturePath, caseFixture]);
  });

  it.each([
    ["manifest", join(caseFixtureDir, "conversation-session-v4-edit.json")],
    ["fixture", join(caseManifestDir, "conversation-session-v4-edit.json")],
  ])("fails strict mode when the case-local %s is missing", (_label, existingCasePath) => {
    expect(() =>
      resolveUpstreamReplayFixturePaths({
        ...createOptions([commonFixturePath, existingCasePath]),
        mode: "strict-case-local",
      }),
    ).toThrow(/conversation-session-v4-edit/);
  });

  it("rejects explicit fixture overrides in strict case-local mode", () => {
    expect(() =>
      resolveUpstreamReplayFixturePaths({
        ...createOptions([commonFixturePath]),
        configuredFixturePaths: [legacyFixturePaths[1]!],
        mode: "strict-case-local",
      }),
    ).toThrow(/E2E_PROVIDER_REPLAY_FIXTURE_PATH/);
  });

  it("fails strict mode when the common fixture is missing", () => {
    const caseFixture = join(caseFixtureDir, "conversation-session-v4-edit.json");
    const caseManifest = join(caseManifestDir, "conversation-session-v4-edit.json");

    expect(() =>
      resolveUpstreamReplayFixturePaths({
        ...createOptions([caseFixture, caseManifest]),
        mode: "strict-case-local",
      }),
    ).toThrow(/common fixture/);
  });

  it("resolves multiple Windows-style formal spec paths in strict mode", () => {
    const secondCaseName = "conversation-session-v4-goal";
    const secondSpec = formalSpec
      .replace("conversation-session-v4-edit", secondCaseName)
      .replaceAll("/", "\\");
    const caseFixture = join(caseFixtureDir, "conversation-session-v4-edit.json");
    const caseManifest = join(caseManifestDir, "conversation-session-v4-edit.json");
    const secondFixture = join(caseFixtureDir, `${secondCaseName}.json`);
    const secondManifest = join(caseManifestDir, `${secondCaseName}.json`);

    expect(
      resolveUpstreamReplayFixturePaths({
        ...createOptions([
          commonFixturePath,
          caseFixture,
          caseManifest,
          secondFixture,
          secondManifest,
        ]),
        mode: "strict-case-local",
        specs: [formalSpec.replaceAll("/", "\\"), secondSpec],
      }),
    ).toEqual([commonFixturePath, caseFixture, secondFixture]);
  });
});
