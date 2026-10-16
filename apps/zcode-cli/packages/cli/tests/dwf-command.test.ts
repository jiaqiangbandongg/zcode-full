import assert from "node:assert/strict";
import test from "node:test";
import type { DynamicWorkflowRunSessionSummary } from "@zcode/contracts";
import {
  createCommandCenter,
  listSlashCommandSuggestions,
  parseSlashCommand,
} from "../src/command-center.js";
import type { CommandCenterApp, CommandCenterDeps } from "../src/command-center.js";

/**
 * `/dwf` 的命令面测试（docs/dynamic-workflow/launch.md「`/dwf`」）。
 * 三条不变量在这里守着：能力缺席要说「不可用」而不是空表；cancel 缺 runId 只在
 * 恰一在飞时替用户决定；resume 的拒绝理由原样来自服务端，绝不客户端重新推导。
 */

const ABORT = { abortSignal: new AbortController().signal };

function createHarness(app: Partial<CommandCenterApp>) {
  const deps: CommandCenterDeps = {
    getApp: async () =>
      ({
        sessionId: "sess_active",
        traceId: "trace-active",
        resume: async () => {
          throw new Error("resume should not run");
        },
        submitPrompt: async () => {
          throw new Error("prompt should not run for /dwf");
        },
        ...app,
      }) as never,
    getMode: () => "build" as never,
    resumeApp: async () => {
      throw new Error("resumeApp should not run");
    },
  };
  return createCommandCenter(deps);
}

function run(overrides: Partial<DynamicWorkflowRunSessionSummary> = {}) {
  return {
    resumable: false,
    runId: "dwfrun_1",
    status: "running",
    ...overrides,
  } as DynamicWorkflowRunSessionSummary;
}

test("/dwf lists this session's dynamic workflow runs as text", async () => {
  let requestedLimit: number | undefined;
  const submitPrompt = createHarness({
    listDynamicWorkflowRuns: async (input) => {
      requestedLimit = input.limit;
      return [
        run({ label: "nightly audit", runId: "dwfrun_live", status: "running" }),
        run({
          failureCode: "Interrupted",
          failureMessage: "host exited",
          label: "flaky test hunt",
          resumable: true,
          runId: "dwfrun_dead",
          status: "stopped",
          stopReason: "interrupted",
        }),
      ];
    },
  });

  const result = await submitPrompt("/dwf", ABORT);

  assert.equal(requestedLimit, 20);
  assert.match(result.response, /Dynamic workflow runs \(2\)/);
  assert.match(result.response, /dwfrun_live · nightly audit · running/);
  // resumable 与 failure 一起呈现：用户看到「可恢复」才知道 /dwf resume 有意义。
  assert.match(
    result.response,
    /dwfrun_dead · flaky test hunt · stopped\/interrupted · resumable \(Interrupted: host exited\)/,
  );
});

test("/dwf list renders the updated time when the server sends one", async () => {
  const updatedAt = new Date(2026, 7, 22, 14, 5).getTime();
  const submitPrompt = createHarness({
    listDynamicWorkflowRuns: async () => [run({ label: "audit", updatedAt })],
  });

  const result = await submitPrompt("/dwf list", ABORT);

  assert.match(result.response, /updated 2026-08-22 14:05/);
});

test("/dwf list degrades gracefully when label and updatedAt are absent", async () => {
  const submitPrompt = createHarness({
    listDynamicWorkflowRuns: async () => [run({ runId: "dwfrun_old" })],
  });

  const result = await submitPrompt("/dwf list", ABORT);

  // 老服务端不发这两个可选键：标签回落 runId、时间整段省略，行仍然完整可读。
  assert.match(result.response, /- dwfrun_old · running/);
  assert.ok(!result.response.includes("updated"), "no time column when the server omits it");
});

test("/dwf list does not repeat the runId when label fell back to it", async () => {
  const submitPrompt = createHarness({
    listDynamicWorkflowRuns: async () => [run({ label: "dwfrun_bare", runId: "dwfrun_bare" })],
  });

  const result = await submitPrompt("/dwf list", ABORT);

  // 服务端的 label 兜底最后一档就是 runId；照抄会印成 "dwfrun_bare dwfrun_bare"。
  assert.match(result.response, /- dwfrun_bare · running/);
});

test("/dwf list and bare /dwf take the same path", async () => {
  const submitPrompt = createHarness({
    listDynamicWorkflowRuns: async () => [run()],
  });

  const bare = await submitPrompt("/dwf", ABORT);
  const explicit = await submitPrompt("/dwf list", ABORT);

  assert.equal(bare.response, explicit.response);
});

test("/dwf list reports an empty session without pretending it is broken", async () => {
  const submitPrompt = createHarness({
    listDynamicWorkflowRuns: async () => [],
  });

  const result = await submitPrompt("/dwf list", ABORT);

  assert.match(result.response, /No dynamic workflow runs in this session\./);
});

test("/dwf list says not available when the capability is absent", async () => {
  const submitPrompt = createHarness({});

  const result = await submitPrompt("/dwf list", ABORT);

  // 能力缺席 ≠ 没有 run：必须区分，否则用户以为工作流丢了。
  assert.match(result.response, /not available in this client/);
});

test("/dwf cancel without a run id cancels the only in-flight run", async () => {
  let cancelledTaskId: string | undefined;
  const submitPrompt = createHarness({
    listDynamicWorkflowRuns: async () => [
      run({ runId: "dwfrun_live", status: "running" }),
      run({ runId: "dwfrun_done", status: "completed" }),
    ],
    cancelBackgroundTask: async (taskId) => {
      cancelledTaskId = taskId;
      return { cancelled: true, status: "cancelled", taskId };
    },
  });

  const result = await submitPrompt("/dwf cancel", ABORT);

  // runId ≡ taskId：终态 run 不是候选，所以唯一在飞的那个被取消。
  assert.equal(cancelledTaskId, "dwfrun_live");
  assert.match(result.response, /Cancelled dynamic workflow run dwfrun_live\./);
});

test("/dwf cancel without a run id lists candidates when several are in flight", async () => {
  let cancelCalled = false;
  const submitPrompt = createHarness({
    listDynamicWorkflowRuns: async () => [
      run({ runId: "dwfrun_a", status: "running" }),
      run({ runId: "dwfrun_b", status: "pending" }),
    ],
    cancelBackgroundTask: async (taskId) => {
      cancelCalled = true;
      return { cancelled: true, status: "cancelled", taskId };
    },
  });

  const result = await submitPrompt("/dwf cancel", ABORT);

  // 多个候选时绝不猜：取消是丢掉的进度，猜错的代价不对称。
  assert.equal(cancelCalled, false);
  assert.match(result.response, /Multiple in-flight dynamic workflow runs/);
  assert.match(result.response, /dwfrun_a · running/);
  assert.match(result.response, /dwfrun_b · pending/);
});

test("/dwf cancel without a run id reports when nothing is in flight", async () => {
  let cancelCalled = false;
  const submitPrompt = createHarness({
    listDynamicWorkflowRuns: async () => [run({ status: "completed" })],
    cancelBackgroundTask: async (taskId) => {
      cancelCalled = true;
      return { cancelled: true, status: "cancelled", taskId };
    },
  });

  const result = await submitPrompt("/dwf cancel", ABORT);

  assert.equal(cancelCalled, false);
  assert.match(result.response, /No in-flight dynamic workflow runs to cancel\./);
});

test("/dwf cancel passes an explicit run id straight through", async () => {
  let cancelledTaskId: string | undefined;
  const submitPrompt = createHarness({
    listDynamicWorkflowRuns: async () => {
      throw new Error("an explicit run id must not need the run list");
    },
    cancelBackgroundTask: async (taskId) => {
      cancelledTaskId = taskId;
      return { cancelled: true, status: "cancelled", taskId };
    },
  });

  const result = await submitPrompt("/dwf cancel dwfrun_named", ABORT);

  assert.equal(cancelledTaskId, "dwfrun_named");
  assert.match(result.response, /Cancelled dynamic workflow run dwfrun_named\./);
});

test("/dwf cancel renders a refused cancellation", async () => {
  const submitPrompt = createHarness({
    cancelBackgroundTask: async (taskId) => ({
      cancelled: false,
      reason: "task already settled",
      status: "completed",
      taskId,
    }),
  });

  const result = await submitPrompt("/dwf cancel dwfrun_gone", ABORT);

  assert.match(result.response, /Could not cancel dwfrun_gone \(completed\): task already settled/);
});

test("/dwf cancel says not available when the capability is absent", async () => {
  const submitPrompt = createHarness({});

  const result = await submitPrompt("/dwf cancel dwfrun_1", ABORT);

  assert.match(result.response, /not available in this client/);
});

test("/dwf resume forwards the run id as workId", async () => {
  let resumedWorkId: string | undefined;
  const submitPrompt = createHarness({
    resumeWorkflowRun: async (input) => {
      resumedWorkId = input.workId;
      return { ok: true, runId: input.workId };
    },
  });

  const result = await submitPrompt("/dwf resume dwfrun_dead", ABORT);

  assert.equal(resumedWorkId, "dwfrun_dead");
  assert.match(result.response, /Resumed dynamic workflow run dwfrun_dead\./);
});

test("/dwf resume renders the server's structured rejection", async () => {
  const submitPrompt = createHarness({
    resumeWorkflowRun: async () => ({ ok: false, reason: "not_resumable" }),
  });

  const result = await submitPrompt("/dwf resume dwfrun_done", ABORT);

  // 服务端裁定原样呈现：友好一行 + 原始 reason code（不按 status 客户端重推导）。
  assert.match(result.response, /Cannot resume dwfrun_done/);
  assert.match(result.response, /only a stopped run can be resumed/);
  assert.match(result.response, /\(not_resumable\)/);
});

test("/dwf resume surfaces every structured reason with its code", async () => {
  const reasons = [
    "not_found",
    "not_resumable",
    "already_running",
    "script_missing",
    "script_mismatch",
    "compile_failed",
  ] as const;

  for (const reason of reasons) {
    const submitPrompt = createHarness({
      resumeWorkflowRun: async () => ({ ok: false, reason }),
    });
    const result = await submitPrompt("/dwf resume dwfrun_1", ABORT);
    assert.match(result.response, new RegExp(`\\(${reason}\\)`));
  }
});

test("/dwf resume compile_failed prints the diagnostics the server attached", async () => {
  const submitPrompt = createHarness({
    resumeWorkflowRun: async () => ({
      ok: false,
      reason: "compile_failed",
      message: "L3:C1 Property 'askWithOldFacade' does not exist",
    }),
  });
  const result = await submitPrompt("/dwf resume dwfrun_1", ABORT);
  assert.match(result.response, /\(compile_failed\)/);
  assert.match(result.response, /AmendWorkflow/);
  assert.match(result.response, /askWithOldFacade/);
});

test("/dwf resume without a run id prints usage", async () => {
  let resumeCalled = false;
  const submitPrompt = createHarness({
    resumeWorkflowRun: async () => {
      resumeCalled = true;
      return { ok: true, runId: "dwfrun_1" };
    },
  });

  const result = await submitPrompt("/dwf resume", ABORT);

  assert.equal(resumeCalled, false);
  assert.match(result.response, /Usage: \/dwf \[list\|cancel \[runId\]\|resume <runId>\]/);
});

test("/dwf resume says not available when the capability is absent", async () => {
  const submitPrompt = createHarness({});

  const result = await submitPrompt("/dwf resume dwfrun_1", ABORT);

  assert.match(result.response, /not available in this client/);
});

test("/dwf rejects an unknown subcommand with usage", async () => {
  const submitPrompt = createHarness({
    listDynamicWorkflowRuns: async () => [run()],
  });

  const result = await submitPrompt("/dwf status", ABORT);

  // 刻意不做 /dwf status：GetWorkflowRun 是模型工具，用户问模型即可。
  assert.match(result.response, /Usage: \/dwf/);
});

test("the slash command registry knows /dwf and /workflow and has dropped /workflows", () => {
  const dwf = parseSlashCommand("/dwf list");
  assert.equal(dwf?.type, "known");
  assert.equal(dwf?.type === "known" ? dwf.name : undefined, "dwf");

  // legacy `/workflows` 命名空间整体移除（面板机器随之删除）。`/workflow` 不是它的残留：
  // 它是与 `/init` 同路的内置 prompt 命令（docs/design/v2/commands.md），名字由 TUI 识别、
  // 正文由 bootstrap 展开。
  assert.equal(parseSlashCommand("/workflow")?.type, "known");
  assert.equal(parseSlashCommand("/workflows")?.type, "unknown");

  const names = listSlashCommandSuggestions().map((entry) => entry.name);
  assert.ok(names.includes("dwf"), "/dwf must be suggestible in the composer");
  assert.ok(names.includes("workflow"), "/workflow is a builtin and must be suggestible");
  assert.ok(!names.includes("workflows"));
  // /expert 是另一套 legacy 面，本轮不动。
  assert.ok(names.includes("expert"));
});
