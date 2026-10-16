import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { parseZCodeProcessDiagnostic } from "@zcode/shared/process-diagnostic";
import { isProtocolServerInvocation } from "../src/arguments.js";
import { interceptKnownRuntimeWarnings } from "../src/runtime-warnings.js";
import { installProtocolStderrBoundary } from "../src/protocol-stderr.js";
import {
  installCliProcessErrorBoundary,
  type CliProcessErrorBoundaryTarget,
} from "../src/process-errors.js";

type Listener = (...args: never[]) => void;

test("protocol stderr flush waits for the last diagnostic write callback", async () => {
  let release!: () => void;
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      if (chunk.length) release = callback;
      else callback();
    },
  });
  const restore = installProtocolStderrBoundary(stderr);
  const warnings = interceptKnownRuntimeWarnings(stderr as unknown as NodeJS.WriteStream);
  let flushed = false;
  try {
    stderr.write("last diagnostic");
    const flush = new Promise<void>((resolve) =>
      stderr.write("", () => {
        flushed = true;
        resolve();
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(flushed, false);
    release();
    await flush;
  } finally {
    warnings.restore();
    restore();
    stderr.destroy();
  }
});

test("protocol lifecycle follows the command, not an option value", () => {
  assert.equal(isProtocolServerInvocation(["--prompt", "app-server"]), false);
  assert.equal(isProtocolServerInvocation(["--cwd", "app-server", "doctor"]), false);
  assert.equal(isProtocolServerInvocation(["--target", "agent-server"]), false);
  assert.equal(isProtocolServerInvocation(["__zcode-plugin-host", "app-server"]), false);
  assert.equal(isProtocolServerInvocation(["app-server", "--help"]), false);
  assert.equal(isProtocolServerInvocation(["--cwd", "/tmp", "app-server", "--stdio"]), true);
  assert.equal(isProtocolServerInvocation(["agent-server", "--stdio"]), true);
});

class FakeProcess implements CliProcessErrorBoundaryTarget {
  private readonly listeners = new Map<string, Set<Listener>>();

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: never[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

function createStderr(): { output: () => string; write: (chunk: string) => boolean } {
  let value = "";
  return {
    output: () => value,
    write: (chunk: string) => {
      value += chunk;
      return true;
    },
  };
}

test("process error boundary observes uncaught exceptions without throwing", () => {
  const target = new FakeProcess();
  const stderr = createStderr();
  const dispose = installCliProcessErrorBoundary({ target, stderr, onFatal: () => {} });

  const error = new Error("uncaught boom");
  target.emit("uncaughtExceptionMonitor", error, "uncaughtException");
  target.emit("uncaughtException", error);

  assert.match(stderr.output(), /kind=uncaughtException/);
  assert.match(stderr.output(), /uncaught boom/);
  const events = stderr.output().split("\n").map(parseZCodeProcessDiagnostic).filter(Boolean);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.name, "Error");
  assert.equal(events[0]?.message, "uncaught boom");
  assert.equal(events[0]?.stack, error.stack);
  assert.equal(events[0]?.kind, "uncaughtException");
  assert.equal(target.listenerCount("uncaughtException"), 1);
  assert.equal(target.listenerCount("unhandledRejection"), 1);
  assert.equal(target.listenerCount("uncaughtExceptionMonitor"), 1);

  dispose();
  assert.equal(target.listenerCount("uncaughtException"), 0);
  assert.equal(target.listenerCount("unhandledRejection"), 0);
  assert.equal(target.listenerCount("uncaughtExceptionMonitor"), 0);
});

test("process error boundary observes non-Error promise rejection reasons", () => {
  const target = new FakeProcess();
  const stderr = createStderr();
  const dispose = installCliProcessErrorBoundary({ target, stderr, onFatal: () => {} });

  target.emit("unhandledRejection", "rejected value", Promise.resolve());

  assert.match(stderr.output(), /kind=unhandledRejection/);
  assert.match(stderr.output(), /rejected value/);
  const event = stderr.output().split("\n").map(parseZCodeProcessDiagnostic).find(Boolean);
  assert.equal(event?.kind, "unhandledRejection");
  assert.equal(event?.message, "rejected value");
  dispose();
});

test("fatal diagnostics are bounded and shutdown is requested only once", () => {
  const target = new FakeProcess();
  const stderr = createStderr();
  let fatalCount = 0;
  const dispose = installCliProcessErrorBoundary({
    target,
    stderr,
    onFatal: () => {
      fatalCount += 1;
    },
  });
  const error = new Error("x".repeat(20_000));
  target.emit("uncaughtExceptionMonitor", error, "uncaughtException");
  target.emit("uncaughtException", error);
  target.emit("uncaughtException", error);
  const events = stderr.output().split("\n").map(parseZCodeProcessDiagnostic).filter(Boolean);
  assert.equal(events.length, 1);
  assert.equal(fatalCount, 1);
  assert.equal(events[0]?.origin, "uncaughtException");
  assert.equal(events[0]?.message.length, 4000);
  assert.ok((events[0]?.stack?.length ?? 0) <= 16_000);
  dispose();
});

test("serialization and stderr failures cannot escape the exception boundary", () => {
  const target = new FakeProcess();
  const dispose = installCliProcessErrorBoundary({
    onFatal: () => {},
    target,
    stderr: {
      write() {
        throw new Error("closed pipe");
      },
    },
  });
  const hostile = {
    toJSON() {
      throw new Error("toJSON failed");
    },
    toString() {
      throw new Error("toString failed");
    },
  };
  assert.doesNotThrow(() => target.emit("unhandledRejection", hostile));
  assert.doesNotThrow(() => target.emit("uncaughtException", new Error("write failure")));
  dispose();
});

const fixture = fileURLToPath(new URL("./fixtures/protocol-lifecycle-child.ts", import.meta.url));

function startChild(mode = "serving", rejectionMode = "throw") {
  const child = spawn(
    process.execPath,
    [`--unhandled-rejections=${rejectionMode}`, "--import", "tsx", fixture, mode],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const stdout: string[] = [];
  const stderr: Buffer[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) stdout.push((JSON.parse(line) as { id: string }).id);
  });
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exited = once(child, "close");
  const waitFor = async (id: string) => {
    const deadline = Date.now() + 5_000;
    while (!stdout.includes(id)) {
      assert.ok(
        Date.now() < deadline && child.exitCode === null,
        `missing ${id}: ${Buffer.concat(stderr)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { child, stdout, stderr, exited, waitFor };
}

for (const rejectionMode of ["throw", "strict"]) {
  for (const command of ["throw", "reject"]) {
    test(
      `fatal ${command} reports once and exits (${rejectionMode})`,
      { timeout: 10_000 },
      async (t) => {
        const probe = startChild("serving", rejectionMode);
        t.after(() => probe.child.kill("SIGKILL"));
        await probe.waitFor("ready");
        probe.child.stdin.write(command + "\n");
        const [code, signal] = await probe.exited;
        assert.equal(code, 1);
        assert.equal(signal, null);
        const events = Buffer.concat(probe.stderr)
          .toString()
          .split("\n")
          .map(parseZCodeProcessDiagnostic)
          .filter(Boolean);
        assert.equal(events.length, 1);
        assert.equal(
          events[0]?.kind,
          command === "throw" ? "uncaughtException" : "unhandledRejection",
        );
      },
    );
  }
}

test(
  "real broken stderr does not recurse or terminate a healthy protocol",
  { timeout: 10_000 },
  async (t) => {
    const probe = startChild();
    t.after(() => probe.child.kill("SIGKILL"));
    await probe.waitFor("ready");
    probe.child.stderr.destroy();
    probe.child.stdin.write("log\n");
    await probe.waitFor("healthy");
    probe.child.stdin.write("ping\n");
    await probe.waitFor("pong");
    probe.child.stdin.end();
    const [code, signal] = await probe.exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
  },
);

for (const mode of ["startup-hung", "handler-hung", "serving"]) {
  test(
    `EOF bounds ${mode} even when the entrypoint never returns`,
    { timeout: 10_000 },
    async (t) => {
      const probe = startChild(mode);
      t.after(() => probe.child.kill("SIGKILL"));
      await probe.waitFor("ready");
      const started = Date.now();
      probe.child.stdin.end();
      const [code, signal] = await probe.exited;
      assert.equal(code, 0);
      assert.equal(signal, null);
      assert.ok(Date.now() - started < 2_000);
    },
  );
}

test("broken stdout stops the runtime", { timeout: 10_000 }, async (t) => {
  const probe = startChild();
  t.after(() => probe.child.kill("SIGKILL"));
  await probe.waitFor("ready");
  probe.child.stdout.destroy();
  probe.child.stdin.write("output\n");
  const [code, signal] = await probe.exited;
  assert.equal(code, 1);
  assert.equal(signal, null);
});

test(
  "repeated signals do not reset the first shutdown deadline or cause",
  { timeout: 10_000 },
  async (t) => {
    const probe = startChild("handler-hung");
    t.after(() => probe.child.kill("SIGKILL"));
    await probe.waitFor("ready");
    probe.child.stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (process.platform !== "win32") {
      probe.child.kill("SIGTERM");
      probe.child.kill("SIGTERM");
    }
    const [code, signal] = await probe.exited;
    assert.equal(code, 0);
    assert.equal(signal, null);
  },
);
