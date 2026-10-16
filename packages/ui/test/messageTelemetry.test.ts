import { afterEach, describe, expect, it } from "vitest";
import {
  buildCustomSupplierKey,
  buildGhostSupplierKey,
  encodeCustomModelValue,
  type ZCodePersistedFileChange,
} from "@zcode/shared";

import {
  activatePromptTelemetry,
  buildCompactionTelemetryExtraDetail,
  buildPromptTelemetryExtraDetail,
  finalizePromptTelemetry,
  queuePromptTelemetry,
  recordAgentStepTelemetryEvent,
  recordSubagentToolAttribution,
  recordPromptModelRequestStarted,
  recordComposerFocus,
  recordComposerTextChange,
  recordPromptFirstToken,
  recordPromptPermissionRequest,
  recordPromptPermissionResponse,
  recordPromptTokenUsageDelta,
  rekeyQueuedPromptTelemetry,
  resetMessageTelemetryForTest,
} from "../src/lib/messageTelemetry.js";

afterEach(() => {
  resetMessageTelemetryForTest();
});

describe("messageTelemetry", () => {
  it("captures send button input timing from focus and first character", () => {
    recordComposerFocus("/tmp/workspace-a", 100);
    recordComposerTextChange("/tmp/workspace-a", "h", 120);

    expect(
      queuePromptTelemetry({
        workspacePath: "/tmp/workspace-a",
        taskId: "task-a",
        messageId: "message-a",
        sendTime: 200,
      }),
    ).toEqual({
      input_start_time: "100",
      input_first_char_time: "120",
      input_send_time: "200",
    });
  });

  it("builds message completion metrics from the active prompt lifecycle", () => {
    const fileChanges: ZCodePersistedFileChange[] = [
      {
        turnIndex: 0,
        snapshots: [
          {
            path: "src/example.ts",
            beforeContent: null,
            afterContent: "const a = 1;\nconst b = 2;\n",
            writeCount: 1,
          },
        ],
      },
    ];

    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-a",
      taskId: "task-a",
      messageId: "message-a",
      sendTime: 200,
      extraDetail: {
        ask_mode: "plan",
        model_name: "claude-sonnet-4-5",
        model_provider: "provider-a",
        agent: "claude",
      },
    });
    activatePromptTelemetry("task-a", "message-a");
    recordPromptFirstToken("task-a", 260);
    recordPromptPermissionRequest({
      taskId: "task-a",
      requestId: "permission-a",
      toolCallId: "tool-a",
      now: 300,
    });
    recordPromptPermissionResponse({
      taskId: "task-a",
      requestId: "permission-a",
      now: 450,
    });
    recordAgentStepTelemetryEvent({
      taskId: "task-a",
      event: {
        type: "agent_message_chunk",
        taskId: "task-a",
        traceId: "trace-a",
        content: "done",
      },
      now: 500,
    });
    recordAgentStepTelemetryEvent({
      taskId: "task-a",
      event: {
        type: "task_complete",
        taskId: "task-a",
        traceId: "trace-a",
        stopReason: "stop",
      },
      now: 700,
    });

    expect(
      finalizePromptTelemetry({
        taskId: "task-a",
        status: "success",
        finishedAt: 700,
        fileChanges,
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 38,
          reasoningTokens: 5,
          cachedInputTokens: 2,
          cachedWriteInputTokens: 1,
        },
      }),
    ).toEqual({
      taskId: "task-a",
      messageId: "message-a",
      eventExtraDetail: {
        ask_mode: "plan",
        model_name: "claude-sonnet-4-5",
        model_provider: "provider-a",
        agent: "claude",
        input_tokens: "10",
        output_tokens: "20",
        reasoning_tokens: "5",
        cached_input_tokens: "2",
        cache_write_input_tokens: "1",
        tool_use_prompt_tokens: "0",
        total_tokens: "38",
        duration_ms: "500",
        waiting_ms: "150",
        generated_code_lines: "2",
        file_change_cnt: "1",
        time_to_first_token: "60",
        request_time: "200",
        status: "success",
        agent_composition: "main_only",
        agent_step_cnt: "1",
        retry_cnt: "0",
        tool_call_total: "0",
        tool_call_failed: "0",
        error_type: "",
        error_msg: "",
      },
    });
  });

  it("scopes completion step counts and loop indexes to the active prompt", () => {
    const runGenerationPrompt = (messageId: string, sendTime: number, finishedAt: number) => {
      queuePromptTelemetry({
        workspacePath: "/tmp/workspace-message-scope",
        taskId: "task-message-scope",
        messageId,
        sendTime,
      });
      activatePromptTelemetry("task-message-scope", messageId);
      recordAgentStepTelemetryEvent({
        taskId: "task-message-scope",
        event: {
          type: "agent_message_chunk",
          taskId: "task-message-scope",
          traceId: `trace-${messageId}`,
          content: "done",
        },
        now: sendTime + 10,
      });
      const [step] = recordAgentStepTelemetryEvent({
        taskId: "task-message-scope",
        event: {
          type: "task_complete",
          taskId: "task-message-scope",
          traceId: `trace-${messageId}`,
          stopReason: "stop",
        },
        now: finishedAt,
      });
      const completion = finalizePromptTelemetry({
        taskId: "task-message-scope",
        status: "success",
        finishedAt,
      });
      return { completion, step };
    };

    const first = runGenerationPrompt("message-scope-1", 100, 200);
    const second = runGenerationPrompt("message-scope-2", 300, 400);

    expect(first.step?.eventExtraDetail.loop_index).toBe("1");
    expect(first.completion?.eventExtraDetail.agent_step_cnt).toBe("1");
    expect(second.step?.eventExtraDetail.loop_index).toBe("1");
    expect(second.completion?.eventExtraDetail.agent_step_cnt).toBe("1");
  });

  it("rejects stale input chunks and tools at the shared step aggregation entry", () => {
    const taskId = "task-stale-step-input";
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-stale-step-input",
      taskId,
      messageId: "message-current",
      inputId: "input-current",
      sendTime: 100,
    });
    activatePromptTelemetry(taskId, "message-current");

    const staleChunkSteps = recordAgentStepTelemetryEvent({
      taskId,
      activeInputId: "input-current",
      event: {
        type: "agent_message_chunk",
        taskId,
        traceId: "trace-session",
        inputId: "input-stale",
        content: "stale response",
      },
      now: 120,
    });
    const staleToolSteps = recordAgentStepTelemetryEvent({
      taskId,
      activeInputId: "input-current",
      event: {
        type: "tool_call_update",
        taskId,
        traceId: "trace-session",
        inputId: "input-stale",
        toolId: "tool-stale",
        kind: "Bash",
        status: "failed",
        error: "stale failure",
      },
      now: 130,
    });
    const currentTerminalSteps = recordAgentStepTelemetryEvent({
      taskId,
      activeInputId: "input-current",
      event: {
        type: "task_complete",
        taskId,
        traceId: "trace-session",
        inputId: "input-current",
        stopReason: "end_turn",
      },
      now: 150,
    });
    const completion = finalizePromptTelemetry({
      taskId,
      status: "success",
      finishedAt: 150,
    });

    expect(staleChunkSteps).toEqual([]);
    expect(staleToolSteps).toEqual([]);
    expect(currentTerminalSteps).toEqual([]);
    expect(completion?.eventExtraDetail).toMatchObject({
      time_to_first_token: "-1",
      agent_step_cnt: "0",
      tool_call_total: "0",
      tool_call_failed: "0",
    });
  });

  it("uses runtime activeInputId after a queued prompt rebinds its pending input", () => {
    const taskId = "task-queued-input-rebind";
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-queued-input-rebind",
      taskId,
      messageId: "message-queued",
      inputId: "input-pending",
      sendTime: 200,
      extraDetail: {
        model_name: "provider-old/model-old",
        model_provider: "provider-old",
      },
    });
    activatePromptTelemetry(taskId, "message-queued");

    const [toolStep] = recordAgentStepTelemetryEvent({
      taskId,
      activeInputId: "input-actual",
      event: {
        type: "tool_call_update",
        taskId,
        traceId: "trace-session",
        inputId: "input-actual",
        toolId: "tool-current",
        kind: "Read",
        status: "completed",
      },
      now: 220,
    });
    recordPromptModelRequestStarted(
      taskId,
      {
        type: "task_network_debug_status",
        taskId,
        traceId: "trace-session",
        inputId: "input-actual",
        eventKey: "event-actual",
        statusType: "model_request_started",
        providerId: "provider-actual",
        modelId: "model-actual",
        requestHeaders: {},
        responseHeaders: {},
        requestHeaderCount: 0,
        responseHeaderCount: 0,
      },
      "input-actual",
    );
    const completion = finalizePromptTelemetry({
      taskId,
      status: "success",
      finishedAt: 240,
    });

    expect(toolStep?.eventExtraDetail).toMatchObject({
      loop_index: "1",
      tool_call_id: "tool-current",
      status: "success",
    });
    expect(completion?.eventExtraDetail).toMatchObject({
      agent_step_cnt: "1",
      tool_call_total: "1",
      tool_call_failed: "0",
      model_name: "provider-actual/model-actual",
      model_provider: "provider-actual",
    });
  });

  it("derives tool completion counts from finalized steps in the active prompt", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-tool-count",
      taskId: "task-tool-count",
      messageId: "message-tool-count",
      sendTime: 100,
    });
    activatePromptTelemetry("task-tool-count", "message-tool-count");

    for (const [toolId, status, error] of [
      ["tool-ok", "completed", undefined],
      ["tool-failed", "failed", "command timed out"],
    ] as const) {
      recordAgentStepTelemetryEvent({
        taskId: "task-tool-count",
        event: {
          type: "tool_call",
          taskId: "task-tool-count",
          traceId: "trace-tool-count",
          toolId,
          kind: "bash",
          toolName: "bash",
          title: "Run command",
          input: {},
          raw: {},
        },
        now: 120,
      });
      recordAgentStepTelemetryEvent({
        taskId: "task-tool-count",
        event: {
          type: "tool_call_update",
          taskId: "task-tool-count",
          traceId: "trace-tool-count",
          toolId,
          status,
          kind: "bash",
          toolName: "bash",
          ...(error ? { error } : {}),
          raw: {},
        },
        now: 150,
      });
    }

    const completion = finalizePromptTelemetry({
      taskId: "task-tool-count",
      status: "fail",
      finishedAt: 200,
    });

    expect(completion?.eventExtraDetail).toMatchObject({
      agent_step_cnt: "2",
      tool_call_total: "2",
      tool_call_failed: "1",
      error_type: "TOOL_CALL_FAILED",
      error_msg: "command timed out",
    });
  });

  it("does not append success-only token fields and reports failure details for failed prompts", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-b",
      taskId: "task-b",
      messageId: "message-b",
      sendTime: 100,
      extraDetail: {
        ask_mode: "default",
        model_name: "model-b",
        model_provider: "provider-b",
        agent: "codex",
      },
    });
    activatePromptTelemetry("task-b", "message-b");
    for (const [toolId, kind, status, error] of [
      ["tool-ok", "read", "completed", undefined],
      ["tool-failed", "bash", "failed", "command timed out"],
    ] as const) {
      recordAgentStepTelemetryEvent({
        taskId: "task-b",
        event: {
          type: "tool_call",
          taskId: "task-b",
          traceId: "trace-b",
          toolId,
          kind,
          input: {},
          raw: {},
        },
        now: 120,
      });
      recordAgentStepTelemetryEvent({
        taskId: "task-b",
        event: {
          type: "tool_call_update",
          taskId: "task-b",
          traceId: "trace-b",
          toolId,
          kind,
          status,
          ...(error ? { error } : {}),
          raw: {},
        },
        now: 150,
      });
    }

    expect(
      finalizePromptTelemetry({
        taskId: "task-b",
        status: "fail",
        finishedAt: 180,
        usage: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
        },
      }),
    ).toEqual({
      taskId: "task-b",
      messageId: "message-b",
      eventExtraDetail: {
        ask_mode: "default",
        model_name: "model-b",
        model_provider: "provider-b",
        agent: "codex",
        duration_ms: "80",
        waiting_ms: "0",
        generated_code_lines: "0",
        file_change_cnt: "0",
        time_to_first_token: "20",
        request_time: "100",
        status: "fail",
        agent_composition: "main_only",
        agent_step_cnt: "2",
        retry_cnt: "0",
        tool_call_total: "2",
        tool_call_failed: "1",
        error_type: "TOOL_CALL_FAILED",
        error_msg: "command timed out",
      },
    });
  });

  it("reports accumulated token usage for failed prompts from usage delta events", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-fail-usage",
      taskId: "task-fail-usage",
      messageId: "message-fail-usage",
      sendTime: 100,
      extraDetail: {
        ask_mode: "build",
      },
    });
    activatePromptTelemetry("task-fail-usage", "message-fail-usage");

    recordPromptTokenUsageDelta({
      taskId: "task-fail-usage",
      eventKey: "usage-event-1",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 17,
        reasoningTokens: 1,
        cachedInputTokens: 2,
        cachedWriteInputTokens: 1,
      },
    });
    recordPromptTokenUsageDelta({
      taskId: "task-fail-usage",
      eventKey: "usage-event-1",
      usage: {
        inputTokens: 999,
        outputTokens: 999,
        totalTokens: 999,
      },
    });
    recordPromptTokenUsageDelta({
      taskId: "task-fail-usage",
      eventKey: "usage-event-2",
      usage: {
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
      },
    });

    expect(
      finalizePromptTelemetry({
        taskId: "task-fail-usage",
        status: "fail",
        finishedAt: 250,
      })?.eventExtraDetail,
    ).toEqual(
      expect.objectContaining({
        status: "fail",
        input_tokens: "13",
        output_tokens: "6",
        reasoning_tokens: "1",
        cached_input_tokens: "2",
        cache_write_input_tokens: "1",
        tool_use_prompt_tokens: "0",
        total_tokens: "22",
        token_source: "usage_delta",
      }),
    );
  });

  it("reports terminal error details for failed prompts", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-terminal-error",
      taskId: "task-terminal-error",
      messageId: "message-terminal-error",
      sendTime: 100,
    });
    activatePromptTelemetry("task-terminal-error", "message-terminal-error");

    expect(
      finalizePromptTelemetry({
        taskId: "task-terminal-error",
        status: "fail",
        finishedAt: 180,
        errorType: "MODEL_REQUEST_FAILED",
        errorMsg: "method not allowed",
      })?.eventExtraDetail,
    ).toEqual(
      expect.objectContaining({
        status: "fail",
        error_type: "MODEL_REQUEST_FAILED",
        error_msg: "method not allowed",
      }),
    );
  });

  it("reports accumulated token usage for interrupted prompts from usage delta events", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-interrupt-usage",
      taskId: "task-interrupt-usage",
      messageId: "message-interrupt-usage",
      sendTime: 100,
    });
    activatePromptTelemetry("task-interrupt-usage", "message-interrupt-usage");

    recordPromptTokenUsageDelta({
      taskId: "task-interrupt-usage",
      eventKey: "usage-event-interrupt",
      usage: {
        inputTokens: 8,
        outputTokens: 1,
        totalTokens: 11,
        cachedInputTokens: 2,
      },
    });

    expect(
      finalizePromptTelemetry({
        taskId: "task-interrupt-usage",
        status: "user_interrupt",
        finishedAt: 180,
      })?.eventExtraDetail,
    ).toEqual(
      expect.objectContaining({
        status: "user_interrupt",
        input_tokens: "8",
        output_tokens: "1",
        reasoning_tokens: "0",
        cached_input_tokens: "2",
        cache_write_input_tokens: "0",
        total_tokens: "11",
        token_source: "usage_delta",
      }),
    );
  });

  it("keeps queued prompt telemetry when the queued message id is replaced by service ack", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-queued-rekey",
      taskId: "task-queued-rekey",
      messageId: "local-queued-id",
      sendTime: 100,
      extraDetail: {
        ask_mode: "build",
      },
    });

    rekeyQueuedPromptTelemetry("task-queued-rekey", "local-queued-id", "ack-queued-id");
    activatePromptTelemetry("task-queued-rekey", "ack-queued-id");

    expect(
      finalizePromptTelemetry({
        taskId: "task-queued-rekey",
        status: "fail",
        finishedAt: 250,
      }),
    ).toEqual({
      taskId: "task-queued-rekey",
      messageId: "ack-queued-id",
      eventExtraDetail: {
        ask_mode: "build",
        duration_ms: "150",
        waiting_ms: "0",
        generated_code_lines: "0",
        file_change_cnt: "0",
        time_to_first_token: "-1",
        request_time: "100",
        status: "fail",
        agent_composition: "main_only",
        agent_step_cnt: "0",
        retry_cnt: "0",
        tool_call_total: "0",
        tool_call_failed: "0",
        error_type: "UNKNOWN",
        error_msg: "",
      },
    });
  });

  it("resolves model_provider from native custom and ghost supplier keys", () => {
    expect(
      buildPromptTelemetryExtraDetail({
        askMode: "plan",
        modelName: "model-native",
        provider: "claude",
        selectedSupplierKey: "native:claude",
      }),
    ).toEqual({
      ask_mode: "plan",
      model_name: "model-native",
      model_provider: "claude",
      agent: "claude",
      plan_status: "unknown",
      plan_product_id: "",
    });

    expect(
      buildPromptTelemetryExtraDetail({
        askMode: "plan",
        modelName: "model-custom",
        provider: "claude",
        selectedSupplierKey: buildCustomSupplierKey("provider-a"),
      }),
    ).toEqual({
      ask_mode: "plan",
      model_name: "model-custom",
      model_provider: "provider-a",
      agent: "claude",
      plan_status: "unknown",
      plan_product_id: "",
    });

    expect(
      buildPromptTelemetryExtraDetail({
        askMode: "plan",
        modelName: "model-ghost",
        provider: "gemini",
        selectedSupplierKey: buildGhostSupplierKey("gemini", "mismatch", "https://demo.invalid"),
      }),
    ).toEqual({
      ask_mode: "plan",
      model_name: "model-ghost",
      model_provider: "gemini",
      agent: "gemini",
      plan_status: "unknown",
      plan_product_id: "",
    });
  });

  it("freezes plan identity fields from send button into message completion", () => {
    const sendButtonExtra = queuePromptTelemetry({
      workspacePath: "/tmp/workspace-a",
      taskId: "task-a",
      messageId: "message-a",
      sendTime: 200,
      extraDetail: buildPromptTelemetryExtraDetail({
        askMode: "chat",
        modelName: "glm-5.1",
        provider: "glm",
        providerBaseURL: "https://api.z.ai/api/paas/v4",
        planIdentitySnapshot: {
          generatedAt: 100,
          planStatus: "coding_plan",
          planProductId: "product-coding-pro",
        },
      }),
    });
    activatePromptTelemetry("task-a", "message-a");

    const completion = finalizePromptTelemetry({
      taskId: "task-a",
      status: "success",
      finishedAt: 300,
      taskMessages: [],
      fileChanges: [],
    });

    expect(sendButtonExtra).toMatchObject({
      plan_status: "coding_plan",
      plan_product_id: "product-coding-pro",
      provider_name: "api.z.ai",
    });
    expect(completion?.eventExtraDetail).toMatchObject({
      plan_status: "coding_plan",
      plan_product_id: "product-coding-pro",
      provider_name: "api.z.ai",
    });
  });

  it("prefers provider-qualified UI model value over stale supplier key for send button", () => {
    expect(
      buildPromptTelemetryExtraDetail({
        askMode: "plan",
        modelName: "4209ad4c-6650-4928-b44e-1167f913289a/deepseek-v4-flash",
        provider: "glm",
        selectedSupplierKey: "native:glm",
      }),
    ).toEqual({
      ask_mode: "plan",
      model_name: "4209ad4c-6650-4928-b44e-1167f913289a/deepseek-v4-flash",
      model_provider: "4209ad4c-6650-4928-b44e-1167f913289a",
      agent: "glm",
      plan_status: "unknown",
      plan_product_id: "",
    });

    expect(
      buildPromptTelemetryExtraDetail({
        askMode: "plan",
        modelName: encodeCustomModelValue("provider-custom", "deepseek-v4-flash"),
        provider: "glm",
        selectedSupplierKey: "native:glm",
      }),
    ).toEqual({
      ask_mode: "plan",
      model_name: encodeCustomModelValue("provider-custom", "deepseek-v4-flash"),
      model_provider: "provider-custom",
      agent: "glm",
      plan_status: "unknown",
      plan_product_id: "",
    });
  });

  it("keeps send button model from UI snapshot but completes with actual model request", () => {
    expect(
      queuePromptTelemetry({
        workspacePath: "/tmp/workspace-actual",
        taskId: "task-actual",
        messageId: "message-actual",
        inputId: "input-actual",
        sendTime: 100,
        extraDetail: {
          ask_mode: "build",
          model_name: "account:bigmodel-start-plan/GLM-5.2",
          model_provider: "provider-custom",
          agent: "glm",
        },
      }),
    ).toMatchObject({
      model_name: "account:bigmodel-start-plan/GLM-5.2",
      model_provider: "provider-custom",
    });
    activatePromptTelemetry("task-actual", "message-actual");

    recordPromptModelRequestStarted("task-actual", {
      type: "task_network_debug_status",
      taskId: "task-actual",
      traceId: "trace-actual",
      inputId: "input-actual",
      eventKey: "event-actual",
      statusType: "model_request_started",
      providerId: "provider-custom",
      modelId: "GLM-5.2",
      requestHeaders: {},
      responseHeaders: {},
      requestHeaderCount: 0,
      responseHeaderCount: 0,
    });

    expect(
      finalizePromptTelemetry({
        taskId: "task-actual",
        status: "success",
        finishedAt: 180,
      })?.eventExtraDetail,
    ).toMatchObject({
      model_name: "provider-custom/GLM-5.2",
      model_provider: "provider-custom",
    });
  });

  it("adds provider hostname from provider endpoint and prefers runtime baseURL", () => {
    expect(
      buildPromptTelemetryExtraDetail({
        askMode: "build",
        modelName: encodeCustomModelValue("provider-custom", "glm-5.2"),
        provider: "glm",
        selectedSupplierKey: buildCustomSupplierKey("provider-custom"),
        providerBaseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      }),
    ).toMatchObject({
      model_provider: "provider-custom",
      provider_name: "dashscope.aliyuncs.com",
    });

    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-hostname",
      taskId: "task-hostname",
      messageId: "message-hostname",
      inputId: "input-hostname",
      sendTime: 100,
      extraDetail: {
        model_name: encodeCustomModelValue("provider-custom", "glm-5.2"),
        model_provider: "provider-custom",
        provider_name: "dashscope.aliyuncs.com",
      },
    });
    activatePromptTelemetry("task-hostname", "message-hostname");

    recordPromptModelRequestStarted("task-hostname", {
      type: "task_network_debug_status",
      taskId: "task-hostname",
      traceId: "trace-hostname",
      inputId: "input-hostname",
      eventKey: "event-hostname",
      statusType: "model_request_started",
      providerId: "provider-custom",
      modelId: "glm-5.2",
      baseURL: "https://runtime.example.com/v1/chat/completions",
      requestHeaders: {},
      responseHeaders: {},
      requestHeaderCount: 0,
      responseHeaderCount: 0,
    });

    expect(
      finalizePromptTelemetry({
        taskId: "task-hostname",
        status: "success",
        finishedAt: 180,
      })?.eventExtraDetail,
    ).toMatchObject({
      model_provider: "provider-custom",
      provider_name: "runtime.example.com",
    });
  });

  it("ignores model request telemetry for a different prompt input", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-input",
      taskId: "task-input",
      messageId: "message-input",
      inputId: "input-current",
      sendTime: 100,
      extraDetail: {
        model_name: "account:bigmodel-start-plan/GLM-5.2",
        model_provider: "provider-custom",
      },
    });
    activatePromptTelemetry("task-input", "message-input");

    recordPromptModelRequestStarted("task-input", {
      type: "task_network_debug_status",
      taskId: "task-input",
      traceId: "trace-input",
      inputId: "input-other",
      eventKey: "event-input",
      statusType: "model_request_started",
      providerId: "provider-custom",
      modelId: "GLM-5.2",
      requestHeaders: {},
      responseHeaders: {},
      requestHeaderCount: 0,
      responseHeaderCount: 0,
    });

    expect(
      finalizePromptTelemetry({
        taskId: "task-input",
        status: "success",
        finishedAt: 180,
      })?.eventExtraDetail,
    ).toMatchObject({
      model_name: "builtin:bigmodel-start-plan/GLM-5.2",
      model_provider: "provider-custom",
    });
  });

  it("builds compaction telemetry for terminal statuses with provider/model and token metrics", () => {
    const detail = buildCompactionTelemetryExtraDetail({
      timeline: {
        version: 1,
        kind: "synthetic",
        type: "context_compaction",
        operationId: "op-1",
        status: "completed",
        trigger: "auto",
        display: "separator",
        reason: "context_limit",
        attempt: 2,
        startedAt: 1000,
        endedAt: 1500,
        preCompactTokenCount: 20000,
        postCompactTokenCount: 5000,
        truePostCompactTokenCount: 5200,
      },
      provider: "claude",
      modelName: "model-x",
      selectedSupplierKey: "native:claude",
    });

    expect(detail).toEqual({
      status: "completed",
      trigger: "auto",
      reason: "context_limit",
      attempt: "2",
      duration_ms: "500",
      pre_compact_tokens: "20000",
      post_compact_tokens: "5000",
      true_post_compact_tokens: "5200",
      compact_ratio: "0.2500",
      model_name: "model-x",
      model_provider: "claude",
    });
  });

  it("leaves compact_ratio and duration empty when token/timing data is missing", () => {
    const detail = buildCompactionTelemetryExtraDetail({
      timeline: {
        version: 1,
        kind: "synthetic",
        type: "context_compaction",
        operationId: "op-2",
        status: "failed",
        trigger: "manual",
        display: "separator",
      },
      provider: "gemini",
    });

    expect(detail).toMatchObject({
      status: "failed",
      trigger: "manual",
      reason: "",
      attempt: "0",
      duration_ms: "",
      pre_compact_tokens: "0",
      post_compact_tokens: "0",
      true_post_compact_tokens: "0",
      compact_ratio: "",
      model_name: "",
      model_provider: "gemini",
    });
  });

  it("returns null for non-terminal compaction statuses", () => {
    for (const status of ["started", "retrying", "skipped"] as const) {
      expect(
        buildCompactionTelemetryExtraDetail({
          timeline: {
            version: 1,
            kind: "synthetic",
            type: "context_compaction",
            operationId: `op-${status}`,
            status,
            trigger: "auto",
            display: "separator",
          },
          provider: "claude",
        }),
      ).toBeNull();
    }
  });

  it("emits agent_step events for reasoning, tool calls, and generation", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-c",
      taskId: "task-c",
      messageId: "message-c",
      sendTime: 100,
      extraDetail: {
        model_name: "claude-sonnet-4-5",
        model_provider: "anthropic",
        provider_name: "api.anthropic.com",
      },
    });
    activatePromptTelemetry("task-c", "message-c");

    expect(
      recordAgentStepTelemetryEvent({
        taskId: "task-c",
        event: {
          type: "agent_thought_chunk",
          taskId: "task-c",
          traceId: "trace-c",
          content: "thinking",
        },
        now: 110,
      }),
    ).toEqual([]);

    expect(
      recordAgentStepTelemetryEvent({
        taskId: "task-c",
        event: {
          type: "tool_call",
          taskId: "task-c",
          traceId: "trace-c",
          toolId: "tool-c",
          kind: "read",
          toolName: "read_file",
          title: "Read file",
          input: {},
          raw: {},
        },
        now: 150,
      }),
    ).toEqual([
      {
        taskId: "task-c",
        messageId: "message-c",
        eventExtraDetail: {
          step_id: expect.any(String),
          is_tftt_cached: "0",
          loop_index: "1",
          step_type: "reasoning",
          model_name: "claude-sonnet-4-5",
          model_provider: "anthropic",
          provider_name: "api.anthropic.com",
          model_request_id: "",
          model_request_count: "0",
          token_usage_scope: "",
          is_tool_call: "0",
          tool_name: "",
          tool_call_id: "",
          duration_ms: "40",
          waiting_ms: "0",
          generation_tail_finalize_ms: "",
          status: "success",
          input_tokens: "0",
          output_tokens: "0",
          reasoning_tokens: "0",
          cached_tokens: "0",
          cache_write_input_tokens: "0",
          total_tokens: "0",
          error_type: "",
          error_msg: "",
        },
      },
    ]);

    expect(
      recordAgentStepTelemetryEvent({
        taskId: "task-c",
        event: {
          type: "tool_call_update",
          taskId: "task-c",
          traceId: "trace-c",
          toolId: "tool-c",
          status: "failed",
          kind: "read",
          toolName: "read_file",
          error: "File not found: utils.ts",
          raw: {},
        },
        now: 190,
      }),
    ).toEqual([
      {
        taskId: "task-c",
        messageId: "message-c",
        eventExtraDetail: {
          step_id: expect.any(String),
          is_tftt_cached: "0",
          loop_index: "2",
          step_type: "tool_call",
          model_name: "claude-sonnet-4-5",
          model_provider: "anthropic",
          provider_name: "api.anthropic.com",
          model_request_id: "",
          model_request_count: "0",
          token_usage_scope: "",
          is_tool_call: "1",
          tool_name: "read_file",
          tool_call_id: "tool-c",
          duration_ms: "40",
          waiting_ms: "0",
          generation_tail_finalize_ms: "",
          status: "fail",
          input_tokens: "0",
          output_tokens: "0",
          reasoning_tokens: "0",
          cached_tokens: "0",
          cache_write_input_tokens: "0",
          total_tokens: "0",
          error_type: "TOOL_EXEC_ERROR",
          error_msg: "File not found: utils.ts",
        },
      },
    ]);

    expect(
      recordAgentStepTelemetryEvent({
        taskId: "task-c",
        event: {
          type: "agent_message_chunk",
          taskId: "task-c",
          traceId: "trace-c",
          content: "done",
        },
        now: 200,
      }),
    ).toEqual([]);

    expect(
      recordAgentStepTelemetryEvent({
        taskId: "task-c",
        event: {
          type: "task_complete",
          taskId: "task-c",
          traceId: "trace-c",
          stopReason: "stop",
        },
        now: 260,
      }),
    ).toEqual([
      {
        taskId: "task-c",
        messageId: "message-c",
        eventExtraDetail: {
          step_id: expect.any(String),
          is_tftt_cached: "0",
          loop_index: "3",
          step_type: "generation",
          model_name: "claude-sonnet-4-5",
          model_provider: "anthropic",
          provider_name: "api.anthropic.com",
          model_request_id: "",
          model_request_count: "0",
          token_usage_scope: "",
          is_tool_call: "0",
          tool_name: "",
          tool_call_id: "",
          duration_ms: "60",
          waiting_ms: "0",
          generation_tail_finalize_ms: "60",
          status: "success",
          input_tokens: "0",
          output_tokens: "0",
          reasoning_tokens: "0",
          cached_tokens: "0",
          cache_write_input_tokens: "0",
          total_tokens: "0",
          error_type: "",
          error_msg: "",
        },
      },
    ]);
  });

  it("成功 CronCreate 的 agent_step 携带新生成的 automation_id", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-cron-create",
      taskId: "task-cron-create",
      messageId: "message-cron-create",
      sendTime: 100,
    });
    activatePromptTelemetry("task-cron-create", "message-cron-create");

    recordAgentStepTelemetryEvent({
      taskId: "task-cron-create",
      event: {
        type: "tool_call",
        taskId: "task-cron-create",
        traceId: "trace-cron-create",
        toolId: "tool-cron-create",
        kind: "CronCreate",
        toolName: "CronCreate",
        title: "CronCreate",
        input: {},
        raw: {},
      },
      now: 110,
    });

    const [step] = recordAgentStepTelemetryEvent({
      taskId: "task-cron-create",
      event: {
        type: "tool_call_update",
        taskId: "task-cron-create",
        traceId: "trace-cron-create",
        toolId: "tool-cron-create",
        status: "completed",
        kind: "CronCreate",
        toolName: "CronCreate",
        content: JSON.stringify({ automation: { automationId: "automation-created" } }),
        raw: {},
      },
      now: 130,
    });

    expect(step?.eventExtraDetail).toMatchObject({
      tool_name: "CronCreate",
      status: "success",
      automation_id: "automation-created",
    });
  });

  it("Skill tool step 携带解析后的 skill metadata，普通 tool step 不携带", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-skill",
      taskId: "task-skill",
      messageId: "message-skill",
      sendTime: 100,
    });
    activatePromptTelemetry("task-skill", "message-skill");

    recordAgentStepTelemetryEvent({
      taskId: "task-skill",
      event: {
        type: "tool_call",
        taskId: "task-skill",
        traceId: "trace-skill",
        toolId: "tool-skill",
        kind: "Skill",
        toolName: "Skill",
        title: "Load skill",
        input: {},
        raw: {},
        skillMetadata: {
          qualifiedName: "document-skills:pptx",
          pluginId: "document-skills@zcode-plugins-official",
          source: "plugin",
        },
      },
      now: 110,
    });

    const [step] = recordAgentStepTelemetryEvent({
      taskId: "task-skill",
      event: {
        type: "tool_call_update",
        taskId: "task-skill",
        traceId: "trace-skill",
        toolId: "tool-skill",
        status: "completed",
        kind: "Skill",
        toolName: "Skill",
        raw: {},
        skillMetadata: {
          qualifiedName: "document-skills:pptx",
          pluginId: "document-skills@zcode-plugins-official",
          source: "plugin",
        },
      },
      now: 130,
    });

    expect(step?.eventExtraDetail).toMatchObject({
      tool_name: "Skill",
      skill_qualified_name: "document-skills:pptx",
      skill_plugin_id: "document-skills@zcode-plugins-official",
      skill_source: "plugin",
    });

    recordAgentStepTelemetryEvent({
      taskId: "task-skill",
      event: {
        type: "tool_call",
        taskId: "task-skill",
        traceId: "trace-skill",
        toolId: "tool-bash",
        kind: "Bash",
        toolName: "Bash",
        title: "Run command",
        input: {},
        raw: {},
        skillMetadata: {
          qualifiedName: "document-skills:pptx",
          pluginId: "document-skills@zcode-plugins-official",
          source: "plugin",
        },
      },
      now: 140,
    });
    const [bashStep] = recordAgentStepTelemetryEvent({
      taskId: "task-skill",
      event: {
        type: "tool_call_update",
        taskId: "task-skill",
        traceId: "trace-skill",
        toolId: "tool-bash",
        status: "completed",
        kind: "Bash",
        toolName: "Bash",
        raw: {},
        skillMetadata: {
          qualifiedName: "document-skills:pptx",
          pluginId: "document-skills@zcode-plugins-official",
          source: "plugin",
        },
      },
      now: 150,
    });
    expect(bashStep?.eventExtraDetail).not.toHaveProperty("skill_qualified_name");
    expect(bashStep?.eventExtraDetail).not.toHaveProperty("skill_plugin_id");
    expect(bashStep?.eventExtraDetail).not.toHaveProperty("skill_source");
  });

  it("uses the latest ordinary message chunk for generation tail finalize time", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-generation-tail",
      taskId: "task-generation-tail",
      messageId: "message-generation-tail",
      sendTime: 100,
    });
    activatePromptTelemetry("task-generation-tail", "message-generation-tail");

    recordAgentStepTelemetryEvent({
      taskId: "task-generation-tail",
      event: {
        type: "agent_message_chunk",
        taskId: "task-generation-tail",
        traceId: "trace-generation-tail",
        content: "first",
      },
      now: 200,
    });
    recordAgentStepTelemetryEvent({
      taskId: "task-generation-tail",
      event: {
        type: "agent_message_chunk",
        taskId: "task-generation-tail",
        traceId: "trace-generation-tail",
        content: "second",
      },
      now: 230,
    });

    expect(
      recordAgentStepTelemetryEvent({
        taskId: "task-generation-tail",
        event: {
          type: "task_complete",
          taskId: "task-generation-tail",
          traceId: "trace-generation-tail",
          stopReason: "stop",
        },
        now: 260,
      }),
    ).toEqual([
      expect.objectContaining({
        eventExtraDetail: expect.objectContaining({
          step_type: "generation",
          duration_ms: "60",
          generation_tail_finalize_ms: "30",
        }),
      }),
    ]);
  });

  it("does not report generation tail finalize time when a tool call closes generation", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-generation-tool",
      taskId: "task-generation-tool",
      messageId: "message-generation-tool",
      sendTime: 100,
    });
    activatePromptTelemetry("task-generation-tool", "message-generation-tool");

    recordAgentStepTelemetryEvent({
      taskId: "task-generation-tool",
      event: {
        type: "agent_message_chunk",
        taskId: "task-generation-tool",
        traceId: "trace-generation-tool",
        content: "I will inspect it",
      },
      now: 200,
    });

    const finalized = recordAgentStepTelemetryEvent({
      taskId: "task-generation-tool",
      event: {
        type: "tool_call",
        taskId: "task-generation-tool",
        traceId: "trace-generation-tool",
        toolId: "tool-generation-tool",
        kind: "Bash",
        toolName: "Bash",
        title: "Bash",
        input: {},
        raw: {},
      },
      now: 260,
    });

    expect(finalized).toHaveLength(1);
    expect(finalized[0]?.eventExtraDetail).toEqual(
      expect.objectContaining({
        step_type: "generation",
        duration_ms: "60",
        generation_tail_finalize_ms: "",
      }),
    );
  });

  it("does not report generation tail finalize time for replayable recovered events", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-generation-replayable",
      taskId: "task-generation-replayable",
      messageId: "message-generation-replayable",
      sendTime: 100,
    });
    activatePromptTelemetry("task-generation-replayable", "message-generation-replayable");

    recordAgentStepTelemetryEvent({
      taskId: "task-generation-replayable",
      event: {
        type: "agent_message_chunk",
        taskId: "task-generation-replayable",
        traceId: "trace-generation-replayable",
        content: "done",
      },
      clientMode: "web-remote-replayable",
      now: 200,
    });

    const finalized = recordAgentStepTelemetryEvent({
      taskId: "task-generation-replayable",
      event: {
        type: "task_complete",
        taskId: "task-generation-replayable",
        traceId: "trace-generation-replayable",
        stopReason: "stop",
      },
      clientMode: "web-remote-replayable",
      now: 260,
    });

    expect(finalized).toHaveLength(1);
    expect(finalized[0]?.eventExtraDetail).toEqual(
      expect.objectContaining({
        step_type: "generation",
        duration_ms: "60",
        generation_tail_finalize_ms: "",
      }),
    );
  });

  it("does not count parented agent chunks as generation steps", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-parented-agent-chunk",
      taskId: "task-parented-agent-chunk",
      messageId: "message-parented-agent-chunk",
      sendTime: 100,
    });
    activatePromptTelemetry("task-parented-agent-chunk", "message-parented-agent-chunk");

    recordAgentStepTelemetryEvent({
      taskId: "task-parented-agent-chunk",
      event: {
        type: "tool_call",
        taskId: "task-parented-agent-chunk",
        traceId: "trace-parented-agent-chunk",
        toolId: "tool-parent-agent",
        kind: "agent",
        toolName: "Task",
        title: "Task",
        input: {},
        raw: {},
      },
      now: 150,
    });

    expect(
      recordAgentStepTelemetryEvent({
        taskId: "task-parented-agent-chunk",
        event: {
          type: "agent_message_chunk",
          taskId: "task-parented-agent-chunk",
          traceId: "trace-parented-agent-chunk",
          parentToolUseId: "tool-parent-agent",
          content: "subagent output",
        },
        now: 200,
      }),
    ).toEqual([]);

    const finalized = recordAgentStepTelemetryEvent({
      taskId: "task-parented-agent-chunk",
      event: {
        type: "task_complete",
        taskId: "task-parented-agent-chunk",
        traceId: "trace-parented-agent-chunk",
        stopReason: "stop",
      },
      now: 260,
    });

    expect(finalized).toHaveLength(1);
    expect(finalized[0]?.eventExtraDetail).toEqual(
      expect.objectContaining({
        step_type: "tool_call",
        tool_call_id: "tool-parent-agent",
        generation_tail_finalize_ms: "",
      }),
    );
  });

  it("attributes permission waiting to the tool step while keeping wall-clock durations", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-permission",
      taskId: "task-permission",
      messageId: "message-permission",
      sendTime: 100,
    });
    activatePromptTelemetry("task-permission", "message-permission");

    recordAgentStepTelemetryEvent({
      taskId: "task-permission",
      event: {
        type: "tool_call",
        taskId: "task-permission",
        traceId: "trace-permission",
        toolId: "tool-permission",
        kind: "bash",
        toolName: "bash",
        title: "Run command",
        input: {},
        raw: {},
      },
      now: 200,
    });
    recordPromptPermissionRequest({
      taskId: "task-permission",
      requestId: "request-permission",
      toolCallId: "tool-permission",
      now: 250,
    });
    // replay/重复投递不能重置等待起点
    recordPromptPermissionRequest({
      taskId: "task-permission",
      requestId: "request-permission",
      toolCallId: "tool-permission",
      now: 300,
    });
    recordPromptPermissionResponse({
      taskId: "task-permission",
      requestId: "request-permission",
      now: 400,
    });
    // 本地响应与 stream response 都可能触发，第二次必须幂等
    recordPromptPermissionResponse({
      taskId: "task-permission",
      requestId: "request-permission",
      now: 450,
    });

    const [toolStep] = recordAgentStepTelemetryEvent({
      taskId: "task-permission",
      event: {
        type: "tool_call_update",
        taskId: "task-permission",
        traceId: "trace-permission",
        toolId: "tool-permission",
        status: "completed",
        kind: "bash",
        toolName: "bash",
        raw: {},
      },
      now: 500,
    });
    const completion = finalizePromptTelemetry({
      taskId: "task-permission",
      status: "success",
      finishedAt: 700,
    });

    expect(toolStep?.eventExtraDetail).toMatchObject({
      step_type: "tool_call",
      duration_ms: "300",
      waiting_ms: "150",
    });
    expect(completion?.eventExtraDetail).toMatchObject({
      duration_ms: "600",
      waiting_ms: "150",
    });
  });

  it("sums permission waits from multiple tool calls into message completion", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-permission-sum",
      taskId: "task-permission-sum",
      messageId: "message-permission-sum",
      sendTime: 100,
    });
    activatePromptTelemetry("task-permission-sum", "message-permission-sum");

    const runTool = (
      toolId: string,
      requestId: string,
      startedAt: number,
      requestedAt: number,
      respondedAt: number,
      finishedAt: number,
    ) => {
      recordAgentStepTelemetryEvent({
        taskId: "task-permission-sum",
        event: {
          type: "tool_call",
          taskId: "task-permission-sum",
          traceId: "trace-permission-sum",
          toolId,
          kind: "bash",
          toolName: "bash",
          title: "Run command",
          input: {},
          raw: {},
        },
        now: startedAt,
      });
      recordPromptPermissionRequest({
        taskId: "task-permission-sum",
        requestId,
        toolCallId: toolId,
        now: requestedAt,
      });
      recordPromptPermissionResponse({
        taskId: "task-permission-sum",
        requestId,
        now: respondedAt,
      });
      return recordAgentStepTelemetryEvent({
        taskId: "task-permission-sum",
        event: {
          type: "tool_call_update",
          taskId: "task-permission-sum",
          traceId: "trace-permission-sum",
          toolId,
          status: "completed",
          kind: "bash",
          toolName: "bash",
          raw: {},
        },
        now: finishedAt,
      })[0];
    };

    const firstTool = runTool("tool-1", "request-1", 150, 200, 250, 300);
    const secondTool = runTool("tool-2", "request-2", 350, 400, 550, 600);
    const completion = finalizePromptTelemetry({
      taskId: "task-permission-sum",
      status: "success",
      finishedAt: 700,
    });

    expect(firstTool?.eventExtraDetail.waiting_ms).toBe("50");
    expect(secondTool?.eventExtraDetail.waiting_ms).toBe("150");
    expect(completion?.eventExtraDetail).toMatchObject({
      duration_ms: "600",
      waiting_ms: "200",
    });
  });

  it("accumulates repeated waits on one tool without attributing unmatched waits to it", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-permission-repeat",
      taskId: "task-permission-repeat",
      messageId: "message-permission-repeat",
      sendTime: 100,
    });
    activatePromptTelemetry("task-permission-repeat", "message-permission-repeat");
    recordAgentStepTelemetryEvent({
      taskId: "task-permission-repeat",
      event: {
        type: "tool_call",
        taskId: "task-permission-repeat",
        traceId: "trace-permission-repeat",
        toolId: "tool-permission-repeat",
        kind: "bash",
        toolName: "bash",
        title: "Run command",
        input: {},
        raw: {},
      },
      now: 150,
    });

    recordPromptPermissionRequest({
      taskId: "task-permission-repeat",
      requestId: "request-repeat-1",
      toolCallId: "tool-permission-repeat",
      now: 200,
    });
    recordPromptPermissionResponse({
      taskId: "task-permission-repeat",
      requestId: "request-repeat-1",
      now: 250,
    });
    recordPromptPermissionRequest({
      taskId: "task-permission-repeat",
      requestId: "request-repeat-2",
      toolCallId: "tool-permission-repeat",
      now: 300,
    });
    recordPromptPermissionResponse({
      taskId: "task-permission-repeat",
      requestId: "request-repeat-2",
      now: 400,
    });
    recordPromptPermissionRequest({
      taskId: "task-permission-repeat",
      requestId: "request-unmatched",
      toolCallId: "another-tool",
      now: 410,
    });
    recordPromptPermissionResponse({
      taskId: "task-permission-repeat",
      requestId: "request-unmatched",
      now: 460,
    });

    const [toolStep] = recordAgentStepTelemetryEvent({
      taskId: "task-permission-repeat",
      event: {
        type: "tool_call_update",
        taskId: "task-permission-repeat",
        traceId: "trace-permission-repeat",
        toolId: "tool-permission-repeat",
        status: "completed",
        kind: "bash",
        toolName: "bash",
        raw: {},
      },
      now: 500,
    });
    const completion = finalizePromptTelemetry({
      taskId: "task-permission-repeat",
      status: "success",
      finishedAt: 600,
    });

    expect(toolStep?.eventExtraDetail.waiting_ms).toBe("150");
    expect(completion?.eventExtraDetail.waiting_ms).toBe("200");
  });

  it("settles unanswered permission waits when the task terminates", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-permission-stop",
      taskId: "task-permission-stop",
      messageId: "message-permission-stop",
      sendTime: 100,
    });
    activatePromptTelemetry("task-permission-stop", "message-permission-stop");
    recordAgentStepTelemetryEvent({
      taskId: "task-permission-stop",
      event: {
        type: "tool_call",
        taskId: "task-permission-stop",
        traceId: "trace-permission-stop",
        toolId: "tool-permission-stop",
        kind: "bash",
        toolName: "bash",
        title: "Run command",
        input: {},
        raw: {},
      },
      now: 200,
    });
    recordPromptPermissionRequest({
      taskId: "task-permission-stop",
      requestId: "request-permission-stop",
      toolCallId: "tool-permission-stop",
      now: 300,
    });

    const [toolStep] = recordAgentStepTelemetryEvent({
      taskId: "task-permission-stop",
      event: {
        type: "task_error",
        taskId: "task-permission-stop",
        traceId: "trace-permission-stop",
        code: "USER_INTERRUPT",
        error: "stopped",
      },
      now: 600,
    });
    const completion = finalizePromptTelemetry({
      taskId: "task-permission-stop",
      status: "user_interrupt",
      finishedAt: 600,
    });

    expect(toolStep?.eventExtraDetail).toMatchObject({
      step_type: "tool_call",
      duration_ms: "400",
      waiting_ms: "300",
      status: "fail",
    });
    expect(completion?.eventExtraDetail).toMatchObject({
      duration_ms: "500",
      waiting_ms: "300",
    });
  });

  it("restores settled permission waiting when terminal tool update has no opening tool call", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-permission-replay-settled",
      taskId: "task-permission-replay-settled",
      messageId: "message-permission-replay-settled",
      sendTime: 100,
    });
    activatePromptTelemetry("task-permission-replay-settled", "message-permission-replay-settled");
    recordPromptPermissionRequest({
      taskId: "task-permission-replay-settled",
      requestId: "request-permission-replay-settled",
      toolCallId: "tool-permission-replay-settled",
      now: 200,
    });
    recordPromptPermissionRequest({
      taskId: "task-permission-replay-settled",
      requestId: "request-permission-replay-overlap",
      toolCallId: "tool-permission-replay-settled",
      now: 250,
    });
    recordPromptPermissionResponse({
      taskId: "task-permission-replay-settled",
      requestId: "request-permission-replay-settled",
      now: 350,
    });
    recordPromptPermissionResponse({
      taskId: "task-permission-replay-settled",
      requestId: "request-permission-replay-overlap",
      now: 450,
    });

    const [toolStep] = recordAgentStepTelemetryEvent({
      taskId: "task-permission-replay-settled",
      event: {
        type: "tool_call_update",
        taskId: "task-permission-replay-settled",
        traceId: "trace-permission-replay-settled",
        toolId: "tool-permission-replay-settled",
        status: "completed",
        kind: "bash",
        toolName: "bash",
        raw: {},
      },
      now: 500,
    });
    const completion = finalizePromptTelemetry({
      taskId: "task-permission-replay-settled",
      status: "success",
      finishedAt: 600,
    });

    expect(toolStep?.eventExtraDetail).toMatchObject({
      step_type: "tool_call",
      duration_ms: "350",
      waiting_ms: "350",
    });
    expect(completion?.eventExtraDetail).toMatchObject({
      duration_ms: "500",
      waiting_ms: "350",
    });
  });

  it("uses the pending request time when terminal tool update settles an unanswered wait", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-permission-replay-open",
      taskId: "task-permission-replay-open",
      messageId: "message-permission-replay-open",
      sendTime: 100,
    });
    activatePromptTelemetry("task-permission-replay-open", "message-permission-replay-open");
    recordPromptPermissionRequest({
      taskId: "task-permission-replay-open",
      requestId: "request-permission-replay-open",
      toolCallId: "tool-permission-replay-open",
      now: 200,
    });

    const [toolStep] = recordAgentStepTelemetryEvent({
      taskId: "task-permission-replay-open",
      event: {
        type: "tool_call_update",
        taskId: "task-permission-replay-open",
        traceId: "trace-permission-replay-open",
        toolId: "tool-permission-replay-open",
        status: "failed",
        kind: "bash",
        toolName: "bash",
        error: "stopped before permission response",
        raw: {},
      },
      now: 500,
    });
    const completion = finalizePromptTelemetry({
      taskId: "task-permission-replay-open",
      status: "user_interrupt",
      finishedAt: 500,
    });

    expect(toolStep?.eventExtraDetail).toMatchObject({
      step_type: "tool_call",
      duration_ms: "300",
      waiting_ms: "300",
      status: "fail",
    });
    expect(completion?.eventExtraDetail).toMatchObject({
      duration_ms: "400",
      waiting_ms: "300",
    });
  });

  it("uses actual model request fields for agent_step telemetry", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-step-model",
      taskId: "task-step-model",
      messageId: "message-step-model",
      inputId: "input-step-model",
      sendTime: 100,
      extraDetail: {
        model_name: "account:bigmodel-start-plan/GLM-5.2",
        model_provider: "provider-custom",
      },
    });
    activatePromptTelemetry("task-step-model", "message-step-model");
    recordPromptModelRequestStarted("task-step-model", {
      type: "task_network_debug_status",
      taskId: "task-step-model",
      traceId: "trace-step-model",
      inputId: "input-step-model",
      eventKey: "event-step-model",
      statusType: "model_request_started",
      requestId: "request-step-model",
      providerId: "provider-custom",
      modelId: "GLM-5.2",
      requestHeaders: {},
      responseHeaders: {},
      requestHeaderCount: 0,
      responseHeaderCount: 0,
    });
    recordAgentStepTelemetryEvent({
      taskId: "task-step-model",
      event: {
        type: "agent_thought_chunk",
        taskId: "task-step-model",
        traceId: "trace-step-model",
        content: "thinking",
      },
      now: 110,
    });

    const [reasoningStep] = recordAgentStepTelemetryEvent({
      taskId: "task-step-model",
      event: {
        type: "agent_message_chunk",
        taskId: "task-step-model",
        traceId: "trace-step-model",
        content: "done",
      },
      now: 150,
    });
    recordPromptTokenUsageDelta({
      taskId: "task-step-model",
      eventKey: "usage-step-model",
      requestId: "request-step-model",
      modelName: "provider-custom/GLM-5.2",
      modelProvider: "provider-custom",
      providerName: "runtime.example.com",
      usage: {
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        reasoningTokens: 6,
        cachedInputTokens: 30,
        cachedWriteInputTokens: 4,
      },
    });
    const [generationStep] = recordAgentStepTelemetryEvent({
      taskId: "task-step-model",
      event: {
        type: "task_complete",
        taskId: "task-step-model",
        traceId: "trace-step-model-complete",
        stopReason: "complete",
      },
      now: 180,
    });

    expect(reasoningStep).toEqual({
      taskId: "task-step-model",
      messageId: "message-step-model",
      eventExtraDetail: expect.objectContaining({
        model_name: "provider-custom/GLM-5.2",
        model_provider: "provider-custom",
        input_tokens: "0",
        total_tokens: "0",
      }),
    });
    expect(generationStep).toEqual({
      taskId: "task-step-model",
      messageId: "message-step-model",
      eventExtraDetail: expect.objectContaining({
        model_name: "provider-custom/GLM-5.2",
        model_provider: "provider-custom",
        provider_name: "runtime.example.com",
        model_request_id: "request-step-model",
        model_request_count: "1",
        token_usage_scope: "model_request",
        input_tokens: "80",
        output_tokens: "20",
        reasoning_tokens: "6",
        cached_tokens: "30",
        cache_write_input_tokens: "4",
        total_tokens: "100",
      }),
    });
  });

  it("attributes foreground subagent usage to its parent Agent tool step", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-subagent-step",
      taskId: "task-subagent-step",
      messageId: "message-subagent-step",
      sendTime: 100,
    });
    activatePromptTelemetry("task-subagent-step", "message-subagent-step");
    recordAgentStepTelemetryEvent({
      taskId: "task-subagent-step",
      event: {
        type: "tool_call",
        taskId: "task-subagent-step",
        traceId: "trace-agent-tool",
        toolId: "tool-agent",
        kind: "Agent",
        toolName: "Agent",
        title: "Agent",
        input: {},
        raw: {},
      },
      now: 120,
    });
    recordSubagentToolAttribution({
      taskId: "task-subagent-step",
      toolCallId: "tool-agent",
      requestIds: ["child-request-1", "child-request-2"],
      requestCount: 2,
      modelName: "child-provider/child-model",
      modelProvider: "child-provider",
      providerName: "child.example.com",
      agentId: "agent-child",
      usage: {
        inputTokens: 150,
        outputTokens: 50,
        totalTokens: 200,
        reasoningTokens: 12,
        cachedInputTokens: 40,
        cachedWriteInputTokens: 5,
      },
    });

    expect(
      recordAgentStepTelemetryEvent({
        taskId: "task-subagent-step",
        event: {
          type: "tool_call_update",
          taskId: "task-subagent-step",
          traceId: "trace-agent-tool-complete",
          toolId: "tool-agent",
          status: "completed",
          kind: "Agent",
          toolName: "Agent",
          raw: {},
        },
        now: 220,
      }),
    ).toEqual([
      {
        taskId: "task-subagent-step",
        messageId: "message-subagent-step",
        eventExtraDetail: expect.objectContaining({
          model_name: "child-provider/child-model",
          model_provider: "child-provider",
          provider_name: "child.example.com",
          agent_id: "agent-child",
          model_request_id: "",
          model_request_count: "2",
          token_usage_scope: "subagent_requests",
          input_tokens: "150",
          output_tokens: "50",
          total_tokens: "200",
        }),
      },
    ]);
  });

  it("keeps a direct tool request usage separate from foreground subagent usage", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-direct-agent-tool",
      taskId: "task-direct-agent-tool",
      messageId: "message-direct-agent-tool",
      inputId: "input-direct-agent-tool",
      sendTime: 100,
    });
    activatePromptTelemetry("task-direct-agent-tool", "message-direct-agent-tool");
    recordPromptModelRequestStarted("task-direct-agent-tool", {
      type: "task_network_debug_status",
      taskId: "task-direct-agent-tool",
      traceId: "trace-main-request",
      inputId: "input-direct-agent-tool",
      eventKey: "main-request-started",
      statusType: "model_request_started",
      requestId: "main-request",
      providerId: "main-provider",
      modelId: "main-model",
      requestHeaders: {},
      responseHeaders: {},
      requestHeaderCount: 0,
      responseHeaderCount: 0,
    });
    recordPromptTokenUsageDelta({
      taskId: "task-direct-agent-tool",
      eventKey: "main-request-usage",
      requestId: "main-request",
      modelName: "main-provider/main-model",
      modelProvider: "main-provider",
      providerName: "main.example.com",
      usage: {
        inputTokens: 75,
        outputTokens: 25,
        totalTokens: 100,
      },
    });

    const [mainRequestStep] = recordAgentStepTelemetryEvent({
      taskId: "task-direct-agent-tool",
      event: {
        type: "tool_call",
        taskId: "task-direct-agent-tool",
        traceId: "trace-agent-tool",
        toolId: "tool-agent-direct",
        kind: "Agent",
        toolName: "Agent",
        title: "Agent",
        input: {},
        raw: {},
      },
      now: 120,
    });
    recordSubagentToolAttribution({
      taskId: "task-direct-agent-tool",
      toolCallId: "tool-agent-direct",
      requestIds: ["child-request"],
      requestCount: 1,
      modelName: "child-provider/child-model",
      modelProvider: "child-provider",
      providerName: "child.example.com",
      agentId: "agent-child",
      usage: {
        inputTokens: 160,
        outputTokens: 40,
        totalTokens: 200,
      },
    });
    const [childToolStep] = recordAgentStepTelemetryEvent({
      taskId: "task-direct-agent-tool",
      event: {
        type: "tool_call_update",
        taskId: "task-direct-agent-tool",
        traceId: "trace-agent-tool-complete",
        toolId: "tool-agent-direct",
        status: "completed",
        kind: "Agent",
        toolName: "Agent",
        raw: {},
      },
      now: 220,
    });

    expect(mainRequestStep?.eventExtraDetail).toMatchObject({
      step_type: "generation",
      model_name: "main-provider/main-model",
      token_usage_scope: "model_request",
      total_tokens: "100",
    });
    expect(childToolStep?.eventExtraDetail).toMatchObject({
      step_type: "tool_call",
      model_name: "child-provider/child-model",
      agent_id: "agent-child",
      token_usage_scope: "subagent_requests",
      total_tokens: "200",
    });
  });

  it("uses the first tool call as time_to_first_token when it arrives before text", () => {
    queuePromptTelemetry({
      workspacePath: "/tmp/workspace-tool-first",
      taskId: "task-tool-first",
      messageId: "message-tool-first",
      sendTime: 100,
    });
    activatePromptTelemetry("task-tool-first", "message-tool-first");

    recordAgentStepTelemetryEvent({
      taskId: "task-tool-first",
      event: {
        type: "tool_call",
        taskId: "task-tool-first",
        traceId: "trace-tool-first",
        toolId: "tool-first",
        kind: "read",
        toolName: "read_file",
        title: "Read file",
        input: {},
        raw: {},
      },
      now: 175,
    });

    expect(
      finalizePromptTelemetry({
        taskId: "task-tool-first",
        status: "success",
        finishedAt: 250,
      })?.eventExtraDetail.time_to_first_token,
    ).toBe("75");
  });
});

describe("composeAgentComposition：fg / bg / wf 三维组合", () => {
  it("枚举八个值", async () => {
    const { composeAgentComposition } = await import("@/lib/messageTelemetry.js");
    const compose = (fg: boolean, bg: boolean, wf: boolean) =>
      composeAgentComposition({
        hasForegroundSubagentResult: fg,
        hasBackgroundSubagentResult: bg,
        hasWorkflowResult: wf,
      });
    expect(compose(false, false, false)).toBe("main_only");
    expect(compose(true, false, false)).toBe("main_plus_fg");
    expect(compose(false, true, false)).toBe("main_plus_bg");
    expect(compose(false, false, true)).toBe("main_plus_wf");
    expect(compose(true, true, false)).toBe("main_plus_fg_bg");
    expect(compose(true, false, true)).toBe("main_plus_fg_wf");
    expect(compose(false, true, true)).toBe("main_plus_bg_wf");
    expect(compose(true, true, true)).toBe("main_plus_fg_bg_wf");
  });
});
