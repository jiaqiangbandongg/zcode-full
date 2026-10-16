// 编译反馈的稿号联接（docs/dynamic-workflow/presentation.md「Compiler feedback」）：行窗口一遍建成，
// 这里穷举「谱系 × 同轮 × 编过即重置 × 无 display 透明 × 跨轮被替代」几条规则。
import { describe, expect, it } from "vitest";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { buildWorkflowDraftByToolCallId } from "@/v4/workflowDraftJoin.js";

let seq = 0;

function workflowRow(options: {
  toolCallId: string;
  turnId?: string;
  toolName?: string;
  runId?: string;
  ok?: boolean;
  status?: string;
  /** 旧快照把 display 放在行顶层；canonical 位置是 output.display（toolCallRowAdapter 同款优先级）。 */
  legacyDisplay?: boolean;
}): ConversationRow {
  seq += 1;
  return {
    rowId: seq,
    turnId: options.turnId ?? "turn-1",
    createdAt: 1_700_000_000_000 + seq,
    createdAtSeq: seq,
    kind: "toolCall",
    toolCallId: options.toolCallId,
    toolName: options.toolName ?? "CreateWorkflow",
    status: options.status ?? "success",
    inputText: "{}",
    input: {
      script: "phase('a')",
      ...(options.runId === undefined ? {} : { run_id: options.runId }),
    },
    ...displayFields(options.ok, options.legacyDisplay === true),
  } as unknown as ConversationRow;
}

function displayFields(ok: boolean | undefined, legacy: boolean): Record<string, unknown> {
  if (ok === undefined) return {};
  const display = {
    kind: "create_workflow",
    ok,
    errorCount: ok ? 0 : 1,
    diagnostics: ok ? [] : [{ line: 1, column: 1, code: 2304, message: "boom" }],
  };
  return legacy ? { display } : { output: { text: "", display } };
}

function otherRow(toolCallId: string, turnId = "turn-1"): ConversationRow {
  seq += 1;
  return {
    rowId: seq,
    turnId,
    createdAt: 1_700_000_000_000 + seq,
    createdAtSeq: seq,
    kind: "toolCall",
    toolCallId,
    toolName: "Read",
    status: "success",
    inputText: "{}",
    input: { file_path: "/a.ts" },
  } as unknown as ConversationRow;
}

describe("buildWorkflowDraftByToolCallId", () => {
  it("同一轮里连续编不过：稿号逐个加一，除最后一稿外都被替代", () => {
    const drafts = buildWorkflowDraftByToolCallId([
      workflowRow({ toolCallId: "a", ok: false }),
      otherRow("read-1"),
      workflowRow({ toolCallId: "b", ok: false }),
      workflowRow({ toolCallId: "c", status: "inputStreaming" }),
    ]);
    expect(drafts.get("a")).toEqual({ ordinal: 1, superseded: true });
    expect(drafts.get("b")).toEqual({ ordinal: 2, superseded: true });
    expect(drafts.get("c")).toEqual({ ordinal: 3, superseded: false });
    // 不是工作流工具的行不进表。
    expect(drafts.has("read-1")).toBe(false);
  });

  it("编过的一稿（display.ok）把谱系清零：下一次提交重新从第 1 稿数起", () => {
    const drafts = buildWorkflowDraftByToolCallId([
      workflowRow({ toolCallId: "a", ok: false }),
      workflowRow({ toolCallId: "b", ok: true }),
      workflowRow({ toolCallId: "c", ok: false }),
    ]);
    expect(drafts.get("b")).toEqual({ ordinal: 2, superseded: true });
    expect(drafts.get("c")).toEqual({ ordinal: 1, superseded: false });
  });

  it("没有 display 的行（待确认、被拒、取消）既不计数也不清零", () => {
    const drafts = buildWorkflowDraftByToolCallId([
      workflowRow({ toolCallId: "a", ok: false }),
      workflowRow({ toolCallId: "b", status: "cancelled" }),
      workflowRow({ toolCallId: "c", ok: false }),
    ]);
    expect(drafts.get("b")).toEqual({ ordinal: 2, superseded: true });
    expect(drafts.get("c")).toEqual({ ordinal: 2, superseded: false });
    expect(drafts.get("a")?.superseded).toBe(true);
  });

  it("新的一轮从第 1 稿数起，但仍然替代上一轮停在那里的草稿", () => {
    const drafts = buildWorkflowDraftByToolCallId([
      workflowRow({ toolCallId: "a", ok: false, turnId: "turn-1" }),
      workflowRow({ toolCallId: "b", ok: false, turnId: "turn-1" }),
      workflowRow({ toolCallId: "c", ok: false, turnId: "turn-2" }),
    ]);
    expect(drafts.get("b")).toEqual({ ordinal: 2, superseded: true });
    expect(drafts.get("c")).toEqual({ ordinal: 1, superseded: false });
  });

  it("修订按前驱 run 各自成谱系，与创建互不相干", () => {
    const drafts = buildWorkflowDraftByToolCallId([
      workflowRow({ toolCallId: "create-1", ok: false }),
      workflowRow({ toolCallId: "amend-x1", toolName: "AmendWorkflow", runId: "run-x", ok: false }),
      workflowRow({ toolCallId: "amend-y1", toolName: "AmendWorkflow", runId: "run-y", ok: false }),
      workflowRow({
        toolCallId: "amend-x2",
        toolName: "AmendWorkflow",
        runId: "run-x",
        status: "inputStreaming",
      }),
    ]);
    expect(drafts.get("create-1")).toEqual({ ordinal: 1, superseded: false });
    expect(drafts.get("amend-x1")).toEqual({ ordinal: 1, superseded: true });
    expect(drafts.get("amend-y1")).toEqual({ ordinal: 1, superseded: false });
    expect(drafts.get("amend-x2")).toEqual({ ordinal: 2, superseded: false });
  });

  it("工具名按 wire 写法归一（create_workflow 也算）；旧快照顶层 display 同样读；非工具行与空窗口不出错", () => {
    const drafts = buildWorkflowDraftByToolCallId([
      { kind: "assistantText", rowId: 1, turnId: "turn-1" } as unknown as ConversationRow,
      workflowRow({ toolCallId: "a", toolName: "create_workflow", ok: false }),
      workflowRow({ toolCallId: "b", ok: false, legacyDisplay: true }),
    ]);
    expect(drafts.get("a")).toEqual({ ordinal: 1, superseded: true });
    expect(drafts.get("b")).toEqual({ ordinal: 2, superseded: false });
    expect(buildWorkflowDraftByToolCallId(undefined).size).toBe(0);
  });
});
