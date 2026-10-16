import { run } from "../../packages/cli/src/run.ts";
import { scheduleCliExitWatchdog } from "../../packages/cli/src/shutdown.ts";
import { loadZCodeModules } from "./memory-e2e-runtime.mjs";

// 只注入隔离配置和 scripted provider；参数、Runtime、Extraction、关闭与信号均走真实实现。
const settings = JSON.parse(process.argv[2]);
const modules = await loadZCodeModules();
const providerId = "memory-bench-provider";
const modelId = "memory-bench-model";
const providerRegistry = new modules.provider.ProviderRegistry([
  {
    providerId,
    config: new modules.provider.ProviderConfig({
      access: new modules.provider.ApiKeyAccessConfig({ apiKey: "memory-bench-test-key" }),
      api: new modules.provider.ProviderApiConfig({
        type: "anthropic-messages",
        baseUrl: settings.baseURL,
      }),
      models: [modelId],
      enabled: true,
    }),
    models: [
      {
        modelId,
        config: new modules.provider.ModelConfig({
          properties: new modules.provider.ModelPropertiesConfig({
            contextWindow: 1_000_000,
            inputFormat: { supportsText: true },
            outputFormat: { supportsText: true },
            supportsToolCall: true,
            supportsMidConversationSystem: true,
          }),
          optionSpecs: new modules.provider.ModelOptionSpecsConfig({
            maxOutputTokens: { max: 1_000_000, map: '{"max_tokens": maxOutputTokens}' },
            reasoningLevel: { values: ["disabled"], map: "{}" },
          }),
        }),
      },
    ],
  },
]);

process.on("message", (message) => {
  if (message === "probe") process.send?.("alive");
});
process.channel?.unref();

try {
  process.exitCode = await run(
    {
      argv: settings.argv,
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
    },
    {
      cwd: () => settings.workspace,
      env: {
        ...process.env,
        ZCODE_ENV: "test",
        ZCODE_STORAGE_DIR: settings.storageRoot,
        ZCODE_MODEL_TELEMETRY_ENABLED: "false",
      },
      skipUserConfig: true,
      loadDotenv: () => ({ keys: [], loaded: false }),
      startProcessProviderRegistryRuntime: async () => ({
        runtime: { registryService: providerRegistry },
        dispose() {},
      }),
      createZCodeApp: async (options) => {
        const app = await modules.bootstrap.createZCodeApp({
          ...options,
          skipUserConfig: true,
          runtimeConfig: {
            ...options.runtimeConfig,
            memory: { ...options.runtimeConfig.memory, enabled: settings.memoryEnabled, use: true },
            modelSelection: { providerId, modelId, options: { reasoningLevel: "disabled" } },
            modelStreaming: "off",
            mcp: { enabled: false },
            subagents: { enabled: false },
            titleGeneration: { enabled: false },
          },
        });
        const close = app.close.bind(app);
        app.close = async () => {
          process.send?.("closing");
          await close();
        };
        return app;
      },
    },
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.disconnect?.();
  scheduleCliExitWatchdog({ exitCode: Number(process.exitCode ?? 0) });
}
