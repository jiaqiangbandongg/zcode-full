import { describe, expect, it } from "vitest";
import { parseZCodeBackgroundBashJobs } from "../src/background-bash-jobs.js";
import { mergeZCodeBackgroundTaskControlItems } from "../src/background-task-control-merge.js";
import { parseZCodeBackgroundTaskControlItems } from "../src/background-task-controls.js";

describe("background bash jobs", () => {
  it("后台 Bash 取消 ID 优先使用 protocol taskId", () => {
    const jobs = parseZCodeBackgroundBashJobs([
      {
        taskId: "exec_background_123",
        id: "call_like_generic_id",
        toolCallId: "call_00_abc",
        toolName: "Bash",
        command: "node background-ticker.js",
        status: "running",
        pid: 5542,
      },
    ]);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      jobId: "exec_background_123",
      toolCallId: "call_00_abc",
      command: "node background-ticker.js",
      taskKind: "bash",
      status: "running",
      pid: 5542,
    });
  });

  it("Bash-only parser does not include background Agent tasks", () => {
    const jobs = parseZCodeBackgroundBashJobs([
      {
        taskId: "agent_background_123",
        toolCallId: "call_agent_00",
        toolName: "Agent",
        description: "Review the branch",
        status: "running",
      },
    ]);

    expect(jobs).toEqual([]);
  });

  it("parses running background Agent tasks for the shared background control surface", () => {
    const jobs = parseZCodeBackgroundTaskControlItems([
      {
        taskId: "agent_background_123",
        toolCallId: "call_agent_00",
        toolName: "Agent",
        description: "Review the branch",
        status: "running",
        outputPath: "/tmp/agent/output.txt",
      },
    ]);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      jobId: "agent_background_123",
      toolCallId: "call_agent_00",
      command: "Review the branch",
      title: "Review the branch",
      status: "running",
      taskKind: "agent",
    });
  });

  it("accepts already-normalized background task control items", () => {
    const jobs = parseZCodeBackgroundTaskControlItems([
      {
        jobId: "agent_normalized_123",
        taskKind: "agent",
        command: "Review the branch",
        status: "running",
        cancellable: true,
      },
    ]);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      jobId: "agent_normalized_123",
      command: "Review the branch",
      status: "running",
      taskKind: "agent",
      cancellable: true,
    });
  });

  it("does not classify generic task records as background Agent tasks", () => {
    const jobs = parseZCodeBackgroundTaskControlItems([
      {
        taskId: "generic_task_123",
        type: "task",
        description: "Generic task record, not a background Agent control item",
        status: "running",
      },
    ]);

    expect(jobs).toEqual([]);
  });

  it("does not classify generic background_task records without explicit task kind", () => {
    const jobs = parseZCodeBackgroundTaskControlItems([
      {
        taskId: "background_task_123",
        type: "background_task",
        command: "sleep 30",
        status: "running",
      },
    ]);

    expect(jobs).toEqual([]);
  });

  it("preserves cancellable capability for explicit Bash background controls", () => {
    const jobs = parseZCodeBackgroundTaskControlItems([
      {
        taskId: "background_task_unsupported",
        type: "background_task",
        toolName: "Bash",
        command: "workflow run long-task",
        status: "running",
        cancellable: false,
      },
    ]);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      cancellable: false,
      jobId: "background_task_unsupported",
      status: "running",
    });
  });

  it("normalizes terminal protocol statuses for shared controls", () => {
    const jobs = parseZCodeBackgroundTaskControlItems([
      {
        taskId: "background_task_timeout",
        toolName: "Bash",
        command: "sleep 999",
        status: "timed_out",
      },
      {
        taskId: "background_task_spawn_error",
        toolName: "Bash",
        command: "missing-command",
        status: "spawn_error",
      },
    ]);

    expect(jobs).toEqual([
      expect.objectContaining({
        jobId: "background_task_timeout",
        status: "killed",
      }),
      expect.objectContaining({
        jobId: "background_task_spawn_error",
        status: "failed",
      }),
    ]);
  });

  it("merges partial background task control updates by job id", () => {
    const merged = mergeZCodeBackgroundTaskControlItems(
      [
        {
          jobId: "background_task_1",
          command: "sleep 1",
          taskKind: "bash",
          status: "running",
        },
        {
          jobId: "background_task_2",
          command: "Review branch",
          taskKind: "agent",
          status: "running",
        },
      ],
      [
        {
          jobId: "background_task_1",
          command: "sleep 1",
          taskKind: "bash",
          status: "completed",
          outputTail: "done",
        },
      ],
    );

    expect(merged).toEqual([
      expect.objectContaining({
        jobId: "background_task_1",
        status: "completed",
        outputTail: "done",
      }),
      expect.objectContaining({
        jobId: "background_task_2",
        status: "running",
      }),
    ]);
  });
});
