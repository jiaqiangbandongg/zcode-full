import { fork } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { createToolSearchCliFixture } from "./toolsearch-cli-process.js";

export async function startToolSearchRuntimeDriver(
  fixture: Awaited<ReturnType<typeof createToolSearchCliFixture>>,
  streaming: "on" | "off",
  options: { mode?: "native" | "local"; recording?: boolean; autoCompact?: boolean } = {},
) {
  // Windows 的 --import 不接受裸盘符路径，必须传 file URL。
  const tsx = pathToFileURL(createRequire(join(process.cwd(), "package.json")).resolve("tsx")).href;
  const child = fork(
    resolve("test/e2e/fixtures/toolsearch/runtime-driver.mjs"),
    [streaming, JSON.stringify(options)],
    {
      cwd: fixture.workspace,
      env: fixture.env,
      execArgv: ["--import", tsx],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdout?.resume();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 0;
  let resolveReady: () => void;
  let rejectReady: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  child.on(
    "message",
    (message: { ready?: boolean; id: number; value?: unknown; error?: string }) => {
      if (message.ready) {
        resolveReady();
        return;
      }
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error));
      else waiter?.resolve(message.value);
    },
  );
  const closed = once(child, "close");
  child.on("close", () => {
    const error = new Error(`ToolSearch runtime driver exited: ${stderr}`);
    rejectReady(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  const timer = setTimeout(() => {
    child.kill();
  }, 90_000);
  await ready.catch(async (error) => {
    clearTimeout(timer);
    await fixture.close();
    throw error;
  });
  function command(command: string, values: Record<string, string> = {}): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.send({ id, command, ...values });
    });
  }
  return {
    turn: (prompt: string) => command("turn", { prompt }),
    catalog: (name: string, state: "absent" | "resident" | "deferred") =>
      command("catalog", { name, state }),
    history: () => command("history"),
    records: () => command("records"),
    async close() {
      try {
        if (child.connected) await command("close");
      } finally {
        clearTimeout(timer);
        if (child.connected) child.kill();
        await closed;
      }
    },
  };
}
