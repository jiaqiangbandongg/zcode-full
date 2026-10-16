import {
  CoreErrorType,
  SUBMIT_RESULT_TOOL_NAME,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
  isCoreError,
  type SubmitResultRequest,
  type WorkflowSubmitPort,
} from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createToolExecutor } from "../src/tool/executor.js";
import { withTerminalToolTurnStop } from "../src/tool/executor/turn-control.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import {
  createSubmitResultToolEntry,
  submitResultToolEntry,
} from "../src/tool/handlers/submit-result.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolEntry, ToolExecutionContext, ToolExecutionResult } from "../src/tool/types.js";

function acceptPort(): WorkflowSubmitPort {
  return { respond: async () => ({ accept: true }) };
}

function toolContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    sessionId: "sess_submit_result" as never,
    toolCallId: "tool_submit_result",
    traceId: "trace_submit_result" as never,
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
    ...overrides,
  };
}

function submitExecutor(port: WorkflowSubmitPort | undefined) {
  const sessionId = createSessionId("submit-result-exec");
  const turnId = createTurnId("submit-result-exec");
  const traceContext = createRootTraceContext({ sessionId, turnId });
  const registry = createToolRegistry();
  registry.register(submitResultToolEntry);
  const executor = createToolExecutor({
    emitEvent: async () => undefined,
    permissionService: new PermissionService(defaultPermissionConfig),
    registry,
    workflowSubmitPort: port,
    sessionId,
    turnId,
    traceContext,
  });
  return { executor, traceContext };
}

describe("submit_result handler", () => {
  it("throws a non-recoverable ConfigurationError when no submit port is configured", async () => {
    let caught: unknown;
    try {
      await submitResultToolEntry.handler({ result: { ok: true } }, toolContext());
    } catch (error) {
      caught = error;
    }
    expect(isCoreError(caught)).toBe(true);
    if (!isCoreError(caught)) throw new Error("expected a core error");
    expect(caught.type).toBe(CoreErrorType.ConfigurationError);
    expect(caught.recoverable).toBe(false);
  });

  it("forwards toolCallId, result and trace to the port and returns accepted on accept", async () => {
    const seen: SubmitResultRequest[] = [];
    const port: WorkflowSubmitPort = {
      respond: async (request) => {
        seen.push(request);
        return { accept: true };
      },
    };
    const result = { title: "done", items: [1, 2] };

    const output = await submitResultToolEntry.handler(
      { result },
      toolContext({ workflowSubmitPort: port, toolCallId: "call_42" }),
    );

    expect(output).toEqual({ status: "accepted" });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.toolCallId).toBe("call_42");
    expect(seen[0]?.result).toEqual(result);
    expect(seen[0]?.trace.traceId).toBe("trace_submit_result");
  });

  it("returns a tool-handler failure carrying the violation list on reject", async () => {
    const port: WorkflowSubmitPort = {
      respond: async () => ({
        accept: false,
        violations: [
          { path: "$.title", expected: "string", got: "number" },
          { path: "$.items", expected: "array", got: "undefined" },
        ],
      }),
    };

    const output = await submitResultToolEntry.handler(
      { result: { title: 1 } },
      toolContext({ workflowSubmitPort: port }),
    );

    expect(output).toMatchObject({ result: false, errorCode: 1 });
    const message = (output as { message: string }).message;
    expect(message).toContain("$.title: expected string, got number");
    expect(message).toContain("$.items: expected array, got undefined");
  });
});

describe("submit_result executor surface", () => {
  it("stops the turn after an accepted submit via subagent_terminal turn control", async () => {
    const { executor, traceContext } = submitExecutor(acceptPort());

    const result = await executor.execute(
      {
        id: createToolCallId("submit-accept"),
        input: { result: { ok: true } },
        name: SUBMIT_RESULT_TOOL_NAME,
      },
      { traceContext },
    );

    expect(result.success).toBe(true);
    expect(result.turnControl).toEqual({
      reason: "subagent_terminal",
      stopTurnAfterResult: true,
    });
    // subagent_terminal 走 turn-tools 的默认 stop（break）分支，而不是 automation_create_limit
    // 的纯文本续写分支——它只对 automation_create_limit 特判。
    expect(result.turnControl?.reason).not.toBe("automation_create_limit");
  });

  it("does not stop the turn on reject and surfaces violations as the error tool_result", async () => {
    const port: WorkflowSubmitPort = {
      respond: async () => ({
        accept: false,
        violations: [{ path: "$.title", expected: "string", got: "number" }],
      }),
    };
    const { executor, traceContext } = submitExecutor(port);

    const result = await executor.execute(
      {
        id: createToolCallId("submit-reject"),
        input: { result: { title: 1 } },
        name: SUBMIT_RESULT_TOOL_NAME,
      },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.turnControl).toBeUndefined();
    expect(result.modelContent).toBe(
      "<tool_use_error>The submitted result does not match the required schema:\n" +
        "$.title: expected string, got number</tool_use_error>",
    );
  });

  it("fails with ConfigurationError through the executor when the port is absent", async () => {
    const { executor, traceContext } = submitExecutor(undefined);

    const result = await executor.execute(
      {
        id: createToolCallId("submit-no-port"),
        input: { result: {} },
        name: SUBMIT_RESULT_TOOL_NAME,
      },
      { traceContext },
    );

    expect(result.success).toBe(false);
    expect(result.turnControl).toBeUndefined();
    expect(result.error?.type).toBe(CoreErrorType.ConfigurationError);
  });
});

describe("submit_result registration gate", () => {
  it("registers submit_result only when includeSubmitResult is set", () => {
    const withPort = createToolRegistry();
    registerBuiltInTools(withPort, { includeSubmitResult: true });
    expect(withPort.has(SUBMIT_RESULT_TOOL_NAME)).toBe(true);

    const withoutPort = createToolRegistry();
    registerBuiltInTools(withoutPort, {});
    expect(withoutPort.has(SUBMIT_RESULT_TOOL_NAME)).toBe(false);
  });

  it("declares submit_result as a terminal-on-success tool via metadata", () => {
    expect(submitResultToolEntry.metadata.stopTurnOnSuccess).toBe(true);
  });
});

describe("withTerminalToolTurnStop", () => {
  const success = {
    toolCallId: "t",
    toolName: "any",
    success: true,
    output: null,
  } as ToolExecutionResult;

  function entryWith(stopTurnOnSuccess?: boolean): ToolEntry {
    return { metadata: { stopTurnOnSuccess } } as unknown as ToolEntry;
  }

  it("stops the turn on success only when the entry declares stopTurnOnSuccess", () => {
    expect(withTerminalToolTurnStop(success, { entry: entryWith(true) }).turnControl).toEqual({
      reason: "subagent_terminal",
      stopTurnAfterResult: true,
    });
    // 键入 metadata 声明而非工具名：未声明的工具永不因成功而终止 turn。
    expect(withTerminalToolTurnStop(success, { entry: entryWith(false) }).turnControl).toBeUndefined();
    expect(
      withTerminalToolTurnStop(success, { entry: entryWith(undefined) }).turnControl,
    ).toBeUndefined();
  });

  it("never stops a failed result even for a terminal tool", () => {
    const failed = { ...success, success: false } as ToolExecutionResult;
    expect(withTerminalToolTurnStop(failed, { entry: entryWith(true) }).turnControl).toBeUndefined();
  });
});

// typed 声明（docs/execution-engine.md「Typed asks and `submit_result`」）：
// 只有 provider 可见的声明与 strict 资格不同，其余逐字节相同。
describe("submit_result typed entry", () => {
  const REVIEW = {
    type: "object",
    properties: { ok: { type: "boolean" }, notes: { type: "string" } },
    required: ["ok"],
    additionalProperties: false,
  };

  it("declares { result: schema } and strict eligibility, sharing everything else with the generic entry", () => {
    const typed = createSubmitResultToolEntry(REVIEW);
    expect(typed.metadata.name).toBe(SUBMIT_RESULT_TOOL_NAME);
    expect(typed.strict).toBe(true);
    expect(typed.inputSchema.required).toEqual(["result"]);
    expect(typed.inputSchema.additionalProperties).toBe(false);
    expect((typed.inputSchema.properties as Record<string, unknown>).result).toMatchObject(REVIEW);
    // 运行时 zod 校验、handler、权限、终止语义与通用条目相同。
    expect(typed.runtimeInputSchema).toBe(submitResultToolEntry.runtimeInputSchema);
    expect(typed.handler).toBe(submitResultToolEntry.handler);
    expect(typed.permission).toEqual(submitResultToolEntry.permission);
    expect(typed.metadata.stopTurnOnSuccess).toBe(true);
    expect(typed.metadata.concurrentSafe).toBe(false);
    // 通用条目不声明 strict：任意 JSON 的 result 在严格子集里表达不了，也不该被约束。
    expect(submitResultToolEntry.strict).toBeUndefined();
    expect(
      (submitResultToolEntry.inputSchema.properties as Record<string, Record<string, unknown>>)
        .result.type,
    ).toBeUndefined();
  });

  it("registers the typed entry when registerBuiltInTools is given a submitResultSchema", () => {
    const registry = createToolRegistry();
    registerBuiltInTools(registry, { includeSubmitResult: true, submitResultSchema: REVIEW });
    const contract = registry.toContracts().find((tool) => tool.name === SUBMIT_RESULT_TOOL_NAME);
    expect(contract?.strict).toBe(true);
    expect((contract?.inputSchema.properties as Record<string, unknown>).result).toMatchObject(
      REVIEW,
    );
  });

  it("registers the generic entry (no strict) without a schema, and nothing without the gate", () => {
    const generic = createToolRegistry();
    registerBuiltInTools(generic, { includeSubmitResult: true });
    const contract = generic.toContracts().find((tool) => tool.name === SUBMIT_RESULT_TOOL_NAME);
    expect(contract).toBeDefined();
    expect(contract?.strict).toBeUndefined();

    // schema 在场但门没开：仍然不注册——端口才是门。
    const gated = createToolRegistry();
    registerBuiltInTools(gated, { submitResultSchema: REVIEW });
    expect(gated.has(SUBMIT_RESULT_TOOL_NAME)).toBe(false);
  });

  it("the typed entry still accepts any JSON at the executor boundary (per-ask shape is the engine's job)", async () => {
    const typed = createSubmitResultToolEntry(REVIEW);
    // 与 schema 不符的 payload 也照常交给端口：形状违规由引擎裁决并作为可修复的 tool_result 回来。
    const seen: unknown[] = [];
    const port: WorkflowSubmitPort = {
      respond: async (request) => {
        seen.push(request.result);
        return { accept: true };
      },
    };
    const output = await typed.handler(
      { result: { unrelated: 1 } },
      toolContext({ workflowSubmitPort: port }),
    );
    expect(output).toEqual({ status: "accepted" });
    expect(seen).toEqual([{ unrelated: 1 }]);
  });
});
