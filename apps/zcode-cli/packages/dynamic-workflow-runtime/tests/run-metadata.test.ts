/**
 * Run 元数据经**真实入口**落库：runWorkflowScript → 引擎构造 → createRun。
 *
 * 直接 new WorkflowEngine 的单测（dynamic-workflow 包内）只证明引擎会写这四个字段；
 * 这里证明 harness 真的把它们递下去了——中间少接一个字段的表现是 dwf_run 里永远为空，
 * 而 resume 的 script_hash 校验因此永远没有比对对象。
 *
 * harness 刻意**不**自己算 scriptHash：编译一次的路径传 `lowered`（此时 harness 手里根本
 * 没有原始脚本文本），若 harness "顺手" 哈希它看到的文本，那条路径上落库的就是 lowered
 * 函数体的哈希——一个静默错误的比对对象。哈希归调用方。
 */

import { describe, expect, it } from "vitest";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";
import { askSpecsFor, TEST_CWD } from "./helpers.js";

const RUN = "run";

const SCRIPT = ['const a = agent("a");', 'const r = await a.ask("hello");', "return r;"].join("\n");

describe("run metadata through the real entry point", () => {
  it("forwards scriptText / scriptHash / parentSessionId / cwd / toolCallId onto the journaled run record", async () => {
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, { asks: { "ask#1": () => ({ type: "text", finalText: "hi" }) } });

    const settlement = await runWorkflowScript({
      scriptText: SCRIPT,
      runId: RUN,
      caps: { maxConcurrency: 16 },
      askSpecs: askSpecsFor(SCRIPT),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
      // 调用方给定的元数据：verbatim 递到 EngineConfig，harness 不加工。
      scriptHash: "caller-computed-hash",
      parentSessionId: "sess_parent",
      cwd: TEST_CWD,
      toolCallId: "call-origin",
    });

    expect(settlement).toEqual({ status: "completed", artifact: "hi" });
    const run = journal.getRun(RUN);
    expect(run).toMatchObject({
      runId: RUN,
      status: "completed",
      // scriptText 落的是调用方给的脚本原文，不是 lowered 之后的函数体。
      scriptText: SCRIPT,
      scriptHash: "caller-computed-hash",
      parentSessionId: "sess_parent",
      cwd: TEST_CWD,
      // 重启后工具卡 join / resume 通知锚点的唯一持久来源（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）。
      toolCallId: "call-origin",
    });
  });

  it("carries the run's subagent model on the journaled run-launched event, reasoning segment included", async () => {
    // 子代理模型零 SQL 地活在 `run-launched` 里（docs/dynamic-workflow/launch.md），与发起锚点、
    // 阶段表同车：harness 只把 launch 整块 verbatim 转交 EngineConfig，不读、不解析、不加工。
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, {
      asks: { "ask#1": () => ({ type: "text", finalText: "hi" }) },
    });

    await runWorkflowScript({
      scriptText: SCRIPT,
      runId: RUN,
      cwd: TEST_CWD,
      caps: { maxConcurrency: 16 },
      askSpecs: askSpecsFor(SCRIPT),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
      launch: { inputId: "input-origin", subagentModel: "zhipu/glm-5.3-flash$high" },
    });

    const launched = journal
      .listEvents(RUN, { types: "all", reportItems: "all" })
      .find((stored) => stored.event.type === "run-launched");
    expect(launched?.event).toEqual({
      type: "run-launched",
      inputId: "input-origin",
      // 档位段原样带着走：`$high` 是选择的一部分，宿主从这条事件读回整串。
      subagentModel: "zhipu/glm-5.3-flash$high",
    });
    // 行上没有这条事实：它不是 dwf_run 的列（用户裁决不做迁移）。
    expect("subagentModel" in journal.getRun(RUN)!).toBe(false);
  });

  it("omits subagentModel entirely when launch carries none", async () => {
    // 缺席即「子代理跑在会话模型上」。落成值为 undefined 的键会让读侧把「没设」读成
    // 「设了一个空模型」——两者在 AmendWorkflow 的三态里是不同的意思。
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, {
      asks: { "ask#1": () => ({ type: "text", finalText: "hi" }) },
    });

    await runWorkflowScript({
      scriptText: SCRIPT,
      runId: RUN,
      cwd: TEST_CWD,
      caps: { maxConcurrency: 16 },
      askSpecs: askSpecsFor(SCRIPT),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
      launch: { inputId: "input-origin" },
    });

    const launched = journal
      .listEvents(RUN, { types: "all", reportItems: "all" })
      .find((stored) => stored.event.type === "run-launched");
    expect("subagentModel" in launched!.event).toBe(false);
  });

  it("journals the authored scriptText, not the lowered body, when both are given", async () => {
    // 「编译一次」的形态：调用方自己编译得到 lowered，同时把作者原文交下来。落库的必须是
    // 原文——两段文本刻意不同，所以"顺手拿 lowered 顶替"会被这条断言抓住。
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, {});

    const settlement = await runWorkflowScript({
    cwd: TEST_CWD,
      lowered: "return 7;",
      runId: RUN,
      caps: { maxConcurrency: 16 },
      askSpecs: new Map(),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
      scriptText: "return 3 + 4; // authored",
      scriptHash: "hash-of-source",
    });

    expect(settlement).toEqual({ status: "completed", artifact: 7 });
    expect(journal.getRun(RUN)).toMatchObject({
      scriptText: "return 3 + 4; // authored",
      scriptHash: "hash-of-source",
    });
  });

  it("forwards the run name onto the journaled run record", async () => {
    // name 与 scriptText / cwd 同一条元数据路。harness 少接这一个字段的表现是 dwf_run.name
    // 永远为空，而宿主的枚举面只能列出裸 runId（run 内省工具的标签就此失效）。
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, {});

    await runWorkflowScript({
    cwd: TEST_CWD,
      lowered: "return 1;",
      runId: RUN,
      caps: { maxConcurrency: 16 },
      askSpecs: new Map(),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
      name: "nightly triage",
    });

    expect(journal.getRun(RUN)).toMatchObject({ name: "nightly triage" });
  });

  it("omits the metadata entirely when the caller passes none", async () => {
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, {});

    await runWorkflowScript({
    cwd: TEST_CWD,
      lowered: "return 1;",
      runId: RUN,
      caps: { maxConcurrency: 16 },
      askSpecs: new Map(),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
    });

    const run = journal.getRun(RUN)!;
    for (const field of ["scriptText", "scriptHash", "parentSessionId", "name"]) {
      expect(field in run).toBe(false);
    }
  });

  it("rejects a resume whose scriptHash does not match the journaled one", async () => {
    // 端到端地证明这条校验现在有比对对象了：第一趟落库哈希，第二趟换一个哈希即被拒。
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, { asks: { "ask#1": () => ({ type: "text", finalText: "hi" }) } });
    const base = {
      runId: RUN,
      caps: { maxConcurrency: 16 },
      askSpecs: askSpecsFor(SCRIPT),
      validate: () => [],
      timeoutMs: 20000,
    } as const;

    await runWorkflowScript({
    cwd: TEST_CWD,
      ...base,
      scriptText: SCRIPT,
      scriptHash: "hash-v1",
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
    });
    expect(journal.getRun(RUN)?.scriptHash).toBe("hash-v1");

    const resumed = new AutoDriver(journal, {});
    await expect(
      runWorkflowScript({
    cwd: TEST_CWD,
        ...base,
        scriptText: `${SCRIPT}\n// edited`,
        scriptHash: "hash-v2",
        makeDriver: (sink) => {
          resumed.attach(sink);
          return resumed;
        },
      }),
    ).rejects.toMatchObject({
      code: "ScriptHashMismatch",
      mismatch: { expected: "hash-v1", got: "hash-v2" },
    });

    // 被拒的 resume 不得改写既有记录（它仍可用 hash-v1 的脚本 resume）。
    expect(journal.getRun(RUN)).toMatchObject({ status: "completed", scriptHash: "hash-v1" });
  });
});
