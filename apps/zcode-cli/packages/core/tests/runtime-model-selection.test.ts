import { describe, expect, it, vi } from "vitest";
import { createTestModelSelection } from "./test-model-selection.js";
import {
  CoreErrorType,
  ModelRetryBudget,
  SessionEventType,
  createModelId,
  createModelProviderId,
  createSessionId,
  type Logger,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

/** 只捕获 warn 的 Logger 桩：退回路径的留痕本身是回归断言的一部分。 */
function createWarnCapturingLogger(warn: ReturnType<typeof vi.fn>): Logger {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: () => logger,
  };
  return logger as unknown as Logger;
}

/** 加速 provider 上的请求按卡过期（3402）失败，其他 provider 正常完成。 */
function createCardExpiryModelFactory(
  highspeedProviderId: string,
  requests: Array<{ modelId: string; providerId: string }>,
) {
  return createTestModelFactory({
    async generateText(_request, observation) {
      requests.push({
        modelId: String(observation.model.modelId),
        providerId: String(observation.model.providerId),
      });
      if (String(observation.model.providerId) === highspeedProviderId) {
        throw Object.assign(new Error("highspeed card is invalid"), {
          code: "invalid_model_request",
          context: {
            providerCode: "3402",
            providerId: highspeedProviderId,
            modelId: "GLM-5.3",
            source: "provider",
            statusCode: 400,
          },
          name: "AiSdkModelAdapterError",
        });
      }
      return {
        finishReason: "stop",
        model: observation.model,
        text: "continued with the original model",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      };
    },
  });
}

const cardExpiryFallbackRules = [
  { reason: "highspeed_card_expired" as const, providerErrorCode: "3402" },
  { reason: "highspeed_request_failed" as const },
];

describe("AgentRuntime model selection event", () => {
  it("首轮只按 admitted Active Model 构造一次 Context", async () => {
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-first-turn-single-context-build"),
      {
        modelSelection: createTestModelSelection("provider-a/model-a"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            return {
              finishReason: "stop",
              model: observation.model,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );
    const internalRuntime = runtime as typeof runtime & {
      createContextBuilderFromSnapshot: (...args: unknown[]) => unknown;
    };
    const createContextBuilderFromSnapshot =
      internalRuntime.createContextBuilderFromSnapshot.bind(internalRuntime);
    let contextBuildCount = 0;
    internalRuntime.createContextBuilderFromSnapshot = (...args: unknown[]) => {
      contextBuildCount++;
      return createContextBuilderFromSnapshot(...args);
    };

    await runtime.executeTurn("first turn");
    expect(contextBuildCount).toBe(1);

    await runtime.executeTurn("second turn");
    expect(contextBuildCount).toBe(2);
  });

  it("uses the admitted Active Model for both Context and the provider request", async () => {
    const requests: Array<{ modelId: string; providerId: string; text: string }> = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-active-model-context"),
      {
        modelSelection: createTestModelSelection("provider-a/model-a"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            requests.push({
              modelId: String(observation.model.modelId),
              providerId: String(observation.model.providerId),
              text: JSON.stringify(request.messages),
            });
            return {
              finishReason: "stop",
              model: observation.model,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    await runtime.executeTurn("switch now", undefined, {
      intent: {
        kind: "sendText",
        modelSelection: {
          providerId: "provider-b",
          modelId: "model-b",
          options: { reasoningLevel: "high" },
        },
        requestedDelivery: "start-now",
        sourceCommandId: "switch-command",
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ providerId: "provider-b", modelId: "model-b" });
    expect(requests[0]?.text).toContain("provider-b/model-b");
    expect(requests[0]?.text).not.toContain("provider-a/model-a");
  });

  it("uses an execution-scoped Active Model in Context without changing Session Selection", async () => {
    const requests: Array<{ modelId: string; providerId: string; text: string }> = [];
    const sessionSelection = createTestModelSelection("provider-a/model-a");
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-execution-model-context"),
      {
        modelSelection: sessionSelection,
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            requests.push({
              modelId: String(observation.model.modelId),
              providerId: String(observation.model.providerId),
              text: JSON.stringify(request.messages),
            });
            return {
              finishReason: "stop",
              model: observation.model,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    await runtime.executeTurn("idle task", undefined, {
      intent: {
        kind: "sendText",
        modelSelection: {
          providerId: "account:zai-offpeak-idle-plan",
          modelId: "GLM-5.2",
          options: { reasoningLevel: "high" },
        },
        requestedDelivery: "start-now",
        sourceCommandId: "idle-command",
      },
      modelExecution: { selectionScope: "execution" },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      providerId: "account:zai-offpeak-idle-plan",
      modelId: "GLM-5.2",
    });
    expect(requests[0]?.text).toContain("account:zai-offpeak-idle-plan/GLM-5.2");
    expect(requests[0]?.text).not.toContain("provider-a/model-a");
    expect(runtime.getSessionModelSelection()).toEqual(sessionSelection);
  });

  it("applies a Session Selection change during an active turn only to the next Active Model", async () => {
    const requests: Array<{ modelId: string; providerId: string; text: string }> = [];
    let runtime: ReturnType<typeof createTestAgentRuntime>;
    runtime = createTestAgentRuntime(
      createSessionId("runtime-active-turn-selection-change"),
      {
        modelSelection: createTestModelSelection("provider-a/model-a"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            requests.push({
              modelId: String(observation.model.modelId),
              providerId: String(observation.model.providerId),
              text: JSON.stringify(request.messages),
            });
            if (requests.length === 1) {
              runtime.setSessionModelSelection({
                providerId: "provider-b",
                modelId: "model-b",
                options: { reasoningLevel: "high" },
              });
            }
            return {
              finishReason: "stop",
              model: observation.model,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    await runtime.executeTurn("first");
    await runtime.executeTurn("second");

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ providerId: "provider-a", modelId: "model-a" });
    expect(requests[0]?.text).toContain("provider-a/model-a");
    expect(requests[0]?.text).not.toContain("provider-b/model-b");
    expect(requests[1]).toMatchObject({ providerId: "provider-b", modelId: "model-b" });
    expect(requests[1]?.text).toContain("provider-b/model-b");
    expect(requests[1]?.text).not.toContain("provider-a/model-a");
  });

  it("uses structured ModelSelection as the current Session model fact", () => {
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-structured-session-model-selection"),
      {
        modelSelection: {
          providerId: "provider-a",
          modelId: "model-a",
          options: {
            reasoningLevel: "high",
          },
        },
      },
      { eventStore: createTestSessionEventStore() },
    );

    expect(runtime.getSessionModelSelection()).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
      options: {
        reasoningLevel: "high",
      },
    });

    const nextSelection = {
      providerId: "provider-b",
      modelId: "model-b",
      options: {
        reasoningLevel: "low",
      },
    };
    runtime.setSessionModelSelection(nextSelection);
    nextSelection.options.reasoningLevel = "mutated-outside-runtime";

    expect(runtime.getSessionModelSelection()).toEqual({
      providerId: "provider-b",
      modelId: "model-b",
      options: {
        reasoningLevel: "low",
      },
    });
  });

  it("publishes the Active Model context window with ModelSelected", async () => {
    const sessionId = createSessionId("runtime-model-selection-context-window");
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore,
        modelFactory: createTestModelFactory({ properties: { contextWindow: 1_000_000 } }),
      },
    );

    await runtime.emitModelSelected({
      modelSelection: {
        providerId: createModelProviderId("deepseek"),
        modelId: createModelId("deepseek-v4-flash"),
      },
      supportedThoughtLevels: ["max", "high", "nothink"],
      traceContext: { traceId: "trace-runtime-model-selection" } as never,
    });

    const selected = (await eventStore.getEvents(sessionId)).find(
      (event) => event.type === SessionEventType.ModelSelected,
    );
    expect(selected?.payload).toMatchObject({
      contextWindow: 1_000_000,
      modelSelection: {
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
      },
      supportedThoughtLevels: ["max", "high", "nothink"],
    });
  });

  it("preserves the registry fallback origin in ModelSelected", async () => {
    const sessionId = createSessionId("runtime-model-selection-registry-fallback");
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(sessionId, {}, { eventStore });

    await runtime.emitModelSelected({
      modelSelection: {
        providerId: createModelProviderId("provider-b"),
        modelId: createModelId("model-b"),
      },
      previousModelSelection: {
        providerId: createModelProviderId("provider-a"),
        modelId: createModelId("model-a"),
      },
      origin: "registryFallback",
      traceContext: { traceId: "trace-runtime-model-selection-fallback" } as never,
    });

    const selected = (await eventStore.getEvents(sessionId)).find(
      (event) => event.type === SessionEventType.ModelSelected,
    );
    expect(selected?.payload).toMatchObject({
      origin: "registryFallback",
      previousModelSelection: {
        providerId: "provider-a",
        modelId: "model-a",
      },
    });
  });

  it("uses the execution-scoped Selection for foreground children without applying profile reasoning", async () => {
    const sessionId = createSessionId("runtime-turn-model-foreground-subagents");
    const eventStore = createTestSessionEventStore();
    const sessionModel = createTestModelSelection("user-provider/user-model");
    const childExecutions: Array<Record<string, unknown>> = [];
    const mainRequests: Array<Record<string, unknown>> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        modelSelection: createTestModelSelection(sessionModel),
        subagents: {
          profiles: [
            {
              description: "Search source code",
              modelSelection: {
                providerId: "custom-provider",
                modelId: "custom-code-model",
                options: { reasoningLevel: "high" },
              },
              name: "Code Search",
              source: "user",
              systemPrompt: "Search code.",
              tools: ["Read"],
            },
          ],
        },
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          maxOutputTokens: (input) =>
            input.selection.providerId === "account:zai-offpeak-idle-plan" ? 16_000 : 32_000,
          async generateText(request, observation) {
            const metadata = observation.invocationContext?.metadata as
              | { querySource?: string; turnNumber?: number }
              | undefined;
            const capturedRequest = {
              maxOutputTokens: request.options?.maxOutputTokens,
              model: observation.model,
            };
            if (metadata?.querySource === "subagent") {
              childExecutions.push(capturedRequest);
              return {
                finishReason: "stop",
                model: observation.model,
                text: "child done",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            mainRequests.push(capturedRequest);
            if (metadata?.turnNumber === 0 && mainRequests.length === 1) {
              return {
                finishReason: "tool-calls",
                model: observation.model,
                text: "",
                toolCalls: [
                  {
                    id: "call_explore",
                    name: "Agent",
                    input: {
                      description: "Explore source",
                      prompt: "Explore the source.",
                      subagent_type: "Explore",
                    },
                  },
                  {
                    id: "call_code_search",
                    name: "Agent",
                    input: {
                      description: "Search source",
                      prompt: "Search the source.",
                      subagent_type: "Code Search",
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }
            if (metadata?.turnNumber === 1 && mainRequests.length === 3) {
              return {
                finishReason: "tool-calls",
                model: observation.model,
                text: "",
                toolCalls: [
                  {
                    id: "call_code_search_ordinary",
                    name: "Agent",
                    input: {
                      description: "Search source with profile settings",
                      prompt: "Search the source with the configured profile.",
                      subagent_type: "Code Search",
                    },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            }

            return {
              finishReason: "stop",
              model: observation.model,
              text: "turn done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("run foreground children", undefined, {
      intent: {
        sourceCommandId: "idle-command",
        kind: "sendText",
        requestedDelivery: "start-now",
        modelSelection: {
          providerId: "account:zai-offpeak-idle-plan",
          modelId: "GLM-5.2",
          options: { reasoningLevel: "high" },
        },
      },
      modelExecution: {
        selectionScope: "execution",
        subagents: { foregroundModel: "submission", background: "deny" },
      },
    });
    await runtime.executeTurn("ordinary prompt");

    expect(childExecutions).toHaveLength(3);
    expect(childExecutions.slice(0, 2).map((execution) => execution.model)).toEqual([
      expect.objectContaining({
        providerId: "account:zai-offpeak-idle-plan",
        modelId: "GLM-5.2",
      }),
      expect.objectContaining({
        providerId: "account:zai-offpeak-idle-plan",
        modelId: "GLM-5.2",
      }),
    ]);
    expect(
      childExecutions
        .slice(0, 2)
        .map(
          (execution) =>
            (execution.model as { options?: { reasoningLevel?: string } }).options?.reasoningLevel,
        ),
    ).toEqual(["high", "high"]);
    expect(childExecutions.slice(0, 2).map((execution) => execution.maxOutputTokens)).toEqual([
      16_000, 16_000,
    ]);
    expect(childExecutions[2]?.model).toEqual(
      expect.objectContaining({
        providerId: "custom-provider",
        modelId: "custom-code-model",
      }),
    );
    expect(childExecutions[2]?.model).toEqual(
      expect.objectContaining({ options: expect.objectContaining({ reasoningLevel: "high" }) }),
    );
    expect(mainRequests).toHaveLength(4);
    expect(mainRequests.at(-1)?.model).toEqual(
      expect.objectContaining({
        providerId: "user-provider",
        modelId: "user-model",
      }),
    );
    expect(runtime.getSessionModelSelection()).toEqual({
      providerId: String(sessionModel.providerId),
      modelId: String(sessionModel.modelId),
    });
  });

  it.each(["failure", "cancel"] as const)(
    "does not retain an execution-scoped Selection after %s",
    async (outcome) => {
      const sessionId = createSessionId(`runtime-turn-model-cleanup-${outcome}`);
      const abortController = new AbortController();
      const requests: Array<Record<string, unknown>> = [];
      let failFirstRequest = true;
      const runtime = createTestAgentRuntime(
        sessionId,
        {
          modelSelection: createTestModelSelection(
            createTestModelSelection("user-provider/user-model"),
          ),
          titleGeneration: { enabled: false },
          workingDirectory: "/workspace/project",
        },
        {
          eventStore: createTestSessionEventStore(),
          modelFactory: createTestModelFactory({
            async generateText(request, observation) {
              requests.push({
                model: observation.model,
                request,
              });
              if (failFirstRequest) {
                failFirstRequest = false;
                if (outcome === "cancel") {
                  abortController.abort(new Error("user cancelled idle turn"));
                }
                throw new Error(`${outcome} idle turn`);
              }
              return {
                finishReason: "stop",
                model: observation.model,
                text: "ordinary turn done",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            },
          } as never),
        },
      );

      await expect(
        runtime.executeTurn("idle turn", undefined, {
          abortSignal: abortController.signal,
          intent: {
            sourceCommandId: `idle-${outcome}`,
            kind: "sendText",
            requestedDelivery: "start-now",
            modelSelection: {
              providerId: "account:zai-offpeak-idle-plan",
              modelId: "GLM-5.2",
            },
          },
          modelExecution: {
            selectionScope: "execution",
          },
        }),
      ).rejects.toMatchObject({
        type: outcome === "cancel" ? CoreErrorType.TurnCancelled : CoreErrorType.UnknownError,
      });

      await runtime.executeTurn("ordinary prompt");

      expect(requests).toHaveLength(2);
      expect(requests[0]?.model).toEqual(
        expect.objectContaining({
          providerId: "account:zai-offpeak-idle-plan",
          modelId: "GLM-5.2",
        }),
      );
      expect(requests[1]?.model).toEqual(
        expect.objectContaining({ providerId: "user-provider", modelId: "user-model" }),
      );
    },
  );

  it("falls back to the Session Selection inside the same turn when the declared provider error hits", async () => {
    const sessionId = createSessionId("runtime-execution-selection-fallback");
    const eventStore = createTestSessionEventStore();
    const highspeedProviderId = "account:zai-highspeed-card";
    const requests: Array<{ modelId: string; providerId: string }> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        modelSelection: createTestModelSelection("user-provider/user-model"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            requests.push({
              modelId: String(observation.model.modelId),
              providerId: String(observation.model.providerId),
            });
            if (String(observation.model.providerId) === highspeedProviderId) {
              throw Object.assign(new Error("highspeed card is invalid"), {
                code: "invalid_model_request",
                context: {
                  providerCode: "3402",
                  providerId: highspeedProviderId,
                  modelId: "GLM-5.3",
                  source: "provider",
                },
                name: "AiSdkModelAdapterError",
              });
            }
            return {
              finishReason: "stop",
              model: observation.model,
              text: "continued with the session model",
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            };
          },
        }),
      },
    );

    const result = await runtime.executeTurn("continue after expiry", undefined, {
      inputId: "command-highspeed-expired",
      intent: {
        sourceCommandId: "command-highspeed-expired",
        kind: "sendText",
        requestedDelivery: "start-now",
        modelSelection: { providerId: highspeedProviderId, modelId: "GLM-5.3" },
      },
      modelExecution: {
        selectionScope: "execution",
        selectionFallback: {
          providerId: highspeedProviderId,
          rules: [
            { reason: "highspeed_card_expired", providerErrorCode: "3402" },
            { reason: "highspeed_request_failed" },
          ],
        },
      },
    });

    expect(result.response).toBe("continued with the session model");
    expect(requests).toEqual([
      { providerId: highspeedProviderId, modelId: "GLM-5.3" },
      { providerId: "user-provider", modelId: "user-model" },
    ]);
    const fallbackEvent = (await eventStore.getEvents(sessionId)).find(
      (event) => event.type === SessionEventType.TurnExecutionModelFallback,
    );
    expect(fallbackEvent?.payload).toMatchObject({
      inputId: "command-highspeed-expired",
      reason: "highspeed_card_expired",
      fromModelSelection: { providerId: highspeedProviderId, modelId: "GLM-5.3" },
      toModelSelection: { providerId: "user-provider", modelId: "user-model" },
    });
    // execution 作用域从不改写 Session Selection：退回目标就是它自己。
    expect(runtime.getSessionModelSelection()).toMatchObject({
      providerId: "user-provider",
      modelId: "user-model",
    });
  });

  it("falls back to the Session Selection on any execution provider failure with a single-attempt budget", async () => {
    // docs/highspeed/highspeed-card-spec.md §2.2：加速请求任何失败（这里是网关 401，没有业务码）都退回；
    // 加速句柄 0 次重试（single-attempt），退回后的会话模型恢复默认预算。
    const sessionId = createSessionId("runtime-execution-selection-any-failure-fallback");
    const eventStore = createTestSessionEventStore();
    const highspeedProviderId = "account:zai-highspeed-card";
    const requests: Array<{ modelId: string; providerId: string; retryBudget: unknown }> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        modelSelection: createTestModelSelection("user-provider/user-model"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            requests.push({
              modelId: String(observation.model.modelId),
              providerId: String(observation.model.providerId),
              retryBudget: observation.invocationContext?.modelRetryBudget,
            });
            if (String(observation.model.providerId) === highspeedProviderId) {
              throw Object.assign(new Error("Provider authentication failed."), {
                code: "provider_not_configured",
                context: {
                  providerId: highspeedProviderId,
                  modelId: "GLM-5.3",
                  reason: "auth_failed",
                  retryable: false,
                  source: "provider",
                  statusCode: 401,
                },
                name: "AiSdkModelAdapterError",
              });
            }
            return {
              finishReason: "stop",
              model: observation.model,
              text: "continued with the session model",
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            };
          },
        }),
      },
    );

    const result = await runtime.executeTurn("continue after gateway failure", undefined, {
      inputId: "command-highspeed-401",
      intent: {
        sourceCommandId: "command-highspeed-401",
        kind: "sendText",
        requestedDelivery: "start-now",
        modelSelection: { providerId: highspeedProviderId, modelId: "GLM-5.3" },
      },
      modelExecution: {
        selectionScope: "execution",
        selectionFallback: {
          providerId: highspeedProviderId,
          rules: [
            { reason: "highspeed_card_expired", providerErrorCode: "3402" },
            { reason: "highspeed_request_failed" },
          ],
        },
      },
    });

    expect(result.response).toBe("continued with the session model");
    expect(requests).toEqual([
      {
        providerId: highspeedProviderId,
        modelId: "GLM-5.3",
        retryBudget: ModelRetryBudget.SingleAttempt,
      },
      { providerId: "user-provider", modelId: "user-model", retryBudget: ModelRetryBudget.Default },
    ]);
    const fallbackEvent = (await eventStore.getEvents(sessionId)).find(
      (event) => event.type === SessionEventType.TurnExecutionModelFallback,
    );
    expect(fallbackEvent?.payload).toMatchObject({
      inputId: "command-highspeed-401",
      reason: "highspeed_request_failed",
      fromModelSelection: { providerId: highspeedProviderId, modelId: "GLM-5.3" },
      toModelSelection: { providerId: "user-provider", modelId: "user-model" },
    });
  });

  it("falls back to the declared target when the runtime has no resident Session Selection", async () => {
    // 回归（2026-10-09 日志复盘）：冷恢复落在 Registry 刚就绪、账号权益未解析的窗口时，持久化的会话选择
    // 校验失败不绑定；之后只发加速轮不会再绑定，3402 时退回目标为空，整轮按 "highspeed card is invalid"
    // 失败弹错。发起方抽卡时知道原模型，现在随 selectionFallback.target 下发，退回不再依赖 runtime 常驻选择。
    const sessionId = createSessionId("runtime-execution-selection-fallback-declared-target");
    const eventStore = createTestSessionEventStore();
    const highspeedProviderId = "account:bigmodel-highspeed-card";
    const target = { providerId: "account:bigmodel-team-coding-plan", modelId: "GLM-5.3" };
    const requests: Array<{ modelId: string; providerId: string }> = [];
    const warn = vi.fn();
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        modelSelection: createTestModelSelection("user-provider/user-model"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        logger: createWarnCapturingLogger(warn),
        modelFactory: createCardExpiryModelFactory(highspeedProviderId, requests),
      },
    );
    // 复现恢复竞态之后的 runtime：没有常驻选择。
    runtime.setSessionModelSelection(undefined);

    const result = await runtime.executeTurn("continue after expiry", undefined, {
      inputId: "command-highspeed-expired-unbound",
      intent: {
        sourceCommandId: "command-highspeed-expired-unbound",
        kind: "sendText",
        requestedDelivery: "start-now",
        modelSelection: { providerId: highspeedProviderId, modelId: "GLM-5.3" },
      },
      modelExecution: {
        selectionScope: "execution",
        selectionFallback: {
          providerId: highspeedProviderId,
          rules: cardExpiryFallbackRules,
          target,
        },
      },
    });

    expect(result.response).toBe("continued with the original model");
    expect(requests).toEqual([{ providerId: highspeedProviderId, modelId: "GLM-5.3" }, target]);
    const fallbackEvent = (await eventStore.getEvents(sessionId)).find(
      (event) => event.type === SessionEventType.TurnExecutionModelFallback,
    );
    expect(fallbackEvent?.payload).toMatchObject({
      inputId: "command-highspeed-expired-unbound",
      reason: "highspeed_card_expired",
      fromModelSelection: { providerId: highspeedProviderId, modelId: "GLM-5.3" },
      toModelSelection: target,
    });
    // 退回只作用于本轮，不借机改写会话常驻选择。
    expect(runtime.getSessionModelSelection()).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: "model.execution_selection.fallback",
        toSource: "declared_target",
        toProviderId: target.providerId,
        providerErrorCode: "3402",
      }),
    );
  });

  it("prefers the declared target over the resident Session Selection", async () => {
    // target 是发起方抽卡时 Composer 的提交选择，比 runtime 内存里的常驻选择更接近用户此刻的意图；
    // 正常情况下两者相同，不同则以发起方为准。
    const sessionId = createSessionId("runtime-execution-selection-fallback-target-first");
    const eventStore = createTestSessionEventStore();
    const highspeedProviderId = "account:bigmodel-highspeed-card";
    const target = { providerId: "account:bigmodel-team-coding-plan", modelId: "GLM-5.3" };
    const requests: Array<{ modelId: string; providerId: string }> = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        modelSelection: createTestModelSelection("user-provider/user-model"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      { eventStore, modelFactory: createCardExpiryModelFactory(highspeedProviderId, requests) },
    );

    await runtime.executeTurn("continue after expiry", undefined, {
      intent: {
        sourceCommandId: "command-highspeed-expired-target-first",
        kind: "sendText",
        requestedDelivery: "start-now",
        modelSelection: { providerId: highspeedProviderId, modelId: "GLM-5.3" },
      },
      modelExecution: {
        selectionScope: "execution",
        selectionFallback: {
          providerId: highspeedProviderId,
          rules: cardExpiryFallbackRules,
          target,
        },
      },
    });

    expect(requests).toEqual([{ providerId: highspeedProviderId, modelId: "GLM-5.3" }, target]);
    expect(runtime.getSessionModelSelection()).toMatchObject({
      providerId: "user-provider",
      modelId: "user-model",
    });
  });

  it("skips a declared target the model factory cannot resolve and falls back to the Session Selection", async () => {
    const sessionId = createSessionId("runtime-execution-selection-fallback-target-unresolvable");
    const eventStore = createTestSessionEventStore();
    const highspeedProviderId = "account:bigmodel-highspeed-card";
    const requests: Array<{ modelId: string; providerId: string }> = [];
    const warn = vi.fn();
    const baseFactory = createCardExpiryModelFactory(highspeedProviderId, requests);
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        modelSelection: createTestModelSelection("user-provider/user-model"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        logger: createWarnCapturingLogger(warn),
        modelFactory: (factoryInput) => {
          // 模拟目标 provider 不在当前 Registry：建模抛错只能跳过该候选，不能替换真实的加速失败原因。
          if (factoryInput.selection.providerId === "ghost-provider") {
            throw new Error("Provider Registry 中不存在 Provider: ghost-provider");
          }
          return baseFactory(factoryInput);
        },
      },
    );

    const result = await runtime.executeTurn("continue after expiry", undefined, {
      intent: {
        sourceCommandId: "command-highspeed-expired-ghost-target",
        kind: "sendText",
        requestedDelivery: "start-now",
        modelSelection: { providerId: highspeedProviderId, modelId: "GLM-5.3" },
      },
      modelExecution: {
        selectionScope: "execution",
        selectionFallback: {
          providerId: highspeedProviderId,
          rules: cardExpiryFallbackRules,
          target: { providerId: "ghost-provider", modelId: "GLM-5.3" },
        },
      },
    });

    expect(result.response).toBe("continued with the original model");
    expect(requests).toEqual([
      { providerId: highspeedProviderId, modelId: "GLM-5.3" },
      { providerId: "user-provider", modelId: "user-model" },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: "model.execution_selection.fallback",
        toSource: "session_selection",
        skippedCandidates: [
          expect.objectContaining({ source: "declared_target", providerId: "ghost-provider" }),
        ],
      }),
    );
  });

  it("fails with the real execution error when neither a declared target nor a resident Session Selection resolves", async () => {
    // 无处可退时不能用建模错误或泛化文案掩埋根因，但必须留痕：过去这个分支完全静默。
    const sessionId = createSessionId("runtime-execution-selection-fallback-unavailable");
    const eventStore = createTestSessionEventStore();
    const highspeedProviderId = "account:bigmodel-highspeed-card";
    const requests: Array<{ modelId: string; providerId: string }> = [];
    const warn = vi.fn();
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        modelSelection: createTestModelSelection("user-provider/user-model"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        logger: createWarnCapturingLogger(warn),
        modelFactory: createCardExpiryModelFactory(highspeedProviderId, requests),
      },
    );
    runtime.setSessionModelSelection(undefined);

    const failure = (await runtime
      .executeTurn("continue after expiry", undefined, {
        intent: {
          sourceCommandId: "command-highspeed-expired-nowhere",
          kind: "sendText",
          requestedDelivery: "start-now",
          modelSelection: { providerId: highspeedProviderId, modelId: "GLM-5.3" },
        },
        modelExecution: {
          selectionScope: "execution",
          selectionFallback: { providerId: highspeedProviderId, rules: cardExpiryFallbackRules },
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )) as (Error & { cause?: unknown }) | undefined;

    expect(failure).toBeInstanceOf(Error);
    const causeMessage = failure?.cause instanceof Error ? failure.cause.message : undefined;
    expect([failure?.message, causeMessage]).toContain("highspeed card is invalid");
    expect(requests).toEqual([{ providerId: highspeedProviderId, modelId: "GLM-5.3" }]);
    const fallbackEvents = (await eventStore.getEvents(sessionId)).filter(
      (event) => event.type === SessionEventType.TurnExecutionModelFallback,
    );
    expect(fallbackEvents).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        event: "model.execution_selection.fallback_unavailable",
        hasDeclaredTarget: false,
        hasSessionSelection: false,
        providerErrorCode: "3402",
      }),
    );
  });

  it("does not fall back when local streaming event persistence fails", async () => {
    // Bug 根因：selectionFallback 的无错误码规则曾把 stream 消费期间的本地落库异常也当成 provider 失败，
    // 不仅掩埋真实存储故障，还会错误地向原模型再发一次请求。
    const sessionId = createSessionId("runtime-execution-selection-local-persistence-failure");
    const eventStore = createTestSessionEventStore();
    const appendEvent = eventStore.append.bind(eventStore);
    eventStore.append = vi.fn(async (event) => {
      if (event.type === SessionEventType.ModelStreaming) {
        throw new Error("event store append failed");
      }
      return appendEvent(event);
    });
    const highspeedProviderId = "account:zai-highspeed-card";
    const streamedProviders: string[] = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        modelSelection: createTestModelSelection("user-provider/user-model"),
        modelStreaming: "on",
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async *streamText(_request, observation) {
            streamedProviders.push(String(observation.model.providerId));
            yield { id: "text-1", type: "text_start" };
            yield { id: "text-1", text: "provider output", type: "text_delta" };
            yield { id: "text-1", type: "text_end" };
            yield {
              finishReason: "stop",
              type: "finish",
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            };
          },
        }),
      },
    );

    const failure = (await runtime
      .executeTurn("persist this stream", undefined, {
        inputId: "command-highspeed-local-persistence-failure",
        intent: {
          sourceCommandId: "command-highspeed-local-persistence-failure",
          kind: "sendText",
          requestedDelivery: "start-now",
          modelSelection: { providerId: highspeedProviderId, modelId: "GLM-5.3" },
        },
        modelExecution: {
          selectionScope: "execution",
          selectionFallback: {
            providerId: highspeedProviderId,
            rules: [{ reason: "highspeed_request_failed" }],
          },
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )) as (Error & { cause?: unknown }) | undefined;

    expect(failure).toBeInstanceOf(Error);
    const causeMessage = failure?.cause instanceof Error ? failure.cause.message : undefined;
    expect([failure?.message, causeMessage]).toContain("event store append failed");
    expect(streamedProviders).toEqual([highspeedProviderId]);
    const fallbackEvents = (await eventStore.getEvents(sessionId)).filter(
      (event) => event.type === SessionEventType.TurnExecutionModelFallback,
    );
    expect(fallbackEvents).toHaveLength(0);
  });

  it("does not retry the accelerated stream when a matched fallback has no resolvable target", async () => {
    // 无处可退已是终止边界；若继续进入通用 stream recovery，会在同一个失败加速端点重复请求。
    const sessionId = createSessionId("runtime-execution-selection-stream-fallback-unavailable");
    const eventStore = createTestSessionEventStore();
    const highspeedProviderId = "account:zai-highspeed-card";
    const streamedProviders: string[] = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        modelSelection: createTestModelSelection("user-provider/user-model"),
        modelStreaming: "on",
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async *streamText(_request, observation) {
            const providerId = String(observation.model.providerId);
            streamedProviders.push(providerId);
            yield { id: "text-1", type: "text_start" };
            yield { id: "text-1", text: "partial accelerated output", type: "text_delta" };
            throw Object.assign(new Error("accelerated stream failed"), {
              code: "model_request_failed",
              context: {
                providerId,
                modelId: "GLM-5.3",
                reason: "network_error",
                retryable: true,
                source: "network",
              },
              name: "AiSdkModelAdapterError",
            });
          },
        }),
      },
    );
    runtime.setSessionModelSelection(undefined);

    const failure = (await runtime
      .executeTurn("stream without fallback target", undefined, {
        inputId: "command-highspeed-stream-no-target",
        intent: {
          sourceCommandId: "command-highspeed-stream-no-target",
          kind: "sendText",
          requestedDelivery: "start-now",
          modelSelection: { providerId: highspeedProviderId, modelId: "GLM-5.3" },
        },
        modelExecution: {
          selectionScope: "execution",
          selectionFallback: {
            providerId: highspeedProviderId,
            rules: [{ reason: "highspeed_request_failed" }],
          },
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      )) as (Error & { cause?: unknown }) | undefined;

    expect(failure).toBeInstanceOf(Error);
    const causeMessage = failure?.cause instanceof Error ? failure.cause.message : undefined;
    expect([failure?.message, causeMessage]).toContain("accelerated stream failed");
    expect(streamedProviders).toEqual([highspeedProviderId]);
    const fallbackEvents = (await eventStore.getEvents(sessionId)).filter(
      (event) => event.type === SessionEventType.TurnExecutionModelFallback,
    );
    expect(fallbackEvents).toHaveLength(0);
  });

  it("falls back only once: a session model failure after the fallback fails the turn", async () => {
    const sessionId = createSessionId("runtime-execution-selection-fallback-once");
    const eventStore = createTestSessionEventStore();
    const highspeedProviderId = "account:zai-highspeed-card";
    const providers: string[] = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        modelSelection: createTestModelSelection("user-provider/user-model"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            const providerId = String(observation.model.providerId);
            providers.push(providerId);
            throw Object.assign(new Error("Provider returned a server error."), {
              code: "model_request_failed",
              context: {
                providerId,
                modelId: String(observation.model.modelId),
                reason: "server_error",
                retryable: true,
                source: "provider",
                statusCode: 503,
              },
              name: "AiSdkModelAdapterError",
            });
          },
        }),
      },
    );

    await expect(
      runtime.executeTurn("both models fail", undefined, {
        inputId: "command-highspeed-503",
        intent: {
          sourceCommandId: "command-highspeed-503",
          kind: "sendText",
          requestedDelivery: "start-now",
          modelSelection: { providerId: highspeedProviderId, modelId: "GLM-5.3" },
        },
        modelExecution: {
          selectionScope: "execution",
          selectionFallback: {
            providerId: highspeedProviderId,
            rules: [{ reason: "highspeed_request_failed" }],
          },
        },
      }),
    ).rejects.toThrow();

    // 加速模型失败一次即退回；退回后的会话模型再失败按真实错误整轮失败，不再二次降级。
    expect(providers).toEqual([highspeedProviderId, "user-provider"]);
    const fallbackEvents = (await eventStore.getEvents(sessionId)).filter(
      (event) => event.type === SessionEventType.TurnExecutionModelFallback,
    );
    expect(fallbackEvents).toHaveLength(1);
  });

  it("falls back before same-model stream recovery when the execution stream fails after visible output", async () => {
    // 退回必须先于 stream recovery：否则可见输出后的瞬态失败会先在加速模型上重试到预算耗尽。
    const sessionId = createSessionId("runtime-execution-selection-stream-fallback");
    const eventStore = createTestSessionEventStore();
    const highspeedProviderId = "account:zai-highspeed-card";
    const streamedProviders: string[] = [];
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        modelSelection: createTestModelSelection("user-provider/user-model"),
        modelStreaming: "on",
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText() {
            throw new Error("streaming runtime must not call generateText");
          },
          async *streamText(_request, observation) {
            const providerId = String(observation.model.providerId);
            streamedProviders.push(providerId);
            yield { id: "text-1", type: "text_start" };
            if (providerId === highspeedProviderId) {
              yield { id: "text-1", text: "partial accelerated output", type: "text_delta" };
              throw Object.assign(new Error("Network connection failed for the provider request."), {
                code: "model_request_failed",
                context: {
                  providerId,
                  modelId: "GLM-5.3",
                  reason: "network_error",
                  retryable: true,
                  source: "network",
                },
                name: "AiSdkModelAdapterError",
              });
            }
            yield { id: "text-1", text: "continued with the session model", type: "text_delta" };
            yield { id: "text-1", type: "text_end" };
            yield {
              finishReason: "stop",
              type: "finish",
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            };
          },
        }),
      },
    );

    const result = await runtime.executeTurn("stream fails mid-way", undefined, {
      inputId: "command-highspeed-stream",
      intent: {
        sourceCommandId: "command-highspeed-stream",
        kind: "sendText",
        requestedDelivery: "start-now",
        modelSelection: { providerId: highspeedProviderId, modelId: "GLM-5.3" },
      },
      modelExecution: {
        selectionScope: "execution",
        selectionFallback: {
          providerId: highspeedProviderId,
          rules: [{ reason: "highspeed_request_failed" }],
        },
      },
    });

    expect(result.response).toBe("continued with the session model");
    // 加速模型只开流一次，没有同模型重试；随后直接由会话模型接管。
    expect(streamedProviders).toEqual([highspeedProviderId, "user-provider"]);
    const events = await eventStore.getEvents(sessionId);
    expect(
      events.filter((event) => event.type === SessionEventType.TurnExecutionModelFallback),
    ).toHaveLength(1);
  });

  it("preserves an explicit source-less model boundary in ModelSelected", async () => {
    const sessionId = createSessionId("runtime-model-selection-source-less-boundary");
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(sessionId, {}, { eventStore });

    await runtime.emitModelSelected({
      modelSelection: {
        providerId: createModelProviderId("child-provider"),
        modelId: createModelId("child-model"),
      },
      previousModelSelection: null,
      traceContext: { traceId: "trace-runtime-model-selection-source-less" } as never,
    });

    const selected = (await eventStore.getEvents(sessionId)).find(
      (event) => event.type === SessionEventType.ModelSelected,
    );
    expect(selected?.payload).toMatchObject({
      previousModelSelection: null,
      modelSelection: {
        providerId: "child-provider",
        modelId: "child-model",
      },
    });
  });
});
