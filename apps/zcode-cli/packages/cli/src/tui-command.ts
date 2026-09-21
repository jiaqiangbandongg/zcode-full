import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RunContext, GlobalOptions } from "@zcode/shared-types";
import { resolveZCodeRuntimeEnv } from "@zcode/shared";
import { createNodeClipboardImageReader } from "./clipboard-image.js";
import { createNodeClipboardTextWriter } from "./clipboard-text.js";
import { listSlashCommandSuggestions } from "./command-center.js";
import { registerCliShutdownHandlers } from "./shutdown.js";
import { listCustomCommandsForTui, loadInitialTuiSessionMetadata } from "./tui-command-data.js";
import { createTuiSubmitPrompt } from "./tui-prompt-handler.js";
import { loadTuiRuntime } from "./tui-runtime-loader.js";
import { resolveTuiStartupLocale } from "./tui-startup-locale.js";
import { createWorkspacePathSuggestionProvider } from "./tui-workspace-paths.js";
import { resolveWorkspaceGitBranch } from "./tui-workspace-git.js";
import { createCliModeState, currentCliMode } from "./tui-command-state.js";
import type { CliPermissionMode, CliResumeRequest, RunDependencies } from "./cli-types.js";

export const runTuiCommand = async (
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  version: string,
  mode?: CliPermissionMode,
  resumeRequest?: CliResumeRequest,
  toolDisallowlist?: readonly string[],
  forceMcs = false,
): Promise<number> => {
  try {
    const modeState = createCliModeState(mode);
    const runTui = deps.runTui ?? (await loadTuiRuntime()).runTui;
    const workspaceDirectory = (deps.cwd ?? process.cwd)();
    const env = deps.env ?? process.env;
    const developerMode = resolveZCodeRuntimeEnv(env) === "development";
    const startupLocale = resolveTuiStartupLocale({
      deps,
      options,
      workingDirectory: workspaceDirectory,
    });
    const promptHandler = createTuiSubmitPrompt(
      deps,
      modeState,
      version,
      resumeRequest,
      options.locale,
      options.detectedLocale,
      startupLocale,
      toolDisallowlist,
      forceMcs,
      options.browserUse,
      options.browserExecutable,
    );
    const unregisterShutdownHandlers = registerCliShutdownHandlers({
      cleanup: async () => {
        await promptHandler.close?.();
      },
      cleanupTimeoutMs: deps.shutdownCleanupTimeoutMs,
      exitProcess: deps.exitProcess,
      process: deps.shutdownProcess,
    });
    try {
      const storageDir = (deps.env ?? process.env).ZCODE_STORAGE_DIR || join(homedir(), ".zcode-beta");
      const backupOnboardingPath = join(storageDir, "git-backup-onboarding-done");
      if (!existsSync(backupOnboardingPath)) {
        ctx.stderr.write(
          "\n💡 ZCode 满血版支持 Git 自动备份到你自己的阿里云 OSS。" +
          "\n   输入 /backup configure 了解详情，或 /backup enable 开启。\n\n",
        );
      }
      return await runTui({
        loadStartupOptions: async () => {
          const [metadata, customCommands, workspaceGitBranch] = await Promise.all([
            loadInitialTuiSessionMetadata(promptHandler),
            listCustomCommandsForTui(deps).catch(() => undefined),
            (deps.resolveWorkspaceGitBranch ?? resolveWorkspaceGitBranch)({
              workspaceDirectory,
            }).catch(() => undefined),
          ]);
          return {
            initialMode: currentCliMode(modeState),
            initialModel: metadata.model,
            initialThoughtLevel: metadata.thoughtLevel,
            loginRequired: metadata.loginRequired,
            locale: metadata.locale ?? startupLocale,
            theme: metadata.theme ?? "auto",
            modelOptions: metadata.modelOptions,
            effortOptions: metadata.effortOptions,
            slashCommands: listSlashCommandSuggestions(customCommands),
            workspaceGitBranch,
          };
        },
        locale: startupLocale,
        developerMode,
        version,
        workspaceDirectory,
        noColor: options.noColor,
        readClipboardImage: deps.readClipboardImage ?? createNodeClipboardImageReader(),
        listModelOptions: promptHandler.listModelOptions,
        listWorkspacePathSuggestions: createWorkspacePathSuggestionProvider({
          workspaceDirectory,
        }),
        listMcpServers: promptHandler.listMcpServers,
        readSubagents: promptHandler.readSubagents,
        readSubagentTranscript: promptHandler.readSubagentTranscript,
        listWorkflowRuns: promptHandler.listWorkflowRuns,
        replayWorkflowRuns: promptHandler.replayWorkflowRuns,
        getMainSessionId: promptHandler.getMainSessionId,
        writeClipboardText:
          deps.writeClipboardText ?? createNodeClipboardTextWriter({ stdout: ctx.stdout }),
        stderr: ctx.stderr,
        stdin: ctx.stdin,
        stdout: ctx.stdout,
        recallPreviousInput: promptHandler.recallPreviousInput,
        sendInput: promptHandler.sendInput,
        setMode: promptHandler.setMode,
        submitPrompt: promptHandler,
        subscribeSessionEvents: promptHandler.subscribeSessionEvents,
      });
    } finally {
      unregisterShutdownHandlers();
      await promptHandler.close?.();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
};
