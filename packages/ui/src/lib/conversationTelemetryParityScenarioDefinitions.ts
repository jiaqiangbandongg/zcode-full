import { requestSecurityMessagesEnUS } from "@/request-security-edition/messages.js";
/* eslint-disable max-lines -- 19 个差分 case 的受控输入必须集中保存，避免新旧驱动各自复制后悄悄漂移。 */

export type ParityModelStatus =
  | "model_request_started"
  | "model_request_completed"
  | "model_request_failed"
  | "model_retry_scheduled"
  | "model_stream_stalled";

export interface ParitySeed {
  sessionId: string;
  commandId: string;
  now: number;
  scope?: string;
  askMode?: string;
  modelName?: string;
  modelProvider?: string;
  providerHostname?: string;
}

export type ConversationTelemetryParityOperation =
  | { kind: "focus"; now: number; scope?: string }
  | { kind: "text"; now: number; value: string; scope?: string }
  | ({ kind: "seed"; duplicate?: boolean } & ParitySeed)
  | {
      kind: "foreground.attach";
      sessionId: string;
      owner: string;
      scope?: string;
    }
  | { kind: "foreground.detach"; owner: string; scope?: string }
  | {
      kind: "turn.started";
      now: number;
      eventId: string;
      sessionId: string;
      commandId: string;
      turnId: string;
      scope?: string;
    }
  | {
      kind: "model.status";
      now: number;
      eventId: string;
      sessionId: string;
      commandId?: string;
      turnId?: string;
      requestId: string;
      status: ParityModelStatus;
      providerId: string;
      modelId: string;
      providerHostname?: string;
      durationMs?: number;
      reason?: string;
      retryable?: boolean;
      statusCode?: number;
      delayMs?: number;
      nextAttempt?: number;
      idleMs?: number;
      timeoutMs?: number;
      scope?: string;
    }
  | {
      kind: "chunk";
      now: number;
      eventId: string;
      sessionId: string;
      commandId: string;
      turnId: string;
      channel: "thought" | "text";
      firstChunk: boolean;
      parentToolCallId?: string;
      scope?: string;
    }
  | {
      kind: "permission";
      now: number;
      eventId: string;
      sessionId: string;
      commandId: string;
      turnId: string;
      phase: "requested" | "resolved" | "denied";
      requestId: string;
      toolCallId: string;
      decision?: "allow" | "deny" | "escalate" | "modify";
      scope?: string;
    }
  | {
      kind: "tool";
      now: number;
      eventId: string;
      sessionId: string;
      commandId: string;
      turnId: string;
      phase: "scheduled" | "started" | "progress" | "completed" | "failed";
      toolCallId: string;
      toolName: string;
      errorCode?: string;
      errorMessage?: string;
      parentToolCallId?: string;
      performance?: {
        totalMs?: number;
        permissionWaitMs?: number;
        commandRunMs?: number;
        exitCode?: number;
        timedOut?: boolean;
        outputBytes?: number;
        commandCategory?: string;
        commandName?: string;
        commandCount?: number;
        commandStatus?:
          | "completed"
          | "failed"
          | "timed_out"
          | "cancelled"
          | "spawn_error"
          | "backgrounded";
        commandHash?: string;
        workspaceKind?: "local" | "remote" | "unknown";
      };
      scope?: string;
    }
  | {
      kind: "usage";
      now: number;
      eventId: string;
      sessionId: string;
      commandId: string;
      turnId: string;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      scope?: string;
    }
  | {
      kind: "terminal";
      now: number;
      eventId: string;
      sessionId: string;
      commandId: string;
      turnId: string;
      status: "success" | "failed" | "interrupted";
      errorCode?: string;
      errorMessage?: string;
      duplicate?: boolean;
      scope?: string;
    }
  | {
      kind: "compaction";
      now: number;
      eventId: string;
      sessionId: string;
      operationId: string;
      status: "completed" | "failed" | "interrupted";
      trigger: "manual" | "auto" | "partial" | "reactive" | "session_memory";
      summaryMessageId?: string;
      reason?: string;
      compactReason?: string;
      modelName?: string;
      modelProvider?: string;
      startedAt?: number;
      endedAt?: number;
      preCompactTokenCount?: number;
      postCompactTokenCount?: number;
      truePostCompactTokenCount?: number;
      duplicate?: boolean;
      scope?: string;
    }
  | {
      kind: "visible.error";
      errorKey: string;
      displayMessage: string;
      code: string;
      traceId: string;
      sessionId: string;
      detail?: string;
      duplicate?: boolean;
      suppressed?: boolean;
      scope?: string;
    }
  | {
      kind: "feedback";
      sessionId: string;
      messageId: string;
      reaction: "like" | "dislike" | "none";
      scope?: string;
    }
  | { kind: "quota.assert" }
  | { kind: "verification.assert" }
  | { kind: "scope.dispose"; scope?: string }
  | { kind: "web.noop"; operations: ConversationTelemetryParityOperation[] };

export interface ConversationTelemetryParityScenario {
  caseId: string;
  operations: ConversationTelemetryParityOperation[];
  minimumReportInventory: Record<string, number>;
  minimumArmsInventory: Record<string, number>;
  proof: string[];
}

const seedDetail = {
  askMode: "build",
  modelName: "glm-model",
  modelProvider: "glm",
  providerHostname: "api.example.com",
} as const;

function id(caseId: string, suffix: string): string {
  return `${caseId.toLowerCase()}-${suffix}`;
}

function successfulTextTurn(input: {
  caseId: string;
  sessionId?: string;
  commandId?: string;
  scope?: string;
  sendAt?: number;
  chunkAt?: number;
  terminalAt?: number;
  includeNetwork?: boolean;
}): ConversationTelemetryParityOperation[] {
  const sessionId = input.sessionId ?? id(input.caseId, "session");
  const commandId = input.commandId ?? id(input.caseId, "command");
  const turnId = id(input.caseId, "turn");
  const sendAt = input.sendAt ?? 100;
  const chunkAt = input.chunkAt ?? 200;
  const terminalAt = input.terminalAt ?? 300;
  const scope = input.scope;
  return [
    {
      kind: "foreground.attach",
      sessionId,
      owner: id(input.caseId, "owner"),
      scope,
    },
    { kind: "focus", now: sendAt - 20, scope },
    { kind: "text", now: sendAt - 10, value: "x", scope },
    { kind: "seed", sessionId, commandId, now: sendAt, ...seedDetail, scope },
    {
      kind: "turn.started",
      now: sendAt + 5,
      eventId: id(input.caseId, "started"),
      sessionId,
      commandId,
      turnId,
      scope,
    },
    ...(input.includeNetwork === false
      ? []
      : ([
          {
            kind: "model.status",
            now: sendAt + 10,
            eventId: id(input.caseId, "request-started"),
            sessionId,
            commandId,
            turnId,
            requestId: id(input.caseId, "request"),
            status: "model_request_started",
            providerId: "glm",
            modelId: "glm-model",
            providerHostname: "api.example.com",
            scope,
          },
        ] satisfies ConversationTelemetryParityOperation[])),
    {
      kind: "chunk",
      now: chunkAt,
      eventId: id(input.caseId, "chunk"),
      sessionId,
      commandId,
      turnId,
      channel: "text",
      firstChunk: true,
      scope,
    },
    {
      kind: "usage",
      now: terminalAt - 10,
      eventId: id(input.caseId, "usage"),
      sessionId,
      commandId,
      turnId,
      inputTokens: 10,
      outputTokens: 5,
      scope,
    },
    ...(input.includeNetwork === false
      ? []
      : ([
          {
            kind: "model.status",
            now: terminalAt - 5,
            eventId: id(input.caseId, "request-completed"),
            sessionId,
            commandId,
            turnId,
            requestId: id(input.caseId, "request"),
            status: "model_request_completed",
            providerId: "glm",
            modelId: "glm-model",
            providerHostname: "api.example.com",
            durationMs: terminalAt - sendAt - 15,
            scope,
          },
        ] satisfies ConversationTelemetryParityOperation[])),
    {
      kind: "terminal",
      now: terminalAt,
      eventId: id(input.caseId, "terminal"),
      sessionId,
      commandId,
      turnId,
      status: "success",
      scope,
    },
  ];
}

function scenario(
  caseId: string,
  operations: ConversationTelemetryParityOperation[],
  report: Record<string, number>,
  arms: Record<string, number>,
  proof: string[],
): ConversationTelemetryParityScenario {
  return {
    caseId,
    operations,
    minimumReportInventory: report,
    minimumArmsInventory: arms,
    proof,
  };
}

function buildScenarios(): ConversationTelemetryParityScenario[] {
  const tdp01 = successfulTextTurn({ caseId: "TDP01" });
  const tdp02 = [
    ...successfulTextTurn({ caseId: "TDP02A", sessionId: "tdp02-session" }),
    ...successfulTextTurn({
      caseId: "TDP02B",
      sessionId: "tdp02-session",
      sendAt: 400,
      chunkAt: 500,
      terminalAt: 600,
    }),
  ];

  const tdp03First = successfulTextTurn({
    caseId: "TDP03A",
    sessionId: "tdp03-session",
    commandId: "tdp03-command-1",
    terminalAt: 500,
  });
  const tdp03Second = successfulTextTurn({
    caseId: "TDP03B",
    sessionId: "tdp03-session",
    commandId: "tdp03-command-2",
    sendAt: 150,
    chunkAt: 600,
    terminalAt: 700,
  });
  // 第二轮 seed 在第一轮 terminal 前接纳；promotion 时重复 seed 必须被去重。
  const tdp03 = [
    ...tdp03First.slice(0, 7),
    ...tdp03Second.slice(0, 4),
    ...tdp03First.slice(7),
    {
      kind: "seed",
      sessionId: "tdp03-session",
      commandId: "tdp03-command-2",
      now: 550,
      duplicate: true,
      ...seedDetail,
    } satisfies ConversationTelemetryParityOperation,
    ...tdp03Second.slice(4),
  ];

  const tdp05: ConversationTelemetryParityOperation[] = [];
  for (const [index, withUsage] of [true, false].entries()) {
    const suffix = String(index + 1);
    const sessionId = `tdp05-session-${suffix}`;
    const commandId = `tdp05-command-${suffix}`;
    const turnId = `tdp05-turn-${suffix}`;
    tdp05.push(
      { kind: "foreground.attach", sessionId, owner: `tdp05-owner-${suffix}` },
      {
        kind: "seed",
        sessionId,
        commandId,
        now: 100 + index * 400,
        ...seedDetail,
      },
      {
        kind: "turn.started",
        now: 110 + index * 400,
        eventId: `tdp05-start-${suffix}`,
        sessionId,
        commandId,
        turnId,
      },
      {
        kind: "model.status",
        now: 120 + index * 400,
        eventId: `tdp05-request-start-${suffix}`,
        sessionId,
        commandId,
        turnId,
        requestId: `tdp05-request-${suffix}`,
        status: "model_request_started",
        providerId: "glm",
        modelId: "glm-model",
      },
      {
        kind: "chunk",
        now: 150 + index * 400,
        eventId: `tdp05-chunk-${suffix}`,
        sessionId,
        commandId,
        turnId,
        channel: "text",
        firstChunk: true,
      },
      ...(withUsage
        ? ([
            {
              kind: "usage",
              now: 170,
              eventId: "tdp05-usage-1",
              sessionId,
              commandId,
              turnId,
              inputTokens: 9,
              outputTokens: 3,
            },
          ] satisfies ConversationTelemetryParityOperation[])
        : []),
      {
        kind: "model.status",
        now: 180 + index * 400,
        eventId: `tdp05-request-fail-${suffix}`,
        sessionId,
        commandId,
        turnId,
        requestId: `tdp05-request-${suffix}`,
        status: "model_request_failed",
        providerId: "glm",
        modelId: "glm-model",
        reason: index === 0 ? "provider failed" : "",
        statusCode: 500,
      },
      {
        kind: "terminal",
        now: 200 + index * 400,
        eventId: `tdp05-terminal-${suffix}`,
        sessionId,
        commandId,
        turnId,
        status: "failed",
        errorCode: index === 0 ? "PROVIDER_ERROR" : undefined,
        errorMessage: index === 0 ? "provider failed" : undefined,
      },
    );
  }

  const tdp06 = [
    ...successfulTextTurn({ caseId: "TDP06A", includeNetwork: false }).map((operation) =>
      operation.kind === "terminal"
        ? {
            ...operation,
            status: "interrupted" as const,
            errorCode: "USER_INTERRUPT",
          }
        : operation,
    ),
    {
      kind: "foreground.attach",
      sessionId: "tdp06-no-terminal",
      owner: "tdp06-owner-2",
    },
    {
      kind: "seed",
      sessionId: "tdp06-no-terminal",
      commandId: "tdp06-no-terminal-command",
      now: 500,
      ...seedDetail,
    },
    {
      kind: "turn.started",
      now: 510,
      eventId: "tdp06-no-terminal-start",
      sessionId: "tdp06-no-terminal",
      commandId: "tdp06-no-terminal-command",
      turnId: "tdp06-no-terminal-turn",
    },
  ] satisfies ConversationTelemetryParityOperation[];

  const tdp07 = successfulTextTurn({ caseId: "TDP07", includeNetwork: false });
  const tdp07ChunkIndex = tdp07.findIndex((operation) => operation.kind === "chunk");
  tdp07.splice(tdp07ChunkIndex, 0, {
    kind: "chunk",
    now: 150,
    eventId: "tdp07-thought",
    sessionId: "tdp07-session",
    commandId: "tdp07-command",
    turnId: "tdp07-turn",
    channel: "thought",
    firstChunk: true,
  });

  const tdp08: ConversationTelemetryParityOperation[] = [];
  const toolVariants = ["success", "failed", "permission", "parented"] as const;
  toolVariants.forEach((variant, index) => {
    const sessionId = `tdp08-${variant}-session`;
    const commandId = `tdp08-${variant}-command`;
    const turnId = `tdp08-${variant}-turn`;
    const base = 100 + index * 500;
    tdp08.push(
      { kind: "foreground.attach", sessionId, owner: `tdp08-${variant}-owner` },
      { kind: "seed", sessionId, commandId, now: base, ...seedDetail },
      {
        kind: "turn.started",
        now: base + 10,
        eventId: `tdp08-${variant}-start`,
        sessionId,
        commandId,
        turnId,
      },
    );
    if (variant === "parented") {
      tdp08.push(
        {
          kind: "chunk",
          now: base + 30,
          eventId: "tdp08-parented-thought",
          sessionId,
          commandId,
          turnId,
          channel: "thought",
          firstChunk: true,
          parentToolCallId: "parent-agent",
        },
        {
          kind: "chunk",
          now: base + 40,
          eventId: "tdp08-parented-text",
          sessionId,
          commandId,
          turnId,
          channel: "text",
          firstChunk: false,
          parentToolCallId: "parent-agent",
        },
        {
          kind: "chunk",
          now: base + 60,
          eventId: "tdp08-main-text",
          sessionId,
          commandId,
          turnId,
          channel: "text",
          firstChunk: false,
        },
      );
    } else {
      if (variant === "permission") {
        tdp08.push({
          kind: "permission",
          now: base + 20,
          eventId: "tdp08-permission-request",
          sessionId,
          commandId,
          turnId,
          phase: "requested",
          requestId: "tdp08-permission",
          toolCallId: "tdp08-permission-tool",
        });
      }
      tdp08.push(
        {
          kind: "tool",
          now: base + 30,
          eventId: `tdp08-${variant}-tool-start`,
          sessionId,
          commandId,
          turnId,
          phase: "started",
          toolCallId: `tdp08-${variant}-tool`,
          toolName: variant === "failed" ? "Bash" : "Read",
        },
        ...(variant === "permission"
          ? ([
              {
                kind: "permission",
                now: base + 80,
                eventId: "tdp08-permission-resolved",
                sessionId,
                commandId,
                turnId,
                phase: "resolved",
                requestId: "tdp08-permission",
                toolCallId: "tdp08-permission-tool",
                decision: "allow",
              },
            ] satisfies ConversationTelemetryParityOperation[])
          : []),
        {
          kind: "tool",
          now: base + 120,
          eventId: `tdp08-${variant}-tool-terminal`,
          sessionId,
          commandId,
          turnId,
          phase: variant === "failed" ? "failed" : "completed",
          toolCallId: `tdp08-${variant}-tool`,
          toolName: variant === "failed" ? "Bash" : "Read",
          errorCode: variant === "failed" ? "TOOL_EXEC_ERROR" : undefined,
          errorMessage: variant === "failed" ? "exit 2" : undefined,
          performance: {
            totalMs: 90,
            permissionWaitMs: variant === "permission" ? 60 : 0,
            commandRunMs: variant === "permission" ? 30 : 90,
            exitCode: variant === "failed" ? 2 : 0,
            timedOut: false,
            outputBytes: 12,
            commandCategory: "read",
            commandHash: "0123456789abcdef",
            workspaceKind: "local",
          },
        },
      );
    }
    tdp08.push({
      kind: "terminal",
      now: base + 200,
      eventId: `tdp08-${variant}-terminal`,
      sessionId,
      commandId,
      turnId,
      status: "success",
    });
  });

  const tdp09 = successfulTextTurn({ caseId: "TDP09", includeNetwork: true });
  const tdp09Terminal = tdp09.findIndex((operation) => operation.kind === "terminal");
  tdp09.splice(tdp09Terminal, 0, {
    kind: "foreground.detach",
    owner: "tdp09-owner",
  });
  tdp09.push({
    kind: "foreground.attach",
    sessionId: "tdp09-session",
    owner: "tdp09-reopen",
  });

  const tdp10: ConversationTelemetryParityOperation[] = [];
  const timingVariants = [
    { name: "negative", sendAt: 200, firstAt: 100, secondAt: undefined },
    { name: "no-token", sendAt: 500, firstAt: undefined, secondAt: undefined },
    { name: "gap-3000", sendAt: 800, firstAt: 900, secondAt: 3_900 },
    { name: "gap-3001", sendAt: 4_200, firstAt: 4_300, secondAt: 7_301 },
    { name: "tool-clear", sendAt: 7_600, firstAt: 7_700, secondAt: 13_000 },
    { name: "split", sendAt: 13_300, firstAt: 13_400, secondAt: undefined },
  ] as const;
  timingVariants.forEach((variant) => {
    const sessionId = `tdp10-${variant.name}-session`;
    const commandId = `tdp10-${variant.name}-command`;
    const turnId = `tdp10-${variant.name}-turn`;
    tdp10.push(
      {
        kind: "foreground.attach",
        sessionId,
        owner: `tdp10-${variant.name}-owner-1`,
      },
      ...(variant.name === "split"
        ? ([
            {
              kind: "foreground.attach",
              sessionId,
              owner: "tdp10-split-owner-2",
            },
          ] satisfies ConversationTelemetryParityOperation[])
        : []),
      {
        kind: "seed",
        sessionId,
        commandId,
        now: variant.sendAt,
        ...seedDetail,
      },
      {
        kind: "turn.started",
        now: variant.sendAt + 1,
        eventId: `tdp10-${variant.name}-start`,
        sessionId,
        commandId,
        turnId,
      },
    );
    if (variant.firstAt !== undefined) {
      tdp10.push({
        kind: "chunk",
        now: variant.firstAt,
        eventId: `tdp10-${variant.name}-chunk-1`,
        sessionId,
        commandId,
        turnId,
        channel: "text",
        firstChunk: true,
      });
    }
    if (variant.name === "tool-clear") {
      tdp10.push(
        {
          kind: "tool",
          now: 11_500,
          eventId: "tdp10-tool-clear-start",
          sessionId,
          commandId,
          turnId,
          phase: "started",
          toolCallId: "tdp10-tool-clear-tool",
          toolName: "Read",
        },
        {
          kind: "tool",
          now: 12_000,
          eventId: "tdp10-tool-clear-complete",
          sessionId,
          commandId,
          turnId,
          phase: "completed",
          toolCallId: "tdp10-tool-clear-tool",
          toolName: "Read",
        },
      );
    }
    if (variant.secondAt !== undefined) {
      tdp10.push({
        kind: "chunk",
        now: variant.secondAt,
        eventId: `tdp10-${variant.name}-chunk-2`,
        sessionId,
        commandId,
        turnId,
        channel: "text",
        firstChunk: false,
      });
    }
    tdp10.push({
      kind: "terminal",
      now: Math.max(
        variant.sendAt + 200,
        (variant.secondAt ?? variant.firstAt ?? variant.sendAt) + 100,
      ),
      eventId: `tdp10-${variant.name}-terminal`,
      sessionId,
      commandId,
      turnId,
      status: "success",
    });
  });

  const tdp11: ConversationTelemetryParityOperation[] = [
    ...["completed", "failed", "interrupted"].map(
      (status) =>
        ({
          kind: "foreground.attach",
          sessionId: `tdp11-${status}-session`,
          owner: `tdp11-${status}-owner`,
        }) satisfies ConversationTelemetryParityOperation,
    ),
    ...["completed", "failed", "interrupted"].map(
      (status, index) =>
        ({
          kind: "compaction",
          now: 200 + index * 100,
          eventId: `tdp11-${status}`,
          sessionId: `tdp11-${status}-session`,
          operationId: `tdp11-${status}-operation`,
          summaryMessageId: `tdp11-${status}-summary`,
          status: status as "completed" | "failed" | "interrupted",
          trigger: index === 0 ? "manual" : "auto",
          reason: index === 0 ? "manual request" : undefined,
          compactReason: index === 1 ? "context_limit" : undefined,
          modelName: index === 2 ? "glm-model" : "external-model",
          modelProvider: index === 2 ? "glm" : "anthropic",
          startedAt: 100,
          endedAt: 150 + index * 10,
          preCompactTokenCount: 100,
          postCompactTokenCount: 40,
          truePostCompactTokenCount: 35,
        }) satisfies ConversationTelemetryParityOperation,
    ),
    {
      kind: "compaction",
      now: 600,
      eventId: "tdp11-duplicate",
      sessionId: "tdp11-completed-session",
      operationId: "tdp11-completed-operation",
      status: "failed",
      trigger: "manual",
      duplicate: true,
    },
    {
      kind: "compaction",
      now: 700,
      eventId: "tdp11-background",
      sessionId: "tdp11-background-session",
      operationId: "tdp11-background-operation",
      status: "completed",
      trigger: "auto",
      modelName: "glm-model",
      modelProvider: "glm",
    },
  ];

  const tdp12 = [
    "model_request_started",
    "model_request_completed",
    "model_request_failed",
    "model_retry_scheduled",
    "model_stream_stalled",
  ].flatMap((status, index) =>
    ["foreground", "background"].map(
      (visibility, visibilityIndex) =>
        ({
          kind: "model.status",
          now: 100 + index * 20 + visibilityIndex,
          eventId: `tdp12-${status}-${visibility}`,
          sessionId: `tdp12-${visibility}-session`,
          requestId: `tdp12-request-${visibility}`,
          status: status as ParityModelStatus,
          providerId: "custom-provider",
          modelId: "custom-model",
          providerHostname: "safe.example.com",
          durationMs: status === "model_request_started" ? undefined : 20 + index,
          reason: status === "model_request_failed" ? "failed" : undefined,
          retryable: status === "model_retry_scheduled" ? true : undefined,
          delayMs: status === "model_retry_scheduled" ? 500 : undefined,
          idleMs: status === "model_stream_stalled" ? 3_001 : undefined,
          timeoutMs: status === "model_stream_stalled" ? 3_000 : undefined,
        }) satisfies ConversationTelemetryParityOperation,
    ),
  );

  const tdp13: ConversationTelemetryParityOperation[] = [];
  const ttftVariants = [
    {
      name: "valid",
      sendAt: 100,
      chunkAt: 180,
      provider: "glm",
      foreground: true,
    },
    {
      name: "negative",
      sendAt: 400,
      chunkAt: 350,
      provider: "glm",
      foreground: true,
    },
    {
      name: "missing",
      sendAt: 700,
      chunkAt: 780,
      provider: "",
      foreground: true,
    },
    {
      name: "background",
      sendAt: 1_000,
      chunkAt: 1_080,
      provider: "glm",
      foreground: false,
    },
  ];
  ttftVariants.forEach((variant) => {
    const sessionId = `tdp13-${variant.name}-session`;
    const commandId = `tdp13-${variant.name}-command`;
    const turnId = `tdp13-${variant.name}-turn`;
    if (variant.foreground) {
      tdp13.push({
        kind: "foreground.attach",
        sessionId,
        owner: `tdp13-${variant.name}-owner`,
      });
    }
    tdp13.push(
      {
        kind: "seed",
        sessionId,
        commandId,
        now: variant.sendAt,
        askMode: "build",
        modelName: "glm-model",
        modelProvider: variant.provider,
      },
      {
        kind: "turn.started",
        now: variant.sendAt + 1,
        eventId: `tdp13-${variant.name}-start`,
        sessionId,
        commandId,
        turnId,
      },
      {
        kind: "chunk",
        now: variant.chunkAt,
        eventId: `tdp13-${variant.name}-chunk`,
        sessionId,
        commandId,
        turnId,
        channel: "text",
        firstChunk: true,
      },
      {
        kind: "terminal",
        now: variant.sendAt + 200,
        eventId: `tdp13-${variant.name}-terminal`,
        sessionId,
        commandId,
        turnId,
        status: "success",
      },
    );
  });

  const tdp14: ConversationTelemetryParityOperation[] = [
    {
      kind: "visible.error",
      errorKey: "tdp14-key-1",
      displayMessage: "Visible provider failure",
      code: "PROVIDER_ERROR",
      traceId: "tdp14-trace-1",
      sessionId: "tdp14-session",
      detail: "bounded detail",
    },
    {
      kind: "visible.error",
      errorKey: "tdp14-key-1",
      displayMessage: "Visible provider failure",
      code: "PROVIDER_ERROR",
      traceId: "tdp14-trace-1",
      sessionId: "tdp14-session",
      duplicate: true,
    },
    {
      kind: "visible.error",
      errorKey: "tdp14-suppressed",
      displayMessage: "Suppressed local error",
      code: "LOCAL_ERROR",
      traceId: "tdp14-trace-suppressed",
      sessionId: "tdp14-session",
      suppressed: true,
    },
    {
      kind: "visible.error",
      errorKey: "tdp14-key-2",
      displayMessage: "Second visible provider failure",
      code: "SECOND_ERROR",
      traceId: "tdp14-trace-2",
      sessionId: "tdp14-session",
    },
  ];

  const tdp15: ConversationTelemetryParityOperation[] = [
    {
      kind: "feedback",
      sessionId: "tdp15-session",
      messageId: "tdp15-assistant",
      reaction: "like",
    },
    {
      kind: "feedback",
      sessionId: "tdp15-session",
      messageId: "tdp15-assistant",
      reaction: "dislike",
    },
    {
      kind: "feedback",
      sessionId: "tdp15-session",
      messageId: "tdp15-assistant",
      reaction: "none",
    },
  ];

  const tdp17: ConversationTelemetryParityOperation[] = [
    {
      kind: "visible.error",
      errorKey: "tdp17-3007",
      displayMessage: requestSecurityMessagesEnUS["zcode.error.providerBusiness.3007"],
      code: "3007",
      traceId: "tdp17-trace",
      sessionId: "tdp17-session",
    },
  ];

  const tdp18 = successfulTextTurn({ caseId: "TDP18", includeNetwork: true });
  const duplicateChunk = tdp18.find(
    (operation): operation is Extract<ConversationTelemetryParityOperation, { kind: "chunk" }> =>
      operation.kind === "chunk",
  );
  const duplicateTerminal = tdp18.find(
    (operation): operation is Extract<ConversationTelemetryParityOperation, { kind: "terminal" }> =>
      operation.kind === "terminal",
  );
  if (duplicateChunk) tdp18.push({ ...duplicateChunk });
  if (duplicateTerminal) tdp18.push({ ...duplicateTerminal, duplicate: true });
  tdp18.push({ kind: "scope.dispose" });

  const tdp19 = [
    ...successfulTextTurn({ caseId: "TDP19A", scope: "identity-a" }),
    ...successfulTextTurn({ caseId: "TDP19B", scope: "identity-b" }),
    { kind: "scope.dispose", scope: "identity-a" },
    {
      kind: "web.noop",
      operations: successfulTextTurn({ caseId: "TDP19WEB", scope: "web" }),
    },
  ] satisfies ConversationTelemetryParityOperation[];

  return [
    scenario(
      "TDP01",
      tdp01,
      { send_btn: 1, agent_step: 1, message_completion: 1 },
      {
        plan_request: 2,
        plan_ttft: 1,
        perf_ui_first_token: 1,
        perf_ui_message_complete: 1,
        perf_ui_turn_breakdown: 1,
      },
      ["draft-create-ack", "source-command-link"],
    ),
    scenario(
      "TDP02",
      tdp02,
      { send_btn: 2, agent_step: 2, message_completion: 2 },
      {
        plan_request: 4,
        plan_ttft: 2,
        perf_ui_first_token: 2,
        perf_ui_message_complete: 2,
        perf_ui_turn_breakdown: 2,
      },
      ["same-talk-id", "message-scope-reset"],
    ),
    scenario(
      "TDP03",
      tdp03,
      { send_btn: 2, agent_step: 2, message_completion: 2 },
      {
        plan_request: 4,
        plan_ttft: 2,
        perf_ui_first_token: 2,
        perf_ui_message_complete: 2,
        perf_ui_turn_breakdown: 2,
      },
      ["queued-before-first-terminal", "promotion-seed-deduped"],
    ),
    scenario(
      "TDP04",
      successfulTextTurn({ caseId: "TDP04" }),
      { send_btn: 1, agent_step: 1, message_completion: 1 },
      {
        plan_request: 2,
        plan_ttft: 1,
        perf_ui_first_token: 1,
        perf_ui_message_complete: 1,
        perf_ui_turn_breakdown: 1,
      },
      ["success-usage", "runtime-model-hostname"],
    ),
    scenario(
      "TDP05",
      tdp05,
      { send_btn: 2, agent_step: 2, message_completion: 2 },
      {
        plan_request: 4,
        plan_ttft: 2,
        perf_ui_first_token: 2,
        perf_ui_message_complete: 2,
        perf_ui_turn_breakdown: 2,
      },
      ["failed-with-usage", "failed-without-usage"],
    ),
    scenario(
      "TDP06",
      tdp06,
      { send_btn: 2, agent_step: 1, message_completion: 1 },
      {
        plan_ttft: 1,
        perf_ui_first_token: 1,
        perf_ui_message_complete: 1,
        perf_ui_turn_breakdown: 1,
      },
      ["interrupted-terminal", "stop-without-terminal-zero-completion"],
    ),
    scenario(
      "TDP07",
      tdp07,
      { send_btn: 1, agent_step: 2, message_completion: 1 },
      {
        plan_ttft: 1,
        perf_ui_first_token: 1,
        perf_ui_message_complete: 1,
        perf_ui_turn_breakdown: 1,
      },
      ["thought-before-text", "tail-finalize"],
    ),
    scenario(
      "TDP08",
      tdp08,
      { send_btn: 4, agent_step: 5, message_completion: 4 },
      {
        plan_ttft: 4,
        perf_ui_first_token: 4,
        perf_ui_message_complete: 4,
        perf_ui_turn_breakdown: 4,
        perf_ui_tool_call_detail: 3,
      },
      ["tool-success", "tool-failed", "permission-wait", "parented-child"],
    ),
    scenario(
      "TDP09",
      tdp09,
      { send_btn: 1, agent_step: 1, message_completion: 1 },
      { plan_request: 2 },
      ["terminal-after-detach", "reopen-no-replay", "background-ui-arms-zero"],
    ),
    scenario(
      "TDP10",
      tdp10,
      { send_btn: 6, agent_step: 6, message_completion: 6 },
      {
        plan_ttft: 4,
        perf_ui_first_token: 6,
        perf_ui_message_complete: 6,
        perf_ui_turn_breakdown: 6,
        perf_ui_stream_stall: 1,
      },
      [
        "negative-ttft-clamped",
        "no-token",
        "stall-3000-zero",
        "stall-3001-one",
        "tool-clears-stall",
        "split-pane-once",
      ],
    ),
    scenario("TDP11", tdp11, { context_compaction: 3 }, {}, [
      "three-terminal-statuses",
      "nonterminal-zero",
      "duplicate-operation-zero",
      "background-zero",
      "legacy-model-encoding",
    ]),
    scenario("TDP12", tdp12, {}, { plan_request: 10 }, [
      "five-network-statuses",
      "foreground-background",
      "accepted-queued-apiRetry-zero",
      "hostname-only",
    ]),
    scenario(
      "TDP13",
      tdp13,
      { send_btn: 4, agent_step: 4, message_completion: 4 },
      {
        plan_ttft: 1,
        perf_ui_first_token: 3,
        perf_ui_message_complete: 3,
        perf_ui_turn_breakdown: 3,
      },
      ["valid-ttft", "negative-no-plan-ttft", "missing-provider-no-plan-ttft", "background-zero"],
    ),
    scenario("TDP14", tdp14, {}, { chat_error_banner: 2 }, [
      "visible",
      "suppressed-zero",
      "same-key-once",
      "new-key-new-event",
    ]),
    scenario("TDP15", tdp15, { assistant_message_feedback: 3 }, {}, [
      "like",
      "dislike",
      "toggle-none",
      "command-failure-rollback",
      "reopen-persisted",
    ]),
    scenario("TDP16", [{ kind: "quota.assert" }], {}, {}, [
      "quota-banner",
      "dismiss",
      "blocking-and-nonblocking",
      "entitlement-refresh",
      "upgrade-context",
      "purchase-events-pruned",
    ]),
    scenario("TDP17", [{ kind: "verification.assert" }, ...tdp17], {}, { chat_error_banner: 1 }, [
      "visible-3007",
      "exact-zcode-plan-provider",
      "one-shot-header",
      "accepted-duplicate-handled",
      "failure-retryable",
      "non-zcode-plan-skipped",
    ]),
    scenario(
      "TDP18",
      tdp18,
      { send_btn: 1, agent_step: 1, message_completion: 1 },
      {
        plan_request: 2,
        plan_ttft: 1,
        perf_ui_first_token: 1,
        perf_ui_message_complete: 1,
        perf_ui_turn_breakdown: 1,
      },
      ["duplicate-live-once", "initial-hydration-recovery-zero", "reload-zero-replay"],
    ),
    scenario(
      "TDP19",
      tdp19,
      { send_btn: 2, agent_step: 2, message_completion: 2 },
      {
        plan_request: 4,
        plan_ttft: 2,
        perf_ui_first_token: 2,
        perf_ui_message_complete: 2,
        perf_ui_turn_breakdown: 2,
      },
      ["workspace-identity-isolated", "remote-session-isolated", "generation-disposed", "web-noop"],
    ),
  ];
}

const SCENARIOS = new Map(buildScenarios().map((item) => [item.caseId, item]));

export const CONVERSATION_TELEMETRY_PARITY_CASE_IDS = [...SCENARIOS.keys()];

export function getConversationTelemetryParityScenario(
  caseId: string,
): ConversationTelemetryParityScenario {
  const found = SCENARIOS.get(caseId);
  if (!found) {
    throw new Error(`Unknown conversation telemetry parity case: ${caseId}`);
  }
  return found;
}
