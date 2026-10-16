#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  isMacosRosettaTarget,
  normalizeNativeSearchArch,
  normalizeNativeSearchPlatform,
  resolveNativeSearchBuildPlan,
} from "./native-search-tools-config.mjs";
import { buildNativeSearchTools } from "./build-native-search-tools.mjs";
import { downloadNativeSearchTools } from "./download-native-search-tools.mjs";
import { verifyBuiltNativeSearchTools } from "./native-search-tools-verify.mjs";
import { resolveSpawnRuntimeOptions } from "./spawn-command.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function execute(command, args, { cwd, env } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...resolveSpawnRuntimeOptions(command),
  });
  if (result.error) throw result.error;
  return result;
}

function expectStatus(result, status, label) {
  assert.equal(
    result.status,
    status,
    `${label} exited with ${result.status}\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`,
  );
}

function verifyBashEmbeddedSearch(plan) {
  const buildResult = execute(
    "pnpm",
    ["--dir", repoRoot, "--filter", "@zcode/bootstrap^...", "--if-present", "build"],
    { cwd: repoRoot, env: process.env },
  );
  expectStatus(buildResult, 0, "Bash embedded search dependency build");

  const integrationResult = execute(
    "pnpm",
    [
      "--dir",
      join(repoRoot, "apps/zcode-cli"),
      "exec",
      "vitest",
      "run",
      "packages/bootstrap/tests/embedded-search-native.e2e.test.ts",
      "--detectAsyncLeaks",
      "--no-file-parallelism",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...(plan.bfsPath ? { ZCODE_BFS_BINARY: plan.bfsPath } : {}),
        ZCODE_REQUIRE_NATIVE_SEARCH_E2E: "1",
        ZCODE_RG_BINARY: plan.rgPath,
        ZCODE_UGREP_BINARY: plan.ugrepPath,
      },
    },
  );
  expectStatus(integrationResult, 0, "Bash embedded search integration E2E");
  assert.doesNotMatch(
    `${integrationResult.stdout}\n${integrationResult.stderr}`,
    /Async Leaks \d+/u,
    "Bash embedded search integration E2E leaked asynchronous resources",
  );
}

async function resolveNativeSearchPlan(outputDir) {
  const targetPlatform = process.env.ZCODE_TARGET_OS?.trim() || process.platform;
  const targetArch = process.env.ZCODE_TARGET_ARCH?.trim() || process.arch;
  const bfsPath = process.env.ZCODE_BFS_BINARY?.trim();
  const rgPath = process.env.ZCODE_RG_BINARY?.trim();
  const ugrepPath = process.env.ZCODE_UGREP_BINARY?.trim();
  const normalizedPlatform = normalizeNativeSearchPlatform(targetPlatform);
  const requiresBfs = normalizedPlatform !== "win32";
  if (!requiresBfs) {
    assert.equal(
      Boolean(bfsPath),
      false,
      "Windows native search E2E must leave find on the Git Bash/system fallback",
    );
  }
  const hasPrebuiltNativeTools = Boolean(rgPath && ugrepPath && (!requiresBfs || bfsPath));

  if (!hasPrebuiltNativeTools) {
    assert.equal(
      Boolean(bfsPath || rgPath || ugrepPath),
      false,
      requiresBfs
        ? "ZCODE_BFS_BINARY, ZCODE_RG_BINARY, and ZCODE_UGREP_BINARY must be provided together"
        : "ZCODE_RG_BINARY and ZCODE_UGREP_BINARY must be provided together",
    );
    buildNativeSearchTools({
      platform: targetPlatform,
      arch: targetArch,
      outputDir,
      quiet: true,
      runUpstreamTests: normalizedPlatform !== "win32",
    });
    return downloadNativeSearchTools({
      platform: targetPlatform,
      arch: targetArch,
      outputDir,
    });
  }

  if (requiresBfs) assert.ok(existsSync(bfsPath), `missing prebuilt bfs: ${bfsPath}`);
  assert.ok(existsSync(rgPath), `missing prebuilt ripgrep: ${rgPath}`);
  assert.ok(existsSync(ugrepPath), `missing prebuilt ugrep: ${ugrepPath}`);
  const basePlan = resolveNativeSearchBuildPlan({
    platform: targetPlatform,
    arch: targetArch,
    outputDir,
  });
  const resolvedPlan = {
    ...basePlan,
    bfsPath: bfsPath ? resolve(bfsPath) : basePlan.bfsPath,
    rgPath: resolve(rgPath),
    ugrepPath: resolve(ugrepPath),
    binaries: {
      ...basePlan.binaries,
      ...(bfsPath ? { bfs: resolve(bfsPath) } : {}),
      ripgrep: resolve(rgPath),
      ugrep: resolve(ugrepPath),
    },
  };
  return resolvedPlan;
}

async function main() {
  assert.ok(
    process.platform === "darwin" || process.platform === "linux" || process.platform === "win32",
    "this E2E must run on macOS, Linux, or Windows",
  );
  const e2eRoot = mkdtempSync(join(tmpdir(), "zcode-native-search-e2e-"));

  try {
    const plan = await resolveNativeSearchPlan(join(e2eRoot, "runtime-tools"));
    const hostPlatform = normalizeNativeSearchPlatform(process.platform);
    const hostArch = normalizeNativeSearchArch(process.arch);
    assert.equal(plan.platform, hostPlatform);
    assert.ok(
      plan.arch === hostArch ||
        isMacosRosettaTarget({
          platform: plan.platform,
          arch: plan.arch,
          hostPlatform,
          hostArch,
        }),
      // Bugfix: Apple Silicon release runner 会通过 Rosetta 执行同机生成的 x64 产物。
      `native search E2E cannot execute ${plan.platformKey} on ${hostPlatform}-${hostArch}`,
    );
    assert.ok(existsSync(plan.rgPath), `missing bundled ripgrep: ${plan.rgPath}`);
    verifyBuiltNativeSearchTools(plan);
    verifyBashEmbeddedSearch(plan);
    console.log(`PASS native search E2E (${plan.platformKey})`);
  } finally {
    rmSync(e2eRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
