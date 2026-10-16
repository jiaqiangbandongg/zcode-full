// node --expose-gc bash-output-benchmark.cjs <adapter.cjs> <concurrency:1|4> [bash|cmd] [expectedArtifactBytes:default=256MiB]
// 每次调用使用独立父 Node；旧/新 bundle 使用同一脚本、Node、机器与请求参数。
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { NodeExecutionAdapter } = require(resolve(process.argv[2]));
const concurrency = Number(process.argv[3] || 1);
assert([1, 4].includes(concurrency));
const bytes = 256 * 1024 ** 2;
// 旧 collector bundle 对照传 67108864；新直写实现应保留全部输出。
const artifactLimit = 64 * 1024 ** 2;
const expectedArtifactBytes = Number(process.argv[5] || bytes);
const windows = process.platform === "win32";
const cmd = windows && process.argv[4] === "cmd";
const shell = {
  dialect: cmd ? "cmd" : windows ? "git-bash" : "posix",
  path: cmd ? process.env.ComSpec : windows ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash",
  display: { name: cmd ? "CMD" : "bash" },
  source: "user-config",
};

async function main() {
  const root = await fs.mkdtemp(join(tmpdir(), "zcode-bash-bench-"));
  const writer = join(root, "writer.cjs");
  await fs.writeFile(
    writer,
    `const fs=require('node:fs'),b=Buffer.alloc(65536,120);for(let i=0;i<${bytes / 65536};i++){let p=0;while(p<b.length)p+=fs.writeSync(i%2+1,b,p,b.length-p);}`,
  );
  const adapter = new NodeExecutionAdapter({
    outputRootDir: root,
    processEnv: { ...process.env, HOME: root },
  });
  const request = {
    command: {
      mode: "shell",
      shellProfile: "posix-bash",
      shellOverride: shell,
      command: cmd ? '"%BENCH_NODE%" "%BENCH_WRITER%"' : '"$BENCH_NODE" "$BENCH_WRITER"',
    },
    cwd: root,
    timeoutMs: 120_000,
    env: { set: { BENCH_NODE: process.execPath, BENCH_WRITER: writer } },
    outputLimit: {
      maxInlineBytes: 30_000,
      maxPersistedBytes: 5 * 1024 ** 3,
      maxArtifactBytes: artifactLimit,
      persistOutput: "on_truncate",
    },
  };
  try {
    await adapter.run({
      ...request,
      command: { ...request.command, command: cmd ? "echo warm" : "printf warm" },
    });
    global.gc?.();
    const baseline = process.memoryUsage();
    const peak = { ...baseline };
    const sample = () => {
      const usage = process.memoryUsage();
      for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], usage[key]);
    };
    const cpuStart = process.cpuUsage();
    const started = performance.now();
    const timer = setInterval(sample, 5);
    let results;
    try {
      results = await Promise.all(
        Array.from({ length: concurrency }, () =>
          adapter.runBashWithBackgroundLifecycle(
            { ...request },
            { mode: "auto_on_timeout" },
            { onEvent: () => undefined },
          ),
        ),
      );
    } finally {
      sample();
      clearInterval(timer);
    }
    const elapsedMs = performance.now() - started;
    const cpu = process.cpuUsage(cpuStart);
    for (const outcome of results) {
      assert.equal(outcome.kind, "foreground");
      const result = outcome.result;
      assert.equal(result.status, "completed");
      assert.equal(result.stdout.bytes, bytes);
      assert.equal(result.stdout.text, "x".repeat(30_000));
      assert.equal((await fs.stat(result.stdout.artifactPath)).size, expectedArtifactBytes);
    }
    console.log(
      JSON.stringify({
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        concurrency,
        bytesPerCommand: bytes,
        expectedArtifactBytes,
        elapsedMs,
        cpuUserMs: cpu.user / 1000,
        cpuSystemMs: cpu.system / 1000,
        baseline,
        peak,
        delta: Object.fromEntries(Object.keys(peak).map((key) => [key, peak[key] - baseline[key]])),
        maxRssKiB: process.resourceUsage().maxRSS,
      }),
    );
  } finally {
    await adapter.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
const keepAlive = setInterval(() => {}, 1_000);
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => clearInterval(keepAlive));
