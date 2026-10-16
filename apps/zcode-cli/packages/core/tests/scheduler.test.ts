// ============================================================
// Test imports
// ============================================================
import { beforeEach, describe, expect, it } from "vitest";
import { ToolScheduler, READ_ONLY_TOOLS } from "../src/tool/scheduler.js";
import type { ToolDependency } from "../src/tool/scheduler.js";
import type { ToolCallId } from "@zcode/contracts";

// -----------------------------------------------
// Tool Scheduler Tests
// -----------------------------------------------

describe("ToolScheduler", () => {
  let scheduler: ToolScheduler;

  beforeEach(() => {
    scheduler = new ToolScheduler();
  });

  it("treats WebSearch as a default read-only concurrent tool", () => {
    expect(READ_ONLY_TOOLS.has("WebSearch")).toBe(true);
  });

  it("does not treat Agent and Task as default read-only concurrent tools", () => {
    expect(READ_ONLY_TOOLS.has("Agent")).toBe(false);
    expect(READ_ONLY_TOOLS.has("Task")).toBe(false);
  });

  describe("basic scheduling", () => {
    it("should handle empty tool list", () => {
      const schedule = scheduler.schedule([]);
      expect(schedule.items).toHaveLength(0);
      expect(schedule.parallelGroups).toHaveLength(0);
    });

    it("should handle single tool", () => {
      const tools: ToolDependency[] = [{ toolCallId: "tool_1" as ToolCallId, dependsOn: [] }];
      const schedule = scheduler.schedule(tools);
      expect(schedule.items).toHaveLength(1);
    });

    it("should detect circular dependencies", () => {
      const tools: ToolDependency[] = [
        { toolCallId: "tool_1" as ToolCallId, dependsOn: ["tool_2" as ToolCallId] },
        { toolCallId: "tool_2" as ToolCallId, dependsOn: ["tool_1" as ToolCallId] },
      ];
      expect(() => scheduler.schedule(tools)).toThrow();
    });
  });

  describe("parallel execution", () => {
    it("should group independent tools in parallel", () => {
      const tools: ToolDependency[] = [
        { toolCallId: "tool_1" as ToolCallId, dependsOn: [] },
        { toolCallId: "tool_2" as ToolCallId, dependsOn: [] },
        { toolCallId: "tool_3" as ToolCallId, dependsOn: [] },
      ];
      const schedule = scheduler.schedule(tools);
      expect(schedule.parallelGroups).toHaveLength(1);
    });

    it("should serialize side-effecting tools between safe batches", () => {
      const tools: ToolDependency[] = [
        {
          toolCallId: "tool_read_1" as ToolCallId,
          toolName: "Read",
          dependsOn: [],
          readOnly: true,
          concurrentSafe: true,
          destructive: false,
          sideEffectScope: "none",
        },
        {
          toolCallId: "tool_write" as ToolCallId,
          toolName: "Write",
          dependsOn: [],
          readOnly: false,
          concurrentSafe: false,
          destructive: false,
          sideEffectScope: "workspace",
        },
        {
          toolCallId: "tool_read_2" as ToolCallId,
          toolName: "Grep",
          dependsOn: [],
          readOnly: true,
          concurrentSafe: true,
          destructive: false,
          sideEffectScope: "none",
        },
      ];

      const schedule = scheduler.schedule(tools);

      expect(schedule.parallelGroups).toEqual([
        ["tool_read_1"],
        ["tool_write"],
        ["tool_read_2"],
      ]);
      expect(schedule.items.map((item) => item.canRunParallel)).toEqual([true, false, true]);
    });

    it("uses subagent metadata to decide whether Agent and Task can run in parallel", () => {
      const explicitlySerializedSchedule = scheduler.schedule([
        {
          toolCallId: "agent_1" as ToolCallId,
          toolName: "Agent",
          dependsOn: [],
          readOnly: true,
          concurrentSafe: false,
          sideEffectScope: "session",
        },
        {
          toolCallId: "task_1" as ToolCallId,
          toolName: "Task",
          dependsOn: [],
          readOnly: true,
          concurrentSafe: false,
          sideEffectScope: "session",
        },
      ]);
      const enabledSchedule = scheduler.schedule([
        {
          toolCallId: "agent_1" as ToolCallId,
          toolName: "Agent",
          dependsOn: [],
          readOnly: true,
          concurrentSafe: true,
          sideEffectScope: "session",
        },
        {
          toolCallId: "task_1" as ToolCallId,
          toolName: "Task",
          dependsOn: [],
          readOnly: true,
          concurrentSafe: true,
          sideEffectScope: "session",
        },
      ]);

      expect(explicitlySerializedSchedule.parallelGroups).toEqual([["agent_1"], ["task_1"]]);
      expect(enabledSchedule.parallelGroups).toEqual([["agent_1", "task_1"]]);
    });
  });

  describe("maxConcurrency", () => {
    it("should split parallel group when exceeding maxConcurrency", () => {
      const schedulerWithLimit = new ToolScheduler({ maxConcurrency: 2 });
      const tools: ToolDependency[] = [
        { toolCallId: "tool_1" as ToolCallId, dependsOn: [] },
        { toolCallId: "tool_2" as ToolCallId, dependsOn: [] },
        { toolCallId: "tool_3" as ToolCallId, dependsOn: [] },
        { toolCallId: "tool_4" as ToolCallId, dependsOn: [] },
        { toolCallId: "tool_5" as ToolCallId, dependsOn: [] },
      ];
      const schedule = schedulerWithLimit.schedule(tools);

      // With maxConcurrency=2, 5 tools should be split into 3 groups: [2, 2, 1]
      expect(schedule.parallelGroups).toHaveLength(3);
      expect(schedule.parallelGroups[0]).toHaveLength(2);
      expect(schedule.parallelGroups[1]).toHaveLength(2);
      expect(schedule.parallelGroups[2]).toHaveLength(1);
    });

    it("should respect custom maxConcurrency of 1", () => {
      const schedulerWithLimit = new ToolScheduler({ maxConcurrency: 1 });
      const tools: ToolDependency[] = [
        { toolCallId: "tool_1" as ToolCallId, dependsOn: [] },
        { toolCallId: "tool_2" as ToolCallId, dependsOn: [] },
        { toolCallId: "tool_3" as ToolCallId, dependsOn: [] },
      ];
      const schedule = schedulerWithLimit.schedule(tools);

      // With maxConcurrency=1, all tools should be serialized
      expect(schedule.parallelGroups).toHaveLength(3);
      expect(schedule.parallelGroups[0]).toHaveLength(1);
      expect(schedule.parallelGroups[1]).toHaveLength(1);
      expect(schedule.parallelGroups[2]).toHaveLength(1);
    });

    it("should not split when tool count equals maxConcurrency", () => {
      const schedulerWithLimit = new ToolScheduler({ maxConcurrency: 3 });
      const tools: ToolDependency[] = [
        { toolCallId: "tool_1" as ToolCallId, dependsOn: [] },
        { toolCallId: "tool_2" as ToolCallId, dependsOn: [] },
        { toolCallId: "tool_3" as ToolCallId, dependsOn: [] },
      ];
      const schedule = schedulerWithLimit.schedule(tools);

      // With maxConcurrency=3 and exactly 3 tools, should be one group
      expect(schedule.parallelGroups).toHaveLength(1);
      expect(schedule.parallelGroups[0]).toHaveLength(3);
    });

    it("should default to maxConcurrency=10", () => {
      const defaultScheduler = new ToolScheduler();
      const tools: ToolDependency[] = Array.from({ length: 15 }, (_, i) => ({
        toolCallId: `tool_${i}` as ToolCallId,
        dependsOn: [],
      }));
      const schedule = defaultScheduler.schedule(tools);

      // Default maxConcurrency is 10, so 15 tools should be [10, 5]
      expect(schedule.parallelGroups).toHaveLength(2);
      expect(schedule.parallelGroups[0]).toHaveLength(10);
      expect(schedule.parallelGroups[1]).toHaveLength(5);
    });
  });
});
