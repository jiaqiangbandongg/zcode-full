import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { RunContext } from "@zcode/shared-types";
import {
  resolveNativeSearchArgs,
  runEmbeddedSearchCli,
} from "../src/internal-search/embedded-search-cli.js";
import { run } from "../src/run.js";

const nativeSearchTest = process.platform === "win32" ? test.skip : test;

function createIo(cwd: string, stdin?: NodeJS.ReadableStream) {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      cwd,
      ...(stdin ? { stdin } : {}),
      stderr: {
        write: (chunk: string | Uint8Array) =>
          void (stderr += typeof chunk === "string" ? chunk : chunk.toString()),
      },
      stdout: {
        write: (chunk: string | Uint8Array) =>
          void (stdout += typeof chunk === "string" ? chunk : chunk.toString()),
      },
    },
    read() {
      return { stderr, stdout };
    },
  };
}

type CapturedWriteStream = NodeJS.WriteStream & {
  output: () => string;
};

function createWriteStream(): CapturedWriteStream {
  let output = "";
  return {
    output: () => output,
    write: (chunk: string | Uint8Array): boolean => {
      output += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    },
  } as CapturedWriteStream;
}

function createContext(argv: string[]): RunContext & {
  stderr: CapturedWriteStream;
  stdout: CapturedWriteStream;
} {
  const stdin = Readable.from([]) as NodeJS.ReadStream;
  stdin.isTTY = false;
  return {
    argv,
    stderr: createWriteStream(),
    stdin,
    stdout: createWriteStream(),
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-embedded-search-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "src", "ignored"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "const needle = true;\n");
  await writeFile(join(root, "src", "b.ts"), "const hay = false;\n");
  await writeFile(join(root, "src", "ignored", "c.ts"), "const needle = 'ignored';\n");
  await writeFile(join(root, ".git", "packed-refs"), "needle from vcs metadata\n");
  await writeFile(join(root, "README.md"), "Needle in docs\n");
  return root;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function writeIgnoringSigtermCommand(path: string, pidFile: string): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
  );
  await chmod(path, 0o755);
}

async function readPidFile(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(path, "utf8")).trim());
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // 子进程启动后才写 pid 文件；轮询能让测试稳定等待到真实 native child。
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for pid file: ${path}`);
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return;
    }
    await delay(20);
  }
  assert.fail(`Expected process ${pid} to exit`);
}

function runShell(
  command: string,
  cwd: string,
): Promise<{
  code: number | null;
  stderr: string;
  stdout: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
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
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stderr, stdout });
    });
  });
}

test("internal grep prepends default VCS excludes for normal searches", () => {
  assert.deepEqual(resolveNativeSearchArgs("grep", ["needle", "."]), [
    "-G",
    "-I",
    "--exclude-dir=.git",
    "--exclude-dir=.svn",
    "--exclude-dir=.hg",
    "--exclude-dir=.bzr",
    "--exclude-dir=.jj",
    "--exclude-dir=.sl",
    "needle",
    ".",
  ]);
});

test("internal grep leaves special arguments without defaults", () => {
  assert.deepEqual(resolveNativeSearchArgs("grep", ["--config", "grep.toml", "needle", "."]), [
    "--config",
    "grep.toml",
    "needle",
    ".",
  ]);
  assert.deepEqual(resolveNativeSearchArgs("grep", ["--format-open", "vim", "needle", "."]), [
    "--format-open",
    "vim",
    "needle",
    ".",
  ]);
  assert.deepEqual(resolveNativeSearchArgs("grep", ["---debug", "needle", "."]), [
    "---debug",
    "needle",
    ".",
  ]);
  assert.deepEqual(resolveNativeSearchArgs("grep", ["-@profile", "needle", "."]), [
    "-@profile",
    "needle",
    ".",
  ]);
});

test("internal grep bypasses null-data and z compatibility flags", () => {
  for (const args of [
    ["-z", "needle", "."],
    ["-Z", "needle", "."],
    ["-Rz", "needle", "."],
    ["-nZ", "needle", "."],
    ["--null", "needle", "."],
    ["--null-data", "needle", "."],
  ]) {
    assert.deepEqual(resolveNativeSearchArgs("grep", args), args);
  }
});

test("internal find keeps native arguments unchanged", () => {
  assert.deepEqual(resolveNativeSearchArgs("find", [".", "-type", "f"]), [".", "-type", "f"]);
});

nativeSearchTest("internal grep prints matching lines", async () => {
  const root = await fixture();
  const { io, read } = createIo(root);

  const exitCode = await runEmbeddedSearchCli(["grep", "needle", "src/a.ts"], io);

  assert.equal(exitCode, 0);
  assert.equal(read().stdout, "const needle = true;\n");
  assert.equal(read().stderr, "");
});

nativeSearchTest("internal grep passes through common native grep flags", async () => {
  const root = await fixture();
  const { io, read } = createIo(root);

  const exitCode = await runEmbeddedSearchCli(["grep", "-e", "needle", "src/a.ts"], io);

  assert.equal(exitCode, 0);
  assert.equal(read().stdout, "const needle = true;\n");
  assert.equal(read().stderr, "");
});

nativeSearchTest("internal grep supports -n and -i", async () => {
  const root = await fixture();
  const { io, read } = createIo(root);

  const exitCode = await runEmbeddedSearchCli(["grep", "-R", "-n", "-i", "needle", "."], io);

  assert.equal(exitCode, 0);
  assert.match(read().stdout, /^\.\/README\.md:1:Needle in docs$/m);
  assert.match(read().stdout, /^\.\/src\/a\.ts:1:const needle = true;$/m);
  assert.doesNotMatch(read().stdout, /\.\/\.git\/packed-refs/m);
});

nativeSearchTest("internal grep preserves stdin for pipeline-style commands", async () => {
  const root = await fixture();
  const stdin = Readable.from(["before\nneedle from stdin\nafter\n"]);
  const { io, read } = createIo(root, stdin);

  const exitCode = await runEmbeddedSearchCli(["grep", "needle"], io);

  assert.equal(exitCode, 0);
  assert.equal(read().stdout, "needle from stdin\n");
  assert.equal(read().stderr, "");
});

nativeSearchTest("internal grep exits quietly when downstream pipe closes early", async () => {
  const root = await fixture();
  const inputPath = join(root, "many.txt");
  await writeFile(inputPath, "needle\n".repeat(200_000));
  const cliMainPath = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const tsxLoaderPath = fileURLToPath(import.meta.resolve("tsx"));

  const result = await runShell(
    [
      // Bug 根因：硬编码 workspace 层的 tsx shim 会在 pnpm filtered install 下不存在；
      // 复用当前 Node 与相同 loader，测试才不依赖 node_modules 的物理铺设方式。
      shellQuote(process.execPath),
      "--import",
      shellQuote(tsxLoaderPath),
      shellQuote(cliMainPath),
      "__internal-search",
      "grep",
      "needle",
      shellQuote(inputPath),
      "|",
      "head",
      "-5",
    ].join(" "),
    root,
  );

  assert.equal(result.stdout, "needle\n".repeat(5));
  assert.equal(result.stderr, "");
  assert.equal(result.code, 0);
});

nativeSearchTest("internal grep abort signal force kills the native child", async () => {
  const root = await fixture();
  const binDir = await mkdtemp(join(tmpdir(), "zcode-embedded-search-bin-"));
  const pidFile = join(root, "fake-grep.pid");
  await writeIgnoringSigtermCommand(join(binDir, "grep"), pidFile);

  const previousPath = process.env.PATH;
  const stdin = new PassThrough();
  const controller = new AbortController();
  const { io } = createIo(root, stdin);
  process.env.PATH = previousPath ? `${binDir}${delimiter}${previousPath}` : binDir;

  try {
    const searchPromise = runEmbeddedSearchCli(["grep", "needle"], {
      ...io,
      signal: controller.signal,
    });
    const childPid = await readPidFile(pidFile);

    controller.abort();

    assert.equal(await searchPromise, 130);
    await waitForProcessExit(childPid);
  } finally {
    stdin.destroy();
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
  }
});

nativeSearchTest(
  "internal grep supports combined flags and separated include filters",
  async () => {
    const root = await fixture();
    const { io, read } = createIo(root);

    const exitCode = await runEmbeddedSearchCli(
      ["grep", "-Rni", "--include", "*.ts", "--exclude-dir", "ignored", "needle", "."],
      io,
    );

    assert.equal(exitCode, 0);
    assert.equal(read().stdout, "./src/a.ts:1:const needle = true;\n");
  },
);

nativeSearchTest("internal grep returns one for no matches", async () => {
  const root = await fixture();
  const { io, read } = createIo(root);

  const exitCode = await runEmbeddedSearchCli(["grep", "missing", "src/a.ts"], io);

  assert.equal(exitCode, 1);
  assert.equal(read().stdout, "");
});

test("internal search rejects unsupported commands", async () => {
  const root = await fixture();
  const { io, read } = createIo(root);

  const exitCode = await runEmbeddedSearchCli(["rg", "needle", "."], io);

  assert.equal(exitCode, 2);
  assert.equal(read().stdout, "");
  assert.equal(read().stderr, "unsupported embedded search command: rg\n");
});

nativeSearchTest("internal find supports name and type predicates", async () => {
  const root = await fixture();
  const { io, read } = createIo(root);

  const exitCode = await runEmbeddedSearchCli(["find", ".", "-type", "f", "-name", "*.ts"], io);

  assert.equal(exitCode, 0);
  assert.deepEqual(read().stdout.trim().split("\n").sort(), [
    "./src/a.ts",
    "./src/b.ts",
    "./src/ignored/c.ts",
  ]);
});

nativeSearchTest("internal find passes through common native find predicates", async () => {
  const root = await fixture();
  const { io, read } = createIo(root);

  const exitCode = await runEmbeddedSearchCli(
    ["find", ".", "-type", "f", "-name", "*.ts", "-print"],
    io,
  );

  assert.equal(exitCode, 0);
  assert.deepEqual(read().stdout.trim().split("\n").sort(), [
    "./src/a.ts",
    "./src/b.ts",
    "./src/ignored/c.ts",
  ]);
  assert.equal(read().stderr, "");
});

nativeSearchTest("internal find returns the native error for invalid predicates", async () => {
  const root = await fixture();
  const { io, read } = createIo(root);

  const exitCode = await runEmbeddedSearchCli(["find", ".", "-definitely-not-real"], io);

  assert.notEqual(exitCode, 0);
  assert.match(read().stderr, /definitely-not-real/);
});

nativeSearchTest("CLI dispatch runs internal search before global option parsing", async () => {
  const root = await fixture();
  const ctx = createContext(["__internal-search", "grep", "-n", "needle", "src/a.ts"]);

  const exitCode = await run(ctx, { cwd: () => root });

  assert.equal(exitCode, 0);
  assert.equal(ctx.stdout.output(), "1:const needle = true;\n");
  assert.equal(ctx.stderr.output(), "");
});
