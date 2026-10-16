import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import {
  diagnostic,
  isRecord,
  toRepoPath,
} from "./conversation-session-formal-admission-utils.mjs";

const RUNTIME_FILE_FIXTURE_SOURCES = new Set([
  "created-by-helper",
  "created-by-provider-tool",
  "created-by-spec",
]);

export async function resolveProviderFixturePaths({
  desktopRoot,
  providerFixtureRoot,
  providerFixtures,
  reasons,
  root,
  specPath,
}) {
  const resolved = [];
  for (const manifestPath of providerFixtures) {
    const absolutePath = resolve(desktopRoot, manifestPath);
    if (
      isAbsolute(manifestPath) ||
      hasTraversalSegment(manifestPath) ||
      !isPathContainedBy(providerFixtureRoot, absolutePath)
    ) {
      reasons.push(
        diagnostic({
          code: "UNSAFE_PROVIDER_FIXTURE_PATH",
          message: `provider fixture must stay inside the Upstream fixture root: ${manifestPath}`,
          specPath,
          subjectPath: toRepoPath(root, absolutePath),
        }),
      );
      continue;
    }
    const realContainment = await inspectRealContainment(
      providerFixtureRoot,
      absolutePath,
    );
    if (realContainment.exists && !realContainment.contained) {
      reasons.push(
        diagnostic({
          code: "UNSAFE_PROVIDER_FIXTURE_PATH",
          message: `provider fixture symlink escapes the Upstream fixture root: ${manifestPath}`,
          specPath,
          subjectPath: toRepoPath(root, absolutePath),
        }),
      );
      continue;
    }
    resolved.push({ absolutePath, manifestPath });
  }
  return resolved;
}

export async function validateStaticFilePaths({
  desktopRoot,
  fixtureRoot,
  reasons,
  root,
  specPath,
  staticPaths,
}) {
  for (const fixturePath of staticPaths) {
    const absolutePath = resolve(desktopRoot, fixturePath);
    if (
      isAbsolute(fixturePath) ||
      hasTraversalSegment(fixturePath) ||
      !isPathContainedBy(fixtureRoot, absolutePath)
    ) {
      reasons.push(
        diagnostic({
          code: "UNSAFE_FILE_FIXTURE_PATH",
          message: `static file fixture must stay inside the desktop fixture root: ${fixturePath}`,
          specPath,
          subjectPath: toRepoPath(root, absolutePath),
        }),
      );
      continue;
    }
    const realContainment = await inspectRealContainment(
      fixtureRoot,
      absolutePath,
    );
    if (!realContainment.exists) {
      reasons.push(
        diagnostic({
          code: "MISSING_FILE_FIXTURE",
          message: `declared file fixture is missing: ${fixturePath}`,
          specPath,
          subjectPath: toRepoPath(root, absolutePath),
        }),
      );
      continue;
    }
    if (!realContainment.contained) {
      reasons.push(
        diagnostic({
          code: "UNSAFE_FILE_FIXTURE_PATH",
          message: `static file fixture symlink escapes the desktop fixture root: ${fixturePath}`,
          specPath,
          subjectPath: toRepoPath(root, absolutePath),
        }),
      );
    }
  }
}

export function validateFileFixtures(value, subjectPath, specPath, reasons) {
  if (!Array.isArray(value)) {
    reasons.push(
      diagnostic({
        code: "INVALID_MANIFEST_SHAPE",
        message: "case manifest fileFixtures must be an array",
        specPath,
        subjectPath,
      }),
    );
    return null;
  }
  const staticPaths = [];
  let valid = true;
  for (const fixture of value) {
    if (typeof fixture === "string") {
      staticPaths.push(fixture);
      continue;
    }
    // 运行时 descriptor 只有在生产者来源可审计且描述完整时才豁免存在检查，
    // 避免仅凭一个 /tmp path 绕过静态 fixture containment。
    if (
      isRecord(fixture) &&
      typeof fixture.path === "string" &&
      fixture.path.trim().length > 0 &&
      typeof fixture.description === "string" &&
      fixture.description.trim().length > 0 &&
      RUNTIME_FILE_FIXTURE_SOURCES.has(fixture.source)
    ) {
      continue;
    }
    reasons.push(
      diagnostic({
        code: "INVALID_RUNTIME_FILE_FIXTURE_DESCRIPTOR",
        message:
          "runtime file fixture descriptors require path, description, and an allowed source",
        specPath,
        subjectPath,
      }),
    );
    valid = false;
  }
  return valid ? { staticPaths } : null;
}

function hasTraversalSegment(path) {
  return path.replaceAll("\\", "/").split("/").includes("..");
}

function isPathContainedBy(root, path) {
  const relativePath = relative(root, path).replaceAll("\\", "/");
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith("../") &&
      !isAbsolute(relativePath))
  );
}

async function inspectRealContainment(root, candidate) {
  try {
    const [realRoot, realCandidate] = await Promise.all([
      realpath(root),
      realpath(candidate),
    ]);
    return {
      contained: isPathContainedBy(realRoot, realCandidate),
      exists: true,
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { contained: true, exists: false };
    }
    throw error;
  }
}
