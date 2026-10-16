import { withoutAgentListingMessages } from "./test-agent-listing.js";
import { describe, expect, it } from "vitest";
import {
  createRootTraceContext,
  createSessionId,
  SessionEventType,
  type LogContext,
  type Logger,
  type McpConnectionSnapshot,
  type McpPort,
  type SessionEvent,
  type SessionEventSink,
  type SessionEventStorePort,
  type TraceContext,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelSelection } from "./test-model-selection.js";
import { createContextBuilder } from "../src/context/index.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestImageArtifactStore } from "./test-image-artifact-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

function providerContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object" && "type" in block) {
          if (block.type === "text" && "text" in block) {
            return String(block.text);
          }
          return JSON.stringify(block);
        }
        return String(block ?? "");
      })
      .join("\n");
  }
  return String(content ?? "");
}

function providerMessagesToText(messages: readonly { content?: unknown }[] | undefined): string {
  return (messages ?? []).map((message) => providerContentToText(message.content)).join("\n");
}

describe("AgentRuntime trace propagation", () => {
  it("uses one trace id for turn, model, and session events", async () => {
    let capturedTraceContext: TraceContext | undefined;
    let capturedMetadata: Record<string, unknown> | undefined;
    const sessionId = createSessionId("runtime-trace");
    const traceContext = createRootTraceContext({ sessionId });
    const eventStore = createTestSessionEventStore();
    const logger = new CapturingLogger();
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore,
        logger,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            capturedTraceContext = observation.invocationContext?.traceContext;
            capturedMetadata = observation.invocationContext?.metadata;
            return {
              finishReason: "stop",
              model: observation.model,
              providerMetadata: undefined,
              text: "model response",
              usage: {
                inputTokens: 2,
                outputTokens: 3,
                totalTokens: 5,
              },
            };
          },
        } as never),
        traceContext,
      },
    );

    const result = await runtime.executeTurn("hello");
    const events = await eventStore.getEvents(sessionId);

    expect(result.traceId).toBe(traceContext.traceId);
    expect(new Set(events.map((event) => event.traceId))).toEqual(new Set([traceContext.traceId]));
    expect(events.map((event) => event.type)).toEqual([
      SessionEventType.TurnStarted,
      SessionEventType.ModelRequest,
      SessionEventType.ModelComplete,
      SessionEventType.TurnComplete,
    ]);
    const turnStarted = events.find((event) => event.type === SessionEventType.TurnStarted);
    const turnQueryId = (turnStarted?.payload as Record<string, unknown> | undefined)?.queryId;
    expect(turnQueryId).toEqual(expect.stringMatching(/^query_/));
    expect(capturedTraceContext?.traceId).toBe(traceContext.traceId);
    expect(capturedTraceContext?.queryId).toBe(turnQueryId);
    expect(capturedMetadata?.traceId).toBe(traceContext.traceId);
    expect(capturedMetadata?.queryId).toBe(turnQueryId);
    expect(capturedMetadata?.sessionId).toBe(sessionId);
    expect(result.response).toBe("model response");
    expect(result.projection.totalTokenCount).toBe(5);
    const turnComplete = events.find((event) => event.type === SessionEventType.TurnComplete);
    expect(turnComplete?.payload).toMatchObject({ historyRoundCount: 1 });

    const usageLog = logger.entries.find(
      (entry) => entry.level === "debug" && entry.message === "Context usage snapshot",
    );
    const usageContext = usageLog?.context as
      | (LogContext & {
          categories?: Array<Record<string, unknown>>;
          categoryBreakdown?: Array<Record<string, unknown>>;
          messageBreakdown?: Array<Record<string, unknown>>;
        })
      | undefined;
    expect(usageContext).toMatchObject({
      event: "context_usage_snapshot",
      module: "core.runtime",
      sessionId,
      status: "completed",
      tokenMethod: "estimated",
      traceId: traceContext.traceId,
    });
    expect(usageContext?.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          confidence: expect.any(String),
          source: "messages",
          tokenMethod: "estimated",
          tokenizer: "zcode.estimateTokens.v1",
          tokens: expect.any(Number),
        }),
      ]),
    );
    expect(usageContext?.messageBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          tokenMethod: "estimated",
        }),
      ]),
    );
    expect(
      usageContext?.categoryBreakdown?.find((category) => category.source === "messages"),
    ).toMatchObject({
      source: "messages",
      contributors: expect.arrayContaining([
        expect.objectContaining({
          kind: "message_role",
          role: "user",
          count: expect.any(Number),
          tokenMethod: "estimated",
        }),
      ]),
    });
    const modelComplete = events.find((event) => event.type === SessionEventType.ModelComplete);
    expect((modelComplete?.payload as Record<string, unknown>)?.contextUsageBreakdown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chars: expect.any(Number),
          source: "messages",
        }),
      ]),
    );
  });

  it("logs image attachment resolution and model media projection without payloads", async () => {
    const sessionId = createSessionId("runtime-image-media-logs");
    const traceContext = createRootTraceContext({ sessionId });
    const logger = new CapturingLogger();
    const runtime = createTestAgentRuntime(
      sessionId,
      { workingDirectory: "/workspace" },
      {
        artifactStore: createTestImageArtifactStore(),
        eventStore: createTestSessionEventStore(),
        logger,
        modelFactory: createTestModelFactory({
          async generateText() {
            return {
              finishReason: "stop",
              model: { modelId: "test-model", providerId: "test-provider" },
              providerMetadata: undefined,
              text: "image response",
              usage: {
                inputTokens: 2,
                outputTokens: 3,
                totalTokens: 5,
              },
            };
          },
        } as never),
        traceContext,
      },
    );

    await runtime.executeTurn("describe [image #1]", [
      {
        content: "data:image/png;base64,aW1hZ2U=",
        path: "[image #1]",
        type: "image",
      },
    ]);

    const attachmentLog = logger.entries.find(
      (entry) => entry.context?.event === "turn.attachments.resolved",
    );
    expect(attachmentLog?.context).toMatchObject({
      attachmentCount: 1,
      event: "turn.attachments.resolved",
      imageAttachmentCount: 1,
      module: "core.runtime",
      sessionId,
      status: "completed",
      traceId: traceContext.traceId,
    });
    expect(attachmentLog?.context?.attachments).toEqual([
      expect.objectContaining({
        contentBlockType: "image",
        mediaType: "image/png",
        mime: "image/png",
        placeholder: "[image #1]",
        recoverability: "provider_ready",
        sourceKind: "inline",
        storageKind: "artifact",
        urlKind: "artifact",
      }),
    ]);

    const mediaLog = logger.entries.find(
      (entry) => entry.context?.event === "model.request.media_summary",
    );
    expect(mediaLog?.context).toMatchObject({
      event: "model.request.media_summary",
      incomingMediaBlockCount: 1,
      omittedMediaCount: 0,
      providerMediaBlockCount: 1,
      retainedMediaCount: 1,
      sessionId,
      status: "completed",
      traceId: traceContext.traceId,
    });
    expect(mediaLog?.context?.providerMediaBlocks).toEqual([
      expect.objectContaining({
        blockType: "image",
        mediaType: "image/png",
        placeholder: "[image #1]",
        role: "user",
        sourceKind: "inline",
      }),
    ]);
    expect(JSON.stringify([attachmentLog?.context, mediaLog?.context])).not.toContain("aW1hZ2U");
  });

  it("logs turn steering queue, drain, and model request context", async () => {
    const sessionId = createSessionId("runtime-steer-logs");
    const traceContext = createRootTraceContext({ sessionId });
    const eventStore = createTestSessionEventStore();
    const logger = new CapturingLogger();
    let runtime: AgentRuntime;
    let modelCallCount = 0;

    runtime = createTestAgentRuntime(
      sessionId,
      { mode: "build" },
      {
        eventStore,
        logger,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            modelCallCount++;
            if (modelCallCount === 1) {
              const activeTurn = runtime.getActiveTurnInfo();
              expect(activeTurn?.steerable).toBe(true);
              const result = await runtime.steerTurn({
                delivery: "guide",
                expectedTurnId: activeTurn?.turnId,
                input: "keep the original task but switch to option B",
              });
              expect(result.kind).toBe("queued");
              return {
                finishReason: "stop",
                providerMetadata: undefined,
                text: "first answer",
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  totalTokens: 2,
                },
              };
            }

            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "second answer",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
        traceContext,
      },
    );

    const result = await runtime.executeTurn("original task");
    const logContexts = logger.entries.map((entry) => entry.context);
    const queued = logContexts.find((context) => context?.event === "turn.steer.queued");
    const drained = logContexts.find((context) => context?.event === "turn.steer.drained");
    const steeredRequest = logContexts.find(
      (context) =>
        context?.event === "model.request.steering_context" &&
        context.drainedInputVisibleAtTail === true,
    );

    expect(result.response).toBe("second answer");
    expect(modelCallCount).toBe(2);
    expect(queued).toMatchObject({
      event: "turn.steer.queued",
      inputPreview: "keep the original task but switch to option B",
      queryId: expect.stringMatching(/^query_/),
      queueLength: 1,
      sessionId,
      status: "waiting",
      traceId: traceContext.traceId,
    });
    const steerQueryId = queued?.queryId;
    expect(drained).toMatchObject({
      drainedCount: 1,
      event: "turn.steer.drained",
      inputPreviews: ["keep the original task but switch to option B"],
      queryId: steerQueryId,
      queryIds: [steerQueryId],
      sessionId,
      status: "completed",
      traceId: traceContext.traceId,
    });
    expect(steeredRequest).toMatchObject({
      drainedInputCount: 1,
      drainedInputVisibleAtTail: true,
      event: "model.request.steering_context",
      latestUserMessageFromEnd: 0,
      modelStepCount: 1,
      queryId: steerQueryId,
      sessionId,
      status: "completed",
      traceId: traceContext.traceId,
    });
    const messageTailRoles = steeredRequest?.messageTailRoles as string[] | undefined;
    expect(messageTailRoles?.slice(-2)).toEqual(["assistant", "user"]);
    const steeredMessageTail = steeredRequest?.messageTail as
      | Array<Record<string, unknown>>
      | undefined;
    expect(steeredMessageTail?.at(-1)).toMatchObject({
      contentBytes: "keep the original task but switch to option B".length,
      role: "user",
    });
  });

  it("emits full context sections through the debug logger for debug observers", async () => {
    const sessionId = createSessionId("runtime-context-debug");
    const traceContext = createRootTraceContext({ sessionId });
    const eventStore = createTestSessionEventStore();
    const logger = new CapturingLogger();
    const contextBuilder = createContextBuilder({
      workingDirectory: ".",
      envInfo: {
        cwd: ".",
        nodeVersion: "v24.14.0",
        osVersion: "test",
        platform: "test",
        shell: "test",
      },
    }).addSection({
      name: "Debug Section",
      source: "request_user_context",
      content: "debug context section body",
      preview: "debug context section body",
    });
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        contextBuilder,
        eventStore,
        logger,
        traceContext,
      },
    );

    expect(runtime.getContextBuilder()).toBe(contextBuilder);

    const contextLog = logger.entries.find(
      (entry) => entry.level === "debug" && entry.message === "Context built",
    );
    const context = contextLog?.context as
      | (LogContext & {
          sections?: Array<Record<string, unknown>>;
        })
      | undefined;

    expect(context).toMatchObject({
      event: "context.built",
      module: "core.runtime",
      sessionId,
      status: "completed",
      traceId: traceContext.traceId,
    });
    expect(context?.sections?.length).toBeGreaterThan(0);
    expect(context?.sections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chars: "debug context section body".length,
          content: "debug context section body",
          name: "Debug Section",
          preview: "debug context section body",
          source: "request_user_context",
          tokens: expect.any(Number),
        }),
      ]),
    );
    expect(context?.sections?.[0]).toEqual(
      expect.objectContaining({
        chars: expect.any(Number),
        content: expect.any(String),
        name: expect.any(String),
        preview: expect.any(String),
        source: expect.any(String),
        tokens: expect.any(Number),
      }),
    );
  });

  it("does not let getContextBuilder preempt async context initialization", async () => {
    const sessionId = createSessionId("runtime-get-context-builder-lazy-init");
    const eventStore = createTestSessionEventStore();
    let resolveCount = 0;
    let requestEnvInfo: unknown;
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const detectedEnvInfo = {
      cwd: "/resolved",
      platform: "linux",
      shell: "bash",
      osVersion: "Linux 6.6.0",
      nodeVersion: "v24.14.0",
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/initial",
      },
      {
        contextSourcePort: {
          async resolveContextSources(request) {
            resolveCount++;
            requestEnvInfo = request.envInfo;
            return {
              workingDirectory: "/resolved",
              currentDate: "2026-06-02",
              diagnostics: [],
              envInfo: request.envInfo ?? detectedEnvInfo,
              userInstructions: {
                filePath: "/resolved/AGENTS.md",
                fileName: "AGENTS.md",
                content: "resolved project instructions",
                bytesRead: "resolved project instructions".length,
                sizeBytes: "resolved project instructions".length,
                truncated: false,
              },
            };
          },
        },
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    runtime.getContextBuilder();
    await runtime.executeTurn("hello");

    expect(resolveCount).toBe(1);
    expect(requestEnvInfo).toBeUndefined();
    const requestText = providerMessagesToText(requests[0]);
    expect(requestText).toContain("/resolved");
    expect(requestText).toContain("- Platform: linux");
    expect(requestText).toContain("resolved project instructions");
    expect(requests[0]?.at(-1)?.role).toBe("user");
    expect(requests[0]?.at(-1)?.content).toContain("hello");
  });

  it("passes the effective Bash shell snapshot to context source resolution", async () => {
    const sessionId = createSessionId("runtime-context-effective-shell");
    const eventStore = createTestSessionEventStore();
    let requestShellDisplayName: unknown;
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        bashShellSelection: {
          dialect: "posix",
          display: { name: "zsh" },
          path: "/usr/bin/zsh",
          source: "auto-detected",
        },
        workingDirectory: "/resolved",
      },
      {
        contextSourcePort: {
          async resolveContextSources(request) {
            requestShellDisplayName = request.effectiveShellDisplayName;
            return {
              workingDirectory: "/resolved",
              currentDate: "2026-06-20",
              diagnostics: [],
              envInfo: {
                cwd: "/resolved",
                nodeVersion: "v24.14.0",
                osVersion: "Linux 6.6.0",
                platform: "linux",
                shell: request.effectiveShellDisplayName ?? "fish",
              },
            };
          },
        },
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("hello");

    expect(requestShellDisplayName).toBe("zsh");
    expect(providerMessagesToText(requests[0])).toContain("- Shell: zsh");
  });

  it("initializes session shell environment once and ignores later candidates", async () => {
    const sessionId = createSessionId("runtime-session-shell-owner-once");
    const eventStore = createTestSessionEventStore();
    let requestShellDisplayName: unknown;
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const firstSelection = {
      dialect: "posix" as const,
      display: { name: "zsh" },
      path: "/bin/zsh",
      source: "auto-detected" as const,
    };
    const secondSelection = {
      dialect: "posix" as const,
      display: { name: "bash" },
      path: "/bin/bash",
      source: "auto-detected" as const,
    };

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/workspace",
      },
      {
        contextSourcePort: {
          async resolveContextSources(request) {
            requestShellDisplayName = request.effectiveShellDisplayName;
            return {
              currentDate: "2026-06-23",
              diagnostics: [],
              envInfo: {
                cwd: "/workspace",
                nodeVersion: "v24.14.0",
                osVersion: "Linux 6.6.0",
                platform: "linux",
                shell: request.effectiveShellDisplayName ?? "fish",
              },
              workingDirectory: "/workspace",
            };
          },
        },
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    let firstCandidateResolveCount = 0;
    let secondCandidateResolveCount = 0;
    expect(
      runtime.initializeSessionShellEnvironmentIfNeeded(() => {
        firstCandidateResolveCount += 1;
        return firstSelection;
      }),
    ).toBe(true);
    expect(
      runtime.initializeSessionShellEnvironmentIfNeeded(() => {
        secondCandidateResolveCount += 1;
        return secondSelection;
      }),
    ).toBe(false);
    expect(firstCandidateResolveCount).toBe(1);
    expect(secondCandidateResolveCount).toBe(0);

    await runtime.executeTurn("check shell");

    expect(requestShellDisplayName).toBe("zsh");
    expect(providerMessagesToText(requests[0])).toContain("- Shell: zsh");
  });

  it("refreshes the initial shell environment when shell changes before the first conversation message", async () => {
    const sessionId = createSessionId("runtime-shell-pre-conversation-refresh");
    const traceContext = createRootTraceContext({ sessionId });
    const eventStore = createTestSessionEventStore();
    let requestMessages: Array<{ role: string; content: string }> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/workspace",
      },
      {
        contextSourcePort: {
          async resolveContextSources(request) {
            return {
              workingDirectory: "/workspace",
              currentDate: "2026-06-20",
              diagnostics: [],
              envInfo: {
                cwd: "/workspace",
                nodeVersion: "v24.14.0",
                osVersion: "Linux 6.6.0",
                platform: "linux",
                shell: request.effectiveShellDisplayName ?? "fish",
              },
            };
          },
        },
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requestMessages = withoutAgentListingMessages(request.messages).map((message) => ({
              content: providerContentToText(message.content),
              role: message.role,
            }));
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
        traceContext,
      },
    );

    await runtime.ensureContextInitialized(traceContext);
    runtime.initializeSessionShellEnvironmentIfNeeded({
      dialect: "git-bash",
      display: { name: "Git Bash" },
      id: "git-bash:/usr/bin/bash",
      label: "Git Bash",
      path: "/usr/bin/bash",
      source: "user-config",
    });
    await runtime.executeTurn("first");

    const requestText = providerMessagesToText(requestMessages);
    expect(requestText).toContain("- Shell: Git Bash");
    expect(requestText).not.toContain("- Shell: fish");
    expect(requestText).not.toContain("The Bash tool shell is Git Bash.");
  });

  it("does not let pre-initialization model updates preempt env detection", async () => {
    const sessionId = createSessionId("runtime-model-update-before-context-init");
    const eventStore = createTestSessionEventStore();
    let requestEnvInfo: unknown;
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const detectedEnvInfo = {
      cwd: "/resolved",
      platform: "linux",
      shell: "bash",
      osVersion: "Linux 6.6.0",
      nodeVersion: "v24.14.0",
      isGitRepository: true,
      gitBranch: "feat/trajectory-167",
      gitStatus: "dirty" as const,
      gitStatusLines: [" M package.json"],
      recentCommits: ["abc123 test commit"],
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        workingDirectory: "/resolved",
      },
      {
        contextSourcePort: {
          async resolveContextSources(request) {
            requestEnvInfo = request.envInfo;
            return {
              workingDirectory: "/resolved",
              currentDate: "2026-06-11",
              diagnostics: [],
              envInfo: request.envInfo ?? detectedEnvInfo,
            };
          },
        },
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    runtime.setSessionModelSelection(
      createTestModelSelection(createTestModelSelection("openai/test-model")),
    );
    await runtime.executeTurn("hello");

    expect(requestEnvInfo).toBeUndefined();
    const requestText = providerMessagesToText(requests[0]);
    expect(requestText).toContain("- Is a git repository: yes");
    expect(requestText).toContain("- Platform: linux");
    expect(requestText).toContain("Current branch: feat/trajectory-167");
    expect(requestText).not.toContain("- Platform: unknown");
    expect(requestText).not.toContain("- Is a git repository: no");
  });

  it("treats systemPrompt as a custom prompt while preserving userContext", async () => {
    const sessionId = createSessionId("runtime-custom-system-body");
    const eventStore = createTestSessionEventStore();
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        systemPrompt: "You are terse for this session.",
        language: "Chinese",
        outputStyle: {
          name: "Terse",
          prompt: "Keep responses short.",
          keepCodingInstructions: false,
        },
        compact: {
          enabled: true,
          microcompact: {
            enabled: true,
            keepRecentToolResults: 3,
          },
        },
        currentDate: "2026-06-04",
        projectContext: {
          type: "node",
          packageManager: "pnpm",
          scripts: {
            test: "vitest",
          },
        },
        envInfo: {
          cwd: "/workspace",
          platform: "linux",
          shell: "bash",
          osVersion: "Linux 6.6.0",
          nodeVersion: "v24.14.0",
          isGitRepository: true,
          gitBranch: "main",
          gitStatus: "dirty",
          gitStatusLines: [" M package.json"],
        },
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "ok",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("hello");

    expect(requests[0]?.[0]).toEqual(expect.objectContaining({ role: "system" }));
    expect(requests[0]?.[0]?.content).toBe("You are ZCode, an interactive coding agent");
    expect(requests[0]?.[0]?.content).not.toContain("# Agent Identity");
    expect(requests[0]?.[1]?.content).toBe("\nYou are terse for this session.");
    expect(requests[0]?.[1]?.content).not.toContain("# Task Behavior");
    expect(requests[0]?.[1]?.content).not.toContain("# Agent Identity");
    expect(requests[0]?.[2]?.role).toBe("user");
    expect(requests[0]?.[2]?.content).not.toContain("# agentsMd");
    expect(requests[0]?.[2]?.content).not.toContain("# claudeMd");
    expect(requests[0]?.[2]?.content).not.toContain("Project context:");
    expect(requests[0]?.[2]?.content).not.toContain("- Package manager: pnpm");
    expect(requests[0]?.[2]?.content).not.toContain("- `test`: vitest");
    expect(requests[0]?.[2]?.content).toContain("# currentDate");
    expect(requests[0]?.[2]?.content).not.toContain("# user_instructions");
    expect(requests[0]?.[2]?.content).not.toContain("hello");
    expect(requests[0]?.[3]?.role).toBe("user");
    expect(requests[0]?.[3]?.content).toContain("Terse output style is active");
    expect(requests[0]?.[3]?.content).toContain("<system-reminder>");
    expect(requests[0]?.[4]?.role).toBe("user");
    expect(requests[0]?.[4]?.content).toContain("hello");
    const providerText = providerMessagesToText(requests[0]);
    expect(providerText).not.toContain("# Session Guidance");
    expect(providerText).not.toContain("# Session-specific guidance");
    expect(providerText).not.toContain("## Current Environment");
    expect(providerText).not.toContain("# Environment");
    expect(providerText).not.toContain("# Context management");
    expect(providerText).not.toContain("# Memory");
    expect(providerText).not.toContain("# Language");
    expect(providerText).not.toContain("# Output Style: Terse");
    expect(providerText).not.toContain("# Function Result Clearing");
    expect(providerText).not.toContain("# Summarize Tool Results");
    expect(providerText).not.toContain("M package.json");
  });

  it("preserves context prefix and conversation history without request-time prefix mutation", async () => {
    const sessionId = createSessionId("runtime-context-prefix-refresh");
    const eventStore = createTestSessionEventStore();
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        envInfo: {
          cwd: "/workspace",
          platform: "linux",
          shell: "bash",
          osVersion: "Linux 6.6.0",
          nodeVersion: "v24.14.0",
        },
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: requests.length === 1 ? "first" : "second",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("first");
    await runtime.executeTurn("second");

    expect(requests[1]?.filter((message) => message.role === "system")).toHaveLength(3);
    const secondRequestText = providerMessagesToText(requests[1]);
    expect(secondRequestText).not.toContain("# Session-specific guidance");
    expect(secondRequestText).not.toContain("`! <command>`");
    expect(secondRequestText).not.toContain(
      "Otherwise use `find` or `grep` via the Bash tool directly.",
    );
    expect(secondRequestText).toContain("first");
    expect(secondRequestText).toContain("second");
  });

  it("keeps aligned system prompt shape across multiple turns with dynamic sections and MCP tools", async () => {
    const sessionId = createSessionId("runtime-system-prompt-multi-turn-dynamic-mcp");
    const eventStore = createTestSessionEventStore();
    const requests: Array<{
      messages: Array<{ role: string; content: string; cacheControl?: unknown }>;
      toolNames: string[];
    }> = [];
    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => ({
        statuses: {
          local: {
            status: "connected",
            transport: "stdio",
            toolCount: 1,
            updatedAt: "now",
          },
        },
        tools: [
          {
            serverName: "local",
            toolName: "ping",
            inputSchema: {
              type: "object",
              properties: {},
            },
            annotations: {
              readOnlyHint: true,
            },
          },
        ],
      }),
    });
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        compact: {
          enabled: true,
          microcompact: {
            enabled: true,
            keepRecentToolResults: 2,
          },
        },
        envInfo: {
          cwd: "/workspace",
          platform: "linux",
          shell: "bash",
          osVersion: "Linux 6.6.0",
          nodeVersion: "v24.14.0",
        },
        language: "Spanish",
        mcp: {
          enabled: true,
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
        outputStyle: {
          name: "Learning",
          prompt: "Explain tradeoffs while solving the task.",
          keepCodingInstructions: false,
        },
      },
      {
        eventStore,
        mcpPort,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push({
              messages: withoutAgentListingMessages(request.messages).map((message) => ({
                cacheControl: message.cacheControl,
                content: providerContentToText(message.content),
                role: message.role,
              })),
              toolNames: request.tools.map((tool: { name: string }) => tool.name),
            });
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: requests.length === 1 ? "first response" : "second response",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("first question");
    await runtime.executeTurn("second question");

    const second = requests[1];
    expect(second?.messages.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
      "user",
      "user",
      "assistant",
      "user",
      "user",
    ]);
    expect(second?.toolNames).toContain("mcp__local__ping");

    const cliPrefix = second?.messages[0]?.content ?? "";
    const stableBody = second?.messages[1]?.content ?? "";
    const dynamicSystem = second?.messages[2]?.content ?? "";

    expect(cliPrefix).toBe("You are ZCode, an interactive coding agent");
    expect(stableBody).not.toContain("# Agent Identity");
    expect(stableBody).toContain("according to the active Output Style below");
    expect(stableBody).not.toContain("# Task Behavior");
    expect(stableBody).toContain("# Harness");
    expect(stableBody).not.toContain("# Session-specific guidance");
    expect(stableBody).not.toContain("# Environment");
    expect(stableBody).not.toContain("# Context management");
    expect(stableBody).not.toContain("# Risky Actions");
    expect(stableBody).not.toContain("Write code that reads like the surrounding code");
    expect(stableBody).not.toContain("For actions that are hard to reverse");
    expect(dynamicSystem).not.toContain("# Session Guidance");
    expect(dynamicSystem).toMatch(/^\n\n# Communicating with the user/);
    expect(dynamicSystem).toContain("Write code that reads like the surrounding code");
    expect(dynamicSystem).toContain("For actions that are hard to reverse");
    expect(dynamicSystem).not.toContain("# Session-specific guidance");
    expect(dynamicSystem).not.toContain("`! <command>`");
    expect(dynamicSystem).toContain("# Environment");
    expect(dynamicSystem).toContain("# Context management");
    expect(dynamicSystem).not.toContain("not a git repository");
    expect(dynamicSystem).not.toContain("- **Git**:");
    expect(dynamicSystem).not.toContain("# Language");
    expect(dynamicSystem).not.toContain(
      "Respond in the primary language of the user's current prompt",
    );
    expect(dynamicSystem).not.toContain("Respond in Spanish");
    expect(dynamicSystem).toContain("# Output Style: Learning");
    expect(dynamicSystem).toContain("Explain tradeoffs while solving the task.");
    expect(dynamicSystem).toContain(
      "# Output Style: Learning\nExplain tradeoffs while solving the task.",
    );
    expect(dynamicSystem).not.toContain("# Output Style: Learning\n\n");
    expect(dynamicSystem).not.toContain("# Function Result Clearing");
    expect(dynamicSystem).not.toContain("compactable tool results");
    expect(dynamicSystem).not.toContain("# Summarize Tool Results");
    expect(dynamicSystem).not.toContain("mcp__local__ping");
    expect(dynamicSystem).not.toContain("scratchpad");
    expect(dynamicSystem).not.toContain("token_budget");
    expect(dynamicSystem.indexOf("# Output Style: Learning")).toBeLessThan(
      dynamicSystem.indexOf("# Context management"),
    );
    expect(second?.messages[4]?.content).toContain("first question");
    expect(second?.messages[4]?.content).not.toContain("Learning output style is active");
    expect(second?.messages[7]?.content).toContain("second question");
    const firstOutputStyleReminder = second?.messages[3]?.content ?? "";
    const secondOutputStyleReminder = second?.messages[6]?.content ?? "";
    expect(firstOutputStyleReminder).toContain("Learning output style is active");
    expect(secondOutputStyleReminder).toContain("Learning output style is active");
    expect(firstOutputStyleReminder).toContain("<system-reminder>");
    expect(secondOutputStyleReminder).toContain("<system-reminder>");
    expect(secondOutputStyleReminder).not.toContain("Explain tradeoffs while solving the task.");
    expect(secondOutputStyleReminder).not.toContain("source=");
    expect(
      providerMessagesToText(second?.messages).match(/Learning output style is active/g),
    ).toHaveLength(2);
    expect(JSON.stringify(second?.messages)).not.toContain("runtimeMessage");
  });

  it("preserves system-reminder-looking real user text across config refresh", async () => {
    const sessionId = createSessionId("runtime-config-refresh-real-user-reminder-text");
    const literalUserPrompt = "<system-reminder>\nuser typed this literal tag\n</system-reminder>";
    const requests: Array<Array<{ role: string; content: unknown; cacheControl?: unknown }>> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                cacheControl: message.cacheControl,
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: requests.length === 1 ? "first response" : "second response",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn(literalUserPrompt);
    runtime.updateConfig({
      outputStyle: {
        name: "Learning",
        prompt: "Explain tradeoffs while solving the task.",
      },
    });
    await runtime.executeTurn("second question");

    const secondMessages = requests[1] ?? [];
    expect(
      secondMessages.some(
        (message) => message.role === "user" && message.content.includes(literalUserPrompt),
      ),
    ).toBe(true);
    expect(
      secondMessages.some(
        (message) => message.role === "user" && message.content.includes("second question"),
      ),
    ).toBe(true);
    expect(JSON.stringify(secondMessages)).not.toContain("runtimeMessage");
    expect(JSON.stringify(secondMessages)).not.toContain("real_user");
    expect(JSON.stringify(secondMessages)).not.toContain("context_prefix");
  });

  it("keeps conversation history across turns in one runtime", async () => {
    const sessionId = createSessionId("runtime-history");
    const eventStore = createTestSessionEventStore();
    const requests: Array<Array<{ role: string; content: string; cacheControl?: unknown }>> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                cacheControl: message.cacheControl,
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );

            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: requests.length === 1 ? "first response" : "second response",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("first question");
    await runtime.executeTurn("second question");

    expect(requests[0]?.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
      "user",
    ]);
    expect(requests[0]?.[0]?.content).toBe("You are ZCode, an interactive coding agent");
    expect(requests[0]?.[0]?.content).not.toContain("# Agent Identity");
    expect(requests[0]?.[1]?.content).not.toContain("# Agent Identity");
    expect(requests[0]?.[1]?.content).toMatch(/^\n?You are an interactive ZCode agent/);
    expect(requests[0]?.[1]?.content).toContain("# Harness");
    expect(requests[0]?.[1]?.content).not.toContain("# Session-specific guidance");
    expect(requests[0]?.[1]?.content).not.toContain("# Environment");
    expect(requests[0]?.[1]?.content).not.toContain("# Context management");
    expect(requests[0]?.[1]?.content).not.toContain("# Task Behavior");
    expect(requests[0]?.[1]?.content).not.toContain(
      "Write code that reads like the surrounding code",
    );
    expect(requests[0]?.[1]?.content).not.toContain("For actions that are hard to reverse");
    expect(requests[0]?.[2]?.content).toMatch(/^\n\n# Communicating with the user/);
    expect(requests[0]?.[2]?.content).toContain(
      "Your text output is what the user reads; they usually can't see your thinking or the raw tool results.",
    );
    expect(requests[0]?.[2]?.content).toContain(
      "Only write a code comment to state a constraint the code itself can't show",
    );
    expect(requests[0]?.[2]?.content).toContain(
      "For actions that are hard to reverse or outward-facing",
    );
    expect(
      requests[0]?.[2]?.content.indexOf("Write code that reads like the surrounding code"),
    ).toBeLessThan(
      requests[0]?.[2]?.content.indexOf(
        "Only write a code comment to state a constraint the code itself can't show",
      ) ?? -1,
    );
    expect(
      requests[0]?.[2]?.content.indexOf(
        "Only write a code comment to state a constraint the code itself can't show",
      ),
    ).toBeLessThan(requests[0]?.[2]?.content.indexOf("For actions that are hard to reverse") ?? -1);
    expect(requests[0]?.[2]?.content.indexOf("For actions that are hard to reverse")).toBeLessThan(
      requests[0]?.[2]?.content.indexOf("# Environment") ?? -1,
    );
    expect(requests[0]?.[2]?.content).not.toContain("# Session-specific guidance");
    expect(requests[0]?.[2]?.content).not.toContain("`! <command>`");
    expect(requests[0]?.[2]?.content).not.toContain("# Language");
    expect(requests[0]?.[2]?.content).not.toContain("# Function Result Clearing");
    expect(requests[0]?.[2]?.content).not.toContain("# Summarize Tool Results");
    expect(requests[0]?.[2]?.content).not.toContain("## Current Environment");
    expect(requests[0]?.[2]?.content).toContain("# Environment");
    expect(requests[0]?.[2]?.content).toContain("# Context management");
    expect(requests[0]?.[2]?.content).toContain(
      "When you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey",
    );
    expect(requests[0]?.[2]?.content.indexOf("# Context management")).toBeLessThan(
      requests[0]?.[2]?.content.indexOf("When you have enough information to act, act.") ?? -1,
    );
    expect(
      requests[0]?.[2]?.content.indexOf("When you have enough information to act, act."),
    ).toBeLessThan(requests[0]?.[2]?.content.indexOf("You are operating autonomously.") ?? -1);
    expect(requests[0]?.[2]?.content).toContain(
      "Exception: when the user is describing a problem, asking a question, or thinking out loud rather than requesting a change",
    );
    expect(requests[0]?.[2]?.content).toContain(
      "Before ending your turn, check your last paragraph.",
    );
    expect(
      requests[0]?.[2]?.content.endsWith(
        "A signal that pattern-matches to a known failure may have a different cause.",
      ),
    ).toBe(true);
    expect(requests[0]?.[2]?.content).not.toContain("not a git repository");
    expect(requests[0]?.[2]?.content).not.toContain("- **Git**:");
    expect(requests[0]?.[3]).toEqual({
      role: "user",
      content: "first question",
      cacheControl: { type: "ephemeral" },
    });
    expect(requests[1]?.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(requests[1]?.[3]?.content).toBe("first question");
    expect(requests[1]?.[3]?.cacheControl).toBeUndefined();
    expect(requests[1]?.[4]?.content).toBe("first response");
    expect(requests[1]?.[5]).toEqual({
      role: "user",
      content: "second question",
      cacheControl: { type: "ephemeral" },
    });
  });

  it("keeps structured context prefix before real user messages across turns", async () => {
    const sessionId = createSessionId("runtime-meta-user-context");
    const eventStore = createTestSessionEventStore();
    const requests: Array<Array<{ role: string; content: string; cacheControl?: unknown }>> = [];
    const contextBuilder = createContextBuilder({
      workingDirectory: "/workspace",
      currentDate: "2026-05-04",
      envInfo: {
        cwd: "/workspace",
        nodeVersion: "v24.14.0",
        osVersion: "test",
        platform: "test",
        shell: "test",
      },
      userInstructions: {
        filePath: "/workspace/AGENTS.md",
        fileName: "AGENTS.md",
        content: "project instructions",
        bytesRead: 20,
        sizeBytes: 20,
        truncated: false,
      },
    });
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        contextBuilder,
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                cacheControl: message.cacheControl,
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );

            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: requests.length === 1 ? "first response" : "second response",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("first question");
    await runtime.executeTurn("second question");

    expect(requests[0]?.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
      "user",
    ]);
    expect(requests[0]?.[0]?.cacheControl).toEqual({ type: "ephemeral" });
    expect(requests[0]?.[1]?.cacheControl).toEqual({ type: "ephemeral" });
    expect(requests[0]?.[2]?.cacheControl).toEqual({ type: "ephemeral" });
    expect(requests[0]?.[3]?.content).toContain("first question");
    expect(requests[0]?.[3]?.cacheControl).toEqual({ type: "ephemeral" });
    expect(requests[1]?.map((message) => message.role)).toEqual([
      "system",
      "system",
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(requests[1]?.[3]?.content).toContain("first question");
    expect(requests[1]?.[3]?.cacheControl).toBeUndefined();
    expect(requests[1]?.[5]?.content).toContain("second question");
    expect(requests[1]?.[5]?.cacheControl).toEqual({ type: "ephemeral" });
  });

  it("emits date change reminder once without refreshing request prefix date", async () => {
    const sessionId = createSessionId("runtime-date-change");
    const eventStore = createTestSessionEventStore();
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const dates = [
      new Date(2026, 5, 2, 10, 0, 0),
      new Date(2026, 5, 2, 11, 0, 0),
      new Date(2026, 5, 3, 0, 5, 0),
      new Date(2026, 5, 3, 9, 0, 0),
    ];
    let nowIndex = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        currentDate: "2026-06-02",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            requests.push(
              withoutAgentListingMessages(request.messages).map((message) => ({
                content: providerContentToText(message.content),
                role: message.role,
              })),
            );
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: `response ${requests.length}`,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
        now: () => dates[Math.min(nowIndex++, dates.length - 1)]!,
      },
    );

    await runtime.executeTurn("first question");
    await runtime.executeTurn("second question");
    await runtime.executeTurn("third question");
    await runtime.executeTurn("fourth question");

    const requestTexts = requests.map((messages) =>
      messages.map((message) => message.content).join("\n"),
    );
    expect(requestTexts[0]).not.toContain("The date has changed.");
    expect(requestTexts[1]).not.toContain("The date has changed.");
    expect(requestTexts[2]).toContain("The date has changed. Today's date is now 2026-06-03.");
    expect(requestTexts[3]).toContain("The date has changed. Today's date is now 2026-06-03.");
    expect(
      requests[2]?.filter((message) => message.content.includes("The date has changed.")),
    ).toHaveLength(1);
    expect(
      requests[3]?.filter((message) => message.content.includes("The date has changed.")),
    ).toHaveLength(1);
    expect(requestTexts[2]).toContain("Today's date is 2026-06-02.");
    expect(requestTexts[3]).toContain("Today's date is 2026-06-02.");
    expect(requestTexts[2]).not.toContain("Today's date is 2026-06-03.");
  });

  it("publishes appended events to a live event sink in order", async () => {
    const sessionId = createSessionId("runtime-live-events");
    const eventStore = createTestSessionEventStore();
    const liveEvents: Array<{ sequenceNumber: number; type: string }> = [];
    const eventSink: SessionEventSink = {
      onSessionEvent(event) {
        liveEvents.push({
          sequenceNumber: event.sequenceNumber,
          type: event.type,
        });
      },
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventSink,
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "live response",
              usage: {
                inputTokens: 2,
                outputTokens: 3,
                totalTokens: 5,
              },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("hello live events");

    const storedEvents = (await eventStore.getEvents(sessionId)).map((event) => ({
      sequenceNumber: event.sequenceNumber,
      type: event.type,
    }));
    expect(liveEvents).toEqual([
      { sequenceNumber: 1, type: SessionEventType.TurnStarted },
      { sequenceNumber: 2, type: SessionEventType.ModelRequest },
      { sequenceNumber: 3, type: SessionEventType.ModelComplete },
      { sequenceNumber: 4, type: SessionEventType.TurnComplete },
    ]);
    expect(liveEvents).toEqual(storedEvents);
  });

  it("streams model deltas through session events when enabled", async () => {
    const sessionId = createSessionId("runtime-model-streaming");
    const eventStore = createTestSessionEventStore();
    const logger = new CapturingLogger();
    const runtime = createTestAgentRuntime(
      sessionId,
      { modelStreaming: "on" },
      {
        eventStore,
        logger,
        modelFactory: createTestModelFactory({
          async generateText() {
            throw new Error("generateText should not be used");
          },
          async *streamText(request) {
            expect(withoutAgentListingMessages(request.messages).at(-1)).toMatchObject({
              content: "hello streaming",
              role: "user",
            });
            yield { type: "text_delta", text: "he" };
            yield { type: "text_delta", text: "llo" };
            yield {
              type: "finish",
              finishReason: "stop",
              usage: {
                inputTokens: 2,
                outputTokens: 3,
                totalTokens: 5,
              },
            };
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("hello streaming");
    const events = await eventStore.getEvents(sessionId);
    const streamingPayloads = events
      .filter((event) => event.type === SessionEventType.ModelStreaming)
      .map((event) => event.payload as { delta: string; done: boolean; kind: string });

    expect(result.response).toBe("hello");
    expect(streamingPayloads).toEqual([
      { assistantMessageId: expect.any(String), delta: "he", done: false, kind: "text_delta" },
      { assistantMessageId: expect.any(String), delta: "llo", done: false, kind: "text_delta" },
      { assistantMessageId: expect.any(String), delta: "", done: true, kind: "finish" },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      SessionEventType.TurnStarted,
      SessionEventType.ModelRequest,
      SessionEventType.ModelStreaming,
      SessionEventType.ModelStreaming,
      SessionEventType.ModelStreaming,
      SessionEventType.ModelComplete,
      SessionEventType.TurnComplete,
    ]);

    const appendSummary = logger.entries.find(
      (entry) => entry.context?.event === "event_store.appended.summary",
    );
    expect(appendSummary?.context).toMatchObject({
      event: "event_store.appended.summary",
      eventCount: 3,
      firstSessionEventSequenceNumber: 3,
      flushReason: "low_frequency_event",
      lastSessionEventSequenceNumber: 5,
      module: "core.runtime",
      payloadKinds: {
        finish: 1,
        text_delta: 2,
      },
      sessionEventType: SessionEventType.ModelStreaming,
    });
    expect(
      logger.entries.some(
        (entry) =>
          entry.context?.event === "event_store.appended" &&
          entry.context.sessionEventType === SessionEventType.ModelStreaming,
      ),
    ).toBe(false);
  });

  it("keeps consuming model stream chunks while streaming event append is pending", async () => {
    const sessionId = createSessionId("runtime-model-streaming-append-backpressure");
    const baseEventStore = createTestSessionEventStore();
    const firstStreamingAppendStarted = createDeferred<void>();
    const releaseFirstStreamingAppend = createDeferred<void>();
    const secondChunkConsumed = createDeferred<"resolved">();
    let delayedFirstStreamingAppend = false;
    const eventStore: SessionEventStorePort = {
      async append(event: SessionEvent) {
        if (
          event.type === SessionEventType.ModelStreaming &&
          (event.payload as { kind?: string }).kind === "text_delta" &&
          !delayedFirstStreamingAppend
        ) {
          delayedFirstStreamingAppend = true;
          firstStreamingAppendStarted.resolve();
          await releaseFirstStreamingAppend.promise;
        }
        return baseEventStore.append(event);
      },
      deleteSession: (id) => baseEventStore.deleteSession(id),
      getEvents: (id) => baseEventStore.getEvents(id),
      getEventsAfter: (id, sequenceNumber) => baseEventStore.getEventsAfter(id, sequenceNumber),
      getLatestSequenceNumber: (id) => baseEventStore.getLatestSequenceNumber(id),
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      { modelStreaming: "on" },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText() {
            throw new Error("generateText should not be used");
          },
          async *streamText() {
            yield { type: "text_delta", text: "直" };
            secondChunkConsumed.resolve("resolved");
            yield { type: "text_delta", text: "接" };
            yield {
              type: "finish",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 2,
                totalTokens: 3,
              },
            };
          },
        } as never),
      },
    );

    const turnPromise = runtime.executeTurn("hello streaming backpressure");
    await firstStreamingAppendStarted.promise;
    await expect(Promise.race([secondChunkConsumed.promise, waitForTest(30)])).resolves.toBe(
      "resolved",
    );
    releaseFirstStreamingAppend.resolve();

    const result = await turnPromise;
    const streamingPayloads = (await baseEventStore.getEvents(sessionId))
      .filter((event) => event.type === SessionEventType.ModelStreaming)
      .map((event) => event.payload as { delta: string; kind: string });

    expect(result.response).toBe("直接");
    expect(streamingPayloads).toEqual([
      { assistantMessageId: expect.any(String), delta: "直", done: false, kind: "text_delta" },
      { assistantMessageId: expect.any(String), delta: "接", done: false, kind: "text_delta" },
      { assistantMessageId: expect.any(String), delta: "", done: true, kind: "finish" },
    ]);
  });

  it("continues the turn when a live event sink fails", async () => {
    const sessionId = createSessionId("runtime-live-event-sink-failure");
    const eventStore = createTestSessionEventStore();
    const liveEventTypes: string[] = [];
    const eventSink: SessionEventSink = {
      onSessionEvent(event) {
        liveEventTypes.push(event.type);
        if (event.type === SessionEventType.ModelComplete) {
          throw new Error("live sink unavailable");
        }
      },
    };
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventSink,
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "sink failure still returns",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("hello failing sink");
    const storedTypes = (await eventStore.getEvents(sessionId)).map((event) => event.type);

    expect(result.response).toBe("sink failure still returns");
    expect(liveEventTypes).toContain(SessionEventType.ModelComplete);
    expect(storedTypes).toContain(SessionEventType.TurnComplete);
  });
});

interface CapturedLogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: LogContext;
  error?: Error;
}

class CapturingLogger implements Logger {
  readonly entries: CapturedLogEntry[];

  constructor(
    private readonly defaultContext: LogContext = {},
    entries: CapturedLogEntry[] = [],
  ) {
    this.entries = entries;
  }

  debug(message: string, context?: LogContext): void {
    this.push("debug", message, context);
  }

  info(message: string, context?: LogContext): void {
    this.push("info", message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.push("warn", message, context);
  }

  error(message: string, error?: Error, context?: LogContext): void {
    this.push("error", message, context, error);
  }

  child(context: LogContext): Logger {
    return new CapturingLogger({ ...this.defaultContext, ...context }, this.entries);
  }

  private push(
    level: CapturedLogEntry["level"],
    message: string,
    context?: LogContext,
    error?: Error,
  ): void {
    this.entries.push({
      level,
      message,
      context: { ...this.defaultContext, ...context },
      error,
    });
  }
}

function createMockMcpPort(overrides: Partial<McpPort> = {}): McpPort {
  return {
    connectConfiguredServers: async () => emptyMcpSnapshot(),
    connectServer: async () => ({
      status: "connected",
      transport: "stdio",
      toolCount: 1,
      updatedAt: "now",
    }),
    disconnectServer: async () => undefined,
    status: async () => ({}),
    listTools: async () => [],
    callTool: async () => ({ content: [{ type: "text", text: "pong" }] }),
    close: async () => {},
    ...overrides,
  };
}

function emptyMcpSnapshot(): McpConnectionSnapshot {
  return {
    statuses: {},
    tools: [],
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function waitForTest(delayMs: number): Promise<"timeout"> {
  return new Promise((resolve) => {
    setTimeout(() => resolve("timeout"), delayMs);
  });
}
