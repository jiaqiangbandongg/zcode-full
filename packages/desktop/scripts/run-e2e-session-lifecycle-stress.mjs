#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const DEFAULT_ITERATIONS = 25;
const desktopDir = resolve(fileURLToPath(new URL("..", import.meta.url)));

function readIterations(args, env) {
  const arg = args.find((item) => item.startsWith("--iterations="));
  const raw = arg?.slice("--iterations=".length) ?? env.ZCODE_E2E_SESSION_STRESS_ITERATIONS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_ITERATIONS;
  }
  if (!/^\d+$/u.test(raw) || Number(raw) <= 0) {
    throw new Error(`iterations must be a positive integer, received: ${raw}`);
  }
  return Number(raw);
}

function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`session lifecycle stress terminated by ${signal}`));
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

const iterations = readIterations(process.argv.slice(2), process.env);
const entropy = randomBytes(6).toString("hex");
const runId = `desktop-e2e-session-lifecycle-p${process.pid}-${entropy}`;
const cacheRoot = join(desktopDir, ".e2e-cache", runId);
const specsDir = join(cacheRoot, "specs");
const homeDir = join(cacheRoot, "home");
const artifactDir = join(desktopDir, ".e2e-artifacts", runId);
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

await mkdir(specsDir, { recursive: true });
for (let index = 1; index <= iterations; index += 1) {
  const marker = String(index).padStart(3, "0");
  await writeFile(
    join(specsDir, `session-lifecycle-${marker}.test.ts`),
    // 每个 alias 都由同一个 WDIO launcher 派发为独立 worker/session，复现全量
    // 运行的重复启动/销毁模式，而不是在一个 Electron session 内循环断言。
    'import "../../../test/e2e/infrastructure/session-lifecycle.test.js";\n',
    "utf8",
  );
}

let exitCode = 1;
try {
  exitCode = await run(
    pnpmCommand,
    ["exec", "wdio", "run", "wdio.conf.ts", "--spec", join(specsDir, "*.test.ts")],
    {
      cwd: desktopDir,
      env: {
        ...process.env,
        PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
        ZCODE_E2E_ARTIFACT_DIR: artifactDir,
        ZCODE_E2E_HOME_DIR: homeDir,
        ZCODE_E2E_RUN_ID: runId,
      },
      stdio: "inherit",
    },
  );
} finally {
  await rm(cacheRoot, { force: true, recursive: true });
}

console.log(`[e2e-session-lifecycle] iterations=${iterations}; artifact=${artifactDir}`);
process.exitCode = exitCode;
