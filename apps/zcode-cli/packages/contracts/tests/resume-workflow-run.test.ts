import { describe, expect, it } from "vitest";
import {
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  ResumeWorkflowRunInputJsonSchema,
  ResumeWorkflowRunInputSchema,
  ResumeWorkflowRunOutputJsonSchema,
  ResumeWorkflowRunOutputSchema,
} from "../src/tools/resume-workflow-run.js";

// 成功输出只有一个形状：run 恢复后在后台飞行，携勿轮询引导。失败走 ToolHandlerFailure
// 不进输出 schema，所以这里没有失败形用例（handler 侧的测试钉那五条 reason）。
const BACKGROUNDED = {
  ok: true,
  runId: "dwfrun-1",
  response: "The workflow run resumed in the background with ID: dwfrun-1.",
  status: "backgrounded" as const,
  backgroundTaskId: "dwfrun-1",
};

describe("ResumeWorkflowRun input schema", () => {
  it("names the tool exactly as it registers", () => {
    expect(RESUME_WORKFLOW_RUN_TOOL_NAME).toBe("ResumeWorkflowRun");
  });

  // snake_case 随 GetWorkflowRun 的 run_id / TaskOutput 的 task_id：在模型眼里这三个键是
  // 同一族的 run/task 标识，命名风格分叉只会让它在工具之间猜。
  it("requires a non-empty snake_case run_id", () => {
    expect(ResumeWorkflowRunInputSchema.parse({ run_id: "dwfrun-1" })).toEqual({
      run_id: "dwfrun-1",
    });
    expect(ResumeWorkflowRunInputSchema.safeParse({ run_id: "" }).success).toBe(false);
    expect(ResumeWorkflowRunInputSchema.safeParse({}).success).toBe(false);
    expect(ResumeWorkflowRunInputSchema.safeParse({ runId: "dwfrun-1" }).success).toBe(false);
  });

  it("stays strict about unknown keys", () => {
    expect(
      ResumeWorkflowRunInputSchema.safeParse({ run_id: "dwfrun-1", force: true }).success,
    ).toBe(false);
  });

  it("requires run_id as the only property in the model-facing JSON schema", () => {
    const schema = ResumeWorkflowRunInputJsonSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {})).toEqual(["run_id"]);
    expect(schema.required).toEqual(["run_id"]);
  });
});

describe("ResumeWorkflowRun output schema", () => {
  it("roundtrips the backgrounded success shape", () => {
    const parsed = ResumeWorkflowRunOutputSchema.parse(BACKGROUNDED);
    expect(parsed).toEqual(BACKGROUNDED);
  });

  // backgroundTaskId ≡ runId 是取消/查询/通知共用键的恒等式；schema 只钉「在场且非空」，
  // 等值本身由 handler 构造保证（handler 侧测试钉 ===）。
  it("requires every field of the success shape — there is no failure variant here", () => {
    expect(ResumeWorkflowRunOutputSchema.safeParse({ ...BACKGROUNDED, status: "completed" }).success).toBe(
      false,
    );
    expect(
      ResumeWorkflowRunOutputSchema.safeParse({ ...BACKGROUNDED, backgroundTaskId: "" }).success,
    ).toBe(false);
    expect(ResumeWorkflowRunOutputSchema.safeParse({ ok: true, runId: "dwfrun-1" }).success).toBe(
      false,
    );
  });

  it("stays strict about unknown keys", () => {
    expect(ResumeWorkflowRunOutputSchema.safeParse({ ...BACKGROUNDED, extra: 1 }).success).toBe(
      false,
    );
  });

  it("projects the success shape into the model-facing JSON schema", () => {
    const schema = ResumeWorkflowRunOutputJsonSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties ?? {})).toEqual([
      "ok",
      "runId",
      "response",
      "status",
      "backgroundTaskId",
    ]);
    expect(schema.required).toEqual(["ok", "runId", "response", "status", "backgroundTaskId"]);
  });
});
