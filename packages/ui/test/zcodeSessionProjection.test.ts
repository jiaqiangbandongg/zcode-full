import { describe, expect, it, vi } from "vitest";
import {
  encodeCustomModelValue,
  formatModelPickerValue as formatSharedModelSelection,
  ZCODE_PROTOCOL_NAME,
  ZCODE_PROTOCOL_VERSION,
  type ZCodeSessionEvent,
  type ZCodeMessagePart,
  type ZCodeMessageWithParts,
  type ZCodeSessionSettingsState,
  type ZCodeSessionStateSnapshot,
} from "@zcode/shared";
import {
  formatModelPickerValue as formatProjectedModelSelection,
  parseModelPickerValue,
  type ZCodeSessionEventProjectionState,
  zcodeSessionEventToZCodeStreamEvents,
  zcodeSessionSettingsToConfigOptions,
  zcodeSessionSnapshotToZCodeTaskSnapshot,
  zcodeStateUpdatedToZCodeStreamEvents,
  zcodeUserInputRequestToZCodeStreamEvent,
  zcodeUserInputResponseToZCodeStreamEvent,
} from "@/lib/zcodeSessionProjection.js";

const workspace = {
  workspacePath: "/workspace/app",
  workspaceIdentity: "remote:ssh:dev:/workspace/app",
  workspaceKey: "remote:ssh:dev:/workspace/app",
};
const subagentOrigin = {
  kind: "subagent",
  agentId: "agent_snapshot",
  agentType: "general",
  childSessionId: "sess_child_snapshot",
  childTurnId: "turn_child_snapshot",
  parentSessionId: "sess_1",
  parentToolCallId: "tool_parent_agent",
  parentTurnId: "turn_parent_snapshot",
} as const;
const model = { providerId: "glm", modelId: "glm-4.6" };
const backgroundAgentProviderError =
  "Requests are too frequent. Please reduce your request frequency, wait a short moment, and retry your request. Request id: e2e-background-subagent-rate-limit";
const settings = {
  model: {
    current: model,
    available: [{ ref: model, label: "GLM 4.6", contextWindow: 128000 }],
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
} satisfies ZCodeSessionSettingsState;

const settingsWithDefaultThoughtLevel = {
  ...settings,
  thoughtLevel: {
    enabled: true,
    current: undefined,
    defaultLevel: "max",
    available: [
      { value: "high", label: "High" },
      { value: "max", label: "Max" },
    ],
  },
} satisfies ZCodeSessionSettingsState;

function createSnapshot(): ZCodeSessionStateSnapshot {
  return {
    protocol: {
      name: ZCODE_PROTOCOL_NAME,
      version: ZCODE_PROTOCOL_VERSION,
    },
    session: {
      sessionId: "sess_1",
      workspace,
      sessionKind: "interactive",
      title: "",
      mode: "build",
      status: "running",
      model,
      createdAt: 1,
      updatedAt: 2,
    },
    settings,
    projection: {
      sessionId: "sess_1",
      status: "running",
      mode: "build",
      turnCount: 1,
      totalTokenCount: 12,
      contextUsed: 12,
      contextWindow: 128000,
      pendingPermissions: [
        {
          requestId: "perm_1",
          toolCallId: "tool_1",
          toolName: "Bash",
          riskLevel: "medium",
          reason: "Run command",
          origin: subagentOrigin,
          requestedAt: 3,
        },
      ],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: {
      eventSeq: 7,
      stateRevision: 3,
      deliveryKind: "desktop-continuous",
      pendingRequestIds: ["perm_1"],
    },
    messages: [
      {
        info: {
          messageId: "msg_user",
          sessionId: "sess_1",
          role: "user",
          time: { created: 1 },
          agent: "zcode-agent",
          model,
        },
        parts: [
          {
            partId: "part_user",
            sessionId: "sess_1",
            messageId: "msg_user",
            type: "text",
            text: "hello",
          },
        ],
      },
      {
        info: {
          messageId: "msg_assistant",
          sessionId: "sess_1",
          role: "assistant",
          parentMessageId: "msg_user",
          time: { created: 2, completed: 12 },
          agent: "zcode-agent",
          model,
          path: { cwd: "/workspace/app", root: "/workspace/app" },
          cost: 0,
          tokens: {
            input: 1,
            output: 2,
            reasoning: 3,
            total: 6,
            cache: { read: 0, write: 0 },
          },
        },
        parts: [
          {
            partId: "part_reasoning",
            sessionId: "sess_1",
            messageId: "msg_assistant",
            type: "reasoning",
            text: "thinking",
          },
          {
            partId: "part_tool",
            sessionId: "sess_1",
            messageId: "msg_assistant",
            type: "tool",
            callId: "tool_1",
            tool: "Bash",
            state: {
              status: "completed",
              input: { command: "pwd" },
              output: "/workspace/app",
              title: "Bash",
              metadata: {},
              startedAt: 4,
              completedAt: 5,
            },
          },
          {
            partId: "part_text",
            sessionId: "sess_1",
            messageId: "msg_assistant",
            type: "text",
            text: "done",
          },
        ],
      },
    ],
  };
}

describe("zcodeSessionProjection", () => {
  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "%s 历史缺少模型来源时保留消息，不伪造模型",
    (deliveryKind) => {
      const snapshot = createSnapshot();
      snapshot.runtime.deliveryKind = deliveryKind;
      for (const message of snapshot.messages) delete message.info.model;
      const projected = zcodeSessionSnapshotToZCodeTaskSnapshot(snapshot);
      expect(projected.messages).toHaveLength(snapshot.messages.length);
      expect(projected.messages.every((message) => message.model === undefined)).toBe(true);
      expect(projected.messages[0]?.content).toBe("hello");
    },
  );
  it("preserves structured attribution when projecting a failed turn to task_error", () => {
    const events = zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_turn_failed_attribution",
        seq: 8,
        sessionId: "sess_1",
        timestamp: 10,
        type: "turn.failed",
        payload: {
          turnPhase: "model",
          error: {
            type: "MODEL_ERROR",
            code: "model_request_failed",
            message: "[1301][Sensitive content rejected]",
            attribution: {
              source: "provider",
              reason: "unknown",
              providerId: "account:bigmodel-individual-coding-plan",
              providerErrorCode: "1301",
            },
          },
        },
      },
      taskId: "task_1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "task_error",
        attribution: {
          source: "provider",
          reason: "unknown",
          providerId: "account:bigmodel-individual-coding-plan",
          providerErrorCode: "1301",
        },
      }),
    );
  });

  it("preserves completed tool display metadata in snapshot raw output", () => {
    const base = createSnapshot();
    const assistant = base.messages[1]!;
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...base,
      messages: [
        base.messages[0]!,
        {
          ...assistant,
          parts: [
            {
              partId: "part_node_repl_image",
              sessionId: "sess_1",
              messageId: assistant.info.messageId,
              type: "tool",
              callId: "tool_node_repl_image",
              tool: "mcp__node_repl__js",
              state: {
                status: "completed",
                input: { code: "nodeRepl.emitImage(await tab.screenshot());" },
                output: "(no output)\n[Attached image/png: MCP image]",
                title: "截图查看",
                metadata: {
                  schemaVersion: 1,
                  display: {
                    kind: "node_repl_images",
                    images: [{ base64: "AAAA", mimeType: "image/png" }],
                  },
                },
                startedAt: 4,
                completedAt: 5,
              },
            },
          ],
        },
      ],
    });

    expect(snapshot.messages[1]?.tools[0]?.raw).toMatchObject({
      toolCallId: "tool_node_repl_image",
      display: {
        kind: "node_repl_images",
        images: [{ base64: "AAAA", mimeType: "image/png" }],
      },
    });
  });

  it("falls back to a valid thought level when session settings carry a stale current value", () => {
    const options = zcodeSessionSettingsToConfigOptions({
      ...settings,
      thoughtLevel: {
        enabled: true,
        current: "high",
        available: [
          { value: "enabled", label: "Enabled" },
          { value: "disabled", label: "Disabled" },
        ],
      },
    });

    expect(options.find((option) => option.category === "thought_level")?.currentValue).toBe(
      "enabled",
    );
  });

  it("uses thought defaultLevel before the first available level when current is empty", () => {
    const options = zcodeSessionSettingsToConfigOptions(settingsWithDefaultThoughtLevel);

    expect(options.find((option) => option.category === "thought_level")?.currentValue).toBe("max");
  });

  it("uses thought defaultLevel in model state updates when current is empty", () => {
    const events = zcodeStateUpdatedToZCodeStreamEvents({
      notification: {
        type: "state.updated",
        scope: "session",
        sessionId: "sess_1",
        revision: 2,
        reason: "model_changed",
        patch: settingsWithDefaultThoughtLevel,
      },
      settings: settingsWithDefaultThoughtLevel,
      taskId: "sess_1",
    });

    expect(events.find((event) => event.type === "glm_agent_model_state_update")).toMatchObject({
      type: "glm_agent_model_state_update",
      thoughtLevel: {
        enabled: true,
        currentValue: "max",
        options: [
          { value: "high", name: "High" },
          { value: "max", name: "Max" },
        ],
      },
    });
  });

  it("maps server-owned session snapshots into the current chat projection", () => {
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot(createSnapshot());

    expect(snapshot.meta).toMatchObject({
      taskId: "sess_1",
      provider: "glm",
      title: "hello",
      status: "running",
      workspaceIdentity: workspace.workspaceIdentity,
    });
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[1]).toMatchObject({
      role: "assistant",
      content: "done",
      thought: "thinking",
      durationMs: 10,
    });
    expect(snapshot.messages[1]?.tools?.[0]).toMatchObject({
      toolName: "Bash",
      status: "completed",
      output: "/workspace/app",
      raw: {
        toolCallId: "tool_1",
      },
    });
    expect(snapshot.messages[1]?.tools?.[0]?.raw).toMatchObject({
      toolCallId: "tool_1",
    });
    expect(snapshot.runtime?.pendingPermissions?.[0]).toMatchObject({
      requestId: "perm_1",
      kind: "Bash",
      origin: subagentOrigin,
    });
    expect(snapshot.runtime?.contextUsage).toEqual({
      used: 12,
      size: 128000,
      cost: null,
    });
  });

  it("projects legacy fork synthetic user as a separator without raw text", () => {
    const base = createSnapshot();
    const forkMetadata = {
      forkContext: {
        kind: "session_fork",
        parentSessionId: "sess_parent",
        restoredFileCount: 0,
        targetMessageId: "msg_parent_assistant",
      },
      source: "fork",
      visibility: "user-visible",
    };
    const forkNotice: ZCodeMessageWithParts = {
      info: {
        messageId: "msg_fork_notice",
        sessionId: "sess_1",
        role: "user",
        time: { created: 3 },
        agent: "zcode-agent",
        model,
        metadata: forkMetadata,
        source: "fork",
        synthetic: true,
        visibility: "user-visible",
      },
      parts: [
        {
          partId: "part_fork_notice",
          sessionId: "sess_1",
          messageId: "msg_fork_notice",
          type: "text",
          text: "This session was forked from a previous session message.",
          metadata: forkMetadata,
          synthetic: true,
        },
      ],
    };

    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...base,
      messages: [...base.messages, forkNotice],
    });
    const forkTimeline = snapshot.messages.find(
      (message) => message.syntheticTimeline?.type === "session_fork",
    );

    expect(forkTimeline).toMatchObject({
      content: "",
      syntheticTimeline: {
        parentSessionId: "sess_parent",
        targetMessageId: "msg_parent_assistant",
        type: "session_fork",
      },
    });
    expect(
      snapshot.messages.some((message) => message.content.includes("This session was forked")),
    ).toBe(false);
  });

  it("projects persisted session_fork timeline parts after cold snapshot restore", () => {
    const base = createSnapshot();
    const timelineMessage: ZCodeMessageWithParts = {
      info: {
        messageId: "msg_fork_timeline",
        sessionId: "sess_1",
        role: "assistant",
        parentMessageId: "msg_assistant",
        time: { created: 4, completed: 4 },
        agent: "zcode-agent",
        model,
        path: { cwd: "/workspace/app", root: "/workspace/app" },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          total: 0,
          cache: { read: 0, write: 0 },
        },
      },
      parts: [
        {
          partId: "part_fork_timeline",
          sessionId: "sess_1",
          messageId: "msg_fork_timeline",
          type: "timeline",
          timelineType: "session_fork",
          display: "separator",
          status: "completed",
          parentSessionId: "sess_parent",
          targetMessageId: "msg_parent_assistant",
          restoredFileCount: 1,
        },
      ],
    };

    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...base,
      messages: [...base.messages, timelineMessage],
    });

    expect(snapshot.messages.find((message) => message.id === "msg_fork_timeline")).toMatchObject({
      content: "",
      syntheticTimeline: {
        parentSessionId: "sess_parent",
        restoredFileCount: 1,
        targetMessageId: "msg_parent_assistant",
        type: "session_fork",
      },
    });
  });

  it("hides model-only fork raw notices when a structured fork timeline exists", () => {
    const base = createSnapshot();
    const forkMetadata = {
      forkContext: {
        kind: "session_fork",
        parentSessionId: "sess_parent",
        restoredFileCount: 0,
        targetMessageId: "msg_parent_assistant",
      },
      source: "fork",
      visibility: "model-only",
    };
    const timelineMessage: ZCodeMessageWithParts = {
      info: {
        messageId: "msg_fork_timeline",
        sessionId: "sess_1",
        role: "assistant",
        parentMessageId: "msg_assistant",
        time: { created: 4, completed: 4 },
        agent: "zcode-agent",
        model,
        path: { cwd: "/workspace/app", root: "/workspace/app" },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          total: 0,
          cache: { read: 0, write: 0 },
        },
      },
      parts: [
        {
          partId: "part_fork_timeline",
          sessionId: "sess_1",
          messageId: "msg_fork_timeline",
          type: "timeline",
          timelineType: "session_fork",
          display: "separator",
          status: "completed",
          parentSessionId: "sess_parent",
          targetMessageId: "msg_parent_assistant",
          restoredFileCount: 0,
        },
      ],
    };
    const rawNotice: ZCodeMessageWithParts = {
      info: {
        messageId: "msg_fork_raw_notice",
        sessionId: "sess_1",
        role: "user",
        time: { created: 5 },
        agent: "zcode-agent",
        model,
        metadata: forkMetadata,
        semantics: {
          kind: "fork_notice",
          origin: "agent_runtime",
          providerVisibility: "visible",
          source: "fork",
          transcriptVisibility: "hidden",
          uiVisibility: "hidden",
        },
        source: "fork",
        synthetic: true,
        visibility: "model-only",
      },
      parts: [
        {
          partId: "part_fork_raw_notice",
          sessionId: "sess_1",
          messageId: "msg_fork_raw_notice",
          type: "text",
          text: "This session was forked from a previous session message.",
          metadata: forkMetadata,
          synthetic: true,
        },
      ],
    };

    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...base,
      messages: [...base.messages, timelineMessage, rawNotice],
    });
    const forkTimelines = snapshot.messages.filter(
      (message) => message.syntheticTimeline?.type === "session_fork",
    );

    expect(forkTimelines).toHaveLength(1);
    expect(forkTimelines[0]).toMatchObject({
      id: "msg_fork_timeline",
      content: "",
      syntheticTimeline: {
        parentSessionId: "sess_parent",
        targetMessageId: "msg_parent_assistant",
        type: "session_fork",
      },
    });
    expect(JSON.stringify(snapshot.messages)).not.toContain("This session was forked");
  });

  it("attaches hidden task notification metadata to the matching background Agent tool", () => {
    const base = createSnapshot();
    const assistantMessage = {
      info: {
        messageId: "msg_assistant_agent",
        sessionId: "sess_1",
        role: "assistant",
        parentMessageId: "msg_user",
        time: { created: 2, completed: 12 },
        agent: "zcode-agent",
        model,
      },
      parts: [
        {
          partId: "part_agent_tool",
          sessionId: "sess_1",
          messageId: "msg_assistant_agent",
          type: "tool",
          callId: "toolu_background_agent",
          tool: "Agent",
          state: {
            status: "completed",
            input: {
              prompt: "run background research",
              run_in_background: true,
            },
            output: "Async agent launched successfully.\noutput_file: /tmp/background-agent.output",
            title: "Agent",
            metadata: {
              _meta: {
                zcode: {
                  backgroundAgent: {
                    runInBackground: true,
                    outputFile: "/tmp/background-agent.output",
                  },
                },
              },
            },
            startedAt: 4,
            completedAt: 5,
          },
        },
      ],
    } satisfies ZCodeSessionStateSnapshot["messages"][number];
    const notificationMessage = {
      info: {
        messageId: "msg_task_notification",
        sessionId: "sess_1",
        role: "user",
        time: { created: 13 },
        agent: "zcode-agent",
        model,
        visibility: "model-only",
      },
      parts: [
        {
          partId: "part_task_notification",
          sessionId: "sess_1",
          messageId: "msg_task_notification",
          type: "text",
          synthetic: true,
          metadata: { source: "background_task" },
          text: [
            "<task-notification>",
            "<task-id>agent_1</task-id>",
            "<tool-use-id>toolu_background_agent</tool-use-id>",
            "<output-file>/tmp/background-agent.output</output-file>",
            "<status>completed</status>",
            "<result>Background agent result &amp; summary</result>",
            "</task-notification>",
          ].join("\n"),
        },
      ],
    } satisfies ZCodeSessionStateSnapshot["messages"][number];

    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...base,
      messages: [base.messages[0]!, assistantMessage, notificationMessage],
    });

    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[1]?.tools?.[0]?.raw).toMatchObject({
      _meta: {
        zcode: {
          taskNotification: {
            outputFile: "/tmp/background-agent.output",
            result: "Background agent result & summary",
            status: "completed",
            taskId: "agent_1",
          },
        },
      },
    });
  });

  it.each([
    {
      expectedError: backgroundAgentProviderError,
      expectedStatus: "failed" as const,
      notificationStatus: "failed",
    },
    {
      expectedError: undefined,
      expectedStatus: "completed" as const,
      notificationStatus: "stopped",
    },
  ])(
    "restores a $notificationStatus background Agent notification without changing unrelated launch semantics",
    ({ expectedError, expectedStatus, notificationStatus }) => {
      const base = createSnapshot();
      const assistantMessage = {
        info: {
          messageId: "msg_assistant_failed_background_agent",
          sessionId: "sess_1",
          role: "assistant",
          parentMessageId: "msg_user",
          time: { created: 2, completed: 12 },
          agent: "zcode-agent",
          model,
        },
        parts: [
          {
            partId: "part_failed_background_agent_tool",
            sessionId: "sess_1",
            messageId: "msg_assistant_failed_background_agent",
            type: "tool",
            callId: "toolu_failed_background_agent",
            tool: "Agent",
            state: {
              status: "completed",
              input: {
                prompt: "run background research",
                run_in_background: true,
              },
              output:
                "Async agent launched successfully.\noutput_file: /tmp/background-agent.output",
              title: "Agent",
              metadata: {
                _meta: {
                  zcode: {
                    backgroundAgent: {
                      runInBackground: true,
                      outputFile: "/tmp/background-agent.output",
                    },
                  },
                },
              },
              startedAt: 4,
              completedAt: 5,
            },
          },
        ],
      } satisfies ZCodeSessionStateSnapshot["messages"][number];
      const notificationMessage = {
        info: {
          messageId: "msg_failed_task_notification",
          sessionId: "sess_1",
          role: "user",
          time: { created: 13 },
          agent: "zcode-agent",
          model,
          visibility: "model-only",
        },
        parts: [
          {
            partId: "part_failed_task_notification",
            sessionId: "sess_1",
            messageId: "msg_failed_task_notification",
            type: "text",
            synthetic: true,
            metadata: { source: "background_task" },
            text: [
              "<task-notification>",
              "<task-id>agent_failed</task-id>",
              "<tool-use-id>toolu_failed_background_agent</tool-use-id>",
              "<output-file>/tmp/background-agent.output</output-file>",
              `<status>${notificationStatus}</status>`,
              `<summary>Agent general-purpose task "Review" ${notificationStatus}.</summary>`,
              ...(expectedError ? [`<error>${expectedError}</error>`] : []),
              "</task-notification>",
            ].join("\n"),
          },
        ],
      } satisfies ZCodeSessionStateSnapshot["messages"][number];

      const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
        ...base,
        messages: [base.messages[0]!, assistantMessage, notificationMessage],
      });

      expect(snapshot.messages).toHaveLength(2);
      expect(snapshot.messages[1]?.tools?.[0]).toMatchObject({
        status: expectedStatus,
        output: "Async agent launched successfully.\noutput_file: /tmp/background-agent.output",
        raw: {
          _meta: {
            zcode: {
              taskNotification: {
                status: notificationStatus,
                summary: `Agent general-purpose task "Review" ${notificationStatus}.`,
                taskId: "agent_failed",
              },
            },
          },
        },
      });
      expect(snapshot.messages[1]?.tools?.[0]?.error).toBe(expectedError);
    },
  );

  it("maps pending ExitPlanMode approvals into pending elicitations", () => {
    const base = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...base,
      projection: {
        ...base.projection,
        pendingPermissions: [
          {
            requestId: "exit_plan_1",
            toolCallId: "tool_exit_plan",
            toolName: "ExitPlanMode",
            riskLevel: "high",
            reason: "Exit plan mode",
            origin: subagentOrigin,
            requestedAt: 4,
            input: { plan: "1. Change runtime\n2. Add tests" },
          },
        ],
      },
      runtime: {
        ...base.runtime,
        pendingRequestIds: ["exit_plan_1"],
      },
    });

    expect(snapshot.runtime?.pendingPermissions).toEqual([]);
    expect(snapshot.runtime?.pendingElicitations?.[0]).toMatchObject({
      type: "elicitation_request",
      requestId: "exit_plan_1",
      message: "Review this implementation plan.",
      header: "Plan",
      options: [{ value: "approve", label: "Approve" }],
      origin: subagentOrigin,
      schema: { interaction: "plan_approval", toolName: "ExitPlanMode" },
    });
  });

  it("keeps tools when a tool-calls assistant is followed by final text", () => {
    const base = createSnapshot();
    const toolOnlyAssistant = {
      ...base.messages[1]!,
      info: {
        ...base.messages[1]!.info,
        finish: "tool-calls",
        messageId: "msg_tool_only",
        time: { created: 2, completed: 312 },
      },
      parts: [
        {
          partId: "part_tool_only_start",
          sessionId: "sess_1",
          messageId: "msg_tool_only",
          type: "tool",
          callId: "tool_read_guard",
          tool: "Read",
          state: {
            status: "completed",
            input: { file_path: "/tmp/zcode-e2e-tool-action-guard.txt" },
            output: "E2E_TOOL_FILE_CONTENT",
            title: "Read",
            metadata: {},
            startedAt: 300,
            completedAt: 310,
          },
        },
      ],
    } satisfies ZCodeSessionStateSnapshot["messages"][number];
    const finalAssistant = {
      ...base.messages[1]!,
      info: {
        ...base.messages[1]!.info,
        finish: "stop",
        messageId: "msg_final_text",
        time: { created: 314, completed: 360 },
      },
      parts: [
        {
          partId: "part_final_text",
          sessionId: "sess_1",
          messageId: "msg_final_text",
          type: "text",
          text: "deepseek-e2e-ok",
        },
      ],
    } satisfies ZCodeSessionStateSnapshot["messages"][number];

    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...base,
      session: {
        ...base.session,
        status: "idle",
      },
      projection: {
        ...base.projection,
        status: "idle",
        pendingPermissions: [],
      },
      runtime: {
        ...base.runtime,
        pendingRequestIds: [],
      },
      messages: [base.messages[0]!, toolOnlyAssistant, finalAssistant],
    });
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[1]).toMatchObject({
      id: "msg_tool_only",
      role: "assistant",
      content: "deepseek-e2e-ok",
      tools: [
        {
          toolName: "Read",
          status: "completed",
        },
      ],
    });
    expect(snapshot.messages[1]?.parts).toEqual([
      { type: "tool-call", toolIndex: 0 },
      { type: "content", content: "deepseek-e2e-ok" },
    ]);
  });

  it("restores user image, video, and PDF attachments from protocol file parts", () => {
    const base = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...base,
      messages: [
        {
          ...base.messages[0]!,
          parts: [
            ...base.messages[0]!.parts,
            {
              partId: "part_image",
              sessionId: "sess_1",
              messageId: "msg_user",
              filename: "screen.png",
              metadata: {
                sizeBytes: 30,
                storageKind: "artifact",
              },
              mime: "image/png",
              type: "file",
              url: "data:image/png;base64,aW1hZ2U=",
            } satisfies ZCodeMessagePart,
            {
              partId: "part_video",
              sessionId: "sess_1",
              messageId: "msg_user",
              filename: "demo.mp4",
              metadata: {
                originalUrl: "/workspace/app/demo.mp4",
                sizeBytes: 5,
                storageKind: "inline",
              },
              mime: "video/mp4",
              type: "file",
              url: "data:video/mp4;base64,dmlkZW8=",
            } satisfies ZCodeMessagePart,
            {
              partId: "part_pdf",
              sessionId: "sess_1",
              messageId: "msg_user",
              filename: "report.pdf",
              metadata: {
                sizeBytes: 9,
                storageKind: "artifact",
              },
              mime: "application/pdf; charset=binary",
              type: "file",
              url: "zcode-artifact://sess_1/pdf-1",
            } satisfies ZCodeMessagePart,
          ],
        },
      ],
    });

    expect(snapshot.messages[0]?.attachments).toEqual([
      {
        kind: "image",
        filename: "screen.png",
        mimeType: "image/png",
        sizeBytes: 30,
        dataBase64: "aW1hZ2U=",
      },
      {
        kind: "video",
        filename: "demo.mp4",
        mimeType: "video/mp4",
        sizeBytes: 5,
        dataBase64: "dmlkZW8=",
        localPath: "/workspace/app/demo.mp4",
      },
      {
        kind: "pdf",
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 9,
      },
    ]);
  });

  it("projects one attachment-only raw user message without exposing the wire fallback", () => {
    const base = createSnapshot();
    const rawMessage = {
      ...base.messages[0]!,
      parts: [
        {
          partId: "part_attachment_only_text",
          sessionId: "sess_1",
          messageId: "msg_user",
          type: "text",
          text: "",
        },
        {
          partId: "part_attachment_only_file",
          sessionId: "sess_1",
          messageId: "msg_user",
          filename: "notes.md",
          metadata: {
            preview: {
              text: "# Notes\nAttachment-only content.",
              truncated: false,
              originalBytes: 32,
            },
            recoverability: "provider_ready",
            sizeBytes: 32,
            storageKind: "inline",
          },
          mime: "text/plain",
          type: "file",
          url: "inline:data-url",
        },
      ],
    } satisfies ZCodeSessionStateSnapshot["messages"][number];
    const originalParts = structuredClone(rawMessage.parts);

    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...base,
      messages: [rawMessage],
    });

    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]).toMatchObject({
      id: "msg_user",
      role: "user",
      content: "",
      attachments: [
        {
          kind: "file",
          filename: "notes.md",
          mimeType: "text/plain",
          sizeBytes: 32,
          textContent: "# Notes\nAttachment-only content.",
        },
      ],
    });
    expect(rawMessage.parts).toEqual(originalParts);
    expect(JSON.stringify(snapshot.messages)).not.toContain("(no content)");
  });

  it("maps idle session snapshots with a completed assistant turn to completed task status", () => {
    const base = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...base,
      session: {
        ...base.session,
        status: "idle",
      },
      projection: {
        ...base.projection,
        status: "idle",
        pendingPermissions: [],
        activeToolCalls: [],
      },
      runtime: {
        ...base.runtime,
        pendingRequestIds: [],
      },
    });

    expect(snapshot.meta.status).toBe("completed");
  });

  it("keeps an idle tool-calls assistant turn without a task terminal status", () => {
    const base = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...base,
      session: {
        ...base.session,
        status: "idle",
      },
      projection: {
        ...base.projection,
        status: "idle",
        pendingPermissions: [],
        activeToolCalls: [],
      },
      runtime: {
        ...base.runtime,
        pendingRequestIds: [],
      },
      messages: base.messages.map((message) =>
        message.info.role === "assistant"
          ? {
              ...message,
              info: {
                ...message.info,
                finish: "tool-calls",
              },
            }
          : message,
      ),
    });

    expect(snapshot.meta.status).toBeUndefined();
  });

  it("keeps an empty idle session without a task terminal status", () => {
    const base = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...base,
      session: {
        ...base.session,
        status: "idle",
      },
      projection: {
        ...base.projection,
        status: "idle",
        pendingPermissions: [],
        activeToolCalls: [],
      },
      runtime: {
        ...base.runtime,
        pendingRequestIds: [],
      },
      messages: [],
    });

    expect(snapshot.meta.status).toBeUndefined();
  });

  it("preserves protocol projection error type as task error code", () => {
    const base = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...base,
      projection: {
        ...base.projection,
        lastError: {
          message: "历史任务使用的模型已不可用，请从当前模型列表中选择一个可用模型后继续。",
          type: "ZCODE_RUNTIME_MODEL_UNAVAILABLE",
        },
      },
    });

    expect(snapshot.meta.lastError).toEqual({
      code: "ZCODE_RUNTIME_MODEL_UNAVAILABLE",
      message: "历史任务使用的模型已不可用，请从当前模型列表中选择一个可用模型后继续。",
    });
  });

  it("prefers structured projection error code over wrapper error type in task meta", () => {
    const base = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...base,
      projection: {
        ...base.projection,
        lastError: {
          message: "Model provider is not configured: stale-provider",
          type: "MODEL_ERROR",
          code: "provider_not_found",
          detail: "stale-provider/gpt-5.5",
          attribution: {
            source: "runtime",
            reason: "provider_not_configured",
            providerId: "account:zai-individual-coding-plan",
          },
        },
      },
    });

    expect(snapshot.meta.lastError).toEqual({
      code: "provider_not_found",
      detail: "stale-provider/gpt-5.5",
      message: "Model provider is not configured: stale-provider",
      attribution: {
        source: "runtime",
        reason: "provider_not_configured",
        providerId: "account:zai-individual-coding-plan",
      },
    });
  });

  it("prioritizes projection lastError over a completed previous assistant turn", () => {
    const base = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...base,
      session: {
        ...base.session,
        status: "idle",
      },
      projection: {
        ...base.projection,
        status: "error",
        pendingPermissions: [],
        activeToolCalls: [],
        lastError: {
          message: "messages.content.type 参数非法，取值范围 ['text']",
          type: "PROVIDER_BUSINESS_ERROR",
        },
      },
      runtime: {
        ...base.runtime,
        activeTurnId: undefined,
        pendingRequestIds: [],
      },
    });

    expect(snapshot.meta.status).toBe("error");
    expect(snapshot.meta.lastError).toEqual({
      code: "PROVIDER_BUSINESS_ERROR",
      message: "messages.content.type 参数非法，取值范围 ['text']",
    });
  });

  it("uses the latest message model for task meta when restored settings were polluted", () => {
    const pollutedModel = {
      providerId: "36965ea6-734a-46a8-8851-3dfec026589e",
      modelId: "glm-5.1-highspeed",
    };
    const historyModel = {
      providerId: "default-deepseek",
      modelId: "deepseek-v4-flash",
    };
    const base = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...base,
      settings: {
        ...base.settings,
        model: {
          ...base.settings.model,
          current: pollutedModel,
          available: [{ ref: pollutedModel, label: "glm-5.1-highspeed" }],
        },
      },
      messages: base.messages.map((message) => ({
        ...message,
        info: {
          ...message.info,
          model: historyModel,
        },
      })),
    });

    expect(snapshot.meta.model).toBe("default-deepseek/deepseek-v4-flash");
  });

  it("maps persisted session todos into task runtime plan", () => {
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...createSnapshot(),
      todos: [
        { content: "实现 Lexer", priority: "high", status: "completed" },
        { content: "实现 Parser", priority: "high", status: "in_progress" },
      ],
    });

    expect(snapshot.runtime?.plan).toEqual([
      { id: "todo-0", title: "实现 Lexer", status: "completed" },
      { id: "todo-1", title: "实现 Parser", status: "in_progress" },
    ]);
  });

  it("maps derived goal stats and grouped todos into task runtime", () => {
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...createSnapshot(),
      runtime: {
        ...createSnapshot().runtime,
        goalVerifications: [
          {
            nextAction: "补齐移动端回归。",
            passed: false,
            reason: "第一轮证据不足。",
          },
        ],
      },
      goalStats: {
        contextUsed: 38_200,
        contextWindow: 120_000,
        iterationCount: 4,
        timeUsedSeconds: 8_667,
        tokenBudget: 120_000,
        tokensUsed: 38_200,
        toolCallCount: 27,
      },
      todoGroups: [
        {
          id: "goal-iteration-1",
          source: "goal_iteration",
          goalIteration: 1,
          targetId: "goal_1",
          startedAt: 1_000,
          updatedAt: 2_000,
          todos: [
            { content: "恢复目标统计", priority: "high", status: "completed" },
            {
              content: "按目标迭代分组 todo",
              priority: "high",
              status: "in_progress",
            },
          ],
        },
      ],
    });

    expect(snapshot.runtime?.goalStats).toEqual({
      contextUsed: 38_200,
      contextWindow: 120_000,
      iterationCount: 4,
      timeUsedSeconds: 8_667,
      tokenBudget: 120_000,
      tokensUsed: 38_200,
      toolCallCount: 27,
    });
    expect(snapshot.runtime?.goalVerifications).toEqual([
      {
        nextAction: "补齐移动端回归。",
        passed: false,
        reason: "第一轮证据不足。",
      },
    ]);
    expect(snapshot.runtime?.todoGroups).toEqual([
      {
        id: "goal-iteration-1",
        source: "goal_iteration",
        goalIteration: 1,
        targetId: "goal_1",
        startedAt: 1_000,
        updatedAt: 2_000,
        todos: [
          {
            id: "goal-iteration-1-todo-0",
            title: "恢复目标统计",
            status: "completed",
          },
          {
            id: "goal-iteration-1-todo-1",
            title: "按目标迭代分组 todo",
            status: "in_progress",
          },
        ],
      },
    ]);
  });

  it("adds persisted goal verification lifecycle as a synthetic divider on snapshot restore", () => {
    const baseSnapshot = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...baseSnapshot,
      runtime: {
        ...baseSnapshot.runtime,
        goalVerificationTimeline: [
          {
            version: 1,
            kind: "synthetic",
            type: "goal_verification",
            display: "separator",
            targetId: "target_1",
            verificationId: "verify_1",
            status: "completed",
            goalIteration: 2,
            anchorAssistantMessageId: "msg_assistant",
            anchorTurnId: "turn_1",
            verification: {
              nextAction: null,
              passed: true,
              reason: "所有目标要求都已完成。",
            },
            startedAt: 20,
            updatedAt: 30,
          },
        ],
      },
    });

    expect(snapshot.runtime?.goalVerificationTimeline).toHaveLength(1);
    expect(snapshot.messages).toHaveLength(3);
    expect(snapshot.messages[2]).toMatchObject({
      id: "zcode-goal-verification-target_1-2",
      role: "assistant",
      content: "",
      timestamp: 20,
      syntheticTimeline: {
        type: "goal_verification",
        status: "completed",
        verificationId: "verify_1",
        goalIteration: 2,
        anchorAssistantMessageId: "msg_assistant",
        anchorTurnId: "turn_1",
      },
    });
  });

  it("anchors goal verification dividers to assistant messages that were coalesced", () => {
    const objective = "写一篇短篇科幻小说";
    const baseSnapshot = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...baseSnapshot,
      projection: {
        ...baseSnapshot.projection,
        target: {
          sessionId: "sess_1",
          targetId: "goal_1",
          objective,
          summaryTitle: null,
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 100,
          updatedAt: 100,
        },
      },
      runtime: {
        ...baseSnapshot.runtime,
        goalVerificationTimeline: [
          {
            version: 1,
            kind: "synthetic",
            type: "goal_verification",
            display: "separator",
            targetId: "goal_1",
            verificationId: "verify_goal_1",
            status: "completed",
            goalIteration: 1,
            anchorAssistantMessageId: "msg_assistant_second",
            verification: {
              nextAction: "continue",
              passed: false,
              reason: "第二轮仍未完成。",
            },
            startedAt: 400,
            updatedAt: 410,
          },
        ],
      },
      messages: [
        {
          info: {
            messageId: "msg_goal_user",
            sessionId: "sess_1",
            role: "user",
            time: { created: 100 },
            agent: "zcode-agent",
            model,
          },
          parts: [
            {
              partId: "part_goal_user",
              sessionId: "sess_1",
              messageId: "msg_goal_user",
              type: "text",
              text: `/goal ${objective}`,
            },
          ],
        },
        {
          info: {
            messageId: "msg_assistant_first",
            sessionId: "sess_1",
            role: "assistant",
            parentMessageId: "msg_goal_user",
            time: { created: 200, completed: 210 },
            agent: "zcode-agent",
            model,
          },
          parts: [
            {
              partId: "part_assistant_first",
              sessionId: "sess_1",
              messageId: "msg_assistant_first",
              type: "text",
              text: "第一轮。",
            },
          ],
        },
        {
          info: {
            messageId: "msg_assistant_second",
            sessionId: "sess_1",
            role: "assistant",
            parentMessageId: "msg_assistant_first",
            time: { created: 220, completed: 230 },
            agent: "zcode-agent",
            model,
          },
          parts: [
            {
              partId: "part_assistant_second",
              sessionId: "sess_1",
              messageId: "msg_assistant_second",
              type: "text",
              text: "第二轮。",
            },
          ],
        },
        {
          info: {
            messageId: "msg_followup_user",
            sessionId: "sess_1",
            role: "user",
            time: { created: 300 },
            agent: "zcode-agent",
            model,
          },
          parts: [
            {
              partId: "part_followup_user",
              sessionId: "sess_1",
              messageId: "msg_followup_user",
              type: "text",
              text: "新问题",
            },
          ],
        },
      ],
    });

    expect(snapshot.messages.map((message) => message.id)).toEqual([
      "msg_goal_user",
      "msg_assistant_first",
      "zcode-goal-verification-goal_1-1",
      "msg_followup_user",
    ]);
    expect(snapshot.messages[1]?.mergedMessageIds).toEqual([
      "msg_assistant_first",
      "msg_assistant_second",
    ]);
  });

  it("uses runtime context usage when restored projection has no usage yet", () => {
    const baseSnapshot = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...baseSnapshot,
      projection: {
        ...baseSnapshot.projection,
        contextUsed: 0,
      },
      runtime: {
        ...baseSnapshot.runtime,
        contextUsage: {
          used: 12345,
          size: 128000,
          cost: null,
          cache: {
            inputTokens: 12345,
            cacheReadTokens: 2345,
            cacheWriteTokens: 678,
            hitRate: 2345 / 12345,
          },
        },
      },
    });

    expect(snapshot.runtime?.contextUsage).toEqual({
      used: 12345,
      size: 128000,
      cost: null,
      cache: {
        inputTokens: 12345,
        cacheReadTokens: 2345,
        cacheWriteTokens: 678,
        hitRate: 2345 / 12345,
      },
    });
  });

  it("maps snapshot runtime apiRetry into legacy task runtime", () => {
    const baseSnapshot = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...baseSnapshot,
      runtime: {
        ...baseSnapshot.runtime,
        apiRetry: {
          kind: "api_retry",
          attempt: 1,
          maxRetries: 3,
          retryDelayMs: 2_000,
          errorStatus: 429,
          error: "rate limited",
        },
      },
    });

    expect(snapshot.runtime?.apiRetry).toEqual({
      kind: "api_retry",
      attempt: 1,
      maxRetries: 3,
      retryDelayMs: 2_000,
      errorStatus: 429,
      error: "rate limited",
    });
  });

  it("maps projection background jobs into runtime background bash jobs", () => {
    const baseSnapshot = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...baseSnapshot,
      projection: {
        ...baseSnapshot.projection,
        backgroundJobs: [
          {
            id: "bg-1",
            kind: "background_bash",
            command: "python -m http.server 3000",
            status: "running",
            startedAt: 10_000,
            pid: 123,
          },
        ],
      },
    });

    expect(snapshot.runtime?.backgroundBashJobs).toEqual([
      expect.objectContaining({
        jobId: "bg-1",
        command: "python -m http.server 3000",
        status: "running",
        startedAt: 10_000,
        pid: 123,
      }),
    ]);
  });

  it("does not project legacy compact timelineText as visible assistant content", () => {
    const internalSummary =
      "This session is being continued from a previous conversation that was compacted.";
    const baseSnapshot = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...baseSnapshot,
      messages: [
        {
          info: {
            messageId: "msg_compact",
            sessionId: "sess_1",
            role: "assistant",
            parentMessageId: "msg_user",
            time: { created: 20, completed: 21 },
            agent: "zcode-agent",
            model,
            cost: 0,
            tokens: {
              input: 1,
              output: 1,
              reasoning: 0,
              total: 2,
              cache: { read: 0, write: 0 },
            },
          },
          parts: [
            {
              partId: "part_compact",
              sessionId: "sess_1",
              messageId: "msg_compact",
              type: "compaction",
              auto: true,
              summaryMessageId: "msg_summary",
              timelineText: internalSummary,
              metadata: {
                operationId: "compact-legacy",
                timelineStatus: "completed",
                trigger: "auto",
              },
            } as unknown as ZCodeMessagePart,
          ],
        },
      ],
    });

    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]).toMatchObject({
      id: "msg_compact",
      role: "assistant",
      content: "",
      syntheticTimeline: {
        type: "context_compaction",
        operationId: "compact-legacy",
        status: "completed",
        trigger: "auto",
      },
    });
    expect(snapshot.messages[0]?.parts ?? []).toEqual([]);
    expect(JSON.stringify(snapshot.messages)).not.toContain(internalSummary);
  });

  it("does not synthesize a compact divider from summary user compaction metadata", () => {
    const baseSnapshot = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...baseSnapshot,
      messages: [
        {
          info: {
            messageId: "msg_summary",
            sessionId: "sess_1",
            role: "user",
            time: { created: 30 },
            agent: "zcode-agent",
            model,
          },
          parts: [
            {
              partId: "part_summary_compaction",
              sessionId: "sess_1",
              messageId: "msg_summary",
              type: "compaction",
              auto: false,
              metadata: {
                operationId: "cmp-summary",
                phase: "standalone_turn",
                trigger: "manual",
              },
            },
          ],
        },
      ],
    });

    expect(snapshot.messages).toEqual([]);
  });

  it("keeps compact summary messages hidden while rendering the lifecycle divider", () => {
    const baseSnapshot = createSnapshot();
    const summaryText =
      "This session is being continued from a previous conversation that ran out of context.";
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...baseSnapshot,
      messages: [
        {
          info: {
            messageId: "msg_compact_lifecycle",
            sessionId: "sess_1",
            role: "assistant",
            parentMessageId: "msg_user",
            time: { created: 20, completed: 21 },
            agent: "zcode-agent",
            model,
            cost: 0,
            tokens: {
              input: 1,
              output: 1,
              reasoning: 0,
              total: 2,
              cache: { read: 0, write: 0 },
            },
          },
          parts: [
            {
              partId: "part_compact_lifecycle",
              sessionId: "sess_1",
              messageId: "msg_compact_lifecycle",
              type: "compaction",
              auto: true,
              summaryMessageId: "msg_summary",
              metadata: {
                operationId: "cmp-visible-divider",
                timelineStatus: "completed",
                trigger: "auto",
                replace: true,
              },
            },
          ],
        },
        {
          info: {
            messageId: "msg_summary",
            sessionId: "sess_1",
            role: "user",
            time: { created: 22 },
            agent: "zcode-agent",
            model,
            summary: {
              title: "Compact summary",
              body: "Summary:\nEarlier work.",
              diffs: [],
            },
          },
          parts: [
            {
              partId: "part_summary_text",
              sessionId: "sess_1",
              messageId: "msg_summary",
              type: "text",
              text: summaryText,
              synthetic: true,
            },
            {
              partId: "part_summary_compaction",
              sessionId: "sess_1",
              messageId: "msg_summary",
              type: "compaction",
              auto: true,
              metadata: {
                operationId: "cmp-visible-divider",
                trigger: "auto",
              },
            },
          ],
        },
      ],
    });

    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]).toMatchObject({
      id: "msg_compact_lifecycle",
      role: "assistant",
      content: "",
      syntheticTimeline: {
        type: "context_compaction",
        operationId: "cmp-visible-divider",
        status: "completed",
        trigger: "auto",
        replace: true,
        summaryMessageId: "msg_summary",
      },
    });
    expect(JSON.stringify(snapshot.messages)).not.toContain(summaryText);
  });

  it("adds a fallback fork divider for legacy fork snapshots without synthetic notice", () => {
    const baseSnapshot = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...baseSnapshot,
      session: {
        ...baseSnapshot.session,
        parentSessionId: "parent-session",
      },
    });

    expect(snapshot.messages).toHaveLength(3);
    expect(snapshot.messages[2]).toMatchObject({
      id: "zcode-timeline-fork-parent-session-",
      role: "user",
      content: "",
      syntheticTimeline: {
        type: "session_fork",
        display: "separator",
        parentSessionId: "parent-session",
        targetMessageId: "",
      },
    });
  });

  it("projects /goal continuation reminders back to the visible slash command query", () => {
    const internalGoalPrompt = [
      '<system-reminder source="goal-continuation">',
      "Continue working toward the active session goal.",
      "",
      "<untrusted_objective>",
      "优化性能到 60fps",
      "</untrusted_objective>",
      "</system-reminder>",
    ].join("\n");
    const baseSnapshot = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...baseSnapshot,
      session: {
        ...baseSnapshot.session,
        title: internalGoalPrompt,
      },
      projection: {
        ...baseSnapshot.projection,
        target: {
          sessionId: "sess_1",
          targetId: "goal_1",
          objective: "优化性能到 60fps",
          summaryTitle: "优化性能到 60fps",
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      messages: [
        {
          info: {
            messageId: "msg_goal_internal",
            sessionId: "sess_1",
            role: "user",
            time: { created: 100 },
            agent: "zcode-agent",
            model,
          },
          parts: [
            {
              partId: "part_goal_internal",
              sessionId: "sess_1",
              messageId: "msg_goal_internal",
              type: "text",
              text: internalGoalPrompt,
            },
          ],
        },
        {
          info: {
            messageId: "msg_goal_assistant",
            sessionId: "sess_1",
            role: "assistant",
            parentMessageId: "msg_goal_internal",
            time: { created: 200, completed: 300 },
            agent: "zcode-agent",
            model,
            path: { cwd: "/workspace/app", root: "/workspace/app" },
            cost: 0,
            tokens: {
              input: 1,
              output: 2,
              reasoning: 0,
              total: 3,
              cache: { read: 0, write: 0 },
            },
          },
          parts: [
            {
              partId: "part_goal_assistant_text",
              sessionId: "sess_1",
              messageId: "msg_goal_assistant",
              type: "text",
              text: "我会先定位渲染瓶颈。",
            },
          ],
        },
      ],
    });

    expect(snapshot.meta.title).toBe("优化性能到 60fps");
    expect(snapshot.meta.target).toMatchObject({
      objective: "优化性能到 60fps",
      summaryTitle: "优化性能到 60fps",
      targetID: "goal_1",
    });
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0]).toMatchObject({
      role: "user",
      content: "/goal 优化性能到 60fps",
    });
    expect(snapshot.messages[0]?.content).not.toContain("system-reminder");
    expect(snapshot.messages[1]).toMatchObject({
      role: "assistant",
      content: "我会先定位渲染瓶颈。",
      goalIteration: 1,
    });
  });

  it("keeps verifier-bounded goal continuation assistant messages split by goal iteration in snapshots", () => {
    const objective = "优化性能到 60fps";
    const baseSnapshot = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...baseSnapshot,
      projection: {
        ...baseSnapshot.projection,
        target: {
          sessionId: "sess_1",
          targetId: "goal_1",
          objective,
          summaryTitle: null,
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 100,
          updatedAt: 100,
        },
      },
      runtime: {
        ...baseSnapshot.runtime,
        goalVerificationTimeline: [
          {
            version: 1,
            kind: "synthetic",
            type: "goal_verification",
            display: "separator",
            targetId: "goal_1",
            verificationId: "verify_goal_1",
            status: "completed",
            goalIteration: 1,
            verification: {
              nextAction: "继续做第二轮。",
              passed: false,
              reason: "第一轮还没完成。",
            },
            startedAt: 300,
            updatedAt: 300,
          },
        ],
      },
      messages: [
        {
          info: {
            messageId: "msg_user_goal",
            sessionId: "sess_1",
            role: "user",
            time: { created: 100 },
            agent: "zcode-agent",
            model,
          },
          parts: [
            {
              partId: "part_user_goal",
              sessionId: "sess_1",
              messageId: "msg_user_goal",
              type: "text",
              text: `/goal ${objective}`,
            },
          ],
        },
        {
          info: {
            messageId: "msg_assistant_goal_1",
            sessionId: "sess_1",
            role: "assistant",
            parentMessageId: "msg_user_goal",
            time: { created: 200, completed: 250 },
            agent: "zcode-agent",
            model,
            path: { cwd: "/workspace/app", root: "/workspace/app" },
            cost: 0,
            tokens: {
              input: 1,
              output: 2,
              reasoning: 0,
              total: 3,
              cache: { read: 0, write: 0 },
            },
          },
          parts: [
            {
              partId: "part_assistant_goal_1",
              sessionId: "sess_1",
              messageId: "msg_assistant_goal_1",
              type: "text",
              text: "第一轮。",
            },
          ],
        },
        {
          info: {
            messageId: "msg_goal_continue",
            sessionId: "sess_1",
            role: "user",
            time: { created: 300 },
            agent: "zcode-agent",
            model,
            synthetic: true,
            source: "goal-continuation",
            visibility: "model-only",
            metadata: { source: "goal-continuation", visibility: "model-only" },
          },
          parts: [
            {
              partId: "part_goal_continue",
              sessionId: "sess_1",
              messageId: "msg_goal_continue",
              type: "text",
              text: "<system-reminder>\nContinue working toward the active session goal.\n</system-reminder>",
              synthetic: true,
              metadata: {
                source: "goal-continuation",
                visibility: "model-only",
              },
            },
          ],
        },
        {
          info: {
            messageId: "msg_assistant_goal_2",
            sessionId: "sess_1",
            role: "assistant",
            parentMessageId: "msg_goal_continue",
            time: { created: 400, completed: 450 },
            agent: "zcode-agent",
            model,
            path: { cwd: "/workspace/app", root: "/workspace/app" },
            cost: 0,
            tokens: {
              input: 1,
              output: 2,
              reasoning: 0,
              total: 3,
              cache: { read: 0, write: 0 },
            },
          },
          parts: [
            {
              partId: "part_assistant_goal_2",
              sessionId: "sess_1",
              messageId: "msg_assistant_goal_2",
              type: "text",
              text: "第二轮。",
            },
          ],
        },
      ],
    });

    expect(snapshot.messages).toHaveLength(4);
    expect(snapshot.messages[1]).toMatchObject({
      role: "assistant",
      content: "第一轮。",
      goalIteration: 1,
    });
    expect(snapshot.messages[2]).toMatchObject({
      role: "assistant",
      content: "",
      syntheticTimeline: {
        type: "goal_verification",
        verificationId: "verify_goal_1",
        goalIteration: 1,
      },
    });
    expect(snapshot.messages[3]).toMatchObject({
      role: "assistant",
      content: "第二轮。",
      goalIteration: 2,
    });
  });

  it("restores /goal prefix for persisted objective user messages", () => {
    const objective = "优化性能到 60fps";
    const baseSnapshot = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...baseSnapshot,
      projection: {
        ...baseSnapshot.projection,
        target: {
          sessionId: "sess_1",
          targetId: "goal_1",
          objective,
          summaryTitle: null,
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 100,
          updatedAt: 100,
        },
      },
      messages: [
        {
          info: {
            messageId: "msg_goal_objective",
            sessionId: "sess_1",
            role: "user",
            time: { created: 100 },
            agent: "zcode-agent",
            model,
          },
          parts: [
            {
              partId: "part_goal_objective",
              sessionId: "sess_1",
              messageId: "msg_goal_objective",
              type: "text",
              text: objective,
            },
          ],
        },
      ],
    });

    expect(snapshot.meta.title).toBe(objective);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]).toMatchObject({
      role: "user",
      content: `/goal ${objective}`,
    });
  });

  it("does not add /goal to earlier normal user messages with the same text", () => {
    const objective = "优化性能到 60fps";
    const baseSnapshot = createSnapshot();
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...baseSnapshot,
      projection: {
        ...baseSnapshot.projection,
        target: {
          sessionId: "sess_1",
          targetId: "goal_1",
          objective,
          summaryTitle: null,
          status: "active",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 200,
          updatedAt: 200,
        },
      },
      messages: [
        {
          info: {
            messageId: "msg_normal_user",
            sessionId: "sess_1",
            role: "user",
            time: { created: 100 },
            agent: "zcode-agent",
            model,
          },
          parts: [
            {
              partId: "part_normal_user",
              sessionId: "sess_1",
              messageId: "msg_normal_user",
              type: "text",
              text: objective,
            },
          ],
        },
      ],
    });

    expect(snapshot.messages[0]).toMatchObject({
      role: "user",
      content: objective,
    });
  });

  it("maps ZCode Protocol context projection updates to legacy usage_update events", () => {
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: {
          eventId: "evt_usage",
          sessionId: "sess_1",
          seq: 4,
          timestamp: 4,
          traceId: "trace_usage",
          type: "session.updated",
          payload: {
            contextUsed: 24000,
            contextWindow: 128000,
          },
        },
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        type: "usage_update",
        taskId: "sess_1",
        traceId: "trace_usage",
        used: 24000,
        size: 128000,
        cost: null,
      },
    ]);
  });

  it("preserves goal target run action patches", () => {
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: {
          eventId: "evt_goal_run_started",
          sessionId: "sess_1",
          seq: 4,
          timestamp: 4,
          traceId: "trace_goal_run",
          type: "session.updated",
          payload: {
            action: "run_started",
            source: "runtime",
            target: {
              activeInputId: "input-1",
              activeRunLastSeenAtMs: 4_000,
              activeRunStartedAtMs: 4_000,
              createdAt: 1,
              objective: "Fix elapsed",
              sessionId: "sess_1",
              status: "active",
              summaryTitle: null,
              targetId: "target-1",
              timeUsedSeconds: 0,
              tokenBudget: null,
              tokensUsed: 0,
              updatedAt: 4_000,
            },
          },
        },
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        target: {
          action: "run_started",
          source: "runtime",
          target: {
            activeInputId: "input-1",
            activeRunLastSeenAtMs: 4_000,
            activeRunStartedAtMs: 4_000,
            objective: "Fix elapsed",
            sessionID: "sess_1",
            status: "active",
            summaryTitle: null,
            targetID: "target-1",
            time: { created: 1, updated: 4_000 },
            timeUsedSeconds: 0,
            tokenBudget: null,
            tokensUsed: 0,
          },
        },
        taskId: "sess_1",
        traceId: "trace_goal_run",
        type: "session_info_update",
      },
    ]);
  });

  it("maps model streaming tool input into pending tool call previews", () => {
    const state = {
      streamingToolInputById: new Map(),
      toolNameById: new Map<string, string>(),
    };
    const common = {
      sessionId: "sess_1",
      seq: 4,
      timestamp: 4,
      traceId: "trace_tool_input",
      type: "model.streaming" as const,
    };

    const startEvents = zcodeSessionEventToZCodeStreamEvents({
      event: {
        ...common,
        eventId: "evt_tool_input_start",
        payload: {
          kind: "tool_input_start",
          toolCallId: "call_write",
          toolName: "Write",
        },
      },
      state,
      taskId: "sess_1",
    });
    expect(startEvents).toEqual([
      expect.objectContaining({
        type: "tool_call",
        toolId: "call_write",
        toolName: "Write",
        input: {},
      }),
    ]);

    const deltaEvents = zcodeSessionEventToZCodeStreamEvents({
      event: {
        ...common,
        eventId: "evt_tool_input_delta",
        payload: {
          kind: "tool_input_delta",
          toolCallId: "call_write",
          delta: '{"file_path":"src/app.ts","content":"line 1\\nline 2',
        },
      },
      state,
      taskId: "sess_1",
    });
    expect(deltaEvents).toEqual([
      expect.objectContaining({
        type: "tool_call_update",
        toolId: "call_write",
        status: "pending",
        input: {
          file_path: "src/app.ts",
          content: "line 1\nline 2",
        },
      }),
    ]);

    const nextDeltaEvents = zcodeSessionEventToZCodeStreamEvents({
      event: {
        ...common,
        eventId: "evt_tool_input_delta_2",
        payload: {
          kind: "tool_input_delta",
          toolCallId: "call_write",
          delta: "\\nline 3",
        },
      },
      state,
      taskId: "sess_1",
    });
    expect(nextDeltaEvents).toEqual([]);
    expect(state.streamingToolInputById?.get("call_write")?.rawInput).toContain("\\nline 3");

    const endEvents = zcodeSessionEventToZCodeStreamEvents({
      event: {
        ...common,
        eventId: "evt_tool_input_end",
        payload: {
          kind: "tool_input_end",
          toolCallId: "call_write",
        },
      },
      state,
      taskId: "sess_1",
    });
    expect(endEvents).toEqual([
      expect.objectContaining({
        type: "tool_call_update",
        toolId: "call_write",
        toolName: "Write",
        raw: expect.objectContaining({
          streamingRawInputLength: expect.any(Number),
        }),
      }),
    ]);
    expect(endEvents[0]).not.toHaveProperty("input");
    expect(state.streamingToolInputById?.get("call_write")?.rawInput).toContain("\\nline 3");

    const completeEvents = zcodeSessionEventToZCodeStreamEvents({
      event: {
        ...common,
        eventId: "evt_tool_call",
        payload: {
          kind: "tool_call",
          toolCallId: "call_write",
          toolName: "Write",
          input: {
            file_path: "src/app.ts",
            content: "line 1\nline 2\n",
          },
        },
      },
      state,
      taskId: "sess_1",
    });
    expect(completeEvents).toEqual([
      expect.objectContaining({
        type: "tool_call_update",
        toolId: "call_write",
        input: {
          file_path: "src/app.ts",
          content: "line 1\nline 2\n",
        },
      }),
    ]);
    expect(state.streamingToolInputById?.get("call_write")?.rawInput).toBe("");
  });

  it("maps scheduled tool tombstones without rematerializing input", () => {
    const state: ZCodeSessionEventProjectionState = {
      streamingToolInputById: new Map(),
      toolNameById: new Map<string, string>(),
    };
    const streamingToolCall = {
      eventId: "evt_tool_call",
      sessionId: "sess_1",
      turnId: "turn_1",
      seq: 4,
      timestamp: 4,
      traceId: "trace_tool_input",
      type: "model.streaming",
      payload: {
        kind: "tool_call",
        toolCallId: "call_write",
        toolName: "Write",
        input: {
          content: "hello",
          file_path: "/tmp/generated.html",
        },
      },
    } satisfies ZCodeSessionEvent;
    const scheduledTombstone = {
      eventId: "evt_tool_scheduled",
      sessionId: "sess_1",
      turnId: "turn_1",
      seq: 5,
      timestamp: 5,
      traceId: "trace_tool_input",
      type: "tool.updated",
      payload: {
        kind: "scheduled",
        toolCallId: "call_write",
        toolName: "Write",
        inputByteLength: 57,
        inputOmitted: true,
        inputRef: "model_stream",
      },
    } satisfies ZCodeSessionEvent;

    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: streamingToolCall,
        state,
        taskId: "sess_1",
      }),
    ).toEqual([
      expect.objectContaining({
        type: "tool_call_update",
        toolId: "call_write",
      }),
    ]);
    const scheduledEvents = zcodeSessionEventToZCodeStreamEvents({
      event: scheduledTombstone,
      state,
      taskId: "sess_1",
    });
    expect(scheduledEvents).toEqual([
      expect.objectContaining({
        raw: expect.not.objectContaining({
          input: expect.anything(),
        }),
        status: "in_progress",
        toolId: "call_write",
        type: "tool_call_update",
      }),
    ]);
    expect(Object.prototype.hasOwnProperty.call(scheduledEvents[0], "input")).toBe(false);
  });

  it("clears streaming raw input when complete tool input is remembered", () => {
    const state: ZCodeSessionEventProjectionState = {
      streamingToolInputById: new Map(),
      toolNameById: new Map<string, string>(),
    };
    const streamingDelta = {
      eventId: "evt_tool_delta",
      sessionId: "sess_1",
      turnId: "turn_1",
      seq: 1,
      timestamp: 1,
      traceId: "trace_tool_input",
      type: "model.streaming",
      payload: {
        kind: "tool_input_delta",
        toolCallId: "call_write",
        toolName: "Write",
        delta: '{"file_path":"/tmp/generated.html","content":"hello"',
      },
    } satisfies ZCodeSessionEvent;
    const scheduledWithCompleteInput = {
      eventId: "evt_tool_scheduled",
      sessionId: "sess_1",
      turnId: "turn_1",
      seq: 2,
      timestamp: 2,
      traceId: "trace_tool_input",
      type: "tool.updated",
      payload: {
        kind: "scheduled",
        toolCallId: "call_write",
        toolName: "Write",
        input: {
          content: "hello",
          file_path: "/tmp/generated.html",
        },
      },
    } satisfies ZCodeSessionEvent;

    zcodeSessionEventToZCodeStreamEvents({
      event: streamingDelta,
      state,
      taskId: "sess_1",
    });
    expect(state.streamingToolInputById?.get("call_write")?.rawInput).toContain("generated.html");

    zcodeSessionEventToZCodeStreamEvents({
      event: scheduledWithCompleteInput,
      state,
      taskId: "sess_1",
    });

    expect(state.streamingToolInputById?.get("call_write")?.rawInput).toBe("");
    expect(state.completeToolInputById?.get("call_write")).toEqual({
      content: "hello",
      file_path: "/tmp/generated.html",
    });
  });

  it("creates missing streaming input state so foreground Write deltas accumulate", () => {
    const state: ZCodeSessionEventProjectionState = {
      toolNameById: new Map<string, string>(),
    };
    const common = {
      sessionId: "sess_1",
      seq: 4,
      timestamp: 4,
      traceId: "trace_tool_input",
      type: "model.streaming" as const,
    };

    zcodeSessionEventToZCodeStreamEvents({
      event: {
        ...common,
        eventId: "evt_tool_input_start",
        payload: {
          kind: "tool_input_start",
          toolCallId: "call_write",
          toolName: "Write",
        },
      },
      state,
      taskId: "sess_1",
    });
    zcodeSessionEventToZCodeStreamEvents({
      event: {
        ...common,
        eventId: "evt_tool_input_delta",
        payload: {
          kind: "tool_input_delta",
          toolCallId: "call_write",
          delta: '{"file_path":"src/app.ts","content":"line 1\\nline 2',
        },
      },
      state,
      taskId: "sess_1",
    });

    const nextDeltaEvents = zcodeSessionEventToZCodeStreamEvents({
      event: {
        ...common,
        eventId: "evt_tool_input_delta_2",
        payload: {
          kind: "tool_input_delta",
          toolCallId: "call_write",
          delta: "\\nline 3",
        },
      },
      state,
      taskId: "sess_1",
    });

    expect(state.streamingToolInputById?.get("call_write")?.deltaCount).toBe(2);
    expect(nextDeltaEvents).toEqual([]);

    const endEvents = zcodeSessionEventToZCodeStreamEvents({
      event: {
        ...common,
        eventId: "evt_tool_input_end",
        payload: {
          kind: "tool_input_end",
          toolCallId: "call_write",
        },
      },
      state,
      taskId: "sess_1",
    });
    expect(endEvents).toEqual([
      expect.objectContaining({
        type: "tool_call_update",
        toolId: "call_write",
        raw: expect.objectContaining({
          streamingRawInputLength: expect.any(Number),
        }),
      }),
    ]);
    expect(endEvents[0]).not.toHaveProperty("input");
  });

  it("infers Write for streamed file inputs when the delta arrives without cached tool metadata", () => {
    const streamEvents = zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_tool_input_delta_no_name",
        sessionId: "sess_1",
        seq: 4,
        timestamp: 4,
        traceId: "trace_tool_input",
        type: "model.streaming",
        payload: {
          kind: "tool_input_delta",
          toolCallId: "call_write",
          delta: '{"file_path":"src/app.ts","content":"line 1',
        },
      },
      state: {
        streamingToolInputById: new Map(),
        toolNameById: new Map<string, string>(),
      },
      taskId: "sess_1",
    });

    expect(streamEvents).toEqual([
      expect.objectContaining({
        type: "tool_call_update",
        toolId: "call_write",
        toolName: "Write",
        kind: "Write",
      }),
    ]);
  });

  it("keeps background streaming tool input as a tombstone until materialization", () => {
    const state: ZCodeSessionEventProjectionState = {
      streamingToolInputById: new Map(),
      toolNameById: new Map<string, string>(),
    };
    const common = {
      sessionId: "sess_1",
      seq: 4,
      timestamp: 4,
      traceId: "trace_tool_input",
      type: "model.streaming" as const,
    };

    const startEvents = zcodeSessionEventToZCodeStreamEvents({
      event: {
        ...common,
        eventId: "evt_tool_input_start",
        payload: {
          kind: "tool_input_start",
          toolCallId: "call_write",
          toolName: "Write",
        },
      },
      projectionMode: "background-summary",
      state,
      taskId: "sess_1",
    });
    const deltaEvents = zcodeSessionEventToZCodeStreamEvents({
      event: {
        ...common,
        eventId: "evt_tool_input_delta",
        payload: {
          kind: "tool_input_delta",
          toolCallId: "call_write",
          delta: '{"file_path":"src/app.ts","content":"line 1\\nline 2',
        },
      },
      projectionMode: "background-summary",
      state,
      taskId: "sess_1",
    });

    expect(startEvents).toHaveLength(1);
    expect(deltaEvents).toEqual([]);
    expect(state.streamingToolInputById?.get("call_write")).toMatchObject({
      deltaCount: 1,
      rawInput: '{"file_path":"src/app.ts","content":"line 1\\nline 2',
    });

    const completeEvents = zcodeSessionEventToZCodeStreamEvents({
      event: {
        ...common,
        eventId: "evt_tool_call",
        payload: {
          kind: "tool_call",
          toolCallId: "call_write",
          toolName: "Write",
          input: {
            file_path: "src/app.ts",
            content: "line 1\nline 2",
          },
        },
      },
      projectionMode: "background-summary",
      state,
      taskId: "sess_1",
    });

    expect(completeEvents).toEqual([
      expect.objectContaining({
        type: "tool_call_update",
        toolId: "call_write",
        input: {
          file_path: "src/app.ts",
          content: "line 1\nline 2",
        },
      }),
    ]);
  });

  it("budgets active streaming tool input previews instead of projecting every delta", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const state: ZCodeSessionEventProjectionState = {
        streamingToolInputById: new Map(),
        toolNameById: new Map<string, string>(),
      };
      const common = {
        sessionId: "sess_1",
        seq: 4,
        timestamp: 4,
        traceId: "trace_tool_input",
        type: "model.streaming" as const,
      };

      zcodeSessionEventToZCodeStreamEvents({
        event: {
          ...common,
          eventId: "evt_tool_input_start",
          payload: {
            kind: "tool_input_start",
            toolCallId: "call_write",
            toolName: "Write",
          },
        },
        state,
        taskId: "sess_1",
      });

      let materializedCount = 0;
      for (let index = 0; index < 100; index += 1) {
        const events = zcodeSessionEventToZCodeStreamEvents({
          event: {
            ...common,
            eventId: `evt_tool_input_delta_${index}`,
            payload: {
              kind: "tool_input_delta",
              toolCallId: "call_write",
              delta: "x",
            },
          },
          state,
          taskId: "sess_1",
        });
        materializedCount += events.length;
      }

      expect(state.streamingToolInputById?.get("call_write")?.deltaCount).toBe(100);
      expect(materializedCount).toBe(1);

      vi.setSystemTime(2_000);
      const intervalEvents = zcodeSessionEventToZCodeStreamEvents({
        event: {
          ...common,
          eventId: "evt_tool_input_delta_interval",
          payload: {
            kind: "tool_input_delta",
            toolCallId: "call_write",
            delta: "y",
          },
        },
        state,
        taskId: "sess_1",
      });
      expect(intervalEvents).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps goal completion verifier model results to goal verification updates", () => {
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: {
          eventId: "evt_goal_verify",
          sessionId: "sess_1",
          seq: 4,
          timestamp: 4,
          traceId: "trace_goal_verify",
          type: "session.updated",
          payload: {
            content: JSON.stringify({
              nextAction: "跑移动端 smoke test。",
              passed: false,
              reason: "第一轮证据不足。",
            }),
            querySource: "target_completion_verification",
            stopReason: "stop",
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
            },
          },
        },
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        type: "goal_verification_update",
        taskId: "sess_1",
        traceId: "trace_goal_verify",
        verification: {
          nextAction: "跑移动端 smoke test。",
          passed: false,
          reason: "第一轮证据不足。",
        },
      },
      {
        type: "task_token_usage_delta",
        taskId: "sess_1",
        traceId: "trace_goal_verify",
        eventId: "evt_goal_verify",
        eventKey: "evt_goal_verify",
        querySource: "target_completion_verification",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        },
      },
    ]);
  });

  it("does not synthesize nextAction when goal completion verifier JSON is invalid", () => {
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: {
          eventId: "evt_goal_verify_invalid",
          sessionId: "sess_1",
          seq: 4,
          timestamp: 4,
          traceId: "trace_goal_verify",
          type: "session.updated",
          payload: {
            content: "not json",
            querySource: "target_completion_verification",
            stopReason: "stop",
          },
        },
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        type: "goal_verification_update",
        taskId: "sess_1",
        traceId: "trace_goal_verify",
        verification: {
          passed: true,
          reason: "The completion verifier did not return valid JSON.",
        },
      },
    ]);
  });

  it("maps goal verification lifecycle payloads to synthetic divider chunks", () => {
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: {
          eventId: "evt_goal_verify_started",
          sessionId: "sess_1",
          seq: 4,
          timestamp: 42,
          traceId: "trace_goal_verify",
          type: "session.updated",
          payload: {
            status: "started",
            targetId: "target_1",
            verificationId: "verify_1",
            goalIteration: 2,
            anchorAssistantMessageId: "assistant_1",
            anchorTurnId: "turn_1",
          },
        },
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        type: "agent_message_chunk",
        taskId: "sess_1",
        traceId: "trace_goal_verify",
        messageId: "zcode-goal-verification-target_1-2",
        content: "",
        zcodeTimeline: {
          version: 1,
          kind: "synthetic",
          type: "goal_verification",
          display: "separator",
          targetId: "target_1",
          verificationId: "verify_1",
          goalIteration: 2,
          anchorAssistantMessageId: "assistant_1",
          anchorTurnId: "turn_1",
          status: "started",
          startedAt: 42,
          updatedAt: 42,
        },
      },
    ]);
  });

  it("maps completed goal verification lifecycle payloads with verifier result", () => {
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: {
          eventId: "evt_goal_verify_completed",
          sessionId: "sess_1",
          seq: 5,
          timestamp: 52,
          traceId: "trace_goal_verify",
          type: "session.updated",
          payload: {
            status: "completed",
            targetId: "target_1",
            verificationId: "verify_1",
            goalIteration: 3,
            verification: {
              nextAction: null,
              passed: true,
              reason: "所有目标要求都已完成。",
            },
          },
        },
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        type: "agent_message_chunk",
        taskId: "sess_1",
        traceId: "trace_goal_verify",
        messageId: "zcode-goal-verification-target_1-3",
        content: "",
        zcodeTimeline: {
          version: 1,
          kind: "synthetic",
          type: "goal_verification",
          display: "separator",
          targetId: "target_1",
          verificationId: "verify_1",
          status: "completed",
          goalIteration: 3,
          verification: {
            passed: true,
            reason: "所有目标要求都已完成。",
          },
          updatedAt: 52,
        },
      },
    ]);
  });

  it.each(["plan", "edit"] as const)("maps %s mode updates without replacing historical values", (mode) => {
    const events = zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_mode",
        sessionId: "sess_1",
        seq: 4,
        timestamp: 4,
        traceId: "trace_mode",
        type: "session.updated",
        payload: {
          mode,
          previousMode: "build",
          source: "tool",
        },
      },
      taskId: "sess_1",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        type: "mode_update",
        taskId: "sess_1",
        traceId: "trace_mode",
        currentModeId: mode,
        availableModes: expect.arrayContaining([
          expect.objectContaining({ id: "build" }),
          expect.objectContaining({ id: "guarded" }),
          expect.objectContaining({ id: "plan" }),
          expect.objectContaining({ id: "yolo" }),
        ]),
      }),
    );
  });

  it("maps main turn model usage with context window to legacy usage_update events", () => {
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: {
          eventId: "evt_model_usage",
          sessionId: "sess_1",
          seq: 5,
          timestamp: 5,
          traceId: "trace_model_usage",
          type: "session.updated",
          payload: {
            contextWindow: 1_000_000,
            querySource: "main_turn",
            usage: {
              inputTokens: 279454,
              outputTokens: 177,
              totalTokens: 279631,
              cacheReadTokens: 1000,
              cacheWriteTokens: 200,
              cacheHitRate: 0.25,
            },
            contextUsageBreakdown: [
              { source: "messages", chars: 1200 },
              { source: "system_tool_schemas", chars: 300 },
            ],
          },
        },
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        type: "task_token_usage_delta",
        taskId: "sess_1",
        traceId: "trace_model_usage",
        eventKey: "evt_model_usage",
        eventId: "evt_model_usage",
        querySource: "main_turn",
        usage: {
          inputTokens: 279454,
          outputTokens: 177,
          totalTokens: 279631,
          reasoningTokens: undefined,
          cachedInputTokens: 1000,
          cachedWriteInputTokens: 200,
        },
      },
      {
        type: "usage_update",
        taskId: "sess_1",
        traceId: "trace_model_usage",
        used: 279631,
        size: 1_000_000,
        cost: null,
        cache: {
          inputTokens: 279454,
          cacheReadTokens: 1000,
          cacheWriteTokens: 200,
          latestHitRate: 0.25,
          hitRate: 0.25,
        },
        breakdown: [
          { source: "messages", chars: 1200 },
          { source: "system_tool_schemas", chars: 300 },
        ],
      },
    ]);
  });

  it("maps model network status payloads to task network debug events", () => {
    const events = zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_network_debug",
        sessionId: "sess_1",
        seq: 5,
        timestamp: 5,
        traceId: "trace_network_debug",
        type: "session.updated",
        payload: {
          type: "model_retry_scheduled",
          requestId: "request-1",
          timestamp: "2026-06-10T00:00:00.000Z",
          model: {
            providerId: "openai",
            modelId: "model-test",
          },
          transport: "http",
          attempt: 1,
          maxAttempts: 3,
          nextAttempt: 2,
          delayMs: 1000,
          reason: "rate_limited",
          message: "rate limited",
          statusCode: 429,
          requestHeaders: {
            authorization: "[redacted]",
          },
          responseHeaders: {
            "retry-after": "1",
          },
        },
      },
      taskId: "sess_1",
    });

    expect(events).toContainEqual({
      type: "task_network_debug_status",
      taskId: "sess_1",
      traceId: "trace_network_debug",
      eventKey: "evt_network_debug",
      eventId: "evt_network_debug",
      statusType: "model_retry_scheduled",
      requestId: "request-1",
      providerId: "openai",
      modelId: "model-test",
      transport: "http",
      attempt: 1,
      maxAttempts: 3,
      nextAttempt: 2,
      statusCode: 429,
      delayMs: 1000,
      reason: "rate_limited",
      message: "rate limited",
      timestamp: "2026-06-10T00:00:00.000Z",
      requestHeaders: {
        authorization: "[redacted]",
      },
      responseHeaders: {
        "retry-after": "1",
      },
      requestHeaderCount: 1,
      responseHeaderCount: 1,
    });
  });

  it("maps aggregate main turn cache hit usage from protocol payload", () => {
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: {
          eventId: "evt_model_usage_average",
          sessionId: "sess_1",
          seq: 5,
          timestamp: 5,
          traceId: "trace_model_usage_average",
          type: "session.updated",
          payload: {
            contextWindow: 1_000_000,
            querySource: "main_turn",
            cacheHit: {
              inputTokens: 200,
              cacheReadTokens: 80,
              cacheWriteTokens: 10,
              latestHitRate: 0.4,
              hitRate: 0.3,
              hitRateRequestCount: 2,
              totalInputTokens: 500,
              totalCacheReadTokens: 150,
              totalCacheWriteTokens: 25,
            },
            usage: {
              inputTokens: 200,
              outputTokens: 20,
              totalTokens: 220,
              cacheReadTokens: 80,
              cacheWriteTokens: 10,
            },
          },
        },
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        type: "task_token_usage_delta",
        taskId: "sess_1",
        traceId: "trace_model_usage_average",
        eventKey: "evt_model_usage_average",
        eventId: "evt_model_usage_average",
        querySource: "main_turn",
        usage: {
          inputTokens: 200,
          outputTokens: 20,
          totalTokens: 220,
          reasoningTokens: undefined,
          cachedInputTokens: 80,
          cachedWriteInputTokens: 10,
        },
      },
      {
        type: "usage_update",
        taskId: "sess_1",
        traceId: "trace_model_usage_average",
        used: 220,
        size: 1_000_000,
        cost: null,
        cache: {
          inputTokens: 200,
          cacheReadTokens: 80,
          cacheWriteTokens: 10,
          latestHitRate: 0.4,
          hitRate: 0.3,
          hitRateRequestCount: 2,
          totalInputTokens: 500,
          totalCacheReadTokens: 150,
          totalCacheWriteTokens: 25,
        },
      },
    ]);
  });

  it("prefers real main turn model usage over projected context used", () => {
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: {
          eventId: "evt_model_usage_projection",
          sessionId: "sess_1",
          seq: 5,
          timestamp: 5,
          traceId: "trace_model_usage_projection",
          type: "session.updated",
          payload: {
            contextUsed: 64000,
            contextWindow: 1_000_000,
            querySource: "main_turn",
            usage: {
              inputTokens: 12345,
              outputTokens: 77,
              totalTokens: 12422,
            },
          },
        },
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        type: "task_token_usage_delta",
        taskId: "sess_1",
        traceId: "trace_model_usage_projection",
        eventKey: "evt_model_usage_projection",
        eventId: "evt_model_usage_projection",
        querySource: "main_turn",
        usage: {
          inputTokens: 12345,
          outputTokens: 77,
          totalTokens: 12422,
          reasoningTokens: undefined,
          cachedInputTokens: undefined,
          cachedWriteInputTokens: undefined,
        },
      },
      {
        type: "usage_update",
        taskId: "sess_1",
        traceId: "trace_model_usage_projection",
        used: 12422,
        size: 1_000_000,
        cost: null,
      },
    ]);
  });

  it("does not map sidecar model usage to context usage", () => {
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: {
          eventId: "evt_title_usage",
          sessionId: "sess_1",
          seq: 6,
          timestamp: 6,
          traceId: "trace_title_usage",
          type: "session.updated",
          payload: {
            contextWindow: 1_000_000,
            querySource: "session_title",
            usage: {
              inputTokens: 89,
              outputTokens: 84,
              totalTokens: 173,
            },
          },
        },
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        type: "task_token_usage_delta",
        taskId: "sess_1",
        traceId: "trace_title_usage",
        eventKey: "evt_title_usage",
        eventId: "evt_title_usage",
        querySource: "session_title",
        usage: {
          inputTokens: 89,
          outputTokens: 84,
          totalTokens: 173,
          reasoningTokens: undefined,
          cachedInputTokens: undefined,
          cachedWriteInputTokens: undefined,
        },
      },
    ]);
  });

  it("maps ZCode model retry status updates to apiRetry events", () => {
    const events = zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_retry",
        sessionId: "sess_1",
        seq: 5,
        timestamp: 5,
        traceId: "trace_retry",
        type: "session.updated",
        payload: {
          type: "model_retry_scheduled",
          attempt: 1,
          maxAttempts: 4,
          delayMs: 2_000,
          statusCode: 429,
          message: "rate limited",
        },
      },
      taskId: "sess_1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "task_network_debug_status",
        taskId: "sess_1",
        traceId: "trace_retry",
        eventKey: "evt_retry",
        statusType: "model_retry_scheduled",
        attempt: 1,
        maxAttempts: 4,
        delayMs: 2_000,
        statusCode: 429,
      }),
    );
    expect(events).toContainEqual({
      type: "session_info_update",
      taskId: "sess_1",
      traceId: "trace_retry",
      apiRetry: {
        kind: "api_retry",
        attempt: 1,
        maxRetries: 3,
        retryDelayMs: 2_000,
        errorStatus: 429,
        error: "rate limited",
      },
    });
  });

  it("keeps adapter retry visible until the retry attempt produces progress", () => {
    const state: ZCodeSessionEventProjectionState = {
      streamedTurnKeys: new Set<string>(),
      toolNameById: new Map<string, string>(),
    };

    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: {
          eventId: "evt_retry_scheduled",
          sessionId: "sess_1",
          seq: 5,
          timestamp: 5,
          traceId: "trace_retry",
          type: "session.updated",
          payload: {
            type: "model_retry_scheduled",
            attempt: 1,
            maxAttempts: 4,
            delayMs: 2_000,
            message: "rate limited",
          },
        },
        state,
        taskId: "sess_1",
      }),
    ).toContainEqual({
      type: "session_info_update",
      taskId: "sess_1",
      traceId: "trace_retry",
      apiRetry: {
        kind: "api_retry",
        attempt: 1,
        maxRetries: 3,
        retryDelayMs: 2_000,
        errorStatus: null,
        error: "rate limited",
      },
    });

    const retryStartedEvents = zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_retry_started",
        sessionId: "sess_1",
        seq: 6,
        timestamp: 6,
        traceId: "trace_retry",
        type: "session.updated",
        payload: {
          type: "model_request_started",
          attempt: 2,
          maxAttempts: 4,
          requestId: "request_retry",
        },
      },
      state,
      taskId: "sess_1",
    });

    expect(retryStartedEvents).toContainEqual(
      expect.objectContaining({
        type: "task_network_debug_status",
        taskId: "sess_1",
        traceId: "trace_retry",
        eventKey: "evt_retry_started",
        statusType: "model_request_started",
        attempt: 2,
        maxAttempts: 4,
      }),
    );
    expect(retryStartedEvents).not.toContainEqual({
      type: "session_info_update",
      taskId: "sess_1",
      traceId: "trace_retry",
      apiRetry: null,
    });

    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: {
          eventId: "evt_retry_progress",
          sessionId: "sess_1",
          seq: 7,
          timestamp: 7,
          traceId: "trace_retry",
          type: "session.updated",
          payload: {
            kind: "reasoning_delta",
            delta: "recovered",
            assistantMessageId: "msg_retry",
          },
        },
        state,
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        type: "session_info_update",
        taskId: "sess_1",
        traceId: "trace_retry",
        apiRetry: null,
      },
      {
        type: "agent_thought_chunk",
        taskId: "sess_1",
        traceId: "trace_retry",
        content: "recovered",
      },
    ]);
  });

  it("maps core stream recovery request starts to apiRetry events", () => {
    const events = zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_stream_recovery_retry",
        sessionId: "sess_1",
        seq: 5,
        timestamp: 5,
        traceId: "trace_retry",
        type: "session.updated",
        payload: {
          type: "model_request_started",
          attempt: 1,
          maxAttempts: 11,
          requestId: "request_recovery",
          streamRecovery: {
            attemptId: "stream_attempt_1",
            anchorId: "anchor_1",
            maxRetries: 10,
            recoveredFromRequestId: "request_failed",
            retryNumber: 3,
          },
        },
      },
      taskId: "sess_1",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "task_network_debug_status",
        taskId: "sess_1",
        traceId: "trace_retry",
        eventKey: "evt_stream_recovery_retry",
        statusType: "model_request_started",
        requestId: "request_recovery",
        attempt: 1,
        maxAttempts: 11,
      }),
    );
    expect(events).toContainEqual({
      type: "session_info_update",
      taskId: "sess_1",
      traceId: "trace_retry",
      apiRetry: {
        kind: "api_retry",
        attempt: 3,
        maxRetries: 10,
        retryDelayMs: 0,
        errorStatus: null,
        error: "Model stream recovery retry started",
      },
    });
  });

  it("maps core stream recovery progress to apiRetry events", () => {
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: {
          eventId: "evt_stream_recovery_progress",
          sessionId: "sess_1",
          seq: 5,
          timestamp: 5,
          traceId: "trace_retry",
          type: "streamRecovery.updated",
          payload: {
            attemptId: "stream_attempt_2",
            failedRequestId: "request_failed",
            maxRetries: 10,
            recoveredFromRequestId: "request_failed",
            retryNumber: 4,
            streamMode: "sse",
          },
        },
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        type: "session_info_update",
        taskId: "sess_1",
        traceId: "trace_retry",
        apiRetry: {
          kind: "api_retry",
          attempt: 4,
          maxRetries: 10,
          retryDelayMs: 0,
          errorStatus: null,
          error: "Model stream recovery retry started",
        },
      },
    ]);
  });

  it("maps private apiRetry meta updates and clear patches", () => {
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: {
          eventId: "evt_retry_meta",
          sessionId: "sess_1",
          seq: 5,
          timestamp: 5,
          traceId: "trace_retry",
          type: "session.updated",
          payload: {
            _meta: {
              zcode: {
                apiRetry: {
                  kind: "api_retry",
                  attempt: 2,
                  maxRetries: 5,
                  retryDelayMs: 4_000,
                  errorStatus: null,
                  error: "network reset",
                },
              },
            },
          },
        },
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        type: "session_info_update",
        taskId: "sess_1",
        traceId: "trace_retry",
        apiRetry: {
          kind: "api_retry",
          attempt: 2,
          maxRetries: 5,
          retryDelayMs: 4_000,
          errorStatus: null,
          error: "network reset",
        },
      },
    ]);

    const clearEvents = zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_retry_clear",
        sessionId: "sess_1",
        seq: 6,
        timestamp: 6,
        traceId: "trace_retry",
        type: "session.updated",
        payload: {
          type: "model_request_completed",
          attempt: 3,
          maxAttempts: 4,
        },
      },
      taskId: "sess_1",
    });

    expect(clearEvents).toContainEqual(
      expect.objectContaining({
        type: "task_network_debug_status",
        taskId: "sess_1",
        traceId: "trace_retry",
        eventKey: "evt_retry_clear",
        statusType: "model_request_completed",
        attempt: 3,
        maxAttempts: 4,
      }),
    );
    expect(clearEvents).toContainEqual({
      type: "session_info_update",
      taskId: "sess_1",
      traceId: "trace_retry",
      apiRetry: null,
    });
  });

  it("maps projection background job updates to runtime stream events", () => {
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: {
          eventId: "evt_background_bash",
          sessionId: "sess_1",
          seq: 4,
          timestamp: 4,
          traceId: "trace_background_bash",
          type: "session.updated",
          payload: {
            projection: {
              backgroundJobs: [
                {
                  id: "bg-1",
                  kind: "background_bash",
                  command: "pnpm dev",
                  status: "running",
                  elapsedMs: 31_000,
                },
              ],
            },
          },
        },
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        type: "background_bash_jobs_update",
        taskId: "sess_1",
        traceId: "trace_background_bash",
        jobs: [
          expect.objectContaining({
            jobId: "bg-1",
            command: "pnpm dev",
            status: "running",
            elapsedMs: 31_000,
          }),
        ],
      },
    ]);
  });

  it("maps single background task payloads into cached background job updates", () => {
    const state: ZCodeSessionEventProjectionState = {};
    const bashEvents = zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_background_bash_started",
        sessionId: "sess_1",
        seq: 4,
        timestamp: 4,
        traceId: "trace_background_bash_started",
        type: "session.updated",
        payload: {
          taskId: "exec_1",
          terminalId: "exec_1",
          toolCallId: "toolu_bash",
          toolName: "Bash",
          command: "sleep 999",
          status: "running",
          startedAt: 10_000,
        },
      },
      state,
      taskId: "sess_1",
    });
    const agentEvents = zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_background_agent_started",
        sessionId: "sess_1",
        seq: 5,
        timestamp: 5,
        traceId: "trace_background_agent_started",
        type: "session.updated",
        payload: {
          taskId: "agent_1",
          terminalId: "agent_1",
          toolCallId: "toolu_agent",
          toolName: "Agent",
          description: "E2E background cancel agent",
          status: "running",
          startedAt: 11_000,
        },
      },
      state,
      taskId: "sess_1",
    });

    expect(bashEvents).toEqual([
      {
        type: "background_bash_jobs_update",
        taskId: "sess_1",
        traceId: "trace_background_bash_started",
        jobs: [
          expect.objectContaining({
            jobId: "exec_1",
            command: "sleep 999",
            status: "running",
            toolCallId: "toolu_bash",
          }),
        ],
      },
    ]);
    expect(agentEvents).toEqual([
      {
        type: "background_bash_jobs_update",
        taskId: "sess_1",
        traceId: "trace_background_agent_started",
        jobs: [
          expect.objectContaining({
            jobId: "exec_1",
            command: "sleep 999",
            status: "running",
          }),
          expect.objectContaining({
            jobId: "agent_1",
            command: "E2E background cancel agent",
            status: "running",
            taskKind: "agent",
            toolCallId: "toolu_agent",
          }),
        ],
      },
    ]);
  });

  it("projects live task notification turns back onto the matching background Agent tool", () => {
    const events = zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_task_notification_started",
        sessionId: "sess_1",
        seq: 6,
        timestamp: 6,
        traceId: "trace_task_notification",
        type: "turn.started",
        payload: {
          input: [
            "<task-notification>",
            "<task-id>agent_1</task-id>",
            "<tool-use-id>toolu_background_agent</tool-use-id>",
            "<output-file>/tmp/background-agent.output</output-file>",
            "<status>completed</status>",
            "<summary>Agent general-purpose task &quot;Review&quot; completed.</summary>",
            "<result>Background Agent live result</result>",
            "</task-notification>",
          ].join("\n"),
          inputSource: "task-notification",
          inputVisibility: "model-only",
        },
      },
      taskId: "sess_1",
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "task_run_started",
        taskId: "sess_1",
        traceId: "trace_task_notification",
      }),
      expect.objectContaining({
        type: "tool_call_update",
        taskId: "sess_1",
        toolId: "toolu_background_agent",
        status: "completed",
        content: "Background Agent live result",
        raw: expect.objectContaining({
          _meta: expect.objectContaining({
            zcode: expect.objectContaining({
              taskNotification: {
                outputFile: "/tmp/background-agent.output",
                result: "Background Agent live result",
                status: "completed",
                summary: 'Agent general-purpose task "Review" completed.',
                taskId: "agent_1",
              },
            }),
          }),
          toolCallId: "toolu_background_agent",
        }),
      }),
    ]);
  });

  it("projects failed live task notifications with the original provider error", () => {
    const events = zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_failed_task_notification_started",
        sessionId: "sess_1",
        seq: 7,
        timestamp: 7,
        traceId: "trace_failed_task_notification",
        type: "turn.started",
        payload: {
          input: [
            "<task-notification>",
            "<task-id>agent_failed</task-id>",
            "<tool-use-id>toolu_failed_background_agent</tool-use-id>",
            "<output-file>/tmp/background-agent.output</output-file>",
            "<status>failed</status>",
            '<summary>Agent general-purpose task "Review" failed.</summary>',
            `<error>${backgroundAgentProviderError}</error>`,
            "</task-notification>",
          ].join("\n"),
          inputSource: "task-notification",
          inputVisibility: "model-only",
        },
      },
      taskId: "sess_1",
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "task_run_started",
        taskId: "sess_1",
        traceId: "trace_failed_task_notification",
      }),
      expect.objectContaining({
        type: "tool_call_update",
        taskId: "sess_1",
        toolId: "toolu_failed_background_agent",
        status: "failed",
        content: 'Agent general-purpose task "Review" failed.',
        error: backgroundAgentProviderError,
        raw: expect.objectContaining({
          _meta: expect.objectContaining({
            zcode: expect.objectContaining({
              taskNotification: expect.objectContaining({
                error: backgroundAgentProviderError,
                status: "failed",
                summary: 'Agent general-purpose task "Review" failed.',
                taskId: "agent_failed",
              }),
            }),
          }),
          toolCallId: "toolu_failed_background_agent",
        }),
      }),
    ]);
  });

  it("projects killed task notification turns as stopped tool updates", () => {
    const events = zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_task_notification_stopped",
        sessionId: "sess_1",
        seq: 7,
        timestamp: 7,
        traceId: "trace_task_notification_stopped",
        type: "turn.started",
        payload: {
          input: [
            "<task-notification>",
            "<task-id>agent_1</task-id>",
            "<tool-use-id>toolu_background_agent</tool-use-id>",
            "<output-file>/tmp/background-agent.output</output-file>",
            "<status>killed</status>",
            "<summary>Agent task was stopped.</summary>",
            "</task-notification>",
          ].join("\n"),
          inputSource: "task-notification",
          inputVisibility: "model-only",
        },
      },
      taskId: "sess_1",
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "task_run_started",
        taskId: "sess_1",
        traceId: "trace_task_notification_stopped",
      }),
      expect.objectContaining({
        type: "tool_call_update",
        taskId: "sess_1",
        toolId: "toolu_background_agent",
        status: "stopped",
        content: "Agent task was stopped.",
        raw: expect.objectContaining({
          _meta: expect.objectContaining({
            zcode: expect.objectContaining({
              taskNotification: expect.objectContaining({
                status: "killed",
                summary: "Agent task was stopped.",
                taskId: "agent_1",
              }),
            }),
          }),
        }),
      }),
    ]);
  });

  it("maps direct user input requests into elicitation requests", () => {
    const event = zcodeUserInputRequestToZCodeStreamEvent("sess_1", {
      requestId: "ask_1",
      sessionId: "sess_1",
      turnId: "turn_1",
      toolCallId: "tool_ask",
      toolName: "AskUserQuestion",
      origin: subagentOrigin,
      prompt: "Need a choice",
      questions: [
        {
          question: "Which branch should I test?",
          header: "Branch",
          options: [
            { value: "main", label: "main", description: "Use main branch" },
            {
              value: "release",
              label: "release",
              description: "Use release branch",
            },
          ],
        },
      ],
      schema: { toolName: "AskUserQuestion" },
    });

    expect(event).toMatchObject({
      type: "elicitation_request",
      taskId: "sess_1",
      requestId: "ask_1",
      message: "Which branch should I test?",
      header: "Branch",
      origin: subagentOrigin,
      options: [
        { value: "main", label: "main", description: "Use main branch" },
        {
          value: "release",
          label: "release",
          description: "Use release branch",
        },
      ],
      questions: [
        {
          question: "Which branch should I test?",
          header: "Branch",
        },
      ],
      schema: { toolName: "AskUserQuestion" },
    });
  });

  it("maps nested ZCode Protocol projection context usage", () => {
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: {
          eventId: "evt_projection_usage",
          sessionId: "sess_1",
          seq: 5,
          timestamp: 5,
          traceId: "trace_projection_usage",
          type: "session.updated",
          payload: {
            projection: {
              contextUsed: 64000,
              contextWindow: 128000,
            },
          },
        },
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        type: "usage_update",
        taskId: "sess_1",
        traceId: "trace_projection_usage",
        used: 64000,
        size: 128000,
        cost: null,
      },
    ]);
  });

  it("does not emit legacy usage_update for zero context usage", () => {
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: {
          eventId: "evt_zero_usage",
          sessionId: "sess_1",
          seq: 6,
          timestamp: 6,
          traceId: "trace_zero_usage",
          type: "session.updated",
          payload: {
            contextUsed: 0,
            contextWindow: 128000,
          },
        },
        taskId: "sess_1",
      }),
    ).toEqual([]);
  });

  it("merges multi-round assistant messages from the same user turn into one", () => {
    const baseAssistantInfo = {
      sessionId: "sess_1",
      role: "assistant" as const,
      parentMessageId: "msg_user",
      agent: "zcode-agent",
      model,
      path: { cwd: "/workspace/app", root: "/workspace/app" },
      cost: 0,
      tokens: {
        input: 1,
        output: 2,
        reasoning: 3,
        total: 6,
        cache: { read: 0, write: 0 },
      },
    };
    const snapshot = zcodeSessionSnapshotToZCodeTaskSnapshot({
      ...createSnapshot(),
      messages: [
        {
          info: {
            messageId: "msg_user",
            sessionId: "sess_1",
            role: "user",
            time: { created: 100 },
            agent: "zcode-agent",
            model,
          },
          parts: [
            {
              partId: "part_user",
              sessionId: "sess_1",
              messageId: "msg_user",
              type: "text",
              text: "do work",
            },
          ],
        },
        {
          info: {
            ...baseAssistantInfo,
            messageId: "msg_round1",
            time: { created: 200, completed: 1_200 },
          },
          parts: [
            {
              partId: "round1_text",
              sessionId: "sess_1",
              messageId: "msg_round1",
              type: "text",
              text: "calling ls ",
            },
            {
              partId: "round1_tool",
              sessionId: "sess_1",
              messageId: "msg_round1",
              type: "tool",
              callId: "tool_1",
              tool: "Bash",
              state: {
                status: "completed",
                input: { command: "ls" },
                output: "a b",
                title: "Bash",
                metadata: {},
                startedAt: 300,
                completedAt: 400,
              },
            },
          ],
        },
        {
          info: {
            ...baseAssistantInfo,
            messageId: "msg_round2",
            parentMessageId: "msg_round1",
            time: { created: 1_500, completed: 3_500 },
          },
          parts: [
            {
              partId: "round2_text",
              sessionId: "sess_1",
              messageId: "msg_round2",
              type: "text",
              text: "done",
            },
            {
              partId: "round2_tool",
              sessionId: "sess_1",
              messageId: "msg_round2",
              type: "tool",
              callId: "tool_2",
              tool: "Read",
              state: {
                status: "completed",
                input: { path: "a" },
                output: "hi",
                title: "Read",
                metadata: {},
                startedAt: 1_600,
                completedAt: 1_700,
              },
            },
          ],
        },
      ],
    });

    expect(snapshot.messages).toHaveLength(2);
    const merged = snapshot.messages[1]!;
    expect(merged.role).toBe("assistant");
    expect(merged.content).toBe("calling ls done");
    expect(merged.timestamp).toBe(200);
    // 整轮跨度 = round2.completed (3500) − round1.created (200)
    expect(merged.durationMs).toBe(3_300);
    expect(merged.tools).toHaveLength(2);
    expect(merged.tools?.[0]?.toolName).toBe("Bash");
    expect(merged.tools?.[1]?.toolName).toBe("Read");
    expect(merged.parts).toEqual([
      { type: "content", content: "calling ls " },
      { type: "tool-call", toolIndex: 0 },
      { type: "content", content: "done" },
      { type: "tool-call", toolIndex: 1 },
    ]);
    expect(snapshot.messages[0]?.turnIndex).toBe(0);
    expect(merged.turnIndex).toBe(0);
  });

  it("maps session events without routing through legacy task service", () => {
    const state = {
      streamedTurnKeys: new Set<string>(),
      toolNameById: new Map<string, string>(),
    };
    const turnStartedEvent = {
      eventId: "evt_start",
      sessionId: "sess_1",
      turnId: "turn_1",
      seq: 0,
      timestamp: 1,
      traceId: "trace_session",
      type: "turn.started",
      payload: {
        input: "hello",
        turnNumber: 1,
        inputId: "t-sess_1-run",
      },
    } satisfies ZCodeSessionEvent;
    const streamingEvent = {
      eventId: "evt_stream",
      sessionId: "sess_1",
      turnId: "turn_1",
      seq: 1,
      timestamp: 2,
      traceId: "trace_session",
      type: "session.updated",
      payload: {
        kind: "text_delta",
        delta: "hel",
        assistantMessageId: "msg_a",
      },
    } satisfies ZCodeSessionEvent;
    const completeEvent = {
      eventId: "evt_done",
      sessionId: "sess_1",
      turnId: "turn_1",
      seq: 2,
      timestamp: 3,
      traceId: "trace_session",
      type: "turn.completed",
      payload: {
        response: "hello",
        tokenCount: 1,
        toolCallCount: 0,
        duration: 10,
        inputId: "t-sess_1-run",
        resultType: "success",
      },
    } satisfies ZCodeSessionEvent;
    const toolEvent = {
      eventId: "evt_tool",
      sessionId: "sess_1",
      turnId: "turn_1",
      seq: 2,
      timestamp: 3,
      traceId: "trace_session",
      type: "tool.updated",
      payload: {
        kind: "scheduled",
        toolCallId: "call_1",
        toolName: "Read",
        input: { filePath: "/repo/app.ts" },
      },
    } satisfies ZCodeSessionEvent;

    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: turnStartedEvent,
        state,
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        type: "task_run_started",
        taskId: "sess_1",
        traceId: "t-sess_1-run",
        inputId: "t-sess_1-run",
        turnId: "turn_1",
        startedAt: 1,
      },
    ]);
    // 修复原因：turn.started 是首 token 前唯一可靠的运行态边界。
    // projection 需要记录 active input，后续 chunk/tool/complete 才能归到同一轮 trace。
    expect(state.activePromptInputIdBySession?.get("sess_1")).toBe("t-sess_1-run");
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: streamingEvent,
        state,
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        type: "agent_message_chunk",
        taskId: "sess_1",
        traceId: "t-sess_1-run",
        inputId: "t-sess_1-run",
        messageId: "msg_a",
        content: "hel",
      },
    ]);
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: {
          ...streamingEvent,
          eventId: "evt_parent_stream",
          payload: {
            kind: "text_delta",
            delta: "child",
            parentToolUseId: "call_parent",
          },
        },
        state,
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        type: "agent_message_chunk",
        taskId: "sess_1",
        traceId: "t-sess_1-run",
        inputId: "t-sess_1-run",
        parentToolUseId: "call_parent",
        content: "child",
      },
    ]);
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: toolEvent,
        state,
        taskId: "sess_1",
      }),
    ).toMatchObject([
      {
        type: "tool_call",
        taskId: "sess_1",
        traceId: "t-sess_1-run",
        inputId: "t-sess_1-run",
        toolId: "call_1",
        toolName: "Read",
      },
    ]);
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: completeEvent,
        state,
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        type: "task_complete",
        taskId: "sess_1",
        traceId: "t-sess_1-run",
        inputId: "t-sess_1-run",
        stopReason: "success",
        usage: undefined,
      },
    ]);
    expect(state.activePromptInputIdBySession?.get("sess_1")).toBeUndefined();
  });

  it("does not render conversation rewind command ack as an assistant chunk", () => {
    const state: ZCodeSessionEventProjectionState = {
      activePromptInputIdBySession: new Map<string, string>(),
      streamedTurnKeys: new Set<string>(),
    };
    const started = {
      eventId: "evt_rewind_start",
      sessionId: "sess_1",
      turnId: "turn_rewind",
      seq: 0,
      timestamp: 10,
      traceId: "trace_rewind",
      type: "turn.started",
      payload: {
        input: "/rewind conversation msg_old_user",
        inputId: "input_rewind",
        turnNumber: 2,
      },
    } satisfies ZCodeSessionEvent;
    const completed = {
      eventId: "evt_rewind_done",
      sessionId: "sess_1",
      turnId: "turn_rewind",
      seq: 1,
      timestamp: 11,
      traceId: "trace_rewind",
      type: "turn.completed",
      payload: {
        response: "Rewound conversation to before message msg_old_user.",
        inputId: "input_rewind",
        resultType: "success",
      },
    } satisfies ZCodeSessionEvent;

    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: started,
        state,
        taskId: "sess_1",
      }),
    ).toMatchObject([{ type: "task_run_started" }]);
    expect(state.rewindControlTurnKeys?.has("sess_1:turn_rewind")).toBe(true);
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: completed,
        state,
        taskId: "sess_1",
      }),
    ).toEqual([
      {
        type: "task_complete",
        taskId: "sess_1",
        traceId: "input_rewind",
        inputId: "input_rewind",
        stopReason: "success",
        usage: undefined,
      },
    ]);
    expect(state.rewindControlTurnKeys?.has("sess_1:turn_rewind")).toBe(false);
  });

  it("maps denied tool permissions to failed tool updates", () => {
    const state = {
      activePromptInputIdBySession: new Map([["sess_1", "input_1"]]),
      toolNameById: new Map([["call_bash", "Bash"]]),
    };
    const payload = {
      toolCallId: "call_bash",
      toolName: "Bash",
      decision: "deny",
      reason: "Plan mode only allows read-only, non-destructive tools",
    };

    expect(
      zcodeSessionEventToZCodeStreamEvents({
        taskId: "sess_1",
        state,
        event: {
          eventId: "evt_permission_denied",
          sessionId: "sess_1",
          turnId: "turn_1",
          seq: 4,
          timestamp: 4,
          traceId: "trace_session",
          type: "permission.resolved",
          payload,
        } satisfies ZCodeSessionEvent,
      }),
    ).toEqual([
      {
        type: "permission_response",
        taskId: "sess_1",
        traceId: "input_1",
        inputId: "input_1",
        requestId: "call_bash",
        optionId: "deny",
        response: { decision: "deny" },
      },
      {
        type: "tool_call_update",
        taskId: "sess_1",
        traceId: "input_1",
        inputId: "input_1",
        toolId: "call_bash",
        parentToolUseId: null,
        status: "failed",
        toolName: "Bash",
        kind: "Bash",
        title: "Bash",
        error: "Plan mode only allows read-only, non-destructive tools",
        raw: payload,
      },
    ]);
  });

  it("remembers tool names from started events for later result-only updates", () => {
    const state = {
      activePromptInputIdBySession: new Map([["sess_1", "input_1"]]),
      toolNameById: new Map<string, string>(),
    } satisfies ZCodeSessionEventProjectionState;
    const startedPayload = {
      toolCallId: "tool_subagent_agent_1_call_search",
      parentToolCallId: "call_parent_agent",
      source: "subagent",
      agentId: "agent_1",
      toolName: "WebSearch",
    };
    const resultPayload = {
      toolCallId: "tool_subagent_agent_1_call_search",
      parentToolCallId: "call_parent_agent",
      source: "subagent",
      agentId: "agent_1",
      result: {
        success: true,
        content: "Web search results for query: test",
      },
    };

    expect(
      zcodeSessionEventToZCodeStreamEvents({
        taskId: "sess_1",
        state,
        event: {
          eventId: "evt_tool_started",
          sessionId: "sess_1",
          turnId: "turn_1",
          seq: 1,
          timestamp: 1,
          traceId: "trace_session",
          type: "tool.updated",
          payload: startedPayload,
        } satisfies ZCodeSessionEvent,
      }),
    ).toEqual([
      {
        type: "tool_call_update",
        taskId: "sess_1",
        traceId: "input_1",
        inputId: "input_1",
        toolId: "tool_subagent_agent_1_call_search",
        parentToolUseId: "call_parent_agent",
        toolName: "WebSearch",
        kind: "WebSearch",
        title: "WebSearch",
        status: "in_progress",
        raw: startedPayload,
      },
    ]);
    expect(state.toolNameById.get("tool_subagent_agent_1_call_search")).toBe("WebSearch");

    expect(
      zcodeSessionEventToZCodeStreamEvents({
        taskId: "sess_1",
        state,
        event: {
          eventId: "evt_tool_result",
          sessionId: "sess_1",
          turnId: "turn_1",
          seq: 2,
          timestamp: 2,
          traceId: "trace_session",
          type: "tool.updated",
          payload: resultPayload,
        } satisfies ZCodeSessionEvent,
      }),
    ).toEqual([
      {
        type: "tool_call_update",
        taskId: "sess_1",
        traceId: "input_1",
        inputId: "input_1",
        toolId: "tool_subagent_agent_1_call_search",
        parentToolUseId: "call_parent_agent",
        toolName: "WebSearch",
        kind: "WebSearch",
        title: "WebSearch",
        status: "completed",
        content: "Web search results for query: test",
        error: undefined,
        raw: resultPayload,
      },
    ]);
  });

  it("remembers tool metadata for later result-only updates across tool renderers", () => {
    const cases = [
      {
        input: { command: "curl -s https://example.com" },
        toolName: "Bash",
      },
      {
        input: { file_path: "package.json" },
        toolName: "Read",
      },
      {
        input: { search_query: "2026 World Cup winner odds" },
        toolName: "WebSearch",
      },
      {
        input: { path: "src", pattern: "TODO" },
        toolName: "Grep",
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const state = {
        activePromptInputIdBySession: new Map([["sess_1", "input_1"]]),
        streamingToolInputById: new Map(),
        toolNameById: new Map<string, string>(),
      } satisfies ZCodeSessionEventProjectionState;
      const toolCallId = `tool_subagent_agent_1_call_${testCase.toolName.toLowerCase()}`;
      const scheduledPayload = {
        toolCallId,
        parentToolCallId: "call_parent_agent",
        source: "subagent",
        agentId: "agent_1",
        toolName: testCase.toolName,
        input: testCase.input,
      };
      const resultPayload = {
        toolCallId,
        parentToolCallId: "call_parent_agent",
        source: "subagent",
        agentId: "agent_1",
        result: {
          success: true,
          content: "ok",
        },
      };

      expect(
        zcodeSessionEventToZCodeStreamEvents({
          taskId: "sess_1",
          state,
          event: {
            eventId: `evt_tool_scheduled_${index}`,
            sessionId: "sess_1",
            turnId: "turn_1",
            seq: index * 2 + 1,
            timestamp: index * 2 + 1,
            traceId: "trace_session",
            type: "tool.updated",
            payload: scheduledPayload,
          } satisfies ZCodeSessionEvent,
        }),
      ).toEqual([
        expect.objectContaining({
          type: "tool_call",
          toolId: toolCallId,
          input: testCase.input,
          toolName: testCase.toolName,
          kind: testCase.toolName,
          title: testCase.toolName,
        }),
      ]);

      expect(
        zcodeSessionEventToZCodeStreamEvents({
          taskId: "sess_1",
          state,
          event: {
            eventId: `evt_tool_result_${index}`,
            sessionId: "sess_1",
            turnId: "turn_1",
            seq: index * 2 + 2,
            timestamp: index * 2 + 2,
            traceId: "trace_session",
            type: "tool.updated",
            payload: resultPayload,
          } satisfies ZCodeSessionEvent,
        }),
      ).toEqual([
        expect.objectContaining({
          type: "tool_call_update",
          toolId: toolCallId,
          parentToolUseId: "call_parent_agent",
          toolName: testCase.toolName,
          kind: testCase.toolName,
          title: testCase.toolName,
          input: testCase.input,
          status: "completed",
          content: "ok",
          raw: resultPayload,
        }),
      ]);
    }
  });

  it("preserves child tool metadata across progress and parent turn completion", () => {
    const state = {
      activePromptInputIdBySession: new Map([["sess_1", "input_1"]]),
      streamingToolInputById: new Map(),
      toolNameById: new Map<string, string>(),
    } satisfies ZCodeSessionEventProjectionState;
    const scheduledPayload = {
      toolCallId: "tool_subagent_agent_1_call_bash",
      parentToolCallId: "call_parent_agent",
      source: "subagent",
      agentId: "agent_1",
      toolName: "Bash",
      input: {
        command: "printf done",
        description: "Print completion marker",
      },
    };
    const progressPayload = {
      toolCallId: scheduledPayload.toolCallId,
      parentToolCallId: scheduledPayload.parentToolCallId,
      source: "subagent",
      agentId: "agent_1",
      toolName: "Bash",
      kind: "started",
    };
    const project = (event: ZCodeSessionEvent) =>
      zcodeSessionEventToZCodeStreamEvents({
        taskId: "sess_1",
        state,
        event,
      });

    project({
      eventId: "evt_tool_scheduled",
      sessionId: "sess_1",
      turnId: "turn_parent",
      seq: 1,
      timestamp: 1,
      traceId: "trace_session",
      type: "tool.updated",
      payload: scheduledPayload,
    });
    expect(
      project({
        eventId: "evt_tool_progress",
        sessionId: "sess_1",
        turnId: "turn_parent",
        seq: 2,
        timestamp: 2,
        traceId: "trace_session",
        type: "tool.updated",
        payload: progressPayload,
      }),
    ).toEqual([
      expect.objectContaining({
        type: "tool_call_update",
        toolId: scheduledPayload.toolCallId,
        input: scheduledPayload.input,
        status: "in_progress",
      }),
    ]);

    project({
      eventId: "evt_parent_completed",
      sessionId: "sess_1",
      turnId: "turn_parent",
      seq: 3,
      timestamp: 3,
      traceId: "trace_session",
      type: "turn.completed",
      payload: {
        inputId: "input_1",
        resultType: "success",
      },
    });
    // parent turn 已完成后，background child tool 仍可能继续接收输入流。
    state.streamingToolInputById?.set(scheduledPayload.toolCallId, {
      rawInput: JSON.stringify(scheduledPayload.input),
    });

    expect(
      project({
        eventId: "evt_tool_result",
        sessionId: "sess_1",
        turnId: "turn_child",
        seq: 4,
        timestamp: 4,
        traceId: "trace_session",
        type: "tool.updated",
        payload: {
          toolCallId: scheduledPayload.toolCallId,
          parentToolCallId: scheduledPayload.parentToolCallId,
          source: "subagent",
          agentId: "agent_1",
          result: {
            success: true,
            content: "done",
          },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        type: "tool_call_update",
        toolId: scheduledPayload.toolCallId,
        toolName: "Bash",
        input: scheduledPayload.input,
        status: "completed",
        content: "done",
      }),
    ]);
    expect(state.streamingToolInputById?.has(scheduledPayload.toolCallId)).toBe(false);
    expect(state.completeToolInputById?.has(scheduledPayload.toolCallId)).toBe(false);
    expect(state.toolNameById?.has(scheduledPayload.toolCallId)).toBe(false);
  });

  it("keeps AskUserQuestion permission responses on the elicitation path", () => {
    const state = {
      activePromptInputIdBySession: new Map([["sess_1", "input_1"]]),
      toolNameById: new Map([["call_ask", "AskUserQuestion"]]),
    };

    expect(
      zcodeSessionEventToZCodeStreamEvents({
        taskId: "sess_1",
        state,
        event: {
          eventId: "evt_ask_declined",
          sessionId: "sess_1",
          turnId: "turn_1",
          seq: 5,
          timestamp: 5,
          traceId: "trace_session",
          type: "permission.resolved",
          payload: {
            toolCallId: "call_ask",
            decision: "deny",
            reason: "User declined",
          },
        } satisfies ZCodeSessionEvent,
      }),
    ).toEqual([
      {
        type: "elicitation_response",
        taskId: "sess_1",
        traceId: "input_1",
        inputId: "input_1",
        requestId: "call_ask",
        action: "decline",
      },
    ]);
  });

  it("keeps ExitPlanMode permission requests on the elicitation path", () => {
    const state = {
      activePromptInputIdBySession: new Map([["sess_1", "input_1"]]),
      toolNameById: new Map<string, string>(),
    };

    expect(
      zcodeSessionEventToZCodeStreamEvents({
        taskId: "sess_1",
        state,
        event: {
          eventId: "evt_exit_plan_requested",
          sessionId: "sess_1",
          turnId: "turn_1",
          seq: 4,
          timestamp: 4,
          traceId: "trace_session",
          type: "permission.requested",
          payload: {
            requestId: "exit_plan_1",
            toolCallId: "call_exit_plan",
            toolName: "ExitPlanMode",
            reason: "Exit plan mode",
          },
        } satisfies ZCodeSessionEvent,
      }),
    ).toEqual([]);
    expect(state.toolNameById.get("call_exit_plan")).toBe("ExitPlanMode");
  });

  it("keeps ExitPlanMode permission responses on the elicitation path", () => {
    const state = {
      activePromptInputIdBySession: new Map([["sess_1", "input_1"]]),
      toolNameById: new Map([["call_exit_plan", "ExitPlanMode"]]),
    };

    expect(
      zcodeSessionEventToZCodeStreamEvents({
        taskId: "sess_1",
        state,
        event: {
          eventId: "evt_exit_plan_denied",
          sessionId: "sess_1",
          turnId: "turn_1",
          seq: 5,
          timestamp: 5,
          traceId: "trace_session",
          type: "permission.resolved",
          payload: {
            toolCallId: "call_exit_plan",
            decision: "deny",
            reason: "Please add tests first",
          },
        } satisfies ZCodeSessionEvent,
      }),
    ).toEqual([
      {
        type: "elicitation_response",
        taskId: "sess_1",
        traceId: "input_1",
        inputId: "input_1",
        requestId: "call_exit_plan",
        action: "decline",
      },
    ]);
  });

  it("maps model-only goal continuation turn starts to goal iteration boundaries", () => {
    const events = zcodeSessionEventToZCodeStreamEvents({
      taskId: "task-goal",
      event: {
        eventId: "evt_goal_start",
        sessionId: "sess_goal",
        turnId: "turn_goal_2",
        seq: 10,
        timestamp: 1_234,
        traceId: "trace_goal",
        type: "turn.started",
        payload: {
          input:
            "<system-reminder>\nContinue working toward the active session goal.\n</system-reminder>",
          inputId: "input-goal",
          inputSource: "goal-continuation",
          inputVisibility: "model-only",
          targetId: "goal-1",
          turnNumber: 2,
        },
      },
    });

    expect(events).toEqual([
      {
        type: "task_run_started",
        taskId: "task-goal",
        traceId: "input-goal",
        inputId: "input-goal",
        turnId: "turn_goal_2",
        startedAt: 1_234,
      },
      {
        type: "goal_iteration_started",
        taskId: "task-goal",
        traceId: "input-goal",
        inputId: "input-goal",
        turnId: "turn_goal_2",
        targetId: "goal-1",
        startedAt: 1_234,
      },
    ]);
  });

  it("maps subagent tool updates into parented tool calls and agent activity", () => {
    const state = {
      streamedTurnKeys: new Set<string>(),
      toolNameById: new Map<string, string>(),
    };
    const parentToolCall = {
      eventId: "evt_parent_agent",
      sessionId: "sess_1",
      turnId: "turn_1",
      seq: 10,
      timestamp: 10,
      traceId: "trace_session",
      type: "tool.updated",
      payload: {
        kind: "scheduled",
        toolCallId: "call_parent_agent",
        toolName: "Agent",
        input: {
          description: "Inspect workspace",
          prompt: "Find the project shape",
        },
      },
    } satisfies ZCodeSessionEvent;
    const subagentToolCall = {
      eventId: "evt_subagent_tool",
      sessionId: "sess_1",
      turnId: "turn_1",
      seq: 11,
      timestamp: 11,
      traceId: "trace_session",
      type: "tool.updated",
      payload: {
        kind: "scheduled",
        toolCallId: "tool_subagent_agent_1_call_1",
        toolName: "Read",
        input: { filePath: "/workspace/package.json" },
        parentToolCallId: "call_parent_agent",
        source: "subagent",
        agentId: "agent_1",
        agentType: "Explore",
        childSessionId: "sess_subagent_agent_1",
        childToolCallId: "call_1",
        description: "Inspect workspace",
      },
    } satisfies ZCodeSessionEvent;
    const parentToolResult = {
      eventId: "evt_parent_agent_result",
      sessionId: "sess_1",
      turnId: "turn_1",
      seq: 12,
      timestamp: 12,
      traceId: "trace_session",
      type: "tool.updated",
      payload: {
        kind: "result",
        toolCallId: "call_parent_agent",
        duration: 123,
        result: {
          success: true,
          content: JSON.stringify({
            status: "completed",
            agentId: "agent_1",
            agentType: "Explore",
            content: [{ type: "text", text: "Subagent summary" }],
          }),
        },
      },
    } satisfies ZCodeSessionEvent;

    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: parentToolCall,
        state,
        taskId: "sess_1",
      }),
    ).toMatchObject([
      {
        type: "tool_call",
        toolId: "call_parent_agent",
        toolName: "Agent",
        parentToolUseId: null,
      },
    ]);
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: subagentToolCall,
        state,
        taskId: "sess_1",
      }),
    ).toMatchObject([
      {
        type: "tool_call",
        toolId: "tool_subagent_agent_1_call_1",
        toolName: "Read",
        parentToolUseId: "call_parent_agent",
      },
    ]);
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: parentToolResult,
        state,
        taskId: "sess_1",
      }),
    ).toMatchObject([
      {
        type: "tool_call_update",
        toolId: "call_parent_agent",
        toolName: "Agent",
        content: {
          kind: "agent_activity",
          content: "Subagent summary",
        },
      },
    ]);
  });

  it("keeps background Agent launch acknowledgements in progress", () => {
    const state = {
      streamedTurnKeys: new Set<string>(),
      toolNameById: new Map<string, string>(),
    };
    zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_parent_agent",
        sessionId: "sess_1",
        turnId: "turn_1",
        seq: 10,
        timestamp: 10,
        traceId: "trace_session",
        type: "tool.updated",
        payload: {
          kind: "scheduled",
          toolCallId: "call_parent_agent",
          toolName: "Agent",
          input: {
            description: "Inspect workspace",
            prompt: "Find the project shape",
            run_in_background: true,
          },
        },
      } satisfies ZCodeSessionEvent,
      state,
      taskId: "sess_1",
    });

    const events = zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_parent_agent_result",
        sessionId: "sess_1",
        turnId: "turn_1",
        seq: 11,
        timestamp: 11,
        traceId: "trace_session",
        type: "tool.updated",
        payload: {
          kind: "result",
          toolCallId: "call_parent_agent",
          duration: 4,
          result: {
            success: true,
            content: [
              'Agent Explore task "Inspect workspace" started in background.',
              "agentId: agent_1",
              "backgroundTaskId: agent_1",
              "Runtime will wait for this background Agent before completing the current turn.",
            ].join("\n"),
          },
        },
      } satisfies ZCodeSessionEvent,
      state,
      taskId: "sess_1",
    });

    expect(events).toMatchObject([
      {
        type: "tool_call_update",
        toolId: "call_parent_agent",
        toolName: "Agent",
        status: "in_progress",
      },
    ]);
  });

  it("keeps previous and current async Task launch acknowledgements in progress", () => {
    const state = {
      streamedTurnKeys: new Set<string>(),
      toolNameById: new Map<string, string>(),
    };
    zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_parent_task",
        sessionId: "sess_1",
        turnId: "turn_1",
        seq: 10,
        timestamp: 10,
        traceId: "trace_session",
        type: "tool.updated",
        payload: {
          kind: "scheduled",
          toolCallId: "call_parent_task",
          toolName: "Task",
          input: {
            description: "Inspect workspace",
            prompt: "Find the project shape",
          },
        },
      } satisfies ZCodeSessionEvent,
      state,
      taskId: "sess_1",
    });

    const acknowledgementContents = [
      [
        'Agent general-purpose task "Inspect workspace" started in background.',
        "agentId: agent_1",
        "outputFile: /tmp/agent_1/output.txt",
        "You will be notified when the Agent completes.",
      ].join("\n"),
      [
        "Async agent launched successfully.",
        "agentId: agent_1 (internal ID - do not mention to user. Use SendMessage with to: 'agent_1' to continue this agent.)",
        "The agent is working in the background. You will be notified automatically when it completes.",
        "output_file: /tmp/agent_1/output.txt",
        "Do NOT Read or tail this file via the shell tool.",
      ].join("\n"),
    ];

    for (const [index, content] of acknowledgementContents.entries()) {
      const events = zcodeSessionEventToZCodeStreamEvents({
        event: {
          eventId: `evt_parent_task_result_${index}`,
          sessionId: "sess_1",
          turnId: "turn_1",
          seq: 11 + index,
          timestamp: 11 + index,
          traceId: "trace_session",
          type: "tool.updated",
          payload: {
            kind: "result",
            toolCallId: "call_parent_task",
            duration: 4,
            result: {
              success: true,
              content,
            },
          },
        } satisfies ZCodeSessionEvent,
        state,
        taskId: "sess_1",
      });

      expect(events).toMatchObject([
        {
          type: "tool_call_update",
          toolId: "call_parent_task",
          toolName: "Task",
          status: "in_progress",
        },
      ]);
    }
  });

  it("does not project subagent TodoWrite updates as the main runtime plan", () => {
    const state = {
      streamedTurnKeys: new Set<string>(),
      toolNameById: new Map<string, string>(),
    };
    const mainTodoCall = {
      eventId: "evt_main_todo",
      sessionId: "sess_1",
      turnId: "turn_1",
      seq: 20,
      timestamp: 20,
      traceId: "trace_session",
      type: "tool.updated",
      payload: {
        kind: "scheduled",
        toolCallId: "call_main_todo",
        toolName: "TodoWrite",
        input: {
          todos: [
            { content: "Main inspect logs", status: "completed" },
            { content: "Main patch projection", status: "in_progress" },
          ],
        },
      },
    } satisfies ZCodeSessionEvent;
    const subagentTodoCall = {
      eventId: "evt_subagent_todo",
      sessionId: "sess_1",
      turnId: "turn_1",
      seq: 21,
      timestamp: 21,
      traceId: "trace_session",
      type: "tool.updated",
      payload: {
        kind: "scheduled",
        toolCallId: "tool_subagent_agent_1_call_todo",
        toolName: "TodoWrite",
        input: {
          todos: [
            { content: "Subagent search market", status: "in_progress" },
            { content: "Subagent summarize sources", status: "pending" },
          ],
        },
        parentToolCallId: "call_parent_agent",
        source: "subagent",
        agentId: "agent_1",
        agentType: "Explore",
        childSessionId: "sess_subagent_agent_1",
        childToolCallId: "call_todo",
        description: "Inspect workspace",
      },
    } satisfies ZCodeSessionEvent;
    const subagentTodoResult = {
      eventId: "evt_subagent_todo_result",
      sessionId: "sess_1",
      turnId: "turn_1",
      seq: 22,
      timestamp: 22,
      traceId: "trace_session",
      type: "tool.updated",
      payload: {
        kind: "result",
        toolCallId: "tool_subagent_agent_1_call_todo",
        result: {
          success: true,
          content: JSON.stringify({
            todos: [
              { content: "Subagent search market", status: "completed" },
              { content: "Subagent summarize sources", status: "in_progress" },
            ],
          }),
        },
        parentToolCallId: "call_parent_agent",
        source: "subagent",
        agentId: "agent_1",
        agentType: "Explore",
        childSessionId: "sess_subagent_agent_1",
        childToolCallId: "call_todo",
        description: "Inspect workspace",
      },
    } satisfies ZCodeSessionEvent;

    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: mainTodoCall,
        state,
        taskId: "sess_1",
      }).map((event) => event.type),
    ).toEqual(["tool_call", "plan"]);
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: subagentTodoCall,
        state,
        taskId: "sess_1",
      }),
    ).toMatchObject([
      {
        type: "tool_call",
        toolId: "tool_subagent_agent_1_call_todo",
        parentToolUseId: "call_parent_agent",
      },
    ]);
    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: subagentTodoResult,
        state,
        taskId: "sess_1",
      }),
    ).toMatchObject([
      {
        type: "tool_call_update",
        toolId: "tool_subagent_agent_1_call_todo",
        parentToolUseId: "call_parent_agent",
      },
    ]);
  });

  it("keeps per-prompt inputId correlation scoped by session", () => {
    const state = {
      streamedTurnKeys: new Set<string>(),
      toolNameById: new Map<string, string>(),
    };

    zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_start",
        sessionId: "sess_1",
        turnId: "turn_1",
        seq: 0,
        timestamp: 1,
        traceId: "trace_session_1",
        type: "turn.started",
        payload: {
          input: "hello",
          turnNumber: 1,
          inputId: "t-sess_1-run",
        },
      },
      state,
      taskId: "sess_1",
    });

    expect(
      zcodeSessionEventToZCodeStreamEvents({
        event: {
          eventId: "evt_stream_other",
          sessionId: "sess_2",
          turnId: "turn_2",
          seq: 1,
          timestamp: 2,
          traceId: "trace_session_2",
          type: "session.updated",
          payload: {
            kind: "text_delta",
            delta: "other",
            assistantMessageId: "msg_b",
          },
        },
        state,
        taskId: "sess_2",
      }),
    ).toEqual([
      {
        type: "agent_message_chunk",
        taskId: "sess_2",
        traceId: "trace_session_2",
        messageId: "msg_b",
        content: "other",
      },
    ]);
  });

  it("projects compact lifecycle payloads to context compaction timeline chunks", () => {
    const state = {
      activePromptInputIdBySession: new Map([["sess_1", "input-compact"]]),
      streamedTurnKeys: new Set<string>(),
      toolNameById: new Map<string, string>(),
    };

    const events = zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_compact_started",
        sessionId: "sess_1",
        turnId: "turn_compact",
        seq: 1,
        timestamp: 2,
        traceId: "trace_compact",
        type: "session.updated",
        payload: {
          operationId: "cmp-1",
          messageId: "msg-compact-1",
          status: "started",
          trigger: "manual",
          display: "separator",
          preCompactTokenCount: 1200,
          startedAt: 100,
        },
      } satisfies ZCodeSessionEvent,
      state,
      taskId: "sess_1",
    });

    expect(events).toEqual([
      {
        type: "agent_message_chunk",
        taskId: "sess_1",
        traceId: "input-compact",
        inputId: "input-compact",
        messageId: "msg-compact-1",
        content: "",
        zcodeTimeline: {
          version: 1,
          kind: "synthetic",
          type: "context_compaction",
          operationId: "cmp-1",
          status: "started",
          trigger: "manual",
          display: "separator",
          inputId: "input-compact",
          preCompactTokenCount: 1200,
          startedAt: 100,
        },
      },
    ]);
  });

  it("projects compact retry payloads with attempt metadata", () => {
    const state = {
      activePromptInputIdBySession: new Map([["sess_1", "input-compact"]]),
      streamedTurnKeys: new Set<string>(),
      toolNameById: new Map<string, string>(),
    };

    const events = zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_compact_retrying",
        sessionId: "sess_1",
        turnId: "turn_compact",
        seq: 2,
        timestamp: 3,
        traceId: "trace_compact",
        type: "session.updated",
        payload: {
          operationId: "cmp-1",
          messageId: "msg-compact-1",
          status: "retrying",
          trigger: "auto",
          display: "separator",
          attempt: 2,
          maxAttempts: 3,
          reason: "Failed to generate compact summary",
        },
      } satisfies ZCodeSessionEvent,
      state,
      taskId: "sess_1",
    });

    expect(events[0]).toMatchObject({
      type: "agent_message_chunk",
      taskId: "sess_1",
      traceId: "input-compact",
      inputId: "input-compact",
      messageId: "msg-compact-1",
      content: "",
      zcodeTimeline: {
        type: "context_compaction",
        operationId: "cmp-1",
        status: "retrying",
        trigger: "auto",
        attempt: 2,
        maxAttempts: 3,
        reason: "Failed to generate compact summary",
      },
    });
  });

  it("projects compact skipped payloads to context compaction timeline chunks", () => {
    const state = {
      activePromptInputIdBySession: new Map([["sess_1", "input-compact"]]),
      streamedTurnKeys: new Set<string>(),
      toolNameById: new Map<string, string>(),
    };

    const events = zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_compact_skipped",
        sessionId: "sess_1",
        turnId: "turn_compact",
        seq: 3,
        timestamp: 4,
        traceId: "trace_compact",
        type: "session.updated",
        payload: {
          operationId: "cmp-skipped",
          messageId: "msg-compact-skipped",
          status: "skipped",
          trigger: "manual",
          display: "separator",
        },
      } satisfies ZCodeSessionEvent,
      state,
      taskId: "sess_1",
    });

    expect(events[0]).toMatchObject({
      type: "agent_message_chunk",
      taskId: "sess_1",
      traceId: "input-compact",
      inputId: "input-compact",
      messageId: "msg-compact-skipped",
      content: "",
      zcodeTimeline: {
        type: "context_compaction",
        operationId: "cmp-skipped",
        status: "skipped",
        trigger: "manual",
      },
    });
  });

  it("projects fork notice part upserts to session fork timeline chunks", () => {
    const state = {
      activePromptInputIdBySession: new Map<string, string>(),
      streamedTurnKeys: new Set<string>(),
      toolNameById: new Map<string, string>(),
    };

    const events = zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_fork_notice",
        sessionId: "forked-session",
        seq: 1,
        timestamp: 2,
        traceId: "trace_fork",
        type: "part.upserted",
        payload: {
          part: {
            partId: "part_fork_notice",
            sessionId: "forked-session",
            messageId: "msg_fork_notice",
            type: "text",
            text: "Forked from parent",
            metadata: {
              forkContext: {
                kind: "session_fork",
                parentSessionId: "parent-session",
                targetMessageId: "parent-message",
                restoredFileCount: 2,
              },
            },
          },
        },
      } satisfies ZCodeSessionEvent,
      state,
      taskId: "forked-session",
    });

    expect(events).toEqual([
      {
        type: "agent_message_chunk",
        taskId: "forked-session",
        traceId: "trace_fork",
        messageId: "msg_fork_notice",
        content: "",
        zcodeTimeline: {
          version: 1,
          kind: "synthetic",
          type: "session_fork",
          display: "separator",
          parentSessionId: "parent-session",
          targetMessageId: "parent-message",
          restoredFileCount: 2,
        },
      },
    ]);
  });

  it("projects compact turn failures to failed timeline chunks instead of task errors", () => {
    const state = {
      activePromptInputIdBySession: new Map([["sess_1", "input-compact"]]),
      streamedTurnKeys: new Set<string>(),
      toolNameById: new Map<string, string>(),
    };

    const events = zcodeSessionEventToZCodeStreamEvents({
      event: {
        eventId: "evt_compact_failed",
        sessionId: "sess_1",
        turnId: "turn_compact",
        seq: 2,
        timestamp: 3,
        traceId: "trace_compact",
        type: "turn.failed",
        payload: {
          turnPhase: "compact",
          inputId: "input-compact",
          error: {
            message: "No summary produced.",
            type: "compact_failed",
          },
        },
      } satisfies ZCodeSessionEvent,
      state,
      taskId: "sess_1",
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent_message_chunk",
      taskId: "sess_1",
      traceId: "input-compact",
      inputId: "input-compact",
      zcodeTimeline: {
        type: "context_compaction",
        status: "failed",
        inputId: "input-compact",
        reason: "No summary produced.",
      },
    });
  });

  it("projects ZCode settings updates to model and mode state events", () => {
    const options = zcodeSessionSettingsToConfigOptions(settings);
    const events = zcodeStateUpdatedToZCodeStreamEvents({
      notification: {
        type: "state.updated",
        scope: "session",
        sessionId: "sess_1",
        revision: 2,
        reason: "model_changed",
        patch: settings,
      },
      settings,
      taskId: "sess_1",
    });

    expect(options.find((option) => option.category === "model")).toMatchObject({
      currentValue: "glm/glm-4.6",
    });
    expect(events.map((event) => event.type)).toEqual([
      "mode_update",
      "glm_agent_model_state_update",
    ]);
    expect(events[0]).toMatchObject({
      type: "mode_update",
      currentModeId: "build",
    });
    expect(events[1]).toMatchObject({
      type: "glm_agent_model_state_update",
      reason: "model_changed",
      model: {
        currentValue: "glm/glm-4.6",
      },
      thoughtLevel: {
        enabled: true,
        currentValue: "medium",
        options: [{ value: "medium", name: "Medium" }],
      },
      contextWindow: {
        tokens: 128000,
      },
    });
  });

  it("parses UI model values into strict ZCode model refs", () => {
    expect(parseModelPickerValue("glm/glm-4.6")).toEqual({
      providerId: "glm",
      modelId: "glm-4.6",
    });
    expect(parseModelPickerValue("custom-openai/agent-model$fast")).toEqual({
      providerId: "custom-openai",
      modelId: "agent-model",
      options: { reasoningLevel: "fast" },
    });
    expect(parseModelPickerValue("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free")).toEqual({
      providerId: "openrouter",
      modelId: "nvidia/nemotron-3-ultra-550b-a55b:free",
    });
    expect(parseModelPickerValue(encodeCustomModelValue("my-provider", "my-model"))).toEqual({
      providerId: "my-provider",
      modelId: "my-model",
    });
  });

  it("formats model variants with the reserved dollar separator", () => {
    const modelSelection = {
      providerId: "custom-openai",
      modelId: "agent-model:free",
      options: { reasoningLevel: "fast" },
    };

    expect(formatSharedModelSelection(modelSelection)).toBe("custom-openai/agent-model:free$fast");
    expect(formatProjectedModelSelection(modelSelection)).toBe(
      "custom-openai/agent-model:free$fast",
    );
  });

  it("projects web remote user input response to elicitation response", () => {
    expect(
      zcodeUserInputResponseToZCodeStreamEvent("sess_1", {
        requestId: "input-1",
        action: "accept",
        content: { answers: { answer_0: "a" } },
      }),
    ).toMatchObject({
      type: "elicitation_response",
      taskId: "sess_1",
      requestId: "input-1",
      action: "accept",
      content: { answers: { answer_0: "a" } },
    });
  });
});
