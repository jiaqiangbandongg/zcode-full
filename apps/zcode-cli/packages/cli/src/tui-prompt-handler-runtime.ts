// tui-prompt-handler.ts 顶到 oxlint max-lines 上限（400 行），把 createApp 里
// 「读 dotenv → 定位要恢复的会话 → 装 bootstrap 模块 → 起 Provider Registry
// 常驻运行时 → 读默认模型选择」这段进程级准备拆到本文件；
// 公开面仍从 tui-prompt-handler.ts 导出。
import type { ZCodeAppOptions } from "@zcode/bootstrap";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import { loadCliDotenv } from "./env.js";
import { createCliProviderRefreshReporter } from "./provider-runtime-env.js";
import { resolveResumeSession } from "./resume.js";
import type { CliResumeRequest, RunDependencies } from "./cli-types.js";

type ProviderRegistryRuntime = Awaited<
  ReturnType<NonNullable<RunDependencies["startProcessProviderRegistryRuntime"]>>
>;

// 跨 App 替换（/new、/resume、/fork）复用的进程级句柄：整个 Prompt Handler 生命期只起一份，
// 只在终态 close 时对称 shutdown。之前是 createTuiSubmitPrompt 里的三个 let 闭包变量。
interface TuiProcessRuntimeState {
  providerEndpointRoutingPort: ZCodeAppOptions["providerEndpointRoutingPort"];
  providerRegistryRuntimePromise: Promise<ProviderRegistryRuntime> | undefined;
  shutdownTelemetry: (() => Promise<void>) | undefined;
}

export const createTuiProcessRuntimeState = (): TuiProcessRuntimeState => ({
  providerEndpointRoutingPort: undefined,
  providerRegistryRuntimePromise: undefined,
  shutdownTelemetry: undefined,
});

// 返回值类型交给推断：原地 createApp 里这几个都是推断出来的局部变量，手写接口反而会把
// 品牌类型（SessionId）和 createZCodeApp 的联合签名收窄错。
export async function prepareTuiAppRuntime(
  deps: RunDependencies,
  version: string,
  request: CliResumeRequest,
  state: TuiProcessRuntimeState,
) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
    cwd: workingDirectory,
    env,
  });

  if (dotenvResult.error) {
    throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
      cause: dotenvResult.error,
    });
  }

  const sessionId = await resolveResumeSession(request, workingDirectory, env, deps);
  const bootstrapModule = deps.createZCodeApp ? undefined : await loadBootstrapModule();
  const createAppFactory = deps.createZCodeApp ?? bootstrapModule?.createZCodeApp;
  if (!createAppFactory) throw new Error("ZCode app factory is unavailable.");
  const prepareTelemetry =
    deps.prepareZCodeTelemetryEnv ?? bootstrapModule?.prepareZCodeTelemetryEnv;
  if (prepareTelemetry) {
    state.shutdownTelemetry =
      deps.shutdownZCodeTelemetry ?? bootstrapModule?.shutdownZCodeTelemetry;
  }
  const appEnv = prepareTelemetry
    ? await prepareTelemetry(env, {
        cliVersion: version,
        productVersion: env.ZCODE_APP_VERSION,
      })
    : env;
  const startProviderRegistryRuntime =
    deps.startProcessProviderRegistryRuntime ??
    bootstrapModule?.startProcessProviderRegistryRuntime;
  if (!startProviderRegistryRuntime) {
    throw new Error("Provider Registry runtime is unavailable.");
  }
  state.providerRegistryRuntimePromise ??= startProviderRegistryRuntime(
    appEnv,
    deps.skipUserConfig
      ? {}
      : {
          standalone: {
            ...createCliProviderRefreshReporter(),
            ...(deps.userConfigPath ? { legacyCliUserConfigFilePath: deps.userConfigPath } : {}),
          },
        },
  );
  const providerRegistryRuntime = await state.providerRegistryRuntimePromise;
  const configuredDefaultModelSelection = providerRegistryRuntime?.modelSelectionConfigRepository
    ? await providerRegistryRuntime.modelSelectionConfigRepository.read()
    : providerRegistryRuntime?.configuredDefaultModelSelection;
  const createProviderEndpointRoutingPort =
    deps.createProviderEndpointRoutingPort ??
    bootstrapModule?.createDefaultProviderEndpointRoutingPort;
  state.providerEndpointRoutingPort ??= createProviderEndpointRoutingPort?.({
    appVersion: version,
    env,
    projectConfigPath: deps.projectConfigPath,
    skipUserConfig: deps.skipUserConfig,
    userConfigPath: deps.userConfigPath,
    workingDirectory,
  });

  return {
    appEnv,
    configuredDefaultModelSelection,
    createAppFactory,
    providerRegistryRuntime,
    sessionId,
    workingDirectory,
  };
}
