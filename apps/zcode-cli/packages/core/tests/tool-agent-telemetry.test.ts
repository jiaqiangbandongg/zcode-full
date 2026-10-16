import { describe, expect, it } from "vitest";
import type {
  AgentExecutionTelemetryPort,
  ToolExecutionSpanWriter,
  ToolTraceStart,
} from "@zcode/contracts";
import {
  HookEventName,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
} from "@zcode/contracts";
import { createInMemoryHookRunner } from "../src/hooks/index.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";

describe("ToolExecutor Agent telemetry", () => {
  it("在统一 Executor 边界使用 canonical tool name 包裹完整执行", async () => {
    const lifecycle: string[] = [];
    let start: ToolTraceStart | undefined;
    const sessionId = createSessionId("tool-agent-telemetry");
    const turnId = createTurnId("turn-agent-telemetry");
    const toolCallId = createToolCallId("tool-call-agent-telemetry");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const registry = createToolRegistry();
    registry.register({
      aliases: ["TraceAlias"],
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "TraceCanonical",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => {
        lifecycle.push("handler.execute");
        return "ok";
      },
    });
    const executor = createToolExecutor({
      agentTelemetry: recordingTelemetry(lifecycle, (input) => {
        start = input;
      }),
      agentTelemetryActorKind: "workflow_child",
      emitEvent: async () => {},
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
      traceContext,
    });

    const result = await executor.execute(
      {
        id: toolCallId,
        input: {},
        name: "TraceAlias",
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(start).toMatchObject({
      registeredToolName: "TraceCanonical",
      toolCallId,
    });
    expect(lifecycle).toEqual([
      "tool.start",
      "tool.run",
      "permission:not_required",
      "handler.execute",
      "tool.output_bytes",
      "tool.output_truncated:false",
      "tool.end:completed",
    ]);
  });

  it("在真实序列化边界写入输出大小并正常收口", async () => {
    const lifecycle: string[] = [];
    const sessionId = createSessionId("tool-agent-performance");
    const turnId = createTurnId("turn-agent-performance");
    const registry = createToolRegistry();
    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "BashLike",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => ({
        stdout: "",
        perf: {
          detail: {
            kind: "command",
            command: {
              category: "git",
              count: 1,
              hash: "0123456789abcdef",
              name: "git",
              runMs: 12,
              status: "failed",
              exitCode: 2,
            },
          },
        },
      }),
    });
    const executor = createToolExecutor({
      agentTelemetry: recordingTelemetry(lifecycle, () => {}),
      emitEvent: async () => {},
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
    });

    await executor.execute({
      id: createToolCallId("tool-call-agent-performance"),
      input: {},
      name: "BashLike",
    });

    expect(lifecycle).toEqual(
      expect.arrayContaining([
        "tool.output_bytes",
        "tool.output_truncated:false",
        "tool.end:completed",
      ]),
    );
  });

  it("未注册工具名在远端 Trace 中归入 unknown，业务错误仍保留原名", async () => {
    let start: ToolTraceStart | undefined;
    const sessionId = createSessionId("tool-agent-unknown");
    const turnId = createTurnId("turn-agent-unknown");
    const registry = createToolRegistry();
    const executor = createToolExecutor({
      agentTelemetry: recordingTelemetry([], (input) => {
        start = input;
      }),
      emitEvent: async () => {},
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId,
      turnId,
    });

    const result = await executor.execute({
      id: createToolCallId("tool-call-agent-unknown"),
      input: {},
      name: "untrusted-user-derived-tool-name",
    });

    expect(start?.registeredToolName).toBe("unknown");
    expect(result.success).toBe(false);
    expect(result.toolName).toBe("untrusted-user-derived-tool-name");
  });

  it("工具专属语义校验失败按 validation 显式收口", async () => {
    const lifecycle: string[] = [];
    let handlerCalled = false;
    const registry = createToolRegistry();
    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "SemanticValidationTool",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      validateInput: () => ({
        errorCode: 422,
        message: "semantic input rejected",
        result: false,
      }),
      handler: async () => {
        handlerCalled = true;
        return "unexpected";
      },
    });
    const executor = createToolExecutor({
      agentTelemetry: recordingTelemetry(lifecycle, () => {}),
      emitEvent: async () => {},
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId: createSessionId("tool-agent-semantic-validation"),
      turnId: createTurnId("turn-agent-semantic-validation"),
    });

    const result = await executor.execute({
      id: createToolCallId("tool-call-agent-semantic-validation"),
      input: {},
      name: "SemanticValidationTool",
    });

    expect(result.success).toBe(false);
    expect(handlerCalled).toBe(false);
    expect(lifecycle).toEqual(["tool.start", "tool.run", "tool.fail:validation"]);
  });

  it("进入 handler 前已取消时按 abort_signal 显式收口", async () => {
    const lifecycle: string[] = [];
    const controller = new AbortController();
    controller.abort(new Error("cancel before execution"));
    const registry = createToolRegistry();
    registry.register({
      inputSchema: {},
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "CancelledBeforeHandler",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => "unexpected",
    });
    const executor = createToolExecutor({
      agentTelemetry: recordingTelemetry(lifecycle, () => {}),
      emitEvent: async () => {},
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId: createSessionId("tool-agent-cancelled-before-handler"),
      turnId: createTurnId("turn-agent-cancelled-before-handler"),
    });

    const result = await executor.execute(
      {
        id: createToolCallId("tool-call-agent-cancelled-before-handler"),
        input: {},
        name: "CancelledBeforeHandler",
      },
      { signal: controller.signal },
    );

    expect(result.success).toBe(false);
    expect(lifecycle).toEqual(["tool.start", "tool.run", "tool.cancel:abort_signal"]);
  });

  it("Hook 修改输入后校验失败按 validation 收口并保留诊断上下文", async () => {
    const lifecycle: string[] = [];
    const registry = createToolRegistry();
    registry.register({
      inputSchema: {
        additionalProperties: false,
        properties: { value: { type: "string" } },
        required: ["value"],
        type: "object",
      },
      metadata: {
        concurrentSafe: true,
        destructive: false,
        name: "HookValidationTool",
        needsApproval: false,
        readOnly: true,
        riskLevel: "low",
        sideEffectScope: "none",
      },
      handler: async () => "unexpected",
    });
    const hookRunner = createInMemoryHookRunner({
      hooks: [
        {
          callback: async (input) => ({
            hookSpecificOutput: {
              additionalContext: "hook validation context",
              hookEventName: input.hookEventName,
              updatedInput: {},
            },
          }),
          event: HookEventName.PreToolUse,
          matcher: "HookValidationTool",
        },
      ],
    });
    const executor = createToolExecutor({
      agentTelemetry: recordingTelemetry(lifecycle, () => {}),
      emitEvent: async () => {},
      hookRunner,
      permissionService: new PermissionService(defaultPermissionConfig),
      registry,
      sessionId: createSessionId("tool-agent-hook-validation"),
      turnId: createTurnId("turn-agent-hook-validation"),
    });

    const result = await executor.execute({
      id: createToolCallId("tool-call-agent-hook-validation"),
      input: { value: "valid-before-hook" },
      name: "HookValidationTool",
    });

    expect(result.success).toBe(false);
    expect(result.modelContent).toContain("hook validation context");
    expect(lifecycle).toEqual(["tool.start", "tool.run", "tool.fail:validation"]);
  });

  it("工具执行直接抛出异常时显式失败并原样重新抛出", async () => {
    const lifecycle: string[] = [];
    const failure = new Error("event sink failed");
    const executor = createToolExecutor({
      agentTelemetry: recordingTelemetry(lifecycle, () => {}),
      emitEvent: async () => {
        throw failure;
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry: createToolRegistry(),
      sessionId: createSessionId("tool-agent-reject"),
      turnId: createTurnId("turn-agent-reject"),
    });

    await expect(
      executor.execute({
        id: createToolCallId("tool-call-agent-reject"),
        input: {},
        name: "missing-tool",
      }),
    ).rejects.toBe(failure);

    expect(lifecycle).toEqual(["tool.start", "tool.run", "tool.fail:unhandled"]);
  });

  it("已取消信号下工具执行直接抛出异常时按取消收口", async () => {
    const lifecycle: string[] = [];
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const executor = createToolExecutor({
      agentTelemetry: recordingTelemetry(lifecycle, () => {}),
      emitEvent: async () => {
        throw new Error("event sink failed after cancellation");
      },
      permissionService: new PermissionService(defaultPermissionConfig),
      registry: createToolRegistry(),
      sessionId: createSessionId("tool-agent-cancelled-reject"),
      turnId: createTurnId("turn-agent-cancelled-reject"),
    });

    await expect(
      executor.execute(
        {
          id: createToolCallId("tool-call-agent-cancelled-reject"),
          input: {},
          name: "missing-tool",
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("event sink failed after cancellation");

    expect(lifecycle).toEqual(["tool.start", "tool.run", "tool.cancel:abort_signal"]);
  });
});

function recordingTelemetry(
  lifecycle: string[],
  onToolStart: (input: ToolTraceStart) => void,
): AgentExecutionTelemetryPort {
  return {
    abandonSession() {},
    captureCausation() {
      return undefined;
    },
    startCompaction() {
      return noopCompaction();
    },
    startDetachedOperation() {
      return noopDetached();
    },
    startStep() {
      return noopStep();
    },
    startTool(input) {
      onToolStart(input);
      lifecycle.push("tool.start");
      let ended = false;
      const writer: ToolExecutionSpanWriter = {
        captureCausation: () => undefined,
        finishCancelled(reason) {
          if (ended) return;
          ended = true;
          lifecycle.push(`tool.cancel:${reason}`);
        },
        finishCompleted() {
          if (ended) return;
          ended = true;
          lifecycle.push("tool.end:completed");
        },
        finishDenied(reason) {
          if (ended) return;
          ended = true;
          lifecycle.push(`tool.denied:${reason}`);
        },
        finishFailed(stage) {
          if (ended) return;
          ended = true;
          lifecycle.push(`tool.fail:${stage}`);
        },
        markPermissionRequested() {
          lifecycle.push("permission:requested");
        },
        run<T>(fn: () => T): T {
          lifecycle.push("tool.run");
          try {
            const value = fn();
            if (value && typeof value === "object" && "then" in value) {
              return Promise.resolve(value).catch((error) => {
                writer.finishFailed("unhandled", "unknown");
                throw error;
              }) as T;
            }
            return value;
          } catch (error) {
            writer.finishFailed("unhandled", "unknown");
            throw error;
          }
        },
        setOutputBytes() {
          lifecycle.push("tool.output_bytes");
        },
        setOutputTruncated(value) {
          lifecycle.push(`tool.output_truncated:${value}`);
        },
        setPermissionDecision(decision) {
          lifecycle.push(`permission:${decision}`);
        },
        startCommand: () => noopCommand(),
      };
      return writer;
    },
    startTurn() {
      return noopTurn();
    },
  };
}

function noopBase() {
  return {
    captureCausation: () => undefined,
    run<TResult>(fn: () => TResult): TResult {
      return fn();
    },
  };
}

function noopTurn() {
  return {
    ...noopBase(),
    finishCancelled() {},
    finishCompleted() {},
    finishFailed() {},
  };
}

function noopStep() {
  return {
    ...noopBase(),
    finishCancelled() {},
    finishCompleted() {},
    finishDiscarded() {},
    finishFailed() {},
  };
}

function noopCompaction() {
  return {
    ...noopBase(),
    finishCancelled() {},
    finishCompleted() {},
    finishDiscarded() {},
    finishFailed() {},
    markFallbackSelected() {},
    setInputTokens() {},
    setOutputTokens() {},
  };
}

function noopDetached() {
  return {
    ...noopBase(),
    finishCancelled() {},
    finishCompleted() {},
    finishFailed() {},
    setResultType() {},
  };
}

function noopCommand() {
  return {
    ...noopBase(),
    finishBackgrounded() {},
    finishCancelled() {},
    finishCompleted() {},
    finishFailed() {},
    markFirstOutput() {},
    markTerminationRequested() {},
    setExitCode() {},
    setOutputBytes() {},
    setSignal() {},
    setTimedOut() {},
  };
}
