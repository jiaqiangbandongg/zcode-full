import { describe, expect, it, vi } from "vitest";
import {
  createMessageId,
  createPartId,
  createRootTraceContext,
  createSessionId,
  createToolCallId,
  createTurnId,
} from "@zcode/contracts";
import type { Logger, ModelSelection, ToolCall } from "../src/runtime/deps.js";
import {
  normalizeModelToolCallsForRuntime,
  requireRuntimeToolCallName,
} from "../src/runtime/helpers/model-tool-call-validation.js";
import { persistPendingToolPart } from "../src/runtime/methods/tool-part-persistence.js";

describe("model tool call validation", () => {
  it("trims model tool names before runtime execution", () => {
    const context = createValidationContext();

    const toolCalls = normalizeModelToolCallsForRuntime(
      [
        {
          id: "call_read",
          input: {},
          name: "  Read  ",
        },
      ],
      context,
    );

    expect(toolCalls).toEqual([
      {
        id: "call_read",
        input: {},
        name: "Read",
      },
    ]);
  });

  it.each(["", "   "])("preserves recoverable model tool name %j", (name) => {
    const logger = createTestLogger();
    const context = createValidationContext({ logger });

    expect(
      normalizeModelToolCallsForRuntime(
        [
          {
            id: "call_empty",
            input: {},
            name,
          },
        ],
        context,
      ),
    ).toEqual([{ id: "call_empty", input: {}, name }]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    { id: "call_provider_empty", name: "", providerExecuted: true },
    { id: "", name: "", providerExecuted: false },
    { id: "call_missing", name: undefined, providerExecuted: false },
    { id: "call_null", name: null, providerExecuted: false },
    { id: "call_number", name: 42, providerExecuted: false },
    { id: "call_object", name: {}, providerExecuted: false },
  ])("rejects non-recoverable model tool identity %#", (toolCall) => {
    const logger = createTestLogger();
    const context = createValidationContext({ logger });

    expect(() =>
      normalizeModelToolCallsForRuntime([{ ...toolCall, input: {} }] as never, context),
    ).toThrow("Model returned an invalid tool call: tool name is empty.");
    expect(logger.warn).toHaveBeenCalledWith(
      "Model returned invalid tool call",
      expect.objectContaining({
        event: "model.invalid_tool_call",
        model: "test-provider/test-model",
        source: "test",
        status: "failed",
        toolCallId: toolCall.id,
        toolCallIndex: 0,
      }),
    );
  });

  it("keeps the execution-only tool-name guard strict for an empty name", () => {
    expect(() =>
      requireRuntimeToolCallName(
        { id: "call_empty_execution_guard", name: "" },
        createValidationContext(),
      ),
    ).toThrow("Model returned an invalid tool call: tool name is empty.");
  });

  it("persists empty provider names behind the non-empty storage projection", async () => {
    const logger = createTestLogger();
    const sessionId = createSessionId("empty-tool-persist");
    const turnId = createTurnId("empty-tool-persist");
    const traceContext = createRootTraceContext({ sessionId, turnId });
    const persistPart = vi.fn();

    await persistPendingToolPart(
      {
        getSessionModelSelection: () => createModelSelection(),
        logger,
        persistPart,
        sessionId,
      } as never,
      {
        assistantMessageId: createMessageId("assistant-empty-tool"),
        input: {},
        partID: createPartId("empty-tool"),
        toolCall: {
          id: createToolCallId("empty-tool"),
          input: {},
          name: "",
          status: "scheduled",
        } satisfies ToolCall,
        traceContext,
      },
    );

    expect(persistPart).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { providerToolName: "" },
        state: expect.objectContaining({
          raw: JSON.stringify({ tool: "empty_tool_name", input: {} }),
          status: "pending",
        }),
        tool: "empty_tool_name",
      }),
      traceContext,
    );
  });

  it("persists MCP presentation before completion for stopped-call hydration", async () => {
    const persistPart = vi.fn();
    const sessionId = createSessionId("mcp-pending-persist");
    const traceContext = createRootTraceContext({
      sessionId,
      turnId: createTurnId("mcp-pending-persist"),
    });
    const display = {
      kind: "mcp_tool" as const,
      serverName: "firebase",
      toolName: "read_resources",
    };

    await persistPendingToolPart(
      {
        getSessionModelSelection: () => createModelSelection(),
        persistPart,
        sessionId,
      } as never,
      {
        assistantMessageId: createMessageId("assistant-mcp-pending"),
        input: {},
        metadata: { schemaVersion: 1, display },
        partID: createPartId("mcp-pending"),
        toolCall: {
          id: createToolCallId("mcp-pending"),
          input: {},
          name: "opaque-provider-name",
          status: "scheduled",
        } satisfies ToolCall,
        traceContext,
      },
    );

    expect(persistPart).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { schemaVersion: 1, display } }),
      traceContext,
    );
  });
});

function createValidationContext(options: { logger?: Logger } = {}) {
  const sessionId = createSessionId("tool-validation");
  const turnId = createTurnId("tool-validation");

  return {
    logger: options.logger,
    model: createModelSelection(),
    source: "test",
    traceContext: createRootTraceContext({ sessionId, turnId }),
  };
}

function createModelSelection(): ModelSelection {
  return {
    modelId: "test-model" as ModelSelection["modelId"],
    providerId: "test-provider" as ModelSelection["providerId"],
  };
}

function createTestLogger(): Logger {
  return {
    child: vi.fn(() => createTestLogger()),
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}
