import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionRequest, ExecutionShellSelection } from "@zcode/contracts";
import type { ZCodeToolExecResource } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { NodeExecutionAdapter } from "../src/exec/node-execution-adapter.js";

describe("Bash 执行适配器资源生命周期", () => {
  it("真实 Bash 退出保留输出和 exit code，资源耗时从 spawn 起算", async () => {
    const root = await mkdtemp(join(tmpdir(), "bash-resource-"));
    const onToolExecResource = vi.fn();
    const adapter = new NodeExecutionAdapter({ outputRootDir: root, onToolExecResource });
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const result = await adapter.run(
        {
          command: {
            mode: "shell",
            shellProfile: "posix-bash",
            shellOverride: shell,
            command: "echo telemetry-output && exit 7",
          },
          cwd: root,
        },
        {
          onEvent: (event) => {
            if (event.type === "started") now = 40000;
          },
        },
      );
      expect(result.stdout.text).toContain("telemetry-output");
      expect(result.exitCode).toBe(7);
      expect(onToolExecResource).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ durationMs: 40000, exitKind: "completed", toolName: "bash" }),
      );
    } finally {
      vi.restoreAllMocks();
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

const shell: ExecutionShellSelection =
  process.platform === "win32"
    ? {
        dialect: "cmd",
        path: process.env.ComSpec ?? "cmd.exe",
        display: { name: "CMD" },
        source: "user-config",
      }
    : { dialect: "posix", path: "/bin/bash", display: { name: "Bash" }, source: "user-config" };

async function gatedCommand(
  onToolExecResource: NonNullable<
    ConstructorParameters<typeof NodeExecutionAdapter>[0]
  >["onToolExecResource"],
) {
  const root = await mkdtemp(join(tmpdir(), "bash-resource-gated-"));
  const script = join(root, "command.cjs");
  const release = join(root, "release");
  await writeFile(
    script,
    `const fs = require('node:fs/promises');
process.stdout.write('ready\\n');
const timer = setInterval(async () => {
  try { await fs.access(process.env.PROBE_RELEASE); clearInterval(timer); }
  catch {}
}, 10);`,
  );
  const adapter = new NodeExecutionAdapter({ outputRootDir: root, onToolExecResource });
  const request: ExecutionRequest = {
    command: {
      mode: "shell",
      shellProfile: "posix-bash",
      shellOverride: shell,
      command: `"${process.execPath}" "${script}"`,
    },
    env: { set: { PROBE_RELEASE: release } },
    cwd: root,
    timeoutMs: 0,
  };
  return {
    adapter,
    request,
    release: () => writeFile(release, "done"),
    async close() {
      await writeFile(release, "done");
      await adapter.close();
      await rm(root, { force: true, recursive: true });
    },
  };
}

it.each(["timeout", "cancel", "output_limit", "signal"] as const)(
  "真实子进程退出分类：%s",
  async (kind) => {
    if (kind === "signal" && process.platform === "win32") return;
    const onToolExecResource = vi.fn();
    const fixture = await gatedCommand(onToolExecResource);
    const controller = new AbortController();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const result = await fixture.adapter.run(
        { ...fixture.request, timeoutMs: kind === "timeout" ? 100 : 0 },
        {
          signal: controller.signal,
          onEvent: (event) => {
            if (event.type !== "started") return;
            now = 40000;
            if (kind === "cancel" || kind === "output_limit")
              controller.abort(kind === "output_limit" ? kind : undefined);
            if (kind === "signal" && event.pid) process.kill(event.pid, "SIGTERM");
          },
        },
      );
      expect(result.status).toBe(
        kind === "timeout" ? "timed_out" : kind === "signal" ? "failed" : "cancelled",
      );
      expect(onToolExecResource).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          durationMs: 40000,
          exitKind: kind === "timeout" ? "timeout" : "killed",
        }),
      );
    } finally {
      vi.restoreAllMocks();
      await fixture.close();
    }
  },
);

it.each(["explicit", "auto_on_timeout"] as const)(
  "前后台沿用同一命令，移交不发完成通知：%s",
  async (mode) => {
    const onToolExecResource = vi.fn();
    const fixture = await gatedCommand(onToolExecResource);
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      const outcome = await fixture.adapter.runBashWithBackgroundLifecycle(
        { ...fixture.request, timeoutMs: 20 },
        { mode },
      );
      expect(outcome.kind).toBe("backgrounded");
      expect(onToolExecResource).not.toHaveBeenCalled();
      now = 40000;
      await fixture.release();
      if (outcome.kind !== "backgrounded") throw new Error("expected background task");
      const done = await fixture.adapter.waitForBackgroundTask(outcome.task.taskId);
      expect(done?.result?.stdout.text).toContain("ready");
      expect(onToolExecResource).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ durationMs: 40000, exitKind: "completed" }),
      );
    } finally {
      vi.restoreAllMocks();
      await fixture.close();
    }
  },
);

it("运行时烟测：真实慢命令经平台探针产生非零 RSS，通知失败不影响输出", async () => {
  const onToolExecResource = vi.fn((_sample: ZCodeToolExecResource) => {
    throw new Error("telemetry sink closed");
  });
  const fixture = await gatedCommand(onToolExecResource);
  try {
    const running = fixture.adapter.run(fixture.request, {
      onEvent: (event) => {
        if (event.type === "started") setTimeout(() => void fixture.release(), 16500);
      },
    });
    const result = await running;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.text).toContain("ready");
    expect(onToolExecResource).toHaveBeenCalledTimes(1);
    const sample = onToolExecResource.mock.calls[0]?.[0];
    expect(sample.durationMs).toBeGreaterThanOrEqual(15000);
    if (process.platform !== "win32") {
      expect(sample.treeRssKbPeak).toBeGreaterThan(0);
      expect(sample.sampleCount).toBe(1);
    }
  } finally {
    await fixture.close();
  }
}, 25000);
