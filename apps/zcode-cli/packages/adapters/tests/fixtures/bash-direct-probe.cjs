// 实际 adapter 的跨平台验证：node bash-direct-probe.cjs <bundled-adapter.cjs> [report.json]
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { tmpdir } = require("node:os");
const { setTimeout: sleep } = require("node:timers/promises");
const { createHash } = require("node:crypto");
const { NodeExecutionAdapter } = require(resolve(process.argv[2]));
const report = { node: process.version, platform: process.platform, arch: process.arch, cases: [] };
const shells =
  process.platform === "win32"
    ? [
        { name: "Git Bash", path: "C:\\Program Files\\Git\\bin\\bash.exe", dialect: "git-bash" },
        {
          name: "CMD",
          path: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
          dialect: "cmd",
        },
      ]
    : [{ name: "bash", path: "/bin/bash", dialect: "posix" }];
const hash = (data) => createHash("sha256").update(data).digest("hex");

async function waitFor(check) {
  const deadline = Date.now() + 15_000;
  let error;
  do {
    try {
      await check();
      return;
    } catch (failure) {
      error = failure;
    }
    await sleep(20);
  } while (Date.now() < deadline);
  throw error;
}

async function probe(shell, name, execute) {
  const root = await fs.mkdtemp(join(tmpdir(), "zcode-adapter-probe-"));
  const cwd = join(root, "输出 with spaces");
  await fs.mkdir(cwd);
  const writer = join(cwd, "writer.cjs");
  const release = join(cwd, "release");
  const path = join(root, "probe", "output-stdout.log");
  const adapter = new NodeExecutionAdapter({
    outputRootDir: root,
    progressThresholdMs: 0,
    progressIntervalMs: 25,
  });
  const request = {
    command: {
      mode: "shell",
      shellProfile: "posix-bash",
      shellOverride: {
        path: shell.path,
        dialect: shell.dialect,
        display: { name: shell.name },
        source: "user-config",
      },
      command:
        shell.dialect === "cmd"
          ? '"%PROBE_NODE%" "%PROBE_WRITER%"'
          : '"$PROBE_NODE" "$PROBE_WRITER"',
    },
    cwd,
    timeoutMs: 15_000,
    env: { set: { PROBE_NODE: process.execPath, PROBE_WRITER: writer, PROBE_RELEASE: release } },
    outputLimit: {
      maxInlineBytes: 30_000,
      maxArtifactBytes: 64 * 1024 ** 2,
      persistOutput: "always",
    },
    trace: { sessionId: "probe", attributes: { toolCallId: "output" } },
  };
  const started = Date.now();
  try {
    const details = await execute({ adapter, request, writer, release, path, cwd });
    report.cases.push({
      shell: shell.name,
      name,
      pass: true,
      elapsedMs: Date.now() - started,
      ...details,
    });
    console.log(JSON.stringify(report.cases.at(-1)));
  } finally {
    await fs.writeFile(release, "go").catch(() => undefined);
    await adapter.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const gate = `const fs=require('node:fs');fs.writeSync(1,'regular:'+fs.fstatSync(1).isFile()+':'+fs.fstatSync(2).isFile()+'\\n');
fs.writeSync(2,'stderr-first\\n');const t=setInterval(()=>{if(fs.existsSync(process.env.PROBE_RELEASE)){clearInterval(t);fs.writeSync(1,'last-no-newline');}},10);`;

async function main() {
  for (const shell of shells) {
    await probe(
      shell,
      "complete-foreground-file-over-64MiB",
      async ({ adapter, request, writer, path }) => {
        await fs.writeFile(
          writer,
          `const fs=require('node:fs');fs.writeSync(1,'HEAD');const chunk=Buffer.alloc(1024*1024,120);for(let i=0;i<65;i++)fs.writeSync(1,chunk);fs.writeSync(2,'TAIL');`,
        );
        const outcome = await adapter.runBashWithBackgroundLifecycle(request, {
          mode: "auto_on_timeout",
        });
        assert.equal(outcome.kind, "foreground");
        const output = outcome.result.stdout;
        const expected = 65 * 1024 ** 2 + 8;
        assert.equal(output.bytes, expected);
        assert.equal(output.artifactBytes, expected);
        assert.equal(output.artifactTruncated, false);
        assert.equal(output.text.length, 30_000);
        assert(output.text.startsWith("HEAD"));
        const file = await fs.open(path, "r");
        try {
          assert.equal((await file.stat()).size, expected);
          const tail = Buffer.alloc(4);
          await file.read(tail, 0, 4, expected - 4);
          assert.equal(tail.toString(), "TAIL");
        } finally {
          await file.close();
        }
        return { fileBytes: expected, summaryBytes: output.text.length, tail: "TAIL" };
      },
    );
    await probe(
      shell,
      "two-preview-sizes-before-exit",
      async ({ adapter, request, writer, path, release }) => {
        await fs.writeFile(
          writer,
          `const fs=require('node:fs');for(let i=1;i<=120;i++)fs.writeSync(1,'progress-line-'+i+'\\n');const timer=setInterval(()=>{if(fs.existsSync(process.env.PROBE_RELEASE)){clearInterval(timer);fs.writeSync(1,'DONE');}},10);`,
        );
        const events = [];
        const running = adapter.run(request, { onEvent: (event) => events.push(event) });
        await waitFor(() => {
          const preview = events.findLast((event) => event.outputPreview)?.outputPreview;
          assert(preview);
          assert(preview.text.includes("progress-line-120"));
          assert(!preview.text.includes("progress-line-30"));
          assert(preview.fullText.includes("progress-line-30"));
          assert.equal(preview.totalLines, 121);
          assert.equal(preview.linesEstimated, false);
        });
        assert(!events.some((event) => event.type === "completed"));
        assert((await fs.stat(path)).size > 0);
        await fs.writeFile(release, "go");
        const result = await running;
        assert.equal(result.status, "completed");
        assert(result.stdout.text.endsWith("DONE"));
        return { preview: events.findLast((event) => event.outputPreview).outputPreview };
      },
    );
    await probe(
      shell,
      "foreground-real-time",
      async ({ adapter, request, writer, release, path }) => {
        await fs.writeFile(writer, gate);
        const prefix =
          shell.dialect === "cmd"
            ? "echo builtin-out&echo builtin-err 1>&2&"
            : "printf builtin-out; printf builtin-err >&2; /usr/bin/printf external-out; ";
        request.command.command = prefix + request.command.command;
        const events = [];
        const running = adapter.run(request, { onEvent: (event) => events.push(event) });
        await waitFor(async () =>
          assert.match(await fs.readFile(path, "utf8"), /regular:true:true\nstderr-first\n$/),
        );
        await waitFor(() =>
          assert(
            events.some(
              (event) => event.type === "progress" && event.stdoutTail.includes("stderr-first"),
            ),
          ),
        );
        assert(!events.some((event) => ["completed", "stdout", "stderr"].includes(event.type)));
        const before = await fs.readFile(path);
        await fs.writeFile(release, "go");
        const result = await running;
        assert.equal(result.status, "completed");
        assert.equal(result.stdout.text, before.toString() + "last-no-newline");
        return { bytesBeforeExit: before.length, finalBytes: result.stdout.bytes };
      },
    );

    for (const mode of ["explicit", "auto_on_timeout"]) {
      await probe(shell, mode, async ({ adapter, request, writer, release, path }) => {
        await fs.writeFile(writer, gate);
        request.timeoutMs = 30;
        const abort = new AbortController();
        const launch = await adapter.runBashWithBackgroundLifecycle(
          request,
          { mode },
          { signal: abort.signal },
        );
        assert.equal(launch.kind, "backgrounded");
        assert.equal(launch.task.outputPath, path);
        await waitFor(async () => assert.match(await fs.readFile(path, "utf8"), /stderr-first/));
        abort.abort();
        await sleep(60);
        assert.equal((await adapter.getBackgroundTask(launch.task.taskId)).status, "running");
        await fs.writeFile(release, "go");
        const done = await adapter.waitForBackgroundTask(launch.task.taskId);
        assert.equal(done.status, "completed");
        assert.equal(done.result.stdout.text, "regular:true:true\nstderr-first\nlast-no-newline");
      });
    }

    await probe(shell, "late-descendant", async ({ adapter, request, writer, release, path }) => {
      const descendant = `const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync(process.env.PROBE_RELEASE)){clearInterval(t);fs.writeSync(1,'late-out\\n');fs.writeSync(2,'late-err\\n');}},10);`;
      await fs.writeFile(
        writer,
        `const fs=require('node:fs');fs.writeSync(1,'root\\n');require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2],detached:true}).unref();`,
      );
      const launch = await adapter.runBashWithBackgroundLifecycle(request, { mode: "explicit" });
      assert.equal(launch.kind, "backgrounded");
      const done = await adapter.waitForBackgroundTask(launch.task.taskId);
      assert.equal(done.result.stdout.text, "root\n");
      await fs.writeFile(release, "go");
      await waitFor(async () =>
        assert.equal(await fs.readFile(path, "utf8"), "root\nlate-out\nlate-err\n"),
      );
      assert.deepEqual((await adapter.getBackgroundTask(launch.task.taskId)).result, done.result);
      await sleep(100);
      return { bytesAtExit: 5, bytesAfterDescendant: 23 };
    });

    await probe(shell, "binary-integrity", async ({ adapter, request, writer, path }) => {
      await fs.writeFile(
        writer,
        `const fs=require('node:fs');const b=Buffer.alloc(65549);for(let i=0;i<64;i++){for(let j=0;j<b.length;j++)b[j]=(i+j)%256;let p=0;while(p<b.length)p+=fs.writeSync(i%2+1,b,p,b.length-p);}`,
      );
      const result = await adapter.run(request);
      assert.equal(result.status, "completed");
      const actual = await fs.readFile(path);
      const expected = Buffer.alloc(64 * 65549);
      for (let i = 0; i < 64; i++)
        for (let j = 0; j < 65549; j++) expected[i * 65549 + j] = (i + j) % 256;
      assert.deepEqual(actual, expected);
      return { bytes: actual.length, sha256: hash(actual) };
    });

    await probe(shell, "concurrent-writers", async ({ adapter, request, writer, path }) => {
      const child = `const fs=require('node:fs'),id=process.argv[1];for(let i=0;i<256;i++){const b=Buffer.from((id+':'+i).padEnd(1023,'.')+'\\n');let p=0;while(p<b.length)p+=fs.writeSync(i%2+1,b,p,b.length-p);}`;
      await fs.writeFile(
        writer,
        `const {spawn}=require('node:child_process');for(let i=0;i<4;i++)spawn(process.execPath,['-e',${JSON.stringify(child)},String(i)],{stdio:['ignore',1,2]});`,
      );
      assert.equal((await adapter.run(request)).status, "completed");
      const actual = await fs.readFile(path);
      assert.equal(actual.length, 4 * 256 * 1024);
      const records = actual.toString().trimEnd().split("\n");
      assert.equal(new Set(records).size, 1024);
      for (const line of records) assert.match(line, /^[0-3]:\d+\.+$/);
      return { bytes: actual.length, records: records.length };
    });

    await probe(shell, "existing-file-flags", async ({ adapter, request, writer, path }) => {
      await fs.mkdir(join(path, ".."), { recursive: true });
      await fs.writeFile(path, "existing:");
      await fs.writeFile(writer, "require('node:fs').writeSync(1,'new')");
      const result = await adapter.run(request);
      assert.equal(result.stdout.text, process.platform === "win32" ? "new" : "existing:new");
    });

    await probe(shell, "background-stop", async ({ adapter, request, writer, path }) => {
      await fs.writeFile(writer, gate);
      const launch = await adapter.runBashWithBackgroundLifecycle(request, { mode: "explicit" });
      assert.equal(launch.kind, "backgrounded");
      await waitFor(async () => assert.match(await fs.readFile(path, "utf8"), /stderr-first/));
      await adapter.cancelBackgroundTask(launch.task.taskId);
      await waitFor(async () =>
        assert.equal((await adapter.getBackgroundTask(launch.task.taskId)).result?.exitCode, 137),
      );
      const result = await adapter.waitForBackgroundTask(launch.task.taskId);
      assert.equal(result.status, "cancelled");
      assert.equal(result.result.exitCode, 137);
    });
  }
  if (process.argv[3]) await fs.writeFile(process.argv[3], JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ complete: true, node: report.node, passed: report.cases.length }));
}
// adapter 的后台 watchdog/杀树计时器不会保活应用；独立验证脚本需要等待完整报告写出。
const keepAlive = setInterval(() => {}, 1_000);
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => clearInterval(keepAlive));
