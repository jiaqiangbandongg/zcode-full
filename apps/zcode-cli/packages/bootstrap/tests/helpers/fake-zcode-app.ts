import type { ExecutionShellSelection, SessionId } from "@zcode/contracts";
import type { ZCodeApp, ZCodeAppOptions } from "../../src/app/types.js";

export function createFakeApp(
  options?: ZCodeAppOptions,
  overrides: Partial<ZCodeApp> = {},
): ZCodeApp {
  const sessionId = options?.sessionId ?? ("sess_test" as SessionId);
  const traceId = options?.traceContext?.traceId ?? ("trace_test" as never);
  let mode = options?.runtimeConfig?.mode ?? "build";
  let model = options?.runtimeConfig?.modelSelection
    ? `${options.runtimeConfig.modelSelection.providerId}/${options.runtimeConfig.modelSelection.modelId}`
    : "glm/glm-4.6";
  let thoughtLevel = options?.runtimeConfig?.modelSelection?.options?.reasoningLevel ?? "medium";
  let bashShellSelection = options?.runtimeConfig?.bashShellSelection;
  let runtimeContextWindow = options?.runtimeConfig?.contextWindow ?? 128_000;
  let foregroundPromotionLeaseId: string | undefined;
  const modelProperties = {
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
  } as const;
  const baseModels = [
    {
      ref: { providerId: "glm", modelId: "glm-4.6" },
      label: "GLM 4.6",
      providerLabel: "glm",
      properties: modelProperties,
    },
    {
      ref: { providerId: "glm", modelId: "glm-4-air" },
      label: "GLM 4 Air",
      providerLabel: "glm",
      properties: modelProperties,
    },
  ];
  let models = [...baseModels];
  let thoughtLevelsByModel = new Map<string, string[]>([
    ["glm/glm-4.6", ["medium", "deep"]],
    ["glm/glm-4-air", ["medium", "deep"]],
  ]);

  return {
    clearTarget: async () => false,
    close: async () => {},
    connectMcpServer: async () => {
      throw new Error("MCP is not available in fake app");
    },
    continueActiveTarget: async () => null,
    disconnectMcpServer: async () => undefined,
    forkFromCheckpoint: async () => {
      throw new Error("Fork is not available in fake app");
    },
    getLocale: () => "en-US",
    getMode: () => mode,
    getModel: () => model,
    getTheme: () => "auto",
    getDefaultThoughtLevel: () => thoughtLevelsByModel.get(model)?.[0],
    getThoughtLevel: () => thoughtLevel,
    generateWorkspaceText: async () => {
      throw new Error("Workspace text generation is not available in fake app");
    },
    testModelConnectivity: async () => {
      throw new Error("Model connectivity testing is not available in fake app");
    },
    listCheckpoints: async () => [],
    listMcpServers: async () => ({}),
    listModels: () => models,
    listPlugins: async () => ({ loaded: [], failed: [] }) as never,
    listThoughtLevels: () => thoughtLevelsByModel.get(model) ?? [],
    loadSessionTranscript: async () => [],
    readToolResultArtifact: async (uri) => ({
      bytes: 0,
      content: "",
      contentType: "text/plain",
      uri,
    }),
    readTodos: async () => [],
    readTarget: async () => null,
    recallPreviousInputHistory: async () => null,
    recordInputHistory: async () => null,
    resume: async () => ({
      directory: options?.runtimeConfig?.workingDirectory ?? "/workspace/app",
      interruptedToolCount: 0,
      messageCount: 0,
      partCount: 0,
      persistedMessagesReloadRequired: false,
      restoredMessages: [],
      traceId,
    }),
    runtime: {
      acquireForegroundPromotionLease: ({ leaseId }) => {
        if (foregroundPromotionLeaseId && foregroundPromotionLeaseId !== leaseId) {
          return { kind: "conflict", leaseId: foregroundPromotionLeaseId };
        }
        foregroundPromotionLeaseId = leaseId;
        return { kind: "acquired", leaseId };
      },
      emitModelSelected: async () => undefined,
      getProjection: async () =>
        ({
          activeToolCalls: [],
          backgroundTasks: [],
          contextUsed: 0,
          contextWindow: runtimeContextWindow,
          createdAt: new Date(1),
          id: sessionId,
          mode,
          pendingPermissions: [],
          pendingSteerInputs: [],
          status: "idle",
          streamingToolLedger: [],
          target: null,
          totalTokenCount: 0,
          turnCount: 0,
          updatedAt: new Date(1),
        }) as never,
      getActiveTurnInfo: () => undefined,
      hasActiveOrQueuedTurnWork: () => false,
      hasResidencyBlockingWork: () => false,
      hasRunningBackgroundTasks: () => false,
      isSessionPersisted: () => false,
      getActiveForegroundExecutionId: () => undefined,
      getSessionModelSelection: () => {
        const [providerId = "", modelId = ""] = model.split("/", 2);
        return {
          providerId,
          modelId,
          ...(thoughtLevel ? { options: { reasoningLevel: thoughtLevel } } : {}),
        };
      },
      getSessionShellSelection: () => bashShellSelection,
      initializeSessionShellEnvironmentIfNeeded: (selection) => {
        if (bashShellSelection) {
          return false;
        }
        bashShellSelection = resolveShellInitializationCandidate(selection);
        return true;
      },
      subscribeEvents: () => () => {},
      releaseForegroundPromotionLease: (leaseId) => {
        if (foregroundPromotionLeaseId !== leaseId) return false;
        foregroundPromotionLeaseId = undefined;
        return true;
      },
      stopActiveForegroundExecution: () => ({ kind: "idle" }),
      updateConfig: (patch) => {
        if ("contextWindow" in patch) {
          runtimeContextWindow = patch.contextWindow ?? 0;
        }
      },
    } as never,
    sendInput: async () => ({ kind: "rejected", reason: "no_active_turn" }),
    sessionId,
    setLocale: async (locale) => ({
      configPath: "/tmp/zcode/config.json",
      locale: locale === "zh-CN" ? "zh-CN" : "en-US",
      previousLocale: "en-US",
      requestedLocale: locale,
      traceId,
    }),
    setMode: async (nextMode) => {
      const previousMode = mode;
      mode = nextMode;
      return { mode, previousMode, traceId };
    },
    setPluginEnabled: async () => {
      throw new Error("Plugins are not available in fake app");
    },
    setTarget: async () => {
      throw new Error("Targets are not available in fake app");
    },
    setModel: async (nextModel) => {
      const nextIdentity =
        typeof nextModel === "string" ? nextModel : `${nextModel.providerId}/${nextModel.modelId}`;
      if (
        !models.some((option) => `${option.ref.providerId}/${option.ref.modelId}` === nextIdentity)
      ) {
        throw new Error(`Unsupported model in fake app: ${nextModel}`);
      }
      const previousModel = model;
      model = nextIdentity;
      if (typeof nextModel !== "string") thoughtLevel = nextModel.options?.reasoningLevel ?? "";
      return { model, previousModel, traceId };
    },
    setThoughtLevel: async (level) => {
      const previousThoughtLevel = thoughtLevel;
      thoughtLevel = level;
      return { previousThoughtLevel, thoughtLevel, traceId };
    },
    steerTurn: async () => ({ kind: "rejected", reason: "no_active_turn" }),
    submitPrompt: async () => {
      throw new Error("Prompt execution is not available in fake app");
    },
    traceId,
    updateTargetStatus: async () => null,
    ...overrides,
  } as ZCodeApp;
}

type ShellInitializationCandidate = Parameters<
  ZCodeApp["runtime"]["initializeSessionShellEnvironmentIfNeeded"]
>[0];

function resolveShellInitializationCandidate(
  candidate: ShellInitializationCandidate,
): ExecutionShellSelection {
  return typeof candidate === "function" ? candidate() : candidate;
}
