import { describe, expect, it } from "vitest";
import {
  HookEventName,
  SessionEventType,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  type SessionEvent,
} from "@zcode/contracts";
import { createInMemoryHookRunner } from "../src/hooks/index.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolEntry, ToolHandler } from "../src/tool/types.js";

describe("ToolExecutor hook additional context", () => {
  it("adds PreToolUse hook context to successful model content", async () => {
    const fixture = createExecutorFixture("tool-hook-pre-context");
    fixture.registry.register(createTestToolEntry("ContextTool", async () => "tool-output"));
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: HookEventName.PreToolUse,
          matcher: "ContextTool",
          callback: async (input) => ({
            hookSpecificOutput: {
              additionalContext: "pre-tool context",
              hookEventName: input.hookEventName,
            },
          }),
        },
      ],
    });
    const executor = fixture.createExecutor(hookRunner);

    const result = await executor.execute(
      {
        id: createToolCallId("pre-context"),
        input: {},
        name: "ContextTool",
      },
      { traceContext: fixture.traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.modelContent).toContain("tool-output");
    expect(result.modelContent).toContain("pre-tool context");
  });

  it("adds PreToolUse and PostToolUseFailure hook context to failed model content", async () => {
    const fixture = createExecutorFixture("tool-hook-failure-context");
    fixture.registry.register(
      createTestToolEntry("FailingContextTool", async () => {
        throw new Error("tool exploded");
      }),
    );
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: HookEventName.PreToolUse,
          matcher: "FailingContextTool",
          callback: async (input) => ({
            hookSpecificOutput: {
              additionalContext: "pre failure context",
              hookEventName: input.hookEventName,
            },
          }),
        },
        {
          event: HookEventName.PostToolUseFailure,
          matcher: "FailingContextTool",
          callback: async (input) => ({
            hookSpecificOutput: {
              additionalContext: "post failure context",
              hookEventName: input.hookEventName,
            },
          }),
        },
      ],
    });
    const executor = fixture.createExecutor(hookRunner);

    const result = await executor.execute(
      {
        id: createToolCallId("pre-failure-context"),
        input: {},
        name: "FailingContextTool",
      },
      { traceContext: fixture.traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.modelContent).toContain("tool exploded");
    expect(result.modelContent).toContain("pre failure context");
    expect(result.modelContent).toContain("post failure context");
  });

  it("keeps PreToolUse context when hook-updated input fails schema validation", async () => {
    const fixture = createExecutorFixture("tool-hook-invalid-update-context");
    let handlerRan = false;
    const entry = createTestToolEntry("InvalidHookUpdateTool", async () => {
      handlerRan = true;
      return "should-not-run";
    });
    entry.inputSchema = {
      additionalProperties: false,
      properties: { value: { type: "string" } },
      required: ["value"],
      type: "object",
    };
    fixture.registry.register(entry);
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: HookEventName.PreToolUse,
          matcher: "InvalidHookUpdateTool",
          callback: async (input) => ({
            hookSpecificOutput: {
              additionalContext: "invalid update context",
              hookEventName: input.hookEventName,
              updatedInput: {},
            },
          }),
        },
      ],
    });

    const result = await fixture.createExecutor(hookRunner).execute(
      {
        id: createToolCallId("invalid-hook-update-context"),
        input: { value: "valid-before-hook" },
        name: "InvalidHookUpdateTool",
      },
      { traceContext: fixture.traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain("Tool input failed inputSchema validation");
    expect(result.modelContent).toContain("invalid update context");
    expect(result.modelContent).not.toContain("InputValidationError:");
    expect(handlerRan).toBe(false);
  });

  it("routes a handler failure through the existing failure lifecycle", async () => {
    const fixture = createExecutorFixture("tool-handler-failure");
    let handlerCalls = 0;
    let postSuccessRan = false;
    let postFailureRan = false;
    fixture.registry.register(
      createTestToolEntry("HandlerFailureTool", async () => {
        handlerCalls += 1;
        return {
          result: false,
          errorCode: 7,
          message: "Tool-specific failure",
        };
      }),
    );
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: HookEventName.PreToolUse,
          matcher: "HandlerFailureTool",
          callback: async (input) => ({
            hookSpecificOutput: {
              additionalContext: "pre failure context",
              hookEventName: input.hookEventName,
            },
          }),
        },
        {
          event: HookEventName.PostToolUse,
          matcher: "HandlerFailureTool",
          callback: async () => {
            postSuccessRan = true;
            return {};
          },
        },
        {
          event: HookEventName.PostToolUseFailure,
          matcher: "HandlerFailureTool",
          callback: async (input) => {
            postFailureRan = true;
            return {
              hookSpecificOutput: {
                additionalContext: "post failure context",
                hookEventName: input.hookEventName,
              },
            };
          },
        },
      ],
    });

    const result = await fixture.createExecutor(hookRunner).execute(
      {
        id: createToolCallId("handler-failure"),
        input: {},
        name: "HandlerFailureTool",
      },
      { traceContext: fixture.traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatchObject({
      code: "7",
      message: "Tool-specific failure",
    });
    expect(result.modelContent).toContain("<tool_use_error>Tool-specific failure</tool_use_error>");
    expect(result.modelContent).toContain("pre failure context");
    expect(result.modelContent).toContain("post failure context");
    expect(handlerCalls).toBe(1);
    expect(postSuccessRan).toBe(false);
    expect(postFailureRan).toBe(true);
    expect(fixture.events.map((event) => event.type)).toEqual([
      SessionEventType.ToolCallStarted,
      SessionEventType.ToolCallError,
    ]);
  });

  it("records non-blocking PostToolUse continue false without failing the tool", async () => {
    const fixture = createExecutorFixture("tool-hook-post-continue-false");
    const events: SessionEvent[] = [];
    let handlerRan = false;
    fixture.registry.register(
      createTestToolEntry("PostContinueTool", async () => {
        handlerRan = true;
        return "tool-output";
      }),
    );
    const hookRunner = createInMemoryHookRunner({
      emitEvent: async (event) => {
        events.push(event);
      },
      hooks: [
        {
          event: HookEventName.PostToolUse,
          matcher: "PostContinueTool",
          callback: async (input) => ({
            continue: false,
            reason: "post hook requested stop",
            hookSpecificOutput: {
              hookEventName: input.hookEventName,
            },
          }),
        },
      ],
    });
    const executor = fixture.createExecutor(hookRunner);

    const result = await executor.execute(
      {
        id: createToolCallId("post-continue-false"),
        input: {},
        name: "PostContinueTool",
      },
      { traceContext: fixture.traceContext },
    );

    expect(result.success).toBe(true);
    expect(handlerRan).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      // D20：block 决策只产生一个终态事件（runner.ts:143 为 blocked ? Blocked : Completed）。
      // 此前同时断言 Completed + Blocked，会让「被拦截」在 UI 上呈现为已完成绿勾。
      SessionEventType.HookRunStarted,
      SessionEventType.HookRunBlocked,
    ]);
  });

  it("matches Task hook matcher aliases without rewriting the Agent hook input", async () => {
    const fixture = createExecutorFixture("tool-hook-task-agent-alias");
    fixture.registry.register(createTestToolEntry("Agent", async () => "agent-output"));
    let observedToolName: string | undefined;
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: HookEventName.PreToolUse,
          matcher: "Task",
          callback: async (input) => {
            observedToolName = "toolName" in input ? input.toolName : undefined;
            return {
              hookSpecificOutput: {
                additionalContext: "task matcher matched agent",
                hookEventName: input.hookEventName,
              },
            };
          },
        },
      ],
    });
    const executor = fixture.createExecutor(hookRunner);

    const result = await executor.execute(
      {
        id: createToolCallId("agent-task-matcher"),
        input: {},
        name: "Agent",
      },
      { traceContext: fixture.traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.modelContent).toContain("task matcher matched agent");
    expect(observedToolName).toBe("Agent");
  });

  it("matches Agent hook matcher aliases without rewriting the Task hook input", async () => {
    const fixture = createExecutorFixture("tool-hook-agent-task-alias");
    fixture.registry.register(createTestToolEntry("Task", async () => "task-output"));
    let observedToolName: string | undefined;
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          event: HookEventName.PreToolUse,
          matcher: "Agent",
          callback: async (input) => {
            observedToolName = "toolName" in input ? input.toolName : undefined;
            return {
              hookSpecificOutput: {
                additionalContext: "agent matcher matched task",
                hookEventName: input.hookEventName,
              },
            };
          },
        },
      ],
    });
    const executor = fixture.createExecutor(hookRunner);

    const result = await executor.execute(
      {
        id: createToolCallId("task-agent-matcher"),
        input: {},
        name: "Task",
      },
      { traceContext: fixture.traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.modelContent).toContain("agent matcher matched task");
    expect(observedToolName).toBe("Task");
  });
});

function createExecutorFixture(sessionName: string) {
  const sessionId = createSessionId(sessionName);
  const turnId = createTurnId("tool-hook-context-turn");
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const registry = createToolRegistry();
  const events: SessionEvent[] = [];
  return {
    events,
    registry,
    traceContext,
    createExecutor(hookRunner: ReturnType<typeof createInMemoryHookRunner>) {
      return createToolExecutor({
        emitEvent: async (event) => {
          events.push(event);
        },
        hookRunner,
        permissionService: new PermissionService(defaultPermissionConfig),
        registry,
        sessionId,
        traceContext,
        turnId,
      });
    },
  };
}

function createTestToolEntry(name: string, handler: ToolHandler): ToolEntry {
  return {
    capability: `${name} test capability`,
    handler,
    inputSchema: {
      additionalProperties: true,
      type: "object",
    },
    metadata: {
      concurrentSafe: true,
      destructive: false,
      name,
      needsApproval: false,
      readOnly: true,
      riskLevel: "low",
      sideEffectScope: "none",
      timeoutMs: 30000,
    },
    outputSchema: {
      type: "string",
    },
    permission: {
      denyPriority: "beforeAsk",
      needsApproval: false,
      patternSources: ["none"],
      permission: "test",
      reason: "test tool",
      riskLevel: "low",
      sideEffectScope: "none",
    },
    resultBudget: {
      maxInlineBytes: 100_000,
      maxModelBytes: 100_000,
      strategy: "truncate",
    },
  };
}
