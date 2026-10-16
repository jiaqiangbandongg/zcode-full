import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSessionId, createTurnId, createTraceId, createToolCallId } from "@zcode/contracts";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { resolveSubagentSelection } from "../src/runtime/helpers/subagent-selection.js";
import { createErrorResult } from "../src/tool/executor/errors.js";
import { modelContentForToolResult } from "../src/runtime/helpers/tool-result.js";

describe("Subagent 选择错误经过真实前后台 runner", () => {
  it.each([false, true])("background=%s 的启动失败向父模型保留原因", async (background) => {
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-selection-error-"));
    const events: unknown[] = [];
    const sessionId = createSessionId("selection-error-parent");
    const turnId = createTurnId("selection-error-turn");
    const port = createExploreSubagentPort({
      outputRootDir,
      createAgentId: () => "selection-error-agent",
      emitParentEvent: async (event) => {
        events.push(event);
      },
      runExploreAgent: async () => {
        resolveSubagentSelection({
          profileSelection: {
            providerId: "account:bigmodel-individual-coding-plan",
            modelId: "GLM-5.3",
          },
          resolveSelection: () => ({
            effectiveSelection: null,
            selectionIssue: "reasoning-level-missing",
          }),
        });
        throw new Error("must not start model");
      },
    });
    const request = {
      agentType: "general-purpose",
      description: "selection failure",
      prompt: "unused",
      parentToolCallId: createToolCallId("selection-error-call"),
      sessionId,
      turnId,
      trace: { traceId: createTraceId(), sessionId, turnId },
      workingDirectory: outputRootDir,
      workspaceRoot: outputRootDir,
    };
    try {
      let caught: Error | undefined;
      try {
        await (background ? port.start!(request) : port.run(request));
      } catch (error) {
        caught = error as Error;
      }
      expect(caught?.message).toContain("reasoning-level-missing");
      const result = createErrorResult(
        { id: "selection-error-call", name: "Agent", input: {} } as Parameters<
          typeof createErrorResult
        >[0],
        caught!,
      );
      expect(modelContentForToolResult(result)).toContain("未选择思考档位");
      expect(result.error?.detail).toContain("reason=reasoning-level-missing");
      // 创建前失败不能伪造已启动子任务事件；错误沿本次 Agent 工具失败返回父模型。
      expect(JSON.stringify(events)).not.toContain('"subagent_spawned"');
    } finally {
      await rm(outputRootDir, { recursive: true, force: true });
    }
  });
});
