import { describe, expect, it } from "vitest";
import {
  COMMANDS_REQUIRING_BASE_REVISION,
  SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX,
  V4_WIRE_PROTOCOL_VERSION,
  WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX,
  commandAckSchema,
  commandPayloadSchemas,
  commandResultSchema,
  helloMessageSchema,
  parseCommandEnvelope,
  savedWorkflowStartRejectionReasonSchema,
  modelSelectionSchema,
  workflowRunSettingsRejectionReasonSchema,
} from "../src/zcode-protocol-v4/index.js";

describe("zcode-protocol-v4 command", () => {
  it("parses a valid sendText envelope with typed payload", () => {
    const result = parseCommandEnvelope({
      commandId: "018f0000-0000-7000-8000-000000000001",
      clientId: "client-1",
      sessionId: "s-1",
      type: "sendText",
      payload: { text: "帮我重构" },
      issuedAt: 1000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.type).toBe("sendText");
      expect(result.envelope.payload).toEqual({ text: "帮我重构" });
    }
  });

  it("keeps the submitted model selection and mode in the same sendText payload", () => {
    const modelSelection = modelSelectionSchema.parse({
      providerId: "deepseek",
      modelId: "deepseek-v4",
      options: { reasoningLevel: "high" },
    });
    const payload = commandPayloadSchemas.sendText.parse({
      text: "使用这次提交选择的模型",
      modelSelection,
      mode: "build",
    });

    expect(payload).toMatchObject({
      modelSelection,
      mode: "build",
    });
  });

  it("parses sendText turn-scoped tool disallowlist", () => {
    const payload = commandPayloadSchemas.sendText.parse({
      text: "继续当前定时任务会话",
      toolDisallowlist: ["CronCreate"],
    });
    expect(payload.toolDisallowlist).toEqual(["CronCreate"]);
  });

  it("parses strict Highspeed message metadata on sendText", () => {
    const highspeedMeta = {
      schemaVersion: 1 as const,
      cardId: "hsc-1",
      taskId: "task-1",
      provider: "zai",
      model: "glm-5",
      issuedAt: 1_000,
      expiresAt: 10_000,
    };

    expect(commandPayloadSchemas.sendText.parse({ text: "accelerate", highspeedMeta })).toEqual({
      text: "accelerate",
      highspeedMeta,
    });
    expect(() =>
      commandPayloadSchemas.sendText.parse({
        text: "invalid",
        highspeedMeta: { ...highspeedMeta, runtimeApiKey: "must-not-persist" },
      }),
    ).toThrow();
  });

  it("preserves strict shared-context references on sendText", () => {
    const payload = commandPayloadSchemas.sendText.parse({
      text: "请继续这个分享里的工作",
      context_refs: [{ kind: "shared_context_import", context_id: "context-1" }],
    });
    expect(payload.context_refs).toEqual([
      { kind: "shared_context_import", context_id: "context-1" },
    ]);
    expect(
      commandPayloadSchemas.sendText.safeParse({
        text: "invalid",
        context_refs: [{ kind: "shared_context_import", context_id: "" }],
      }).success,
    ).toBe(false);
    expect(
      commandPayloadSchemas.sendText.safeParse({
        text: "invalid",
        context_refs: [{ kind: "other", context_id: "context-1" }],
      }).success,
    ).toBe(false);
  });

  it("accepts the authoritative shared-context discard command", () => {
    expect(commandPayloadSchemas.discardSharedContext.parse({ contextId: "context-1" })).toEqual({
      contextId: "context-1",
    });
    expect(commandPayloadSchemas.discardSharedContext.safeParse({ contextId: "" }).success).toBe(
      false,
    );
  });

  it("parses a one-message start-now, queue or guide delivery override", () => {
    expect(
      commandPayloadSchemas.sendText.parse({
        text: "preempt current turn",
        requestedDelivery: "startNow",
      }),
    ).toEqual({ text: "preempt current turn", requestedDelivery: "startNow" });
    expect(
      commandPayloadSchemas.sendText.parse({
        text: "opposite follow-up",
        requestedDelivery: "guide",
      }),
    ).toEqual({ text: "opposite follow-up", requestedDelivery: "guide" });
    expect(
      commandPayloadSchemas.sendText.parse({
        text: "opposite follow-up",
        requestedDelivery: "queue",
      }),
    ).toEqual({ text: "opposite follow-up", requestedDelivery: "queue" });
  });

  it("validates bot delivery target on sendText", () => {
    const payload = commandPayloadSchemas.sendText.parse({
      text: "创建一个定时任务",
      botDeliveryTarget: {
        provider: "feishu",
        botId: "bot-feishu",
        providerUserId: "chat-1",
        chatType: "group",
      },
    });
    expect(payload.botDeliveryTarget).toEqual({
      provider: "feishu",
      botId: "bot-feishu",
      providerUserId: "chat-1",
      chatType: "group",
    });
    expect(
      commandPayloadSchemas.sendText.safeParse({
        text: "invalid",
        botDeliveryTarget: {
          provider: "telegram",
          botId: "bot-telegram",
          providerUserId: "chat-1",
          chatType: "private",
        },
      }).success,
    ).toBe(false);
    expect(
      commandPayloadSchemas.sendText.safeParse({
        text: "invalid",
        botDeliveryTarget: {
          provider: "weixin",
          botId: "bot-weixin",
          providerUserId: "chat-1",
          chatType: "private",
          providerMessageId: "must-not-persist",
        },
      }).success,
    ).toBe(false);
  });

  it("Off-Peak attribution is turn-scoped and mutually exclusive with automation", () => {
    expect(
      commandPayloadSchemas.sendText.parse({
        text: "resume",
        offPeakTaskId: "offpeak-1",
        offPeakRunType: "resume",
        toolDisallowlist: ["CronCreate"],
        futureAdditiveField: "ignored-by-current-cli",
      }),
    ).toEqual({
      text: "resume",
      offPeakTaskId: "offpeak-1",
      offPeakRunType: "resume",
      toolDisallowlist: ["CronCreate"],
    });
    expect(() =>
      commandPayloadSchemas.sendText.parse({
        text: "invalid",
        offPeakRunType: "init",
      }),
    ).toThrow();
    expect(() =>
      commandPayloadSchemas.sendText.parse({
        text: "invalid",
        automationId: "automation-1",
        offPeakTaskId: "offpeak-1",
      }),
    ).toThrow();
  });

  it("keeps execution-scoped model context narrow and drops the legacy runtime snapshot", () => {
    const payload = commandPayloadSchemas.sendText.parse({
      text: "run with an execution-scoped model",
      modelSelection: {
        providerId: "account:zai-offpeak-idle-plan",
        modelId: "GLM-5.2",
      },
      modelExecution: {
        memoryExtraction: "skip",
        selectionScope: "execution",
        requestAuth: {
          apiKey: "request-key",
          headers: { "X-Off-Peak-Ticket-ID": "ticket-1" },
        },
        subagents: {
          foregroundModel: "submission",
          background: "deny",
        },
      },
      turnRuntimeModel: {
        provider: { api: { baseUrl: "https://must-not-cross-the-wire.example" } },
      },
    });

    expect(payload).toEqual({
      text: "run with an execution-scoped model",
      modelSelection: {
        providerId: "account:zai-offpeak-idle-plan",
        modelId: "GLM-5.2",
      },
      modelExecution: {
        memoryExtraction: "skip",
        selectionScope: "execution",
        requestAuth: {
          apiKey: "request-key",
          headers: { "X-Off-Peak-Ticket-ID": "ticket-1" },
        },
        subagents: {
          foregroundModel: "submission",
          background: "deny",
        },
      },
    });
  });

  it("only accepts the explicit per-turn Memory Extraction skip policy", () => {
    expect(
      commandPayloadSchemas.sendText.parse({
        text: "do not extract this turn",
        modelSelection: { providerId: "offpeak", modelId: "model" },
        modelExecution: { memoryExtraction: "skip", selectionScope: "execution" },
      }),
    ).toMatchObject({ modelExecution: { memoryExtraction: "skip" } });
    expect(
      commandPayloadSchemas.sendText.safeParse({
        text: "invalid Memory policy",
        modelSelection: { providerId: "offpeak", modelId: "model" },
        modelExecution: { memoryExtraction: "disabled", selectionScope: "execution" },
      }).success,
    ).toBe(false);
  });

  it("rejects static provider facts inside model execution context", () => {
    expect(
      commandPayloadSchemas.sendText.safeParse({
        text: "invalid execution context",
        modelSelection: {
          providerId: "account:zai-offpeak-idle-plan",
          modelId: "GLM-5.2",
        },
        modelExecution: {
          selectionScope: "execution",
          endpoint: "https://must-not-cross-the-wire.example",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects payload that does not match the command type", () => {
    const result = parseCommandEnvelope({
      commandId: "cmd-1",
      clientId: "client-1",
      sessionId: "s-1",
      type: "forkAssistant",
      payload: { wrongField: true },
      issuedAt: 1000,
    });
    expect(result.ok).toBe(false);
  });

  it("hard-cuts row commands to wire v3 target identity and epoch CAS", () => {
    expect(V4_WIRE_PROTOCOL_VERSION).toBe(3);
    expect(
      helloMessageSchema.safeParse({
        kind: "hello",
        protocolVersion: 2,
        connectionId: "connection-1",
        clientMode: "desktop-continuous",
        deliveryProfile: "continuous",
        serverTime: 1000,
        capabilities: {
          nativeDialogs: true,
          localTerminal: true,
          binaryFrames: true,
          compression: "none",
        },
        auth: {},
      }).success,
    ).toBe(false);

    const valid = parseCommandEnvelope({
      commandId: "cmd-edit-v3",
      clientId: "client-1",
      sessionId: "s-1",
      baseRevision: 7,
      baseLogEpoch: "epoch-7",
      type: "editUserQuery",
      payload: {
        target: { rowId: 12, entityId: "message-user-12" },
        newText: "edited",
      },
      issuedAt: 1000,
    });
    expect(valid.ok).toBe(true);

    for (const invalid of [
      {
        commandId: "cmd-edit-old-row",
        clientId: "client-1",
        sessionId: "s-1",
        baseRevision: 7,
        baseLogEpoch: "epoch-7",
        type: "editUserQuery",
        payload: { targetRowId: 12, newText: "edited" },
        issuedAt: 1000,
      },
      {
        commandId: "cmd-edit-no-epoch",
        clientId: "client-1",
        sessionId: "s-1",
        baseRevision: 7,
        type: "editUserQuery",
        payload: {
          target: { rowId: 12, entityId: "message-user-12" },
          newText: "edited",
        },
        issuedAt: 1000,
      },
    ]) {
      expect(parseCommandEnvelope(invalid).ok).toBe(false);
    }
  });

  it.each(["editUserQuery", "sendQueuedNow"] as const)(
    "%s accepts a refreshed Highspeed execution model for an explicit rerun",
    (type) => {
      const target = { rowId: 12, entityId: "message-user-12" };
      const highspeedMeta = {
        schemaVersion: 1 as const,
        cardId: "hsc-edit",
        taskId: "s-1",
        provider: "builtin:bigmodel-coding-plan",
        model: "GLM-5.3",
        issuedAt: 1_000,
        expiresAt: 60_000,
      };
      // 显式重跑会重新抽卡，因此 Selection 与执行材料必须能整体刷新；加速轮永远是
      // execution 作用域，不允许改写 Session Selection。
      const modelSelection = {
        providerId: "account:bigmodel-highspeed-card",
        modelId: "GLM-5.3",
      };
      const modelExecution = {
        selectionScope: "execution" as const,
        requestAuth: {
          apiKey: "card-jwt",
          headers: { "X-Highspeed-Card-ID": "hsc-edit" },
        },
        selectionFallback: {
          providerId: "account:bigmodel-highspeed-card",
          rules: [
            { reason: "highspeed_card_expired" as const, providerErrorCode: "3402" },
            { reason: "highspeed_request_failed" as const },
          ],
          // 退回目标随声明下发：重跑时也必须带上当时的会话原模型，CLI 不再依赖运行态常驻选择。
          target: { providerId: "account:bigmodel-team-coding-plan", modelId: "GLM-5.3" },
        },
      };
      const result = parseCommandEnvelope({
        commandId: `cmd-${type}`,
        clientId: "client-1",
        sessionId: "s-1",
        baseRevision: 7,
        baseLogEpoch: "epoch-7",
        type,
        payload:
          type === "editUserQuery"
            ? { target, newText: "edited", highspeedMeta, modelSelection, modelExecution }
            : { queueItemId: "queue-1", highspeedMeta, modelSelection, modelExecution },
        issuedAt: 1_000,
      });

      expect(result).toMatchObject({
        ok: true,
        envelope: { payload: { highspeedMeta, modelSelection, modelExecution } },
      });
    },
  );

  it.each(["editUserQuery", "sendQueuedNow"] as const)(
    "%s rejects modelExecution without the Selection it constrains",
    (type) => {
      const result = parseCommandEnvelope({
        commandId: `cmd-${type}-orphan-execution`,
        clientId: "client-1",
        sessionId: "s-1",
        baseRevision: 7,
        baseLogEpoch: "epoch-7",
        type,
        payload:
          type === "editUserQuery"
            ? {
                target: { rowId: 12, entityId: "message-user-12" },
                newText: "edited",
                modelExecution: { selectionScope: "execution" as const },
              }
            : {
                queueItemId: "queue-1",
                modelExecution: { selectionScope: "execution" as const },
              },
        issuedAt: 1_000,
      });

      expect(result.ok).toBe(false);
    },
  );

  it("allows createSession without firstInput (draft session, 2026-07-05 ruling)", () => {
    const result = parseCommandEnvelope({
      commandId: "cmd-2",
      clientId: "client-1",
      sessionId: null,
      type: "createSession",
      payload: { workspaceId: "ws-1" },
      issuedAt: 1000,
    });
    expect(result.ok).toBe(true);
  });

  it("parses an atomic Submission in createSession.firstInput", () => {
    const result = parseCommandEnvelope({
      commandId: "cmd-create-submission",
      clientId: "client-1",
      sessionId: null,
      type: "createSession",
      payload: {
        workspaceId: "ws-1",
        firstInput: {
          text: "hello",
          modelSelection: {
            providerId: "provider-a",
            modelId: "model-a",
            options: { reasoningLevel: "high" },
          },
          mode: "plan",
        },
      },
      issuedAt: 1000,
    });
    expect(result.ok).toBe(true);
  });

  it("parses createSession MCP runtime configuration", () => {
    const result = parseCommandEnvelope({
      commandId: "cmd-create-mcp",
      clientId: "client-1",
      sessionId: null,
      type: "createSession",
      payload: {
        workspaceId: "ws-1",
        mcpServers: [
          {
            name: "docs",
            command: "node",
            args: ["server.js"],
            env: [{ name: "TOKEN", value: "secret-ref" }],
          },
        ],
      },
      issuedAt: 1000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.payload).toMatchObject({
        mcpServers: [{ name: "docs", command: "node" }],
      });
    }
  });

  it("preserves explicit side first input model selection and rejects malformed selection", () => {
    const command = {
      commandId: "side-model",
      clientId: "c",
      sessionId: "parent",
      type: "createSelectionSideSession",
      issuedAt: 1,
    };
    const modelSelection = {
      providerId: "account:bigmodel-start-plan",
      modelId: "glm-5",
      options: { reasoningLevel: "high" },
    };
    const result = parseCommandEnvelope({
      ...command,
      payload: { firstInput: { text: "hello", modelSelection } },
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.envelope.payload).toEqual({ firstInput: { text: "hello", modelSelection } });
    expect(
      parseCommandEnvelope({
        ...command,
        payload: { firstInput: { text: "hello", modelSelection: { providerId: "" } } },
      }).ok,
    ).toBe(false);
  });

  it("parses non-CAS createSelectionSideSession and its ACK result", () => {
    const result = parseCommandEnvelope({
      commandId: "cmd-selection-side-1",
      clientId: "client-1",
      sessionId: "parent-1",
      type: "createSelectionSideSession",
      payload: {},
      issuedAt: 1000,
    });
    expect(result.ok).toBe(true);
    expect(COMMANDS_REQUIRING_BASE_REVISION.has("createSelectionSideSession")).toBe(false);
    expect(
      commandAckSchema.parse({
        commandId: "cmd-selection-side-1",
        status: "accepted",
        revisionAtDecision: 7,
        result: {
          type: "createSelectionSideSession",
          sessionId: "child-1",
        },
      }).result,
    ).toEqual({ type: "createSelectionSideSession", sessionId: "child-1" });
  });

  it("keeps omitted createSession.config.mode absent so workspace default mode can win", () => {
    const result = parseCommandEnvelope({
      commandId: "cmd-create-config-no-mode",
      clientId: "client-1",
      sessionId: null,
      type: "createSession",
      payload: {
        workspaceId: "ws-1",
        config: {
          provider: "default-deepseek",
          model: "deepseek-v4-flash",
          thought: "max",
          followupMode: "queue",
        },
      },
      issuedAt: 1000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.envelope.payload).toEqual({
        workspaceId: "ws-1",
        config: {
          provider: "default-deepseek",
          model: "deepseek-v4-flash",
          thought: "max",
          followupMode: "queue",
        },
      });
    }
  });

  it("普通 create/switch 命令不再保留 Host runtimeModel", () => {
    const runtimeModel = {
      revision: "model-runtime:test",
      generatedAt: 1,
      model: { providerId: "legacy", modelId: "model" },
      provider: {
        providerId: "legacy",
        kind: "anthropic",
        apiFormat: "anthropic-messages",
        baseURL: "https://example.com",
        models: [{ modelId: "model" }],
      },
    };

    const create = commandPayloadSchemas.createSession.parse({
      workspaceId: "ws-1",
      runtimeModel,
    });
    const change = commandPayloadSchemas.switchModelConfig.parse({
      provider: "legacy",
      model: "model",
      thought: "high",
      runtimeModel,
    });

    expect("runtimeModel" in create).toBe(false);
    expect("runtimeModel" in change).toBe(false);
  });

  it("keeps legacy rewind absent while allowing workspace-only applyFileRewind", () => {
    expect("rewind" in commandPayloadSchemas).toBe(false);
    const result = parseCommandEnvelope({
      commandId: "cmd-file-rewind-1",
      clientId: "client-1",
      sessionId: "s-1",
      baseRevision: 7,
      baseLogEpoch: "epoch-7",
      type: "applyFileRewind",
      payload: { target: { rowId: 12, entityId: "turn-12" } },
      issuedAt: 1000,
    });
    expect(result.ok).toBe(true);
    expect(COMMANDS_REQUIRING_BASE_REVISION.has("applyFileRewind")).toBe(true);
  });

  it("has no forkOf on createSession (P5)", () => {
    expect(
      commandPayloadSchemas.createSession.safeParse({
        workspaceId: "ws-1",
        forkOf: "s-0",
      }).success,
      // zod object 默认 strip 未知键——这里断言的是类型层没有 forkOf 定义
    ).toBe(true);
    const parsed = commandPayloadSchemas.createSession.parse({
      workspaceId: "ws-1",
      forkOf: "s-0",
    });
    expect("forkOf" in parsed).toBe(false);
  });

  it("CAS command set matches the spec table", () => {
    expect([...COMMANDS_REQUIRING_BASE_REVISION].sort()).toEqual(
      [
        "deleteQueueItem",
        "editQueueItem",
        "editUserQuery",
        "applyFileRewind",
        "forkAssistant",
        "pauseGoal",
        "reorderQueueItem",
        "resumeGoal",
        "retryTurn",
        "sendQueuedNow",
        "setAssistantFeedback",
        "setAutoDrain",
        "setFollowupMode",
        "switchCollaborationMode",
        "switchModelConfig",
      ].sort(),
    );
    // stop 永不 stale：不在 CAS 集合
    expect(COMMANDS_REQUIRING_BASE_REVISION.has("compact")).toBe(false);
    expect(COMMANDS_REQUIRING_BASE_REVISION.has("stop")).toBe(false);
    expect(COMMANDS_REQUIRING_BASE_REVISION.has("resolveInteraction")).toBe(false);
    // 完成态统计是同一 user message 的幂等后台补写，不能被 Renderer revision 漂移丢弃。
    expect(COMMANDS_REQUIRING_BASE_REVISION.has("setHighspeedMetrics")).toBe(false);
  });

  it("parses persisted Highspeed completion metrics", () => {
    const parsed = parseCommandEnvelope({
      commandId: "cmd-highspeed-metrics",
      clientId: "desktop-1",
      sessionId: "s-1",
      baseLogEpoch: "epoch-1",
      type: "setHighspeedMetrics",
      payload: {
        target: { rowId: 8, entityId: "user-1" },
        regularTps: 73,
        outputTokens: 120_000,
        durationMs: 881_000,
        highspeedTps: 90,
        savedDurationMs: 762_836,
      },
      issuedAt: 1000,
    });
    expect(parsed.ok).toBe(true);
  });

  // M5 additive：switchCollaborationMode——值域 = core CollaborationMode 可切换子集。
  it("parses switchCollaborationMode and rejects out-of-catalog mode", () => {
    const ok = parseCommandEnvelope({
      commandId: "cmd-mode-1",
      clientId: "client-1",
      sessionId: "s-1",
      baseRevision: 3,
      baseLogEpoch: "epoch-3",
      type: "switchCollaborationMode",
      payload: { mode: "plan" },
      issuedAt: 1000,
    });
    expect(ok.ok).toBe(true);
    const bad = parseCommandEnvelope({
      commandId: "cmd-mode-2",
      clientId: "client-1",
      sessionId: "s-1",
      type: "switchCollaborationMode",
      // auto 非用户可切换模式，不进命令面
      payload: { mode: "auto" },
      issuedAt: 1000,
    });
    expect(bad.ok).toBe(false);
  });

  // M5 ③-2 additive：resolveInteraction answer 的 action/content——elicitation
  // 回执收敛（多题答案/注解无损）。黄金断言：旧形态（仅 optionId/freeText）继续合法。
  it("parses resolveInteraction with additive action/content and keeps legacy answers valid", () => {
    const legacy = parseCommandEnvelope({
      commandId: "cmd-ri-1",
      clientId: "client-1",
      sessionId: "s-1",
      type: "resolveInteraction",
      payload: { interactionId: "req-1", answer: { optionId: "allowOnce" } },
      issuedAt: 1000,
    });
    expect(legacy.ok).toBe(true);

    const extended = parseCommandEnvelope({
      commandId: "cmd-ri-2",
      clientId: "client-1",
      sessionId: "s-1",
      type: "resolveInteraction",
      payload: {
        interactionId: "req-2",
        answer: {
          action: "accept",
          content: { answers: { "要哪种？": "B" }, annotations: {} },
        },
      },
      issuedAt: 1000,
    });
    expect(extended.ok).toBe(true);
    if (extended.ok) {
      expect(extended.envelope.payload).toEqual({
        interactionId: "req-2",
        answer: {
          action: "accept",
          content: { answers: { "要哪种？": "B" }, annotations: {} },
        },
      });
    }

    const badAction = parseCommandEnvelope({
      commandId: "cmd-ri-3",
      clientId: "client-1",
      sessionId: "s-1",
      type: "resolveInteraction",
      payload: { interactionId: "req-3", answer: { action: "maybe" } },
      issuedAt: 1000,
    });
    expect(badAction.ok).toBe(false);
  });

  it("keeps the shared freeText answer shape backward compatible", () => {
    expect(
      commandPayloadSchemas.resolveInteraction.safeParse({
        interactionId: "permission-1",
        answer: { optionId: "deny", freeText: "请改用只读方案" },
      }).success,
    ).toBe(true);
    expect(
      commandPayloadSchemas.resolveInteraction.safeParse({
        interactionId: "user-input-2",
        answer: { freeText: "x".repeat(4097) },
      }).success,
    ).toBe(true);
  });

  it("parses dedicated Workspace Hook review/toggle/revoke commands and rejects malformed targets", () => {
    const target = {
      sessionId: "s-1",
      taskId: "task-1",
      runId: "run-1",
      workspaceIdentity: "workspace:1",
      bundleDigest: "a".repeat(64),
      reviewFlowId: "flow-1",
      generation: 1,
      interactionId: "interaction-1",
    };
    for (const [type, payload] of [
      [
        "respondWorkspaceHookReview",
        {
          ...target,
          decision: { action: "trust_selected", reviewItemIds: ["item-1"] },
        },
      ],
      ["toggleWorkspaceHookReviewItem", { ...target, reviewItemId: "item-1", enabled: false }],
      ["revokeWorkspaceHookTrust", { ...target, reviewItemIds: ["item-1"] }],
    ] as const) {
      expect(
        parseCommandEnvelope({
          commandId: `cmd-${type}`,
          clientId: "client-1",
          sessionId: "s-1",
          type,
          payload,
          issuedAt: 1000,
        }).ok,
      ).toBe(true);
    }
    expect(
      parseCommandEnvelope({
        commandId: "cmd-revoke-current",
        clientId: "client-1",
        sessionId: "s-1",
        type: "revokeWorkspaceHookTrust",
        payload: {
          sessionId: "s-1",
          workspaceIdentity: "workspace:1",
          bundleDigest: "a".repeat(64),
          hookDeclarationDigests: ["b".repeat(64)],
        },
        issuedAt: 1000,
      }).ok,
    ).toBe(true);
    expect(
      parseCommandEnvelope({
        commandId: "cmd-hook-bad",
        clientId: "client-1",
        sessionId: "s-1",
        type: "respondWorkspaceHookReview",
        payload: {
          ...target,
          bundleDigest: "not-a-digest",
          decision: { action: "trust_selected", reviewItemIds: ["item-1"] },
        },
        issuedAt: 1000,
      }).ok,
    ).toBe(false);
  });

  it("validates ack statuses including noop (R-09)", () => {
    const ack = commandAckSchema.parse({
      commandId: "cmd-3",
      status: "noop",
      reasonCode: "proto.alreadyResolved",
      revisionAtDecision: 42,
      result: {
        type: "resolveInteraction",
        resolvedBy: { clientId: "other-client", optionId: "allow" },
      },
    });
    expect(ack.status).toBe("noop");
  });

  it("validates restart input disposition for delivery-aware recovery", () => {
    const ack = commandAckSchema.parse({
      commandId: "cmd-discarded-queue",
      status: "failed",
      reasonCode: "fault.command.inputDiscardedOnRestart",
      revisionAtDecision: 42,
      result: { type: "inputDisposition", delivery: "queue" },
    });
    expect(ack.result).toEqual({ type: "inputDisposition", delivery: "queue" });
  });

  it("validates applyFileRewind ack result", () => {
    const ack = commandAckSchema.parse({
      commandId: "cmd-file-rewind-2",
      status: "accepted",
      revisionAtDecision: 8,
      result: {
        type: "applyFileRewind",
        applied: true,
        response: "Rewound 1 file from summary checkpoints.",
        preview: {
          canApply: true,
          safeFiles: [
            {
              path: "/work/src/demo.ts",
              action: "restore",
              operationCount: 1,
              toolNames: ["Write"],
            },
          ],
          unsafeFiles: [],
          ignoredFiles: [],
        },
      },
    });
    expect(ack.result?.type).toBe("applyFileRewind");
  });

  it("validates edit ACK disposition and destination session", () => {
    const rewind = commandAckSchema.parse({
      commandId: "cmd-edit-rewind",
      status: "accepted",
      revisionAtDecision: 8,
      result: {
        type: "editUserQuery",
        disposition: "rewind",
        sessionId: "s-1",
      },
    });
    const fork = commandAckSchema.parse({
      commandId: "cmd-edit-fork",
      status: "accepted",
      revisionAtDecision: 8,
      result: {
        type: "editUserQuery",
        disposition: "fork",
        sessionId: "s-child",
      },
    });
    expect(rewind.result).toEqual({
      type: "editUserQuery",
      disposition: "rewind",
      sessionId: "s-1",
    });
    expect(fork.result).toEqual({
      type: "editUserQuery",
      disposition: "fork",
      sessionId: "s-child",
    });
  });

  it("parses a startSavedWorkflow payload and rejects bad shapes", () => {
    // 直接启动命令：不携 baseRevision，与 cancel / resume 同类。
    expect(
      parseCommandEnvelope({
        commandId: "018f0000-0000-7000-8000-0000000000aa",
        clientId: "client-1",
        sessionId: "s-empty",
        type: "startSavedWorkflow",
        payload: { name: "deep-research", scope: "global", args: { topic: "x", depth: 2 } },
        issuedAt: 1000,
      }).ok,
    ).toBe(true);
    // scope 可选：项目档缺省不传。
    expect(commandPayloadSchemas.startSavedWorkflow.parse({ name: "cleanup" })).toEqual({
      name: "cleanup",
    });
    // 空名字被拒（invalid_name 属于运行时诊断，但 schema 先挡空串）。
    expect(commandPayloadSchemas.startSavedWorkflow.safeParse({ name: "" }).success).toBe(false);
    // scope 只认 project / global。
    expect(
      commandPayloadSchemas.startSavedWorkflow.safeParse({ name: "x", scope: "team" }).success,
    ).toBe(false);
  });

  it("parses the startSavedWorkflow accepted result branch", () => {
    const ack = commandAckSchema.parse({
      commandId: "cmd-start-saved",
      status: "accepted",
      revisionAtDecision: 0,
      result: {
        type: "startSavedWorkflow",
        runId: "run-123",
        toolCallId: "launch-abc",
      },
    });
    expect(ack.result).toEqual({
      type: "startSavedWorkflow",
      runId: "run-123",
      toolCallId: "launch-abc",
    });
    // runId / toolCallId 必带且非空。
    expect(
      commandResultSchema.safeParse({ type: "startSavedWorkflow", runId: "", toolCallId: "x" })
        .success,
    ).toBe(false);
  });

  it("exposes the saved-workflow rejection vocabulary and fault prefix", () => {
    expect(SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX).toBe(
      "fault.command.savedWorkflowStartRejected.",
    );
    expect(savedWorkflowStartRejectionReasonSchema.options).toEqual([
      "invalid_name",
      "not_found",
      "invalid_args",
      "compile_failed",
      "session_busy",
      "start_failed",
    ]);
    // 前缀 + reason 拼成完整 fault code；bootstrap 铸造、ui 前缀匹配。
    expect(`${SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX}not_found`).toBe(
      "fault.command.savedWorkflowStartRejected.not_found",
    );
  });

  // 「配置」弹层的命令（docs/dynamic-workflow/launch.md「Changing a run's settings from the GUI」）。
  it("parses amendWorkflowRunSettings payloads with the omit / null / value tri-state", () => {
    const schema = commandPayloadSchemas.amendWorkflowRunSettings;
    // 不携 baseRevision，与 cancel / resume 同类。
    expect(
      parseCommandEnvelope({
        commandId: "018f0000-0000-7000-8000-0000000000ab",
        clientId: "client-1",
        sessionId: "s-1",
        type: "amendWorkflowRunSettings",
        payload: { workId: "run-a", subagentModel: "zhipu/glm-5.3-flash$high", maxConcurrency: 4 },
        issuedAt: 1000,
      }).ok,
    ).toBe(true);
    expect(schema.parse({ workId: "run-a" })).toEqual({ workId: "run-a" });
    expect(schema.parse({ workId: "run-a", subagentModel: null, maxConcurrency: null })).toEqual({
      workId: "run-a",
      subagentModel: null,
      maxConcurrency: null,
    });
    expect(schema.safeParse({ workId: "run-a", maxConcurrency: 0 }).success).toBe(false);
    expect(schema.safeParse({ workId: "run-a", maxConcurrency: 2.5 }).success).toBe(false);
    expect(schema.safeParse({ workId: "run-a", subagentModel: "" }).success).toBe(false);
  });

  it("parses the amendWorkflowRunSettings accepted result and exposes its rejection vocabulary", () => {
    const ack = commandAckSchema.parse({
      commandId: "cmd-settings",
      status: "accepted",
      revisionAtDecision: 0,
      result: {
        type: "amendWorkflowRunSettings",
        runId: "run-b",
        toolCallId: "settings-abc",
        supersededRunId: "run-a",
      },
    });
    expect(ack.result).toEqual({
      type: "amendWorkflowRunSettings",
      runId: "run-b",
      toolCallId: "settings-abc",
      supersededRunId: "run-a",
    });
    expect(
      commandResultSchema.safeParse({
        type: "amendWorkflowRunSettings",
        runId: "run-b",
        toolCallId: "",
      }).success,
    ).toBe(false);
    expect(workflowRunSettingsRejectionReasonSchema.options).toEqual([
      "not_found",
      "not_configurable",
      "unchanged",
      "script_missing",
      "model_unavailable",
      "compile_failed",
      "missing_boundaries",
      "start_failed",
    ]);
    expect(`${WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX}unchanged`).toBe(
      "fault.command.workflowRunSettingsRejected.unchanged",
    );
  });
});
