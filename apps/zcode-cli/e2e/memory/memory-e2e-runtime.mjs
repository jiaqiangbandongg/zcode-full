import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  existingMemoryFile,
  initialProjectMemoryIndex,
  memoryE2EText,
} from "./memory-e2e-provider.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../../..");
const modelId = "memory-e2e-model";
const providerId = "memory-e2e-provider";

export async function createScenarioPaths(runRoot, modules) {
  const project = scenarioRoot(runRoot, "project");
  const custom = scenarioRoot(runRoot, "custom");
  const disabled = scenarioRoot(runRoot, "disabled");
  const headless = scenarioRoot(runRoot, "headless");
  const shutdown = scenarioRoot(runRoot, "shutdown");
  for (const scenario of [project, custom, disabled, headless, shutdown]) {
    await mkdir(scenario.workspace, { recursive: true });
    await mkdir(scenario.storageRoot, { recursive: true });
  }

  project.memoryRoot = modules.core.resolveProjectMemoryRoot({
    cliStorageRoot: join(project.storageRoot, "cli"),
    workspacePath: project.workspace,
  });
  project.indexFile = join(project.memoryRoot, "MEMORY.md");
  project.existingFile = join(project.memoryRoot, "database-test-policy.md");
  project.extractedFile = join(project.memoryRoot, "deployment-approval-policy.md");
  await mkdir(project.memoryRoot, { recursive: true });
  await writeFile(project.indexFile, initialProjectMemoryIndex(), "utf8");
  await writeFile(project.existingFile, existingMemoryFile(), "utf8");

  custom.memoryRoot = join(custom.workspace, ".zcode", "agent-memory", "memory-curator");
  custom.memoryFile = join(custom.memoryRoot, "review-convention.md");
  await mkdir(custom.memoryRoot, { recursive: true });
  await writeFile(
    join(custom.memoryRoot, "MEMORY.md"),
    "- [Review convention](review-convention.md): Keep review findings evidence-first.\n",
    "utf8",
  );

  disabled.memoryRoot = modules.core.resolveProjectMemoryRoot({
    cliStorageRoot: join(disabled.storageRoot, "cli"),
    workspacePath: disabled.workspace,
  });
  headless.memoryRoot = modules.core.resolveProjectMemoryRoot({
    cliStorageRoot: join(headless.storageRoot, "cli"),
    workspacePath: headless.workspace,
  });
  headless.indexFile = join(headless.memoryRoot, "MEMORY.md");
  headless.existingFile = join(headless.memoryRoot, "database-test-policy.md");
  await mkdir(headless.memoryRoot, { recursive: true });
  await writeFile(headless.indexFile, initialProjectMemoryIndex(), "utf8");
  await writeFile(headless.existingFile, existingMemoryFile(), "utf8");
  shutdown.memoryRoot = modules.core.resolveProjectMemoryRoot({
    cliStorageRoot: join(shutdown.storageRoot, "cli"),
    workspacePath: shutdown.workspace,
  });
  shutdown.cancelledFile = join(shutdown.memoryRoot, "must-not-be-written.md");
  return { custom, disabled, headless, project, shutdown };
}

export async function runMemoryScenarios(input) {
  await runProjectMemoryScenario(input);
  await runCustomAgentScenario(input);
  await runDisabledScenario(input);
  await runHeadlessExtractionDisabledScenario(input);
  return {
    closeCancellation: await runCloseCancellationScenario(input),
  };
}

export async function loadZCodeModules() {
  const paths = {
    bootstrap: join(repoRoot, "apps/zcode-cli/packages/bootstrap/dist/index.js"),
    bootstrapModelConfig: join(repoRoot, "apps/zcode-cli/packages/bootstrap/dist/model-config.js"),
    core: join(repoRoot, "apps/zcode-cli/packages/core/dist/index.js"),
    projectMemoryRetrievalBranch: join(
      repoRoot,
      "apps/zcode-cli/packages/core/dist/memory/project-memory-retrieval-branch.js",
    ),
    providerConfig: join(repoRoot, "packages/provider/dist/config/index.js"),
    providerRegistry: join(repoRoot, "packages/provider/dist/registry.js"),
  };
  try {
    const [
      bootstrap,
      bootstrapModelConfig,
      core,
      projectMemoryRetrievalBranch,
      providerConfig,
      providerRegistry,
    ] = await Promise.all(Object.values(paths).map((path) => import(pathToFileURL(path).href)));
    return {
      bootstrap: { ...bootstrap, ...bootstrapModelConfig },
      core,
      projectMemoryRetrievalBranch,
      provider: { ...providerConfig, ...providerRegistry },
    };
  } catch (error) {
    throw new Error(
      "Unable to load built ZCode packages. Run the Memory E2E e2e:build script first.",
      { cause: error },
    );
  }
}

function scenarioRoot(runRoot, name) {
  const root = join(runRoot, name);
  return {
    root,
    storageRoot: join(root, "storage"),
    workspace: join(root, "workspace"),
  };
}

async function runProjectMemoryScenario({ modules, paths, provider }) {
  const app = await createApp({
    modules,
    provider,
    sessionId: "memory-e2e-project-session",
    storageRoot: paths.project.storageRoot,
    workspace: paths.project.workspace,
  });

  try {
    await withTimeout(
      app.submitPrompt(memoryE2EText.defaultBranchPrompt),
      15_000,
      "project default Memory turn",
    );
    await withTimeout(
      app.submitPrompt(memoryE2EText.extractionPrompt),
      15_000,
      "project Extraction turn",
    );
    await withTimeout(
      app.runtime.drainMemoryExtractions(),
      15_000,
      "project Memory Extraction completion",
    );
  } finally {
    await withTimeout(app.close?.(), 15_000, "project Memory close");
  }

  const nextSession = await createApp({
    modules,
    provider,
    sessionId: "memory-e2e-project-next-session",
    storageRoot: paths.project.storageRoot,
    workspace: paths.project.workspace,
  });
  try {
    await withTimeout(
      nextSession.submitPrompt(memoryE2EText.extractedDefaultPrompt),
      15_000,
      "project Memory next-session index turn",
    );
    await withTimeout(
      nextSession.runtime.drainMemoryExtractions(),
      15_000,
      "project Memory next-session Extraction completion",
    );
  } finally {
    await withTimeout(nextSession.close?.(), 15_000, "project Memory next-session close");
  }
}

async function runCustomAgentScenario({ modules, paths, provider }) {
  const profile = {
    description: "Maintain durable review conventions.",
    memory: "project",
    name: "memory-curator",
    source: "project",
    systemPrompt: "Review and preserve durable collaboration guidance.",
    tools: ["Grep"],
  };
  const app = await createApp({
    modules,
    profiles: [profile],
    provider,
    sessionId: "memory-e2e-custom-parent-session",
    storageRoot: paths.custom.storageRoot,
    subagentsEnabled: true,
    workspace: paths.custom.workspace,
  });

  try {
    await withTimeout(
      app.submitPrompt(memoryE2EText.customParentPrompt),
      15_000,
      "custom agent Memory turn",
    );
    await withTimeout(
      app.runtime.drainMemoryExtractions(),
      15_000,
      "custom agent parent Extraction completion",
    );
  } finally {
    await withTimeout(app.close?.(), 15_000, "custom agent close");
  }
}

async function runDisabledScenario({ modules, paths, provider }) {
  const app = await createApp({
    memoryEnabled: false,
    modules,
    provider,
    sessionId: "memory-e2e-disabled-session",
    storageRoot: paths.disabled.storageRoot,
    workspace: paths.disabled.workspace,
  });

  try {
    await withTimeout(
      app.submitPrompt(memoryE2EText.disabledPrompt),
      15_000,
      "disabled Memory turn",
    );
  } finally {
    await withTimeout(app.close?.(), 15_000, "disabled Memory close");
  }
}

async function runHeadlessExtractionDisabledScenario({ modules, paths, provider }) {
  const app = await createApp({
    extractionEnabled: false,
    modules,
    provider,
    sessionId: "memory-e2e-headless-session",
    storageRoot: paths.headless.storageRoot,
    workspace: paths.headless.workspace,
  });

  try {
    await withTimeout(
      app.submitPrompt(memoryE2EText.headlessPrompt),
      15_000,
      "headless Memory turn",
    );
    await withTimeout(
      app.runtime.drainMemoryExtractions(),
      15_000,
      "headless Memory Extraction drain",
    );
  } finally {
    await withTimeout(app.close?.(), 15_000, "headless Memory close");
  }
}

async function runCloseCancellationScenario({ closeBarrier, modules, paths, provider }) {
  const app = await createApp({
    modules,
    provider,
    sessionId: "memory-e2e-close-cancellation-session",
    storageRoot: paths.shutdown.storageRoot,
    workspace: paths.shutdown.workspace,
  });
  let closePromise;
  let closeStartedAtMs = 0;
  let closeDurationMs = 0;

  try {
    await withTimeout(
      app.submitPrompt(memoryE2EText.closeCancellationPrompt),
      15_000,
      "Memory close-cancellation Main turn",
    );
    await withTimeout(
      closeBarrier.waitUntilStarted(),
      15_000,
      "Memory close-cancellation Extraction start",
    );
    closeStartedAtMs = Date.now();
    closePromise = app.close?.();
    await withTimeout(closePromise, 2_000, "Memory close-cancellation session close");
    closeDurationMs = Date.now() - closeStartedAtMs;
  } finally {
    closeBarrier.releaseResponse();
    await withTimeout(closePromise ?? app.close?.(), 15_000, "Memory close-cancellation cleanup");
  }

  await waitForProviderRecord(
    provider,
    (record) =>
      record.requestBody.includes(memoryE2EText.closeCancellationPrompt) &&
      record.requestBody.includes(memoryE2EText.extractionMarker),
    "Memory close-cancellation provider capture",
  );
  await nextTask();
  return { closeDurationMs };
}

function createApp(input) {
  const env = {
    ...process.env,
    ZCODE_ENV: "test",
    ZCODE_STORAGE_DIR: input.storageRoot,
  };
  const target = {
    apiKey: "memory-e2e-key",
    apiKeyRequired: false,
    baseURL: input.provider.baseURL,
    kind: "anthropic",
    model: modelId,
    provider: providerId,
  };
  const modelAdapter = input.modules.bootstrap.createModelAdapter({
    env,
    executionConfig: input.modules.bootstrap.createRuntimeAiSdkModelExecutionConfig(env),
  });
  const providerRegistry = createProviderRegistry(input.modules.provider, target);

  return input.modules.bootstrap.createZCodeApp({
    env,
    modelAdapter,
    providerRegistry,
    runtimeConfig: {
      memory: {
        enabled: input.memoryEnabled ?? true,
        ...(input.extractionEnabled === undefined
          ? {}
          : { extractionEnabled: input.extractionEnabled }),
        use: true,
      },
      mcp: { enabled: false },
      mode: "yolo",
      modelSelection: { providerId, modelId, options: { reasoningLevel: "disabled" } },
      modelStreaming: "off",
      subagents: {
        enabled: input.subagentsEnabled ?? false,
        maxTurns: 4,
        profiles: input.profiles ?? [],
      },
      titleGeneration: { enabled: false },
      workingDirectory: input.workspace,
    },
    sessionId: input.sessionId,
    skipUserConfig: true,
  });
}

function createProviderRegistry(providerModule, target) {
  const providerConfig = new providerModule.ProviderConfig({
    access: new providerModule.ApiKeyAccessConfig({ apiKey: target.apiKey }),
    api: new providerModule.ProviderApiConfig({
      type: "anthropic-messages",
      baseUrl: target.baseURL,
    }),
    models: [modelId],
    enabled: true,
  });
  const modelConfig = new providerModule.ModelConfig({
    properties: new providerModule.ModelPropertiesConfig({
      contextWindow: 1_000_000,
      inputFormat: {
        supportsText: true,
        supportsImage: true,
        supportsVideo: true,
        supportsAudio: false,
        supportsPdf: true,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    }),
    optionSpecs: new providerModule.ModelOptionSpecsConfig({
      // fixture 必须遵守当前 Option Map 合同，避免在 Memory 请求之前就创建模型失败。
      reasoningLevel: { values: ["disabled"], map: "{}" },
      maxOutputTokens: { max: 1_000_000, map: '{"max_tokens": maxOutputTokens}' },
    }),
  });
  return new providerModule.ProviderRegistry([
    {
      providerId,
      config: providerConfig,
      models: [{ modelId, config: modelConfig }],
    },
  ]);
}

async function withTimeout(promise, timeoutMs, label) {
  if (!promise) return;
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForProviderRecord(provider, predicate, label) {
  const deadline = Date.now() + 5_000;
  while (!provider.records.some(predicate)) {
    if (Date.now() >= deadline) {
      throw new Error(`${label} timed out`);
    }
    await nextTask();
  }
}

async function nextTask() {
  await new Promise((resolve) => setImmediate(resolve));
}
