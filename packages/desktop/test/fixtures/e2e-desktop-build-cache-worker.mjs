import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  E2E_DESKTOP_REQUIRED_OUTPUT_PATHS,
  ensureE2EDesktopBuild,
} from "../../scripts/ensure-e2e-desktop-build.mjs";

const root = resolve(process.argv[2]);
const outputs = E2E_DESKTOP_REQUIRED_OUTPUT_PATHS.map((path) => resolve(root, path));

ensureE2EDesktopBuild({
  buildDesktop() {
    appendFileSync(resolve(root, "builds.log"), `${process.pid}\n`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    for (const output of outputs) {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, `built by ${process.pid}\n`);
    }
  },
  env: {},
  fingerprintOptions: {
    gitHead: "shared-head",
    inputPaths: ["src"],
    repoRoot: root,
  },
  lockOptions: { retryDelayMs: 20, timeoutMs: 10_000 },
  lockPath: resolve(root, "cache/desktop-build.lock"),
  outputs,
  stampPath: resolve(root, "cache/desktop-build-stamp.json"),
});
