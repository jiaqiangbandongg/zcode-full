/**
 * 沙箱子进程 spawn env 契约：必须显式携带 `ELECTRON_RUN_AS_NODE=1` 且继承父进程 env。
 *
 * Bug 根因（2026-08-19 桌面实测）：桌面端 agent 进程由 Electron Helper 运行
 * （process.execPath 指向 Helper），而 CLI 启动时会把 ELECTRON_RUN_AS_NODE 从自身
 * process.env 里 sanitize 掉（shared/runtimeEnv.ts，防止 Bash/MCP 子进程误继承）。
 * harness 原先 spawn 子进程不传 env → 继承已被清洗的 env → Electron Helper 不进
 * Node 模式，按完整 Electron/Chromium 应用启动并卡在 GPU 初始化：子进程活着但永远
 * 沉默，run 卡在 run-started（journal 无 node/actor，无失败结算）。修复与
 * official-plugin-runtime.ts 同款：spawn env 显式带 ELECTRON_RUN_AS_NODE=1
 * （纯 Node 下该变量无效，无副作用）。
 *
 * 两条断言缺一不可：只断言 flag 会漏掉「env 只剩 flag、丢掉 PATH 等继承项」的错误修法；
 * 只断言继承会漏掉 flag 本身。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { spawn as spawnType } from "node:child_process";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";
import { askSpecsFor, TEST_CWD } from "./helpers.js";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";

// 包一层真 spawn：只截获 options，子进程照常启动——桥接、结算全走真实路径。
const spawnCalls: Array<{ options: Record<string, unknown> }> = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const wrapped: typeof spawnType = ((...args: Parameters<typeof spawnType>) => {
    spawnCalls.push({ options: (args[2] ?? {}) as Record<string, unknown> });
    return actual.spawn(...args);
  }) as typeof spawnType;
  return { ...actual, spawn: wrapped };
});

const SCRIPT = ['const a = agent("a");', 'const r = await a.ask("hello");', "return r;"].join("\n");
const CANARY_KEY = "DWF_SPAWN_ENV_CANARY";

afterEach(() => {
  delete process.env[CANARY_KEY];
  spawnCalls.length = 0;
});

describe("sandbox child spawn env", () => {
  it("spawns the child with ELECTRON_RUN_AS_NODE=1 and the inherited parent env", async () => {
    process.env[CANARY_KEY] = "inherited";

    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, { asks: { "ask#1": () => ({ type: "text", finalText: "hi" }) } });
    const settlement = await runWorkflowScript({
    cwd: TEST_CWD,
      scriptText: SCRIPT,
      runId: "run",
      caps: { maxConcurrency: 16 },
      askSpecs: askSpecsFor(SCRIPT),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
    });

    // 真实链路仍然要跑完——env 传错（比如覆盖掉 PATH）会在这里以失败结算暴露。
    expect(settlement).toEqual({ status: "completed", artifact: "hi" });

    expect(spawnCalls).toHaveLength(1);
    const env = spawnCalls[0]?.options.env as Record<string, string | undefined> | undefined;
    expect(env).toBeDefined();
    expect(env?.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env?.[CANARY_KEY]).toBe("inherited");
  });
});
