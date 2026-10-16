/**
 * 沙箱子进程的 **spawn 策略**契约（`RunWorkflowOptions.childSpawn`）。
 *
 * 2026-09-09 追记（docs/dynamic-workflow/launch.md）之后，payload 不再过命令行：harness 先把
 * 入口文件写到 `<cwd>/.zcode/workflow-runs/<runId>.mjs`，argv 只剩路径。
 *   - 缺省策略：`node --max-old-space-size=… <entry>`（没有 `--input-type` / `--eval`）；
 *   - SEA（bug 根因见同一 spec 的「SEA 子命令」）：SEA 单文件二进制**不解释 Node CLI 旗标**，
 *     故 harness 允许调用方（bootstrap，只在 SEA 下）改用 `childSpawn.argsPrefix`：
 *     `execPath [...argsPrefix, <entry>]`，零旗标。
 *
 * 两条断言方向缺一不可：
 *   - 缺省分支的 argv 形状（旗标、入口路径、`ELECTRON_RUN_AS_NODE`）必须钉住，否则 SEA 修法会
 *     顺手回归掉桌面 Electron helper 的既有修复；
 *   - argsPrefix 分支必须**真的能跑完一个 run**，光断言 argv 形状只能证明我们拼对了字符串，
 *     证明不了子进程侧「import 入口文件、调 start」的形态也成立。这里用一个 SEA CLI 的替身脚本
 *     （正是 dwf-child-command.ts 做的事）跑真链路。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { spawn as spawnType } from "node:child_process";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";
import { askSpecsFor } from "./helpers.js";

// 包一层真 spawn：只截获 args/options，子进程照常启动——桥接、结算全走真实路径。
const spawnCalls: Array<{ args: readonly string[]; options: Record<string, unknown> }> = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const wrapped: typeof spawnType = ((...args: Parameters<typeof spawnType>) => {
    spawnCalls.push({
      args: (args[1] ?? []) as readonly string[],
      options: (args[2] ?? {}) as Record<string, unknown>,
    });
    return actual.spawn(...args);
  }) as typeof spawnType;
  return { ...actual, spawn: wrapped };
});

const SCRIPT = ['const a = agent("a");', 'const r = await a.ask("hello");', "return r;"].join("\n");

const roots: string[] = [];

afterEach(async () => {
  spawnCalls.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** 跑一个真实 run（一次 ask，AutoDriver 回 "hi"），返回结算与 run cwd。 */
async function runOnce(extra: Partial<Parameters<typeof runWorkflowScript>[0]> = {}) {
  const cwd = await tempRoot("dwf-spawn-args-cwd-");
  const journal = new InMemoryJournalStore();
  const driver = new AutoDriver(journal, { asks: { "ask#1": () => ({ type: "text", finalText: "hi" }) } });
  const settlement = await runWorkflowScript({
    scriptText: SCRIPT,
    runId: "run",
    cwd,
    caps: { maxConcurrency: 16 },
    askSpecs: askSpecsFor(SCRIPT),
    validate: () => [],
    makeDriver: (sink) => {
      driver.attach(sink);
      return driver;
    },
    timeoutMs: 20000,
    ...extra,
  });
  return { settlement, cwd };
}

/** 从入口文件文本里取出内嵌的 payload（不 import 它：import 会在测试进程里跑它的顶层逻辑）。 */
async function readEntryPayload(entryPath: string): Promise<Record<string, unknown>> {
  const text = await readFile(entryPath, "utf8");
  const match = /^export const payload = (.*);$/m.exec(text);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as Record<string, unknown>;
}

/**
 * 写一个 SEA CLI 的替身：它就是 `dwf-child-command.ts` 的最小形态——import 入口文件、注入真实
 * deps 调 `start`。关键是它**不接受任何 Node 旗标**，只认 argv 末位的路径——正是 SEA 二进制的行为。
 */
async function writeSeaCliStandIn(): Promise<string> {
  const root = await tempRoot("dwf-sea-standin-");
  const scriptPath = join(root, "sea-cli-stand-in.mjs");
  await writeFile(
    scriptPath,
    `import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createContext, runInContext } from "node:vm";

// 严格模拟 SEA 主程序：除了 argv 末位的入口路径，任何多余 token 都是错误。
if (process.argv.length !== 3) {
  process.stderr.write("sea-cli-stand-in: unexpected argv " + JSON.stringify(process.argv.slice(2)) + "\\n");
  process.exit(1);
}

const entry = await import(pathToFileURL(process.argv[2]).href);
await entry.start({
  vm: { createContext, runInContext },
  createInterface,
  stdin: process.stdin,
  stdout: process.stdout,
});
`,
    "utf8",
  );
  return scriptPath;
}

describe("sandbox child spawn strategy", () => {
  it("spawns only the heap flag and the entry path when childSpawn is absent", async () => {
    const { settlement, cwd } = await runOnce();

    expect(settlement).toEqual({ status: "completed", artifact: "hi" });
    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0]!.args;

    // 命令行上只有旗标与路径——payload 与子进程源码都不在这里（Windows 32,767 字符上限）。
    expect(args).toEqual(["--max-old-space-size=256", join(cwd, ".zcode", "workflow-runs", "run.mjs")]);
    await expect(readEntryPayload(args[1]!)).resolves.toMatchObject({ lowered: expect.any(String) });
    expect(spawnCalls[0]!.options.env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1" });
    expect(spawnCalls[0]!.options.cwd).toBe(cwd);
  });

  it("keeps host-only run metadata out of the child payload (launch stays host-side)", async () => {
    // 只有 `args` 过界——沙箱脚本要读它。其余 run 元数据（lineage 指针、工具调用 id、父会话、
    // 展示名、以及 launch 那一整块：发起锚点与子代理模型）全是宿主事实。把它们写进入口文件
    // 只会让一份 run 级事实多出一个永远不会被读的副本，而那个副本还会随入口文件留在项目的
    // .zcode 目录里。launch 里的 `subagentModel` 尤其如此：模型面整个在宿主侧（子进程只把
    // ask 经桥递回来），子进程知道跑在哪个模型上既无用处，也没有任何代码路径会去读。
    //
    // 五个都真的传下去，否则「不在 payload 里」是一句废话。
    const { settlement, cwd } = await runOnce({
      launch: { inputId: "input-origin", subagentModel: "zhipu/glm-5.3-flash$high" },
      resumedFrom: "run-predecessor",
      toolCallId: "call-origin",
      parentSessionId: "sess_parent",
      name: "nightly triage",
      args: { topic: "release" },
    });

    expect(settlement).toEqual({ status: "completed", artifact: "hi" });
    const payload = await readEntryPayload(join(cwd, ".zcode", "workflow-runs", "run.mjs"));
    // 过界的那一个还在：这条断言让「全都没过界」不能靠一个空 payload 蒙混过去。
    expect(payload.args).toEqual({ topic: "release" });
    for (const field of ["launch", "resumedFrom", "toolCallId", "parentSessionId", "name"]) {
      expect(field in payload).toBe(false);
    }
  });

  it("maps maxOldSpaceSizeMb onto the node flag on the default path", async () => {
    await runOnce({ maxOldSpaceSizeMb: 512 });

    expect(spawnCalls[0]!.args[0]).toBe("--max-old-space-size=512");
  });

  it("spawns argsPrefix + entry path with zero node flags, and the run still settles", async () => {
    const standIn = await writeSeaCliStandIn();

    const { settlement, cwd } = await runOnce({ childSpawn: { argsPrefix: [standIn] } });

    // 真链路跑完是这条分支的主张：argv 拼对了，子进程侧「import 入口、调 start」的形态也成立。
    expect(settlement).toEqual({ status: "completed", artifact: "hi" });
    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0]!.args;
    expect(args).toEqual([standIn, join(cwd, ".zcode", "workflow-runs", "run.mjs")]);
    // 一个旗标都不许漏出去——SEA 主程序会把它们当未知参数而报错退出。
    expect(args.some((arg) => arg.startsWith("--"))).toBe(false);
    // 堆上限只能随 payload 走（argsPrefix 路上没有旗标可传），由入口文件 best-effort 施加。
    await expect(readEntryPayload(args[1]!)).resolves.toMatchObject({ maxOldSpaceSizeMb: 256 });
    // Electron helper 的既有修复对两条分支都成立。
    expect(spawnCalls[0]!.options.env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("forwards every argsPrefix token in order, entry path last", async () => {
    const standIn = await writeSeaCliStandIn();

    // 替身脚本只接受 argv.length === 3，所以多一个 token 必然让它自述失败——这正好证明
    // 「prefix 原样透传、入口路径在末位」不是靠巧合成立的。
    const { settlement } = await runOnce({
      childSpawn: { argsPrefix: [standIn, "__zcode-dwf-child"] },
      timeoutMs: 20000,
    });

    // 子进程非零退出而无 complete：宿主侧故障，stopped(interrupted)。
    expect(settlement).toMatchObject({ status: "stopped", reason: "interrupted" });
    expect(spawnCalls[0]!.args).toEqual([
      standIn,
      "__zcode-dwf-child",
      expect.stringMatching(/run\.mjs$/),
    ]);
  });
});
