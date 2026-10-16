// dwf run 发起锚点的解析与读回（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Token telemetry for subagents」）。
import { describe, expect, it } from "vitest";
import { createRootTraceContext, createSessionId, createTurnId } from "@zcode/contracts";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import {
  readRunLaunchAnchor,
  readRunScriptPath,
  resolveLaunchAnchor,
} from "../src/app/dynamic-workflow-run-launch-anchor.js";
import { runScriptPathField } from "../src/app/dynamic-workflow-run-observation.js";

const trace = createRootTraceContext({
  sessionId: createSessionId("anchor"),
  turnId: createTurnId("anchor"),
});

describe("resolveLaunchAnchor：优先级", () => {
  it("前驱锚点 > 显式 launchInputId > 活动轮解析 > 铸值", () => {
    const mint = () => "minted";
    expect(
      resolveLaunchAnchor({
        predecessor: { inputId: "pred" },
        requested: "req",
        resolveLaunchInputId: () => "active",
        trace,
        mint,
      }),
    ).toEqual({ inputId: "pred" });
    expect(
      resolveLaunchAnchor({ requested: "req", resolveLaunchInputId: () => "active", trace, mint }),
    ).toEqual({ inputId: "req" });
    expect(resolveLaunchAnchor({ resolveLaunchInputId: () => "active", trace, mint })).toEqual({
      inputId: "active",
    });
    expect(resolveLaunchAnchor({ resolveLaunchInputId: () => undefined, trace, mint })).toEqual({
      inputId: "minted",
    });
  });

  it("缺省铸 UUID v7", () => {
    const { inputId } = resolveLaunchAnchor({ trace });
    expect(inputId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
});

describe("readRunLaunchAnchor：从 journal 读回", () => {
  it("首条 run-launched 的 inputId；没有则 undefined", () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: "r1",
      caps: { maxConcurrency: 1 },
      spentTokens: 0,
      status: "running",
    });
    journal.appendEvent("r1", { type: "run-started", runId: "r1", caps: { maxConcurrency: 1 } });
    expect(readRunLaunchAnchor(journal, "r1")).toBeUndefined();
    journal.appendEvent("r1", { type: "run-launched", inputId: "launch-1", toolCallId: "tool-1" });
    // resume 再发一次 run-started 不影响锚点。
    journal.appendEvent("r1", { type: "run-started", runId: "r1", caps: { maxConcurrency: 1 } });
    expect(readRunLaunchAnchor(journal, "r1")).toEqual({ inputId: "launch-1" });
    expect(readRunLaunchAnchor(journal, "missing")).toBeUndefined();
  });
});

// 本 run 的脚本文件（docs/dynamic-workflow/launch.md「Script files」的 Provenance）。
//
// 这一组钉的是**冷读路径的缺席语义**：两条读面对一个本进程没有条目的 run 只能扫事件头，而
// 本特性之前发起的 run 要么整条 `run-launched` 都没有（锚点之前），要么有事件但没有这个键。
// 两种都必须让读面上的字段**整个不出现**，而不是出现一个值为 undefined 的键——`GetWorkflowRun`
// 的输出是「无则缺席」的投影，一个 undefined 值会让模型读到一个它无法 `Edit` 的路径。
describe("readRunScriptPath：从 journal 读回脚本文件", () => {
  const seedRun = (journal: InMemoryJournalStore, runId: string): void => {
    journal.createRun({
      runId,
      caps: { maxConcurrency: 1 },
      spentTokens: 0,
      status: "running",
    });
    journal.appendEvent(runId, { type: "run-started", runId, caps: { maxConcurrency: 1 } });
  };

  it("整条 run-launched 都没有（锚点之前的老 run）→ undefined", () => {
    const journal = new InMemoryJournalStore();
    seedRun(journal, "r-old");
    expect(readRunScriptPath(journal, "r-old")).toBeUndefined();
    // 未知 run 与「没有这条事件」对读面是同一件事。
    expect(readRunScriptPath(journal, "missing")).toBeUndefined();
  });

  it("有 run-launched 但没有这个键（本特性之前的 run）→ undefined", () => {
    const journal = new InMemoryJournalStore();
    seedRun(journal, "r-no-key");
    journal.appendEvent("r-no-key", { type: "run-launched", inputId: "launch-1" });
    expect(readRunScriptPath(journal, "r-no-key")).toBeUndefined();
  });

  it("有这个键 → 首条 run-launched 上的绝对路径，resume 再发 run-started 不影响它", () => {
    const journal = new InMemoryJournalStore();
    seedRun(journal, "r-path");
    journal.appendEvent("r-path", {
      type: "run-launched",
      inputId: "launch-2",
      scriptPath: "/repo/.zcode/workflow-drafts/audit.dwf.ts",
    });
    journal.appendEvent("r-path", {
      type: "run-started",
      runId: "r-path",
      caps: { maxConcurrency: 1 },
    });
    expect(readRunScriptPath(journal, "r-path")).toBe("/repo/.zcode/workflow-drafts/audit.dwf.ts");
  });

  // 冷读的另一半：读回 undefined 之后，两条读面上的字段必须**整个不出现**。
  it("runScriptPathField 把 undefined 变成空对象：键不出现，不是值为 undefined", () => {
    const absent = runScriptPathField(undefined);
    expect(absent).toEqual({});
    expect("scriptPath" in absent).toBe(false);
    expect(runScriptPathField("/repo/audit.dwf.ts")).toEqual({
      scriptPath: "/repo/audit.dwf.ts",
    });
  });
});
