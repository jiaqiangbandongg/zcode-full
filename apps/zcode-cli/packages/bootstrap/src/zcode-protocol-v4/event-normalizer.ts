import type {
  BackgroundResultOriginMeta,
  HighspeedMessageMetadata,
  ModelStreamingPayload,
  SessionEvent,
  SyntheticUserMessageSource,
  TurnAttachmentMeta,
  TurnInputIntentMetadata,
  TurnStartedPayload,
  WorkflowLaunchMeta,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";

export type CanonicalConversationVisibility = "visible" | "modelOnly" | "stateOnly";
export type CanonicalConversationOrigin =
  | "realUser"
  | "backgroundResult"
  | "goalContinuation"
  | "mailbox"
  | "synthetic"
  | "workflowLaunch"
  | "assistant"
  | "system";

export interface CanonicalConversationPlacement {
  lane: "trigger" | "assistantWork" | "stateOnly";
  relation: "withinProductTurn" | "none";
}

export interface ConversationNormalizationDiagnostic {
  code:
    | "normalizer.user.missingTranscriptMessageId"
    | "normalizer.assistant.missingTranscriptMessageId";
  eventId: string;
}

interface CanonicalConversationFactBase {
  event: SessionEvent;
  entityId: string;
  productTurnId: string;
  runtimeTurnId: string;
  transcriptMessageId: string | null;
  visibility: CanonicalConversationVisibility;
  origin: CanonicalConversationOrigin;
  placement: CanonicalConversationPlacement;
  diagnostics: readonly ConversationNormalizationDiagnostic[];
}

export interface CanonicalUserIntentFact extends CanonicalConversationFactBase {
  inputOrigin?: "desktop" | "mobile";
  conversationQuotes?: import("@zcode/contracts").TurnInputIntentMetadata["conversationQuotes"];
  botGroupSource?: import("@zcode/shared").BotGroupInputSource;
  semanticKind: "userIntent";
  visibility: "visible" | "modelOnly";
  origin:
    | "realUser"
    | "backgroundResult"
    | "goalContinuation"
    | "mailbox"
    | "synthetic"
    | "workflowLaunch";
  input: string;
  intentText: string;
  intentKind: "sendText" | "sendGoalCommand";
  turnNumber: number;
  executionKind: "agent" | "controlOnly";
  turnHeaderOrigin:
    | "userInput"
    | "backgroundResult"
    | "goalContinuation"
    | "editRerun"
    | "workflowLaunch";
  originMeta?: BackgroundResultOriginMeta;
  /**
   * 中枢直接启动已保存工作流的启动轮元数据（`inputSource === "workflow_launch"` 时在场）。
   * 活投影据它在 turnHeader / userInput 两行上画启动卡；与消息 metadata 里的同一份对齐（冷热同形）。
   */
  workflowLaunch?: WorkflowLaunchMeta;
  /** `input` 从此下标起是引擎附加文本。 */
  epilogueStart?: number;
  sourceCommandId?: string;
  foregroundExecutionId?: string;
  clientId?: string;
  highspeed?: HighspeedMessageMetadata;
  attachments?: readonly CanonicalTurnAttachment[];
  queueItemId?: string;
  admissionSeq?: number;
  admittedAt?: number;
  requestedDelivery?: "auto" | "startNow" | "queue" | "guide";
  admittedDelivery?: "startNow" | "queue" | "guide";
  sharedContextRefs?: readonly { kind: "shared_context_import"; context_id: string }[];
  fallbackReasonCode?: string;
  modelSelection?: TurnInputIntentMetadata["modelSelection"];
  mode?: TurnInputIntentMetadata["mode"];
  planEnabled?: boolean;
  provenance?: {
    sourceCommandId: string;
    queueItemId?: string;
    clientId?: string;
  };
  source?: TurnInputIntentMetadata["source"];
}

export interface CanonicalTurnAttachment extends Omit<AttachmentRef, "ref"> {
  ref?: string;
}

export interface CanonicalModelStream {
  kind: ModelStreamingPayload["kind"];
  delta: string;
  done: boolean;
  assistantResponseId?: string;
  transcriptPartId?: string;
  toolCallId?: ModelStreamingPayload["toolCallId"];
  toolName?: string;
  input?: unknown;
  providerExecuted?: boolean;
}

export interface CanonicalAssistantSegmentFact extends CanonicalConversationFactBase {
  semanticKind: "assistantSegment";
  visibility: "visible";
  origin: "assistant";
  stream: CanonicalModelStream;
}

export interface CanonicalPassthroughFact extends CanonicalConversationFactBase {
  semanticKind: "passthrough";
  sourceCommandId?: string;
}

export type CanonicalConversationFact =
  | CanonicalUserIntentFact
  | CanonicalAssistantSegmentFact
  | CanonicalPassthroughFact;

export interface NormalizeConversationEventContext {
  productTurnId?: string;
  openAssistantSegments?: Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>>;
}

export interface CanonicalOpenSegmentIdentity {
  entityId: string;
  transcriptMessageId: string | null;
}

/**
 * live SessionEvent 与 cold hydration 合成事件的唯一字段解释入口。
 *
 * 过去 ProductProjection 直接从 raw payload 分别猜 messageId、origin 与
 * visibility；cold 少一个字段时可见 row 仍会生成，但命令 target 缺失。normalizer
 * 先生成自包含 canonical fact，让 row、target、actions 使用同一份身份事实。
 */
export function normalizeConversationEvent(
  event: SessionEvent,
  context: NormalizeConversationEventContext = {},
): CanonicalConversationFact {
  const runtimeTurnId = runtimeTurnIdOf(event);
  const productTurnId = context.productTurnId ?? runtimeTurnId;
  if (event.type === SessionEventType.TurnStarted) {
    return normalizeTurnStarted(event, event.payload as TurnStartedPayload, {
      runtimeTurnId,
      productTurnId,
    });
  }
  if (event.type === SessionEventType.ModelStreaming) {
    return normalizeModelStreaming(event, event.payload as ModelStreamingPayload, {
      runtimeTurnId,
      productTurnId,
      openAssistantSegments: context.openAssistantSegments,
    });
  }
  if (
    event.type === SessionEventType.CompactStarted ||
    event.type === SessionEventType.CompactCompleted ||
    event.type === SessionEventType.CompactFailed
  ) {
    const payload = event.payload as Record<string, unknown>;
    const operationId =
      typeof payload.operationId === "string" && payload.operationId.length > 0
        ? payload.operationId
        : String(event.id);
    const transcriptMessageId =
      typeof payload.messageId === "string" && payload.messageId.length > 0
        ? payload.messageId
        : null;
    return {
      semanticKind: "passthrough",
      event,
      entityId: operationId,
      productTurnId,
      runtimeTurnId,
      transcriptMessageId,
      visibility: "visible",
      origin: "system",
      placement: { lane: "assistantWork", relation: "withinProductTurn" },
      diagnostics: [],
      ...(typeof payload.sourceCommandId === "string"
        ? { sourceCommandId: payload.sourceCommandId }
        : {}),
    };
  }
  return {
    semanticKind: "passthrough",
    event,
    entityId: String(event.id),
    productTurnId,
    runtimeTurnId,
    transcriptMessageId: null,
    visibility: "stateOnly",
    origin: "system",
    placement: { lane: "stateOnly", relation: "none" },
    diagnostics: [],
  };
}

function normalizeTurnStarted(
  event: SessionEvent,
  payload: TurnStartedPayload,
  ids: { runtimeTurnId: string; productTurnId: string },
): CanonicalUserIntentFact {
  const transcriptMessageId = payload.messageId ? String(payload.messageId) : null;
  const origin = userInputOrigin(payload.inputSource);
  // live 使用 runtime turnId、cold 使用 hydrate-turn-N；即使二者指向
  // 同一条持久 user message，过去仍生成不同 productTurnId，导致行分组与命令边界
  // 在恢复前后漂移。真实用户轮以持久 user messageId 作为稳定 product turn 身份；
  // legacy 缺 messageId 时才保留 runtime fallback，并通过 diagnostics 暴露降级。
  // 可见 user、goal continuation、background wake 都是 product-turn trigger；
  // 只要有持久 messageId 就必须共用它，不能只稳定 realUser。
  const productTurnId = transcriptMessageId ?? ids.productTurnId;
  const diagnostics: ConversationNormalizationDiagnostic[] = transcriptMessageId
    ? []
    : [
        {
          code: "normalizer.user.missingTranscriptMessageId",
          eventId: String(event.id),
        },
      ];
  return {
    semanticKind: "userIntent",
    event,
    entityId:
      transcriptMessageId ??
      `legacy:user:${String(event.sessionId)}:${ids.runtimeTurnId}:${String(event.id)}`,
    productTurnId,
    runtimeTurnId: ids.runtimeTurnId,
    transcriptMessageId,
    visibility: payload.inputVisibility === "model-only" ? "modelOnly" : "visible",
    origin,
    placement: { lane: "trigger", relation: "withinProductTurn" },
    diagnostics,
    input: payload.input,
    intentText: payload.intent?.text ?? payload.input,
    intentKind: payload.intent?.kind === "sendGoalCommand" ? "sendGoalCommand" : "sendText",
    turnNumber: payload.turnNumber,
    executionKind: payload.executionKind ?? "agent",
    turnHeaderOrigin: turnHeaderOrigin(payload.inputSource),
    ...(payload.originMeta ? { originMeta: payload.originMeta } : {}),
    ...(payload.workflowLaunch ? { workflowLaunch: payload.workflowLaunch } : {}),
    ...(payload.epilogueStart === undefined ? {} : { epilogueStart: payload.epilogueStart }),
    ...((payload.intent?.sourceCommandId ?? payload.inputId)
      ? { sourceCommandId: payload.intent?.sourceCommandId ?? payload.inputId }
      : {}),
    ...(payload.foregroundExecutionId
      ? { foregroundExecutionId: payload.foregroundExecutionId }
      : {}),
    ...(payload.intent?.clientId ? { clientId: payload.intent.clientId } : {}),
    ...(payload.intent?.highspeed ? { highspeed: payload.intent.highspeed } : {}),
    ...(payload.intent?.queueItemId ? { queueItemId: payload.intent.queueItemId } : {}),
    ...(payload.intent?.admissionSeq !== undefined
      ? { admissionSeq: payload.intent.admissionSeq }
      : {}),
    ...(payload.intent?.admittedAt !== undefined ? { admittedAt: payload.intent.admittedAt } : {}),
    ...(payload.intent?.requestedDelivery
      ? { requestedDelivery: payload.intent.requestedDelivery }
      : {}),
    ...(payload.intent?.admittedDelivery
      ? { admittedDelivery: payload.intent.admittedDelivery }
      : {}),
    ...(payload.intent?.sharedContextRefs
      ? { sharedContextRefs: payload.intent.sharedContextRefs }
      : {}),
    ...(payload.intent?.fallbackReasonCode
      ? { fallbackReasonCode: payload.intent.fallbackReasonCode }
      : {}),
    ...(payload.intent?.modelSelection ? { modelSelection: payload.intent.modelSelection } : {}),
    ...(payload.intent?.mode ? { mode: payload.intent.mode } : {}),
    ...(payload.intent?.planEnabled !== undefined
      ? { planEnabled: payload.intent.planEnabled }
      : {}),
    ...(payload.intent?.inputOrigin ? { inputOrigin: payload.intent.inputOrigin } : {}),
    ...(payload.intent?.conversationQuotes
      ? { conversationQuotes: payload.intent.conversationQuotes }
      : {}),
    ...(payload.intent?.botGroupSource ? { botGroupSource: payload.intent.botGroupSource } : {}),
    ...(payload.intent?.provenance ? { provenance: payload.intent.provenance } : {}),
    ...(payload.intent?.source ? { source: payload.intent.source } : {}),
    ...normalizeAttachments(payload),
  };
}

function normalizeModelStreaming(
  event: SessionEvent,
  payload: ModelStreamingPayload,
  ids: {
    runtimeTurnId: string;
    productTurnId: string;
    openAssistantSegments: NormalizeConversationEventContext["openAssistantSegments"];
  },
): CanonicalAssistantSegmentFact {
  const lane = assistantStreamLane(payload.kind);
  const openSegment =
    lane === "text" || lane === "reasoning" ? ids.openAssistantSegments?.[lane] : undefined;
  const inheritsOpenSegment = !isAssistantStreamStart(payload.kind);
  const inheritedSegment = inheritsOpenSegment ? openSegment : undefined;
  const transcriptMessageId = payload.assistantMessageId
    ? String(payload.assistantMessageId)
    : (inheritedSegment?.transcriptMessageId ?? null);
  const identityRequired =
    payload.kind === "text_start" || (payload.kind === "text_delta" && !transcriptMessageId);
  const diagnostics: ConversationNormalizationDiagnostic[] =
    identityRequired && !transcriptMessageId
      ? [
          {
            code: "normalizer.assistant.missingTranscriptMessageId",
            eventId: String(event.id),
          },
        ]
      : [];
  const transcriptPartId = payload.partId ? String(payload.partId) : undefined;
  const toolEntityId = payload.toolCallId ? String(payload.toolCallId) : undefined;
  const intrinsicEntityId =
    lane === "tool" ? (toolEntityId ?? transcriptPartId) : (transcriptPartId ?? toolEntityId);
  return {
    semanticKind: "assistantSegment",
    event,
    entityId:
      transcriptMessageId ??
      inheritedSegment?.entityId ??
      intrinsicEntityId ??
      `legacy:assistant:${String(event.sessionId)}:${ids.runtimeTurnId}:${transcriptPartId ?? String(event.id)}`,
    productTurnId: ids.productTurnId,
    runtimeTurnId: ids.runtimeTurnId,
    transcriptMessageId,
    visibility: "visible",
    origin: "assistant",
    placement: { lane: "assistantWork", relation: "withinProductTurn" },
    diagnostics,
    stream: {
      kind: payload.kind,
      delta: payload.delta,
      done: payload.done,
      ...(transcriptMessageId ? { assistantResponseId: transcriptMessageId } : {}),
      ...(transcriptPartId ? { transcriptPartId } : {}),
      ...(payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
      // 空字符串是空工具名恢复的有效原始事实；truthy 判断会把它抹成
      // undefined，导致后续产品态过滤误把该调用物化成一个空名工具行。
      ...(typeof payload.toolName === "string" ? { toolName: payload.toolName } : {}),
      ...(payload.input !== undefined ? { input: payload.input } : {}),
      ...(payload.providerExecuted !== undefined
        ? { providerExecuted: payload.providerExecuted }
        : {}),
    },
  };
}

function assistantStreamLane(
  kind: ModelStreamingPayload["kind"],
): "text" | "reasoning" | "tool" | "other" {
  if (kind?.startsWith("text_")) return "text";
  if (kind?.startsWith("reasoning_")) return "reasoning";
  if (kind?.startsWith("tool_") || kind === "tool_call") return "tool";
  return "other";
}

function isAssistantStreamStart(kind: ModelStreamingPayload["kind"]): boolean {
  return kind === "text_start" || kind === "reasoning_start" || kind === "tool_input_start";
}

function runtimeTurnIdOf(event: SessionEvent): string {
  if (event.turnId) return String(event.turnId);
  if (event.type === SessionEventType.TurnStarted) {
    const payload = event.payload as TurnStartedPayload;
    return `turn-${payload.turnNumber}`;
  }
  return "turn-unknown";
}

function normalizeAttachments(payload: TurnStartedPayload): {
  attachments?: readonly CanonicalTurnAttachment[];
} {
  if (payload.intent?.attachmentRefs && payload.intent.attachmentRefs.length > 0) {
    return { attachments: payload.intent.attachmentRefs.map((attachment) => ({ ...attachment })) };
  }
  if (!payload.attachments || payload.attachments.length === 0) return {};
  return { attachments: payload.attachments.map(normalizeAttachment) };
}

function normalizeAttachment(attachment: TurnAttachmentMeta): CanonicalTurnAttachment {
  return {
    ...(attachment.ref ? { ref: attachment.ref } : {}),
    fileName: attachment.fileName,
    mime: attachment.mime,
    bytes: attachment.bytes,
  };
}

function turnHeaderOrigin(
  source: SyntheticUserMessageSource | undefined,
): CanonicalUserIntentFact["turnHeaderOrigin"] {
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "rewind":
      return "editRerun";
    // 中枢直接启动：turnHeader 与 userInput 同用 workflowLaunch origin，UI 据此画启动卡而非用户气泡。
    case "workflow_launch":
      return "workflowLaunch";
    default:
      return "userInput";
  }
}

function userInputOrigin(
  source: SyntheticUserMessageSource | undefined,
): CanonicalUserIntentFact["origin"] {
  switch (source) {
    case "background_task":
      return "backgroundResult";
    case "goal-continuation":
      return "goalContinuation";
    case "subagent":
    case "subagent_message":
      // child 回复是 mailbox runtime carrier，不是真实用户输入；
      // live/cold 即使都隐藏它，也必须保留相同 canonical origin。
      return "mailbox";
    case "fork":
    case "plugin_reference":
    case "rewind":
    case "todo_reminder":
      return "synthetic";
    // 中枢直接启动：用户在中枢里的真实动作，可见 user row 但以启动卡呈现（origin 区分它与普通气泡）。
    case "workflow_launch":
      return "workflowLaunch";
    default:
      return "realUser";
  }
}
