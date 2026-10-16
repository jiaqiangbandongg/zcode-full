import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stringifyHostLogArg } from "../src/host/hostLog.js";
import { subagentUpdateCursor } from "./e2e/helpers/subagent-snapshot-wait.js";

const runNode = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "subagent-log-path-"));
  roots.push(root);
  return root;
}
const paths = [
  "/workspace/.zcode/agents/reviewer.md",
  String.raw`D:\workspace\.zcode\agents\reviewer.md`,
  String.raw`\\server\share\workspace\.zcode\agents\reviewer.md`,
];
const message = (path: string, pid = 42) =>
  [
    `[subagentRuntimeConfig][pid:${pid}]`,
    "Subagent 配置文件更新完成",
    { path, changedPaths: [path], fallback: false },
  ]
    .map(stringifyHostLogArg)
    .join(" ");

describe("subagent E2E log path matching", () => {
  it.each(paths)("waits for a new matching Host update: %s", async (path) => {
    const root = await fixture();
    const logPath = join(root, "host.log");
    await writeFile(logPath, message(path, 1) + "\n");
    let matched = false;
    vi.stubGlobal("browser", {
      electron: { execute: async () => root },
      waitUntil: async (predicate: () => Promise<boolean>) => {
        matched = await predicate();
      },
    });
    const updated = await subagentUpdateCursor();
    await updated([1], [path]);
    expect(matched).toBe(false);
    await appendFile(logPath, message(path) + "\n");
    await updated([43], [path]);
    expect(matched).toBe(false);
    await updated([42], [path]);
    expect(matched).toBe(true);
    await updated([42], ["reviewer.md"]);
    expect(matched).toBe(true);
  });

  it.each(paths)("records the preload observer's matching update: %s", async (path) => {
    const root = await fixture();
    await writeFile(join(root, "host-fault-control.json"), JSON.stringify({ tracePaths: [path] }));
    const entry = join(root, "entry.mjs");
    await writeFile(entry, "export {};\n");
    const preload = fileURLToPath(
      new URL("./e2e/helpers/subagent-host-faults.cjs", import.meta.url),
    );
    // 在独立 Node 子进程执行真实测试 preload，避免其文件边界替换污染单测进程。
    const { stdout } = await runNode(process.execPath, [
      "-e",
      `process.env.ZCODE_E2E_HOST_FAULT_ROOT = ${JSON.stringify(root)};
       process.parentPort = { postMessage() {} };
       process.argv[2] = ${JSON.stringify(entry)};
       require(${JSON.stringify(preload)});
       process.parentPort.postMessage(${JSON.stringify({ source: "host", message: message(path) })});
       process.stdout.write(String(process.pid));`,
    ]);
    const events = (await readFile(join(root, `host-boundary-${stdout}.jsonl`), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.filter((event) => event.kind === "snapshot-published")).toEqual([
      { pid: Number(stdout), kind: "snapshot-published", paths: [path], readCounts: {} },
    ]);
  });
});
