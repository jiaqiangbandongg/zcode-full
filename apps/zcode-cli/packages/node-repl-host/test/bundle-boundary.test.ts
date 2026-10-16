import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

// 这份依赖边界守卫原先长在 browser-use-plugin/test/bundle-boundary.test.ts 上（entry 是
// browser-use 的 src/mcp/server.ts）。node_repl 宿主抽成本包后 entry 随之搬家，守卫必须跟着
// 搬：留在 browser-use 侧会指向已删除的 src/mcp/，而本包才是真正被 plugin host import 的产物。
// 相对路径深度不变（两个包同为 apps/zcode-cli/packages/*），因此下面的 ../contracts、
// ../../../../packages/shared 等前缀原样有效。
describe("node_repl MCP bundle boundary", () => {
  it("只依赖 core 的 REPL 引擎，不带入 Agent、工具或工作流编译器", async () => {
    const result = await build({
      absWorkingDir: packageRoot,
      bundle: true,
      entryPoints: ["src/server.ts"],
      format: "esm",
      legalComments: "none",
      metafile: true,
      platform: "node",
      target: "node24",
      write: false,
    });
    const inputs = Object.keys(result.metafile.inputs).map((path) =>
      normalizePath(resolve(packageRoot, path)),
    );
    const coreRoot = `${normalizePath(resolve(packageRoot, "../core/dist"))}/`;
    const coreInputs = inputs.filter((path) => path.startsWith(coreRoot));
    expect(coreInputs.length).toBeGreaterThan(0);
    // Bug 原因：仅从总入口取 NodeReplSession，也会因顶层副作用带入整套业务依赖。
    // 检查依赖边界而非固定包体积，允许 REPL 自身增加实现文件。
    expect(coreInputs.find((path) => !path.startsWith(`${coreRoot}repl/`))).toBeUndefined();
    expect(
      inputs.find((path) => /(?:^|\/)(?:dynamic-workflow|typescript)\//u.test(path)),
    ).toBeUndefined();

    const contractRoot = `${normalizePath(resolve(packageRoot, "../contracts/dist"))}/`;
    const contractInputs = inputs
      .filter((path) => path.startsWith(contractRoot))
      .map((path) => path.slice(contractRoot.length));
    expect(contractInputs.sort()).toEqual([
      "interfaces/mcp.port.js",
      "tools/json-schema.js",
      "tools/node-repl.js",
    ]);

    const sharedRoot = `${normalizePath(resolve(packageRoot, "../../../../packages/shared/src"))}/`;
    const sharedInputs = inputs.filter((path) => path.startsWith(sharedRoot));
    expect(sharedInputs.length).toBeGreaterThan(0);
    // 同一个总入口即使只取常量，也会初始化其它领域的 schema；Worker 会重复承担这份开销。
    expect(
      sharedInputs.find((path) => !path.startsWith(`${sharedRoot}browser-use/`)),
    ).toBeUndefined();
  });
});
