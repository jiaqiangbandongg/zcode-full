import { mkdtemp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type ModelSelectionViewInput,
  ApiKeyAccessConfig,
  ModelConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
} from "@zcode/provider";
import {
  NodePersonalProviderConfigRepository,
  NodeProviderRegistryRuntime,
  createNodeModelSelectionFacade,
} from "@zcode/provider-node";
import {
  createZCodeAgentService,
  createZCodeTaskServiceAdapter,
  getDataBaseDir,
  setDataBaseDir,
} from "@zcode/services/node";
import { TaskIndexRepo } from "../../../../services/src/session/taskIndexRepo.js";
import { createZCodeTaskIndexSyncer } from "../../../../services/src/zcode-agent/zcodeTaskIndexSyncer.js";
import { getE2EAppDataPaths } from "./desktop-app.js";
import {
  createBotsServiceHarness,
  createFeishuConfig,
} from "../bots/helpers/bots-service-harness.js";

/** 真实 Host/CLI，只有模型 HTTP、飞书 HTTP 和 Bot 配置存储使用隔离夹具。 */
export async function createBotWorkerIntegration(baseUrl: string, dropTextContaining?: string) {
  const home = await mkdtemp(join(getE2EAppDataPaths().homeDir, "bot-worker-"));
  const workspacePath = join(home, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const previousDataDir = getDataBaseDir();
  setDataBaseDir(home);
  const cleanup: Array<() => void | Promise<void>> = [() => setDataBaseDir(previousDataDir)];
  const dispose = async () => {
    const errors: unknown[] = [];
    for (const release of cleanup.splice(0).reverse()) {
      try {
        await release();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Bot worker fixture cleanup failed");
  };
  try {
    const personalFilePath = join(home, ".zcode/v2/provider_config.json");
    const modelSelection = {
      providerId: "e2e-bot-worker",
      modelId: "e2e-bot-model",
      options: { reasoningLevel: "disabled" },
    };
    const personal = new NodePersonalProviderConfigRepository({
      filePath: personalFilePath,
      pollingIntervalMs: false,
    });
    cleanup.push(() => personal.dispose());
    await personal.update((current) => ({
      ...current,
      providers: current.providers.setRule({
        providerId: modelSelection.providerId,
        providerName: "Bot Worker Fixture",
        config: new ProviderConfig({
          group: "standard-personal",
          access: new ApiKeyAccessConfig({ apiKey: "isolated-fixture" }),
          api: new ProviderApiConfig({ type: "anthropic-messages", baseUrl }),
          personalModelIds: [modelSelection.modelId],
        }),
      }),
      models: current.models.setExact(
        modelSelection.providerId,
        modelSelection.modelId,
        new ModelConfig({
          properties: new ModelPropertiesConfig({
            contextWindow: 128000,
            requiresMfjsToolSchema: false,
            inputFormat: { supportsText: true },
            outputFormat: { supportsText: true },
            supportsToolCall: true,
            supportsJsonSchemaOutput: false,
          }),
        }),
      ),
    }));
    personal.dispose();
    const builtin = resolve("../../config/provider/zcode-builtin.json");
    const runtime = new NodeProviderRegistryRuntime({
      personalFilePath,
      zcodeBuiltinFilePath: builtin,
      watch: false,
      personalPollingIntervalMs: false,
    });
    cleanup.push(() => runtime.dispose());
    await runtime.start();
    const facade = createNodeModelSelectionFacade(runtime.registryService);
    const modelSelectionService = {
      getView: async (input?: ModelSelectionViewInput) =>
        facade.getView(modelSelection, undefined, input),
    };
    const selected = await modelSelectionService.getView({ selection: modelSelection });
    if (!selected.preferredSelection || !selected.effectiveSelection) {
      throw new Error(
        JSON.stringify({
          stage: "fixture-model",
          preferred: selected.preferredSelection,
          issue: selected.selectionIssue,
          providers: selected.providers.map((p) => ({
            id: p.providerId,
            models: p.models.map((m) => m.modelId),
          })),
        }),
      );
    }
    const bot = createBotsServiceHarness({
      config: createFeishuConfig("feishu", "bot-worker"),
      modelSelectionService,
      state: {
        version: 3,
        bots: {
          "bot-worker": {
            botId: "bot-worker",
            workspacePath,
            mode: "draft",
            activeTaskId: null,
            draftOptions: { provider: "glm", modelSelection },
            updatedAt: Date.now(),
          },
        },
      },
      lastWorkspaceSession: [{ kind: "local", workspacePath }],
    });
    const reverseReplies: unknown[] = [];
    const reverseResources: unknown[] = [];
    const agent = createZCodeAgentService({
      commandResolver: () => ({
        command: process.execPath,
        args: [
          resolve("../../apps/zcode-cli/packages/cli/dist/zcode.cjs"),
          "app-server",
          "--stdio",
        ],
        env: {
          HOME: home,
          USERPROFILE: home,
          ZCODE_DATA_BASE_DIR: home,
          ZCODE_RUNTIME_ENV: "development",
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalFilePath,
        },
      }),
      modelSelectionReadinessSource: modelSelectionService,
      channelReplyExecutor: async (request) => {
        reverseReplies.push(request);
        return bot.service.replyToChannel!(request);
      },
      topicResourceExecutor: async (request, signal) => {
        reverseResources.push(request);
        return bot.service.readTopicResource!({ ...request, signal });
      },
      topicResourceValidator: (request, signal) =>
        bot.service.validateTopicResource!({ ...request, signal }),
    });
    cleanup.push(async () => {
      await agent.disposeWorkspace({ workspacePath });
      agent.disposeAll();
    });
    const droppedTextEvents: string[] = [];
    const observedTextEvents: string[] = [];
    const permissionRequests: unknown[] = [];
    {
      const subscribe = agent.onDynamicSessionEvent;
      // 在真实 CLI 与 legacy 投影边界注入丢帧；终态与持久正文保持真实，不能伪造补齐结果。
      agent.onDynamicSessionEvent =
        (params) =>
        (listener, ...rest) =>
          subscribe(params)(
            (event) => {
              if (event.type === "session.event") {
                if (event.event.type === "permission.requested")
                  permissionRequests.push(event.event.payload);
                const payload = event.event.payload as { kind?: string; delta?: unknown };
                if (payload.kind === "text_delta" && typeof payload.delta === "string")
                  observedTextEvents.push(payload.delta);
                if (
                  dropTextContaining &&
                  payload.kind === "text_delta" &&
                  typeof payload.delta === "string" &&
                  payload.delta.includes(dropTextContaining)
                ) {
                  droppedTextEvents.push(payload.delta);
                  return;
                }
              }
              listener(event);
            },
            ...rest,
          );
    }
    const repo = new TaskIndexRepo();
    cleanup.push(() => repo.close());
    const syncer = createZCodeTaskIndexSyncer({ agentService: agent, taskIndexRepo: repo });
    cleanup.push(() => syncer.disposeAll());
    cleanup.push(() => bot.service.disposeAllAndWait());
    const task = createZCodeTaskServiceAdapter({
      zcodeAgentService: agent,
      taskIndexRepo: repo,
      taskIndexSyncer: syncer,
    });
    Object.assign(bot.zcodeTaskService, task);
    return {
      home,
      workspacePath,
      modelSelection,
      agent,
      task,
      bot,
      reverseReplies,
      reverseResources,
      droppedTextEvents,
      observedTextEvents,
      permissionRequests,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
