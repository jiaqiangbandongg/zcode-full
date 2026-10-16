import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPlatformService } from "@zcode/shared";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import { resetMessageTelemetryForTest } from "@/lib/messageTelemetry.js";
import {
  clearUiPerfArmsReporterForTest,
  setUiPerfArmsReporter,
} from "@/lib/uiPerfArmsTelemetry.js";
import { ConversationTelemetrySupervisor } from "@/v4/telemetry/conversationTelemetrySupervisor.js";
import { buildV4ConversationPromptTelemetryExtraDetail } from "@/v4/telemetry/conversationPromptTelemetry.js";

function createPlatform() {
  const reportTelemetryEvent = vi.fn(async () => undefined);
  const reportArmsCustomEvent = vi.fn(async () => undefined);
  return {
    platform: {
      reportTelemetryEvent,
      reportArmsCustomEvent,
    } as unknown as IPlatformService,
    reportTelemetryEvent,
    reportArmsCustomEvent,
  };
}

function commonFact(eventId: string, eventSeq: number, sessionId = "session-1") {
  return {
    version: 1 as const,
    eventId,
    eventSeq,
    occurredAt: eventSeq,
    sessionId,
    sourceCommandId: "command-1",
    turnId: "turn-1",
  };
}

function armsByName(
  calls: ReturnType<typeof createPlatform>["reportArmsCustomEvent"],
  name: string,
) {
  return calls.mock.calls.map(([payload]) => payload).filter((payload) => payload.name === name);
}

function reportsByElement(
  calls: ReturnType<typeof createPlatform>["reportTelemetryEvent"],
  elementName: string,
) {
  return calls.mock.calls
    .map(([payload]) => payload)
    .filter((payload) => payload.elementName === elementName);
}

function startForegroundSubagent(supervisor: ConversationTelemetrySupervisor, sendTime: number) {
  supervisor.acceptPromptSeed({
    sessionId: "parent-session",
    sourceCommandId: "parent-command",
    memoryEnabled: true,
    sendTime,
    extraDetail: {
      model_name: "main-provider/main-model",
      model_provider: "main-provider",
    },
  });
  supervisor.handleFact({
    ...commonFact("parent-turn-start", 1, "parent-session"),
    sourceCommandId: "parent-command",
    kind: "turn.started",
    executionKind: "agent",
  });
  supervisor.handleFact({
    ...commonFact("agent-tool-start", 2, "parent-session"),
    sourceCommandId: "parent-command",
    kind: "tool.lifecycle",
    phase: "started",
    toolCallId: "agent-tool",
    toolName: "Agent",
  });
  supervisor.handleFact({
    ...commonFact("subagent-spawned", 3, "parent-session"),
    sourceCommandId: "parent-command",
    kind: "subagent.lifecycle",
    phase: "spawned",
    agentId: "agent-1",
    childSessionId: "child-session",
    parentToolCallId: "agent-tool",
    background: false,
    status: "running",
  });
}

function startForegroundSubagentRequest(supervisor: ConversationTelemetrySupervisor) {
  supervisor.handleFact({
    ...commonFact("child-request-start", 1, "child-session"),
    sourceCommandId: "child-command",
    turnId: "child-turn",
    kind: "model.request.status",
    requestId: "child-request",
    status: "model_request_started",
    providerId: "qwen-provider",
    modelId: "qwen3.7-max",
    providerHostname: "provider.example.com",
    transport: "sse",
    querySource: "subagent",
    attempt: 1,
    maxAttempts: 1,
  });
}

function spawnBackgroundSubagent(
  supervisor: ConversationTelemetrySupervisor,
  input: {
    agentId: string;
    childSessionId: string;
    sourceCommandId?: string;
    parentToolCallId?: string;
    eventId?: string;
    memoryEnabled?: boolean;
  },
) {
  supervisor.handleFact({
    memoryEnabled: input.memoryEnabled,
    ...commonFact(input.eventId ?? `${input.agentId}-spawned`, 1, "parent-session"),
    ...(input.sourceCommandId !== undefined
      ? { sourceCommandId: input.sourceCommandId }
      : { sourceCommandId: "parent-command" }),
    kind: "subagent.lifecycle",
    phase: "spawned",
    agentId: input.agentId,
    childSessionId: input.childSessionId,
    parentToolCallId: input.parentToolCallId ?? `${input.agentId}-parent-tool`,
    background: true,
    status: "running",
  });
}

function reportForegroundSubagentUsage(supervisor: ConversationTelemetrySupervisor) {
  supervisor.handleFact({
    ...commonFact("child-usage", 2, "child-session"),
    sourceCommandId: "child-command",
    turnId: "child-turn",
    kind: "usage.delta",
    requestId: "child-request",
    providerId: "qwen-provider",
    modelId: "qwen3.7-max",
    providerHostname: "provider.example.com",
    inputTokens: 8_616,
    outputTokens: 69,
    totalTokens: 8_685,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 5_797,
  });
}

function terminateForegroundSubagentParent(
  supervisor: ConversationTelemetrySupervisor,
  error?: {
    code?: string;
    message?: string;
  },
) {
  supervisor.handleFact({
    ...commonFact("agent-tool-failed", 4, "parent-session"),
    sourceCommandId: "parent-command",
    kind: "tool.lifecycle",
    phase: "failed",
    toolCallId: "agent-tool",
    toolName: "Agent",
    ...(error?.code ? { errorCode: error.code } : {}),
    errorMessage:
      error?.message ??
      "Agent was cancelled before the subagent returned findings or background launch completed",
  });
  supervisor.handleFact({
    ...commonFact("parent-turn-terminal", 5, "parent-session"),
    sourceCommandId: "parent-command",
    kind: "turn.terminal",
    status: "interrupted",
    resultType: "cancelled",
  });
}

function completionAgentCompositions(
  calls: ReturnType<typeof createPlatform>["reportTelemetryEvent"],
): string[] {
  return reportsByElement(calls, "message_completion").map(
    (report) => report.eventExtraDetail.agent_composition,
  );
}

describe("ConversationTelemetrySupervisor", () => {
  it("父 ACK 未到时 child step 从启动事实读取 Memory", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "memory-child-before-ack",
    });
    spawnBackgroundSubagent(supervisor, {
      agentId: "memory-child",
      childSessionId: "child-session",
      memoryEnabled: true,
    });
    supervisor.handleFact({
      ...commonFact("child-tool", 2, "child-session"),
      kind: "tool.lifecycle",
      phase: "started",
      toolCallId: "read-1",
      toolName: "Read",
    });
    supervisor.handleFact({
      ...commonFact("child-tool-end", 3, "child-session"),
      kind: "tool.lifecycle",
      phase: "completed",
      toolCallId: "read-1",
      toolName: "Read",
    });
    await supervisor.flushReportsForTest();
    const steps = reportsByElement(reportTelemetryEvent, "agent_step");
    expect(steps).toHaveLength(1);
    expect(steps[0].eventExtraDetail.memory_enabled).toBe("1");
    expect(reportsByElement(reportTelemetryEvent, "message_completion")).toHaveLength(0);
    supervisor.dispose();
  });

  it.each([true, false, undefined])(
    "Memory 开关 %s 在三事件保持一致且不读取可变设置",
    async (memoryEnabled) => {
      const { platform, reportTelemetryEvent } = createPlatform();
      const supervisor = new ConversationTelemetrySupervisor({
        platform,
        workspaceScopeKey: "memory-test",
      });
      const seed = {
        sessionId: "session-1",
        sourceCommandId: "command-1",
        sendTime: 1,
        memoryEnabled,
        extraDetail: {},
      };
      // 事实可能先于 ACK 到达，必须复用既有缓冲顺序。
      supervisor.handleFact({
        ...commonFact("memory-start", 1),
        kind: "turn.started",
        memoryEnabled,
      });
      supervisor.acceptPromptSeed(seed);
      seed.memoryEnabled = !memoryEnabled;
      supervisor.handleFact({
        ...commonFact("memory-tool", 2),
        kind: "tool.lifecycle",
        phase: "started",
        toolCallId: "read-1",
        toolName: "Read",
      });
      supervisor.handleFact({
        ...commonFact("memory-tool-end", 3),
        kind: "tool.lifecycle",
        phase: "completed",
        toolCallId: "read-1",
        toolName: "Read",
      });
      supervisor.handleFact({
        ...commonFact("memory-end", 4),
        kind: "turn.terminal",
        status: "success",
        resultType: "success",
      });
      supervisor.acceptPromptSeed(seed);
      await vi.waitFor(() =>
        expect(reportsByElement(reportTelemetryEvent, "message_completion")).toHaveLength(1),
      );
      for (const name of ["send_btn", "message_completion", "agent_step"]) {
        const reports = reportsByElement(reportTelemetryEvent, name);
        expect(reports).toHaveLength(1);
        expect(reports[0].eventExtraDetail.memory_enabled).toBe(
          memoryEnabled === undefined ? "" : memoryEnabled ? "1" : "0",
        );
      }
      supervisor.dispose();
    },
  );

  it.each([true, false])(
    "后台轮从 live fact 继承 Memory %s 且不伪造 send_btn",
    async (memoryEnabled) => {
      const { platform, reportTelemetryEvent } = createPlatform();
      const supervisor = new ConversationTelemetrySupervisor({
        platform,
        workspaceScopeKey: "memory-background",
      });
      supervisor.handleFact({
        ...commonFact("bg-start", 1),
        kind: "turn.started",
        inputSource: "background_task",
        memoryEnabled,
      });
      supervisor.handleFact({
        ...commonFact("bg-end", 2),
        kind: "turn.terminal",
        status: "success",
        resultType: "success",
      });
      await vi.waitFor(() =>
        expect(reportsByElement(reportTelemetryEvent, "message_completion")).toHaveLength(1),
      );
      expect(reportsByElement(reportTelemetryEvent, "send_btn")).toHaveLength(0);
      expect(
        reportsByElement(reportTelemetryEvent, "message_completion")[0].eventExtraDetail
          .memory_enabled,
      ).toBe(memoryEnabled ? "1" : "0");
      supervisor.dispose();
    },
  );

  it.each(["zai", "bigmodel"])(
    "%s 新旧身份在实际请求换模后的完成/step 上报对齐",
    async (family) => {
      const run = async (modern: boolean) => {
        resetMessageTelemetryForTest();
        const { platform, reportTelemetryEvent, reportArmsCustomEvent } = createPlatform();
        // perf_ui_* 走模块级 reporter，与 plan_* 直接经 platform 上报不同，需显式挂载才能观察到。
        setUiPerfArmsReporter(platform);
        let now = 100;
        const supervisor = new ConversationTelemetrySupervisor({
          platform,
          workspaceScopeKey: "compat-workspace",
          now: () => now,
        });
        const detach = supervisor.attachForeground({}, "session-1");
        const team = modern
          ? `account:${family}-team-coding-plan`
          : `builtin:${family}-coding-plan`;
        const start = modern ? `account:${family}-start-plan` : `builtin:${family}-start-plan`;
        supervisor.acceptPromptSeed({
          sessionId: "session-1",
          sourceCommandId: "command-1",
          sendTime: now,
          extraDetail: buildV4ConversationPromptTelemetryExtraDetail({
            configProvider: team,
            modelName: "GLM-5.3",
            providerBaseURL: "https://example.com/api",
            planIdentitySnapshot: {
              generatedAt: 1,
              planStatus: "coding_plan",
              planProductId: "team",
            },
          }),
        });
        supervisor.handleFact({
          ...commonFact("start", 1),
          kind: "turn.started",
          executionKind: "agent",
        });
        let seq = 2;
        for (const providerId of [team, start]) {
          now += 10;
          const requestId = `request-${seq}`;
          const fact = Object.freeze({
            // plan_request 按 eventId 在模块级去重且跨用例保留；family/run 前缀保证每轮都能观察到上报。
            ...commonFact(`${family}-${modern ? "modern" : "legacy"}-request-${seq}`, seq++),
            kind: "model.request.status" as const,
            requestId,
            status: "model_request_started" as const,
            providerId,
            modelId: "GLM-5.3",
            providerHostname: "example.com",
            transport: "fetch" as const,
            querySource: "build",
            attempt: 1,
            maxAttempts: 1,
          });
          supervisor.handleFact(fact);
          expect(fact.providerId).toBe(providerId);
          supervisor.handleFact({
            ...commonFact(`chunk-${seq}`, seq++),
            kind: "stream.chunk",
            channel: "text",
            chunkLength: 5,
            firstChunk: true,
          });
          supervisor.handleFact({
            ...commonFact(`usage-${seq}`, seq++),
            kind: "usage.delta",
            requestId,
            providerId,
            modelId: "GLM-5.3",
            providerHostname: "example.com",
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
          });
          supervisor.handleFact({
            ...commonFact(`tool-${seq}`, seq++),
            kind: "tool.lifecycle",
            phase: "started",
            toolCallId: requestId,
            toolName: "Read",
          });
          supervisor.handleFact({
            ...commonFact(`end-${seq}`, seq++),
            kind: "tool.lifecycle",
            phase: "completed",
            toolCallId: requestId,
            toolName: "Read",
          });
        }
        now += 10;
        const terminal = {
          ...commonFact("terminal", seq++),
          kind: "turn.terminal" as const,
          status: "success" as const,
          resultType: "complete" as const,
        };
        supervisor.handleFact(terminal);
        supervisor.handleFact(terminal);
        await supervisor.flushReportsForTest();
        const reports = reportTelemetryEvent.mock.calls.map(([payload]) => ({
          element: payload.elementName,
          talkId: payload.talkId,
          messageId: payload.messageId,
          // step_id 是每次采集随机生成值，不是统计维度；其他字段完整成对比较。
          detail: Object.fromEntries(
            Object.entries(payload.eventExtraDetail).filter(([key]) => key !== "step_id"),
          ),
        }));
        expect(reports.filter((event) => event.element === "message_completion")).toHaveLength(1);
        expect(
          reports.find((event) => event.element === "message_completion")?.detail,
        ).toMatchObject({
          model_provider: `builtin:${family}-start-plan`,
          model_name: `builtin:${family}-start-plan/GLM-5.3`,
          input_tokens: "20",
          output_tokens: "10",
        });
        expect(
          reports
            .filter((event) => event.element === "agent_step")
            .map((event) => event.detail.model_provider),
        ).toEqual(
          expect.arrayContaining([`builtin:${family}-coding-plan`, `builtin:${family}-start-plan`]),
        );
        // ARMS 侧复用同一份 legacy detail：内置 provider 的旧报表身份必须保留、模型按白名单规范化，
        // 否则内置用户在 plan_ttft / perf_ui_* 看板里会整体落入 custom。
        expect(armsByName(reportArmsCustomEvent, "plan_ttft")[0]?.properties).toMatchObject({
          provider_id: `builtin:${family}-start-plan`,
          provider_scope: "builtin",
          model_name: "glm-5.3",
        });
        expect(armsByName(reportArmsCustomEvent, "perf_ui_first_token")[0]?.properties?.model).toBe(
          "glm-5.3",
        );
        // plan_request 直接使用协议事件里的 provider（account:* 或旧 builtin:*），两种命名空间都应保留。
        const planRequests = armsByName(reportArmsCustomEvent, "plan_request");
        expect(planRequests.map((payload) => payload.properties?.provider_id)).toEqual([
          team,
          start,
        ]);
        for (const payload of planRequests) {
          expect(payload.properties).toMatchObject({
            provider_scope: "builtin",
            model_name: "glm-5.3",
          });
        }
        detach();
        supervisor.dispose();
        return reports;
      };
      expect(await run(true)).toEqual(await run(false));
    },
  );
  beforeEach(() => {
    resetMessageTelemetryForTest();
    clearUiPerfArmsReporterForTest();
  });

  afterEach(() => {
    clearUiPerfArmsReporterForTest();
    resetMessageTelemetryForTest();
  });

  it("send seed 以 V4 config provider 为 model_provider，并保留旧 model value 与 agent 口径", () => {
    expect(
      buildV4ConversationPromptTelemetryExtraDetail({
        agentProvider: "glm",
        configProvider: "custom-provider-id",
        modelName: "custom-model",
        askMode: "plan",
        providerBaseURL: "https://api.example.com/v1/messages?token=secret",
        planIdentitySnapshot: {
          generatedAt: 123,
          planStatus: "coding_plan",
          planProductId: "product-1",
        },
      }),
    ).toEqual({
      ask_mode: "plan",
      model_name: "custom:custom-provider-id:custom-model",
      model_provider: "custom-provider-id",
      provider_name: "api.example.com",
      agent: "glm",
      plan_status: "coding_plan",
      plan_product_id: "product-1",
      message_source: "chat",
      task_trigger: "",
    });
  });

  it("send seed 缺少显式运行时 provider 时沿用 ZCode Agent 默认值", () => {
    expect(
      buildV4ConversationPromptTelemetryExtraDetail({
        configProvider: "glm",
        modelName: "glm-model",
        askMode: "build",
      }),
    ).toMatchObject({
      agent: "glm",
      message_source: "chat",
      model_name: "glm-model",
      model_provider: "glm",
      task_trigger: "",
    });
  });

  it("沿用旧 payload 收口 send/completion/step 与 foreground ARMS", async () => {
    const { platform, reportTelemetryEvent, reportArmsCustomEvent } = createPlatform();
    setUiPerfArmsReporter(platform);
    let now = 100;
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "base\u0000workspace\u00001",
      now: () => now,
    });
    const detach = supervisor.attachForeground({}, "session-1");
    supervisor.recordComposerFocus();
    now = 120;
    supervisor.recordComposerTextChange("hello");
    now = 200;
    supervisor.acceptPromptSeed({
      sessionId: "session-1",
      sourceCommandId: "command-1",
      sendTime: now,
      extraDetail: {
        ask_mode: "build",
        model_name: "seed-model",
        model_provider: "seed-provider",
        agent: "glm",
        plan_status: "unknown",
        plan_product_id: "",
      },
    });

    const send = reportsByElement(reportTelemetryEvent, "send_btn");
    expect(send).toHaveLength(1);
    expect(send[0]).toMatchObject({
      elementName: "send_btn",
      eventRegion: "app",
      eventType: "ck",
      talkId: "session-1",
      messageId: "command-1",
      eventExtraDetail: {
        ask_mode: "build",
        model_name: "seed-model",
        model_provider: "seed-provider",
        agent: "glm",
        plan_status: "unknown",
        plan_product_id: "",
        input_start_time: "100",
        input_first_char_time: "120",
        input_send_time: "200",
      },
    });

    now = 210;
    supervisor.handleFact({
      ...commonFact("event-start", 1),
      kind: "turn.started",
      executionKind: "agent",
    });
    now = 220;
    supervisor.handleFact({
      ...commonFact("event-model", 2),
      kind: "model.request.status",
      requestId: "request-1",
      status: "model_request_started",
      providerId: "runtime-provider",
      modelId: "runtime-model",
      providerHostname: "runtime.example.com",
      transport: "fetch",
      querySource: "build",
      attempt: 1,
      maxAttempts: 3,
    });
    now = 250;
    supervisor.handleFact({
      ...commonFact("event-thought", 3),
      kind: "stream.chunk",
      channel: "thought",
      chunkLength: 10,
      firstChunk: true,
    });
    now = 260;
    supervisor.handleFact({
      ...commonFact("event-permission-request", 4),
      kind: "permission.lifecycle",
      phase: "requested",
      requestId: "permission-1",
      toolCallId: "tool-1",
      toolName: "bash",
    });
    now = 300;
    supervisor.handleFact({
      ...commonFact("event-tool-start", 5),
      kind: "tool.lifecycle",
      phase: "started",
      toolCallId: "tool-1",
      toolName: "bash",
    });
    now = 350;
    supervisor.handleFact({
      ...commonFact("event-permission-response", 6),
      kind: "permission.lifecycle",
      phase: "resolved",
      requestId: "permission-1",
      toolCallId: "tool-1",
      toolName: "bash",
      decision: "allow",
    });
    now = 500;
    supervisor.handleFact({
      ...commonFact("event-tool-complete", 7),
      kind: "tool.lifecycle",
      phase: "completed",
      toolCallId: "tool-1",
      toolName: "bash",
      parentToolCallId: "parent-tool",
      childToolCallId: "child-tool",
      childSessionId: "child-session",
      agentId: "agent-1",
      agentType: "subagent",
      performance: {
        totalMs: 200,
        permissionWaitMs: 90,
        commandRunMs: 110,
        exitCode: 0,
        timedOut: false,
        outputBytes: 42,
        commandCategory: "read",
        commandHash: "0123456789abcdef",
        workspaceKind: "local",
      },
    });
    now = 600;
    supervisor.handleFact({
      ...commonFact("event-text-1", 8),
      kind: "stream.chunk",
      channel: "text",
      chunkLength: 3,
      firstChunk: false,
      assistantMessageId: "assistant-1",
    });
    now = 3_600;
    supervisor.handleFact({
      ...commonFact("event-text-2", 9),
      kind: "stream.chunk",
      channel: "text",
      chunkLength: 3,
      firstChunk: false,
      assistantMessageId: "assistant-1",
    });
    expect(armsByName(reportArmsCustomEvent, "perf_ui_stream_stall")).toHaveLength(0);
    now = 6_601;
    supervisor.handleFact({
      ...commonFact("event-text-3", 10),
      kind: "stream.chunk",
      channel: "text",
      chunkLength: 3,
      firstChunk: false,
      assistantMessageId: "assistant-1",
    });
    expect(armsByName(reportArmsCustomEvent, "perf_ui_stream_stall")).toEqual([
      {
        name: "perf_ui_stream_stall",
        group: "ui_perf",
        value: 3001,
        properties: {
          stall_ms: 3001,
          waiting_tool: false,
          // `runtime-provider` 不是内置 provider，复合模型值必须归一，避免把自定义
          // provider 名与模型名透传到 ARMS。
          model: "custom",
          chunk_type: "message",
          talk_id: "session-1",
          message_id: "assistant-1",
        },
      },
    ]);
    now = 6_700;
    supervisor.handleFact({
      ...commonFact("event-usage", 11),
      kind: "usage.delta",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 18,
      reasoningTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    });
    now = 7_000;
    supervisor.handleFact({
      ...commonFact("event-terminal", 12),
      kind: "turn.terminal",
      status: "success",
      resultType: "complete",
      durationMs: 6_800,
      tokenCount: 18,
      toolCallCount: 1,
    });
    await supervisor.flushReportsForTest();

    const completion = reportsByElement(reportTelemetryEvent, "message_completion");
    expect(completion).toHaveLength(1);
    expect(completion[0]).toMatchObject({
      elementName: "message_completion",
      eventRegion: "app",
      eventType: "agent_trace",
      talkId: "session-1",
      messageId: "command-1",
      eventExtraDetail: {
        ask_mode: "build",
        model_name: "runtime-provider/runtime-model",
        model_provider: "runtime-provider",
        provider_name: "runtime.example.com",
        agent: "glm",
        plan_status: "unknown",
        plan_product_id: "",
        input_tokens: "10",
        output_tokens: "5",
        reasoning_tokens: "3",
        cached_input_tokens: "2",
        cache_write_input_tokens: "1",
        tool_use_prompt_tokens: "0",
        total_tokens: "18",
        duration_ms: "6800",
        waiting_ms: "90",
        generated_code_lines: "0",
        file_change_cnt: "0",
        time_to_first_token: "50",
        request_time: "200",
        status: "success",
        agent_step_cnt: "3",
        retry_cnt: "0",
        tool_call_total: "1",
        tool_call_failed: "0",
        error_type: "",
        error_msg: "",
      },
    });
    expect(reportsByElement(reportTelemetryEvent, "agent_step")).toHaveLength(3);
    expect(armsByName(reportArmsCustomEvent, "plan_request")).toHaveLength(1);
    expect(armsByName(reportArmsCustomEvent, "perf_ui_tool_call_detail")[0]).toMatchObject({
      properties: {
        tool_call_id: "tool-1",
        parent_tool_call_id: "parent-tool",
        child_tool_call_id: "child-tool",
        child_session_id: "child-session",
        agent_id: "agent-1",
        agent_type: "subagent",
      },
    });
    expect(armsByName(reportArmsCustomEvent, "perf_ui_first_token")[0]?.value).toBe(50);
    expect(armsByName(reportArmsCustomEvent, "plan_ttft")[0]?.value).toBe(50);
    expect(armsByName(reportArmsCustomEvent, "perf_ui_message_complete")[0]?.value).toBe(6_800);
    expect(armsByName(reportArmsCustomEvent, "perf_ui_turn_breakdown")[0]).toMatchObject({
      value: 6_800,
      properties: {
        waiting_ms: 90,
        file_change_cnt: 0,
        generated_code_lines: 0,
      },
    });

    detach();
    supervisor.dispose();
  });

  it.each([
    {
      phase: "completed" as const,
      errorMessage: undefined,
      expectedStatus: "success",
      expectedErrorType: "",
      expectedErrorMessage: "",
      expectedFailedCount: "0",
    },
    {
      phase: "failed" as const,
      errorMessage: "exit 2",
      expectedStatus: "fail",
      expectedErrorType: "TOOL_EXEC_ERROR",
      expectedErrorMessage: "exit 2",
      expectedFailedCount: "1",
    },
  ])(
    "工具 $phase terminal 立即收口 /event/report agent_step，不等待 turn terminal",
    async ({
      phase,
      errorMessage,
      expectedStatus,
      expectedErrorType,
      expectedErrorMessage,
      expectedFailedCount,
    }) => {
      const { platform, reportTelemetryEvent } = createPlatform();
      let now = 100;
      const supervisor = new ConversationTelemetrySupervisor({
        platform,
        workspaceScopeKey: `scope-tool-terminal-${phase}`,
        now: () => now,
      });
      supervisor.acceptPromptSeed({
        sessionId: "session-1",
        sourceCommandId: "command-1",
        sendTime: now,
        extraDetail: { model_name: "model", model_provider: "provider" },
      });
      now = 120;
      supervisor.handleFact({
        ...commonFact(`turn-start-${phase}`, 1),
        kind: "turn.started",
        executionKind: "agent",
      });
      now = 200;
      supervisor.handleFact({
        ...commonFact(`tool-start-${phase}`, 2),
        kind: "tool.lifecycle",
        phase: "started",
        toolCallId: "tool-1",
        toolName: "Bash",
      });
      now = 350;
      supervisor.handleFact({
        ...commonFact(`tool-terminal-${phase}`, 3),
        kind: "tool.lifecycle",
        phase,
        toolCallId: "tool-1",
        toolName: "Bash",
        ...(errorMessage ? { errorMessage } : {}),
      });
      await supervisor.flushReportsForTest();

      expect(reportsByElement(reportTelemetryEvent, "message_completion")).toEqual([]);
      expect(reportsByElement(reportTelemetryEvent, "agent_step")).toEqual([
        expect.objectContaining({
          elementName: "agent_step",
          eventType: "agent_trace",
          talkId: "session-1",
          messageId: "command-1",
          eventExtraDetail: expect.objectContaining({
            step_type: "tool_call",
            tool_name: "Bash",
            tool_call_id: "tool-1",
            duration_ms: "150",
            status: expectedStatus,
            error_type: expectedErrorType,
            error_msg: expectedErrorMessage ? "[redacted]" : "",
          }),
        }),
      ]);

      now = 900;
      supervisor.handleFact({
        ...commonFact(`turn-terminal-${phase}`, 4),
        kind: "turn.terminal",
        status: "success",
        resultType: "complete",
      });
      await supervisor.flushReportsForTest();

      expect(
        reportTelemetryEvent.mock.calls
          .map(([payload]) => payload.elementName)
          .filter((name) => name === "agent_step" || name === "message_completion"),
      ).toEqual(["agent_step", "message_completion"]);
      expect(reportsByElement(reportTelemetryEvent, "message_completion")).toEqual([
        expect.objectContaining({
          eventExtraDetail: expect.objectContaining({
            agent_step_cnt: "1",
            tool_call_total: "1",
            tool_call_failed: expectedFailedCount,
          }),
        }),
      ]);
      supervisor.dispose();
    },
  );

  it.each([
    ["main-provider", "child-provider", "main-provider", "child-provider"],
    [
      "account:bigmodel-team-coding-plan",
      "account:zai-start-plan",
      "builtin:bigmodel-coding-plan",
      "builtin:zai-start-plan",
    ],
  ])(
    "主模型 %s、前台 Subagent %s、后续主模型分别保留 usage 与旧统计身份",
    async (mainId, childId, mainReportId, childReportId) => {
      const { platform, reportTelemetryEvent } = createPlatform();
      let now = 100;
      const supervisor = new ConversationTelemetrySupervisor({
        platform,
        workspaceScopeKey: "scope-foreground-subagent-usage",
        now: () => now,
      });
      supervisor.acceptPromptSeed({
        sessionId: "session-1",
        sourceCommandId: "command-1",
        sendTime: now,
        extraDetail: {
          model_name: "seed-model",
          model_provider: "seed-provider",
        },
      });
      supervisor.handleFact({
        ...commonFact("parent-turn-start", 1),
        kind: "turn.started",
        executionKind: "agent",
      });

      now = 110;
      supervisor.handleFact({
        ...commonFact("main-request-1-start", 2),
        kind: "model.request.status",
        requestId: "main-request-1",
        status: "model_request_started",
        providerId: mainId,
        modelId: "main-model",
        providerHostname: "main.example.com",
        transport: "sse",
        querySource: "main_turn",
        attempt: 1,
        maxAttempts: 1,
      });
      now = 120;
      supervisor.handleFact({
        ...commonFact("main-reasoning", 3),
        kind: "stream.chunk",
        channel: "thought",
        chunkLength: 3,
        firstChunk: true,
      });
      now = 130;
      supervisor.handleFact({
        ...commonFact("main-generation-1", 4),
        kind: "stream.chunk",
        channel: "text",
        chunkLength: 4,
        firstChunk: true,
      });
      supervisor.handleFact({
        ...commonFact("main-usage-1", 5),
        kind: "usage.delta",
        requestId: "main-request-1",
        providerId: mainId,
        modelId: "main-model",
        providerHostname: "main.example.com",
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        reasoningTokens: 5,
        cacheReadTokens: 10,
        cacheWriteTokens: 2,
      });

      now = 140;
      supervisor.handleFact({
        ...commonFact("agent-tool-start", 6),
        kind: "tool.lifecycle",
        phase: "started",
        toolCallId: "agent-tool-1",
        toolName: "Agent",
      });
      supervisor.handleFact({
        ...commonFact("subagent-spawned", 7),
        kind: "subagent.lifecycle",
        phase: "spawned",
        agentId: "agent-1",
        agentType: "explore",
        childSessionId: "child-session-1",
        parentToolCallId: "agent-tool-1",
        background: false,
        status: "running",
      });
      supervisor.handleFact({
        // detached child 的 eventId 允许与父 session 同号，去重必须带 sessionId。
        ...commonFact("main-request-1-start", 1, "child-session-1"),
        sourceCommandId: "child-command-1",
        turnId: "child-turn-1",
        kind: "model.request.status",
        requestId: "child-request-1",
        status: "model_request_started",
        providerId: childId,
        modelId: "child-model",
        providerHostname: "child.example.com",
        transport: "sse",
        querySource: "subagent",
        attempt: 1,
        maxAttempts: 1,
      });
      supervisor.handleFact({
        ...commonFact("main-usage-1", 2, "child-session-1"),
        sourceCommandId: "child-command-1",
        turnId: "child-turn-1",
        kind: "usage.delta",
        requestId: "child-request-1",
        providerId: childId,
        modelId: "child-model",
        providerHostname: "child.example.com",
        inputTokens: 150,
        outputTokens: 50,
        totalTokens: 200,
        reasoningTokens: 12,
        cacheReadTokens: 30,
        cacheWriteTokens: 4,
      });
      supervisor.handleFact({
        ...commonFact("subagent-stopped", 8),
        kind: "subagent.lifecycle",
        phase: "stopped",
        agentId: "agent-1",
        agentType: "explore",
        childSessionId: "child-session-1",
        parentToolCallId: "agent-tool-1",
        background: false,
        status: "completed",
      });
      now = 200;
      supervisor.handleFact({
        ...commonFact("agent-tool-complete", 9),
        kind: "tool.lifecycle",
        phase: "completed",
        toolCallId: "agent-tool-1",
        toolName: "Agent",
      });

      now = 210;
      supervisor.handleFact({
        ...commonFact("main-request-2-start", 10),
        kind: "model.request.status",
        requestId: "main-request-2",
        status: "model_request_started",
        providerId: mainId,
        modelId: "main-model",
        providerHostname: "main.example.com",
        transport: "sse",
        querySource: "main_turn",
        attempt: 1,
        maxAttempts: 1,
      });
      supervisor.handleFact({
        ...commonFact("main-generation-2", 11),
        kind: "stream.chunk",
        channel: "text",
        chunkLength: 4,
        firstChunk: true,
      });
      supervisor.handleFact({
        ...commonFact("main-usage-2", 12),
        kind: "usage.delta",
        requestId: "main-request-2",
        providerId: mainId,
        modelId: "main-model",
        providerHostname: "main.example.com",
        inputTokens: 90,
        outputTokens: 30,
        totalTokens: 120,
        reasoningTokens: 0,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
      });
      now = 240;
      supervisor.handleFact({
        ...commonFact("parent-terminal", 13),
        kind: "turn.terminal",
        status: "success",
      });
      await supervisor.flushReportsForTest();

      const steps = reportsByElement(reportTelemetryEvent, "agent_step");
      expect(steps).toHaveLength(4);
      expect(steps.map((step) => step.eventExtraDetail)).toEqual([
        expect.objectContaining({
          step_type: "reasoning",
          model_name: `${mainReportId}/main-model`,
          total_tokens: "0",
        }),
        expect.objectContaining({
          step_type: "generation",
          model_name: `${mainReportId}/main-model`,
          model_request_id: "main-request-1",
          total_tokens: "100",
        }),
        expect.objectContaining({
          step_type: "tool_call",
          tool_name: "Agent",
          model_name: `${childReportId}/child-model`,
          token_usage_scope: "subagent_requests",
          total_tokens: "200",
        }),
        expect.objectContaining({
          step_type: "generation",
          model_name: `${mainReportId}/main-model`,
          model_request_id: "main-request-2",
          total_tokens: "120",
        }),
      ]);
      expect(reportsByElement(reportTelemetryEvent, "message_completion")).toEqual([
        expect.objectContaining({
          messageId: "command-1",
          eventExtraDetail: expect.objectContaining({
            duration_ms: "140",
            request_time: "100",
            agent_step_cnt: "4",
          }),
        }),
      ]);
      expect(
        reportTelemetryEvent.mock.calls
          .map(([payload]) => payload.elementName)
          .filter(
            (elementName) => elementName === "agent_step" || elementName === "message_completion",
          ),
      ).toEqual(["agent_step", "agent_step", "agent_step", "agent_step", "message_completion"]);
      supervisor.dispose();
    },
  );

  it("父 Agent 与镜像 child tool 共享 agent_id，child tool 使用真实 Subagent 模型", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    let now = 100;
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-subagent-tool-agent-id",
      now: () => now,
    });
    supervisor.acceptPromptSeed({
      sessionId: "parent-session",
      sourceCommandId: "parent-command",
      sendTime: now,
      extraDetail: {
        model_name: "main-provider/GLM-5.2-Highspeed",
        model_provider: "main-provider",
      },
    });
    supervisor.handleFact({
      ...commonFact("parent-turn-start", 1, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "turn.started",
      executionKind: "agent",
    });
    supervisor.handleFact({
      ...commonFact("agent-tool-start", 2, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "tool.lifecycle",
      phase: "started",
      toolCallId: "call-parent-agent",
      toolName: "Agent",
    });
    supervisor.handleFact({
      ...commonFact("subagent-spawned", 3, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "subagent.lifecycle",
      phase: "spawned",
      agentId: "agent-child",
      agentType: "Explore",
      childSessionId: "child-session",
      parentToolCallId: "call-parent-agent",
      background: false,
      status: "running",
    });
    supervisor.handleFact({
      ...commonFact("child-request-start", 1, "child-session"),
      sourceCommandId: "child-command",
      turnId: "child-turn",
      kind: "model.request.status",
      requestId: "child-request",
      status: "model_request_started",
      providerId: "qwen-provider",
      modelId: "qwen3.7-max",
      providerHostname: "provider.example.com",
      transport: "sse",
      querySource: "subagent",
      attempt: 1,
      maxAttempts: 1,
    });
    supervisor.handleFact({
      ...commonFact("child-usage", 2, "child-session"),
      sourceCommandId: "child-command",
      turnId: "child-turn",
      kind: "usage.delta",
      requestId: "child-request",
      providerId: "qwen-provider",
      modelId: "qwen3.7-max",
      providerHostname: "provider.example.com",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    const mirroredToolId = "tool_subagent_agent-child_toolu-child";
    const mirroredRelation = {
      agentId: "agent-child",
      agentType: "Explore",
      childSessionId: "child-session",
      childToolCallId: "toolu-child",
      parentToolCallId: "call-parent-agent",
    };
    now = 130;
    supervisor.handleFact({
      ...commonFact("child-tool-start", 4, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "tool.lifecycle",
      phase: "started",
      toolCallId: mirroredToolId,
      toolName: "WebFetch",
      ...mirroredRelation,
    });
    now = 140;
    supervisor.handleFact({
      ...commonFact("subagent-stopped", 5, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "subagent.lifecycle",
      phase: "stopped",
      agentId: "agent-child",
      agentType: "Explore",
      childSessionId: "child-session",
      parentToolCallId: "call-parent-agent",
      background: false,
      status: "completed",
    });
    now = 150;
    supervisor.handleFact({
      // lifecycle 与 mirror 不同流；工具终态即使晚于 stopped 仍需取得 child 归因。
      ...commonFact("child-tool-complete", 6, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "tool.lifecycle",
      phase: "completed",
      toolCallId: mirroredToolId,
      toolName: "WebFetch",
      durationMs: 20,
      ...mirroredRelation,
    });
    now = 170;
    supervisor.handleFact({
      ...commonFact("agent-tool-complete", 7, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "tool.lifecycle",
      phase: "completed",
      toolCallId: "call-parent-agent",
      toolName: "Agent",
    });
    await supervisor.flushReportsForTest();

    const steps = reportsByElement(reportTelemetryEvent, "agent_step");
    const agentStep = steps.find((step) => step.eventExtraDetail.tool_name === "Agent");
    const childToolStep = steps.find((step) => step.eventExtraDetail.tool_name === "WebFetch");
    expect(agentStep?.eventExtraDetail).toEqual(
      expect.objectContaining({
        tool_call_id: "call-parent-agent",
        agent_id: "agent-child",
        agent_role: "foreground subagent",
        model_name: "qwen-provider/qwen3.7-max",
        token_usage_scope: "subagent_requests",
        total_tokens: "120",
      }),
    );
    expect(childToolStep?.eventExtraDetail).toEqual(
      expect.objectContaining({
        tool_call_id: mirroredToolId,
        agent_id: "agent-child",
        agent_role: "foreground subagent",
        model_name: "qwen-provider/qwen3.7-max",
        model_provider: "qwen-provider",
        token_usage_scope: "",
        total_tokens: "0",
      }),
    );
    supervisor.dispose();
  });

  it("父 Agent 非 timeout 终态先到时仍等待 SubagentStopped 回填晚到 usage", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    let now = 100;
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-cancelled-foreground-subagent",
      now: () => now,
    });
    startForegroundSubagent(supervisor, now);
    startForegroundSubagentRequest(supervisor);

    now = 200;
    terminateForegroundSubagentParent(supervisor);
    reportForegroundSubagentUsage(supervisor);
    await supervisor.flushReportsForTest();
    expect(reportsByElement(reportTelemetryEvent, "agent_step")).toHaveLength(0);
    expect(reportsByElement(reportTelemetryEvent, "message_completion")).toHaveLength(0);

    now = 250;
    supervisor.handleFact({
      ...commonFact("subagent-stopped", 6, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "subagent.lifecycle",
      phase: "stopped",
      agentId: "agent-1",
      childSessionId: "child-session",
      parentToolCallId: "agent-tool",
      background: false,
      status: "failed",
    });
    await supervisor.flushReportsForTest();

    expect(reportsByElement(reportTelemetryEvent, "agent_step")).toEqual([
      expect.objectContaining({
        messageId: "parent-command",
        eventExtraDetail: expect.objectContaining({
          step_type: "tool_call",
          tool_name: "Agent",
          status: "fail",
          model_name: "qwen-provider/qwen3.7-max",
          model_provider: "qwen-provider",
          provider_name: "provider.example.com",
          model_request_id: "child-request",
          model_request_count: "1",
          token_usage_scope: "subagent_requests",
          input_tokens: "8616",
          output_tokens: "69",
          cache_write_input_tokens: "5797",
          total_tokens: "8685",
        }),
      }),
    ]);
    expect(reportsByElement(reportTelemetryEvent, "message_completion")).toEqual([
      expect.objectContaining({
        messageId: "parent-command",
        eventExtraDetail: expect.objectContaining({
          request_time: "100",
          duration_ms: "100",
          agent_step_cnt: "1",
        }),
      }),
    ]);
    expect(
      reportTelemetryEvent.mock.calls
        .map(([payload]) => payload.elementName)
        .filter(
          (elementName) => elementName === "agent_step" || elementName === "message_completion",
        ),
    ).toEqual(["agent_step", "message_completion"]);
    supervisor.dispose();
  });

  it("main completion 没有 subagent 结果时上报 0，background child 停止本身不计入结果", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-subagent-result-none",
    });
    supervisor.acceptPromptSeed({
      sessionId: "parent-session",
      sourceCommandId: "parent-command",
      sendTime: 100,
      extraDetail: { model_name: "main-model", model_provider: "main-provider" },
    });
    supervisor.handleFact({
      ...commonFact("parent-turn-start", 1, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "turn.started",
    });
    spawnBackgroundSubagent(supervisor, {
      agentId: "background-agent",
      childSessionId: "background-child",
      sourceCommandId: "parent-command",
      parentToolCallId: "background-agent-tool",
    });
    supervisor.handleFact({
      ...commonFact("background-stopped", 2, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "subagent.lifecycle",
      phase: "stopped",
      agentId: "background-agent",
      childSessionId: "background-child",
      parentToolCallId: "background-agent-tool",
      background: true,
      status: "completed",
    });
    supervisor.handleFact({
      ...commonFact("parent-terminal", 3, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "turn.terminal",
      status: "success",
    });
    await supervisor.flushReportsForTest();

    expect(completionAgentCompositions(reportTelemetryEvent)).toEqual(["main_only"]);
    supervisor.dispose();
  });

  it("foreground subagent 结果在 child stopped 后计为 main_plus_fg", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-subagent-result-foreground",
    });
    startForegroundSubagent(supervisor, 100);
    supervisor.handleFact({
      ...commonFact("foreground-stopped", 4, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "subagent.lifecycle",
      phase: "stopped",
      agentId: "agent-1",
      childSessionId: "child-session",
      parentToolCallId: "agent-tool",
      background: false,
      status: "completed",
    });
    supervisor.handleFact({
      ...commonFact("parent-terminal", 5, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "turn.terminal",
      status: "success",
    });
    await supervisor.flushReportsForTest();

    expect(completionAgentCompositions(reportTelemetryEvent)).toEqual(["main_plus_fg"]);
    supervisor.dispose();
  });

  it("background notification dequeue 后启动的 main turn 计为 main_plus_bg", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-subagent-result-background",
    });
    supervisor.handleFact({
      ...commonFact("background-wake-start", 1, "session-1"),
      sourceCommandId: "background-wake-command",
      kind: "turn.started",
      inputSource: "background_task",
      backgroundSource: "subagent",
    });
    supervisor.handleFact({
      ...commonFact("background-wake-terminal", 2, "session-1"),
      sourceCommandId: "background-wake-command",
      kind: "turn.terminal",
      status: "success",
      backgroundSubagentResultConsumed: true,
    });
    await supervisor.flushReportsForTest();

    expect(completionAgentCompositions(reportTelemetryEvent)).toEqual(["main_plus_bg"]);
    expect(
      reportsByElement(reportTelemetryEvent, "message_completion")[0]?.eventExtraDetail,
    ).toMatchObject({
      message_source: "background_subagent",
    });
    supervisor.dispose();
  });

  it("background notification 无具体来源时保留 background_task 来源", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-background-bash-composition",
    });
    supervisor.handleFact({
      ...commonFact("background-bash-start", 1, "session-1"),
      sourceCommandId: "background-bash-command",
      kind: "turn.started",
      inputSource: "background_task",
    });
    supervisor.handleFact({
      ...commonFact("background-bash-terminal", 2, "session-1"),
      sourceCommandId: "background-bash-command",
      kind: "turn.terminal",
      status: "success",
      backgroundSubagentResultConsumed: true,
    });
    await supervisor.flushReportsForTest();

    expect(completionAgentCompositions(reportTelemetryEvent)).toEqual(["main_plus_bg"]);
    expect(
      reportsByElement(reportTelemetryEvent, "message_completion")[0]?.eventExtraDetail,
    ).toMatchObject({ message_source: "background_task" });
    supervisor.dispose();
  });

  it("background Bash 发起后在 active-loop 消费 subagent 结果仍保留 background_task 来源", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-background-bash-active-loop-subagent",
    });
    supervisor.handleFact({
      ...commonFact("background-bash-active-loop-start", 1, "session-1"),
      sourceCommandId: "background-bash-active-loop-command",
      kind: "turn.started",
      inputSource: "background_task",
      backgroundSource: "bash",
    });
    supervisor.handleFact({
      ...commonFact("background-bash-active-loop-terminal", 2, "session-1"),
      sourceCommandId: "background-bash-active-loop-command",
      kind: "turn.terminal",
      status: "success",
      backgroundSubagentResultConsumed: true,
    });
    await supervisor.flushReportsForTest();

    expect(completionAgentCompositions(reportTelemetryEvent)).toEqual(["main_plus_bg"]);
    expect(
      reportsByElement(reportTelemetryEvent, "message_completion")[0]?.eventExtraDetail,
    ).toMatchObject({ message_source: "background_task" });
    supervisor.dispose();
  });

  it("用户 query active-loop 消费 background subagent 结果仍保持 chat 来源", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-user-query-background-result",
    });
    supervisor.acceptPromptSeed({
      sessionId: "session-1",
      sourceCommandId: "user-command",
      sendTime: 1,
      extraDetail: { message_source: "chat" },
    });
    supervisor.handleFact({
      ...commonFact("user-turn-start", 1, "session-1"),
      sourceCommandId: "user-command",
      kind: "turn.started",
      executionKind: "agent",
    });
    supervisor.handleFact({
      ...commonFact("user-turn-terminal", 2, "session-1"),
      sourceCommandId: "user-command",
      kind: "turn.terminal",
      status: "success",
      backgroundSubagentResultConsumed: true,
    });
    await supervisor.flushReportsForTest();

    expect(completionAgentCompositions(reportTelemetryEvent)).toEqual(["main_plus_bg"]);
    expect(
      reportsByElement(reportTelemetryEvent, "message_completion")[0]?.eventExtraDetail,
    ).toMatchObject({
      message_source: "chat",
    });
    supervisor.dispose();
  });

  it("同一 main wake turn 同时消费结果时计为 main_plus_fg_bg", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-subagent-result-mixed",
    });
    supervisor.handleFact({
      ...commonFact("mixed-wake-start", 1, "session-1"),
      sourceCommandId: "mixed-wake-command",
      kind: "turn.started",
      inputSource: "background_task",
    });
    supervisor.handleFact({
      ...commonFact("mixed-agent-start", 2, "session-1"),
      sourceCommandId: "mixed-wake-command",
      kind: "tool.lifecycle",
      phase: "started",
      toolCallId: "mixed-agent-tool",
      toolName: "Agent",
    });
    supervisor.handleFact({
      ...commonFact("mixed-foreground-spawned", 3, "session-1"),
      sourceCommandId: "mixed-wake-command",
      kind: "subagent.lifecycle",
      phase: "spawned",
      agentId: "foreground-agent",
      childSessionId: "mixed-foreground-child",
      parentToolCallId: "mixed-agent-tool",
      background: false,
      status: "running",
    });
    supervisor.handleFact({
      ...commonFact("mixed-foreground-stopped", 4, "session-1"),
      sourceCommandId: "mixed-wake-command",
      kind: "subagent.lifecycle",
      phase: "stopped",
      agentId: "foreground-agent",
      childSessionId: "mixed-foreground-child",
      parentToolCallId: "mixed-agent-tool",
      background: false,
      status: "completed",
    });
    supervisor.handleFact({
      ...commonFact("mixed-agent-completed", 5, "session-1"),
      sourceCommandId: "mixed-wake-command",
      kind: "tool.lifecycle",
      phase: "completed",
      toolCallId: "mixed-agent-tool",
      toolName: "Agent",
    });
    supervisor.handleFact({
      ...commonFact("mixed-wake-terminal", 6, "session-1"),
      sourceCommandId: "mixed-wake-command",
      kind: "turn.terminal",
      status: "success",
      backgroundSubagentResultConsumed: true,
    });
    await supervisor.flushReportsForTest();

    expect(completionAgentCompositions(reportTelemetryEvent)).toEqual(["main_plus_fg_bg"]);
    supervisor.dispose();
  });

  it("background child 工具逐条上报，Agent step 独占累计 token，不生成 thought/generation/completion", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    let now = 100;
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-background-tool-step",
      now: () => now,
    });
    supervisor.acceptPromptSeed({
      sessionId: "parent-session",
      sourceCommandId: "parent-command",
      sendTime: now,
      memoryEnabled: true,
      extraDetail: {},
    });
    spawnBackgroundSubagent(supervisor, {
      agentId: "agent-background",
      childSessionId: "child-background",
    });

    now = 120;
    supervisor.handleFact({
      ...commonFact("child-model-started", 1, "child-background"),
      sourceCommandId: undefined,
      kind: "model.request.status",
      requestId: "child-request",
      status: "model_request_started",
      providerId: "child-provider",
      modelId: "child-model",
      providerHostname: "child.example.com",
      transport: "sse",
      querySource: "subagent",
      attempt: 1,
      maxAttempts: 1,
    });
    now = 130;
    supervisor.handleFact({
      ...commonFact("child-thought", 2, "child-background"),
      sourceCommandId: undefined,
      kind: "stream.chunk",
      channel: "thought",
      chunkLength: 10,
      firstChunk: true,
    });
    now = 140;
    supervisor.handleFact({
      ...commonFact("child-text", 3, "child-background"),
      sourceCommandId: undefined,
      kind: "stream.chunk",
      channel: "text",
      chunkLength: 10,
      firstChunk: true,
      assistantMessageId: "child-message",
    });
    now = 150;
    supervisor.handleFact({
      ...commonFact("child-usage", 4, "child-background"),
      sourceCommandId: undefined,
      kind: "usage.delta",
      requestId: "child-request",
      providerId: "child-provider",
      modelId: "child-model",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      reasoningTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 5,
    });
    now = 160;
    supervisor.handleFact({
      ...commonFact("child-tool-started", 5, "child-background"),
      sourceCommandId: undefined,
      kind: "tool.lifecycle",
      phase: "started",
      toolCallId: "child-tool",
      toolName: "Bash",
    });
    now = 180;
    supervisor.handleFact({
      ...commonFact("child-tool-completed", 6, "child-background"),
      sourceCommandId: undefined,
      kind: "tool.lifecycle",
      phase: "completed",
      toolCallId: "child-tool",
      toolName: "Bash",
    });
    now = 190;
    supervisor.handleFact({
      ...commonFact("child-terminal", 7, "child-background"),
      sourceCommandId: undefined,
      kind: "turn.terminal",
      status: "success",
    });
    await supervisor.flushReportsForTest();

    expect(
      reportTelemetryEvent.mock.calls
        .map(([payload]) => payload.elementName)
        .filter((name) => name === "agent_step" || name === "message_completion"),
    ).toEqual(["agent_step", "agent_step"]);
    expect(
      reportsByElement(reportTelemetryEvent, "agent_step").map(
        (report) => report.eventExtraDetail.memory_enabled,
      ),
    ).toEqual(["1", "1"]);
    expect(reportsByElement(reportTelemetryEvent, "agent_step")).toEqual([
      expect.objectContaining({
        talkId: "parent-session",
        messageId: "parent-command",
        eventExtraDetail: expect.objectContaining({
          step_type: "tool_call",
          tool_name: "Bash",
          tool_call_id: "tool_subagent_agent-background_child-tool",
          loop_index: "1",
          agent_id: "agent-background",
          agent_role: "background subagent",
          model_name: "child-provider/child-model",
          model_provider: "child-provider",
          provider_name: "child.example.com",
          token_usage_scope: "",
          total_tokens: "0",
          duration_ms: "20",
        }),
      }),
      expect.objectContaining({
        talkId: "parent-session",
        messageId: "parent-command",
        eventExtraDetail: expect.objectContaining({
          step_type: "tool_call",
          tool_name: "Agent",
          tool_call_id: "tool_subagent_agent-background_agent-background-parent-tool",
          loop_index: "2",
          agent_id: "agent-background",
          agent_role: "background subagent",
          model_name: "child-provider/child-model",
          token_usage_scope: "subagent_requests",
          model_request_count: "1",
          input_tokens: "100",
          output_tokens: "20",
          total_tokens: "120",
          reasoning_tokens: "3",
          cached_tokens: "4",
          cache_write_input_tokens: "5",
          duration_ms: "90",
          status: "success",
        }),
      }),
    ]);
    expect(reportsByElement(reportTelemetryEvent, "message_completion")).toHaveLength(0);
    supervisor.dispose();
  });

  it.each(["success", "failed", "interrupted"] as const)(
    "background %s 终态保留每个 child 的累计 usage，重复 usage/stopped/terminal 不重复上报",
    async (status) => {
      const { platform, reportTelemetryEvent } = createPlatform();
      const supervisor = new ConversationTelemetrySupervisor({
        platform,
        workspaceScopeKey: "bg-usage",
      });
      startForegroundSubagent(supervisor, 10);
      for (const agentId of ["a", "b", "c"]) {
        spawnBackgroundSubagent(supervisor, { agentId, childSessionId: agentId });
        supervisor.handleFact({
          ...commonFact(`${agentId}-request`, 1, agentId),
          kind: "model.request.status",
          status: "model_request_started",
          requestId: `${agentId}-r1`,
          providerId: "provider",
          modelId: "model",
          transport: "sse",
          querySource: "subagent",
          attempt: 1,
          maxAttempts: 1,
        });
      }
      terminateForegroundSubagentParent(supervisor);
      supervisor.handleFact({
        ...commonFact("fg-stopped", 8, "parent-session"),
        kind: "subagent.lifecycle",
        phase: "stopped",
        agentId: "agent-1",
        childSessionId: "child-session",
        parentToolCallId: "agent-tool",
        background: false,
        status: "stopped",
      });
      await supervisor.flushReportsForTest();
      const parentCompletion = reportsByElement(reportTelemetryEvent, "message_completion");
      expect(parentCompletion).toHaveLength(1);
      for (const [index, agentId] of ["a", "b", "c"].entries()) {
        for (const [eventId, requestId] of [
          ["u1", "r1"],
          ["u1-copy", "r1"],
          ["u2", "r2"],
        ]) {
          supervisor.handleFact({
            ...commonFact(`${agentId}-${eventId}`, 10, agentId),
            kind: "usage.delta",
            requestId: `${agentId}-${requestId}`,
            providerId: "provider",
            modelId: "model",
            inputTokens: 100 * (index + 1),
            outputTokens: 20,
            totalTokens: 100 * (index + 1) + 20,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          });
        }
        await supervisor.flushReportsForTest();
        expect(
          reportsByElement(reportTelemetryEvent, "agent_step").filter(
            (r) => r.eventExtraDetail.agent_id === agentId,
          ),
        ).toHaveLength(0);
        for (const eventId of ["terminal", "terminal-copy"]) {
          supervisor.handleFact({
            ...commonFact(`${agentId}-${eventId}`, 20, agentId),
            kind: "turn.terminal",
            status,
            ...(status !== "success"
              ? { errorCode: "CHILD_FAILED", errorMessage: "child stopped" }
              : {}),
          });
        }
        supervisor.handleFact({
          ...commonFact(`${agentId}-stopped`, 21, "parent-session"),
          kind: "subagent.lifecycle",
          phase: "stopped",
          background: true,
          agentId,
          childSessionId: agentId,
          parentToolCallId: `${agentId}-parent-tool`,
          status: "stopped",
        });
      }
      await supervisor.flushReportsForTest();
      const background = reportsByElement(reportTelemetryEvent, "agent_step").filter(
        (r) => r.eventExtraDetail.agent_role === "background subagent",
      );
      expect(background).toHaveLength(3);
      for (const [index, step] of background.entries()) {
        expect(step.eventExtraDetail).toMatchObject({
          tool_name: "Agent",
          loop_index: "1",
          model_request_count: "2",
          token_usage_scope: "subagent_requests",
          total_tokens: String(240 + index * 200),
          status: status === "success" ? "success" : "fail",
          error_msg: status === "success" ? "" : "[redacted]",
        });
      }
      expect(reportsByElement(reportTelemetryEvent, "message_completion")).toEqual(
        parentCompletion,
      );
      supervisor.dispose();
    },
  );

  it.each([
    { status: "completed", hasUsage: true },
    { status: "failed", hasUsage: true },
    { status: "stopped", hasUsage: true },
    { status: "completed", hasUsage: false },
    { status: "failed", hasUsage: false },
    { status: "stopped", hasUsage: false },
  ])(
    "background 仅 stopped=$status 也结算一次（hasUsage=$hasUsage）",
    async ({ status, hasUsage }) => {
      const { platform, reportTelemetryEvent, reportArmsCustomEvent } = createPlatform();
      let now = 100;
      const supervisor = new ConversationTelemetrySupervisor({
        platform,
        workspaceScopeKey: "bg-stopped-usage",
        now: () => now,
      });
      spawnBackgroundSubagent(supervisor, { agentId: "bg", childSessionId: "child-bg" });
      supervisor.handleFact({
        ...commonFact("request", 1, "child-bg"),
        kind: "model.request.status",
        status: "model_request_started",
        requestId: "request-bg",
        providerId: "provider",
        modelId: "model",
        providerHostname: "provider.example.com",
        transport: "sse",
        querySource: "subagent",
        attempt: 1,
        maxAttempts: 1,
      });
      if (hasUsage) {
        supervisor.handleFact({
          ...commonFact("usage", 2, "child-bg"),
          kind: "usage.delta",
          requestId: "request-bg",
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
          reasoningTokens: 5,
          cacheReadTokens: 30,
          cacheWriteTokens: 40,
        });
      }
      await supervisor.flushReportsForTest();
      expect(reportsByElement(reportTelemetryEvent, "agent_step")).toHaveLength(0);
      now = 250;
      const armsBeforeStopped = reportArmsCustomEvent.mock.calls.slice();
      const stopped = {
        ...commonFact("stopped", 3, "parent-session"),
        kind: "subagent.lifecycle" as const,
        phase: "stopped" as const,
        background: true,
        agentId: "bg",
        childSessionId: "child-bg",
        parentToolCallId: "bg-parent-tool",
        status,
        ...(status === "completed"
          ? {}
          : { errorMessage: "provider failure or user cancellation" }),
      };
      supervisor.handleFact(stopped);
      await supervisor.flushReportsForTest();
      const reports = reportsByElement(reportTelemetryEvent, "agent_step");
      expect(reports).toEqual([
        expect.objectContaining({
          talkId: "parent-session",
          messageId: "parent-command",
          eventExtraDetail: expect.objectContaining({
            agent_id: "bg",
            agent_role: "background subagent",
            tool_name: "Agent",
            tool_call_id: "tool_subagent_bg_bg-parent-tool",
            child_session_id: "child-bg",
            parent_tool_call_id: "bg-parent-tool",
            loop_index: "1",
            duration_ms: "150",
            model_name: "provider/model",
            model_provider: "provider",
            provider_name: "provider.example.com",
            model_request_count: hasUsage ? "1" : "0",
            token_usage_scope: hasUsage ? "subagent_requests" : "",
            input_tokens: hasUsage ? "100" : "0",
            output_tokens: hasUsage ? "20" : "0",
            total_tokens: hasUsage ? "120" : "0",
            reasoning_tokens: hasUsage ? "5" : "0",
            cached_tokens: hasUsage ? "30" : "0",
            cache_write_input_tokens: hasUsage ? "40" : "0",
            status: status === "completed" ? "success" : "fail",
            error_type: status === "completed" ? "" : "TOOL_EXEC_ERROR",
            error_msg: status === "completed" ? "" : "[redacted]",
          }),
        }),
      ]);
      supervisor.handleFact({ ...stopped, eventId: "stopped-copy" });
      supervisor.handleFact({
        ...commonFact("late-terminal", 4, "child-bg"),
        kind: "turn.terminal",
        status: "failed",
        errorMessage: "late error must not replace the first terminal",
      });
      await supervisor.flushReportsForTest();
      expect(reportsByElement(reportTelemetryEvent, "agent_step")).toEqual(reports);
      expect(reportsByElement(reportTelemetryEvent, "message_completion")).toHaveLength(0);
      expect(reportsByElement(reportTelemetryEvent, "send_btn")).toHaveLength(0);
      expect(reportArmsCustomEvent.mock.calls).toEqual(armsBeforeStopped);
      supervisor.dispose();
    },
  );

  it("background child 的 loop_index 按 child 独立递增，并行 child 互不影响", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-background-loop-index",
      now: () => 100,
    });
    spawnBackgroundSubagent(supervisor, {
      agentId: "agent-a",
      childSessionId: "child-a",
    });
    spawnBackgroundSubagent(supervisor, {
      agentId: "agent-b",
      childSessionId: "child-b",
    });

    for (const [index, childSessionId, , toolCallId] of [
      ["a-1", "child-a", "agent-a", "tool-a-1"],
      ["b-1", "child-b", "agent-b", "tool-b-1"],
      ["a-2", "child-a", "agent-a", "tool-a-2"],
      ["b-2", "child-b", "agent-b", "tool-b-2"],
    ] as const) {
      supervisor.handleFact({
        ...commonFact(`${index}-started`, 10, childSessionId),
        sourceCommandId: undefined,
        kind: "tool.lifecycle",
        phase: "started",
        toolCallId,
        toolName: "Read",
      });
      supervisor.handleFact({
        ...commonFact(`${index}-completed`, 11, childSessionId),
        sourceCommandId: undefined,
        kind: "tool.lifecycle",
        phase: "completed",
        toolCallId,
        toolName: "Read",
      });
    }
    await supervisor.flushReportsForTest();

    const steps = reportsByElement(reportTelemetryEvent, "agent_step");
    expect(
      steps.map((step) => [
        step.eventExtraDetail.agent_id,
        step.eventExtraDetail.loop_index,
        step.eventExtraDetail.tool_call_id,
      ]),
    ).toEqual([
      ["agent-a", "1", "tool_subagent_agent-a_tool-a-1"],
      ["agent-b", "1", "tool_subagent_agent-b_tool-b-1"],
      ["agent-a", "2", "tool_subagent_agent-a_tool-a-2"],
      ["agent-b", "2", "tool_subagent_agent-b_tool-b-2"],
    ]);
    expect(reportsByElement(reportTelemetryEvent, "message_completion")).toHaveLength(0);
    supervisor.dispose();
  });

  it("background stopped 汇总后仍收口全部已开始工具，不重复汇总或补算晚到 usage", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    let now = 100;
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-background-late-tool-terminal",
      now: () => now,
    });
    spawnBackgroundSubagent(supervisor, {
      agentId: "agent-background",
      childSessionId: "child-background",
    });
    supervisor.handleFact({
      ...commonFact("child-tool-started", 2, "child-background"),
      sourceCommandId: undefined,
      kind: "tool.lifecycle",
      phase: "started",
      toolCallId: "child-tool",
      toolName: "Bash",
    });
    supervisor.handleFact({
      ...commonFact("child-tool-2-started", 3, "child-background"),
      kind: "tool.lifecycle",
      phase: "started",
      toolCallId: "child-tool-2",
      toolName: "Read",
    });
    const usage = {
      ...commonFact("child-usage", 4, "child-background"),
      kind: "usage.delta" as const,
      requestId: "child-request",
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    supervisor.handleFact(usage);
    now = 110;
    const permission = {
      ...commonFact("permission-requested", 5, "child-background"),
      kind: "permission.lifecycle" as const,
      phase: "requested" as const,
      requestId: "child-permission",
      toolCallId: "child-tool",
    };
    supervisor.handleFact(permission);
    now = 120;
    supervisor.handleFact({
      ...commonFact("subagent-stopped", 3, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "subagent.lifecycle",
      phase: "stopped",
      agentId: "agent-background",
      childSessionId: "child-background",
      parentToolCallId: "agent-background-parent-tool",
      background: true,
      status: "stopped",
    });
    now = 150;
    supervisor.handleFact({ ...permission, eventId: "permission-resolved", phase: "resolved" });
    // stopped 后不能因未知工具/权限事实重新开启一份 telemetry 工作。
    supervisor.handleFact({ ...permission, eventId: "late-permission", toolCallId: "late-tool" });
    supervisor.handleFact({
      ...commonFact("late-tool-started", 6, "child-background"),
      kind: "tool.lifecycle",
      phase: "started",
      toolCallId: "late-tool",
      toolName: "Bash",
    });
    now = 160;
    await supervisor.flushReportsForTest();
    const aggregate = reportsByElement(reportTelemetryEvent, "agent_step");
    expect(aggregate).toHaveLength(1);
    expect(aggregate[0]?.eventExtraDetail).toMatchObject({
      tool_name: "Agent",
      loop_index: "3",
      status: "fail",
      total_tokens: "120",
      token_usage_scope: "subagent_requests",
    });
    supervisor.handleFact({ ...usage, eventId: "late-usage", requestId: "late-request" });
    supervisor.handleFact({
      ...commonFact("stopped-copy", 4, "parent-session"),
      kind: "subagent.lifecycle",
      phase: "stopped",
      agentId: "agent-background",
      childSessionId: "child-background",
      parentToolCallId: "agent-background-parent-tool",
      background: true,
      status: "stopped",
    });
    supervisor.handleFact({
      ...commonFact("child-tool-completed", 4, "child-background"),
      sourceCommandId: undefined,
      kind: "tool.lifecycle",
      phase: "completed",
      toolCallId: "child-tool",
      toolName: "Bash",
    });
    supervisor.handleFact({
      ...commonFact("child-tool-completed-copy", 7, "child-background"),
      kind: "tool.lifecycle",
      phase: "completed",
      toolCallId: "child-tool",
      toolName: "Bash",
    });
    supervisor.handleFact({
      ...commonFact("child-tool-2-completed", 5, "child-background"),
      kind: "tool.lifecycle",
      phase: "completed",
      toolCallId: "child-tool-2",
      toolName: "Read",
    });
    supervisor.handleFact({
      ...commonFact("child-terminal", 5, "child-background"),
      sourceCommandId: undefined,
      kind: "turn.terminal",
      status: "interrupted",
      resultType: "cancelled",
    });
    await supervisor.flushReportsForTest();

    expect(reportsByElement(reportTelemetryEvent, "agent_step")).toEqual([
      ...aggregate,
      expect.objectContaining({
        messageId: "parent-command",
        eventExtraDetail: expect.objectContaining({
          tool_name: "Bash",
          tool_call_id: "tool_subagent_agent-background_child-tool",
          agent_id: "agent-background",
          agent_role: "background subagent",
          total_tokens: "0",
          loop_index: "1",
          waiting_ms: "40",
        }),
      }),
      expect.objectContaining({
        eventExtraDetail: expect.objectContaining({
          tool_name: "Read",
          loop_index: "2",
          total_tokens: "0",
        }),
      }),
    ]);
    expect(reportsByElement(reportTelemetryEvent, "message_completion")).toHaveLength(0);
    supervisor.dispose();
  });

  it("background child 没有待收口工具时在 SubagentStopped 后清理 ledger", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-background-stopped-without-tool",
      now: () => 100,
    });
    spawnBackgroundSubagent(supervisor, {
      agentId: "agent-background",
      childSessionId: "child-background",
    });
    supervisor.handleFact({
      ...commonFact("subagent-stopped", 2, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "subagent.lifecycle",
      phase: "stopped",
      agentId: "agent-background",
      childSessionId: "child-background",
      parentToolCallId: "agent-background-parent-tool",
      background: true,
      status: "failed",
    });
    supervisor.handleFact({
      ...commonFact("late-tool-completed", 3, "child-background"),
      sourceCommandId: undefined,
      kind: "tool.lifecycle",
      phase: "completed",
      toolCallId: "late-tool",
      toolName: "Bash",
    });
    await supervisor.flushReportsForTest();

    expect(reportsByElement(reportTelemetryEvent, "agent_step")).toEqual([
      expect.objectContaining({
        eventExtraDetail: expect.objectContaining({
          tool_name: "Agent",
          status: "fail",
          total_tokens: "0",
        }),
      }),
    ]);
    expect(reportsByElement(reportTelemetryEvent, "message_completion")).toHaveLength(0);
    supervisor.dispose();
  });

  it.each([
    { status: "success", hasUsage: false },
    { status: "failed", hasUsage: false },
    { status: "interrupted", hasUsage: false },
    { status: "success", hasUsage: true },
  ] as const)(
    "background $status 终态无 usage 也上报 Agent step（hasUsage=$hasUsage）",
    async ({ status, hasUsage }) => {
      const { platform, reportTelemetryEvent } = createPlatform();
      const supervisor = new ConversationTelemetrySupervisor({
        platform,
        workspaceScopeKey: "scope-background-terminal-only",
        now: () => 100,
      });
      spawnBackgroundSubagent(supervisor, {
        agentId: "agent-1",
        childSessionId: "child-session",
      });
      startForegroundSubagentRequest(supervisor);
      if (hasUsage) {
        supervisor.handleFact({
          ...commonFact("child-zero-usage", 2, "child-session"),
          kind: "usage.delta",
          requestId: "child-request",
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
      }
      supervisor.handleFact({
        ...commonFact("child-thought", 3, "child-session"),
        sourceCommandId: undefined,
        kind: "stream.chunk",
        channel: "text",
        chunkLength: 1,
        firstChunk: true,
      });
      await supervisor.flushReportsForTest();
      expect(reportsByElement(reportTelemetryEvent, "agent_step")).toHaveLength(0);
      for (const eventId of ["child-terminal", "duplicate-terminal"]) {
        supervisor.handleFact({
          ...commonFact(eventId, 4, "child-session"),
          sourceCommandId: undefined,
          kind: "turn.terminal",
          status,
          ...(status !== "success" ? { errorMessage: "child stopped without usage" } : {}),
        });
      }
      await supervisor.flushReportsForTest();

      expect(reportsByElement(reportTelemetryEvent, "agent_step")).toEqual([
        expect.objectContaining({
          talkId: "parent-session",
          messageId: "parent-command",
          eventExtraDetail: expect.objectContaining({
            step_type: "tool_call",
            tool_name: "Agent",
            tool_call_id: "tool_subagent_agent-1_agent-1-parent-tool",
            agent_id: "agent-1",
            agent_role: "background subagent",
            loop_index: "1",
            model_name: "qwen-provider/qwen3.7-max",
            model_provider: "qwen-provider",
            provider_name: "provider.example.com",
            model_request_id: hasUsage ? "child-request" : "",
            model_request_count: hasUsage ? "1" : "0",
            token_usage_scope: hasUsage ? "subagent_requests" : "",
            input_tokens: "0",
            output_tokens: "0",
            reasoning_tokens: "0",
            cached_tokens: "0",
            cache_write_input_tokens: "0",
            total_tokens: "0",
            status: status === "success" ? "success" : "fail",
            error_type: status === "success" ? "" : "TOOL_EXEC_ERROR",
            error_msg: status === "success" ? "" : "[redacted]",
          }),
        }),
      ]);
      expect(reportsByElement(reportTelemetryEvent, "send_btn")).toHaveLength(0);
      expect(reportsByElement(reportTelemetryEvent, "message_completion")).toHaveLength(0);
      supervisor.dispose();
    },
  );

  it("background child 的 failed tool lifecycle 按 foreground 口径保留错误", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-background-tool-failed",
      now: () => 100,
    });
    spawnBackgroundSubagent(supervisor, {
      agentId: "agent-background",
      childSessionId: "child-background",
    });
    supervisor.handleFact({
      ...commonFact("child-tool-failed", 1, "child-background"),
      sourceCommandId: undefined,
      kind: "tool.lifecycle",
      phase: "failed",
      toolCallId: "child-tool",
      toolName: "Bash",
      errorCode: "tool_timeout",
      errorMessage: "command timed out",
    });
    await supervisor.flushReportsForTest();

    expect(reportsByElement(reportTelemetryEvent, "agent_step")).toEqual([
      expect.objectContaining({
        eventExtraDetail: expect.objectContaining({
          step_type: "tool_call",
          tool_call_id: "tool_subagent_agent-background_child-tool",
          agent_id: "agent-background",
          agent_role: "background subagent",
          status: "fail",
          error_type: "TOOL_EXEC_ERROR",
          error_msg: "[redacted]",
        }),
      }),
    ]);
    expect(reportsByElement(reportTelemetryEvent, "message_completion")).toHaveLength(0);
    supervisor.dispose();
  });

  it("main completion 后 background child 仍可上报 tool step，但不修改 main completion", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    let now = 10;
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-background-after-main",
      now: () => now,
    });
    supervisor.acceptPromptSeed({
      sessionId: "parent-session",
      sourceCommandId: "parent-command",
      sendTime: now,
      extraDetail: { model_name: "main-provider/main-model", model_provider: "main-provider" },
    });
    supervisor.handleFact({
      ...commonFact("parent-started", 1, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "turn.started",
      executionKind: "agent",
    });
    spawnBackgroundSubagent(supervisor, {
      agentId: "agent-background",
      childSessionId: "child-background",
    });
    now = 20;
    supervisor.handleFact({
      ...commonFact("parent-terminal", 2, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "turn.terminal",
      status: "success",
    });
    now = 30;
    supervisor.handleFact({
      ...commonFact("child-tool-started", 1, "child-background"),
      sourceCommandId: undefined,
      kind: "tool.lifecycle",
      phase: "started",
      toolCallId: "child-tool",
      toolName: "Read",
    });
    now = 40;
    supervisor.handleFact({
      ...commonFact("child-tool-completed", 2, "child-background"),
      sourceCommandId: undefined,
      kind: "tool.lifecycle",
      phase: "completed",
      toolCallId: "child-tool",
      toolName: "Read",
    });
    await supervisor.flushReportsForTest();

    expect(
      reportTelemetryEvent.mock.calls
        .map(([payload]) => payload.elementName)
        .filter((name) => name === "agent_step" || name === "message_completion"),
    ).toEqual(["message_completion", "agent_step"]);
    expect(reportsByElement(reportTelemetryEvent, "message_completion")).toEqual([
      expect.objectContaining({
        messageId: "parent-command",
        eventExtraDetail: expect.objectContaining({ agent_step_cnt: "0" }),
      }),
    ]);
    expect(reportsByElement(reportTelemetryEvent, "agent_step")).toHaveLength(1);
    supervisor.dispose();
  });

  it("background mirror 与无 usage 的 child 汇总均不污染 main completion", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-background-mirror-filter",
      now: () => 100,
    });
    supervisor.acceptPromptSeed({
      sessionId: "parent-session",
      sourceCommandId: "parent-command",
      sendTime: 100,
      extraDetail: { model_name: "main-model", model_provider: "main-provider" },
    });
    supervisor.handleFact({
      ...commonFact("parent-started", 1, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "turn.started",
      executionKind: "agent",
    });
    spawnBackgroundSubagent(supervisor, {
      agentId: "agent-background",
      childSessionId: "child-background",
    });

    supervisor.handleFact({
      ...commonFact("mirror-permission-requested", 2, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "permission.lifecycle",
      phase: "requested",
      requestId: "permission-1",
      toolCallId: "tool_subagent_agent-background_child-tool",
      background: true,
      childSessionId: "child-background",
    });
    supervisor.handleFact({
      ...commonFact("mirror-tool-started", 3, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "tool.lifecycle",
      phase: "started",
      toolCallId: "tool_subagent_agent-background_child-tool",
      toolName: "Bash",
      agentId: "agent-background",
      childSessionId: "child-background",
      childToolCallId: "child-tool",
      parentToolCallId: "background-agent-tool",
      background: true,
    });
    supervisor.handleFact({
      ...commonFact("child-tool-started", 1, "child-background"),
      sourceCommandId: undefined,
      kind: "tool.lifecycle",
      phase: "started",
      toolCallId: "child-tool",
      toolName: "Bash",
    });
    supervisor.handleFact({
      ...commonFact("child-permission-requested", 2, "child-background"),
      sourceCommandId: undefined,
      kind: "permission.lifecycle",
      phase: "requested",
      requestId: "permission-1",
      toolCallId: "child-tool",
    });
    supervisor.handleFact({
      ...commonFact("child-permission-resolved", 3, "child-background"),
      sourceCommandId: undefined,
      kind: "permission.lifecycle",
      phase: "resolved",
      requestId: "permission-1",
      toolCallId: "child-tool",
      decision: "allow",
    });
    supervisor.handleFact({
      ...commonFact("child-tool-completed", 4, "child-background"),
      sourceCommandId: undefined,
      kind: "tool.lifecycle",
      phase: "completed",
      toolCallId: "child-tool",
      toolName: "Bash",
    });
    supervisor.handleFact({
      ...commonFact("parent-terminal", 5, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "turn.terminal",
      status: "success",
    });
    supervisor.handleFact({
      ...commonFact("child-terminal", 6, "child-background"),
      sourceCommandId: undefined,
      kind: "turn.terminal",
      status: "success",
    });
    await supervisor.flushReportsForTest();

    expect(
      reportsByElement(reportTelemetryEvent, "agent_step").map((step) => [
        step.eventExtraDetail.tool_name,
        step.eventExtraDetail.loop_index,
        step.eventExtraDetail.total_tokens,
      ]),
    ).toEqual([
      ["Bash", "1", "0"],
      ["Agent", "2", "0"],
    ]);
    expect(
      reportTelemetryEvent.mock.calls
        .map(([payload]) => payload.elementName)
        .filter((name) => name === "agent_step" || name === "message_completion"),
    ).toEqual(["agent_step", "message_completion", "agent_step"]);
    expect(reportsByElement(reportTelemetryEvent, "message_completion")).toEqual([
      expect.objectContaining({
        eventExtraDetail: expect.objectContaining({
          agent_step_cnt: "0",
          waiting_ms: "0",
        }),
      }),
    ]);
    supervisor.dispose();
  });

  it("队列立即发送不会在前一 Subagent terminal deferred 时串用 message 状态", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    let now = 100;
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-send-queued-now-after-subagent",
      now: () => now,
    });
    startForegroundSubagent(supervisor, now);
    startForegroundSubagentRequest(supervisor);
    reportForegroundSubagentUsage(supervisor);

    now = 180;
    supervisor.acceptPromptSeed({
      sessionId: "parent-session",
      sourceCommandId: "queued-command",
      sendTime: now,
      extraDetail: {
        model_name: "main-provider/main-model",
        model_provider: "main-provider",
      },
    });

    now = 200;
    terminateForegroundSubagentParent(supervisor);

    const queuedFact = (eventId: string, eventSeq: number) => ({
      ...commonFact(eventId, eventSeq, "parent-session"),
      sourceCommandId: "queued-command",
      turnId: "queued-turn",
    });
    now = 210;
    supervisor.handleFact({
      ...queuedFact("queued-turn-start", 7),
      kind: "turn.started",
      executionKind: "agent",
    });
    now = 220;
    supervisor.handleFact({
      ...queuedFact("queued-request-start", 8),
      kind: "model.request.status",
      requestId: "queued-request",
      status: "model_request_started",
      providerId: "main-provider",
      modelId: "main-model",
      providerHostname: "main.example.com",
      transport: "sse",
      querySource: "main_turn",
      attempt: 1,
      maxAttempts: 1,
    });
    now = 230;
    supervisor.handleFact({
      ...queuedFact("queued-text", 9),
      kind: "stream.chunk",
      channel: "text",
      chunkLength: 5,
      firstChunk: true,
    });
    now = 240;
    supervisor.handleFact({
      ...queuedFact("queued-usage", 10),
      kind: "usage.delta",
      requestId: "queued-request",
      providerId: "main-provider",
      modelId: "main-model",
      providerHostname: "main.example.com",
      inputTokens: 10,
      outputTokens: 2,
      totalTokens: 12,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    now = 250;
    supervisor.handleFact({
      ...queuedFact("queued-turn-terminal", 11),
      kind: "turn.terminal",
      status: "success",
      resultType: "complete",
    });
    await supervisor.flushReportsForTest();
    expect(reportsByElement(reportTelemetryEvent, "agent_step")).toHaveLength(0);
    expect(reportsByElement(reportTelemetryEvent, "message_completion")).toHaveLength(0);

    now = 300;
    supervisor.handleFact({
      ...commonFact("subagent-stopped-before-queued-replay", 12, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "subagent.lifecycle",
      phase: "stopped",
      agentId: "agent-1",
      childSessionId: "child-session",
      parentToolCallId: "agent-tool",
      background: false,
      status: "failed",
    });
    await supervisor.flushReportsForTest();

    expect(
      reportsByElement(reportTelemetryEvent, "send_btn").map((payload) => payload.messageId),
    ).toEqual(["parent-command", "queued-command"]);
    expect(
      reportsByElement(reportTelemetryEvent, "agent_step").map((payload) => ({
        messageId: payload.messageId,
        stepType: payload.eventExtraDetail.step_type,
        tokenScope: payload.eventExtraDetail.token_usage_scope,
        totalTokens: payload.eventExtraDetail.total_tokens,
      })),
    ).toEqual([
      {
        messageId: "parent-command",
        stepType: "tool_call",
        tokenScope: "subagent_requests",
        totalTokens: "8685",
      },
      {
        messageId: "queued-command",
        stepType: "generation",
        tokenScope: "model_request",
        totalTokens: "12",
      },
    ]);
    expect(
      reportsByElement(reportTelemetryEvent, "message_completion").map((payload) => ({
        messageId: payload.messageId,
        requestTime: payload.eventExtraDetail.request_time,
        duration: payload.eventExtraDetail.duration_ms,
        stepCount: payload.eventExtraDetail.agent_step_cnt,
      })),
    ).toEqual([
      {
        messageId: "parent-command",
        requestTime: "100",
        duration: "100",
        stepCount: "1",
      },
      {
        messageId: "queued-command",
        requestTime: "180",
        duration: "70",
        stepCount: "1",
      },
    ]);
    expect(
      reportTelemetryEvent.mock.calls
        .map(([payload]) => payload.elementName)
        .filter(
          (elementName) => elementName === "agent_step" || elementName === "message_completion",
        ),
    ).toEqual(["agent_step", "message_completion", "agent_step", "message_completion"]);
    supervisor.dispose();
  });

  it("Agent timeout 先于 SubagentStopped 时立即按已知 usage 收口且迟到 stopped 不重复", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    let now = 100;
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-timeout-first-foreground-subagent",
      now: () => now,
    });
    startForegroundSubagent(supervisor, now);
    startForegroundSubagentRequest(supervisor);
    reportForegroundSubagentUsage(supervisor);
    now = 200;
    supervisor.handleFact({
      ...commonFact("parent-turn-terminal", 4, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "turn.terminal",
      status: "interrupted",
      resultType: "cancelled",
    });
    await supervisor.flushReportsForTest();
    expect(reportsByElement(reportTelemetryEvent, "agent_step")).toHaveLength(0);
    expect(reportsByElement(reportTelemetryEvent, "message_completion")).toHaveLength(0);

    now = 210;
    supervisor.handleFact({
      ...commonFact("agent-tool-timeout", 5, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "tool.lifecycle",
      phase: "failed",
      toolCallId: "agent-tool",
      toolName: "Agent",
      errorCode: "tool_timeout",
      errorMessage: "Tool execution timed out after 600000ms",
    });
    await supervisor.flushReportsForTest();

    expect(reportsByElement(reportTelemetryEvent, "agent_step")).toEqual([
      expect.objectContaining({
        messageId: "parent-command",
        eventExtraDetail: expect.objectContaining({
          step_type: "tool_call",
          tool_name: "Agent",
          duration_ms: "110",
          status: "fail",
          model_name: "qwen-provider/qwen3.7-max",
          model_provider: "qwen-provider",
          provider_name: "provider.example.com",
          model_request_id: "child-request",
          model_request_count: "1",
          token_usage_scope: "subagent_requests",
          input_tokens: "8616",
          output_tokens: "69",
          cache_write_input_tokens: "5797",
          total_tokens: "8685",
        }),
      }),
    ]);
    expect(reportsByElement(reportTelemetryEvent, "message_completion")).toEqual([
      expect.objectContaining({
        messageId: "parent-command",
        eventExtraDetail: expect.objectContaining({
          request_time: "100",
          duration_ms: "100",
          agent_step_cnt: "1",
        }),
      }),
    ]);
    expect(
      reportTelemetryEvent.mock.calls
        .map(([payload]) => payload.elementName)
        .filter(
          (elementName) => elementName === "agent_step" || elementName === "message_completion",
        ),
    ).toEqual(["agent_step", "message_completion"]);

    supervisor.handleFact({
      ...commonFact("late-subagent-stopped", 6, "parent-session"),
      sourceCommandId: "parent-command",
      kind: "subagent.lifecycle",
      phase: "stopped",
      agentId: "agent-1",
      childSessionId: "child-session",
      parentToolCallId: "agent-tool",
      background: false,
      status: "failed",
    });
    expect(reportsByElement(reportTelemetryEvent, "agent_step")).toHaveLength(1);
    expect(reportsByElement(reportTelemetryEvent, "message_completion")).toHaveLength(1);
    supervisor.dispose();
  });

  it("background 仍上报 plan_request 和 seeded /report，但不产生 UI ARMS", async () => {
    const { platform, reportTelemetryEvent, reportArmsCustomEvent } = createPlatform();
    setUiPerfArmsReporter(platform);
    let now = 10;
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-background",
      now: () => now,
    });
    supervisor.acceptPromptSeed({
      sessionId: "session-1",
      sourceCommandId: "command-1",
      sendTime: 10,
      extraDetail: {
        ask_mode: "build",
        model_name: "model",
        model_provider: "provider",
      },
    });
    supervisor.handleFact({
      ...commonFact("background-start", 1),
      kind: "turn.started",
    });
    now = 20;
    supervisor.handleFact({
      ...commonFact("background-model", 2),
      kind: "model.request.status",
      requestId: "request-bg",
      status: "model_request_completed",
      providerId: "provider",
      modelId: "model",
      transport: "fetch",
      attempt: 1,
      maxAttempts: 1,
      durationMs: 5,
    });
    now = 30;
    supervisor.handleFact({
      ...commonFact("background-chunk", 3),
      kind: "stream.chunk",
      channel: "text",
      chunkLength: 1,
      firstChunk: true,
    });
    now = 40;
    supervisor.handleFact({
      ...commonFact("background-terminal", 4),
      kind: "turn.terminal",
      status: "success",
    });
    await supervisor.flushReportsForTest();

    expect(reportsByElement(reportTelemetryEvent, "send_btn")).toHaveLength(1);
    expect(reportsByElement(reportTelemetryEvent, "message_completion")).toHaveLength(1);
    expect(reportsByElement(reportTelemetryEvent, "agent_step")).toHaveLength(1);
    expect(reportArmsCustomEvent.mock.calls.map(([payload]) => payload.name)).toEqual([
      "plan_request",
    ]);
    supervisor.dispose();
  });

  it("automation TurnStarted 自动建 seed，不伪造 send_btn，且调度字段只进入 completion", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-automation",
      now: () => 1_700_000_000_500,
    });
    const sourceCommandId = "automation-1:1700000000000";
    const automationFact = {
      version: 1 as const,
      eventSeq: 1,
      occurredAt: 1_700_000_000_120,
      sessionId: "session-automation",
      sourceCommandId,
      turnId: "turn-automation",
    };
    supervisor.handleFact({
      ...automationFact,
      eventId: "automation-start",
      kind: "turn.started",
      automationId: "automation-1",
      taskTrigger: "schedule",
      scheduledAt: 1_700_000_000_000,
    });
    supervisor.handleFact({
      ...automationFact,
      eventId: "automation-chunk",
      eventSeq: 2,
      kind: "stream.chunk",
      channel: "text",
      chunkLength: 2,
      firstChunk: true,
    });
    supervisor.handleFact({
      ...automationFact,
      eventId: "automation-terminal",
      eventSeq: 3,
      kind: "turn.terminal",
      status: "success",
    });
    await supervisor.flushReportsForTest();

    expect(reportsByElement(reportTelemetryEvent, "send_btn")).toHaveLength(0);
    const step = reportsByElement(reportTelemetryEvent, "agent_step")[0]?.eventExtraDetail;
    expect(step).toMatchObject({
      message_source: "scheduled_task",
      task_trigger: "schedule",
      automation_id: "automation-1",
    });
    expect(step).not.toHaveProperty("scheduled_at");
    expect(step).not.toHaveProperty("schedule_lag_ms");
    expect(
      reportsByElement(reportTelemetryEvent, "message_completion")[0]?.eventExtraDetail,
    ).toMatchObject({
      message_source: "scheduled_task",
      task_trigger: "schedule",
      automation_id: "automation-1",
      scheduled_at: "1700000000000",
      schedule_lag_ms: "120",
    });
    supervisor.dispose();
  });

  it("manual run 不带调度字段；同会话后续 chat 轮不继承 automation_id、step 不携带 seed 模型维度", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-manual",
      now: () => 1_700_000_001_000,
    });
    const manualCommandId = "automation-1:manual:run-1";
    const manualFact = {
      version: 1 as const,
      occurredAt: 1_700_000_000_500,
      sessionId: "session-shared",
      sourceCommandId: manualCommandId,
      turnId: "turn-manual",
    };
    supervisor.handleFact({
      ...manualFact,
      eventId: "manual-start",
      eventSeq: 1,
      kind: "turn.started",
      automationId: "automation-1",
      taskTrigger: "manual",
    });
    supervisor.handleFact({
      ...manualFact,
      eventId: "manual-chunk",
      eventSeq: 2,
      kind: "stream.chunk",
      channel: "text",
      chunkLength: 2,
      firstChunk: true,
    });
    supervisor.handleFact({
      ...manualFact,
      eventId: "manual-terminal",
      eventSeq: 3,
      kind: "turn.terminal",
      status: "success",
    });

    const chatCommandId = "command-chat-1";
    supervisor.acceptPromptSeed({
      sessionId: "session-shared",
      sourceCommandId: chatCommandId,
      sendTime: 1_700_000_000_900,
      extraDetail: {
        message_source: "chat",
        task_trigger: "",
        model_name: "seed-model",
        plan_status: "coding_plan",
      },
    });
    const chatFact = {
      version: 1 as const,
      occurredAt: 1_700_000_000_950,
      sessionId: "session-shared",
      sourceCommandId: chatCommandId,
      turnId: "turn-chat",
    };
    supervisor.handleFact({
      ...chatFact,
      eventId: "chat-start",
      eventSeq: 4,
      kind: "turn.started",
    });
    supervisor.handleFact({
      ...chatFact,
      eventId: "chat-chunk",
      eventSeq: 5,
      kind: "stream.chunk",
      channel: "text",
      chunkLength: 2,
      firstChunk: true,
    });
    supervisor.handleFact({
      ...chatFact,
      eventId: "chat-terminal",
      eventSeq: 6,
      kind: "turn.terminal",
      status: "success",
    });
    await supervisor.flushReportsForTest();

    expect(reportsByElement(reportTelemetryEvent, "send_btn")).toHaveLength(1);
    const manualStep = reportsByElement(reportTelemetryEvent, "agent_step").find(
      (payload) => payload.messageId === manualCommandId,
    )?.eventExtraDetail;
    expect(manualStep).toMatchObject({
      message_source: "scheduled_task",
      task_trigger: "manual",
      automation_id: "automation-1",
    });
    expect(manualStep).not.toHaveProperty("scheduled_at");
    const manualCompletion = reportsByElement(reportTelemetryEvent, "message_completion").find(
      (payload) => payload.messageId === manualCommandId,
    )?.eventExtraDetail;
    expect(manualCompletion).toMatchObject({
      message_source: "scheduled_task",
      task_trigger: "manual",
      automation_id: "automation-1",
    });
    expect(manualCompletion).not.toHaveProperty("scheduled_at");
    expect(manualCompletion).not.toHaveProperty("schedule_lag_ms");

    const chatStep = reportsByElement(reportTelemetryEvent, "agent_step").find(
      (payload) => payload.messageId === chatCommandId,
    )?.eventExtraDetail;
    expect(chatStep).toMatchObject({ message_source: "chat", task_trigger: "" });
    expect(chatStep).not.toHaveProperty("automation_id");
    // seed 的模型/套餐维度只属于 send/completion，不进 step 契约。
    expect(chatStep).not.toHaveProperty("plan_status");
    const chatCompletion = reportsByElement(reportTelemetryEvent, "message_completion").find(
      (payload) => payload.messageId === chatCommandId,
    )?.eventExtraDetail;
    expect(chatCompletion).toMatchObject({ message_source: "chat", task_trigger: "" });
    expect(chatCompletion).not.toHaveProperty("automation_id");
    supervisor.dispose();
  });

  it("Off-Peak first/resume/retry talk 共用 task 归因，manual 不继承且每轮 message_id 独立", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-off-peak",
      now: () => 2_000,
    });
    let eventSeq = 0;
    const runOffPeakTurn = (params: {
      sessionId: string;
      sourceCommandId: string;
      turnId: string;
      offPeakRunType: "init" | "resume";
    }) => {
      const base = {
        version: 1 as const,
        occurredAt: 1_000 + eventSeq,
        sessionId: params.sessionId,
        sourceCommandId: params.sourceCommandId,
        turnId: params.turnId,
      };
      supervisor.handleFact({
        ...base,
        eventId: `${params.sourceCommandId}-start`,
        eventSeq: eventSeq++,
        kind: "turn.started",
        offPeakTaskId: "offpeak-stable-1",
        offPeakRunType: params.offPeakRunType,
      });
      supervisor.handleFact({
        ...base,
        eventId: `${params.sourceCommandId}-model`,
        eventSeq: eventSeq++,
        kind: "model.request.status",
        requestId: `${params.sourceCommandId}-request`,
        status: "model_request_started",
        providerId: "runtime-provider",
        modelId: "runtime-model",
        providerHostname: "api.example.com",
        transport: "fetch",
        attempt: 1,
        maxAttempts: 1,
      });
      supervisor.handleFact({
        ...base,
        eventId: `${params.sourceCommandId}-chunk`,
        eventSeq: eventSeq++,
        kind: "stream.chunk",
        channel: "text",
        chunkLength: 1,
        firstChunk: true,
      });
      const terminal = {
        ...base,
        eventId: `${params.sourceCommandId}-terminal`,
        eventSeq: eventSeq++,
        kind: "turn.terminal",
        status: "success",
      } satisfies ConversationTelemetryFact;
      supervisor.handleFact(terminal);
      supervisor.handleFact({
        ...terminal,
        eventId: `${params.sourceCommandId}-terminal-duplicate`,
        eventSeq: eventSeq++,
      });
    };

    runOffPeakTurn({
      sessionId: "talk-first",
      sourceCommandId: "message-first",
      turnId: "turn-first",
      offPeakRunType: "init",
    });
    runOffPeakTurn({
      sessionId: "talk-first",
      sourceCommandId: "message-resume",
      turnId: "turn-resume",
      offPeakRunType: "resume",
    });
    runOffPeakTurn({
      sessionId: "talk-retry",
      sourceCommandId: "message-retry",
      turnId: "turn-retry",
      offPeakRunType: "init",
    });

    supervisor.acceptPromptSeed({
      sessionId: "talk-first",
      sourceCommandId: "message-manual",
      sendTime: 1_500,
      extraDetail: {
        message_source: "chat",
        task_trigger: "",
        model_name: "manual-seed",
        model_provider: "manual-provider",
      },
    });
    supervisor.handleFact({
      ...commonFact("manual-start", eventSeq++, "talk-first"),
      sourceCommandId: "message-manual",
      turnId: "turn-manual",
      kind: "turn.started",
    });
    supervisor.handleFact({
      ...commonFact("manual-chunk", eventSeq++, "talk-first"),
      sourceCommandId: "message-manual",
      turnId: "turn-manual",
      kind: "stream.chunk",
      channel: "text",
      chunkLength: 1,
      firstChunk: true,
    });
    supervisor.handleFact({
      ...commonFact("manual-terminal", eventSeq++, "talk-first"),
      sourceCommandId: "message-manual",
      turnId: "turn-manual",
      kind: "turn.terminal",
      status: "success",
    });
    await supervisor.flushReportsForTest();

    expect(reportsByElement(reportTelemetryEvent, "send_btn")).toHaveLength(1);
    const completions = reportsByElement(reportTelemetryEvent, "message_completion");
    const steps = reportsByElement(reportTelemetryEvent, "agent_step");
    expect(completions).toHaveLength(4);
    for (const [messageId, offPeakRunType] of [
      ["message-first", "init"],
      ["message-resume", "resume"],
      ["message-retry", "init"],
    ] as const) {
      const detail = completions.find(
        (payload) => payload.messageId === messageId,
      )?.eventExtraDetail;
      expect(detail).toMatchObject({
        message_source: "off_peak_task",
        off_peak_task_id: "offpeak-stable-1",
        off_peak_run_type: offPeakRunType,
        model_name: "runtime-provider/runtime-model",
        model_provider: "runtime-provider",
      });
      expect(detail).not.toHaveProperty("automation_id");
      expect(detail).not.toHaveProperty("task_trigger");
      expect(
        steps.find((payload) => payload.messageId === messageId)?.eventExtraDetail,
      ).toMatchObject({
        message_source: "off_peak_task",
        off_peak_task_id: "offpeak-stable-1",
        off_peak_run_type: offPeakRunType,
      });
    }
    expect(completions.find((payload) => payload.messageId === "message-retry")?.talkId).toBe(
      "talk-retry",
    );
    const manual = completions.find(
      (payload) => payload.messageId === "message-manual",
    )?.eventExtraDetail;
    expect(manual).toMatchObject({ message_source: "chat" });
    expect(manual).not.toHaveProperty("off_peak_task_id");
    expect(manual).not.toHaveProperty("off_peak_run_type");
    const manualStep = steps.find(
      (payload) => payload.messageId === "message-manual",
    )?.eventExtraDetail;
    expect(manualStep).not.toHaveProperty("off_peak_task_id");
    expect(manualStep).not.toHaveProperty("off_peak_run_type");
    supervisor.dispose();
  });

  it("Off-Peak usage fact 去重后 completion 保留精确总量，step 保持占位口径", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-off-peak-usage",
      now: () => 2_000,
    });
    const base = {
      version: 1 as const,
      occurredAt: 1_000,
      sessionId: "talk-usage",
      sourceCommandId: "message-usage",
      turnId: "turn-usage",
    };
    supervisor.handleFact({
      ...base,
      eventId: "usage-start",
      eventSeq: 1,
      kind: "turn.started",
      offPeakTaskId: "offpeak-usage",
    });
    const usage = {
      ...base,
      eventId: "usage-once",
      eventSeq: 2,
      kind: "usage.delta",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 18,
      reasoningTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    } satisfies ConversationTelemetryFact;
    supervisor.handleFact(usage);
    supervisor.handleFact(usage);
    supervisor.handleFact({
      ...base,
      eventId: "usage-chunk",
      eventSeq: 3,
      kind: "stream.chunk",
      channel: "text",
      chunkLength: 1,
      firstChunk: true,
    });
    supervisor.handleFact({
      ...base,
      eventId: "usage-terminal",
      eventSeq: 4,
      kind: "turn.terminal",
      status: "success",
    });
    await supervisor.flushReportsForTest();

    expect(
      reportsByElement(reportTelemetryEvent, "message_completion")[0]?.eventExtraDetail,
    ).toMatchObject({
      input_tokens: "10",
      output_tokens: "5",
      reasoning_tokens: "3",
      total_tokens: "18",
      off_peak_task_id: "offpeak-usage",
    });
    expect(reportsByElement(reportTelemetryEvent, "agent_step")[0]?.eventExtraDetail).toMatchObject(
      {
        input_tokens: "0",
        output_tokens: "0",
        cached_tokens: "0",
        off_peak_task_id: "offpeak-usage",
      },
    );
    supervisor.dispose();
  });

  it("CronCreate 成功终态把新任务 automation_id 写入对应 agent_step", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-cron-create",
      now: () => 500,
    });
    supervisor.acceptPromptSeed({
      sessionId: "session-cron-create",
      sourceCommandId: "command-cron-create",
      sendTime: 100,
      extraDetail: { message_source: "chat", task_trigger: "" },
    });
    const base = {
      version: 1 as const,
      sessionId: "session-cron-create",
      sourceCommandId: "command-cron-create",
      turnId: "turn-cron-create",
    };
    supervisor.handleFact({
      ...base,
      eventId: "cron-turn-start",
      eventSeq: 1,
      occurredAt: 110,
      kind: "turn.started",
    });
    supervisor.handleFact({
      ...base,
      eventId: "cron-tool-start",
      eventSeq: 2,
      occurredAt: 120,
      kind: "tool.lifecycle",
      phase: "started",
      toolCallId: "tool-cron-create",
      toolName: "CronCreate",
    });
    supervisor.handleFact({
      ...base,
      eventId: "cron-tool-complete",
      eventSeq: 3,
      occurredAt: 150,
      kind: "tool.lifecycle",
      phase: "completed",
      toolCallId: "tool-cron-create",
      toolName: "CronCreate",
      automationId: "automation-created",
    });
    await supervisor.flushReportsForTest();

    expect(reportsByElement(reportTelemetryEvent, "agent_step")[0]?.eventExtraDetail).toMatchObject(
      {
        tool_name: "CronCreate",
        status: "success",
        automation_id: "automation-created",
      },
    );
    supervisor.dispose();
  });

  it("异步 reporter 仍严格按 send → step → completion 串行", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const releases: Array<() => void> = [];
    reportTelemetryEvent.mockImplementation(
      () => new Promise<void>((resolve) => releases.push(resolve)),
    );
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-report-order",
      now: () => 100,
    });
    supervisor.acceptPromptSeed({
      sessionId: "session-1",
      sourceCommandId: "command-1",
      sendTime: 10,
      extraDetail: { model_name: "model", model_provider: "provider" },
    });
    supervisor.handleFact({
      ...commonFact("order-start", 1),
      kind: "turn.started",
    });
    supervisor.handleFact({
      ...commonFact("order-model", 2),
      kind: "model.request.status",
      requestId: "request-1",
      status: "model_request_started",
      providerId: "provider",
      modelId: "model",
      transport: "fetch",
      attempt: 1,
      maxAttempts: 1,
    });
    supervisor.handleFact({
      ...commonFact("order-chunk", 3),
      kind: "stream.chunk",
      channel: "text",
      chunkLength: 1,
      firstChunk: true,
    });
    supervisor.handleFact({
      ...commonFact("order-terminal", 4),
      kind: "turn.terminal",
      status: "success",
    });

    const reportedNames = () =>
      reportTelemetryEvent.mock.calls.map(([payload]) => payload.elementName);
    expect(reportedNames()).toEqual(["send_btn"]);
    releases.shift()?.();
    await vi.waitFor(() => expect(reportedNames()).toEqual(["send_btn", "agent_step"]));
    releases.shift()?.();
    await vi.waitFor(() =>
      expect(reportedNames()).toEqual(["send_btn", "agent_step", "message_completion"]),
    );
    releases.shift()?.();
    await supervisor.flushReportsForTest();
    supervisor.dispose();
  });

  it("ACK 前 buffer 保留 turn.started，并按 terminal key exactly-once", async () => {
    const { platform, reportTelemetryEvent, reportArmsCustomEvent } = createPlatform();
    setUiPerfArmsReporter(platform);
    let now = 1_000;
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-buffer",
      now: () => now,
    });
    supervisor.handleFact({
      ...commonFact("buffer-start", 1),
      kind: "turn.started",
    });
    for (let index = 0; index < 140; index += 1) {
      now += 1;
      supervisor.handleFact({
        ...commonFact(`buffer-chunk-${index}`, index + 2),
        kind: "stream.chunk",
        channel: "text",
        chunkLength: 1,
        firstChunk: index === 0,
      });
    }
    supervisor.acceptPromptSeed({
      sessionId: "session-1",
      sourceCommandId: "command-1",
      sendTime: 900,
      extraDetail: {
        model_name: "model",
        model_provider: "provider",
      },
    });
    supervisor.attachForeground({}, "session-1");
    now = 2_000;
    const terminal = {
      ...commonFact("buffer-terminal-1", 200),
      kind: "turn.terminal",
      status: "interrupted",
      resultType: "cancelled",
      errorCode: "USER_INTERRUPT",
      errorMessage: "stopped",
    } satisfies ConversationTelemetryFact;
    supervisor.handleFact(terminal);
    supervisor.handleFact({ ...terminal, eventId: "buffer-terminal-2", eventSeq: 201 });
    await supervisor.flushReportsForTest();

    const completion = reportsByElement(reportTelemetryEvent, "message_completion");
    expect(completion).toHaveLength(1);
    expect(completion[0]).toMatchObject({
      talkId: "session-1",
      messageId: "command-1",
      eventExtraDetail: {
        status: "user_interrupt",
        error_type: "USER_INTERRUPT",
        error_msg: "[redacted]",
        time_to_first_token: "101",
      },
    });
    // buffered chunk 到达时仍在 background；terminal 前切回也不能补造 UI TTFT。
    expect(armsByName(reportArmsCustomEvent, "perf_ui_first_token")).toHaveLength(0);
    expect(armsByName(reportArmsCustomEvent, "plan_ttft")).toHaveLength(0);
    expect(reportsByElement(reportTelemetryEvent, "agent_step")[0]).toMatchObject({
      eventExtraDetail: { status: "success" },
    });
    supervisor.dispose();
  });

  it("同 session direct 与 queued seed 依次 promotion，terminal 不清后续队列", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    let now = 100;
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-queued",
      now: () => now,
    });
    for (const sourceCommandId of ["command-direct", "command-queued"]) {
      supervisor.acceptPromptSeed({
        sessionId: "session-queued",
        sourceCommandId,
        sendTime: now,
        extraDetail: { model_name: "model", model_provider: "provider" },
      });
      now += 10;
    }

    supervisor.handleFact({
      ...commonFact("direct-start", 1, "session-queued"),
      sourceCommandId: "command-direct",
      turnId: "turn-direct",
      kind: "turn.started",
    });
    now = 200;
    supervisor.handleFact({
      ...commonFact("direct-terminal", 2, "session-queued"),
      sourceCommandId: "command-direct",
      turnId: "turn-direct",
      kind: "turn.terminal",
      status: "success",
    });
    now = 300;
    supervisor.handleFact({
      ...commonFact("queued-start", 3, "session-queued"),
      sourceCommandId: "command-queued",
      turnId: "turn-queued",
      kind: "turn.started",
    });
    now = 400;
    supervisor.handleFact({
      ...commonFact("queued-terminal", 4, "session-queued"),
      sourceCommandId: "command-queued",
      turnId: "turn-queued",
      kind: "turn.terminal",
      status: "success",
    });
    await supervisor.flushReportsForTest();

    expect(reportsByElement(reportTelemetryEvent, "send_btn")).toHaveLength(2);
    expect(
      reportsByElement(reportTelemetryEvent, "message_completion").map(
        (payload) => payload.messageId,
      ),
    ).toEqual(["command-direct", "command-queued"]);
    supervisor.dispose();
  });

  it("无本地 seed 的 command fact 使用 200 组 LRU 上限", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-pending-lru",
      now: () => 1_000,
    });
    for (let index = 0; index < 200; index += 1) {
      supervisor.handleFact({
        ...commonFact(`pending-${index}`, index, `session-${index}`),
        sourceCommandId: `command-${index}`,
        turnId: `turn-${index}`,
        kind: "turn.started",
      });
    }
    // 再命中 command-0，把它移到 LRU 尾部；新增 command-200 应淘汰 command-1。
    supervisor.handleFact({
      ...commonFact("pending-0-touch", 201, "session-0"),
      sourceCommandId: "command-0",
      turnId: "turn-0",
      kind: "stream.chunk",
      channel: "text",
      chunkLength: 1,
      firstChunk: true,
    });
    supervisor.handleFact({
      ...commonFact("pending-200", 202, "session-200"),
      sourceCommandId: "command-200",
      turnId: "turn-200",
      kind: "turn.started",
    });
    expect(supervisor.getPendingCommandCountForTest()).toBe(200);

    supervisor.acceptPromptSeed({
      sessionId: "session-1",
      sourceCommandId: "command-1",
      sendTime: 900,
      extraDetail: {},
    });
    supervisor.handleFact({
      ...commonFact("evicted-terminal", 203, "session-1"),
      sourceCommandId: "command-1",
      turnId: "turn-1",
      kind: "turn.terminal",
      status: "success",
    });
    supervisor.acceptPromptSeed({
      sessionId: "session-0",
      sourceCommandId: "command-0",
      sendTime: 900,
      extraDetail: {},
    });
    supervisor.handleFact({
      ...commonFact("retained-terminal", 204, "session-0"),
      sourceCommandId: "command-0",
      turnId: "turn-0",
      kind: "turn.terminal",
      status: "success",
    });
    await supervisor.flushReportsForTest();
    expect(
      reportsByElement(reportTelemetryEvent, "message_completion").map(
        (payload) => payload.messageId,
      ),
    ).toEqual(["command-0"]);
    supervisor.dispose();
  });

  it("foreground raw 负 TTFT 仅由 ui_perf 钳 0，plan_ttft 丢弃", () => {
    const { platform, reportArmsCustomEvent } = createPlatform();
    setUiPerfArmsReporter(platform);
    let now = 200;
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-clock-rollback",
      now: () => now,
    });
    supervisor.attachForeground({}, "session-1");
    supervisor.acceptPromptSeed({
      sessionId: "session-1",
      sourceCommandId: "command-1",
      sendTime: 200,
      extraDetail: { model_name: "model", model_provider: "provider" },
    });
    supervisor.handleFact({
      ...commonFact("rollback-start", 1),
      kind: "turn.started",
    });
    now = 100;
    supervisor.handleFact({
      ...commonFact("rollback-token", 2),
      kind: "stream.chunk",
      channel: "text",
      chunkLength: 1,
      firstChunk: true,
    });
    now = 300;
    supervisor.handleFact({
      ...commonFact("rollback-terminal", 3),
      kind: "turn.terminal",
      status: "success",
    });
    expect(armsByName(reportArmsCustomEvent, "perf_ui_first_token")[0]?.value).toBe(0);
    expect(armsByName(reportArmsCustomEvent, "plan_ttft")).toHaveLength(0);
    supervisor.dispose();
  });

  it("plan_request 五态无需 seed，compaction 按到达时 foreground 与 operation 去重", () => {
    const { platform, reportTelemetryEvent, reportArmsCustomEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-independent",
      now: () => 2_000,
    });
    const statuses = [
      "model_request_started",
      "model_request_completed",
      "model_request_failed",
      "model_retry_scheduled",
      "model_stream_stalled",
    ] as const;
    statuses.forEach((status, index) => {
      supervisor.handleFact({
        ...commonFact(`plan-${index}`, index, "session-plan"),
        sourceCommandId: undefined,
        turnId: undefined,
        kind: "model.request.status",
        requestId: "request-plan",
        status,
        providerId: "provider",
        modelId: "model",
        transport: "fetch",
        attempt: 1,
        maxAttempts: 3,
      });
    });
    expect(
      armsByName(reportArmsCustomEvent, "plan_request").map(
        (payload) => payload.properties?.request_status,
      ),
    ).toEqual(["started", "completed", "failed", "retry_scheduled", "stream_stalled"]);

    const compaction = {
      ...commonFact("compact-1", 20, "session-compact"),
      sourceCommandId: undefined,
      turnId: undefined,
      kind: "compaction.terminal",
      operationId: "operation-1",
      summaryMessageId: "summary-1",
      status: "completed",
      trigger: "manual",
      reason: "manual request",
      attempt: 2,
      startedAt: 1_000,
      endedAt: 1_500,
      preCompactTokenCount: 100,
      postCompactTokenCount: 40,
      truePostCompactTokenCount: 35,
      modelName: "model",
      modelProvider: "provider",
    } satisfies ConversationTelemetryFact;
    supervisor.handleFact(compaction);
    expect(reportsByElement(reportTelemetryEvent, "context_compaction")).toHaveLength(0);
    supervisor.attachForeground({}, "session-compact");
    supervisor.handleFact({ ...compaction, eventId: "compact-2", eventSeq: 21 });
    supervisor.handleFact({ ...compaction, eventId: "compact-3", eventSeq: 22 });
    expect(reportsByElement(reportTelemetryEvent, "context_compaction")).toHaveLength(0);
    const foregroundCompaction = {
      ...compaction,
      eventId: "compact-4",
      eventSeq: 23,
      operationId: "operation-2",
      summaryMessageId: "summary-2",
    } satisfies ConversationTelemetryFact;
    supervisor.handleFact(foregroundCompaction);
    supervisor.handleFact({
      ...foregroundCompaction,
      eventId: "compact-5",
      eventSeq: 24,
      status: "failed",
      reason: "late contradictory terminal",
    });
    expect(reportsByElement(reportTelemetryEvent, "context_compaction")).toEqual([
      expect.objectContaining({
        elementName: "context_compaction",
        eventRegion: "app",
        eventType: "agent_trace",
        talkId: "session-compact",
        messageId: "summary-2",
        eventExtraDetail: {
          status: "completed",
          trigger: "manual",
          reason: "manual request",
          attempt: "2",
          duration_ms: "500",
          pre_compact_tokens: "100",
          post_compact_tokens: "40",
          true_post_compact_tokens: "35",
          compact_ratio: "0.4000",
          model_name: "provider/model",
          model_provider: "provider",
        },
      }),
    ]);
    supervisor.dispose();
  });

  it("compaction 不用 compactReason 回填旧 reason，glm 模型保持原值", () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-compact-legacy-fields",
      now: () => 2_000,
    });
    supervisor.attachForeground({}, "session-compact");
    supervisor.handleFact({
      ...commonFact("compact-legacy", 1, "session-compact"),
      sourceCommandId: undefined,
      turnId: undefined,
      kind: "compaction.terminal",
      operationId: "operation-legacy",
      status: "completed",
      trigger: "auto",
      compactReason: "context_limit",
      modelName: "glm-model",
      modelProvider: "glm",
    });
    expect(reportsByElement(reportTelemetryEvent, "context_compaction")[0]).toMatchObject({
      eventExtraDetail: {
        reason: "",
        model_name: "glm-model",
        model_provider: "glm",
      },
    });
    supervisor.dispose();
  });

  it("tool-first 与无 token terminal 保留旧 first-token ARMS 边界", () => {
    const { platform, reportArmsCustomEvent } = createPlatform();
    setUiPerfArmsReporter(platform);
    let now = 100;
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-tool-first",
      now: () => now,
    });
    supervisor.attachForeground({}, "session-1");
    supervisor.acceptPromptSeed({
      sessionId: "session-1",
      sourceCommandId: "command-1",
      sendTime: 100,
      extraDetail: { model_name: "model", model_provider: "provider" },
    });
    supervisor.handleFact({ ...commonFact("tool-first-start", 1), kind: "turn.started" });
    now = 140;
    supervisor.handleFact({
      ...commonFact("tool-first-tool", 2),
      kind: "tool.lifecycle",
      phase: "scheduled",
      toolCallId: "tool-1",
      toolName: "Read",
    });
    now = 200;
    supervisor.handleFact({
      ...commonFact("tool-first-terminal", 3),
      kind: "turn.terminal",
      status: "success",
    });
    expect(armsByName(reportArmsCustomEvent, "perf_ui_first_token")[0]?.value).toBe(40);
    expect(armsByName(reportArmsCustomEvent, "plan_ttft")[0]?.value).toBe(40);

    supervisor.acceptPromptSeed({
      sessionId: "session-2",
      sourceCommandId: "command-2",
      sendTime: 200,
      extraDetail: { model_name: "model", model_provider: "provider" },
    });
    supervisor.attachForeground({}, "session-2");
    supervisor.handleFact({
      ...commonFact("no-token-start", 4, "session-2"),
      sourceCommandId: "command-2",
      turnId: "turn-2",
      kind: "turn.started",
    });
    now = 260;
    supervisor.handleFact({
      ...commonFact("no-token-terminal", 5, "session-2"),
      sourceCommandId: "command-2",
      turnId: "turn-2",
      kind: "turn.terminal",
      status: "success",
    });
    expect(
      armsByName(reportArmsCustomEvent, "perf_ui_first_token").map((item) => item.value),
    ).toEqual([40, 0]);
    expect(armsByName(reportArmsCustomEvent, "plan_ttft")).toHaveLength(1);
    supervisor.dispose();
  });

  it("parented child text 不进入 generation，但保留旧 TTFT 与 stall", async () => {
    const { platform, reportTelemetryEvent, reportArmsCustomEvent } = createPlatform();
    setUiPerfArmsReporter(platform);
    let now = 100;
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-parented-child",
      now: () => now,
    });
    supervisor.attachForeground({}, "session-1");
    supervisor.acceptPromptSeed({
      sessionId: "session-1",
      sourceCommandId: "command-1",
      sendTime: 100,
      extraDetail: { model_name: "model", model_provider: "provider" },
    });
    supervisor.handleFact({ ...commonFact("child-start", 1), kind: "turn.started" });
    now = 150;
    supervisor.handleFact({
      ...commonFact("child-chunk-1", 2),
      kind: "stream.chunk",
      channel: "text",
      chunkLength: 10,
      firstChunk: true,
      parentToolCallId: "parent-agent-tool",
    });
    now = 3_251;
    supervisor.handleFact({
      ...commonFact("child-chunk-2", 3),
      kind: "stream.chunk",
      channel: "text",
      chunkLength: 10,
      firstChunk: false,
      parentToolCallId: "parent-agent-tool",
    });
    now = 3_300;
    supervisor.handleFact({
      ...commonFact("child-terminal", 4),
      kind: "turn.terminal",
      status: "success",
    });
    await supervisor.flushReportsForTest();
    expect(reportsByElement(reportTelemetryEvent, "agent_step")).toHaveLength(0);
    expect(armsByName(reportArmsCustomEvent, "perf_ui_stream_stall")[0]?.value).toBe(3_101);
    expect(armsByName(reportArmsCustomEvent, "perf_ui_first_token")[0]?.value).toBe(50);
    expect(armsByName(reportArmsCustomEvent, "plan_ttft")[0]?.value).toBe(50);
    supervisor.dispose();
  });

  it("parented child thought 保留旧 reasoning 与 TTFT 行为", async () => {
    const { platform, reportTelemetryEvent, reportArmsCustomEvent } = createPlatform();
    setUiPerfArmsReporter(platform);
    let now = 100;
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-parented-thought",
      now: () => now,
    });
    supervisor.attachForeground({}, "session-1");
    supervisor.acceptPromptSeed({
      sessionId: "session-1",
      sourceCommandId: "command-1",
      sendTime: 100,
      extraDetail: { model_name: "model", model_provider: "provider" },
    });
    supervisor.handleFact({ ...commonFact("thought-start", 1), kind: "turn.started" });
    now = 150;
    supervisor.handleFact({
      ...commonFact("parented-thought", 2),
      kind: "stream.chunk",
      channel: "thought",
      chunkLength: 10,
      firstChunk: true,
      parentToolCallId: "parent-agent-tool",
    });
    now = 200;
    supervisor.handleFact({
      ...commonFact("thought-terminal", 3),
      kind: "turn.terminal",
      status: "success",
    });
    await supervisor.flushReportsForTest();
    expect(reportsByElement(reportTelemetryEvent, "agent_step")).toHaveLength(1);
    expect(armsByName(reportArmsCustomEvent, "perf_ui_first_token")[0]?.value).toBe(50);
    expect(armsByName(reportArmsCustomEvent, "plan_ttft")[0]?.value).toBe(50);
    supervisor.dispose();
  });

  it("chat_error_banner 复用既有 builder 上报真实可见错误", () => {
    const { platform, reportArmsCustomEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-error",
    });
    supervisor.reportVisibleChatError({
      errorKey: "error-1",
      displayMessage: "Request failed",
      error: {
        message: "raw request failed",
        code: "MODEL_ERROR",
        traceId: "trace-1",
        taskId: "session-1",
        detail: "detail",
      },
    });
    expect(armsByName(reportArmsCustomEvent, "chat_error_banner")).toEqual([
      {
        name: "chat_error_banner",
        group: "ui_error",
        value: 1,
        properties: expect.objectContaining({
          surface: "chat_input_error_banner",
          error_code: "MODEL_ERROR",
          error_message: "Request failed",
          trace_id: "trace-1",
          task_id: "session-1",
          has_detail: true,
          provider_business_action: "",
          provider_business_code: "",
        }),
      },
    ]);
    supervisor.dispose();
  });

  it("chat_error_banner 保留普通业务恢复维度并隐藏 3007 内部动作", () => {
    const { platform, reportArmsCustomEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-provider-errors",
    });
    supervisor.reportVisibleChatError({
      displayMessage: "Please login",
      error: { message: "login required", code: "1006" },
    });
    supervisor.reportVisibleChatError({
      displayMessage: "Security check rejected",
      error: { message: "security check rejected", code: "3007" },
    });
    expect(
      armsByName(reportArmsCustomEvent, "chat_error_banner").map((payload) => payload.properties),
    ).toEqual([
      expect.objectContaining({
        provider_business_action: "login",
        provider_business_code: "1006",
      }),
      expect.objectContaining({
        provider_business_action: "",
        provider_business_code: "",
      }),
    ]);
    supervisor.dispose();
  });
});

describe("workflow subagent：动态工作流子代理的 token 埋点（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Token telemetry for subagents」）", () => {
  const CHILD = "sess_dwf-run-1-worker_1";

  function spawnWorkflowActor(
    supervisor: ConversationTelemetrySupervisor,
    input: { sourceCommandId?: string; childSessionId?: string; agentId?: string } = {},
  ) {
    supervisor.handleFact({
      ...commonFact("wf-actor-spawned", 1, "parent-session"),
      ...(input.sourceCommandId === undefined
        ? { sourceCommandId: "launch-input-1" }
        : { sourceCommandId: input.sourceCommandId }),
      kind: "workflow.lifecycle",
      phase: "actor-spawned",
      runId: "dwfrun-1",
      toolCallId: "tool-wf",
      agentId: input.agentId ?? "worker@1",
      childSessionId: input.childSessionId ?? CHILD,
    });
  }

  function childUsage(
    supervisor: ConversationTelemetrySupervisor,
    eventId: string,
    requestId: string,
  ) {
    supervisor.handleFact({
      ...commonFact(`${eventId}-request`, 1, CHILD),
      turnId: "child-turn-1",
      kind: "model.request.status",
      requestId,
      status: "model_request_started",
      providerId: "glm-provider",
      modelId: "glm-5.3",
      providerHostname: "glm.example.com",
      transport: "sse",
      querySource: "workflow_child",
      attempt: 1,
      maxAttempts: 1,
    });
    supervisor.handleFact({
      ...commonFact(eventId, 2, CHILD),
      turnId: "child-turn-1",
      kind: "usage.delta",
      requestId,
      providerId: "glm-provider",
      modelId: "glm-5.3",
      providerHostname: "glm.example.com",
      inputTokens: 1000,
      outputTokens: 50,
      totalTokens: 1050,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  }

  function settleRun(
    supervisor: ConversationTelemetrySupervisor,
    status: "completed" | "errored" | "stopped",
    errorMessage?: string,
  ) {
    supervisor.handleFact({
      ...commonFact("wf-run-settled", 9, "parent-session"),
      sourceCommandId: "launch-input-1",
      kind: "workflow.lifecycle",
      phase: "run-settled",
      runId: "dwfrun-1",
      toolCallId: "tool-wf",
      status,
      ...(errorMessage === undefined ? {} : { errorMessage }),
    });
  }

  it("工具 step 零 token 带角色与 run 字段；usage 按 requestId 去重；子会话 turn.terminal 不结算；run-settled 一条汇总 step", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-workflow-actor",
    });
    spawnWorkflowActor(supervisor);
    childUsage(supervisor, "wf-usage-1", "req-1");
    // 同一 requestId 重放（重连 / 重放）不重复计。
    childUsage(supervisor, "wf-usage-1-dup", "req-1");
    supervisor.handleFact({
      ...commonFact("wf-tool-start", 3, CHILD),
      turnId: "child-turn-1",
      kind: "tool.lifecycle",
      phase: "started",
      toolCallId: "bash-1",
      toolName: "Bash",
    });
    supervisor.handleFact({
      ...commonFact("wf-tool-done", 4, CHILD),
      turnId: "child-turn-1",
      kind: "tool.lifecycle",
      phase: "completed",
      toolCallId: "bash-1",
      toolName: "Bash",
      durationMs: 12,
    });
    // 一次 ask 结束：子会话自己的 turn.terminal 不是子代理终态。
    supervisor.handleFact({
      ...commonFact("wf-child-terminal", 5, CHILD),
      turnId: "child-turn-1",
      kind: "turn.terminal",
      status: "success",
    });
    await supervisor.flushReportsForTest();

    const beforeSettle = reportsByElement(reportTelemetryEvent, "agent_step");
    expect(beforeSettle).toHaveLength(1);
    expect(beforeSettle[0]).toEqual(
      expect.objectContaining({
        talkId: "parent-session",
        messageId: "launch-input-1",
        eventExtraDetail: expect.objectContaining({
          step_type: "tool_call",
          tool_name: "Bash",
          tool_call_id: "tool_workflow_worker@1_bash-1",
          agent_id: "worker@1",
          agent_role: "workflow subagent",
          workflow_run_id: "dwfrun-1",
          child_session_id: CHILD,
          workflow_tool_call_id: "tool-wf",
          total_tokens: "0",
          model_name: "glm-provider/glm-5.3",
        }),
      }),
    );

    // 第二次 ask 的用量继续累计到同一个子代理。
    supervisor.handleFact({
      ...commonFact("wf-usage-2", 6, CHILD),
      turnId: "child-turn-2",
      kind: "usage.delta",
      requestId: "req-2",
      providerId: "glm-provider",
      modelId: "glm-5.3",
      inputTokens: 200,
      outputTokens: 10,
      totalTokens: 210,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    settleRun(supervisor, "completed");
    await supervisor.flushReportsForTest();

    const steps = reportsByElement(reportTelemetryEvent, "agent_step");
    expect(steps).toHaveLength(2);
    expect(steps[1]).toEqual(
      expect.objectContaining({
        talkId: "parent-session",
        messageId: "launch-input-1",
        eventExtraDetail: expect.objectContaining({
          step_type: "tool_call",
          tool_name: "Agent",
          tool_call_id: "tool_workflow_worker@1_dwfrun-1",
          agent_id: "worker@1",
          agent_role: "workflow subagent",
          workflow_run_id: "dwfrun-1",
          status: "success",
          token_usage_scope: "subagent_requests",
          model_request_count: "2",
          input_tokens: "1200",
          output_tokens: "60",
          total_tokens: "1260",
          model_name: "glm-provider/glm-5.3",
          provider_name: "glm.example.com",
        }),
      }),
    );
    expect(reportsByElement(reportTelemetryEvent, "message_completion")).toHaveLength(0);
    supervisor.dispose();
  });

  it("停下的 run：每个子代理一条 fail 汇总 step，错误原文保留，无 usage 时 token 为 0", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-workflow-stopped",
    });
    spawnWorkflowActor(supervisor);
    settleRun(supervisor, "stopped", "Workflow run stopped (user)");
    await supervisor.flushReportsForTest();

    expect(reportsByElement(reportTelemetryEvent, "agent_step")).toEqual([
      expect.objectContaining({
        messageId: "launch-input-1",
        eventExtraDetail: expect.objectContaining({
          tool_name: "Agent",
          agent_role: "workflow subagent",
          status: "fail",
          error_msg: "[redacted]",
          model_request_count: "0",
          total_tokens: "0",
        }),
      }),
    ]);
    // 结算后迟到的用量不再改变任何上报（也不再有新的 step）。
    childUsage(supervisor, "wf-late", "req-late");
    await supervisor.flushReportsForTest();
    expect(reportsByElement(reportTelemetryEvent, "agent_step")).toHaveLength(1);
    supervisor.dispose();
  });

  it("没有锚点（sourceCommandId 缺席）不登记也不上报", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-workflow-no-anchor",
    });
    supervisor.handleFact({
      version: 1,
      eventId: "wf-no-anchor",
      eventSeq: 1,
      occurredAt: 1,
      sessionId: "parent-session",
      kind: "workflow.lifecycle",
      phase: "actor-spawned",
      runId: "dwfrun-1",
      agentId: "worker@1",
      childSessionId: CHILD,
    });
    childUsage(supervisor, "wf-usage", "req-1");
    settleRun(supervisor, "completed");
    await supervisor.flushReportsForTest();
    expect(reportsByElement(reportTelemetryEvent, "agent_step")).toHaveLength(0);
    supervisor.dispose();
  });

  it("workflow 通知唤起的 main turn 计为 main_plus_wf，message_source 为 background_workflow", async () => {
    const { platform, reportTelemetryEvent } = createPlatform();
    const supervisor = new ConversationTelemetrySupervisor({
      platform,
      workspaceScopeKey: "scope-workflow-composition",
    });
    supervisor.handleFact({
      ...commonFact("wf-wake-start", 1, "session-1"),
      sourceCommandId: "wf-wake-command",
      kind: "turn.started",
      inputSource: "background_task",
      backgroundSource: "workflow",
    });
    supervisor.handleFact({
      ...commonFact("wf-wake-terminal", 2, "session-1"),
      sourceCommandId: "wf-wake-command",
      kind: "turn.terminal",
      status: "success",
      workflowResultConsumed: true,
      backgroundSubagentResultConsumed: true,
    });
    await supervisor.flushReportsForTest();

    expect(completionAgentCompositions(reportTelemetryEvent)).toEqual(["main_plus_bg_wf"]);
    expect(
      reportsByElement(reportTelemetryEvent, "message_completion")[0]?.eventExtraDetail,
    ).toMatchObject({ message_source: "background_workflow" });
    supervisor.dispose();
  });
});
