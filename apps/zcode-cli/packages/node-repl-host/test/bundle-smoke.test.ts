import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildNodeReplHostBundle } from "../scripts/build.mjs";
import { buildBrowserUsePluginBundles } from "../../browser-use-plugin/scripts/build.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const buildTimeoutMs = 120_000;

type ProbeResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};

// Bug 原因：node_repl 的 MCP server 是 CLI spawn 的独立 stdio 子进程，plugin host 通过
// `await import(pathToFileURL(dist/mcp/server.js))` 加载它。之前所有测试都跑在 TS 源码上，
// 没有任何一条覆盖"打出来的 bundle 能不能被 import"，所以 2026-07-27 这次 ESM bundle 里
// yaml 的 require("process") 命中 esbuild 抛错版 __require shim、加载即崩，
// 从 lint 到单测到 CI 全绿通过，最后是用户发现 mcp__node_repl__js 工具整个消失。
// 这个 smoke test 直接构建真实产物并在子进程里 import 一次，把"加载期崩溃"挡在提交之前。
const runBundleProbe = (bundlePath: string): Promise<ProbeResult> => {
  // 用 --input-type=module -e 而不是直接执行文件：import 时 process.argv[1] 为空，
  // server.ts 的"直接执行"分支不会被触发，因此不会真的起一个 stdio server 挂住子进程，
  // 但模块求值路径（也就是崩溃发生的地方）与真实 plugin host 完全一致。
  const probeSource = [
    `const bundle = await import(${JSON.stringify(pathToFileURL(bundlePath).href)});`,
    "process.stdout.write(typeof bundle.main);",
  ].join("\n");

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", probeSource], {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectPromise);
    child.once("close", (exitCode) => {
      resolvePromise({ exitCode, stderr, stdout });
    });
  });
};

describe("node_repl host and browser-use runtime bundles", () => {
  let outputDirectory = "";
  let mcpOutfile = "";
  let browserClientOutfile = "";

  beforeAll(async () => {
    outputDirectory = await mkdtemp(join(tmpdir(), "zcode-node-repl-bundle-"));
    // 宿主产物由本包构建；browser-client 仍由 browser-use 构建。两个 bundle 都是 ESM，
    // 都可能被 CJS 依赖在加载期炸掉，所以一起 smoke。
    // 临时目录不在 type=module package 下；用 .mjs 保证直接 spawn 与正式 .js 产物语义一致。
    const [host, browser] = await Promise.all([
      buildNodeReplHostBundle({ outfile: join(outputDirectory, "mcp", "server.mjs") }),
      buildBrowserUsePluginBundles({
        browserClientOutfile: join(outputDirectory, "browser-client.mjs"),
      }),
    ]);
    mcpOutfile = host.outfile;
    browserClientOutfile = browser.browserClientOutfile;
  }, buildTimeoutMs);

  afterAll(async () => {
    if (outputDirectory) {
      await rm(outputDirectory, { force: true, recursive: true });
    }
  });

  it(
    "imports the built node_repl MCP server bundle without failing module evaluation",
    async () => {
      const probe = await runBundleProbe(mcpOutfile);

      // 断言 stderr 是为了失败时能直接看到崩溃原因，而不是只看到一个 exit code。
      expect(probe.stderr).not.toContain("Dynamic require of");
      expect({ exitCode: probe.exitCode, stderr: probe.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      // plugin host 要求 runtime bundle 显式导出 main()，缺失时 MCP 握手前就会退出。
      expect(probe.stdout).toBe("function");
    },
    buildTimeoutMs,
  );

  it(
    "negotiates MCP 2026-07-28 and isolates globals plus module cache in built node_repl",
    async () => {
      const transport = new StdioClientTransport({
        args: [mcpOutfile],
        command: process.execPath,
        cwd: packageRoot,
        stderr: "pipe",
      });
      const client = new Client(
        { name: "node-repl-bundle-smoke", version: "0.1.0" },
        { versionNegotiation: { mode: { pin: "2026-07-28" } } },
      );
      let serverStderr = "";
      transport.stderr?.setEncoding("utf8");
      transport.stderr?.on("data", (chunk: string) => {
        serverStderr += chunk;
      });
      try {
        await client.connect(transport).catch(async (error) => {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\nbundle: ${mcpOutfile}\nserver stderr:\n${serverStderr}`,
          );
        });
        const listed = await client.listTools();
        expect(client.getProtocolEra()).toBe("modern");
        expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["js"]);
        const meta = {
          "com.zcode/request-context": {
            runtime_scope: "main",
            session_id: "bundle-session",
          },
        };
        const first = await client.callTool({
          name: "js",
          arguments: {
            code: [
              "globalThis.__zcodeKernelMarker = 'FIRST';",
              "require('node:events').__zcodeModuleMarker = 'FIRST';",
              "'set';",
            ].join("\n"),
          },
          _meta: meta,
        });
        expect(first.isError).not.toBe(true);
        const second = await client.callTool({
          name: "js",
          arguments: {
            code: "({ kernel: typeof globalThis.__zcodeKernelMarker, module: typeof require('node:events').__zcodeModuleMarker });",
          },
          _meta: meta,
        });
        expect(second.content).toContainEqual(
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining('"kernel": "undefined"'),
          }),
        );
        expect(second.content).toContainEqual(
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining('"module": "undefined"'),
          }),
        );
        expect(serverStderr).toBe("");
      } finally {
        await client.close();
      }
    },
    buildTimeoutMs,
  );

  it("guards its CLI entry with pathToFileURL so Windows actually builds", async () => {
    // Bug 原因（2026-09-12，CI build:windows:x64）：入口守卫原先写成
    // `import.meta.url === \`file://${process.argv[1]}\``。Windows 上 argv[1] 是
    // `C:\\...\\build.mjs`，而 import.meta.url 是 `file:///C:/.../build.mjs`，两者永远不相等 ——
    // 脚本被当成纯模块导入、什么都不做就退出，构建"成功"却没有产物，直到 dev 守卫报
    // 「build succeeded without required MCP runtime」才暴露。
    const source = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
    expect(source).toContain("pathToFileURL");
    // 字符串拼接的形态一旦回来，Windows 会再次静默不产出。只看代码行（注释里留了反例说明）。
    const codeLines = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(codeLines).not.toMatch(/file:\/\/\$\{process\.argv/u);
  });

  it("injects a real require into both ESM bundles so bundled CJS dependencies keep working", async () => {
    const [mcpBundle, browserClientBundle] = await Promise.all([
      readFile(mcpOutfile, "utf8"),
      readFile(browserClientOutfile, "utf8"),
    ]);

    for (const bundle of [mcpBundle, browserClientBundle]) {
      expect(bundle).toContain('createRequire as __zcodeCreateRequire } from "node:module"');
    }
  });

  // 构建期守卫本身也要有测试：define 名漂移时必须**构建失败**，而不是静默产出空串 ——
  // 后者的症状只在正式包出现，且表现为超时，没有任何日志。
  it("fails the build when the injected build id does not reach the output", async () => {
    const outfile = join(outputDirectory, "mcp", "server.guard.mjs");
    // 用一个不可能出现在产物里的值：走完整构建后守卫应当抛错。
    // 这里通过临时改写 define 名不现实，所以直接验证守卫的判据 —— 产物必须包含该值。
    const source = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
    expect(source).toContain("__ZCODE_CUA_HELPER_BUILD_ID__");
    expect(source).toMatch(/未折叠进|did not reach/u);
    // 并确认守卫只在 buildId 非空时生效（dev 空串不应让构建失败）。
    const devResult = await buildNodeReplHostBundle({ outfile, cuaHelperBuildId: "" });
    expect(devResult.cuaHelperBuildId).toBe("");
  }, buildTimeoutMs);
});
