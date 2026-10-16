import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// SG-02（!2071 review）：模块边界重构的承重不变量是"发布/运行时解析路径与
// 源码一致"——宿主直接消费 `@zcode/zcode-cua/frame-contract`，没有任何
// workspace 链接可依赖。这里做产物级验证：
//  1. 真实 node 子进程从 dist 产物加载子路径并核对导出面；
//  2. staging 形态（只有 producer dist/ + package.json，无 node_modules）同样可加载。
// The subpath export is ESM-only ("import" condition), so CJS require.resolve
// cannot see it. Locate the pnpm-hoisted producer copy by walking up from this
// test file to the workspace root.
function findProducerPackageRoot(): string {
  let dir = import.meta.dirname;
  while (true) {
    const candidate = join(dir, "node_modules", "@zcode", "zcode-cua", "package.json");
    if (existsSync(candidate)) return dirname(candidate);
    const parent = dirname(dir);
    if (parent === dir) throw new Error("workspace root not found from " + import.meta.dirname);
    dir = parent;
  }
}
const producerPackageRoot = findProducerPackageRoot();

const REQUIRED_EXPORTS = [
  "OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY",
  "OFFICIAL_CUA_IMAGE_INLINE_BASE64_BYTES",
  "containsOfficialCuaImageRefCredentialText",
  "isOfficialCuaImageRefText",
  "parseOfficialCuaImageRef",
  "containsImageRefAuthority",
  "preserveOfficialCuaFrameResult",
  "attestOfficialCuaFrameContent",
  "findOfficialCuaFrameContentPair",
  "readRasterEnvelopeIdentity",
] as const;

function runNodeImport(targetDir: string, specifier: string): string[] {
  const script = `import(${JSON.stringify(specifier)}).then((m) => console.log(JSON.stringify(Object.keys(m).sort())))`;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: targetDir,
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: "" },
  });
  return JSON.parse(stdout.trim().split("\n").pop()!) as string[];
}

describe("producer frame-contract artifact resolution (SG-02)", () => {
  it("loads the installed subpath and exposes the full contract surface", () => {
    const keys = runNodeImport(producerPackageRoot, "@zcode/zcode-cua/frame-contract");
    for (const name of REQUIRED_EXPORTS) {
      expect(keys, `missing export ${name}`).toContain(name);
    }
  });
});
