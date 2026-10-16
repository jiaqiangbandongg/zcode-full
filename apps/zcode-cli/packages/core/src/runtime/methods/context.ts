import { join } from "node:path";

import {
  traceContextToLogContext,
  createContextBuilder,
  createSubagentContextBuilder,
} from "../deps.js";
import type {
  Model,
  ModelToolCall,
  SkillLoadOutcome,
  TraceContext,
  ContextSourceSnapshot,
  ContextBuilder,
  ContextBuilderConfig,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { ensureMemoryDirectoryExists } from "../../memory/directory.js";
import { formatProjectMemoryIndexContent } from "../../memory/index-content.js";
import {
  ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
  type ProjectMemoryRetrievalBranch,
} from "../../memory/project-memory-retrieval-branch.js";
import {
  createReadFileStateKey,
  normalizeReadFileStateMtimeMs,
} from "../../tool/read-file-state.js";
import { resolveEnabledProjectMemoryRoot } from "../helpers/project-memory.js";
import { buildContextHistoryEntries } from "./context-history-entries.js";
import { resolveRuntimeEmbeddedSearchEnabled } from "./embedded-search-branch.js";
import { getContextSourceShellDisplayName } from "./session-shell-environment.js";
import {
  ensureGenUiOutputDirectory,
  resolveGenUiOutputDirectory,
} from "../helpers/gen-ui-output.js";

export { buildContextHistoryEntries };

export async function ensureContextInitialized(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  model?: Model,
): Promise<void> {
  if (this.contextInitialized) return;

  const shellDisplayName = getContextSourceShellDisplayName(this);
  const snapshot = this.contextSourcePort
    ? await this.contextSourcePort.resolveContextSources(
        {
          workingDirectory: this.workingDirectory,
          currentDate: this.config.currentDate,
          effectiveShellDisplayName: shellDisplayName,
          envInfo: this.config.envInfo,
          userInstructions: this.config.userInstructions
            ? {
                ...this.config.userInstructions,
                workingDirectory:
                  this.config.userInstructions.workingDirectory ?? this.workingDirectory,
              }
            : undefined,
          projectContext: this.config.projectContext,
          trace: traceContext,
        },
        { signal: undefined },
      )
    : this.createConfigOnlyContextSnapshot(this.workingDirectory);

  this.workingDirectory = snapshot.workingDirectory;
  // Bash cd 之后 workingDirectory 会变化，但 workspaceRoot 仍表示会话初始工作区边界。
  this.workspaceRoot = snapshot.workingDirectory;
  this.contextSourceSnapshot = snapshot;
  this.startMcpStartup(traceContext);
  this.skillLoadOutcome = await this.discoverSkillsForContext(traceContext);
  this.memoryRoot = await this.loadProjectMemoryRoot(traceContext);
  this.memoryIndexContent = await loadProjectMemoryIndexContent(
    this,
    this.memoryRoot,
    ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
  );
  await ensureGenUiOutputDirectory(this);
  this.contextBuilder = this.createContextBuilderFromSnapshot(snapshot, this.memoryRoot, {
    memoryIndexContent: this.memoryIndexContent,
    model,
  });
  this.initializeMessageHistoryFromContext(this.contextBuilder, traceContext);
  this.contextInitialized = true;
}

export async function getSkillCatalog(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SkillLoadOutcome> {
  // Composer 曾独立扫描磁盘，所以运行中的 Session 会看到 AgentRuntime
  // 尚未加载的新 Skill。先经过 runtime 唯一的 context 初始化门，再返回防御性副本，
  // 让 UI 与本 Session 实际可用的 Skill 保持同一快照；新 runtime 会自然重新发现。
  await this.ensureContextInitialized(traceContext);
  const outcome = this.skillLoadOutcome ?? {
    skills: [],
    diagnostics: [],
    totalDiscovered: 0,
  };
  return {
    skills: outcome.skills.map((skill) => ({ ...skill })),
    diagnostics: outcome.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    totalDiscovered: outcome.totalDiscovered,
  };
}

export function createContextBuilderFromSnapshot(
  this: AgentRuntimeInternal,
  snapshot: ContextSourceSnapshot,
  memoryRoot?: string,
  options: { memoryIndexContent?: string; model?: Model; persistEnvInfo?: boolean } = {},
): ContextBuilder {
  const envInfo = snapshot.envInfo;
  // 同步 preview / config-only fallback 会构造 unknown envInfo。
  // 这类临时值不能写回 config，否则首轮真实 context source 会把它当作显式 envInfo，
  // 从而跳过 Node env/git 探测。
  if (options.persistEnvInfo !== false) {
    // 执行模型属于 model step，不写回可复用的 Context Source。
    this.config.envInfo = envInfo;
  }
  if (this.config.subagentContext) {
    return createSubagentContextBuilder({
      agentPrompt: this.config.subagentContext.agentPrompt,
      currentDate: snapshot.currentDate,
      envInfo,
      model: options.model,
      skillMetadataBudget: this.config.skillMetadataBudget,
      skills: this.skillLoadOutcome,
      userInstructions: this.config.subagentContext.userInstructions,
    });
  }

  const contextConfig: ContextBuilderConfig = {
    workingDirectory: snapshot.workingDirectory,
    envInfo,
    model: options.model,
    presentationSurface: this.config.presentationSurface,
    genUiOutputDirectory: resolveGenUiOutputDirectory(this),
    currentDate: snapshot.currentDate,
    userInstructions: snapshot.userInstructions,
    projectContext: snapshot.projectContext,
    memoryIndexContent: options.memoryIndexContent,
    memoryRoot,
    skills: this.skillLoadOutcome,
    agentProfiles: this.config.subagents?.profiles,
    embeddedSearchEnabled: resolveRuntimeEmbeddedSearchEnabled(this),
    skillMetadataBudget: this.config.skillMetadataBudget,
    customSystemPrompt: this.config.systemPrompt,
    workflowActor: this.config.workflowActor,
    language: this.config.language,
    outputStyle: this.config.outputStyle,
    compact: this.config.compact,
    guidanceToolNames: this.getTools(options.model).map((tool) => tool.name),
  };

  return createContextBuilder(contextConfig).setToolRegistry(this.registry);
}

export async function loadProjectMemoryRoot(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<string | undefined> {
  const memoryRoot = resolveEnabledProjectMemoryRoot(this.config, this.workspaceRoot);
  if (!memoryRoot) {
    this.logMemorySkipped(traceContext, "disabled_or_excluded", {
      taskType: this.config.taskType,
    });
    return undefined;
  }
  if (!this.fileSystemPort) {
    this.logMemorySkipped(traceContext, "missing_file_system_port", {
      memoryRoot,
    });
    return undefined;
  }
  await ensureMemoryDirectoryExists(this.fileSystemPort, memoryRoot, traceContext, this.logger);
  return memoryRoot;
}

export async function loadProjectMemoryIndexContent(
  runtime: AgentRuntimeInternal,
  memoryRoot: string | undefined,
  retrievalBranch: ProjectMemoryRetrievalBranch,
): Promise<string | undefined> {
  if (retrievalBranch !== "default-index") return undefined;
  const fileSystemPort = runtime.fileSystemPort;
  if (!fileSystemPort || !memoryRoot) return undefined;
  const indexPath = join(memoryRoot, "MEMORY.md");
  try {
    const read = await fileSystemPort.readTextFile({ path: indexPath });
    const formattedContent = formatProjectMemoryIndexContent(read.content);
    if (!formattedContent) return undefined;
    runtime.readFileState.set(createReadFileStateKey(indexPath, undefined, undefined), {
      content: read.content,
      isPartialView: formattedContent !== read.content,
      limit: undefined,
      mtimeMs: normalizeReadFileStateMtimeMs(read.revision?.mtimeMs),
      offset: undefined,
      path: indexPath,
      readAt: runtime.now(),
      revisionId: read.revision?.id,
      sizeBytes: read.sizeBytes,
    });
    return read.content;
  } catch {
    // 默认 Memory 分支将缺失或不可读的 index 视为没有该 context source。
    return undefined;
  }
}

export function logMemorySkipped(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  reason: string,
  context: Record<string, unknown> = {},
): void {
  this.logger?.debug("Memory read skipped", {
    ...traceContextToLogContext(traceContext),
    event: "memory.read.skipped",
    module: "core.runtime",
    reason,
    status: "completed",
    ...context,
  });
}

export async function discoverSkillsForContext(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SkillLoadOutcome | undefined> {
  if (!this.skillPort) {
    return undefined;
  }

  try {
    const outcome = await this.skillPort.discoverSkills({
      workingDirectory: this.workingDirectory,
      trace: traceContext,
    });
    this.logger?.debug("Skills discovered", {
      ...traceContextToLogContext(traceContext),
      diagnosticCount: outcome.diagnostics.length,
      module: "core.runtime",
      skillCount: outcome.skills.length,
      totalDiscovered: outcome.totalDiscovered,
    });
    return outcome;
  } catch (error) {
    this.logger?.warn("Skill discovery failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      module: "core.runtime",
    });
    return {
      skills: [],
      diagnostics: [
        {
          code: "skill_scan_failed",
          severity: "warning",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      totalDiscovered: 0,
    };
  }
}

export function createConfigOnlyContextSnapshot(
  this: AgentRuntimeInternal,
  workingDirectory: string,
): ContextSourceSnapshot {
  return {
    workingDirectory,
    envInfo: this.config.envInfo ?? {
      cwd: workingDirectory,
      platform: "unknown",
      shell: "unknown",
      osVersion: "unknown",
      nodeVersion: "unknown",
    },
    currentDate: this.config.currentDate,
    projectContext: this.config.projectContext,
    diagnostics: [],
  };
}

export function initializeMessageHistoryFromContext(
  this: AgentRuntimeInternal,
  contextBuilder: ContextBuilder,
  traceContext: TraceContext,
): void {
  const contextResult = contextBuilder.build();
  this.latestContextBuildResult = contextResult;
  this.messageHistory.init(buildContextHistoryEntries(contextResult));

  this.logger?.debug("Context built", {
    ...traceContextToLogContext(traceContext),
    event: "context.built",
    module: "core.runtime",
    sectionCount: contextResult.sections.length,
    status: "completed",
    tokenMethod: "estimated",
    tokenizer: "zcode.estimateTokens.v1",
    totalChars: contextResult.totalChars,
    totalTokens: contextResult.totalTokens,
    sections: contextResult.sections.map((s) => ({
      name: s.name,
      source: s.source,
      chars: s.chars,
      tokens: s.tokens,
      tokenMethod: "estimated",
      confidence: "medium",
      tokenizer: "zcode.estimateTokens.v1",
      preview: s.preview,
      content: s.content,
    })),
  });
}

export function extractToolCallsFromResult(
  this: AgentRuntimeInternal,
  result: any,
): ModelToolCall[] {
  const toolCalls: ModelToolCall[] = [];

  // Try different result formats
  const responses = result.responses ?? result.finishReasons ?? [];

  for (const response of responses) {
    if (response.toolCalls && Array.isArray(response.toolCalls)) {
      for (const tc of response.toolCalls) {
        toolCalls.push({
          id: tc.id,
          name: tc.name ?? tc.toolName,
          input: tc.input,
          providerExecuted: tc.providerExecuted,
        });
      }
    }
  }

  // Also check for flat tool_calls array
  if (result.toolCalls && Array.isArray(result.toolCalls)) {
    for (const tc of result.toolCalls) {
      if (!toolCalls.find((c) => c.id === tc.id)) {
        toolCalls.push({
          id: tc.id,
          name: tc.name ?? tc.toolName,
          input: tc.input,
          providerExecuted: tc.providerExecuted,
        });
      }
    }
  }

  return toolCalls;
}

export function shouldStreamModelText(this: AgentRuntimeInternal): boolean {
  return this.config.modelStreaming === "on";
}
