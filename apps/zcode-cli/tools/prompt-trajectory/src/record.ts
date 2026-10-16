import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeDerivedTrajectories } from "./derive.js";
import {
  createFixtureWorkspace,
  createRuntimeModelConfig,
  loadFixture,
  resolveModelSelection,
  resolveUpstreamBaseURL,
  type PromptTrajectoryAttachment,
  type PromptTrajectoryFixture,
  type PromptTrajectoryStep,
  type RuntimeModelConfig,
} from "./fixture.js";
import { MessageLedger } from "./message-ledger.js";
import { startOpenAiProviderProxy } from "./openai-provider-proxy.js";

interface ZCodeBootstrapModule {
  createModelAdapter(input: unknown): unknown;
  createZCodeApp(input: unknown): Promise<{
    close?: () => Promise<void>;
    submitPrompt(prompt: RecorderPromptInput): Promise<unknown>;
  }>;
}

type RecorderPromptInput =
  | string
  | {
      attachments?: PromptTrajectoryAttachment[];
      text: string;
    };

interface ZCodeContractsModule {
  parseModelSelection(input: string): unknown;
}

interface ConfigConstructor {
  new (input?: unknown): unknown;
}

interface ProviderRegistryConstructor {
  new (providers?: readonly unknown[]): unknown;
}

interface ZCodeProviderModule {
  ApiKeyAccessConfig: ConfigConstructor;
  ModelConfig: ConfigConstructor;
  ModelOptionSpecsConfig: ConfigConstructor;
  ModelPropertiesConfig: ConfigConstructor;
  ProviderApiConfig: ConfigConstructor;
  ProviderConfig: ConfigConstructor;
  ProviderRegistry: ProviderRegistryConstructor;
}

interface RuntimeSessionEvent {
  type?: unknown;
}

interface RuntimeEventObserver {
  sink: {
    onSessionEvent(event: RuntimeSessionEvent): void;
  };
  waitForEvent(input: { count?: number; eventType: string; timeoutMs?: number }): Promise<void>;
}

export async function recordPromptTrajectory(input: {
  ccRequestPath?: string;
  fixturePath: string;
  outDir: string;
}): Promise<void> {
  await recordPromptTrajectoryFromFixture({
    ccRequestPath: input.ccRequestPath,
    fixture: await loadFixture(input.fixturePath),
    outDir: input.outDir,
  });
}

export async function recordPromptTrajectoryFromFixture(input: {
  ccRequestPath?: string;
  fixture: PromptTrajectoryFixture;
  outDir: string;
}): Promise<void> {
  await mkdir(input.outDir, { recursive: true });
  const jsonlPath = join(input.outDir, "trajectory.jsonl");
  const fixture = input.fixture;
  const ledger = await MessageLedger.open(jsonlPath);
  let closeProxy: (() => Promise<void>) | undefined;
  let closeApp: (() => Promise<void>) | undefined;

  try {
    const { bootstrap, contracts, provider } = await loadZCodeModules();
    const proxy = await startOpenAiProviderProxy({
      ledger,
      mockResponses: fixture.mockResponses,
      upstreamBaseURL: resolveUpstreamBaseURL({ fixture }),
    });
    closeProxy = proxy.close;
    const modelConfig = createRuntimeModelConfig({
      env: process.env,
      fixture,
      proxyBaseURL: proxy.baseURL,
    });
    const modelAdapter = bootstrap.createModelAdapter({
      env: process.env,
      registryConfig: {
        providers: {},
      },
    });
    const recorderModelAdapter = wrapModelAdapterConnectionForFixture(modelAdapter, fixture);
    const workspace = await createFixtureWorkspace(fixture);
    const modelSelection = contracts.parseModelSelection(resolveModelSelection(fixture));
    const eventObserver = createRuntimeEventObserver();
    const providerRegistry = createRecorderProviderRegistry(provider, modelConfig, fixture);
    const app = await bootstrap.createZCodeApp({
      eventSink: eventObserver.sink,
      env: process.env,
      modelAdapter: recorderModelAdapter,
      providerRegistry,
      runtimeConfig: buildRecorderRuntimeConfig({
        fixture,
        modelSelection,
        workingDirectory: workspace,
      }),
      skipUserConfig: true,
    });
    closeApp = async () => {
      await app.close?.();
    };

    await executeFixtureSteps({ app, eventObserver, steps: fixture.steps });
  } finally {
    await closeApp?.();
    await closeProxy?.();
    await ledger.close();
  }

  await writeDerivedTrajectories({
    ccRequestPath: input.ccRequestPath,
    inputPath: jsonlPath,
    outDir: input.outDir,
  });
}

function wrapModelAdapterConnectionForFixture(
  modelAdapter: unknown,
  fixture: PromptTrajectoryFixture,
): unknown {
  const connectionBaseURL = fixture.model?.connectionBaseURL;
  const connectionProviderKind = fixture.model?.connectionProviderKind;
  if (!connectionBaseURL && !connectionProviderKind) return modelAdapter;

  return new Proxy(modelAdapter as Record<PropertyKey, unknown>, {
    get(target, property, receiver) {
      if (property === "resolveConnection") {
        return (model: unknown) => {
          const baseResolve = Reflect.get(target, property, receiver);
          if (typeof baseResolve !== "function") {
            throw new Error("Model adapter does not expose resolveConnection.");
          }
          const connection = baseResolve.call(target, model) as Record<string, unknown>;
          return {
            ...connection,
            ...(connectionBaseURL ? { baseURL: connectionBaseURL } : {}),
            ...(connectionProviderKind ? { providerKind: connectionProviderKind } : {}),
          };
        };
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function executeFixtureSteps(input: {
  app: {
    submitPrompt(prompt: RecorderPromptInput): Promise<unknown>;
  };
  eventObserver: RuntimeEventObserver;
  steps: readonly PromptTrajectoryStep[];
}): Promise<void> {
  for (const step of input.steps) {
    if (step.type === "submitPrompt") {
      await input.app.submitPrompt(
        step.attachments?.length ? { attachments: step.attachments, text: step.text } : step.text,
      );
      continue;
    }
    if (step.type === "waitForEvent") {
      await input.eventObserver.waitForEvent({
        count: step.count,
        eventType: step.eventType,
        timeoutMs: step.timeoutMs,
      });
      continue;
    }
    assertNever(step);
  }
}

function createRuntimeEventObserver(): RuntimeEventObserver {
  const events: RuntimeSessionEvent[] = [];
  const waiters = new Set<{
    count: number;
    eventType: string;
    resolve(): void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  const matchingCount = (eventType: string): number =>
    events.filter((event) => event.type === eventType).length;

  const settleReadyWaiters = (): void => {
    for (const waiter of waiters) {
      if (matchingCount(waiter.eventType) < waiter.count) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve();
    }
  };

  return {
    sink: {
      onSessionEvent(event) {
        events.push(event);
        settleReadyWaiters();
      },
    },
    waitForEvent(input) {
      const count = input.count ?? 1;
      if (matchingCount(input.eventType) >= count) return Promise.resolve();

      return new Promise<void>((resolve, reject) => {
        const timeoutMs = input.timeoutMs ?? 10_000;
        const waiter = {
          count,
          eventType: input.eventType,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            reject(
              new Error(
                `Timed out waiting for ${count} ${input.eventType} event(s) after ${timeoutMs}ms.`,
              ),
            );
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
  };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported fixture step: ${JSON.stringify(value)}`);
}

async function loadZCodeModules(): Promise<{
  bootstrap: ZCodeBootstrapModule;
  contracts: ZCodeContractsModule;
  provider: ZCodeProviderModule;
}> {
  const bootstrapPath = pathToFileURL(
    join(import.meta.dirname, "../../../packages/bootstrap/dist/index.js"),
  ).href;
  const contractsPath = pathToFileURL(
    join(import.meta.dirname, "../../../packages/contracts/dist/index.js"),
  ).href;
  const providerConfigPath = pathToFileURL(
    join(import.meta.dirname, "../../../../../packages/provider/dist/config/index.js"),
  ).href;
  const providerRegistryPath = pathToFileURL(
    join(import.meta.dirname, "../../../../../packages/provider/dist/registry.js"),
  ).href;
  try {
    const [bootstrap, contracts, providerConfig, providerRegistry] = await Promise.all([
      import(bootstrapPath) as Promise<ZCodeBootstrapModule>,
      import(contractsPath) as Promise<ZCodeContractsModule>,
      import(providerConfigPath) as Promise<Omit<ZCodeProviderModule, "ProviderRegistry">>,
      import(providerRegistryPath) as Promise<Pick<ZCodeProviderModule, "ProviderRegistry">>,
    ]);
    return {
      bootstrap,
      contracts,
      provider: { ...providerConfig, ...providerRegistry },
    };
  } catch (error) {
    throw new Error(
      "Missing built zcode-cli packages. Run `pnpm --filter @zcode/bootstrap^... build && pnpm --filter @zcode/bootstrap build` before `record`.",
      { cause: error },
    );
  }
}

function createRecorderProviderRegistry(
  provider: ZCodeProviderModule,
  modelConfig: RuntimeModelConfig,
  fixture: PromptTrajectoryFixture,
): unknown {
  const target = modelConfig.main;
  if (!target.baseURL) {
    throw new Error("Prompt trajectory Provider is missing baseURL");
  }
  const apiFormat =
    target.kind === "anthropic"
      ? "anthropic-messages"
      : target.kind === "openai"
        ? "openai-responses"
        : "openai-chat-completions";
  const providerConfig = new provider.ProviderConfig({
    access: new provider.ApiKeyAccessConfig({
      apiKey: target.apiKey ?? "prompt-trajectory-key",
    }),
    api: new provider.ProviderApiConfig({
      type: apiFormat,
      baseURL: target.baseURL,
      headers: target.headers,
    }),
    models: [target.model],
    enabled: true,
  });
  const registryModelConfig = new provider.ModelConfig({
    properties: new provider.ModelPropertiesConfig({
      contextWindow: 1_000_000,
      inputFormat: {
        supportsText: true,
        supportsImage: true,
        supportsVideo: true,
        supportsAudio: false,
        supportsPdf: true,
        ...fixture.modelInputFormat,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    }),
    optionSpecs: new provider.ModelOptionSpecsConfig({
      maxOutputTokens: { max: 1_000_000 },
    }),
  });
  return new provider.ProviderRegistry([
    {
      providerId: target.provider,
      config: providerConfig,
      models: [{ modelId: target.model, config: registryModelConfig }],
    },
  ]);
}

export function buildRecorderRuntimeConfig(input: {
  fixture: PromptTrajectoryFixture;
  modelSelection: unknown;
  workingDirectory: string;
}): Record<string, unknown> {
  const fixtureRuntimeConfig = input.fixture.runtimeConfig;

  return {
    ...fixtureRuntimeConfig,
    compact: fixtureRuntimeConfig?.compact,
    mcp: { enabled: false },
    memory: { enabled: false },
    mode: fixtureRuntimeConfig?.mode ?? "yolo",
    modelSelection: input.modelSelection,
    modelStreaming: fixtureRuntimeConfig?.modelStreaming ?? "on",
    outputStyle: fixtureRuntimeConfig?.outputStyle,
    subagents: fixtureRuntimeConfig?.subagents ?? { enabled: false },
    titleGeneration: { enabled: false },
    workingDirectory: input.workingDirectory,
  };
}
