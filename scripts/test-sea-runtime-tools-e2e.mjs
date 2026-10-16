#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  NATIVE_SEARCH_TOOL_VERSIONS,
  resolveNativeSearchReleasePlan,
} from "./native-search-tools-config.mjs";
import {
  hostTarget,
  outputBinaryName,
} from "../apps/zcode-cli/packages/cli/scripts/sea-targets.mjs";
import { resolveSpawnRuntimeOptions } from "./spawn-command.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliWorkspace = join(repoRoot, "apps", "zcode-cli");
const cliPackageRoot = join(cliWorkspace, "packages", "cli");

function execute(command, args, { cwd = repoRoot, env = process.env, stdio = "inherit" } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    stdio,
    ...resolveSpawnRuntimeOptions(command),
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} exited with ${result.status}\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`,
  );
  return result;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runtimeToolFixtures(releasePlan) {
  const toolIds = releasePlan.runtimeToolIds;
  return toolIds.map((toolId) => {
    const baseBinaryName = toolId === "ripgrep" ? "rg" : toolId;
    const binaryName = releasePlan.platform === "win32" ? `${baseBinaryName}.exe` : baseBinaryName;
    const sourcePath = join(
      repoRoot,
      "packages",
      "desktop",
      "bundled-tools",
      releasePlan.platformKey,
      toolId,
      binaryName,
    );
    assert.ok(existsSync(sourcePath), `missing host runtime tool ${toolId}: ${sourcePath}`);
    return {
      binaryName,
      envVar:
        toolId === "bfs"
          ? "ZCODE_BFS_BINARY"
          : toolId === "ugrep"
            ? "ZCODE_UGREP_BINARY"
            : "ZCODE_RG_BINARY",
      id: toolId,
      sha256: sha256(sourcePath),
      sourcePath,
      version: NATIVE_SEARCH_TOOL_VERSIONS[toolId],
    };
  });
}

function main() {
  assert.ok(
    process.platform === "darwin" || process.platform === "linux" || process.platform === "win32",
    "SEA native runtime tool E2E must run on macOS, Linux, or Windows",
  );
  const releasePlan = resolveNativeSearchReleasePlan();
  assert.equal(
    releasePlan.enabled,
    true,
    `native runtime tools are not enabled for ${releasePlan.platformKey}`,
  );
  const target = hostTarget();
  const fixtures = runtimeToolFixtures(releasePlan);

  execute("pnpm", ["--dir", cliWorkspace, "build"]);
  execute("pnpm", [
    "--dir",
    cliWorkspace,
    "--filter",
    "@zcode/cli",
    "sea",
    "--",
    "--target",
    target,
  ]);

  const e2eRoot = mkdtempSync(join(tmpdir(), "zcode-sea-runtime-tools-e2e-"));
  try {
    const isolatedBinary = join(e2eRoot, basename(outputBinaryName(target)));
    copyFileSync(join(cliPackageRoot, "dist", outputBinaryName(target)), isolatedBinary);
    if (process.platform !== "win32") chmodSync(isolatedBinary, 0o755);

    const storageRoot = join(e2eRoot, "storage");
    const seaEnv = {
      ...process.env,
      ZCODE_STORAGE_DIR: storageRoot,
    };
    delete seaEnv.ZCODE_BFS_BINARY;
    delete seaEnv.ZCODE_RG_BINARY;
    delete seaEnv.ZCODE_UGREP_BINARY;

    execute(isolatedBinary, ["--version"], {
      cwd: e2eRoot,
      env: seaEnv,
    });

    const extractedPaths = {};
    const initialStats = {};
    for (const fixture of fixtures) {
      const binaryPath = join(
        storageRoot,
        "cache",
        "runtime_tools",
        target,
        fixture.id,
        `${fixture.version}-${fixture.sha256}`,
        fixture.binaryName,
      );
      assert.ok(existsSync(binaryPath), `SEA did not extract ${fixture.id}: ${binaryPath}`);
      assert.equal(sha256(binaryPath), fixture.sha256, `${fixture.id} cache hash mismatch`);
      if (process.platform !== "win32") {
        assert.notEqual(statSync(binaryPath).mode & 0o111, 0, `${fixture.id} is not executable`);
      }
      execute(binaryPath, ["--version"], {
        cwd: e2eRoot,
      });
      extractedPaths[fixture.envVar] = binaryPath;
      const binaryStat = statSync(binaryPath);
      initialStats[fixture.id] = {
        ino: binaryStat.ino,
        mtimeMs: binaryStat.mtimeMs,
      };
    }

    execute(isolatedBinary, ["--version"], {
      cwd: e2eRoot,
      env: seaEnv,
    });
    for (const fixture of fixtures) {
      const currentStat = statSync(extractedPaths[fixture.envVar]);
      assert.deepEqual(
        { ino: currentStat.ino, mtimeMs: currentStat.mtimeMs },
        initialStats[fixture.id],
        `${fixture.id} was unnecessarily re-extracted`,
      );
    }

    execute(process.execPath, [join(repoRoot, "scripts", "test-native-search-tools-e2e.mjs")], {
      env: {
        ...process.env,
        ...extractedPaths,
      },
    });
    console.log(`PASS SEA runtime tools E2E (${target})`);
  } finally {
    rmSync(e2eRoot, { force: true, recursive: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}
