import { describe, expect, it } from "vitest";
import {
  conversationTelemetryFactSchema,
  commandAckSchema,
  parseCommandEnvelope,
} from "../src/zcode-protocol-v4/index.js";

const base = {
  version: 1 as const,
  eventId: "event-1",
  eventSeq: 1,
  occurredAt: 1_700_000_000_000,
  sessionId: "session-1",
};

describe("ConversationTelemetryFact schema", () => {
  it("Memory 元数据保持 boolean 且兼容旧 ACK/fact", () => {
    const ack = { commandId: "command-1", status: "accepted", revisionAtDecision: 0 };
    const fact = { ...base, kind: "turn.started" };
    for (const [schema, value] of [
      [commandAckSchema, ack],
      [conversationTelemetryFactSchema, fact],
    ] as const) {
      expect(schema.parse(value)).not.toHaveProperty("memoryEnabled");
      for (const memoryEnabled of [true, false]) {
        expect(schema.parse({ ...value, memoryEnabled })).toMatchObject({ memoryEnabled });
      }
      expect(schema.safeParse({ ...value, memoryEnabled: "false" }).success).toBe(false);
    }
  });

  it("只允许定时任务 admission 与 CronCreate 关联 ID，不接收任务正文", () => {
    const started = conversationTelemetryFactSchema.parse({
      ...base,
      kind: "turn.started",
      sourceCommandId: "automation-1:1700000000000",
      automationId: "automation-1",
      taskTrigger: "schedule",
      scheduledAt: 1_700_000_000_000,
    });
    expect(started).toMatchObject({ automationId: "automation-1", taskTrigger: "schedule" });
    expect(() =>
      conversationTelemetryFactSchema.parse({ ...started, prompt: "private" }),
    ).toThrow();

    const tool = conversationTelemetryFactSchema.parse({
      ...base,
      kind: "tool.lifecycle",
      phase: "completed",
      toolCallId: "cron-create-1",
      toolName: "CronCreate",
      automationId: "automation-1",
    });
    expect(tool).toMatchObject({ automationId: "automation-1" });
    expect(() => conversationTelemetryFactSchema.parse({ ...tool, output: "private" })).toThrow();
  });

  it("Off-Peak admission 只接收稳定 task ID，且与 automation 互斥", () => {
    const started = conversationTelemetryFactSchema.parse({
      ...base,
      kind: "turn.started",
      sourceCommandId: "message-run-1",
      offPeakTaskId: "offpeak-1",
      offPeakRunType: "init",
    });
    expect(started).toMatchObject({ offPeakTaskId: "offpeak-1", offPeakRunType: "init" });
    expect(() =>
      conversationTelemetryFactSchema.parse({
        ...base,
        kind: "turn.started",
        sourceCommandId: "message-run-2",
        offPeakRunType: "resume",
      }),
    ).toThrow();
    expect(() =>
      conversationTelemetryFactSchema.parse({
        ...started,
        automationId: "automation-1",
      }),
    ).toThrow();
    for (const forbidden of [
      { prompt: "private prompt" },
      { workspacePath: "/private/workspace" },
      { ticketId: "private-ticket" },
      { responseBody: "private response" },
    ]) {
      expect(() => conversationTelemetryFactSchema.parse({ ...started, ...forbidden })).toThrow();
    }
  });

  it("只接受 provider hostname，不允许 URL、header、prompt 或工具正文穿透", () => {
    const valid = conversationTelemetryFactSchema.parse({
      ...base,
      kind: "model.request.status",
      requestId: "request-1",
      status: "model_request_started",
      providerId: "zcode-plan",
      modelId: "model-1",
      providerHostname: "example.com",
      transport: "sse",
      attempt: 1,
      maxAttempts: 3,
    });
    expect(valid).toMatchObject({ providerHostname: "example.com" });

    for (const forbidden of [
      { baseURL: "https://example.com/private?q=token" },
      { requestHeaders: { authorization: "secret" } },
      { requestHeaderCount: 3 },
      { responseHeaderCount: 4 },
      { prompt: "private prompt" },
      { responseBody: "private response" },
      { message: "upstream response body" },
      { finishReason: "provider-private-reason" },
      { providerHostname: "https://example.com/private?q=token" },
      { providerHostname: "example.com:443" },
      { providerHostname: "user@example.com" },
      { providerHostname: "example.com/path" },
      { providerHostname: "example.com query" },
    ]) {
      expect(() => conversationTelemetryFactSchema.parse({ ...valid, ...forbidden })).toThrow();
    }
    expect(() =>
      conversationTelemetryFactSchema.parse({
        ...valid,
        providerHostname: "[2001:db8::1]",
      }),
    ).not.toThrow();
  });

  it("tool fact 只接收 allowlist perf，拒绝 input/output", () => {
    const valid = conversationTelemetryFactSchema.parse({
      ...base,
      kind: "tool.lifecycle",
      phase: "completed",
      toolCallId: "tool-1",
      toolName: "Read",
      performance: {
        totalMs: 20,
        fileCount: 1,
        workspaceKind: "local",
        commandName: "git",
        commandCount: 1,
        commandStatus: "completed",
      },
    });
    expect(valid.kind).toBe("tool.lifecycle");
    expect(() =>
      conversationTelemetryFactSchema.parse({
        ...valid,
        input: { path: "/secret" },
      }),
    ).toThrow();
    expect(() =>
      conversationTelemetryFactSchema.parse({
        ...valid,
        performance: { totalMs: 20, rawOutput: "secret" },
      }),
    ).toThrow();
  });

  it("subagent fact 只接收父子会话关联，不允许正文", () => {
    const valid = conversationTelemetryFactSchema.parse({
      ...base,
      kind: "subagent.lifecycle",
      phase: "spawned",
      agentId: "agent-1",
      agentType: "explore",
      childSessionId: "child-session-1",
      parentToolCallId: "parent-tool-1",
      background: false,
      status: "running",
    });
    expect(valid).toMatchObject({
      agentId: "agent-1",
      childSessionId: "child-session-1",
      background: false,
    });
    expect(() =>
      conversationTelemetryFactSchema.parse({
        ...valid,
        prompt: "private",
      }),
    ).toThrow();
  });

  it("stream fact 只保留 parent id，不允许正文；usage 不接收 V4 文件摘要", () => {
    const stream = conversationTelemetryFactSchema.parse({
      ...base,
      kind: "stream.chunk",
      channel: "text",
      chunkLength: 20,
      firstChunk: true,
      parentToolCallId: "parent-agent-tool",
    });
    expect(stream).toMatchObject({ parentToolCallId: "parent-agent-tool" });
    expect(() =>
      conversationTelemetryFactSchema.parse({ ...stream, content: "private" }),
    ).toThrow();

    const usage = conversationTelemetryFactSchema.parse({
      ...base,
      kind: "usage.delta",
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(() =>
      conversationTelemetryFactSchema.parse({
        ...usage,
        fileAdditions: 10,
        fileCount: 1,
      }),
    ).toThrow();
  });

  it("workflow.lifecycle 只带 run / 子代理 id 与状态；phase 决定必填", () => {
    const spawned = conversationTelemetryFactSchema.parse({
      ...base,
      kind: "workflow.lifecycle",
      phase: "actor-spawned",
      runId: "dwfrun-1",
      toolCallId: "tool-1",
      agentId: "agent#1@1",
      childSessionId: "sess_dwf-1",
      sourceCommandId: "launch-input-1",
    });
    expect(spawned).toMatchObject({ phase: "actor-spawned", childSessionId: "sess_dwf-1" });
    const settled = conversationTelemetryFactSchema.parse({
      ...base,
      kind: "workflow.lifecycle",
      phase: "run-settled",
      runId: "dwfrun-1",
      status: "stopped",
      stopReason: "user",
      errorMessage: "Workflow run stopped (user)",
    });
    expect(settled).toMatchObject({ status: "stopped", stopReason: "user" });
    // actor-spawned 缺子会话 id 不成立；run-settled 缺状态不成立；正文字段一律拒绝。
    expect(() =>
      conversationTelemetryFactSchema.parse({
        ...base,
        kind: "workflow.lifecycle",
        phase: "actor-spawned",
        runId: "dwfrun-1",
        agentId: "agent#1@1",
      }),
    ).toThrow();
    expect(() =>
      conversationTelemetryFactSchema.parse({
        ...base,
        kind: "workflow.lifecycle",
        phase: "run-settled",
        runId: "dwfrun-1",
      }),
    ).toThrow();
    expect(() =>
      conversationTelemetryFactSchema.parse({ ...spawned, scriptText: "export const x = 1" }),
    ).toThrow();
  });

  it("turn.started 接受 workflow 唤起来源；turn.terminal 接受 workflowResultConsumed", () => {
    expect(
      conversationTelemetryFactSchema.parse({
        ...base,
        kind: "turn.started",
        inputSource: "background_task",
        backgroundSource: "workflow",
      }),
    ).toMatchObject({ backgroundSource: "workflow" });
    expect(
      conversationTelemetryFactSchema.parse({
        ...base,
        kind: "turn.terminal",
        status: "success",
        workflowResultConsumed: true,
      }),
    ).toMatchObject({ workflowResultConsumed: true });
  });
});

describe("setAssistantFeedback command schema", () => {
  it("复用 row target CAS，feedback null 表示清除", () => {
    const parsed = parseCommandEnvelope({
      commandId: "command-1",
      clientId: "desktop-1",
      sessionId: "session-1",
      baseRevision: 3,
      baseLogEpoch: "epoch-1",
      type: "setAssistantFeedback",
      payload: {
        target: { rowId: 7, entityId: "assistant-message-1" },
        feedback: null,
      },
      issuedAt: 1_700_000_000_000,
    });
    expect(parsed.ok).toBe(true);
  });

  it("缺少 revision/logEpoch 或伪造 target 字段时拒绝", () => {
    const envelope = {
      commandId: "command-1",
      clientId: "desktop-1",
      sessionId: "session-1",
      type: "setAssistantFeedback" as const,
      payload: {
        target: { rowId: 7, entityId: "assistant-message-1" },
        feedback: "like",
      },
      issuedAt: 1_700_000_000_000,
    };
    expect(parseCommandEnvelope(envelope).ok).toBe(false);
    expect(
      parseCommandEnvelope({
        ...envelope,
        baseRevision: 3,
        baseLogEpoch: "epoch-1",
        payload: {
          ...envelope.payload,
          target: { ...envelope.payload.target, messageId: "x" },
        },
      }).ok,
    ).toBe(false);
  });
});
