import { describe, expect, it } from "vitest";
import {
  TASK_OUTPUT_PROVIDER_DESCRIPTION,
  TaskOutputInputJsonSchema,
  TaskOutputInputSchema,
} from "../src/tools/task-output.js";

describe("TaskOutput contracts", () => {
  it("exposes the canonical provider description", () => {
    expect(TASK_OUTPUT_PROVIDER_DESCRIPTION).toBe(
      [
        "DEPRECATED: Background tasks return their output file path in the tool result, and you receive a <task-notification> with the same path when the task completes.",
        "- For bash tasks: prefer using the Read tool on that output file path — it contains stdout/stderr.",
        "- For local_agent tasks: use the Agent tool result directly. Do NOT Read the .output file — it is a symlink to the full subagent conversation transcript (JSONL) and will overflow your context window.",
        "- For remote_agent tasks: prefer using the Read tool on the output file path — it contains the streamed remote session output (same as bash).",
        "",
        "- Retrieves output from a running or completed task (background shell, agent, or remote session)",
        "- Takes a task_id parameter identifying the task",
        "- Returns the task output along with status information",
        "- Use block=true (default) to wait for task completion",
        "- Use block=false for non-blocking check of current status",
        "- Task IDs can be found using the /tasks command",
        "- Works with all task types: background shells, async agents, and remote sessions",
      ].join("\n"),
    );
  });

  it("exposes the canonical provider input schema", () => {
    expect(TaskOutputInputJsonSchema).toEqual({
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "The task ID to get output from",
        },
        block: {
          type: "boolean",
          default: true,
          description: "Whether to wait for completion",
        },
        timeout: {
          type: "number",
          default: 30_000,
          minimum: 0,
          maximum: 600_000,
          description: "Max wait time in ms",
        },
      },
      required: ["task_id", "block", "timeout"],
      additionalProperties: false,
      $schema: "https://json-schema.org/draft/2020-12/schema",
    });
  });

  it("applies defaults and accepts only the supported semantic boolean strings", () => {
    expect(TaskOutputInputSchema.parse({ task_id: "agent_1" })).toEqual({
      task_id: "agent_1",
      block: true,
      timeout: 30_000,
    });
    expect(
      TaskOutputInputSchema.parse({
        task_id: "agent_1",
        block: "false",
        timeout: 0,
      }),
    ).toEqual({
      task_id: "agent_1",
      block: false,
      timeout: 0,
    });
    expect(TaskOutputInputSchema.parse({ task_id: "agent_1", block: "true" }).block).toBe(true);
    expect(
      TaskOutputInputSchema.safeParse({
        task_id: "agent_1",
        block: "1",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields and out-of-range timeout values", () => {
    expect(
      TaskOutputInputSchema.safeParse({
        task_id: "agent_1",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      TaskOutputInputSchema.safeParse({
        task_id: "agent_1",
        timeout: 600_001,
      }).success,
    ).toBe(false);
  });
});
