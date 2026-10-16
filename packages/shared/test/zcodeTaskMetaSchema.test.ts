import { describe, expect, it } from "vitest";
import { zcodeSessionFileSchema } from "../src/validation.js";

describe("zcodeTaskMetaSchema", () => {
  it("会保留 unread 持久化字段", () => {
    const parsed = zcodeSessionFileSchema.parse({
      meta: {
        taskId: "task-schema",
        traceId: "trace-schema",
        title: "Schema roundtrip",
        workspacePath: "/tmp/workspace",
        createdAt: 1,
        updatedAt: 2,
        mode: "default",
        provider: "codex",
        unreadAt: 12,
      },
      messages: [],
    });

    expect(parsed.meta.unreadAt).toBe(12);
  });

  it("会保留 zcode target 持久化字段", () => {
    const parsed = zcodeSessionFileSchema.parse({
      meta: {
        taskId: "task-target",
        traceId: "trace-target",
        title: "Target roundtrip",
        workspacePath: "/tmp/workspace",
        createdAt: 1,
        updatedAt: 2,
        mode: "default",
        provider: "glm",
        target: {
          sessionID: "session-target",
          targetID: "target-1",
          objective: "finish target integration",
          summaryTitle: "Finish target integration",
          status: "active",
          tokenBudget: 1000,
          tokensUsed: 12,
          timeUsedSeconds: 3,
          time: {
            created: 1,
            updated: 2,
          },
        },
      },
      messages: [],
    });

    expect(parsed.meta.target?.objective).toBe("finish target integration");
    expect(parsed.meta.target?.tokensUsed).toBe(12);
  });

  it("兼容旧 task target 缺失 summaryTitle", () => {
    const parsed = zcodeSessionFileSchema.parse({
      meta: {
        taskId: "task-target-legacy",
        traceId: "trace-target-legacy",
        title: "Legacy target",
        workspacePath: "/tmp/workspace",
        createdAt: 1,
        updatedAt: 2,
        mode: "default",
        provider: "glm",
        target: {
          sessionID: "session-target",
          targetID: "target-1",
          objective: "finish target integration",
          status: "complete",
          tokenBudget: null,
          tokensUsed: 12,
          timeUsedSeconds: 3,
          time: {
            created: 1,
            updated: 2,
          },
        },
      },
      messages: [],
    });

    expect(parsed.meta.target?.summaryTitle).toBeNull();
  });

  it("会保留 task 最后失败原因", () => {
    const parsed = zcodeSessionFileSchema.parse({
      meta: {
        taskId: "task-last-error",
        traceId: "trace-last-error",
        title: "Last error roundtrip",
        workspacePath: "/tmp/workspace",
        createdAt: 1,
        updatedAt: 2,
        mode: "default",
        provider: "claude",
        status: "error",
        lastError: {
          code: "EMPTY_REPLY",
          message: "Agent 未产生任何回复，请重试。",
          traceId: "trace-last-error",
          taskId: "task-last-error",
          attribution: {
            source: "runtime",
            reason: "model_config_missing",
          },
        },
      },
      messages: [],
    });

    expect(parsed.meta.lastError).toMatchObject({
      code: "EMPTY_REPLY",
      message: "Agent 未产生任何回复，请重试。",
      attribution: {
        source: "runtime",
        reason: "model_config_missing",
      },
    });
  });

  it("会拒绝非法 zcode target 状态", () => {
    expect(() =>
      zcodeSessionFileSchema.parse({
        meta: {
          taskId: "task-target-invalid",
          traceId: "trace-target-invalid",
          title: "Target invalid",
          workspacePath: "/tmp/workspace",
          createdAt: 1,
          updatedAt: 2,
          mode: "default",
          provider: "glm",
          target: {
            sessionID: "session-target",
            targetID: "target-1",
            objective: "finish target integration",
            summaryTitle: "Finish target integration",
            status: "sleeping",
            tokenBudget: 1000,
            tokensUsed: 12,
            timeUsedSeconds: 3,
            time: {
              created: 1,
              updated: 2,
            },
          },
        },
        messages: [],
      }),
    ).toThrow();
  });
});
