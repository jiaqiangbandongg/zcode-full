import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  DynamicWorkflowSnippetEvalRequest,
  DynamicWorkflowSnippetEvalResult,
  DynamicWorkflowSnippetPort,
  EvalWorkflowSnippetOutput,
} from "@zcode/contracts";
import { evalWorkflowSnippetToolEntry } from "../src/tool/handlers/eval-workflow-snippet.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

/** 端口 fake：记录请求、按脚本回结果。编译与执行的真实链路在 bootstrap 的 service 测试里。 */
function stubPort(result: DynamicWorkflowSnippetEvalResult): {
  port: DynamicWorkflowSnippetPort;
  requests: DynamicWorkflowSnippetEvalRequest[];
} {
  const requests: DynamicWorkflowSnippetEvalRequest[] = [];
  return {
    requests,
    port: {
      async evalSnippet(request) {
        requests.push(request);
        return result;
      },
    },
  };
}

function makeContext(port?: DynamicWorkflowSnippetPort): ToolExecutionContext {
  return {
    ...(port === undefined ? {} : { dynamicWorkflowSnippetPort: port }),
    workingDirectory: "/tmp/snippet-test",
    traceId: "trace-1",
    sessionId: "sess_test",
  } as unknown as ToolExecutionContext;
}

async function run(input: unknown, context: ToolExecutionContext): Promise<EvalWorkflowSnippetOutput> {
  return (await evalWorkflowSnippetToolEntry.handler(input, context)) as EvalWorkflowSnippetOutput;
}

describe("EvalWorkflowSnippet tool", () => {
  it("is registered by default via registerBuiltInTools", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry);
    expect(registry.has("EvalWorkflowSnippet")).toBe(true);
  });

  it("fails honestly when the port is absent (nothing pretends to execute)", async () => {
    const output = await run({ code: "return 1;" }, makeContext());
    expect(output.ok).toBe(false);
    expect(output.response).toContain("NOT executed");
    expect(output.response).toContain("not available");
  });

  it("passes code, session cwd and the default 60s timeout to the port", async () => {
    const { port, requests } = stubPort({ kind: "completed", logs: [], logsTruncated: false });
    await run({ code: "return 1;" }, makeContext(port));
    expect(requests).toHaveLength(1);
    expect(requests[0]?.code).toBe("return 1;");
    expect(requests[0]?.cwd).toBe("/tmp/snippet-test");
    expect(requests[0]?.timeoutMs).toBe(60_000);
  });

  it("honours an explicit timeoutMs within schema bounds", async () => {
    const { port, requests } = stubPort({ kind: "completed", logs: [], logsTruncated: false });
    await run({ code: "return 1;", timeoutMs: 600_000 }, makeContext(port));
    expect(requests[0]?.timeoutMs).toBe(600_000);
  });

  it("rejects timeoutMs beyond the 600s schema ceiling", async () => {
    const { port } = stubPort({ kind: "completed", logs: [], logsTruncated: false });
    await expect(run({ code: "return 1;", timeoutMs: 900_000 }, makeContext(port))).rejects.toThrow();
  });

  it("renders diagnostics with the NOT-executed note", async () => {
    const { port } = stubPort({
      kind: "diagnostics",
      diagnostics: [{ code: 2304, column: 14, line: 1, message: "Cannot find name 'agent'." }],
    });
    const output = await run({ code: `await agent("x")` }, makeContext(port));
    expect(output.ok).toBe(false);
    expect(output.diagnostics).toHaveLength(1);
    expect(output.response).toContain("L1:C14 Cannot find name 'agent'.");
    expect(output.response).toContain("NOT executed");
  });

  it("renders the artifact and logs on success", async () => {
    const { port } = stubPort({
      kind: "completed",
      artifact: { files: ["a.ts"], count: 1 },
      logs: ["saw 1"],
      logsTruncated: false,
    });
    const output = await run({ code: "return x;" }, makeContext(port));
    expect(output.ok).toBe(true);
    expect(output.response).toContain("Return value:");
    expect(output.response).toContain('"a.ts"');
    expect(output.response).toContain("- saw 1");
    expect(output.logs).toEqual(["saw 1"]);
  });

  it("says so when the snippet returned no value", async () => {
    const { port } = stubPort({ kind: "completed", logs: [], logsTruncated: false });
    const output = await run({ code: 'log("hi");' }, makeContext(port));
    expect(output.ok).toBe(true);
    expect(output.response).toContain("returned no value");
  });

  it("renders structured failures with the stable code, keeping logs", async () => {
    const { port } = stubPort({
      kind: "failed",
      error: { code: "WorldReadCapExceeded", message: "files.grep over cap" },
      logs: ["before the failure"],
      logsTruncated: true,
    });
    const output = await run({ code: "…" }, makeContext(port));
    expect(output.ok).toBe(false);
    expect(output.response).toContain("(WorldReadCapExceeded)");
    expect(output.response).toContain("- before the failure");
    expect(output.response).toContain("logs truncated");
  });
});

// docs/dynamic-workflow/launch.md「Script files」→「The `path` source」：片段的第二条来源。
// 整个文件就是代码（不解析元数据块），诊断按文件行报。
describe("EvalWorkflowSnippet — the `path` source", () => {
  const validate = (input: unknown) => evalWorkflowSnippetToolEntry.validateInput!(input, {});
  const resolve = async (input: unknown, cwd: string) =>
    await evalWorkflowSnippetToolEntry.resolveInput!(input, { workingDirectory: cwd });

  it("refuses a call giving both sources, and one giving neither", () => {
    expect(validate({ code: "return 1;", path: "a.ts" })).toMatchObject({ result: false });
    expect(validate({})).toMatchObject({ result: false });
    expect(validate({ code: "return 1;" })).toEqual({ result: true });
    expect(validate({ path: "a.ts" })).toEqual({ result: true });
  });

  it("reads the file whole as `code`, metadata block included", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dwf-snippet-path-"));
    try {
      // 恰好以起始标记开头的文件也整个是代码：片段没有保存定义那套语义。
      const source = '/* zcode-workflow\ndescription: not a workflow\n*/\nreturn 1;';
      writeFileSync(join(cwd, "snippet.ts"), source, "utf8");
      const resolution = await resolve({ path: "snippet.ts" }, cwd);
      expect(resolution).toMatchObject({ result: true });
      const input = (resolution as { input: Record<string, unknown> }).input;
      expect(input.code).toBe(source);
      expect(input.path).toBe(join(cwd, "snippet.ts"));
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("names the file when it cannot be read", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dwf-snippet-path-"));
    try {
      const resolution = await resolve({ path: "missing.ts" }, cwd);
      expect(resolution).toMatchObject({ result: false });
      expect((resolution as { message: string }).message).toContain("missing.ts could not be read");
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });

  it("prefixes diagnostics with the file when the snippet came from one", async () => {
    const { port } = stubPort({
      kind: "diagnostics",
      diagnostics: [{ code: 2304, column: 14, line: 1, message: "Cannot find name 'agent'." }],
    });
    const context = makeContext(port);
    const output = await run(
      { code: `await agent("x")`, path: join(context.workingDirectory, "snippet.ts") },
      context,
    );
    expect(output.response).toContain("snippet.ts:L1:C14 Cannot find name 'agent'.");
  });
});

describe("EvalWorkflowSnippet approval gate (world.run)", () => {
  const gate = (input: unknown) => evalWorkflowSnippetToolEntry.prepareApproval!(input);

  it("proceeds silently for a pure read snippet", () => {
    expect(gate({ code: `return await files.glob("*.ts");` })).toEqual({ gate: "proceed" });
  });

  it("asks when the snippet carries world.run commands", () => {
    expect(gate({ code: `const r = await world.run("lean", ["a.lean"]); return r.exitCode;` })).toEqual({
      gate: "ask",
    });
  });

  it("proceeds for invalid input and for snippets that do not compile", () => {
    // handler / 端口负责把这两种失败变成可读的诊断；打断用户批准一段编不过的代码没有意义。
    expect(gate({ notCode: true })).toEqual({ gate: "proceed" });
    expect(gate({ code: `await agent("x").ask("y");` })).toEqual({ gate: "proceed" });
    expect(gate({ code: `const c = "node"; await world.run(c, []);` })).toEqual({ gate: "proceed" });
  });

  it("stays a standard-permission tool: no alwaysAsk, no always-allow suppression", () => {
    // 2026-08-26 复议（docs/dynamic-workflow/authoring.md「EvalWorkflowSnippet」）：alwaysAsk 只属于
    // CreateWorkflow——load-bearing 且昂贵。snippet 按标准模式 / 规则流程裁决。
    expect(evalWorkflowSnippetToolEntry.permission.alwaysAsk).toBeUndefined();
    expect(evalWorkflowSnippetToolEntry.permission.askOptions).toBeUndefined();
  });
});
