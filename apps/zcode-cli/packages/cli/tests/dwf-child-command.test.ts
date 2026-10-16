/**
 * 隐藏子命令 `__zcode-dwf-child` 的分派与执行。
 *
 * Bug 根因（docs/dynamic-workflow/launch.md「Single-executable builds」）：SEA 单文件二进制不解释 Node
 * CLI 旗标，harness 缺省的 `node --max-old-space-size=… <entry>` 在 SEA 下会把旗标交给严格
 * parseArgs，子进程立刻报错退出——SEA 下每一个 dwf run 必然失败。修法与 official plugin host
 * 同款：自 re-exec 本二进制 + 在 parseArgs **之前**分派。
 *
 * 2026-09-09 追记之后 argv 末位是入口文件路径（payload 不再过命令行）。两件事必须钉住：
 *   1. 分派发生在 parseArgs 之前——任何进了 parseArgs 的形态都会把路径当未知参数报错；
 *   2. 子进程真的跑起来：子命令 `import()` 入口文件、注入真实 vm/readline/stdio 调它的 `start`，
 *      把 NDJSON 写回 stdout。入口文件由 harness 同一个 `renderChildEntry` 渲染，与生产同形。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { ZCODE_DWF_CHILD_COMMAND } from "@zcode/contracts";
import { renderChildEntry } from "@zcode/dynamic-workflow-runtime";
import type { RunContext } from "@zcode/shared-types";
import { isDwfChildInvocation } from "../src/dwf-child-command.js";
import { run } from "../src/run.js";

const createCapturedStdout = () => {
  let output = "";
  return {
    output: () => output,
    stream: {
      isTTY: false,
      write: (chunk: string | Uint8Array): boolean => {
        output += typeof chunk === "string" ? chunk : chunk.toString();
        return true;
      },
    } as unknown as NodeJS.WriteStream,
  };
};

/**
 * 子进程语境的 RunContext：stdin 必须是**真** Readable（childMain 拿它建 readline，
 * cli.unit.test.ts 里那个 `{ isTTY: false }` 假 stdin 会直接让 readline 抛错）。
 * 这里给一条立即 EOF 的空流：本用例的脚本不发 ask，父进程也就没有 response 要喂。
 */
const createChildContext = (
  argv: string[],
): { ctx: RunContext; stdout: () => string; stderr: () => string } => {
  const stdout = createCapturedStdout();
  const stderr = createCapturedStdout();
  return {
    ctx: {
      argv,
      stderr: stderr.stream,
      stdin: Readable.from([]) as unknown as NodeJS.ReadStream,
      stdout: stdout.stream,
    },
    stdout: stdout.output,
    stderr: stderr.output,
  };
};

/**
 * 用生产同一个渲染器写一份入口文件。刻意**不**经引擎/编译器：这里被测的是 CLI 边界的契约
 * （argv 末位的路径 + 入口文件的 `start` 导出），不是 workflow 的编译管线。
 * 不带 `maxOldSpaceSizeMb`：入口文件在 `execArgv` 缺旗标时会对**本进程** best-effort 设堆上限，
 * 测试进程不该被它改。
 */
const writeEntry = async (lowered: string): Promise<{ path: string; dispose: () => Promise<void> }> => {
  const root = await mkdtemp(join(tmpdir(), "dwf-child-cmd-"));
  const path = join(root, "run.mjs");
  await writeFile(path, renderChildEntry({ lowered }, { runId: "run" }), "utf8");
  return { path, dispose: () => rm(root, { force: true, recursive: true }) };
};

test("recognises the dwf child subcommand only as argv[0]", () => {
  assert.equal(isDwfChildInvocation([ZCODE_DWF_CHILD_COMMAND, "/tmp/run.mjs"]), true);
  assert.equal(isDwfChildInvocation([ZCODE_DWF_CHILD_COMMAND]), true);
  assert.equal(isDwfChildInvocation([]), false);
  assert.equal(isDwfChildInvocation(["--help"]), false);
  // 出现在别处不算：否则一个普通 prompt 里提到这个词就能改变 CLI 的行为。
  assert.equal(isDwfChildInvocation(["-p", ZCODE_DWF_CHILD_COMMAND]), false);
});

test("runs the sandbox child from the entry file and writes the NDJSON completion to stdout", async () => {
  const entry = await writeEntry('__host.log("from the sandbox");\nreturn { ok: 42 };');
  try {
    const { ctx, stdout, stderr } = createChildContext([ZCODE_DWF_CHILD_COMMAND, entry.path]);

    const exitCode = await run(ctx);

    assert.equal(exitCode, 0);
    assert.equal(stderr(), "");
    const lines = stdout()
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    assert.deepEqual(lines, [
      { kind: "event", type: "log", message: "from the sandbox" },
      { kind: "complete", ok: true, value: { ok: 42 } },
    ]);
  } finally {
    await entry.dispose();
  }
});

test("reports a lowered-body syntax error as an error completion, not a crash", async () => {
  const entry = await writeEntry("this is not javascript(");
  try {
    const { ctx, stdout, stderr } = createChildContext([ZCODE_DWF_CHILD_COMMAND, entry.path]);

    const exitCode = await run(ctx);

    assert.equal(exitCode, 0);
    assert.equal(stderr(), "");
    const message = JSON.parse(stdout().trim());
    assert.equal(message.kind, "complete");
    assert.equal(message.ok, false);
    assert.equal(message.error.name, "SyntaxError");
  } finally {
    await entry.dispose();
  }
});

test("fails with usage when the entry path argument is missing", async () => {
  const { ctx, stdout, stderr } = createChildContext([ZCODE_DWF_CHILD_COMMAND]);

  const exitCode = await run(ctx);

  assert.equal(exitCode, 1);
  // stdout 是父进程的 NDJSON 通道，接线错误只许走 stderr。
  assert.equal(stdout(), "");
  assert.match(stderr(), new RegExp(`Usage: ${ZCODE_DWF_CHILD_COMMAND}`));
});

test("fails on stderr when the entry file does not exist", async () => {
  const { ctx, stdout, stderr } = createChildContext([
    ZCODE_DWF_CHILD_COMMAND,
    join(tmpdir(), "dwf-child-cmd-missing", "nope.mjs"),
  ]);

  const exitCode = await run(ctx);

  assert.equal(exitCode, 1);
  assert.equal(stdout(), "");
  assert.match(stderr(), /Workflow child failed: /);
});
