import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTask, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { RunContext } from "@zcode/shared-types";
import { run, type RunDependencies } from "../src/run.js";
import type { CliShutdownProcess } from "../src/shutdown.js";

function harness(argv: string[], enabled = true) {
  const calls: string[] = [];
  const drainStarted = Promise.withResolvers<void>();
  const drainComplete = Promise.withResolvers<void>();
  const signalProcess = Object.assign(new EventEmitter(), { platform: "linux" as const });
  let stdout = "";
  let stderr = "";
  const ctx: RunContext = {
    argv,
    stdin: { isTTY: false } as NodeJS.ReadStream,
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
        return true;
      },
    } as NodeJS.WriteStream,
  };
  const deps: RunDependencies = {
    skipUserConfig: true,
    loadDotenv: () => ({ keys: [], loaded: false }),
    startProcessProviderRegistryRuntime: async () =>
      ({
        runtime: { registryService: {} },
        dispose: () => calls.push("dispose"),
      }) as never,
    shutdownCleanupTimeoutMs: 10,
    shutdownProcess: signalProcess as CliShutdownProcess,
    exitProcess: (code) => {
      calls.push(`exit:${code}`);
    },
    mapSessionEvent: ((event: unknown) => event) as never,
    createZCodeApp: (options) => {
      calls.push(`extraction:${options?.runtimeConfig?.memory?.extractionEnabled}`);
      assert.equal(options?.runtimeConfig?.memory?.enabled, undefined);
      return {
        sessionId: "memory-bench-test",
        traceId: "memory-bench-trace",
        runtime: {
          isProjectMemoryEnabled: () => enabled,
          drainMemoryExtractions: async (timeoutMs: number | null) => {
            assert.equal(timeoutMs, null);
            calls.push("drain:start");
            drainStarted.resolve();
            await drainComplete.promise;
            calls.push("drain:end");
          },
        },
        submitPrompt: async (
          _prompt: unknown,
          options?: { onEvent?: (event: unknown) => void },
        ) => {
          calls.push("main");
          options?.onEvent?.({ type: "turn.completed" });
          return {
            response: "main answer",
            events: [],
            projection: { status: "idle", turnCount: 1, totalTokenCount: 0 },
          };
        },
        close: async () => {
          calls.push("close");
          drainComplete.resolve();
        },
      } as never;
    },
  };
  return {
    calls,
    ctx,
    deps,
    drainStarted,
    drainComplete,
    signalProcess,
    output: () => ({ stdout, stderr }),
  };
}

for (const format of ["text", "json", "stream-json"]) {
  test(
    `memory bench waits before final ${format} output and close, beyond cleanup timeout`,
    { timeout: 5000 },
    async () => {
      const h = harness([
        "-p",
        "remember this convention",
        "--memory-bench",
        "--output-format",
        format,
      ]);
      let finished = false;
      const running = run(h.ctx, h.deps).then((code) => {
        finished = true;
        return code;
      });
      try {
        await Promise.race([
          h.drainStarted.promise,
          running.then(() => assert.fail(h.output().stderr)),
        ]);
        await delay(25);
        assert.equal(finished, false);
        assert.deepEqual(h.calls, ["extraction:true", "main", "drain:start"]);
        assert.equal(
          h.output().stdout,
          format === "stream-json" ? '{"type":"turn.completed"}\n' : "",
        );
      } finally {
        h.drainComplete.resolve();
        await running;
      }
      assert.equal(await running, 0);
      assert.deepEqual(h.calls, [
        "extraction:true",
        "main",
        "drain:start",
        "drain:end",
        "close",
        "dispose",
      ]);
      assert.match(h.output().stdout, /main answer/);
    },
  );
}

test("normal headless prompt keeps Extraction disabled and does not drain", async () => {
  const h = harness(["-p", "remember this convention"]);
  assert.equal(await run(h.ctx, h.deps), 0);
  assert.deepEqual(h.calls, ["extraction:false", "main", "close", "dispose"]);
});

test("memory bench rejects disabled Memory before submitting the main prompt", async () => {
  const h = harness(["-p", "remember this convention", "--memory-bench"], false);
  assert.equal(await run(h.ctx, h.deps), 1);
  assert.match(h.output().stderr, /Memory.*enabled/i);
  assert.deepEqual(h.calls, ["extraction:true", "close", "dispose"]);
});

for (const argv of [
  [],
  ["tui"],
  ["app-server"],
  ["agent-server"],
  ["--target", "remember this convention"],
]) {
  test(`memory bench rejects unsupported invocation ${JSON.stringify(argv)}`, async () => {
    const h = harness([...argv, "--memory-bench"]);
    assert.equal(await run(h.ctx, h.deps), 1);
    assert.match(h.output().stderr, /--memory-bench.*--prompt/);
    assert.deepEqual(h.calls, []);
  });
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  test(
    `memory bench keeps ${signal} cancellation active while waiting`,
    { timeout: 5000 },
    async () => {
      const h = harness(["-p", "remember this convention", "--memory-bench"]);
      const running = run(h.ctx, h.deps);
      await Promise.race([
        h.drainStarted.promise,
        running.then(() => assert.fail(h.output().stderr)),
      ]);
      h.signalProcess.emit(signal);
      await running;
      await nextTask();
      assert.equal(h.calls.filter((call) => call === "close").length, 1);
      assert.ok(h.calls.includes(`exit:${code}`));
      assert.equal(h.output().stdout, "");
    },
  );
}
