import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  clearHoistedPatchedDependencyTargets,
  resolvePatchedDependencyPackageName,
} from "../bootstrap-patched-dependencies.mjs";

test("解析 scoped 与普通 patched dependency key", () => {
  assert.equal(
    resolvePatchedDependencyPackageName("@arms/rum-electron@0.0.3"),
    "@arms/rum-electron",
  );
  assert.equal(resolvePatchedDependencyPackageName("vitest@4.1.7"), "vitest");
});

test("bootstrap install 前只清理 hoisted patched dependency 目标", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-bootstrap-patch-"));
  try {
    const packageJsonPath = join(rootDir, "package.json");
    await writeFile(
      packageJsonPath,
      JSON.stringify({
        pnpm: {
          patchedDependencies: {
            "@arms/rum-electron@0.0.3": "patches/arms.patch",
            "vitest@4.1.7": "patches/vitest.patch",
          },
        },
      }),
    );
    await mkdir(join(rootDir, "node_modules/@arms/rum-electron"), {
      recursive: true,
    });
    await mkdir(join(rootDir, "node_modules/vitest"), { recursive: true });
    await mkdir(join(rootDir, "node_modules/unrelated"), { recursive: true });

    const removed = await clearHoistedPatchedDependencyTargets({
      rootDir,
      packageJsonPath,
    });

    assert.deepEqual(removed.sort(), ["@arms/rum-electron", "vitest"]);
    await assert.rejects(access(join(rootDir, "node_modules/@arms/rum-electron")));
    await assert.rejects(access(join(rootDir, "node_modules/vitest")));
    await access(join(rootDir, "node_modules/unrelated"));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
