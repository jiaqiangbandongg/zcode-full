import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("构建配置契约：builtin-provider-config-build", async () => {
  // 构建工具直接运行于 Node；不让 Vitest 的模块转换掩盖打包入口的导入／文件路径问题。
  const result = await promisify(execFile)(
    process.execPath,
    ["--test", "scripts/test/builtin-provider-config-build.test.mjs"],
    { cwd: resolve(import.meta.dirname, "../../.."), timeout: 25_000 },
  );
  expect(result.stdout).toContain("fail 0");
});
