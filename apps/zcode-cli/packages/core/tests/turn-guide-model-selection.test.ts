import { describe, expect, it, vi } from "vitest";
import {
  createModelId,
  createModelProviderId,
  type Model,
  type ModelSelection,
} from "@zcode/contracts";
import { drainInlineGuideForNextRequest } from "../src/runtime/methods/turn-guide-drain.js";

describe("inline Guide model selection", () => {
  it("replaces the Loop Model at the next model-step boundary", async () => {
    const oldModel = createModel("provider-a", "model-a");
    const newModel = createModel("provider-b", "model-b", "high");
    const runtimeConfig = {
      mode: "build",
      modelSelection: {
        providerId: "provider-a",
        modelId: "model-a",
      } satisfies ModelSelection,
    };
    let sessionModelSelection: ModelSelection = {
      providerId: "provider-a",
      modelId: "model-a",
    };
    let canonicalEntries = [
      { message: { role: "system" as const, content: "old context" } },
      { message: { role: "user" as const, content: "original prompt" } },
    ];
    const runtime = {
      activeTurn: { pendingInputs: [{}] },
      config: runtimeConfig,
      contextBuilder: { build: vi.fn() },
      contextInitialized: true,
      contextSourceSnapshot: {
        currentDate: "2026-09-03",
        envInfo: {
          cwd: "/workspace",
          nodeVersion: "test",
          osVersion: "test",
          platform: "test",
          shell: "test",
        },
        workingDirectory: "/workspace",
      },
      createContextBuilderFromSnapshot: vi.fn(() => ({
        build: () => ({
          metaUserAttachments: [],
          systemMessages: [{ role: "system" as const, content: "provider-b/model-b context" }],
        }),
      })),
      drainPendingInput: vi.fn(async () => ({
        injectedMessageIds: [],
        latestMessageId: undefined,
        pendingInputIds: ["guide-input"],
        intent: {
          sourceCommandId: "guide-command",
          kind: "sendText",
          requestedDelivery: "guide",
          admittedDelivery: "guide",
          modelSelection: {
            providerId: "provider-b",
            modelId: "model-b",
            options: { reasoningLevel: "high" },
          },
        },
      })),
      emitModeChanged: vi.fn(),
      emitModelSelected: vi.fn(),
      getMode: () => runtimeConfig.mode,
      getSessionModelSelection: () => structuredClone(sessionModelSelection),
      hasInlineGuidePendingInput: () => true,
      messageHistory: {
        borrowReadOnlyRuntimeEntries: () => canonicalEntries,
        replaceMessages: vi.fn((entries) => {
          canonicalEntries = entries;
        }),
      },
      modelFactory: vi.fn(() => newModel),
      rootTraceContext: { traceId: "guide-trace" },
      sessionStore: { saveSessionEntry: vi.fn(async () => undefined) },
      sessionId: "guide-session",
      setSessionModelSelection: vi.fn((selection: ModelSelection) => {
        sessionModelSelection = structuredClone(selection);
      }),
      updateConfig: vi.fn((patch: typeof runtimeConfig) => {
        Object.assign(runtimeConfig, patch);
      }),
    };
    const state = {
      activeTurn: runtime.activeTurn,
      currentUserMessageId: "message-before-guide",
      events: [],
      model: oldModel,
      repeatedToolCallSignature: "old-signature",
      repeatedToolCallStreakCount: 2,
      turnTraceContext: { traceId: "guide-trace", queryId: "old-query" },
      turnRequestState: {
        entries: canonicalEntries,
        outputTokenContinuationCount: 0,
      },
    };

    const drained = await drainInlineGuideForNextRequest(runtime as never, state as never);

    expect(drained).toBe(true);
    expect(runtime.modelFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: {
          providerId: "provider-b",
          modelId: "model-b",
          options: { reasoningLevel: "high" },
        },
      }),
    );
    expect(state.model).toMatchObject({
      providerId: "provider-b",
      modelId: "model-b",
      options: { reasoningLevel: "high" },
    });
    expect(JSON.stringify(state.turnRequestState.entries)).toContain("provider-b/model-b context");
    expect(JSON.stringify(state.turnRequestState.entries)).not.toContain("old context");
    expect(runtime.emitModelSelected).toHaveBeenCalledOnce();
    expect(runtime.sessionStore.saveSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          modelId: "model-b",
          providerId: "provider-b",
          options: {
            reasoningLevel: "high",
          },
        },
      }),
    );
  });
});

function createModel(providerId: string, modelId: string, reasoningLevel?: string): Model {
  return {
    providerId: createModelProviderId(providerId),
    modelId: createModelId(modelId),
    properties: {
      contextWindow: 128_000,
      supportsMidConversationSystem: false,
      supportsNativeWebSearch: false,
      supportsJsonSchemaOutput: true,
      supportsToolCall: true,
    },
    optionSpecs: {
      reasoningLevel: {
        values: ["low", "high"],
      },
      maxOutputTokens: { max: 8_000 },
    },
    options: { reasoningLevel, maxOutputTokens: 8_000 },
    bind() {
      return this;
    },
    async generateText() {
      throw new Error("not used");
    },
    async *streamText() {
      throw new Error("not used");
    },
  };
}
