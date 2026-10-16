import { existsSync } from "node:fs";
import { join } from "node:path";

export type UpstreamReplayFixtureMode = "compatible" | "strict-case-local";
export type UpstreamE2EHttpMode = "capture" | "replay";

export function resolveUpstreamE2EHttpMode({
  explicitReplayFixture,
  manualReview,
  requestedMode,
}: {
  explicitReplayFixture: boolean;
  manualReview: boolean;
  requestedMode?: string;
}): UpstreamE2EHttpMode {
  if (manualReview && explicitReplayFixture) {
    if (requestedMode === "capture") {
      throw new Error(
        "E2E_PROVIDER_REPLAY_FIXTURE_PATH cannot be combined with E2E_PROVIDER_HTTP_MODE=capture.",
      );
    }
    return "replay";
  }
  if (manualReview) {
    if (requestedMode && requestedMode !== "capture") {
      throw new Error(
        "Manual review defaults to capture; set E2E_PROVIDER_REPLAY_FIXTURE_PATH for pending replay.",
      );
    }
    return "capture";
  }
  return requestedMode === "capture" ? "capture" : "replay";
}

export function resolveUpstreamE2EHttpModeForWorker({
  caseLocalReplayFixtureAvailable = false,
  explicitReplayFixture,
  requestedMode,
  specs,
}: {
  caseLocalReplayFixtureAvailable?: boolean;
  explicitReplayFixture: boolean;
  requestedMode?: string;
  specs: readonly string[];
}): UpstreamE2EHttpMode {
  const captureFlags = new Set(
    specs.map((spec) => {
      const normalized = spec.replaceAll("\\", "/");
      return (
        (normalized.includes("/manual-review/") &&
          !caseLocalReplayFixtureAvailable) ||
        normalized.endsWith("/upstream-provider.test.ts")
      );
    }),
  );
  if (captureFlags.size > 1) {
    throw new Error(
      "A single E2E worker cannot mix replay and capture specs because their provider HTTP modes differ.",
    );
  }
  return resolveUpstreamE2EHttpMode({
    explicitReplayFixture,
    // Upstream provider smoke 与缺 fixture 的 manual-review 验证真实上游；已有确定性
    // case-local fixture 的 pending case 使用 replay，避免真实模型形态破坏精确断言。
    manualReview: captureFlags.has(true),
    requestedMode,
  });
}

export function hasUpstreamCaseLocalReplayFixtureForWorker({
  caseFixtureDir,
  pathExists = existsSync,
  specs,
}: {
  caseFixtureDir: string;
  pathExists?: (path: string) => boolean;
  specs: readonly string[];
}): boolean {
  const caseNames = specs
    .map(resolveConversationSessionCaseName)
    .filter((caseName): caseName is string => Boolean(caseName));
  return (
    caseNames.length > 0 &&
    caseNames.length === specs.length &&
    caseNames.every((caseName) => pathExists(join(caseFixtureDir, `${caseName}.json`)))
  );
}

interface ResolveUpstreamReplayFixturePathsOptions {
  caseFixtureDir: string;
  caseManifestDir: string;
  commonFixturePath: string;
  configuredFixturePaths: string[] | null;
  legacyFixturePaths: string[];
  mode: UpstreamReplayFixtureMode;
  pathExists?: (path: string) => boolean;
  pluginFixturePaths: string[];
  specs: string[];
}

export function resolveUpstreamReplayFixturePaths({
  caseFixtureDir,
  caseManifestDir,
  commonFixturePath,
  configuredFixturePaths,
  legacyFixturePaths,
  mode,
  pathExists = existsSync,
  pluginFixturePaths,
  specs,
}: ResolveUpstreamReplayFixturePathsOptions): string[] {
  if (configuredFixturePaths) {
    if (mode === "strict-case-local") {
      // 修复原因：strict CI 若接受显式 fixture 覆盖，就能再次绕过 case-local 合同并加载 legacy 池。
      throw new Error(
        "E2E_PROVIDER_REPLAY_FIXTURE_PATH cannot be used with strict-case-local replay fixtures.",
      );
    }
    return uniquePaths(configuredFixturePaths);
  }

  const caseNames = uniquePaths(
    specs
      .map(resolveConversationSessionCaseName)
      .filter((caseName): caseName is string => Boolean(caseName)),
  );
  const caseFixturePaths = caseNames.map((caseName) => join(caseFixtureDir, `${caseName}.json`));

  if (mode === "strict-case-local") {
    const missingPaths = [
      ...(pathExists(commonFixturePath) ? [] : [`common fixture: ${commonFixturePath}`]),
      ...caseNames.flatMap((caseName) => {
        const manifestPath = join(caseManifestDir, `${caseName}.json`);
        const fixturePath = join(caseFixtureDir, `${caseName}.json`);
        return [
          ...(pathExists(manifestPath) ? [] : [`case manifest: ${manifestPath}`]),
          ...(pathExists(fixturePath) ? [] : [`case fixture: ${fixturePath}`]),
        ];
      }),
    ];
    if (missingPaths.length > 0) {
      throw new Error(
        `Strict case-local Upstream replay fixtures are incomplete:\n${missingPaths
          .map((path) => `- ${path}`)
          .join("\n")}`,
      );
    }
  }

  return uniquePaths([
    ...(pathExists(commonFixturePath) ? [commonFixturePath] : []),
    ...caseFixturePaths.filter(pathExists),
    ...(mode === "strict-case-local" ? [] : pluginFixturePaths),
    // 修复原因：formal CI 必须让缺失 matcher 直接失败，不能再由历史共享池替代 case-local fixture 假绿。
    ...(mode === "strict-case-local" ? [] : legacyFixturePaths),
  ]);
}

function resolveConversationSessionCaseName(spec: string): string | null {
  const normalized = spec.replaceAll("\\", "/");
  if (!normalized.includes("/test/e2e/conversation-session/")) {
    return null;
  }
  const fileName = normalized.split("/").at(-1) ?? "";
  if (!fileName.endsWith(".test.ts") || fileName.includes("*")) {
    return null;
  }
  return fileName.slice(0, -".test.ts".length);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}
