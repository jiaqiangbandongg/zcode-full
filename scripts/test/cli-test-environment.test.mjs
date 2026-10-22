import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("CUA producer checkout 参与 CLI 测试缓存键并由 Turbo 传入", async () => {
  const config = JSON.parse(
    await readFile(new URL("../../apps/zcode-cli/turbo.json", import.meta.url), "utf8"),
  );
  assert.ok(config.tasks.test.env.includes("ZCODE_CUA_REPO"));
  assert.ok(config.tasks.test.env.includes("VITEST_MAX_WORKERS"));
});

test("CLI 全量测试先准备跨 workspace 的模型映射构建产物", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../apps/zcode-cli/package.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.scripts.pretest, "pnpm --dir ../.. --filter @zcode/model-option-map build");
});
