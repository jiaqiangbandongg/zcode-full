#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";

const ROOT_UNIT_E2E_GLOB = "packages/desktop/test/e2e/**/*.test.ts";

function resolvePnpmCliPath(env) {
  const npmExecPath = env.npm_execpath;
  if (
    npmExecPath &&
    (npmExecPath.toLowerCase().includes("\\pnpm\\") ||
      npmExecPath.toLowerCase().includes("/pnpm/"))
  ) {
    return npmExecPath;
  }

  const pathEntries = (env.PATH ?? env.Path ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const pathEntry of pathEntries) {
    const candidate = join(pathEntry, "node_modules", "pnpm", "bin", "pnpm.cjs");
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function spawnPnpm(args, options) {
  // Bugfix: Windows 下不能把文件参数拼成 cmd.exe 字符串；%PATH% 这类合法文件名
  // 会被 shell 展开。pre-push 专用 runner 在 Windows 下直接走 pnpm JS 入口，保持 argv 原样传递。
  if (process.platform !== "win32") {
    return spawnSync("pnpm", args, options);
  }

  const cliPath = resolvePnpmCliPath(options.env ?? process.env);
  if (cliPath) {
    return spawnSync(process.execPath, [cliPath, ...args], options);
  }

  return spawnSync("pnpm", args, { ...options, shell: true });
}

function collectGitLocalEnvNames() {
  const result = spawnSync("git", ["rev-parse", "--local-env-vars"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status !== 0) {
    return ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function createCleanGitEnv() {
  const env = { ...process.env };

  // lint-staged 在 pre-push 路径下使用临时 GIT_INDEX_FILE 保护真实 index。
  // Vitest 及单测中的临时 Git 仓库不应继承这些 local env，否则会误命中当前仓库。
  for (const name of collectGitLocalEnvNames()) {
    delete env[name];
  }

  return env;
}

function readFilesFromManifest(mode, manifestPath) {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      !parsed ||
      parsed.mode !== mode ||
      !Array.isArray(parsed.files) ||
      !parsed.files.every((file) => typeof file === "string")
    ) {
      throw new Error("invalid manifest shape");
    }
    return parsed.files;
  } finally {
    rmSync(manifestPath, { force: true });
  }
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  if (rest[0] === "--files-manifest") {
    const manifestPath = rest[1];
    if (!manifestPath) {
      throw new Error("--files-manifest requires a path");
    }
    return {
      mode,
      files: readFilesFromManifest(mode, manifestPath),
    };
  }

  return { mode, files: rest };
}

const { mode, files } = parseArgs(process.argv.slice(2));

if (mode !== "run" && mode !== "related") {
  console.error(
    "Usage: node scripts/run-lint-staged-vitest.mjs <run|related> [--files-manifest <path>|<files...>]",
  );
  process.exit(1);
}

if (files.length === 0) {
  process.exit(0);
}

const vitestArgs =
  mode === "run"
    ? ["exec", "vitest", "run", "--exclude", ROOT_UNIT_E2E_GLOB, ...files]
    : [
        "exec",
        "vitest",
        "related",
        "--run",
        "--passWithNoTests",
        "--exclude",
        ROOT_UNIT_E2E_GLOB,
        ...files,
      ];

const result = spawnPnpm(vitestArgs, {
  env: createCleanGitEnv(),
  stdio: "inherit",
});

if (result.error) {
  console.error(
    `[lint-staged vitest] failed to spawn pnpm: ${result.error.message}`,
  );
}

process.exitCode = result.status ?? 1;
