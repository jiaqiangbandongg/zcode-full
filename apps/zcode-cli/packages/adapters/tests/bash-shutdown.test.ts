import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const execFileAsync = promisify(execFile);
const adapterSource = fileURLToPath(
  new URL("../src/exec/node-execution-adapter.ts", import.meta.url),
);

// 不能在 Vitest worker 内验证保活：框架的 IPC/定时器会掩盖 Node 在 close 尚未完成时退出。
const driverSource = `
import { NodeExecutionAdapter } from ${JSON.stringify(adapterSource)};
import { spawn } from 'node:child_process';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

async function main() {
  const mode = process.argv[2], root = process.argv[3];
  const ready = join(root, 'worker.pid');
  if (mode === 'worker') {
    process.on('SIGTERM', () => {});
    await writeFile(ready, String(process.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'root') {
    spawn(process.execPath, [process.argv[1], 'worker', root], { stdio: ['ignore', 1, 2] });
    process.stdout.write('root output');
    setInterval(() => {}, 1000);
    return;
  }
  const adapter = new NodeExecutionAdapter({ outputRootDir: root });
  const controller = new AbortController();
  const request = {
    command: {
      mode: 'shell', shellProfile: 'posix-bash',
      shellOverride: { path: '/bin/bash', dialect: 'posix', source: 'user-config', display: { name: 'bash' } },
      command: '"$TEST_NODE" "$TEST_DRIVER" root "$TEST_ROOT"',
    },
    cwd: root,
    timeoutMs: mode === 'timeout' ? 2000 : 10000,
    env: { set: { TEST_NODE: process.execPath, TEST_DRIVER: process.argv[1], TEST_ROOT: root } },
    outputLimit: { persistOutput: 'always', ...(mode === 'output_limit' ? { maxPersistedBytes: 1 } : {}) },
  };
  const options = { signal: controller.signal, onEvent: (event) => {
    if (event.type === 'started') console.log('ROOT_PID ' + event.pid);
  } };
  const pending = mode === 'background'
    ? adapter.runBashWithBackgroundLifecycle(request, { mode: 'explicit' }, options)
    : adapter.run(request, options);
  const background = mode === 'background' ? await pending : undefined;
  if (background) console.log('ROOT_PID ' + background.task.pid);
  const deadline = Date.now() + 5000;
  while (true) {
    try { await access(ready); break; } catch {}
    if (Date.now() >= deadline) throw new Error('Worker did not start');
    await sleep(20);
  }
  if (mode === 'abort') controller.abort();
  if (mode === 'background') await adapter.cancelBackgroundTask(background.task.taskId);
  // 后台 Stop 的 ACK 可早于最终 result；close 后再读取完整结算。
  if (mode === 'close' || mode === 'background') await adapter.close();
  const result = background
    ? (await adapter.waitForBackgroundTask(background.task.taskId)).result
    : await pending;
  console.log('RESULT ' + result.status);
  await adapter.close();
  console.log('CLOSE_FINISHED');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
`;

async function isRunning(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "stat=", "-p", String(pid)]);
    // Linux 容器的 init 可能延迟回收孤儿 zombie；已终止的进程不算仍在执行。
    return stdout.trim().length > 0 && !stdout.trim().startsWith("Z");
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32")("Bash shutdown in an isolated Node", () => {
  let directory: string;
  let driver: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "zcode-bash-shutdown-"));
    driver = join(directory, "driver.cjs");
    await build({
      stdin: { contents: driverSource, resolveDir: process.cwd() },
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: driver,
      logLevel: "silent",
    });
  });
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each(["abort", "close", "background", "timeout", "output_limit"])(
    "finishes cleanup before process exit after %s",
    async (mode) => {
      const root = join(directory, mode);
      await mkdir(root);
      const child = spawn(process.execPath, [driver, mode, root], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout!.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr!.on("data", (chunk) => {
        stderr += chunk;
      });
      const deadline = setTimeout(() => child.kill("SIGKILL"), 15000);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        expect(code, stderr).toBe(0);
        expect(stdout).toContain("CLOSE_FINISHED");
        expect(stdout).toContain(`RESULT ${mode === "timeout" ? "timed_out" : "cancelled"}`);
        const pid = Number(await readFile(join(root, "worker.pid"), "utf8"));
        await vi.waitFor(async () => expect(await isRunning(pid)).toBe(false));
      } finally {
        clearTimeout(deadline);
        child.kill("SIGKILL");
        const rootPid = Number(/ROOT_PID (\d+)/u.exec(stdout)?.[1]);
        if (rootPid > 1) {
          try {
            process.kill(-rootPid, "SIGKILL");
          } catch {
            /* 测试负责回收失败时留下的进程组。 */
          }
        }
      }
    },
    20000,
  );
});
