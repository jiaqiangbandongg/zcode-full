#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "src/cli.ts", "run-testcases", ...process.argv.slice(2)],
  {
    cwd: packageRoot,
    stdio: "inherit",
  },
);

process.exit(result.status ?? 1);
