import { describe, expect, it } from "vitest";
import {
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  zcodeComputerUseOperationEventSchema,
  zcodeProviderRuntimeHeadersRequestParamsSchema,
  zcodeProviderRuntimeHeadersResponseSchema,
  zcodeProtocolMethods,
  zcodeProtocolMessageSchema,
  zcodeProcessResourceSampleSchema,
  zcodeProtocolNotifications,
  zcodeMcpListParamsSchema,
  zcodeModelFormatPropertiesSchema,
  zcodeMcpTelemetryEventSchema,
  zcodeSessionCreateParamsSchema,
  zcodeSessionCompactParamsSchema,
  zcodeSessionEventSchema,
  zcodeSessionEventsResultSchema,
  zcodeSessionResumeParamsSchema,
  zcodeSessionSubagentsParamsSchema,
  zcodeSessionSubagentsResultSchema,
  zcodeSessionSendParamsSchema,
  zcodeSessionSetModelParamsSchema,
  zcodeSessionSetThoughtLevelParamsSchema,
  zcodeSessionRuntimePreferencesResultSchema,
  zcodeSessionSettingsStateSchema,
  zcodeSessionStateSnapshotSchema,
  zcodeStateUpdatedNotificationSchema,
  zcodeWorkspacePresentationSchema,
  zcodeWorkspaceReadPresentationParamsSchema,
  zcodeWorkspaceUpdateInteractionPreferencesParamsSchema,
  zcodeWorkspaceUpdateInteractionPreferencesResultSchema,
  zcodeWorkspaceUpdateModelIoPreferencesParamsSchema,
  zcodeWorkspaceUpdateModelIoPreferencesResultSchema,
  zcodeAutomationCreateParamsSchema,
  zcodeAutomationCheckTaskBindingParamsSchema,
  zcodeAutomationCheckTaskBindingResultSchema,
  zcodeAutomationUpdateParamsSchema,
  zcodeAutomationProtocolSchema,
} from "../src/zcode-protocol/index.js";
import {
  APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL,
  appRuntimePreferencesChangedBroadcastPayloadSchema,
} from "../src/app-runtime-preferences.js";
import { zcodeUserMessageInfoSchema } from "../src/zcode-protocol-legacy-types.js";
import { conversationRowSchema, workflowLaunchMetaSchema } from "../src/zcode-protocol-v4/rows.js";
import { errorAttributionSchema } from "../src/zcode-protocol-v4/snapshot.js";

const workspace = {
  workspacePath: "/workspace/app",
  workspaceIdentity: "remote:ssh:dev:/workspace/app",
  workspaceKey: "remote:ssh:dev:/workspace/app",
};

const model = {
  providerId: "glm",
  modelId: "glm-4.6",
};

const modelProperties = {
  inputFormat: {
    supportsText: true,
    supportsImage: false,
    supportsVideo: false,
    supportsAudio: false,
    supportsPdf: true,
  },
  outputFormat: { supportsText: true },
};

describe("ZCode Protocol", () => {
  it("模型格式能力只接受完整的嵌套 properties 契约", () => {
    const properties = {
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: true,
      },
      outputFormat: { supportsText: true },
    };

    expect(zcodeModelFormatPropertiesSchema.parse(properties)).toEqual(properties);
    expect(() =>
      zcodeModelFormatPropertiesSchema.parse({
        supportsImages: true,
        supportsPdf: true,
        supportsVideo: false,
      }),
    ).toThrow();
    expect(() =>
      zcodeModelFormatPropertiesSchema.parse({
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsPdf: true,
        },
        outputFormat: { supportsText: true },
      }),
    ).toThrow();
  });

  it("普通 Session 命令拒绝 Host runtimeModel 快照", () => {
    const runtimeModel = {
      revision: "model-runtime:test",
      generatedAt: 1,
      model,
      provider: {
        providerId: model.providerId,
        kind: "anthropic",
        apiFormat: "anthropic-messages",
        baseURL: "https://example.com",
        models: [{ modelId: model.modelId }],
      },
    };

    const payloads = [
      [zcodeSessionCreateParamsSchema, { workspace, model, runtimeModel }],
      [zcodeSessionResumeParamsSchema, { sessionId: "session-1", runtimeModel }],
      [
        zcodeSessionSendParamsSchema,
        {
          sessionId: "session-1",
          content: "hello",
          expectedModelRuntimeRevision: runtimeModel.revision,
          runtimeModel,
        },
      ],
      [zcodeSessionCompactParamsSchema, { sessionId: "session-1", runtimeModel }],
      [zcodeSessionSetModelParamsSchema, { sessionId: "session-1", model, runtimeModel }],
      [
        zcodeSessionSetThoughtLevelParamsSchema,
        { sessionId: "session-1", thoughtLevel: "high", runtimeModel },
      ],
    ] as const;

    for (const [schema, payload] of payloads) {
      expect(() => schema.parse(payload)).toThrow();
    }
  });

  it("accepts only bounded process resource samples without workspace or session identity", () => {
    const sample = {
      arch: "arm64",
      cpuCores: 2.5,
      cpuPercent: 31.25,
      intervalMs: 60_000,
      logicalCpuCount: 8,
      platform: "darwin",
      rssKb: 65_536,
    };

    expect(zcodeProtocolNotifications.processResourceSample).toBe("process/resourceSample");
    // PRT-025：旧 CLI 发来的样本没有新字段，仍必须通过校验（新增字段全部可选，握手版本不递增）。
    expect(zcodeProcessResourceSampleSchema.parse(sample)).toEqual(sample);
    const sampleWithTelemetryFields = {
      ...sample,
      heapUsedKb: 20_480,
      uptimeMinutes: 12,
      totalMemoryGb: 16,
      instanceToken: "9f2c4a1b7d0e5638",
    };
    expect(zcodeProcessResourceSampleSchema.parse(sampleWithTelemetryFields)).toEqual(
      sampleWithTelemetryFields,
    );
    // lane 由 app 侧 services 按所属进程管理器打标，CLI 不知道自己的 lane，也不允许自报。
    expect(() => zcodeProcessResourceSampleSchema.parse({ ...sample, lane: "chat" })).toThrow();
    // instanceToken 只用于 main 统计进程数，绝不能被拿来夹带 pid、路径或 workspace 标识。
    expect(() =>
      zcodeProcessResourceSampleSchema.parse({ ...sample, instanceToken: "/private/repo" }),
    ).toThrow();
    expect(() =>
      zcodeProcessResourceSampleSchema.parse({ ...sample, instanceToken: "" }),
    ).toThrow();
    expect(() => zcodeProcessResourceSampleSchema.parse({ ...sample, heapUsedKb: -1 })).toThrow();
    expect(() =>
      zcodeProcessResourceSampleSchema.parse({ ...sample, uptimeMinutes: 1.5 }),
    ).toThrow();
    expect(() =>
      zcodeProcessResourceSampleSchema.parse({
        ...sample,
        workspacePath: "/private/repo",
      }),
    ).toThrow();
    expect(() =>
      zcodeProcessResourceSampleSchema.parse({
        ...sample,
        cpuCores: Number.NaN,
      }),
    ).toThrow();
    expect(() =>
      zcodeProcessResourceSampleSchema.parse({
        ...sample,
        logicalCpuCount: 0,
      }),
    ).toThrow();
  });

  it("accepts only the four privacy-bounded MCP telemetry events", () => {
    const base = {
      arch: "arm64",
      occurredAt: 1_000,
      platform: "darwin",
    } as const;
    const events = [
      {
        ...base,
        kind: "process_start",
        mcpId: "builtin:node_repl",
        mcpInstanceId: "mcp-instance-1",
        mcpIsolation: "workspace",
        mcpSource: "builtin",
      },
      {
        ...base,
        kind: "process_start",
        mcpId: "builtin:zcode-cua:computer-use",
        mcpInstanceId: "mcp-instance-2",
        mcpIsolation: "session",
        mcpSource: "builtin",
      },
      {
        ...base,
        kind: "process_start",
        mcpId: "builtin:document-skills:image%20search%2F%E9%AB%98%E6%B8%85",
        mcpInstanceId: "mcp-instance-3",
        mcpIsolation: "session",
        mcpSource: "builtin",
      },
      {
        ...base,
        affectedSessionCount: 2,
        exitCode: 1,
        kind: "process_crash",
        mcpId: "builtin:node_repl",
        mcpInstanceId: "mcp-instance-1",
        mcpIsolation: "workspace",
        mcpSource: "builtin",
        signal: null,
        uptimeMs: 10_000,
      },
      {
        ...base,
        configuredCount: 3,
        connectedCount: 2,
        failedCount: 1,
        kind: "session_startup",
        processCount: 1,
        sessionId: "session-1",
      },
      {
        ...base,
        kind: "memory",
        mcpId: "custom:123456789abc",
        mcpInstanceId: "mcp-instance-2",
        mcpIsolation: "session",
        mcpSource: "custom",
        memoryKb: 65_536,
        memoryScope: "process_tree",
        orphanSuspected: true,
        ownerSessionCount: 0,
        unownedSeconds: 60.001,
      },
    ];

    expect(zcodeProtocolNotifications.mcpTelemetry).toBe("process/mcpTelemetry");
    expect(events.map((event) => zcodeMcpTelemetryEventSchema.parse(event))).toEqual(events);
    expect(() =>
      zcodeMcpTelemetryEventSchema.parse({
        ...events[0],
        mcpServerName: "private-company-server",
      }),
    ).toThrow();
  });

  it("accepts a default thought level in session settings", () => {
    expect(
      zcodeSessionSettingsStateSchema.parse({
        model: {
          current: model,
          available: [{ ref: model, label: "GLM 4.6", properties: modelProperties }],
        },
        thoughtLevel: {
          enabled: true,
          current: undefined,
          defaultLevel: "max",
          available: [
            { value: "high", label: "High" },
            { value: "max", label: "Max" },
          ],
        },
        mode: {
          current: "build",
        },
      }),
    ).toMatchObject({
      thoughtLevel: {
        defaultLevel: "max",
      },
    });
  });

  it("uses reasoning presence as support and rejects removed model-option projections", () => {
    const currentModelOption = {
      ref: model,
      label: "GLM 4.6",
      properties: modelProperties,
      reasoning: { levels: [{ value: "high", label: "High" }] },
    };

    expect(
      zcodeSessionSettingsStateSchema.parse({
        model: { current: model, available: [currentModelOption] },
        thoughtLevel: { enabled: true, available: [], current: undefined },
        mode: { current: "build" },
      }).model.available[0]?.reasoning?.levels,
    ).toHaveLength(1);

    for (const removedField of [
      "providerSource",
      "providerLogoUrl",
      "supportsTools",
      "supportsStructuredOutput",
      "supportsJsonSchemaOutput",
    ]) {
      expect(() =>
        zcodeSessionSettingsStateSchema.parse({
          model: {
            current: model,
            available: [{ ...currentModelOption, [removedField]: true }],
          },
          thoughtLevel: { enabled: true, available: [], current: undefined },
          mode: { current: "build" },
        }),
      ).toThrow();
    }

    expect(() =>
      zcodeSessionSettingsStateSchema.parse({
        model: {
          current: model,
          available: [{ ...currentModelOption, reasoning: { enabled: true, levels: [] } }],
        },
        thoughtLevel: { enabled: true, available: [], current: undefined },
        mode: { current: "build" },
      }),
    ).toThrow();
  });

  it("validates the dedicated app runtime preference broadcast payload", () => {
    expect(APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL).toBe(
      "settings:app-runtime-preferences",
    );
    expect(
      appRuntimePreferencesChangedBroadcastPayloadSchema.parse({
        askUserQuestionAutoResolutionEnabled: false,
      }),
    ).toEqual({
      askUserQuestionAutoResolutionEnabled: false,
      modelIoFullRetentionEnabled: false,
    });
    expect(() =>
      appRuntimePreferencesChangedBroadcastPayloadSchema.parse({
        askUserQuestionAutoResolutionEnabled: false,
        ignored: true,
      }),
    ).toThrow();
  });

  it("accepts bounded browser ambient context on session/send while staying strict", () => {
    expect(
      zcodeSessionSendParamsSchema.parse({
        sessionId: "sess_1",
        content: "continue",
        browserAmbientContext: {
          tabCount: 1,
          currentUrl: "https://example.com/current?q=1",
        },
      }).browserAmbientContext,
    ).toEqual({ tabCount: 1, currentUrl: "https://example.com/current?q=1" });
    expect(() =>
      zcodeSessionSendParamsSchema.parse({
        sessionId: "sess_1",
        content: "continue",
        browserAmbientContext: { tabCount: 0 },
      }),
    ).toThrow();
    expect(() =>
      zcodeSessionSendParamsSchema.parse({
        sessionId: "sess_1",
        content: "continue",
        browserAmbientContext: { tabCount: 1, pageText: "secret" },
      }),
    ).toThrow();
  });

  it("session/send accepts Off-Peak turn attribution but rejects competing automation identity", () => {
    expect(
      zcodeSessionSendParamsSchema.parse({
        sessionId: "sess_1",
        content: "continue",
        offPeakTaskId: "offpeak-1",
        offPeakRunType: "resume",
      }),
    ).toMatchObject({ offPeakTaskId: "offpeak-1", offPeakRunType: "resume" });
    expect(() =>
      zcodeSessionSendParamsSchema.parse({
        sessionId: "sess_1",
        content: "invalid",
        offPeakRunType: "init",
      }),
    ).toThrow();
    expect(() =>
      zcodeSessionSendParamsSchema.parse({
        sessionId: "sess_1",
        content: "continue",
        automationId: "automation-1",
        offPeakTaskId: "offpeak-1",
      }),
    ).toThrow();
  });

  it("session/send and automation/create validate the bot delivery target strictly", () => {
    const botDeliveryTarget = {
      provider: "weixin" as const,
      botId: "bot-weixin",
      providerUserId: "chat-1",
      chatType: "private" as const,
    };
    expect(
      zcodeSessionSendParamsSchema.parse({
        sessionId: "sess_1",
        content: "创建定时任务",
        botDeliveryTarget,
      }).botDeliveryTarget,
    ).toEqual(botDeliveryTarget);
    expect(
      zcodeAutomationCreateParamsSchema.parse({
        cronExpr: "0 9 * * *",
        prompt: "日报",
        botDeliveryTarget,
      }).botDeliveryTarget,
    ).toEqual(botDeliveryTarget);
    expect(() =>
      zcodeAutomationCreateParamsSchema.parse({
        cronExpr: "0 9 * * *",
        prompt: "日报",
        botDeliveryTarget: { ...botDeliveryTarget, provider: "discord" },
      }),
    ).toThrow();
  });

  it("keeps protocol methods session-first and private", () => {
    const methods = Object.values(zcodeProtocolMethods);

    expect(methods).not.toContain("capabilities");
    expect(methods.every((method) => !method.includes("task"))).toBe(true);
    expect(methods).toContain("session/read");
    expect(methods).toContain("session/usage");
    expect(methods).toContain("session/subagents");
    expect(methods).toContain("session/setModel");
    expect(methods).toContain("session/cancelBackgroundTask");
    expect(methods).toContain("workspace/readPresentation");
    expect(methods).not.toContain("workspace/readState");
    expect(methods).not.toContain("workspace/setDefaultModel");
    expect(methods).not.toContain("workspace/setDefaultThoughtLevel");
    expect(methods).toContain("automation/create");
    expect(methods).toContain("automation/update");
  });

  it("validates the strict Computer Use operation lifecycle notification", () => {
    expect(zcodeProtocolMethods.computerUseOperationEvent).toBe("computer-use/operation-event");

    const base = {
      eventId: "evt-1",
      sequenceNumber: 1,
      sessionId: "sess-1",
      timestamp: 1_700_000_000_000,
    };
    for (const event of [
      { ...base, kind: "turn-started", turnId: "turn-1" },
      { ...base, kind: "turn-completed", turnId: "turn-1" },
      { ...base, kind: "turn-failed", turnId: "turn-1" },
      {
        ...base,
        kind: "tool-scheduled",
        turnId: "turn-1",
        toolCallId: "call-1",
        toolName: "mcp__computer-use__left_click",
      },
      {
        ...base,
        kind: "tool-scheduled",
        turnId: "turn-1",
        toolCallId: "call-node-repl",
        toolName: "mcp__node_repl__js",
        computerUse: true,
      },
      {
        ...base,
        kind: "tool-started",
        turnId: "turn-1",
        toolCallId: "call-1",
      },
      { ...base, kind: "session-closed" },
    ]) {
      expect(zcodeComputerUseOperationEventSchema.safeParse(event).success).toBe(true);
    }

    for (const event of [
      { ...base, eventId: "", kind: "session-closed" },
      { ...base, sequenceNumber: -1, kind: "session-closed" },
      { ...base, kind: "turn-started" },
      { ...base, kind: "tool-scheduled", turnId: "turn-1", toolCallId: "call-1" },
      // computerUse 是布尔事实，只有 true 有意义；false 与动作名都不在契约里。
      {
        ...base,
        kind: "tool-scheduled",
        turnId: "turn-1",
        toolCallId: "call-1",
        toolName: "mcp__node_repl__js",
        computerUse: false,
      },
      // tool-started 拿不到模型源码（ToolCallStartedPayload 无 input），不允许携带该事实。
      {
        ...base,
        kind: "tool-started",
        turnId: "turn-1",
        toolCallId: "call-1",
        computerUse: true,
      },
      { ...base, kind: "tool-started", toolCallId: "" },
      { ...base, kind: "session-closed", toolName: "must-not-pass" },
      { ...base, kind: "unknown-kind" },
    ]) {
      expect(zcodeComputerUseOperationEventSchema.safeParse(event).success).toBe(false);
    }
  });

  it("workspace/readPresentation 只接受 workspace identity", () => {
    expect(() =>
      zcodeWorkspaceReadPresentationParamsSchema.parse({
        workspace,
        runtimeModel: {},
      }),
    ).toThrow();
    expect(zcodeWorkspaceReadPresentationParamsSchema.parse({ workspace })).toEqual({ workspace });
  });

  it("preserves automation runtime config in strict protocol schemas", () => {
    const create = zcodeAutomationCreateParamsSchema.parse({
      title: "daily report",
      cronExpr: "0 9 * * *",
      prompt: "summarize",
      modelSelection: {
        providerId: "glm",
        modelId: "glm-5.2",
        options: { reasoningLevel: "high" },
      },
      mode: "plan",
    });
    expect(
      zcodeAutomationCreateParamsSchema.parse({
        title: "3分钟后提醒",
        cronExpr: "* * * * *",
        relativeDelayMinutes: 3,
        prompt: "提醒我",
        recurring: false,
      }),
    ).toMatchObject({ relativeDelayMinutes: 3, recurring: false });
    expect(create).toMatchObject({
      modelSelection: {
        providerId: "glm",
        modelId: "glm-5.2",
        options: { reasoningLevel: "high" },
      },
      mode: "plan",
    });

    expect(
      zcodeAutomationProtocolSchema.parse({
        automationId: "automation-1",
        ...create,
        enabled: true,
        lifecycleStatus: "active",
        runCount: 0,
        recurring: true,
      }),
    ).toMatchObject({ mode: "plan", modelSelection: { modelId: "glm-5.2" } });

    expect(
      zcodeAutomationProtocolSchema.parse({
        automationId: "automation-default-mode",
        title: "daily report",
        cronExpr: "0 9 * * *",
        prompt: "summarize",
        mode: "default",
        enabled: true,
        lifecycleStatus: "active",
        runCount: 0,
        recurring: true,
      }),
    ).toMatchObject({ mode: "default" });
  });

  it("将会话 Cron interval carrier 严格限制为 1-200 并要求成对提交", () => {
    expect(
      zcodeAutomationCreateParamsSchema.parse({
        cronExpr: "* * * * *",
        prompt: "提醒我",
        intervalUnit: "minute",
        interval: 200,
      }),
    ).toMatchObject({ intervalUnit: "minute", interval: 200 });
    expect(() =>
      zcodeAutomationCreateParamsSchema.parse({
        cronExpr: "* * * * *",
        prompt: "提醒我",
        intervalUnit: "minute",
        interval: 201,
      }),
    ).toThrow();
    expect(() =>
      zcodeAutomationCreateParamsSchema.parse({
        cronExpr: "* * * * *",
        prompt: "提醒我",
        intervalUnit: "minute",
      }),
    ).toThrow();

    expect(
      zcodeAutomationUpdateParamsSchema.parse({
        automationId: "automation-1",
        intervalUnit: "yearly",
        interval: 200,
      }),
    ).toMatchObject({ intervalUnit: "yearly", interval: 200 });
    expect(() =>
      zcodeAutomationUpdateParamsSchema.parse({
        automationId: "automation-1",
        intervalUnit: "yearly",
        interval: 1.5,
      }),
    ).toThrow();
    // carrier 必须保持无限循环，避免 host 直接收到 recurring=false / 有限次数的矛盾状态。
    expect(
      zcodeAutomationUpdateParamsSchema.parse({
        automationId: "automation-1",
        intervalUnit: "yearly",
        interval: 200,
        recurring: true,
        maxRuns: null,
      }),
    ).toMatchObject({ recurring: true, maxRuns: null });
    for (const invalidMode of [{ recurring: false }, { maxRuns: 2 }]) {
      expect(() =>
        zcodeAutomationUpdateParamsSchema.parse({
          automationId: "automation-1",
          intervalUnit: "yearly",
          interval: 200,
          ...invalidMode,
        }),
      ).toThrow();
    }
    for (const invalidMode of [{ recurring: false }, { maxRuns: 2 }]) {
      expect(() =>
        zcodeAutomationCreateParamsSchema.parse({
          cronExpr: "* * * * *",
          prompt: "提醒我",
          intervalUnit: "minute",
          interval: 200,
          ...invalidMode,
        }),
      ).toThrow();
    }
  });

  it("validates the dedicated automation task-binding query", () => {
    expect(
      zcodeAutomationCheckTaskBindingParamsSchema.parse({ targetTaskId: "session-1" }),
    ).toEqual({ targetTaskId: "session-1" });
    expect(zcodeAutomationCheckTaskBindingResultSchema.parse({ bound: true })).toEqual({
      bound: true,
    });
    expect(() =>
      zcodeAutomationCheckTaskBindingParamsSchema.parse({ targetTaskId: " " }),
    ).toThrow();
    expect(() =>
      zcodeAutomationCheckTaskBindingResultSchema.parse({ bound: false, automations: [] }),
    ).toThrow();
  });

  it("validates a strict non-empty automation update patch", () => {
    expect(
      zcodeAutomationUpdateParamsSchema.parse({
        automationId: "automation-1",
        cronExpr: "0 10 * * *",
        recurring: true,
        maxRuns: null,
      }),
    ).toEqual({
      automationId: "automation-1",
      cronExpr: "0 10 * * *",
      recurring: true,
      maxRuns: null,
    });
    expect(
      zcodeAutomationUpdateParamsSchema.parse({
        automationId: "automation-1",
        recurring: true,
      }),
    ).toEqual({
      automationId: "automation-1",
      recurring: true,
    });

    expect(() =>
      zcodeAutomationUpdateParamsSchema.parse({ automationId: "automation-1" }),
    ).toThrow();
    expect(() =>
      zcodeAutomationUpdateParamsSchema.parse({
        automationId: "automation-1",
        title: "new title",
        enabled: false,
      }),
    ).toThrow();
    expect(() =>
      zcodeAutomationUpdateParamsSchema.parse({
        automationId: "automation-1",
        maxRuns: null,
      }),
    ).toThrow("clearing maxRuns requires recurring=true");
    expect(() =>
      zcodeAutomationUpdateParamsSchema.parse({
        automationId: "automation-1",
        recurring: false,
        maxRuns: null,
      }),
    ).toThrow("clearing maxRuns requires recurring=true");
    expect(() =>
      zcodeAutomationUpdateParamsSchema.parse({
        automationId: "automation-1",
        recurring: true,
        maxRuns: 3,
      }),
    ).toThrow("recurring=true cannot be combined with a numeric maxRuns");
  });

  it("accepts an explicit session title-generation switch while staying strict", () => {
    expect(
      zcodeSessionCreateParamsSchema.parse({
        workspace,
        titleGenerationEnabled: false,
      }).titleGenerationEnabled,
    ).toBe(false);
    expect(() =>
      zcodeSessionCreateParamsSchema.parse({
        workspace,
        titleGenerationEnabled: "false",
      }),
    ).toThrow();
  });

  it("validates the paged session subagent projection", () => {
    expect(
      zcodeSessionSubagentsParamsSchema.parse({
        sessionId: "sess_parent",
        endedCursor: "cursor-20",
        endedLimit: 20,
      }),
    ).toEqual({
      sessionId: "sess_parent",
      endedCursor: "cursor-20",
      endedLimit: 20,
    });

    expect(
      zcodeSessionSubagentsResultSchema.parse({
        revision: 7,
        childSessionIds: ["sess_child_running", "sess_child_failed"],
        running: [
          {
            childSessionId: "sess_child_running",
            subagentType: "Explore",
            title: "Inspect the renderer",
            status: "waiting",
            startedAt: 10,
          },
        ],
        ended: {
          total: 1,
          items: [
            {
              childSessionId: "sess_child_failed",
              subagentType: "Plan",
              title: "Plan the migration",
              summary: "Provider request failed",
              status: "failed",
              startedAt: 1,
              endedAt: 9,
            },
          ],
          nextCursor: "cursor-40",
        },
      }),
    ).toMatchObject({
      revision: 7,
      childSessionIds: ["sess_child_running", "sess_child_failed"],
      running: [{ status: "waiting" }],
      ended: { total: 1, items: [{ status: "failed" }] },
    });

    expect(() =>
      zcodeSessionSubagentsParamsSchema.parse({
        sessionId: "sess_parent",
        endedLimit: 0,
      }),
    ).toThrow();
    expect(() =>
      zcodeSessionSubagentsResultSchema.parse({
        revision: 0,
        childSessionIds: ["sess_child"],
        running: [],
        ended: {
          total: 1,
          items: [
            {
              childSessionId: "sess_child",
              subagentType: "Explore",
              title: "Inspect",
              status: "running",
            },
          ],
        },
      }),
    ).toThrow();
  });

  it("parses JSON-RPC style messages without requiring a jsonrpc field", () => {
    const parsed = zcodeProtocolMessageSchema.parse({
      id: "request-1",
      method: "session/read",
      params: {
        sessionId: "sess_1",
      },
    });

    expect(parsed).toMatchObject({
      id: "request-1",
      method: "session/read",
    });
  });

  it("allows MCP list requests to carry explicit MCP servers", () => {
    expect(
      zcodeMcpListParamsSchema.parse({
        workspace,
        mcpServers: [
          {
            name: "agents-fallback",
            command: "node",
            args: ["server.mjs"],
            env: [{ name: "TOKEN", value: "secret" }],
            timeoutMs: 3000,
          },
        ],
      }),
    ).toMatchObject({
      workspace,
      mcpServers: [
        {
          name: "agents-fallback",
          command: "node",
          args: ["server.mjs"],
          env: [{ name: "TOKEN", value: "secret" }],
          timeoutMs: 3000,
        },
      ],
    });
  });

  it("accepts MCP servers on session create and resume params while staying strict", () => {
    const mcpServers = [
      {
        name: "chrome-devtools",
        command: "npx",
        args: ["-y", "chrome-devtools-mcp@latest"],
        env: [],
        timeoutMs: 3,
      },
      {
        name: "linear",
        type: "http",
        url: "https://mcp.example.test",
        headers: [{ name: "Authorization", value: "Bearer token" }],
        timeoutMs: 5000,
      },
      {
        name: "events",
        type: "sse",
        url: "https://mcp.example.test/sse",
        headers: [],
        timeoutMs: 8000,
      },
    ];

    expect(zcodeSessionCreateParamsSchema.parse({ workspace, mcpServers }).mcpServers).toEqual(
      mcpServers,
    );
    expect(
      zcodeSessionResumeParamsSchema.parse({
        sessionId: "sess_1",
        workspace,
        mcpServers,
      }).mcpServers,
    ).toEqual(mcpServers);
    expect(() =>
      zcodeSessionCreateParamsSchema.parse({
        workspace,
        mcpServers: [
          {
            ...mcpServers[0],
            tokenShouldNotPass: true,
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts session create tool lists while staying strict", () => {
    const parsed = zcodeSessionCreateParamsSchema.parse({
      workspace,
      toolAllowlist: ["mcp__zcode-cua__request_access", "mcp__zcode-cua__list_apps"],
      toolDenylist: ["Bash"],
    });

    expect(parsed.toolAllowlist).toEqual([
      "mcp__zcode-cua__request_access",
      "mcp__zcode-cua__list_apps",
    ]);
    expect(parsed.toolDenylist).toEqual(["Bash"]);
    expect(() =>
      zcodeSessionCreateParamsSchema.parse({
        workspace,
        toolAllowlist: ["Read"],
        unexpectedToolPolicy: true,
      }),
    ).toThrow();
  });

  it("accepts session RESUME tool lists too (cold resume keeps the same isolation)", () => {
    // 冷恢复必须和 create 同边界地带工具面约束，否则 CUA 会话 resume 后会重新可见 Bash 等被禁工具。
    const parsed = zcodeSessionResumeParamsSchema.parse({
      sessionId: "sess_1",
      toolAllowlist: ["mcp__zcode-cua__request_access"],
      toolDenylist: ["Bash"],
    });
    expect(parsed.toolAllowlist).toEqual(["mcp__zcode-cua__request_access"]);
    expect(parsed.toolDenylist).toEqual(["Bash"]);
    // 仍 strict：未知字段拒绝。
    expect(() =>
      zcodeSessionResumeParamsSchema.parse({
        sessionId: "sess_1",
        unexpectedToolPolicy: true,
      }),
    ).toThrow();
  });

  it("models provider runtime header refresh as a strict interaction request", () => {
    const params = zcodeProviderRuntimeHeadersRequestParamsSchema.parse({
      requestId: "header-refresh-1",
      sessionId: "sess_1",
      turnId: "turn_1",
      workspace,
      modelSelection: model,
      providerId: "account:zai-individual-coding-plan",
      reason: "model-request",
    });
    // 当前请求期鉴权材料承接请求级 header；不能恢复旧 Registry revision 或裸 headers 协议。
    const runtimeProviderHeaders = {
      "X-Request-Scoped-Param": "request-token",
      "X-Request-Scoped-Region": "cn",
    };
    const response = zcodeProviderRuntimeHeadersResponseSchema.parse({
      headersApplied: true,
      requestAuth: {
        apiKey: "request-key",
        headers: { "X-Request": "request-header", ...runtimeProviderHeaders },
      },
    });
    expect(response).toMatchObject({ requestAuth: { headers: runtimeProviderHeaders } });
    expect(() =>
      zcodeProviderRuntimeHeadersResponseSchema.parse({
        headersApplied: true,
      }),
    ).toThrow();
    expect(() =>
      zcodeProviderRuntimeHeadersResponseSchema.parse({
        headersApplied: true,
        runtimeProviderHeaders,
        providerRevision: "rev-2",
      }),
    ).toThrow();

    expect(zcodeProtocolMethods.interactionRequestProviderRuntimeHeaders).toBe(
      "interaction/requestProviderRuntimeHeaders",
    );
    expect(() =>
      zcodeProviderRuntimeHeadersRequestParamsSchema.parse({
        ...params,
        staleHeader: "must-not-pass-through",
      }),
    ).toThrow();
  });

  it.each(["start-plan", "individual-coding-plan", "team-coding-plan", "off-peak"] as const)(
    "runtime headers 直接接受 Registry zhipu access mode: %s",
    (mode) => {
      const parsed = zcodeProviderRuntimeHeadersRequestParamsSchema.parse({
        requestId: `request-${mode}`,
        sessionId: "sess_1",
        workspace,
        modelSelection: model,
        providerId: `account:${mode}`,
        accountAccess: {
          type: "zhipu-account",
          accountType: "bigmodel",
          mode,
          entitled: true,
        },
        reason: "model-request",
      });

      expect(parsed.accountAccess).toEqual({
        type: "zhipu-account",
        accountType: "bigmodel",
        mode,
        entitled: true,
      });
    },
  );

  it("runtime headers 拒绝已经退出 Registry 的旧 planKind Access 形状", () => {
    expect(() =>
      zcodeProviderRuntimeHeadersRequestParamsSchema.parse({
        requestId: "request-legacy",
        sessionId: "sess_1",
        workspace,
        modelSelection: model,
        providerId: "account:legacy",
        accountAccess: {
          type: "zhipu-account",
          accountType: "bigmodel",
          planKind: "team-coding-plan",
        },
        reason: "model-request",
      }),
    ).toThrow();
  });

  it("parses subagent mirrored tool updates with explicit protocol metadata", () => {
    const scheduled = zcodeSessionEventSchema.parse({
      eventId: "evt_subagent_tool_scheduled",
      seq: 12,
      sessionId: "sess_parent",
      timestamp: 13,
      traceId: "trace_parent",
      turnId: "turn_parent",
      type: "tool.updated",
      payload: {
        kind: "scheduled",
        toolCallId: "tool_subagent_agent_1_call_1",
        toolName: "Read",
        input: { filePath: "/workspace/app.ts" },
        parentToolCallId: "call_parent_agent",
        source: "subagent",
        agentId: "agent_1",
        agentType: "Explore",
        childSessionId: "sess_subagent_agent_1",
        childToolCallId: "call_1",
        description: "Inspect workspace",
      },
    });
    const started = zcodeSessionEventSchema.parse({
      eventId: "evt_subagent_tool_started",
      seq: 13,
      sessionId: "sess_parent",
      timestamp: 14,
      traceId: "trace_parent",
      turnId: "turn_parent",
      type: "tool.updated",
      payload: {
        kind: "started",
        toolCallId: "tool_subagent_agent_1_call_1",
        startedAt: 14,
        parentToolCallId: "call_parent_agent",
        source: "subagent",
        agentId: "agent_1",
        agentType: "Explore",
        childSessionId: "sess_subagent_agent_1",
        childToolCallId: "call_1",
        description: "Inspect workspace",
      },
    });

    expect(scheduled.payload.parentToolCallId).toBe("call_parent_agent");
    expect(started.payload.source).toBe("subagent");
    expect(() =>
      zcodeSessionEventSchema.parse({
        ...scheduled,
        payload: {
          ...scheduled.payload,
          unknownSubagentField: true,
        },
      }),
    ).toThrow();
  });

  it("parses background subagent mirrored tool updates", () => {
    const event = zcodeSessionEventSchema.parse({
      eventId: "evt_background_subagent_tool_started",
      seq: 14,
      sessionId: "sess_parent",
      timestamp: 15,
      traceId: "trace_parent",
      turnId: "turn_parent",
      type: "tool.updated",
      payload: {
        kind: "started",
        toolCallId: "tool_subagent_agent_1_call_1",
        startedAt: 15,
        source: "subagent",
        agentId: "agent_1",
        agentType: "Explore",
        childSessionId: "sess_subagent_agent_1",
        childToolCallId: "call_1",
        background: true,
      },
    });

    expect(event.payload.background).toBe(true);
  });

  it("parses subagent mirrored permission events with routing metadata", () => {
    const requested = zcodeSessionEventSchema.parse({
      eventId: "evt_subagent_permission_requested",
      seq: 14,
      sessionId: "sess_parent",
      timestamp: 15,
      traceId: "trace_parent",
      turnId: "turn_parent",
      type: "permission.requested",
      payload: {
        requestId: "permission_1",
        toolCallId: "tool_subagent_agent_1_call_1",
        toolName: "Bash",
        riskLevel: "high",
        reason: "Run workspace tests",
        input: { command: "pnpm test" },
        childSessionId: "sess_subagent_agent_1",
        background: true,
        options: [
          {
            optionId: "allow_once",
            kind: "allowOnce",
            name: "Allow once",
            response: { decision: "allow" },
          },
        ],
      },
    });
    const resolved = zcodeSessionEventSchema.parse({
      eventId: "evt_subagent_permission_resolved",
      seq: 15,
      sessionId: "sess_parent",
      timestamp: 16,
      traceId: "trace_parent",
      turnId: "turn_parent",
      type: "permission.resolved",
      payload: {
        requestId: "permission_1",
        toolCallId: "tool_subagent_agent_1_call_1",
        toolName: "Bash",
        decision: "allow",
        childSessionId: "sess_subagent_agent_1",
        background: true,
      },
    });

    expect(requested.payload.childSessionId).toBe("sess_subagent_agent_1");
    expect(requested.payload.background).toBe(true);
    expect(resolved.payload.childSessionId).toBe("sess_subagent_agent_1");
    expect(resolved.payload.background).toBe(true);
  });

  it("parses scheduled tool updates that reference model-streamed input", () => {
    const scheduled = zcodeSessionEventSchema.parse({
      eventId: "evt_tool_scheduled_tombstone",
      seq: 15,
      sessionId: "sess_parent",
      timestamp: 16,
      traceId: "trace_parent",
      turnId: "turn_parent",
      type: "tool.updated",
      payload: {
        kind: "scheduled",
        toolCallId: "call_1",
        toolName: "Write",
        inputByteLength: 32768,
        inputOmitted: true,
        inputRef: "model_stream",
      },
    });

    expect(scheduled.payload.inputOmitted).toBe(true);
    expect(scheduled.payload.inputRef).toBe("model_stream");
    expect("input" in scheduled.payload).toBe(false);
  });

  describe.each(["desktop-continuous", "web-remote-replayable"])(
    "scheduled tool message ownership (%s)",
    (deliveryKind) => {
      it.each([
        { input: { command: "sleep 20" } },
        { inputByteLength: 128, inputOmitted: true, inputRef: "model_stream" },
      ])("preserves ownership for input form %j while keeping strict validation", (input) => {
        const event = {
          eventId: "evt_scheduled_ownership",
          seq: 1,
          sessionId: "sess_ownership",
          timestamp: 1,
          deliveryKind,
          type: "tool.updated",
          payload: {
            kind: "scheduled",
            toolCallId: "call_ownership",
            toolName: "Bash",
            ...input,
          },
        };

        // 旧 CLI 没有消息归属字段时仍须兼容；新 CLI 的字段不能导致整条调度事件丢失。
        expect(zcodeSessionEventSchema.parse(event).payload).toEqual(event.payload);
        const payload = { ...event.payload, assistantMessageId: "msg_assistant" };
        expect(zcodeSessionEventSchema.parse({ ...event, payload })).toEqual({ ...event, payload });

        for (const assistantMessageId of ["", null, 42]) {
          expect(
            zcodeSessionEventSchema.safeParse({
              ...event,
              payload: { ...payload, assistantMessageId },
            }).success,
          ).toBe(false);
        }
        expect(
          zcodeSessionEventSchema.safeParse({
            ...event,
            payload: { ...payload, unknownField: true },
          }).success,
        ).toBe(false);
      });
    },
  );

  it("parses a server-authoritative session state snapshot", () => {
    const snapshot = zcodeSessionStateSnapshotSchema.parse({
      protocol: {
        name: ZCODE_PROTOCOL_NAME,
        version: ZCODE_PROTOCOL_VERSION,
      },
      session: {
        sessionId: "sess_1",
        workspace,
        sessionKind: "interactive",
        title: "Build login flow",
        titleSource: "generated",
        mode: "build",
        status: "idle",
        model,
        createdAt: 1,
        updatedAt: 2,
      },
      settings: {
        model: {
          current: model,
          available: [{ ref: model, label: "GLM 4.6", properties: modelProperties }],
          lastUsed: model,
        },
        thoughtLevel: {
          enabled: true,
          current: "medium",
          available: [{ value: "medium", label: "Medium" }],
        },
        mode: {
          current: "build",
        },
      },
      projection: {
        sessionId: "sess_1",
        status: "idle",
        mode: "build",
        turnCount: 1,
        totalTokenCount: 0,
        contextUsed: 0,
        contextWindow: 128000,
        pendingPermissions: [],
        activeToolCalls: [],
        backgroundJobs: [],
        lastError: {
          type: "MODEL_ERROR",
          code: "provider_not_found",
          message: "Model provider is not configured: stale-provider",
          detail: "stale-provider/gpt-5.5",
          attribution: {
            source: "runtime",
            reason: "provider_not_configured",
            providerId: "account:zai-individual-coding-plan",
            retryable: false,
          },
        },
      },
      runtime: {
        eventSeq: 7,
        stateRevision: 3,
        deliveryKind: "desktop-continuous",
        pendingRequestIds: [],
      },
      messages: [
        {
          info: {
            messageId: "msg_1",
            sessionId: "sess_1",
            role: "user",
            time: { created: 1 },
            agent: "zcode-agent",
            model,
          },
          parts: [
            {
              partId: "part_1",
              sessionId: "sess_1",
              messageId: "msg_1",
              type: "text",
              text: "hello",
            },
          ],
        },
      ],
    });

    expect(snapshot.settings.model.current.providerId).toBe("glm");
    expect(snapshot.session.titleSource).toBe("generated");
    expect(snapshot.projection.lastError).toEqual({
      type: "MODEL_ERROR",
      code: "provider_not_found",
      message: "Model provider is not configured: stale-provider",
      detail: "stale-provider/gpt-5.5",
      attribution: {
        source: "runtime",
        reason: "provider_not_configured",
        providerId: "account:zai-individual-coding-plan",
        retryable: false,
      },
    });
    expect(snapshot.runtime.stateRevision).toBe(3);
  });

  it("parses agent-owned session title update events", () => {
    const event = zcodeSessionEventSchema.parse({
      eventId: "evt_title_1",
      seq: 8,
      sessionId: "sess_1",
      timestamp: 9,
      traceId: "trace_title_1",
      type: "session.titleUpdated",
      payload: {
        previousTitle: "please fix the mobile login button",
        source: "generated",
        title: "Fix mobile login",
      },
    });

    expect(event.type).toBe("session.titleUpdated");
    expect(event.payload).toMatchObject({ title: "Fix mobile login" });
  });

  it("preserves attribution on legacy turn.failed events", () => {
    const event = zcodeSessionEventSchema.parse({
      eventId: "evt_failed_1",
      seq: 9,
      sessionId: "sess_1",
      timestamp: 10,
      type: "turn.failed",
      payload: {
        turnPhase: "model",
        error: {
          type: "MODEL_ERROR",
          code: "model_request_failed",
          message: "Model request failed.",
          attribution: {
            source: "provider",
            reason: "unknown",
            errorPhase: "response",
            exceptionKind: "api_call",
            providerId: "account:zai-start-plan",
            providerErrorCode: "3012",
            statusCode: 405,
          },
        },
      },
    });

    expect(event.payload.error.attribution).toEqual({
      source: "provider",
      reason: "unknown",
      errorPhase: "response",
      exceptionKind: "api_call",
      providerId: "account:zai-start-plan",
      providerErrorCode: "3012",
      statusCode: 405,
    });
  });

  it("rejects raw exception names from error attribution", () => {
    expect(() =>
      errorAttributionSchema.parse({
        errorPhase: "stream",
        exceptionKind: "SecretProviderNetworkError",
      }),
    ).toThrow();
  });

  it("accepts complete steer queue and drain facts emitted by the CLI", () => {
    const queued = zcodeSessionEventSchema.parse({
      eventId: "evt_steer_queued_1",
      seq: 9,
      sessionId: "sess_1",
      timestamp: 10,
      type: "turn.steerQueued",
      payload: {
        pendingInputId: "pending_1",
        inputId: "input_1",
        queryId: "query_1",
        input: "继续检查",
        inputPreview: "继续检查",
        inputSize: 4,
        delivery: "guide",
        intent: { delivery: "guide", sourceCommandId: "command_1" },
        toolDisallowlist: ["Write"],
        targetTurnId: "turn_1",
        queueLength: 1,
      },
    });
    const drained = zcodeSessionEventSchema.parse({
      eventId: "evt_steer_drained_1",
      seq: 10,
      sessionId: "sess_1",
      timestamp: 11,
      type: "turn.steerDrained",
      payload: {
        pendingInputIds: ["pending_1"],
        queryIds: ["query_1"],
        targetTurnId: "turn_1",
        injectedMessageIds: ["message_1"],
        drainedInputs: [
          {
            pendingInputId: "pending_1",
            messageId: "message_1",
            text: "继续检查",
            delivery: "guide",
            intent: { delivery: "guide", sourceCommandId: "command_1" },
            toolDisallowlist: ["Write"],
          },
        ],
      },
    });

    expect(queued.payload).toMatchObject({ delivery: "guide" });
    expect(drained.payload).toMatchObject({
      drainedInputs: [{ messageId: "message_1", delivery: "guide" }],
    });
  });

  it("parses typed session events for tool updates", () => {
    const event = zcodeSessionEventSchema.parse({
      eventId: "evt_tool_1",
      seq: 12,
      sessionId: "sess_1",
      timestamp: 13,
      type: "tool.updated",
      payload: {
        kind: "result",
        toolCallId: "tool_1",
        toolName: "Edit",
        duration: 42,
        result: {
          success: true,
          content: "done",
        },
      },
    });

    expect(event.type).toBe("tool.updated");
    expect(event.payload.kind).toBe("result");
  });

  it("strictly validates bounded Node REPL image display payloads", () => {
    const event = {
      eventId: "evt_tool_image_1",
      seq: 13,
      sessionId: "sess_1",
      timestamp: 14,
      type: "tool.updated",
      payload: {
        kind: "result",
        toolCallId: "tool_image_1",
        toolName: "mcp__node_repl__js",
        duration: 42,
        result: {
          success: true,
          content: "(no output)\n\n[Attached image/png: MCP image]",
          display: {
            kind: "node_repl_images",
            images: [{ base64: "AAAA", mimeType: "image/png" }],
            source: "browser_turn_end",
          },
        },
      },
    };

    expect(zcodeSessionEventSchema.parse(event).payload).toMatchObject({
      kind: "result",
      result: {
        display: { kind: "node_repl_images", source: "browser_turn_end" },
      },
    });
    expect(() =>
      zcodeSessionEventSchema.parse({
        ...event,
        payload: {
          ...event.payload,
          result: {
            ...event.payload.result,
            display: {
              ...event.payload.result.display,
              unbounded: true,
            },
          },
        },
      }),
    ).toThrow();
  });

  it("keeps browser turn-end image displays in strict v4 tool rows", () => {
    const row = conversationRowSchema.parse({
      rowId: 4,
      turnId: "turn-1",
      createdAt: 10,
      createdAtSeq: 4,
      kind: "toolCall",
      toolCallId: "tool-browser-turn-end",
      toolName: "mcp__node_repl__js",
      status: "success",
      inputText: "",
      display: {
        kind: "node_repl_images",
        source: "browser_turn_end",
        images: [{ base64: "AAAA", mimeType: "image/png" }],
      },
    });

    expect(row).toMatchObject({
      kind: "toolCall",
      display: { kind: "node_repl_images", source: "browser_turn_end" },
    });
  });

  it("keeps the official MCP unavailable code in strict v4 tool rows", () => {
    // 两个 strict schema（CLI contracts 的 display payload 与这里的 row）必须同步加字段，
    // 少加一处整条 row 会被拒，输入框提示就永远拿不到事实。
    const row = conversationRowSchema.parse({
      rowId: 5,
      turnId: "turn-1",
      createdAt: 10,
      createdAtSeq: 5,
      kind: "toolCall",
      toolCallId: "tool-official-mcp",
      toolName: "mcp__zcode-official__search_image",
      status: "success",
      inputText: "{}",
      display: {
        kind: "mcp_tool",
        serverName: "zcode-official",
        toolName: "search_image",
        unavailable: { code: "quota_exceeded" },
      },
    });

    expect(row).toMatchObject({
      display: { kind: "mcp_tool", unavailable: { code: "quota_exceeded" } },
    });
    // internal_error 不在 code 枚举里：它是服务端兜底掩码，不驱动界面提示。枚举外的值因此
    // **不会被携带**——display 不设门后 row 仍然有效，但这张卡没有载荷（§4.4.5）。
    const maskedRow = conversationRowSchema.parse({
      rowId: 6,
      turnId: "turn-1",
      createdAt: 10,
      createdAtSeq: 6,
      kind: "toolCall",
      toolCallId: "tool-official-mcp",
      toolName: "mcp__zcode-official__search_image",
      status: "success",
      inputText: "{}",
      display: {
        kind: "mcp_tool",
        serverName: "zcode-official",
        toolName: "search_image",
        unavailable: { code: "internal_error" },
      },
    });
    expect(maskedRow.kind === "toolCall" ? maskedRow.display : "unreachable").toBeUndefined();
  });

  it("strictly validates bounded CreateWorkflow display payloads", () => {
    const event = {
      eventId: "evt_tool_workflow_1",
      seq: 15,
      sessionId: "sess_1",
      timestamp: 16,
      type: "tool.updated",
      payload: {
        kind: "result",
        toolCallId: "tool_workflow_1",
        toolName: "CreateWorkflow",
        duration: 7,
        result: {
          success: false,
          content: "The workflow script has type errors:",
          display: {
            kind: "create_workflow",
            ok: false,
            errorCount: 1,
            diagnostics: [{ line: 3, column: 5, code: 2304, message: "Cannot find name 'agent'." }],
          },
        },
      },
    };

    expect(zcodeSessionEventSchema.parse(event).payload).toMatchObject({
      kind: "result",
      result: { display: { kind: "create_workflow", ok: false, errorCount: 1 } },
    });
    expect(() =>
      zcodeSessionEventSchema.parse({
        ...event,
        payload: {
          ...event.payload,
          result: {
            ...event.payload.result,
            display: { ...event.payload.result.display, unbounded: true },
          },
        },
      }),
    ).toThrow();
  });

  it("keeps bounded CreateWorkflow diagnostics displays in strict v4 tool rows", () => {
    const row = conversationRowSchema.parse({
      rowId: 6,
      turnId: "turn-1",
      createdAt: 12,
      createdAtSeq: 6,
      kind: "toolCall",
      toolCallId: "tool-create-workflow",
      toolName: "CreateWorkflow",
      status: "error",
      inputText: "",
      display: {
        kind: "create_workflow",
        ok: false,
        errorCount: 2,
        diagnostics: [
          { line: 3, column: 5, code: 2304, message: "Cannot find name 'agent'." },
          { line: 8, column: 1, code: 1005, message: "';' expected." },
        ],
        truncated: true,
      },
    });

    expect(row).toMatchObject({
      kind: "toolCall",
      display: { kind: "create_workflow", ok: false, errorCount: 2, truncated: true },
    });
  });

  it("accepts the bounded CreateWorkflow causality graph on both protocol boundaries", () => {
    const causalityGraph = {
      steps: [
        {
          id: "world-read#1",
          kind: "world-read",
          label: "glob *.ts",
          line: 1,
          column: 20,
          lane: "workspace",
        },
        {
          id: "ask#1",
          kind: "ask",
          label: "planner",
          line: 2,
          column: 24,
          lane: "actor#1",
          repeat: "serial",
        },
        {
          id: "ask#2",
          kind: "ask",
          label: "reviewer",
          // 插值名的静态形状：v3 镜像曾漏掉这两个 pattern 字段（0a8b059f40 只改了
          // contracts 与 v4），.strict() 之下整图验证失败——固定在这条双边界用例里。
          labelPattern: { head: "研究员", tail: "号" },
          line: 3,
          column: 24,
          lane: "actor#2",
          lanes: ["actor#2", "actor#3"],
          repeat: "stack",
        },
      ],
      lanes: [
        { id: "workspace" },
        { id: "actor#1", name: "planner", line: 2, column: 17 },
        { id: "actor#2", name: "reviewer", line: 3, column: 17 },
        { id: "actor#3", namePattern: { head: "研究员" }, line: 4, column: 17 },
      ],
      // 第二层是子代理导向（docs/dynamic-workflow/presentation.md）：每阶段一张参与者卡，
      // 无阶段词汇时 phase 恒为 `unphased`。字面量基数的家族每成员一张 `member` 卡，
      // 基数未知时一张 `many` 卡。同样钉在双边界用例里，防单边漏改。
      participants: [
        { id: "unphased:workspace", phase: "unphased", lane: "workspace", steps: ["world-read#1"] },
        { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#1"] },
        {
          id: "unphased:actor#2[0]",
          phase: "unphased",
          lane: "actor#2",
          steps: ["ask#2"],
          member: { index: 0, of: 2 },
        },
        {
          id: "unphased:actor#2[1]",
          phase: "unphased",
          lane: "actor#2",
          steps: ["ask#2"],
          member: { index: 1, of: 2 },
        },
        {
          id: "unphased:actor#3",
          phase: "unphased",
          lane: "actor#3",
          steps: ["ask#2"],
          many: true,
        },
      ],
      // 一种箭头：runs after；`back: true` 只标循环回边（single-arrow-contract spec）；
      // `types` 是跨越这条交接的产物类型（检视器素材，不上箭头）。
      handoffs: [
        { from: "unphased:workspace", to: "unphased:actor#1" },
        { from: "unphased:actor#1", to: "unphased:actor#2[0]", types: ["Plan"] },
        { from: "unphased:actor#1", to: "unphased:actor#2[1]", types: ["Plan"] },
        { from: "unphased:actor#2[0]", to: "unphased:actor#1", back: true },
      ],
      sink: ["ask#2"],
    };

    // Legacy protocol: result.display superRefine.
    const event = zcodeSessionEventSchema.parse({
      eventId: "evt_tool_workflow_graph",
      seq: 16,
      sessionId: "sess_1",
      timestamp: 17,
      type: "tool.updated",
      payload: {
        kind: "result",
        toolCallId: "tool_workflow_graph",
        toolName: "CreateWorkflow",
        duration: 7,
        result: {
          success: true,
          content: "The workflow script compiled cleanly.",
          display: {
            kind: "create_workflow",
            ok: true,
            errorCount: 0,
            diagnostics: [],
            causalityGraph,
          },
        },
      },
    });
    expect(event.payload).toMatchObject({
      kind: "result",
      result: { display: { kind: "create_workflow", ok: true, causalityGraph } },
    });

    // V4 rows: toolCallRow.display.
    const row = conversationRowSchema.parse({
      rowId: 7,
      turnId: "turn-1",
      createdAt: 13,
      createdAtSeq: 7,
      kind: "toolCall",
      toolCallId: "tool-create-workflow-graph",
      toolName: "CreateWorkflow",
      status: "success",
      inputText: "",
      display: {
        kind: "create_workflow",
        ok: true,
        errorCount: 0,
        diagnostics: [],
        causalityGraph,
      },
    });
    expect(row).toMatchObject({
      kind: "toolCall",
      display: { kind: "create_workflow", ok: true, causalityGraph },
    });
  });

  // 留白（docs/dynamic-workflow/authoring.md「Holes」）：`hole` 站点、step / 阶段上的 `fill`、图的
  // `holes[]` 与 FillWorkflowHole 行的顶层 `fill`。dwf-recursive 只改了 contracts 与 v4，v3 镜像在
  // .strict() 之下拒掉整条 tool.updated，桌面端的 v3 订阅便丢了那张卡——与上面 labelPattern 同一类。
  it("carries typed-hole fields through both the legacy event and v4 rows", () => {
    const causalityGraph = {
      steps: [
        { id: "ask#1", kind: "ask", label: "planner", lane: "actor#1", phase: "phase#1" },
        {
          id: "hole#1a2b3c4d",
          kind: "hole",
          label: "verdict",
          lane: "main",
          phase: "hole#1a2b3c4d",
        },
        {
          id: "ask#2",
          kind: "ask",
          label: "judge",
          lane: "actor#2",
          phase: "phase#2",
          fill: "hole#1a2b3c4d",
        },
      ],
      lanes: [
        { id: "actor#1", name: "planner" },
        { id: "actor#2", name: "judge" },
      ],
      participants: [
        { id: "phase#1:actor#1", phase: "phase#1", lane: "actor#1", steps: ["ask#1"] },
        { id: "phase#2:actor#2", phase: "phase#2", lane: "actor#2", steps: ["ask#2"] },
      ],
      handoffs: [{ from: "phase#1:actor#1", to: "phase#2:actor#2" }],
      phases: [
        { id: "phase#1", name: "plan" },
        { id: "hole#1a2b3c4d", name: "verdict" },
        { id: "phase#2", name: "judge", fill: "hole#1a2b3c4d" },
      ],
      phaseEdges: [
        { from: "phase#1", to: "hole#1a2b3c4d" },
        { from: "hole#1a2b3c4d", to: "phase#2" },
      ],
      holes: [
        {
          siteId: "hole#1a2b3c4d",
          name: "verdict",
          type: "Verdict",
          phase: "hole#1a2b3c4d",
          tail: true,
        },
      ],
      exits: ["phase#2"],
    };
    const display = {
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph,
      fill: { siteId: "hole#1a2b3c4d", name: "verdict", draftPath: "/tmp/fill.ts", line: 3 },
    };

    // Legacy protocol: result.display superRefine.
    const event = zcodeSessionEventSchema.parse({
      eventId: "evt_tool_workflow_holes",
      seq: 22,
      sessionId: "sess_1",
      timestamp: 23,
      type: "tool.updated",
      payload: {
        kind: "result",
        toolCallId: "tool_workflow_holes",
        toolName: "FillWorkflowHole",
        duration: 7,
        result: { success: true, content: "The hole is filled.", display },
      },
    });
    expect(event.payload).toMatchObject({ kind: "result", result: { display } });

    // V4 rows: toolCallRow.display.
    const row = conversationRowSchema.parse({
      rowId: 11,
      turnId: "turn-1",
      createdAt: 17,
      createdAtSeq: 11,
      kind: "toolCall",
      toolCallId: "tool-fill-workflow-hole",
      toolName: "FillWorkflowHole",
      status: "success",
      inputText: "",
      display,
    });
    expect(row).toMatchObject({ kind: "toolCall", display });
  });

  it("rejects an out-of-bounds CreateWorkflow causality graph in strict v4 tool rows", () => {
    const base = {
      rowId: 8,
      turnId: "turn-1",
      createdAt: 14,
      createdAtSeq: 8,
      kind: "toolCall",
      toolCallId: "tool-create-workflow-graph-bounds",
      toolName: "CreateWorkflow",
      status: "success",
      inputText: "",
    };
    const display = { kind: "create_workflow", ok: true, errorCount: 0, diagnostics: [] };
    const step = {
      id: "ask#1",
      kind: "ask",
      label: "a",
      lane: "actor#1",
    };
    const participant = {
      id: "unphased:actor#1",
      phase: "unphased",
      lane: "actor#1",
      steps: ["ask#1"],
    };
    const graph = {
      steps: [step],
      lanes: [{ id: "actor#1" }],
      participants: [participant],
      handoffs: [],
    };
    // v4 行上的 display 不设门（docs/v4-refactor/10-protocol-spec.md §4.4.5）：认不出来的载荷被
    // 丢掉、row 本身仍然有效，而不是把整帧拒掉。所以本 helper 断言的是「这份图被携带了」——被丢
    // 时主动抛错，好让下面每条 toThrow / not.toThrow 继续表达原来的意思。有界性没有放松：越界
    // 载荷同样到不了 UI，变的只是代价（拒整帧、连带打掉订阅 → 卡片退化成纯文本）。
    const parseWith = (causalityGraph: unknown) => {
      const row = conversationRowSchema.parse({ ...base, display: { ...display, causalityGraph } });
      if (row.kind !== "toolCall" || row.display === undefined) {
        throw new Error("v4 row dropped the create_workflow display");
      }
      return row.display;
    };

    expect(() => parseWith(graph)).not.toThrow();

    // 65 steps exceed the 64-step bound.
    expect(() =>
      parseWith({
        ...graph,
        steps: Array.from({ length: 65 }, (_, index) => ({ ...step, id: `ask#${index}` })),
      }),
    ).toThrow();

    // A 129-char label exceeds the label bound.
    expect(() => parseWith({ ...graph, steps: [{ ...step, label: "n".repeat(129) }] })).toThrow();

    // step 级 `edges` 与 `Lane.nesting` 已退出载荷（docs/dynamic-workflow/presentation.md）：
    // 空数组也是多出来的键。
    expect(() => parseWith({ ...graph, edges: [] })).toThrow();
    expect(() => parseWith({ ...graph, lanes: [{ id: "actor#1", nesting: 1 }] })).toThrow();

    // 参与者与交接必填——零参与者是空数组，不是缺席。
    const { participants: _p, ...noParticipants } = graph;
    const { handoffs: _h, ...noHandoffs } = graph;
    expect(() => parseWith(noParticipants)).toThrow();
    expect(() => parseWith(noHandoffs)).toThrow();

    // 65 participants exceed the 64-participant bound.
    expect(() =>
      parseWith({
        ...graph,
        participants: Array.from({ length: 65 }, (_, index) => ({
          ...participant,
          id: `unphased:actor#1[${index}]`,
          member: { index, of: 65 },
        })),
      }),
    ).toThrow();

    // 一张卡至少一个 step；member = {index ≥ 0, of ≥ 1} strict；many 只接受字面量 true。
    expect(() => parseWith({ ...graph, participants: [{ ...participant, steps: [] }] })).toThrow();
    expect(() =>
      parseWith({
        ...graph,
        participants: [{ ...participant, id: "unphased:actor#1[1]", member: { index: 1, of: 2 } }],
      }),
    ).not.toThrow();
    for (const member of [{ index: -1, of: 2 }, { index: 0, of: 0 }, { index: 0 }, { of: 2 }]) {
      expect(() => parseWith({ ...graph, participants: [{ ...participant, member }] })).toThrow();
    }
    expect(() =>
      parseWith({ ...graph, participants: [{ ...participant, many: false }] }),
    ).toThrow();

    // 交接边只有 {from, to, back?, types?}：分析器的 kind / certainty 不进展示载荷。
    const handoff = { from: "unphased:actor#1", to: "unphased:actor#1" };
    expect(() =>
      parseWith({
        ...graph,
        handoffs: [{ ...handoff, kind: "message", certainty: "always" }],
      }),
    ).toThrow();

    // 257 handoffs exceed the 256-handoff bound.
    expect(() =>
      parseWith({ ...graph, handoffs: Array.from({ length: 257 }, () => handoff) }),
    ).toThrow();

    // `types` 在场就是 1..8 个名字，每个 ≤ 128 字符。
    expect(() =>
      parseWith({ ...graph, handoffs: [{ ...handoff, types: ["Flaky"] }] }),
    ).not.toThrow();
    for (const types of [
      [],
      Array.from({ length: 9 }, (_, i) => `T${i}`),
      [""],
      ["t".repeat(129)],
    ]) {
      expect(() => parseWith({ ...graph, handoffs: [{ ...handoff, types }] })).toThrow();
    }

    // `back` 是字面量 true：false / 字符串都不是「没标回边」的另一种拼法。
    expect(() => parseWith({ ...graph, handoffs: [{ ...handoff, back: false }] })).toThrow();
  });

  it("accepts may-set lane-expansion copies with `source` on both protocol boundaries", () => {
    // may-set 车道展开：一个 ask 站点变成每候选车道一份拷贝，`source` 记下展开自的站点 id
    // （直播叠加的关联键）。字段是 additive 的，所以不带 source 的旧载荷照常验证。
    const copy = {
      id: "ask#2~actor#1",
      kind: "ask",
      label: "ask",
      line: 7,
      column: 58,
      lane: "actor#1",
      lanes: ["actor#1", "actor#2"],
      source: "ask#2",
      repeat: "serial",
    };
    const causalityGraph = {
      steps: [copy, { ...copy, id: "ask#2~actor#2", lane: "actor#2" }],
      lanes: [
        { id: "actor#1", name: "black" },
        { id: "actor#2", name: "white" },
      ],
      // 每条候选车道一张参与者卡，卡的 steps 指向该车道的拷贝 id。
      participants: [
        { id: "unphased:actor#1", phase: "unphased", lane: "actor#1", steps: ["ask#2~actor#1"] },
        { id: "unphased:actor#2", phase: "unphased", lane: "actor#2", steps: ["ask#2~actor#2"] },
      ],
      handoffs: [
        { from: "unphased:actor#1", to: "unphased:actor#2", back: true },
        { from: "unphased:actor#2", to: "unphased:actor#1", back: true },
      ],
      sink: ["ask#2~actor#1", "ask#2~actor#2"],
    };
    const display = {
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph,
    };

    // Legacy protocol: result.display superRefine.
    const event = zcodeSessionEventSchema.parse({
      eventId: "evt_tool_workflow_may_set",
      seq: 18,
      sessionId: "sess_1",
      timestamp: 19,
      type: "tool.updated",
      payload: {
        kind: "result",
        toolCallId: "tool_workflow_may_set",
        toolName: "CreateWorkflow",
        duration: 7,
        result: { success: true, content: "The workflow script compiled cleanly.", display },
      },
    });
    expect(event.payload).toMatchObject({
      kind: "result",
      result: { display: { causalityGraph } },
    });

    // V4 rows: toolCallRow.display.
    const base = {
      rowId: 9,
      turnId: "turn-1",
      createdAt: 15,
      createdAtSeq: 9,
      kind: "toolCall",
      toolCallId: "tool-create-workflow-may-set",
      toolName: "CreateWorkflow",
      status: "success",
      inputText: "",
    };
    expect(conversationRowSchema.parse({ ...base, display })).toMatchObject({
      display: { causalityGraph },
    });

    // 拷贝 id（`site~lane`）在 64 字符 id 上限内；source 走同一组上界。
    expect(copy.id.length).toBeLessThanOrEqual(64);
    // 65 字符的 source 越界，整份载荷因此不被携带（不设门 = 丢卡，不是拒帧；§4.4.5）。
    const overlongSourceRow = conversationRowSchema.parse({
      ...base,
      display: {
        ...display,
        causalityGraph: {
          steps: [{ ...copy, source: "s".repeat(65) }],
          lanes: causalityGraph.lanes,
          participants: [],
          handoffs: [],
        },
      },
    });
    expect(
      overlongSourceRow.kind === "toolCall" ? overlongSourceRow.display : "unreachable",
    ).toBeUndefined();
  });

  it("accepts the phase vocabulary on both protocol boundaries", () => {
    // docs/dynamic-workflow/presentation.md：phases / phaseEdges / exits / step.phase 是一套
    // 全有或全无的词汇表。四层 schema（contracts、tool-result-metadata、v4 rows、这份 v3
    // 镜像）必须逐字段对齐——任一层漏改，.strict() 之下带阶段的工作流会整图验证失败、图
    // 整块消失，正是 labelPattern/namePattern 在 0a8b059f40 上出过的事故。
    const causalityGraph = {
      steps: [
        {
          id: "world-read#1",
          kind: "world-read",
          label: "glob *.ts",
          lane: "workspace",
          // 首个标记之前的 step 落进保留的合成阶段。
          phase: "unphased",
        },
        {
          id: "ask#1",
          kind: "ask",
          label: "planner",
          lane: "actor#1",
          phase: "phase#1",
        },
        {
          // 跨阶段拷贝：共享 helper 的站点被两个阶段各认领一份，`source` 是运行时站点 id。
          id: "ask#2~phase#1",
          kind: "ask",
          label: "bench",
          lane: "actor#2",
          source: "ask#2",
          phase: "phase#1",
        },
        {
          id: "ask#2~phase#2",
          kind: "ask",
          label: "bench",
          lane: "actor#2",
          source: "ask#2",
          phase: "phase#2",
        },
      ],
      lanes: [
        { id: "workspace" },
        { id: "actor#1", name: "planner" },
        { id: "actor#2", name: "bench" },
      ],
      // 参与者按阶段分卡：同一子代理在两个阶段各是一张卡（id 以阶段为前缀）。
      participants: [
        { id: "unphased:workspace", phase: "unphased", lane: "workspace", steps: ["world-read#1"] },
        { id: "phase#1:actor#1", phase: "phase#1", lane: "actor#1", steps: ["ask#1"] },
        { id: "phase#1:actor#2", phase: "phase#1", lane: "actor#2", steps: ["ask#2~phase#1"] },
        { id: "phase#2:actor#2", phase: "phase#2", lane: "actor#2", steps: ["ask#2~phase#2"] },
      ],
      handoffs: [
        { from: "unphased:workspace", to: "phase#1:actor#1" },
        { from: "phase#1:actor#1", to: "phase#1:actor#2", types: ["Plan"] },
      ],
      phases: [
        // `unphased` 无 name（UI 本地化显示）；作者的阶段带原词与首个标记位置。
        { id: "unphased" },
        { id: "phase#1", name: "preflight", line: 1, column: 1 },
        { id: "phase#2", name: "gate", line: 9, column: 3 },
      ],
      // 阶段边与 step 边同形：{from, to, back?}。回边 phase#2 → phase#1 = 循环跨两个阶段。
      phaseEdges: [
        { from: "unphased", to: "phase#1" },
        { from: "phase#1", to: "phase#2" },
        { from: "phase#2", to: "phase#1", back: true },
      ],
      // 阶段流（docs/dynamic-workflow/presentation.md「Streams」）：channel 串起来的两个 future
      // 阶段，只有 {from, to}——不是 runs after，没有 back。
      phaseStreams: [{ from: "phase#1", to: "phase#2" }],
      // 控制流可在其后正常完成的阶段（阶段视图的「阶段 → 返回物」箭头）。
      exits: ["phase#2"],
      sink: ["ask#1"],
    };
    const display = {
      kind: "create_workflow",
      ok: true,
      errorCount: 0,
      diagnostics: [],
      causalityGraph,
    };

    // Legacy protocol: result.display superRefine.
    const event = zcodeSessionEventSchema.parse({
      eventId: "evt_tool_workflow_phases",
      seq: 20,
      sessionId: "sess_1",
      timestamp: 21,
      type: "tool.updated",
      payload: {
        kind: "result",
        toolCallId: "tool_workflow_phases",
        toolName: "CreateWorkflow",
        duration: 7,
        result: { success: true, content: "The workflow script compiled cleanly.", display },
      },
    });
    expect(event.payload).toMatchObject({
      kind: "result",
      result: { display: { causalityGraph } },
    });

    // V4 rows: toolCallRow.display.
    const base = {
      rowId: 10,
      turnId: "turn-1",
      createdAt: 16,
      createdAtSeq: 10,
      kind: "toolCall",
      toolCallId: "tool-create-workflow-phases",
      toolName: "CreateWorkflow",
      status: "success",
      inputText: "",
    };
    expect(conversationRowSchema.parse({ ...base, display })).toMatchObject({
      display: { causalityGraph },
    });

    // 两种展开叠加的 id（`ask#2~actor#1~phase#2`）仍在 64 字符上限内。
    expect("ask#2~actor#1~phase#2".length).toBeLessThanOrEqual(64);

    // v4 行上的 display 不设门（docs/v4-refactor/10-protocol-spec.md §4.4.5）：认不出来的载荷被
    // 丢掉、row 本身仍然有效，而不是把整帧拒掉。所以本 helper 断言的是「这份图被携带了」——被丢
    // 时主动抛错，好让下面每条 toThrow / not.toThrow 继续表达原来的意思。有界性没有放松：越界
    // 载荷同样到不了 UI，变的只是代价（拒整帧、连带打掉订阅 → 卡片退化成纯文本）。
    const parseWith = (graph: unknown) => {
      const row = conversationRowSchema.parse({
        ...base,
        display: { ...display, causalityGraph: graph },
      });
      if (row.kind !== "toolCall" || row.display === undefined) {
        throw new Error("v4 row dropped the create_workflow display");
      }
      return row.display;
    };

    // 有标记却零 step 的脚本产出**在场但空**的三个数组，handler 原样直通（不谎报
    // truncated）。UI 的视图切换是「在场且非空」，所以空词汇表必须在两条边界上都可表示——
    // 数组只有 .max() 上界，任何一层手滑加上 .min(1) 都会让那条直通路径整图验证失败。
    const emptyVocabulary = {
      steps: [],
      lanes: [],
      participants: [],
      handoffs: [],
      phases: [],
      phaseEdges: [],
      exits: [],
    };
    expect(() => parseWith(emptyVocabulary)).not.toThrow();
    expect(
      zcodeSessionEventSchema.parse({
        eventId: "evt_tool_workflow_phases_empty",
        seq: 21,
        sessionId: "sess_1",
        timestamp: 22,
        type: "tool.updated",
        payload: {
          kind: "result",
          toolCallId: "tool_workflow_phases_empty",
          toolName: "CreateWorkflow",
          duration: 7,
          result: {
            success: true,
            content: "ok",
            display: { ...display, causalityGraph: emptyVocabulary },
          },
        },
      }).payload,
    ).toMatchObject({ result: { display: { causalityGraph: emptyVocabulary } } });

    // 33 phases exceed the 32-phase bound; the handler degrades the whole vocabulary
    // before this boundary, so a payload this shape must be rejected outright.
    expect(() =>
      parseWith({
        ...causalityGraph,
        phases: Array.from({ length: 33 }, (_, index) => ({ id: `phase#${index + 1}` })),
      }),
    ).toThrow();

    // 129 phase edges exceed the 128-edge bound.
    expect(() =>
      parseWith({
        ...causalityGraph,
        phaseEdges: Array.from({ length: 129 }, () => ({ from: "phase#1", to: "phase#2" })),
      }),
    ).toThrow();

    // 129 phase streams exceed the same 128 bound; a stream carries no `back` and no kind.
    expect(() =>
      parseWith({
        ...causalityGraph,
        phaseStreams: Array.from({ length: 129 }, () => ({ from: "phase#1", to: "phase#2" })),
      }),
    ).toThrow();
    for (const stream of [
      { from: "phase#1", to: "phase#2", back: true },
      { from: "phase#1", to: "phase#2", kind: "data" },
    ]) {
      expect(() => parseWith({ ...causalityGraph, phaseStreams: [stream] })).toThrow();
    }

    // 33 exits exceed the 32-phase bound (exits 与阶段表同一上界).
    expect(() =>
      parseWith({
        ...causalityGraph,
        exits: Array.from({ length: 33 }, (_, index) => `phase#${index + 1}`),
      }),
    ).toThrow();

    // 阶段边与 step 边同形：分析器的 kind / certainty / exact 一个都不进载荷。
    expect(() =>
      parseWith({
        ...causalityGraph,
        phaseEdges: [
          { from: "phase#1", to: "phase#2", kind: "seq", certainty: "maybe", exact: true },
        ],
      }),
    ).toThrow();
  });

  it("gives the same verdict on the single-arrow shape on both protocol boundaries", () => {
    // docs/dynamic-workflow/presentation.md：硬断——旧形状（边带 kind /
    // certainty / exact，step 带 region / certainty，车道带 families，顶层带 regions）在
    // v3 / v4 两份镜像上**同时**被拒；新形状（{from, to, back?}、参与者 + 交接、exits）同时
    // 通过。docs/dynamic-workflow/presentation.md 又砍掉 step 级 `edges` 与 `Lane.nesting`，
    // 两者也在这里钉成同判。任一层漏改都会让同一份载荷在一条边界上通过、在另一条上整图消失。第三份
    // （contracts）不在本包依赖里，由 contracts 自己的 create-workflow.test.ts 用同一组
    // 样本钉住。
    const eventOf = (causalityGraph: unknown) => ({
      eventId: "evt_tool_workflow_single_arrow",
      seq: 22,
      sessionId: "sess_1",
      timestamp: 23,
      type: "tool.updated",
      payload: {
        kind: "result",
        toolCallId: "tool_workflow_single_arrow",
        toolName: "CreateWorkflow",
        duration: 7,
        result: {
          success: true,
          content: "ok",
          display: {
            kind: "create_workflow",
            ok: true,
            errorCount: 0,
            diagnostics: [],
            causalityGraph,
          },
        },
      },
    });
    const rowOf = (causalityGraph: unknown) => ({
      rowId: 11,
      turnId: "turn-1",
      createdAt: 17,
      createdAtSeq: 11,
      kind: "toolCall",
      toolCallId: "tool-create-workflow-single-arrow",
      toolName: "CreateWorkflow",
      status: "success",
      inputText: "",
      display: {
        kind: "create_workflow",
        ok: true,
        errorCount: 0,
        diagnostics: [],
        causalityGraph,
      },
    });
    // 第二个判定问的是「v4 行**携带了**这份图吗」，不是「row 解析成功吗」：display 不设门后，
    // 读不懂的载荷被丢而 row 仍然有效，按 success 问每个负例都会变成 true（§4.4.5）。
    const verdicts = (causalityGraph: unknown) => {
      const row = conversationRowSchema.safeParse(rowOf(causalityGraph));
      return [
        zcodeSessionEventSchema.safeParse(eventOf(causalityGraph)).success,
        row.success && row.data.kind === "toolCall" && row.data.display !== undefined,
      ];
    };

    const fresh = {
      steps: [
        { id: "ask#1", kind: "ask", label: "planner", lane: "actor#1", phase: "phase#1" },
        { id: "ask#2", kind: "ask", label: "reviewer", lane: "actor#2", phase: "phase#2" },
      ],
      lanes: [
        { id: "actor#1", name: "planner" },
        { id: "actor#2", name: "reviewer" },
      ],
      participants: [
        { id: "phase#1:actor#1", phase: "phase#1", lane: "actor#1", steps: ["ask#1"] },
        {
          id: "phase#2:actor#2[0]",
          phase: "phase#2",
          lane: "actor#2",
          steps: ["ask#2"],
          member: { index: 0, of: 2 },
        },
        {
          id: "phase#2:actor#2[1]",
          phase: "phase#2",
          lane: "actor#2",
          steps: ["ask#2"],
          member: { index: 1, of: 2 },
        },
      ],
      handoffs: [
        { from: "phase#1:actor#1", to: "phase#2:actor#2[0]", types: ["Plan"] },
        { from: "phase#1:actor#1", to: "phase#2:actor#2[1]", types: ["Plan"] },
        { from: "phase#2:actor#2[0]", to: "phase#1:actor#1", back: true },
      ],
      phases: [
        { id: "phase#1", name: "plan" },
        { id: "phase#2", name: "review" },
      ],
      phaseEdges: [
        { from: "phase#1", to: "phase#2" },
        { from: "phase#2", to: "phase#1", back: true },
      ],
      exits: ["phase#2"],
      sink: ["ask#2"],
    };
    expect(verdicts(fresh)).toEqual([true, true]);

    const legacy = {
      steps: [
        {
          id: "ask#1",
          kind: "ask",
          label: "planner",
          lane: "actor#1",
          region: "seq#1",
          certainty: "always",
        },
        {
          id: "ask#2",
          kind: "ask",
          label: "reviewer",
          lane: "actor#2",
          region: "loop#1",
          certainty: "maybe",
        },
      ],
      lanes: [
        { id: "actor#1", name: "planner" },
        { id: "actor#2", name: "reviewer", families: ["loop#1"] },
      ],
      regions: [
        { id: "seq#1", kind: "seq" },
        { id: "loop#1", kind: "loop", parent: "seq#1" },
      ],
      edges: [
        { from: "ask#1", to: "ask#2", kind: "data", certainty: "always", exact: true },
        { from: "ask#2", to: "ask#1", kind: "carry", certainty: "maybe" },
      ],
      sink: ["ask#2"],
    };
    expect(verdicts(legacy)).toEqual([false, false]);

    // 逐个旧字段也各自被拒——不是只有整包旧载荷才拒。
    const [freshStep] = fresh.steps;
    const [freshLane] = fresh.lanes;
    const [freshParticipant] = fresh.participants;
    const [freshHandoff] = fresh.handoffs;
    const { participants: _p, ...noParticipants } = fresh;
    const { handoffs: _h, ...noHandoffs } = fresh;
    for (const graph of [
      { ...fresh, steps: [{ ...freshStep, region: "seq#1" }, fresh.steps[1]] },
      { ...fresh, steps: [{ ...freshStep, certainty: "always" }, fresh.steps[1]] },
      { ...fresh, lanes: [{ ...freshLane, families: ["loop#1"] }, fresh.lanes[1]] },
      { ...fresh, lanes: [freshLane, { ...fresh.lanes[1], nesting: 2 }] },
      { ...fresh, regions: [] },
      // step 级 edges 整个字段都不在了。
      { ...fresh, edges: [] },
      { ...fresh, edges: [{ from: "ask#1", to: "ask#2" }] },
      // 参与者 / 交接必填、strict、有界。
      noParticipants,
      noHandoffs,
      {
        ...fresh,
        participants: [{ ...freshParticipant, steps: [] }, ...fresh.participants.slice(1)],
      },
      { ...fresh, participants: [{ ...freshParticipant, member: { index: -1, of: 2 } }] },
      { ...fresh, participants: [{ ...freshParticipant, member: { index: 0, of: 0 } }] },
      { ...fresh, participants: [{ ...freshParticipant, member: { index: 0 } }] },
      { ...fresh, participants: [{ ...freshParticipant, many: false }] },
      { ...fresh, participants: [{ ...freshParticipant, name: "planner" }] },
      { ...fresh, handoffs: [{ ...freshHandoff, kind: "data" }] },
      { ...fresh, handoffs: [{ ...freshHandoff, certainty: "always" }] },
      { ...fresh, handoffs: [{ ...freshHandoff, exact: true }] },
      { ...fresh, handoffs: [{ ...freshHandoff, back: false }] },
      { ...fresh, handoffs: [{ ...freshHandoff, types: [] }] },
      {
        ...fresh,
        handoffs: [{ ...freshHandoff, types: Array.from({ length: 9 }, (_, i) => `T${i}`) }],
      },
      { ...fresh, handoffs: [{ ...freshHandoff, types: ["t".repeat(129)] }] },
      { ...fresh, phaseEdges: [{ from: "phase#1", to: "phase#2", kind: "seq" }] },
      { ...fresh, phaseEdges: [{ from: "phase#1", to: "phase#2", back: "yes" }] },
      { ...fresh, phaseEdges: [{ from: "phase#1", to: "phase#2", types: ["Plan"] }] },
    ]) {
      expect(verdicts(graph)).toEqual([false, false]);
    }
    // 新字段的合法变体在两条边界上同时通过。
    for (const graph of [
      {
        ...fresh,
        participants: [{ ...freshParticipant, many: true }, ...fresh.participants.slice(1)],
      },
      {
        ...fresh,
        handoffs: [{ ...freshHandoff, types: Array.from({ length: 8 }, (_, i) => `T${i}`) }],
      },
      { ...fresh, participants: [], handoffs: [] },
    ]) {
      expect(verdicts(graph)).toEqual([true, true]);
    }
  });

  it("parses replayable session event batches", () => {
    const batch = zcodeSessionEventsResultSchema.parse({
      events: [
        {
          eventId: "evt_turn_1",
          seq: 1,
          sessionId: "sess_1",
          timestamp: 2,
          deliveryKind: "web-remote-replayable",
          type: "turn.started",
          payload: {
            inputId: "t-sess_1-run",
            input: "hello",
            turnNumber: 1,
          },
        },
      ],
    });

    expect(batch.events[0]?.deliveryKind).toBe("web-remote-replayable");
    expect(batch.events[0]?.payload).toMatchObject({ inputId: "t-sess_1-run" });
  });

  it.each([undefined, "desktop-continuous", "web-remote-replayable"])(
    "accepts the complete runtime turn.started payload (%s)",
    (deliveryKind) => {
      const event = zcodeSessionEventSchema.parse({
        eventId: "evt_turn_runtime",
        seq: 2,
        sessionId: "sess_1",
        turnId: "turn_1",
        timestamp: 3,
        deliveryKind,
        type: "turn.started",
        payload: {
          turnNumber: 2,
          executionStartedAt: 1789614547807.125,
          input: "hello",
          messageId: "msg_1",
          foregroundExecutionId: "foreground_1",
          backgroundSource: "subagent",
          intent: {
            sourceCommandId: "command_1",
            queueItemId: "queue_1",
            clientId: "bot",
            kind: "sendText",
          },
          originMeta: { source: "bot" },
          attachments: [{ name: "fixture.txt", mediaType: "text/plain" }],
        },
      });

      expect(event.payload).toMatchObject({
        executionStartedAt: 1789614547807.125,
        messageId: "msg_1",
        foregroundExecutionId: "foreground_1",
        backgroundSource: "subagent",
        intent: expect.objectContaining({ sourceCommandId: "command_1" }),
      });
    },
  );

  it("parses subagent message model-only inputs for replayable delivery", () => {
    const event = zcodeSessionEventSchema.parse({
      eventId: "evt_subagent_response",
      seq: 2,
      sessionId: "sess_1",
      timestamp: 3,
      deliveryKind: "web-remote-replayable",
      type: "turn.started",
      payload: {
        inputId: "turn_subagent_response",
        input: "<subagent-message>progress</subagent-message>",
        inputSource: "subagent_message",
        inputVisibility: "model-only",
        turnNumber: 2,
      },
    });

    expect(event.payload).toMatchObject({
      inputSource: "subagent_message",
      inputVisibility: "model-only",
    });
  });

  it("parses persisted model-only subagent messages across the app/agent boundary", () => {
    const message = zcodeUserMessageInfoSchema.parse({
      messageId: "msg_subagent_response",
      sessionId: "sess_1",
      role: "user",
      time: { created: 3 },
      agent: "zcode-agent",
      model,
      source: "subagent_message",
      visibility: "model-only",
    });

    expect(message.source).toBe("subagent_message");
  });

  it("parses strict workspace interaction preference updates", () => {
    expect(
      zcodeWorkspaceUpdateInteractionPreferencesParamsSchema.parse({
        workspace,
        preferences: {
          askUserQuestionAutoResolutionEnabled: false,
        },
      }),
    ).toEqual({
      workspace,
      preferences: {
        askUserQuestionAutoResolutionEnabled: false,
      },
    });
    expect(
      zcodeWorkspaceUpdateInteractionPreferencesResultSchema.parse({
        workspace,
        askUserQuestionAutoResolutionEnabled: false,
        snoozedInteractionCount: 2,
      }),
    ).toMatchObject({
      askUserQuestionAutoResolutionEnabled: false,
      snoozedInteractionCount: 2,
    });
    expect(() =>
      zcodeWorkspaceUpdateInteractionPreferencesParamsSchema.parse({
        workspace,
        preferences: {
          askUserQuestionAutoResolutionEnabled: false,
          ignored: true,
        },
      }),
    ).toThrow();
  });

  it("parses strict workspace ModelIO retention preference updates", () => {
    expect(
      zcodeWorkspaceUpdateModelIoPreferencesParamsSchema.parse({
        workspace,
        preferences: { fullRetentionEnabled: true },
      }),
    ).toEqual({
      workspace,
      preferences: { fullRetentionEnabled: true },
    });
    expect(
      zcodeWorkspaceUpdateModelIoPreferencesResultSchema.parse({
        workspace,
        fullRetentionEnabled: true,
        updatedSessionCount: 2,
      }),
    ).toMatchObject({
      fullRetentionEnabled: true,
      updatedSessionCount: 2,
    });
    expect(() =>
      zcodeWorkspaceUpdateModelIoPreferencesParamsSchema.parse({
        workspace,
        preferences: { fullRetentionEnabled: true, ignored: true },
      }),
    ).toThrow();
  });

  it("keeps runtime preference compatibility by defaulting missing fields", () => {
    expect(DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY).toBe("preflight-v1");
    expect(
      zcodeSessionRuntimePreferencesResultSchema.parse({
        nativeSearchEnhancementsEnabled: true,
      }),
    ).toMatchObject({
      askUserQuestionAutoResolutionEnabled: true,
      memoryEnabled: false,
      modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    });
    expect(
      zcodeSessionRuntimePreferencesResultSchema.parse({
        nativeSearchEnhancementsEnabled: true,
        askUserQuestionAutoResolutionEnabled: false,
        modelContextBudgetStrategy: "preflight-v1",
      }).askUserQuestionAutoResolutionEnabled,
    ).toBe(false);
    expect(() =>
      zcodeSessionRuntimePreferencesResultSchema.parse({
        nativeSearchEnhancementsEnabled: true,
        modelContextBudgetStrategy: "unknown",
      }),
    ).toThrow();
  });

  it("accepts turn.completed cache stats and history round count from runtime events", () => {
    const event = zcodeSessionEventSchema.parse({
      type: "turn.completed",
      eventId: "evt_1",
      sessionId: "sess_1",
      turnId: "turn_1",
      seq: 2,
      traceId: "trace_1",
      timestamp: Date.now(),
      deliveryKind: "desktop-continuous",
      payload: {
        response: "ok",
        tokenCount: 2,
        toolCallCount: 0,
        historyRoundCount: 3,
        duration: 123,
        resultType: "success",
        inputId: "run_1",
        cacheStats: {
          totalMessages: 4,
          cachedMessages: 2,
          lastCacheHit: true,
          cacheReadTokens: 128,
        },
      },
    });

    expect(event.payload.cacheStats).toMatchObject({
      cachedMessages: 2,
      lastCacheHit: true,
    });
    expect(event.payload.historyRoundCount).toBe(3);
  });

  it("parses state.updated notifications as the core state sync primitive", () => {
    const event = zcodeStateUpdatedNotificationSchema.parse({
      type: "state.updated",
      scope: "session",
      workspace,
      sessionId: "sess_1",
      revision: 4,
      reason: "model_changed",
      patch: {
        settings: {
          model: {
            current: model,
          },
        },
      },
    });

    expect(event.revision).toBe(4);
  });

  it("workspace presentation rejects model facts", () => {
    expect(() =>
      zcodeWorkspacePresentationSchema.parse({
        workspace,
        mode: "build",
        slashCommands: [],
        model,
      }),
    ).toThrow();
  });
});

describe("v4 workflowLaunch rows (direct-launch)", () => {
  const meta = {
    runId: "run-123",
    toolCallId: "launch-abc",
    name: "deep-research",
    scope: "global" as const,
    path: "/home/u/.zcode/workflows/deep-research.ts",
    args: { topic: "adaptive concurrency", depth: 2 },
    description: "Deep-dive a topic across the web and write a brief.",
  };

  it("parses a turnHeader row with origin workflowLaunch + meta", () => {
    const row = conversationRowSchema.parse({
      rowId: 1,
      turnId: "turn-1",
      createdAt: 10,
      createdAtSeq: 1,
      kind: "turnHeader",
      origin: "workflowLaunch",
      executionKind: "controlOnly",
      state: "running",
      startedAt: 10,
      workflowLaunch: meta,
    });
    expect(row).toMatchObject({
      kind: "turnHeader",
      origin: "workflowLaunch",
      workflowLaunch: meta,
    });
  });

  it("parses a userInput row with origin workflowLaunch + meta (text still carried)", () => {
    const row = conversationRowSchema.parse({
      rowId: 2,
      turnId: "turn-1",
      createdAt: 10,
      createdAtSeq: 2,
      kind: "userInput",
      text: 'Started the saved workflow "deep-research" (global) from the workflows hub as run run-123.',
      origin: "workflowLaunch",
      workflowLaunch: meta,
    });
    expect(row).toMatchObject({
      kind: "userInput",
      origin: "workflowLaunch",
      workflowLaunch: meta,
    });
  });

  it("rejects a description over the 500-char bound", () => {
    expect(
      workflowLaunchMetaSchema.safeParse({ ...meta, description: "x".repeat(501) }).success,
    ).toBe(false);
    expect(
      workflowLaunchMetaSchema.safeParse({ ...meta, description: "x".repeat(500) }).success,
    ).toBe(true);
  });

  it("rejects an args payload over the 4KB serialized bound", () => {
    const bigArgs = { blob: "x".repeat(5000) };
    expect(workflowLaunchMetaSchema.safeParse({ ...meta, args: bigArgs }).success).toBe(false);
  });

  it("rejects meta with missing runId or bad scope", () => {
    expect(workflowLaunchMetaSchema.safeParse({ ...meta, runId: "" }).success).toBe(false);
    expect(workflowLaunchMetaSchema.safeParse({ ...meta, scope: "team" }).success).toBe(false);
  });

  // 设置轮（docs/dynamic-workflow/launch.md「The settings turn」）：同一份元数据，没有保存文件可指，
  // 多一块 `amend` 说改了什么。
  it("parses a settings-turn meta: no scope or path, an amend block with from/to ends", () => {
    const settings = {
      runId: "run-b",
      toolCallId: "settings-abc",
      name: "deep-research",
      amend: {
        predecessorRunId: "run-a",
        subagentModel: { to: "zhipu/glm-5.3-flash" },
        maxConcurrency: { from: 13, to: 4 },
        ceiling: 13,
      },
    };
    expect(workflowLaunchMetaSchema.parse(settings)).toEqual(settings);
    // 无名 run 的设置轮不带名字（UI 换用兜底词，不拿 run id 当标题）。
    const { name: _name, ...unnamed } = settings;
    void _name;
    expect(workflowLaunchMetaSchema.parse(unnamed)).toEqual(unnamed);
    expect(
      workflowLaunchMetaSchema.safeParse({
        ...settings,
        amend: { ...settings.amend, maxConcurrency: { to: 0 } },
      }).success,
    ).toBe(false);
    expect(
      workflowLaunchMetaSchema.safeParse({ ...settings, amend: { predecessorRunId: "" } }).success,
    ).toBe(false);
  });

  // 就地生效的设置轮（docs/dynamic-workflow/concurrency.md）：只改并发上限、run 又在飞时没有前驱，
  // `predecessorRunId` 因此缺席——缺席本身就是「改的就是 runId 这一条」的信号（渲染端据它只出行）。
  it("parses an in-place retune's settings-turn meta: no predecessorRunId at all", () => {
    const retune = {
      runId: "run-a",
      toolCallId: "settings-xyz",
      name: "deep-research",
      amend: { maxConcurrency: { from: 13, to: 4 }, ceiling: 13 },
    };
    expect(workflowLaunchMetaSchema.parse(retune)).toEqual(retune);
    // 在场时仍要是一个真 run id：可选不等于可空、也不等于可空串。
    expect(
      workflowLaunchMetaSchema.safeParse({
        ...retune,
        amend: { ...retune.amend, predecessorRunId: null },
      }).success,
    ).toBe(false);
  });
});
