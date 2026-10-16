import { collectRuntimeAgentListing } from "../helpers/agent-listing.js";
import {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  CompactTimelineStatus,
  MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  SessionEventType,
  createChildTraceContext,
  isCoreError,
  createMessageId,
  createPartId,
  traceContextToLogContext,
  buildCompactPrompt,
  buildCompactSummaryMessage,
  buildManualCompactBoundary,
  createCompactBoundaryId,
  getUsageTotalTokens,
} from "../deps.js";
import type { SessionEvent, TraceContext } from "../deps.js";
import {
  defaultCompactPhaseForTrigger,
  defaultCompactReasonForTrigger,
  buildPostCompactReadStateReminderEntries,
  countCompactPreservedRuntimeMessages,
  buildPostCompactRuntimeEntries,
  compactFailureReasonFromError,
  estimateRuntimeEntryTokens,
  getRuntimeEntriesToSummarize,
  hasEnoughRuntimeEntriesToCompact,
  selectCompactEntries,
  selectCompactEntriesAfterPromptTooLong,
  selectCompactEntriesForInitialPromptTooLong,
  throwIfTurnAborted,
  isTurnCancellationError,
  isModelContextExceededError,
  isModelMediaTooLargeError,
  logMediaBudgetProjection,
  logMediaCapabilityProjection,
  truncateCompactSummaryRequestEntriesAfterPromptTooLong,
  projectCompactMediaForRetry,
  projectMessagesForModelMediaPolicy,
  logCompactMediaRetryProjection,
  readApprovedPlanFileReferenceEntry,
} from "../helpers/index.js";
import type { CompactTimelineContext, RuntimeModelTextResult } from "../types.js";
import type { Model } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { CompactAttemptOutcome } from "./turn-loop-state.js";
import {
  legacySyntheticRuntimeMetadata,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { selectPersistedCompactTail } from "../helpers/compact-preservation.js";
import {
  buildCompactSummaryRequestMessages,
  createCompactContextExceededFinishError,
  createCompactPromptTooLongError,
  formatCompactSummaryOrThrow,
  persistCompactTimelineEvent,
} from "./compact-active-helpers.js";
import { runCompactSummaryModelRequest } from "./compact-summary-model-request.js";
import { resolveNormalRequestMaxOutputTokens } from "./model-token-limits.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { resetProjectMemoryRecall } from "../helpers/project-memory-recall.js";
import { createRuntimeModel } from "./runtime-model.js";
import {
  filterOutputTokenContinuationEntries,
  preserveCanonicalContextPrefix,
} from "./turn-output-token-continuation.js";

const AUTO_COMPACT_MAX_ATTEMPTS = 3;
const COMPACT_TOOL_KEEP_MAX_COUNT = 100;

export async function compactActiveConversation(
  this: AgentRuntimeInternal,
  customInstructions: string | undefined,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  options: {
    abortSignal?: AbortSignal;
    compactContextTelemetry?: {
      inputTokens: number;
      policyContextWindowTokens: number;
      thresholdTokens?: number;
      tokenSource: "estimate" | "provider_usage";
    };
    autoCompactThreshold?: number;
    compactReason?: CompactReason;
    initialPromptTooLongCause?: unknown;
    phase?: CompactPhase;
    sourceCommandId?: string;
    trigger?: CompactTrigger;
    model?: Model;
    agentListingTools?: readonly { name: string }[];
    activeEntries?: readonly RuntimeMessageEntry[];
  } = {},
): Promise<{
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
  tokenCount: number;
}> {
  const trigger = options.trigger ?? CompactTrigger.Manual;
  const phase = options.phase ?? defaultCompactPhaseForTrigger(trigger);
  const compactTelemetry = this.agentTelemetry.compaction({
    trigger,
    phase,
    maxAttempts: AUTO_COMPACT_MAX_ATTEMPTS,
    modelMode: this.config.modelStreaming === "off" ? "non_streaming" : "streaming",
    policyContextWindowTokens: options.compactContextTelemetry?.policyContextWindowTokens,
    thresholdTokens: options.compactContextTelemetry?.thresholdTokens,
    tokenSource: options.compactContextTelemetry?.tokenSource,
    traceContext: turnTraceContext,
  });
  if (options.compactContextTelemetry) {
    // Auto 复用策略决策，Reactive 复用 overflow 路径 activeMessages；其他 trigger 不额外投影。
    compactTelemetry.setInputTokens(options.compactContextTelemetry.inputTokens);
  }
  return compactTelemetry.run(async () => {
    try {
      const result = await compactActiveConversationImpl.call(
        this,
        customInstructions,
        turnTraceContext,
        events,
        options,
      );
      compactTelemetry.setOutputTokens(result.tokenCount);
      compactTelemetry.finishCompleted();
      return result;
    } catch (error) {
      if (isTurnCancellationError(error, options.abortSignal)) {
        compactTelemetry.finishCancelled("abort_signal");
      } else {
        compactTelemetry.finishFailed("unhandled", "unknown", error);
      }
      throw error;
    }
  });
}

async function compactActiveConversationImpl(
  this: AgentRuntimeInternal,
  customInstructions: string | undefined,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  options: {
    abortSignal?: AbortSignal;
    compactContextTelemetry?: {
      inputTokens: number;
      policyContextWindowTokens: number;
      thresholdTokens?: number;
      tokenSource: "estimate" | "provider_usage";
    };
    autoCompactThreshold?: number;
    compactReason?: CompactReason;
    initialPromptTooLongCause?: unknown;
    phase?: CompactPhase;
    sourceCommandId?: string;
    trigger?: CompactTrigger;
    model?: Model;
    agentListingTools?: readonly { name: string }[];
    activeEntries?: readonly RuntimeMessageEntry[];
  } = {},
): Promise<{
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
  tokenCount: number;
}> {
  throwIfTurnAborted(options.abortSignal);
  const trigger = options.trigger ?? CompactTrigger.Manual;
  const phase = options.phase ?? defaultCompactPhaseForTrigger(trigger);
  const compactReason = options.compactReason ?? defaultCompactReasonForTrigger(trigger);
  const compactModel =
    options.model ??
    createRuntimeModel(this, {
      selection: this.getSessionModelSelection(),
    });
  const executionMaxOutputTokens = compactModel.optionSpecs.maxOutputTokens.max;
  // Active compact 会跨多个 await 保留这份成员浅快照；它依赖 RuntimeMessageEntry
  // 不可变约定。selection、provider render 和最终 replace 会创建各自拥有的副本，
  // 禁止在 compact 期间原地修改 activeEntries 内共享的 entry/message/content。
  const activeEntries = [
    ...(options.activeEntries ?? this.messageHistory.borrowReadOnlyRuntimeEntries()),
  ];
  const useMidConversationSystem =
    this.config.midConversationSystem?.mode === "force" ||
    compactModel.properties.supportsMidConversationSystem;
  const initialSelection = selectInitialCompactEntriesForActiveConversation({
    activeEntries,
    initialPromptTooLongCause: options.initialPromptTooLongCause,
    trigger,
    useMidConversationSystem,
  });
  let currentSelection = initialSelection;
  let preservedEntries = currentSelection.preservedEntries;
  const initialEntriesForSummary = currentSelection.entriesForSummary;
  let entriesForSummary = initialEntriesForSummary;
  let entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
  const preCompactTokenCount = estimateRuntimeEntryTokens(activeEntries, {
    useMidConversationSystem,
  });
  const maxAttempts = trigger === CompactTrigger.Auto ? AUTO_COMPACT_MAX_ATTEMPTS : 1;
  let attempt = 1;
  const compactTimeline: CompactTimelineContext = {
    operationId: `cmp_${crypto.randomUUID()}`,
    messageId: createMessageId(),
    partId: createPartId(),
    trigger,
    phase,
    compactReason,
    ...(options.sourceCommandId ? { sourceCommandId: options.sourceCommandId } : {}),
    startedAt: Date.now(),
    preCompactTokenCount,
  };

  if (!hasEnoughRuntimeEntriesToCompact(entriesForSummary)) {
    const skippedPayload = this.buildCompactTimelinePayload(compactTimeline, {
      endedAt: Date.now(),
      replace: true,
      status: CompactTimelineStatus.Skipped,
    });
    // 刚压缩过或历史太少时，/compact 是健康 no-op，不能暴露成系统故障。
    // 上层快速回填 tracker 只能记录真实 boundary，因此必须显式返回 skipped。
    await persistCompactTimelineEvent(
      this,
      SessionEventType.CompactCompleted,
      skippedPayload,
      turnTraceContext,
      events,
    );
    return {
      displayText: "Context is up to date; no compression needed",
      entries: activeEntries,
      outcome: "skipped",
      tokenCount: preCompactTokenCount,
    };
  }

  const compactStartedPayload = this.buildCompactTimelinePayload(compactTimeline, {
    ...(maxAttempts > 1 ? { attempt, maxAttempts } : {}),
    status: CompactTimelineStatus.Started,
  });
  await persistCompactTimelineEvent(
    this,
    SessionEventType.CompactStarted,
    compactStartedPayload,
    turnTraceContext,
    events,
  );
  // 止血原因：massive MCP 工具会把 compact summary request 的 provider context 撑爆。
  // ToolSearch/deferred tools 完成前，仅在工具数超过阈值时让 compact summary 保持无工具。
  await this.initializeMcp(turnTraceContext);
  throwIfTurnAborted(options.abortSignal);
  const runtimeCompactTools = this.getTools(compactModel);
  const compactTools =
    runtimeCompactTools.length > COMPACT_TOOL_KEEP_MAX_COUNT ? [] : runtimeCompactTools;

  while (true) {
    try {
      const lastSummarizedMessageId = this.latestConversationMessageId;
      const modelTraceContext = createChildTraceContext(turnTraceContext, {
        attributes: {
          model: `${compactModel.providerId}/${compactModel.modelId}`,
          querySource: "compact",
        },
      });
      const compactPrompt = buildCompactPrompt(customInstructions);
      let result: RuntimeModelTextResult;
      let compactPromptTooLongAttempts = 0;
      let stripMediaForSummary = false;
      const reselectEntriesAfterPromptTooLong = (cause: unknown): boolean => {
        const reselected = selectCompactEntriesAfterPromptTooLong({
          currentGroupsPreserved: currentSelection.groupsPreserved,
          entries: activeEntries,
          promptTooLongCause: cause,
          trigger,
          useMidConversationSystem,
        });
        if (!reselected) return false;

        compactPromptTooLongAttempts += 1;
        currentSelection = reselected;
        preservedEntries = reselected.preservedEntries;
        entriesForSummary = reselected.entriesForSummary;
        entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
        return true;
      };
      const truncateEntriesAfterPromptTooLong = (cause: unknown): boolean => {
        if (!canUseCompactSummaryTruncationFallback(trigger)) return false;

        const truncated = truncateCompactSummaryRequestEntriesAfterPromptTooLong({
          attempt: compactPromptTooLongAttempts,
          cause,
          entriesForSummary,
          logger: this.logger,
          traceContext: modelTraceContext,
          useMidConversationSystem,
        });
        if (!truncated) return false;

        compactPromptTooLongAttempts += 1;
        entriesForSummary = truncated;
        entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
        return true;
      };

      while (true) {
        const requestMessages = buildCompactSummaryRequestMessages(
          entriesForSummary,
          compactPrompt,
          { useMidConversationSystem },
        );
        const recordableEntries = filterOutputTokenContinuationEntries(entriesForSummary);
        const recordableRequestMessages =
          recordableEntries === entriesForSummary
            ? requestMessages
            : buildCompactSummaryRequestMessages(recordableEntries, compactPrompt, {
                useMidConversationSystem,
              });
        // Compact 曾只执行 capability projection，漏掉普通 turn 共用的聚合
        // 媒体预算；统一走模型媒体策略，避免 summary 请求绕过全局请求上限。
        const mediaPolicyProjection = projectMessagesForModelMediaPolicy(
          requestMessages,
          compactModel.properties.inputFormat,
        );
        logMediaCapabilityProjection(
          this.logger,
          modelTraceContext,
          mediaPolicyProjection.capabilityProjection,
          {
            event: "compact.request.media_capability_projection",
            message: "Compact request media capability projection",
            model: `${compactModel.providerId}/${compactModel.modelId}`,
          },
        );
        logMediaBudgetProjection(
          this.logger,
          modelTraceContext,
          mediaPolicyProjection.mediaBudgetProjection,
          {
            event: "compact.request.media_projection",
            message: "Compact request media budget projection",
          },
        );
        let projectedRequestMessages = mediaPolicyProjection.messages;
        let projectedRecordableMessages =
          recordableRequestMessages === requestMessages
            ? projectedRequestMessages
            : projectMessagesForModelMediaPolicy(
                recordableRequestMessages,
                compactModel.properties.inputFormat,
              ).messages;
        if (stripMediaForSummary) {
          // 复用通用 media budget 文案会污染 summary 的 provider-visible 内容。
          const mediaProjection = projectCompactMediaForRetry(projectedRequestMessages);
          projectedRequestMessages = mediaProjection.messages;
          projectedRecordableMessages =
            recordableRequestMessages === requestMessages
              ? projectedRequestMessages
              : projectCompactMediaForRetry(projectedRecordableMessages).messages;
          logCompactMediaRetryProjection(this.logger, modelTraceContext, mediaProjection);
        }

        const modelRequestEvent = this.createEvent(
          SessionEventType.ModelRequest,
          {
            // 事件误用了含 Continue 的实际请求数组，导致 query-local 提示进入持久化轨迹。
            // 与 v0.16.6 一致：事件记录过滤后的投影，下面的 provider 请求仍使用完整上下文。
            messages: projectedRecordableMessages,
            providerId: String(compactModel.providerId),
            modelId: String(compactModel.modelId),
            querySource: "compact",
            toolCount: compactTools.length,
            compactPromptTooLongRetry: compactPromptTooLongAttempts,
          },
          modelTraceContext,
        );
        await this.appendEvent(modelRequestEvent, modelTraceContext);
        events.push(modelRequestEvent);
        const modelStartedAt = Date.now();
        const networkEventStartIndex = events.length;
        const compactSummaryMaxOutputTokens = capCompactSummaryMaxOutputTokens(compactModel);
        const compactModelRequest = {
          abortSignal: options.abortSignal,
          maxOutputTokens: compactSummaryMaxOutputTokens,
          messages: projectedRequestMessages,
          metadata: traceContextToLogContext(modelTraceContext),
          modelCall: {
            attributes: {
              compactionOuterAttempt: attempt,
              compactionTrigger: trigger,
            },
            operation: "context_compaction" as const,
            operationId: compactTimeline.operationId,
          },
          statusSink: this.createModelStatusSink(modelTraceContext, events),
          // compact 的首个真实 provider event 结束 SSE retry 资格；隐藏 partial 在
          // content block 提交前仍可丢弃并 HTTP fallback，block end 后则禁止任何重放。
          preserveProviderStreamBoundaries: true,
          traceContext: modelTraceContext,
          tools: compactTools,
          refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
            abortSignal: options.abortSignal,
            model: compactModel,
            traceContext: modelTraceContext,
          }),
        };

        try {
          result = await runCompactSummaryModelRequest({
            logger: this.logger,
            model: compactModel,
            request: compactModelRequest,
          });
        } catch (error) {
          await recordModelUsageFact(this, {
            attemptIndex: compactPromptTooLongAttempts,
            error,
            events,
            model: compactModel,
            networkEventStartIndex,
            querySource: "compact",
            startedAt: modelStartedAt,
            status: isTurnCancellationError(error, options.abortSignal) ? "cancelled" : "error",
            traceContext: modelTraceContext,
          });
          if (isTurnCancellationError(error, options.abortSignal)) {
            throw error;
          }
          if (isModelMediaTooLargeError(error) && !stripMediaForSummary) {
            stripMediaForSummary = true;
            this.logger?.info(
              "Compact summary hit media-size error; retrying with stripped media",
              {
                ...traceContextToLogContext(modelTraceContext),
                errorMessage: error instanceof Error ? error.message : String(error),
                event: "compact.request.media_too_large.retry",
                module: "core.runtime",
              },
            );
            continue;
          }
          if (isModelContextExceededError(error)) {
            if (reselectEntriesAfterPromptTooLong(error)) continue;
            if (truncateEntriesAfterPromptTooLong(error)) continue;
            throw createCompactPromptTooLongError({
              attempt: compactPromptTooLongAttempts,
              cause: error,
              preCompactTokenCount,
            });
          }
          throw error;
        }

        await recordModelUsageFact(this, {
          attemptIndex: compactPromptTooLongAttempts,
          events,
          model: compactModel,
          networkEventStartIndex,
          querySource: "compact",
          result,
          startedAt: modelStartedAt,
          status: "completed",
          toolCallCount: this.extractToolCallsFromResult(result).length,
          traceContext: modelTraceContext,
        });
        const contextError = createCompactContextExceededFinishError(result);
        if (contextError) {
          // compact summary 也可能以 finishReason 返回超窗而不是 throw；
          // 必须先进入同一套 recent preserve 重选逻辑，避免 finishReason 路径丢上下文。
          if (reselectEntriesAfterPromptTooLong(contextError)) continue;
          if (truncateEntriesAfterPromptTooLong(contextError)) continue;
          throw createCompactPromptTooLongError({
            attempt: compactPromptTooLongAttempts,
            cause: contextError,
            preCompactTokenCount,
          });
        }
        break;
      }

      const summary = formatCompactSummaryOrThrow(this, result);
      const persistedSummary = summary;
      const planFileReferenceEntry = this.fileSystemPort
        ? await readApprovedPlanFileReferenceEntry({
            abortSignal: options.abortSignal,
            fileSystemPort: this.fileSystemPort,
            sessionId: this.sessionId,
            traceContext: modelTraceContext,
            workspaceRoot: this.workspaceRoot,
          })
        : undefined;
      const agentListingEntry = collectRuntimeAgentListing(
        this,
        preservedEntries,
        options.agentListingTools ?? this.getTools(options.model ?? compactModel),
      );
      const postCompactReminderEntries = [
        ...(agentListingEntry ? [agentListingEntry] : []),
        ...(planFileReferenceEntry ? [planFileReferenceEntry] : []),
        ...buildPostCompactReadStateReminderEntries({
          preservedEntries,
          readFileState: this.readFileState,
        }),
      ];

      const modelCompleteEvent = this.createEvent(
        SessionEventType.ModelComplete,
        {
          content: summary,
          stopReason: result.finishReason,
          usage: result.usage,
          querySource: "compact",
          toolCallCount: 0,
        },
        modelTraceContext,
      );
      await this.appendEvent(modelCompleteEvent, modelTraceContext);
      events.push(modelCompleteEvent);

      const summaryMessageId = createMessageId();
      const summaryMessageContent = buildCompactSummaryMessage(persistedSummary, {
        suppressFollowup: true,
      });
      // Continue 没有对应 Session message；无 store 的统计也不能把它计入保留记录。
      const recordablePreservedEntries = filterOutputTokenContinuationEntries(preservedEntries);
      const preservation = this.sessionStore
        ? await selectPersistedCompactTail({
            sessionStore: this.sessionStore,
            sessionId: this.sessionId,
            groupsPreserved: currentSelection.groupsPreserved,
            summaryMessageId,
          })
        : { keptMessageCount: countCompactPreservedRuntimeMessages(recordablePreservedEntries) };
      const postCompactEntries = buildPostCompactRuntimeEntries(
        activeEntries,
        {
          message: {
            role: "user",
            content: summaryMessageContent,
          },
          metadata: legacySyntheticRuntimeMetadata(),
        },
        {
          postCompactReminderEntries,
          preservedEntries,
        },
      );
      const truePostCompactTokenCount = estimateRuntimeEntryTokens(postCompactEntries, {
        useMidConversationSystem,
      });
      const providerPostCompactTokenCount = getUsageTotalTokens(result.usage);
      const compactBoundary = buildManualCompactBoundary({
        boundaryId: createCompactBoundaryId(),
        autoCompactThreshold: options.autoCompactThreshold,
        compactReason,
        customInstructions,
        lastSummarizedMessageId,
        phase,
        postCompactTokenCount: providerPostCompactTokenCount,
        preCompactTokenCount,
        summarizedMessageCount: entriesToSummarize.length,
        summaryMessageId,
        traceContext: turnTraceContext,
        trigger,
        ...(currentSelection.groupsPreserved > 0
          ? {
              keptMessageCount: preservation.keptMessageCount,
            }
          : {}),
        preservedSegment: preservation.preservedSegment,
        truePostCompactTokenCount,
        willRetriggerNextTurn:
          options.autoCompactThreshold !== undefined
            ? truePostCompactTokenCount >= options.autoCompactThreshold
            : undefined,
      });

      await this.persistCompactSummary(
        summaryMessageId,
        summaryMessageContent,
        persistedSummary,
        compactBoundary,
        modelTraceContext,
        {
          model: compactModel,
          operationId: compactTimeline.operationId,
          postCompactReminderEntries,
        },
      );

      const compactBoundaryEvent = this.createEvent(
        SessionEventType.CompactBoundary,
        compactBoundary,
        turnTraceContext,
      );
      await this.appendEvent(compactBoundaryEvent, turnTraceContext);
      events.push(compactBoundaryEvent);

      const compactCompletedPayload = this.buildCompactTimelinePayload(compactTimeline, {
        ...(maxAttempts > 1 ? { attempt, maxAttempts } : {}),
        boundaryId: compactBoundary.boundaryId,
        endedAt: Date.now(),
        postCompactTokenCount: providerPostCompactTokenCount,
        replace: true,
        status: CompactTimelineStatus.Completed,
        summaryMessageId,
        tailStartMessageId: lastSummarizedMessageId,
        truePostCompactTokenCount,
      });
      await persistCompactTimelineEvent(
        this,
        SessionEventType.CompactCompleted,
        compactCompletedPayload,
        turnTraceContext,
        events,
      );

      this.latestConversationMessageId = summaryMessageId;
      const recordablePostCompactEntries = filterOutputTokenContinuationEntries(postCompactEntries);
      this.messageHistory.replaceMessages(
        options.activeEntries
          ? preserveCanonicalContextPrefix(
              this.messageHistory.borrowReadOnlyRuntimeEntries(),
              recordablePostCompactEntries,
            )
          : recordablePostCompactEntries,
      );
      this.readFileState.clear();
      resetProjectMemoryRecall(this);

      return {
        displayText: "Compacted",
        entries: postCompactEntries,
        outcome: "compacted",
        tokenCount: providerPostCompactTokenCount,
      };
    } catch (error) {
      if (
        trigger === CompactTrigger.Auto &&
        attempt < maxAttempts &&
        !isTurnCancellationError(error, options.abortSignal) &&
        isAutoCompactRetryableError(error)
      ) {
        attempt += 1;
        const retryPayload = this.buildCompactTimelinePayload(compactTimeline, {
          attempt,
          maxAttempts,
          reason: compactFailureReasonFromError(error),
          status: CompactTimelineStatus.Retrying,
        });
        // 自动 compact 的中间失败不能提前落成 failed 横线。
        // 这里在同一个 operation 上发 retrying，直到第 3 次仍失败才写最终 failed。
        await persistCompactTimelineEvent(
          this,
          SessionEventType.CompactStarted,
          retryPayload,
          turnTraceContext,
          events,
        );
        this.logger?.warn("Auto compact retrying", {
          ...traceContextToLogContext(turnTraceContext),
          attempt,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "compact.auto.retrying",
          maxAttempts,
          module: "core.runtime",
          timelineStatus: CompactTimelineStatus.Retrying,
        });
        currentSelection = initialSelection;
        preservedEntries = currentSelection.preservedEntries;
        entriesForSummary = initialEntriesForSummary;
        entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
        continue;
      }
      await this.finishCompactTimelineFailure({
        abortSignal: options.abortSignal,
        attempt,
        error,
        events,
        maxAttempts: maxAttempts > 1 ? maxAttempts : undefined,
        timeline: compactTimeline,
        traceContext: turnTraceContext,
      });
      throw error;
    }
  }
}

function isAutoCompactRetryableError(error: unknown): boolean {
  return isCoreError(error) ? error.retryable : true;
}

function canUseCompactSummaryTruncationFallback(trigger: CompactTrigger): boolean {
  return trigger !== CompactTrigger.Auto && trigger !== CompactTrigger.Reactive;
}

function selectInitialCompactEntriesForActiveConversation(input: {
  activeEntries: readonly RuntimeMessageEntry[];
  initialPromptTooLongCause?: unknown;
  trigger: CompactTrigger;
  useMidConversationSystem?: boolean;
}) {
  const baseSelection = selectCompactEntries({
    entries: input.activeEntries,
    trigger: input.trigger,
  });
  if (input.initialPromptTooLongCause === undefined) {
    return baseSelection;
  }

  return (
    selectCompactEntriesForInitialPromptTooLong({
      entries: input.activeEntries,
      promptTooLongCause: input.initialPromptTooLongCause,
      trigger: input.trigger,
      useMidConversationSystem: input.useMidConversationSystem,
    }) ?? baseSelection
  );
}

function capCompactSummaryMaxOutputTokens(model: Model): number {
  // Compact 是独立执行链，在这里显式选择模型上限与 summary 20K 上限中的较小值。
  const desired = Math.min(
    resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: model.optionSpecs.maxOutputTokens.max,
    }),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  );
  return Math.min(desired, model.optionSpecs.maxOutputTokens.max);
}
