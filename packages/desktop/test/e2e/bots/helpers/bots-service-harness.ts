import { readFile } from "node:fs/promises";

import type { ModelSelectionView } from "@zcode/provider";
import type {
  BotsConfigFile,
  BotsStateFile,
  ModelSelection,
  ZCodeStreamEvent,
} from "@zcode/shared";
import { createBotsService, type IModelSelectionService } from "@zcode/services/node";
import { resolveE2ERuntimePath } from "../../helpers/e2e-runtime-paths.js";

const E2E_BOT_WORKSPACE = resolveE2ERuntimePath("bots", "e2e-bot-workspace");

export interface RecordedRequest {
  url: string;
  method: string;
  body?: string;
}

export interface BotSyntheticFixture {
  caseId: string;
  classification: "synthetic";
  syntheticReason: string;
  timing: string;
  promptMarker?: string;
}

export async function readBotSyntheticFixture(filename: string): Promise<BotSyntheticFixture> {
  const url = new URL(`../../fixtures/bots/${filename}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as BotSyntheticFixture;
}

export interface BotsServiceHarnessOptions {
  config: BotsConfigFile;
  state?: BotsStateFile;
  modelSelectionService?: Pick<IModelSelectionService, "getView">;
  fetch?: typeof fetch;
  remoteWorkspaceService?: Record<string, unknown>;
  runStartupBackgroundTasks?: boolean;
  broadcastService?: { send(message: unknown): Promise<void> };
  lastWorkspaceSession?: Array<
    Record<string, unknown> & { kind: "local" | "remote"; workspacePath: string }
  >;
}

export interface BotsServiceHarness {
  createTaskCalls: unknown[];
  readState: () => BotsStateFile;
  respondElicitationCalls: unknown[];
  sendPromptCalls: unknown[];
  service: ReturnType<typeof createBotsService>;
  subscriptions: Array<{
    params: Record<string, unknown>;
    listener: (event: ZCodeStreamEvent) => Promise<void> | void;
  }>;
  zcodeTaskService: Record<string, unknown>;
}

export function createBotModelSelectionView(): ModelSelectionView {
  const providerId = "bot-e2e-provider";
  const modelId = "bot-e2e-model";
  return {
    revision: 1,
    preferredSelection: { providerId, modelId },
    providers: [
      {
        providerId,
        providerName: "Bot E2E Provider",
        config: {
          api: {
            type: "anthropic-messages",
            baseUrl: "https://example.invalid/v1",
          },
          personalModelIds: [modelId],
        },
        models: [
          {
            modelId,
            config: {
              enabled: true,

              properties: {
                requiresMfjsToolSchema: false,
                contextWindow: 128_000,
                inputFormat: {
                  supportsText: true,
                  supportsImage: false,
                  supportsVideo: false,
                  supportsAudio: false,
                  supportsPdf: false,
                },
                outputFormat: { supportsText: true },
                supportsToolCall: true,
                supportsJsonSchemaOutput: true,
                supportsNativeWebSearch: false,
                supportsMidConversationSystem: false,
              },
              optionSpecs: {
                reasoningLevel: { values: ["disabled"], map: "{}" },
                maxOutputTokens: {
                  max: 8_192,
                  map: '{"max_completion_tokens":maxOutputTokens}',
                },
              },
            },
          },
        ],
      },
    ],
  };
}

export function createBotsServiceHarness(options: BotsServiceHarnessOptions): BotsServiceHarness {
  let config = options.config;
  let state: BotsStateFile = options.state ?? { version: 3, bots: {} };
  const createTaskCalls: unknown[] = [];
  let taskModelSelection: ModelSelection | null = null;
  const sendPromptCalls: unknown[] = [];
  const respondElicitationCalls: unknown[] = [];
  const subscriptions: Array<{
    params: Record<string, unknown>;
    listener: (event: ZCodeStreamEvent) => Promise<void> | void;
  }> = [];

  const zcodeTaskService = {
    listTasks: async () => [],
    listDeletedTaskIds: async () => [],
    createTask: async (params: unknown) => {
      createTaskCalls.push(params);
      taskModelSelection = (params as { modelSelection?: ModelSelection }).modelSelection ?? null;
      return {
        taskId: "task-e2e-bot",
        title: "E2E Bot Task",
        workspacePath: E2E_BOT_WORKSPACE,
        provider: "glm",
      };
    },
    sendPrompt: async (params: unknown) => {
      sendPromptCalls.push(params);
    },
    setMode: async () => undefined,
    setConfigOption: async () => [],
    setModel: async (params: { modelSelection: ModelSelection }) => {
      taskModelSelection = params.modelSelection;
      return [];
    },
    setAutomationSessionConfig: async () => [],
    getTaskConfigOptions: async () => [],
    getTaskModelSelection: async () => taskModelSelection,
    getTaskSnapshot: async () => null,
    getTaskTokenUsage: async () => ({
      sessionId: "task-e2e-bot",
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 0,
      modelErrorCount: 0,
      inputBaselineBySource: {},
    }),
    resumeTask: async () => ({
      taskId: "task-e2e-bot",
      title: "E2E Bot Task",
      workspacePath: E2E_BOT_WORKSPACE,
      provider: "glm",
    }),
    respondPermission: async () => true,
    respondElicitation: async (params: unknown) => {
      respondElicitationCalls.push(params);
      return true;
    },
    stopGeneration: async () => undefined,
    onDynamicTaskEvent:
      (params: Record<string, unknown>) =>
      (listener: (event: ZCodeStreamEvent) => Promise<void> | void) => {
        subscriptions.push({ params, listener });
        return { dispose() {} };
      },
    onDynamicStreamEvent: () => () => ({ dispose() {} }),
  };

  const service = createBotsService({
    credentialService: {
      load: async () => "app-secret-e2e",
      save: async () => undefined,
      delete: async () => undefined,
    },
    zcodeTaskService,
    settingService: {
      get: async () => ({
        locale: "zh-CN",
        recentProjects: [E2E_BOT_WORKSPACE],
        lastWorkspaceSession: options.lastWorkspaceSession ?? [
          { kind: "local", workspacePath: E2E_BOT_WORKSPACE },
        ],
        enabledBuiltinAgentCliProviders: ["glm"],
      }),
      update: async () => undefined,
      updateDataBaseDir: async () => undefined,
      ensureDefaultProject: async (path: string) => ({ path, created: false }),
    },
    repo: {
      readConfig: async () => config,
      writeConfig: async (next: BotsConfigFile) => (config = next),
      readState: async () => state,
      writeState: async (next: BotsStateFile) => (state = next),
    },
    modelSelectionService: options.modelSelectionService ?? {
      getView: async () => createBotModelSelectionView(),
    },
    remoteWorkspaceService: options.remoteWorkspaceService,
    broadcastService: options.broadcastService,
    runStartupBackgroundTasks: options.runStartupBackgroundTasks ?? false,
    warmCandidateCachesOnStartup: false,
  } as never);

  return {
    createTaskCalls,
    readState: () => structuredClone(state),
    respondElicitationCalls,
    sendPromptCalls,
    service,
    subscriptions,
    zcodeTaskService,
  };
}

export function createFeishuConfig(
  provider: "feishu" | "lark" = "feishu",
  id = `${provider}-e2e`,
): BotsConfigFile {
  return {
    version: 3,
    bots: [
      {
        id,
        name: `${provider} E2E`,
        provider,
        enabled: true,
        credentialRef: `${provider}-secret`,
        feishuAppId: `${provider}-app-e2e`,
        providerUserId: "ou_e2e_user",
        allowedWorkspaces: ["*"],
        allowedCommands: {
          status: true,
          new: true,
          workspace: true,
          model: true,
          thoughtLevel: true,
          sandboxMode: true,
          approvalPolicy: true,
          reply: true,
        },
        currentOptions: {},
        replyMode: "streaming_card",
      },
    ],
  };
}

export function createFeishuCallback(botId: string, text: string) {
  return {
    botId,
    event: {
      sender: { sender_id: { open_id: "ou_e2e_user" } },
      message: {
        chat_id: "oc_e2e_private",
        message_id: `om_${botId}_inbound`,
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text }),
      },
    },
  };
}

export function createRecordingFeishuFetch(requests: RecordedRequest[]): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({
      url,
      method,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    if (url.endsWith("/tenant_access_token/internal")) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "token-e2e" }));
    }
    if (url.includes("/open-apis/im/v1/messages")) {
      return new Response(JSON.stringify({ code: 0, data: { message_id: "om_e2e_card" } }));
    }
    if (url.includes("/reactions") && method === "POST") {
      return new Response(JSON.stringify({ code: 0, data: { reaction_id: "reaction-e2e" } }));
    }
    if (url.includes("/contact/v3/users/")) {
      return new Response(JSON.stringify({ code: 0, data: { user: { name: "E2E User" } } }));
    }
    return new Response(JSON.stringify({ code: 0 }));
  };
}
