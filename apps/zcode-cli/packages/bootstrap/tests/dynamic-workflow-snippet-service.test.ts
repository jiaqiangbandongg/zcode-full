/**
 * dwf snippet service（EvalWorkflowSnippet 的执行面）。见 docs/dynamic-workflow/authoring.md。
 *
 * 这些用例走**真沙箱**（runWorkflowScript spawn 一个 node 子进程，runtime 包的 e2e 先例），
 * 但 world read 落在内存 fs 桩上——被测对象是 service 这一层的编排：scratch facade 编译、
 * 诊断路径、结算映射、logs 捕获、超时、产物上限。与真文件系统的对接由
 * workflow-driver-world-read-args.test.ts 与 runtime e2e 覆盖。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ExecutionPort, FileSystemPort, TraceContext } from "@zcode/contracts";
import { NodeExecutionAdapter } from "@zcode/adapters/exec";
import { WORLD_RUN_LITERAL_CODE } from "@zcode/dynamic-workflow";
import { createDynamicWorkflowSnippetService } from "../src/app/dynamic-workflow-snippet-service.js";
/**
 * 独立的 run cwd：harness 把入口文件写到 `<cwd>/.zcode/workflow-runs/<runId>.mjs` 且保留，
 * 用 process.cwd() 会把存档留在包目录里，并让并行测试文件互相覆写同名入口文件。
 */
const TEST_CWD: string = mkdtempSync(join(tmpdir(), "dwf-bootstrap-test-cwd-"));

/** 极简内存 fs 端口（照 workflow-driver-world-read-args.test.ts 的桩形状）。 */
function stubFileSystemPort(glob: string[], read: string, globHangs: boolean): FileSystemPort {
  const unsupported = (name: string) => () => {
    throw new Error(`stubFileSystemPort.${name} 不应被触及`);
  };
  return {
    async searchFiles(request: { path: string; pattern: string }) {
      // 永不应答的 world read：让 snippet「活着却无事可做」的唯一合法形态是一条在飞的 host 请求
      // （runtime 包 tests/failures.test.ts 的 HANG 同理）；裸的永不兑现 promise 会被 cell 当场判停滞。
      if (globHangs) await new Promise<never>(() => {});
      return {
        path: request.path,
        pattern: request.pattern,
        durationMs: 0,
        files: glob,
        numFiles: glob.length,
        truncated: false,
      };
    },
    async readTextFile(request: { path: string }) {
      return {
        path: request.path,
        content: read,
        encoding: "utf-8",
        bytesRead: read.length,
        sizeBytes: read.length,
        truncated: false,
      };
    },
    createDirectory: unsupported("createDirectory"),
    stat: unsupported("stat"),
    readBinaryFile: unsupported("readBinaryFile"),
    readTextFileRange: unsupported("readTextFileRange"),
    writeTextFile: unsupported("writeTextFile"),
    removeFile: unsupported("removeFile"),
    listDirectory: unsupported("listDirectory"),
    searchText: unsupported("searchText"),
  } as unknown as FileSystemPort;
}

function unsupportedExecutionPort(): ExecutionPort {
  return {
    run: () => {
      throw new Error("本用例不应触及 ExecutionPort（git.* world-read）");
    },
  };
}

const trace: TraceContext = {
  traceId: "trace-snippet-test",
  spanId: "span-1",
  sessionId: "sess_test",
} as TraceContext;

function makeService(options?: { glob?: string[]; read?: string; globHangs?: boolean }) {
  return createDynamicWorkflowSnippetService({
    fileSystemPort: stubFileSystemPort(
      options?.glob ?? [],
      options?.read ?? "",
      options?.globHangs ?? false,
    ),
    executionPort: unsupportedExecutionPort(),
    availableParallelism: () => 4,
  });
}

function request(code: string, timeoutMs = 30_000) {
  return { code, cwd: TEST_CWD, timeoutMs, trace };
}

describe("dynamic workflow snippet service", () => {
  it("returns diagnostics for agent() without executing anything", async () => {
    const service = makeService();
    const result = await service.evalSnippet(request(`return await agent("a").ask("x");`));
    expect(result.kind).toBe("diagnostics");
    if (result.kind !== "diagnostics") return;
    expect(result.diagnostics[0]?.message).toContain("Cannot find name 'agent'");
  });

  it("runs a world-read + pure-logic snippet and returns the artifact", async () => {
    const service = makeService({ glob: ["b.ts", "a.ts", "a.test.ts"] });
    const result = await service.evalSnippet(
      request(
        `const paths = await files.glob("**/*.ts");\n` +
          `log(\`saw \${paths.length}\`);\n` +
          `return paths.filter((p) => p.endsWith(".test.ts"));`,
      ),
    );
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    // facade 归一：工作区相对 + 字典序（glob 事故的钉子在 driver 侧，这里断言端到端形状）。
    expect(result.artifact).toEqual(["a.test.ts"]);
    expect(result.logs).toEqual(["saw 3"]);
    expect(result.logsTruncated).toBe(false);
  });

  it("returns completed without artifact when the snippet has no return", async () => {
    const service = makeService();
    const result = await service.evalSnippet(request(`log("side quest only");`));
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect("artifact" in result).toBe(false);
    expect(result.logs).toEqual(["side quest only"]);
  });

  it("maps a script throw to a structured failure with the sandbox message", async () => {
    const service = makeService();
    const result = await service.evalSnippet(request(`throw new Error("boom from snippet");`));
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.error.code).toBe("DriverError");
    expect(result.error.message).toContain("boom from snippet");
  });

  it("kills the sandbox on wall-clock timeout and fails structurally", async () => {
    // 挂在一条永不应答的 world read 上：请求在飞，cell 不会判停滞，只剩墙钟能结束它。
    const service = makeService({ globHangs: true });
    const result = await service.evalSnippet(request(`await files.glob("**");`, 1_000));
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    // 墙钟超时是宿主侧故障：引擎结算 stopped(interrupted)（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md
    // 决策 12）；snippet 没有 resume 语义，对调用方仍是结构化失败，code 透出 Interrupted。
    expect(result.error.code).toBe("Interrupted");
    expect(result.error.message).toContain("1000ms");
  }, 20_000);

  it("fails a stalled snippet at once instead of waiting for the wall clock", async () => {
    // 没有在飞请求的永不兑现 promise 是停滞（execution-engine.md「The vm cell」停滞检测）：
    // cell 以 ScriptStalled 结束 run，snippet 立刻拿到结构化失败，而不是挂到 30s 超时。
    const service = makeService();
    const result = await service.evalSnippet(request(`await new Promise(() => {});`, 30_000));
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.error.code).toBe("DriverError");
    expect(result.error.message).toContain("Stalled");
  }, 10_000);

  it("rejects an oversized return value with ArtifactTooLarge", async () => {
    const service = makeService();
    const result = await service.evalSnippet(
      // 300KB 的字符串产物：超过 256KB 序列化上限。
      request(`return "x".repeat(300 * 1024);`),
    );
    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.error.code).toBe("ArtifactTooLarge");
    expect(result.error.message).toContain("262144");
  });

  it("caps captured logs and marks truncation", async () => {
    const service = makeService();
    const result = await service.evalSnippet(
      request(`for (let i = 0; i < 120; i++) log("line " + i);`),
    );
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.logs.length).toBe(100);
    expect(result.logsTruncated).toBe(true);
  });

  it("surfaces world-read cap rejections as catchable inside the snippet", async () => {
    // 2001 个文件超过 files.glob 的 2000 上限：service 不截断，脚本 catch 到结构化拒绝。
    const service = makeService({ glob: Array.from({ length: 2001 }, (_, i) => `f${i}.ts`) });
    const result = await service.evalSnippet(
      request(
        `try {\n  await files.glob("**");\n  return "no-cap";\n} catch (error) {\n` +
          `  return (error as { code?: string }).code ?? "caught";\n}`,
      ),
    );
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    expect(result.artifact).toBe("WorldReadCapExceeded");
  });
});

describe("dynamic workflow snippet service — world.run", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "dwf-snippet-world-run-"));
  afterAll(() => rmSync(outputRoot, { force: true, recursive: true }));

  function makeWorldRunService() {
    return createDynamicWorkflowSnippetService({
      fileSystemPort: stubFileSystemPort([], ""),
      // 真执行端口：world.run 的 e2e 意义正在于「同一个 driver 面对真命令」。
      executionPort: new NodeExecutionAdapter({
        outputRootDir: outputRoot,
        processEnv: process.env as Record<string, string>,
      }) as unknown as ExecutionPort,
      availableParallelism: () => 4,
    });
  }

  it("runs a real command and hands the nonzero exit code back to script logic", async () => {
    const service = makeWorldRunService();
    const result = await service.evalSnippet(
      request(
        `const r = await world.run("node", ["-e", "console.log('hi'); process.exit(3)"]);\n` +
          `return { code: r.exitCode, out: r.stdout.trim() };`,
        30_000,
      ),
    );
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") return;
    // 非零退出是值：门控逻辑在脚本内分支，不经异常控制流。
    expect(result.artifact).toEqual({ code: 3, out: "hi" });
  }, 30_000);

  it("rejects a non-literal cmd with the positioned world.run diagnostic", async () => {
    const service = makeWorldRunService();
    const result = await service.evalSnippet(
      request(`const cmd = "node";\nawait world.run(cmd, []);`),
    );
    expect(result.kind).toBe("diagnostics");
    if (result.kind !== "diagnostics") return;
    expect(result.diagnostics[0]?.code).toBe(WORLD_RUN_LITERAL_CODE);
    expect(result.diagnostics[0]?.line).toBe(2);
  });
});
