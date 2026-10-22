import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function quote(value) {
  return process.platform === "win32"
    ? `"${value.replaceAll('"', '\\"')}"`
    : `'${value.replaceAll("'", "'\\''")}'`;
}

export default {
  // 单个入口接收源码与测试，选择器合并去重；不再分两批重复执行共同依赖。
  "**/*.{js,jsx,ts,tsx,mjs,mts,cjs,cts,json,yaml,yml,sh}": async (files) => {
    const selected = [...new Set(files)].filter(
      (file) => !file.replaceAll("\\", "/").includes("packages/desktop/test/e2e/"),
    );
    if (!selected.length) return [];
    const manifest = join(
      tmpdir(),
      `.zcode-lint-staged-vitest-${process.pid}-${randomUUID()}.json`,
    );
    await writeFile(manifest, JSON.stringify({ mode: "affected", files: selected }));
    return `node scripts/run-lint-staged-vitest.mjs affected --files-manifest ${quote(manifest)}`;
  },
};
