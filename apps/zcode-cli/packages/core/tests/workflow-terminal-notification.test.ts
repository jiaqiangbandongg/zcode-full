// ============================================================
// dwf 终态通知的三终态词与 provider 停下的文案表（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）
// ============================================================
// 直接钉 formatter：`<status>` 用真实终态词、`<stop-reason>` 只在 stopped 上在场、`<error>` 块
// 按 providerStop.kind 选文案（原因 → 动作 → 事实行 → 原文行）、呈现指引按 reason 分叉；
// legacy `Workflow`（不带 runStatus）逐字节不变。

import { describe, expect, it } from "vitest";
import type { DynamicWorkflowRunError } from "@zcode/contracts";
import {
  formatTaskNotification,
  formatWorkflowProviderStopError,
  formatWorkflowStallNotification,
  type TaskNotificationInput,
} from "../src/runtime-task/notification.js";

const BASE: TaskNotificationInput = {
  status: "killed",
  summary: 'Workflow "nightly audit" was stopped.',
  taskId: "dwfrun-1",
  taskType: "local_workflow",
  deliveryGuidance: true,
};

function providerStop(
  overrides: Partial<NonNullable<DynamicWorkflowRunError["providerStop"]>> = {},
): DynamicWorkflowRunError {
  return {
    code: "ProviderStop",
    message: "Subagent turn failed: [1006] token expired",
    providerStop: {
      kind: "auth",
      reason: "auth_failed",
      providerId: "account:bigmodel-coding-plan",
      providerLabel: "BigModel",
      modelId: "GLM-5.3",
      providerCode: "1006",
      subagent: "verify@2",
      subagentName: "verifier",
      phase: "Verify",
      rawMessage: "[1006] token expired",
      ...overrides,
    },
  };
}

describe("formatTaskNotification（local_workflow）：三终态词", () => {
  it("stopped(user)：<status>stopped</status> + <stop-reason>user</stop-reason> + 不要恢复的指引", () => {
    const text = formatTaskNotification({ ...BASE, runStatus: "stopped", stopReason: "user" });
    expect(text).toContain("<status>stopped</status>");
    expect(text).toContain("<stop-reason>user</stop-reason>");
    expect(text).toContain("The user stopped this workflow on purpose.");
    expect(text).not.toContain("<stopped-by>");
    expect(text).not.toContain("resumable as-is");
  });

  it("stopped(model)：你自己 TaskStop 停的", () => {
    const text = formatTaskNotification({ ...BASE, runStatus: "stopped", stopReason: "model" });
    expect(text).toContain("<stop-reason>model</stop-reason>");
    expect(text).toContain("You stopped this workflow with TaskStop.");
  });

  it("stopped(interrupted)：指引直接给出 ResumeWorkflowRun 与 run_id", () => {
    const text = formatTaskNotification({
      ...BASE,
      runStatus: "stopped",
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "the owning process exited" },
      error: "the owning process exited",
    });
    expect(text).toContain("<stop-reason>interrupted</stop-reason>");
    expect(text).toContain("<error>the owning process exited</error>");
    expect(text).toContain("The process that owned this run exited before it finished.");
    expect(text).toContain('ResumeWorkflowRun with run_id="dwfrun-1"');
  });

  it("stopped(provider)：<error> 是文案表铸的整块，指引先解决原因再 resume、不要重建", () => {
    const text = formatTaskNotification({
      ...BASE,
      runStatus: "stopped",
      stopReason: "provider",
      failure: providerStop(),
      error: "Subagent turn failed: [1006] token expired",
    });
    expect(text).toContain("<stop-reason>provider</stop-reason>");
    expect(text).toContain("<error>\n");
    expect(text).toContain("Sign-in to BigModel (account:bigmodel-coding-plan) expired");
    expect(text).toContain('then call ResumeWorkflowRun with run_id="dwfrun-1"');
    expect(text).toContain(
      "provider=account:bigmodel-coding-plan model=GLM-5.3 subagent=verify@2 phase=Verify code=1006",
    );
    expect(text).toContain("raw: [1006] token expired");
    // 原文只出现在 raw 行，不再另贴一遍 message。
    expect(text).not.toContain("<error>Subagent turn failed");
    expect(text).toContain("A provider-side error stopped this run");
    expect(text).toContain("resolve the cause with the user before calling ResumeWorkflowRun");
    expect(text).toContain("Do not rebuild the workflow.");
  });

  it("errored：指引指向 AmendWorkflow，并明说 ResumeWorkflowRun 会拒绝", () => {
    const text = formatTaskNotification({
      ...BASE,
      status: "failed",
      runStatus: "errored",
      error: "script threw TypeError",
      failure: { code: "DriverError", message: "script threw TypeError" },
    });
    expect(text).toContain("<status>errored</status>");
    expect(text).not.toContain("<stop-reason>");
    expect(text).toContain("<error>script threw TypeError</error>");
    expect(text).toContain("The workflow script failed.");
    expect(text).toContain("AmendWorkflow");
    expect(text).toContain('run_id="dwfrun-1"');
    expect(text).toContain("ResumeWorkflowRun will refuse this run");
  });

  // 脚本文件（docs/dynamic-workflow/launch.md「Script files」）：有文件时下一步是「编辑那个
  // 文件、用 `path` 修订」，没有文件才退回「改好脚本再内联提交」的老话。两句都必须逐字节钉住
  // ——模型照抄的正是这里的 `run_id` 与 `path`。
  it("errored + scriptPath：指引说出路径、`path` 参数与「不要内联粘贴」", () => {
    const text = formatTaskNotification({
      ...BASE,
      status: "failed",
      runStatus: "errored",
      error: "script threw TypeError",
      scriptPath: ".zcode/workflow-drafts/audit.dwf.ts",
    });
    expect(text).toContain(
      'The run\'s script is at .zcode/workflow-drafts/audit.dwf.ts. Edit that file in place, then call AmendWorkflow (run_id="dwfrun-1", path=".zcode/workflow-drafts/audit.dwf.ts") so finished work is reused — do not paste the script inline. ResumeWorkflowRun will refuse this run: replaying the same script would fail the same way.',
    );
    // 有文件时旧话整句消失：两句并存会让模型以为内联重提交仍是一条平等的路。
    expect(text).not.toContain("Fix the script and submit it with AmendWorkflow");
  });

  it("errored 不带 scriptPath：旧那一句逐字节不变", () => {
    const text = formatTaskNotification({
      ...BASE,
      status: "failed",
      runStatus: "errored",
      error: "script threw TypeError",
    });
    expect(text).toContain(
      'Fix the script and submit it with AmendWorkflow (run_id="dwfrun-1") so finished work is reused. ResumeWorkflowRun will refuse this run: replaying the same script would fail the same way.',
    );
    expect(text).not.toContain("Edit that file in place");
  });

  it("stopped(model) + scriptPath：为改脚本而停的那一句尾巴上多一句「编辑它、传 path」", () => {
    const text = formatTaskNotification({
      ...BASE,
      runStatus: "stopped",
      stopReason: "model",
      scriptPath: ".zcode/workflow-drafts/audit.dwf.ts",
    });
    expect(text).toContain("You stopped this workflow with TaskStop.");
    expect(text).toContain(
      "Its script is at .zcode/workflow-drafts/audit.dwf.ts: edit that file and pass `path`.",
    );
  });

  it("stopped(model) 不带 scriptPath：那一句不出现，其余逐字节不变", () => {
    const text = formatTaskNotification({ ...BASE, runStatus: "stopped", stopReason: "model" });
    expect(text).toContain(
      "(Next time, amend the running run directly: AmendWorkflow stops it for you.)",
    );
    expect(text).not.toContain("edit that file and pass");
  });

  it("scriptPath 只喂给 errored 与 stopped(model) 两支：其余终态的指引一个字不变", () => {
    const withPath = { ...BASE, scriptPath: ".zcode/workflow-drafts/audit.dwf.ts" };
    for (const input of [
      { ...withPath, status: "completed", runStatus: "completed" as const },
      { ...withPath, runStatus: "stopped" as const, stopReason: "user" as const },
      { ...withPath, runStatus: "stopped" as const, stopReason: "interrupted" as const },
    ]) {
      const text = formatTaskNotification(input);
      expect(text).not.toContain(".zcode/workflow-drafts/audit.dwf.ts");
    }
  });

  it("legacy Workflow（无 runStatus）逐字节沿用追踪器词汇与旧指引", () => {
    const text = formatTaskNotification({ ...BASE, status: "failed", error: "boom" });
    expect(text).toContain("<status>failed</status>");
    expect(text).not.toContain("<stop-reason>");
    expect(text).toContain("<error>boom</error>");
    expect(text).toContain(
      "if the process died (error code Interrupted), the run is resumable as-is.",
    );
  });
});

describe("formatWorkflowProviderStopError：按 kind 的文案表", () => {
  const cases: {
    kind: NonNullable<DynamicWorkflowRunError["providerStop"]>["kind"];
    first: RegExp;
    second: RegExp;
    extra?: Partial<NonNullable<DynamicWorkflowRunError["providerStop"]>>;
  }[] = [
    {
      kind: "auth",
      first:
        /Sign-in to BigModel \(account:bigmodel-coding-plan\) expired while subagent verifier \(phase "Verify"\) was running\./,
      second:
        /Ask the user to sign in to BigModel again, then call ResumeWorkflowRun with run_id="dwfrun-1"\. Finished steps are kept\./,
    },
    {
      kind: "not_configured",
      first:
        /Provider account:bigmodel-coding-plan is not configured on this machine, so subagent verifier \(phase "Verify"\) could not send its request\./,
      second:
        /configure the provider or switch this session to another model, then call ResumeWorkflowRun/,
    },
    {
      kind: "model_unavailable",
      first: /Model GLM-5\.3 is not available on BigModel \(not in the user's plan, or retired\)\./,
      second:
        /switch this session to a model the plan includes, then call ResumeWorkflowRun with run_id="dwfrun-1"\. Subagents follow the session's model\./,
    },
    {
      kind: "invalid_request",
      first:
        /BigModel rejected subagent verifier \(phase "Verify"\)'s request as invalid \(code 3001\)\./,
      second:
        /Switching the session to another model usually clears this; then call ResumeWorkflowRun/,
      extra: { providerCode: "3001", reason: "invalid_request" },
    },
    {
      kind: "quota",
      first: /BigModel reports the user's quota is exhausted \(code 1005\)\./,
      second:
        /top up or upgrade the plan, or switch to another provider, then call ResumeWorkflowRun/,
      extra: { providerCode: "1005", reason: "invalid_request" },
    },
    {
      kind: "quota",
      first:
        /BigModel reports the user's usage cap is reached \(code 1308\); it resets at 2026-09-13T12:00:00\.000Z\./,
      second:
        /Tell the user; after the reset, call ResumeWorkflowRun with run_id="dwfrun-1"\. Do not rebuild the workflow\./,
      extra: { providerCode: "1308", reason: "rate_limited", resetAt: Date.UTC(2026, 8, 13, 12) },
    },
    {
      kind: "other",
      first:
        /BigModel refused subagent verifier \(phase "Verify"\)'s request with a permanent error \(code 1314\)\./,
      second:
        /Resolve it with the user \(the raw message below says what the provider wants\), then call ResumeWorkflowRun/,
      extra: { providerCode: "1314", reason: "unknown" },
    },
  ];

  it.each(cases)(
    "$kind（code $extra.providerCode）：原因 → 动作 → 事实行 → 原文行",
    ({ kind, first, second, extra }) => {
      const text = formatWorkflowProviderStopError(providerStop({ kind, ...extra }), "dwfrun-1");
      const lines = text.split("\n");
      expect(lines[0]).toMatch(first);
      expect(lines[1]).toMatch(second);
      expect(lines[2]).toBe(
        `provider=account:bigmodel-coding-plan model=GLM-5.3 subagent=verify@2 phase=Verify code=${extra?.providerCode ?? "1006"}`,
      );
      expect(lines[3]).toBe("raw: [1006] token expired");
      expect(lines).toHaveLength(4);
    },
  );

  it("每个占位都有兜底：无显示名 / 无子代理名 / 无 phase / 无原文 / 无 code", () => {
    const text = formatWorkflowProviderStopError(
      {
        code: "ProviderStop",
        message: "x",
        providerStop: { kind: "auth", reason: "auth_failed" },
      },
      "dwfrun-2",
    );
    expect(text.split("\n")).toEqual([
      "Sign-in to the provider expired while subagent a subagent was running.",
      'Ask the user to sign in to the provider again, then call ResumeWorkflowRun with run_id="dwfrun-2". Finished steps are kept.',
      "provider=unknown model=unknown subagent=unknown code=auth_failed",
    ]);
  });

  it("没有 providerStop 明细时退回 message", () => {
    expect(formatWorkflowProviderStopError({ code: "Interrupted", message: "exited" }, "r")).toBe(
      "exited",
    );
  });
});

describe("formatWorkflowStallNotification", () => {
  it("说清：多久没成功、provider 在答什么、当前并发、run 仍在跑、不要动它", () => {
    const text = formatWorkflowStallNotification({
      runLabel: "nightly audit",
      runId: "dwfrun-1",
      sinceMs: 20 * 60_000,
      reason: "rate_limited",
      cap: 3,
    });
    expect(text).toContain("<workflow-stall>");
    expect(text).toContain("<run-id>dwfrun-1</run-id>");
    expect(text).toContain("<run>nightly audit</run>");
    expect(text).toContain("<since-ms>1200000</since-ms>");
    expect(text).toContain("<dominant-reason>rate_limited</dominant-reason>");
    expect(text).toContain("<cap>3</cap>");
    expect(text).toContain(
      "Workflow run nightly audit (dwfrun-1) has not completed a model request in 20 minutes; the provider keeps answering rate_limited and the run is retrying with backoff (current fan-out 3).",
    );
    expect(text).toContain("It is still running and needs nothing from you.");
  });

  it("reason / cap 缺席时文案退化而不空", () => {
    const text = formatWorkflowStallNotification({
      runLabel: "r",
      runId: "dwfrun-1",
      sinceMs: 90_000,
    });
    expect(text).not.toContain("<dominant-reason>");
    expect(text).not.toContain("<cap>");
    expect(text).toContain(
      "in 2 minutes; the provider keeps failing requests and the run is retrying with backoff.",
    );
  });
});
