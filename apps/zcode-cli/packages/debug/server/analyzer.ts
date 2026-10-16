import { basename } from "node:path";
import type {
  CacheReport,
  CacheSegment,
  ContextSectionSource,
  ContextSectionView,
  ContextSnapshotView,
  ContextUsageCategory,
  ContextUsageMessageBreakdown,
  ContextUsageSkillDetail,
  ContextUsageSnapshotView,
  ContextUsageToolDetail,
  DeveloperRequest,
  ProjectSummary,
  SourceStatus,
  TokenConfidence,
  TokenMethod,
  TimelineItem,
  TraceDetailResponse,
  TraceSpan,
  TraceSpanLane,
  TraceSpanStatus,
  TraceListResponse,
  TraceSummary,
} from "../src/shared.js";
import {
  isRecord,
  loadEventLog,
  loadLogs,
  loadSqlite,
  numberValue,
  stringValue,
} from "./sources.js";
import type {
  DbMessageRecord,
  DbObservation,
  DbPartRecord,
  EventRecord,
  LoadedObservation,
  LogRecord,
  ObservationOptions,
  SourceLoadResult,
} from "./types.js";

const DEFAULT_TRACE_LIMIT = 10;

type TraceSummaryDraft = TraceSummary & {
  firstUserMessageAt?: string;
};

export async function listTraces(options: ObservationOptions = {}): Promise<TraceListResponse> {
  const observation = await loadObservation(options);
  return {
    sources: sourceStatuses(observation),
    projects: buildProjectSummaries(observation.db.records[0]),
    traces: buildTraceSummaries(
      observation,
      options.limit ?? DEFAULT_TRACE_LIMIT,
      options.projectId,
    ),
  };
}

export async function inspectTrace(
  traceId: string,
  options: ObservationOptions = {},
): Promise<TraceDetailResponse> {
  const observation = await loadObservation({ ...options, traceId });
  const sessions = collectSessionsForTrace(traceId, observation, options.sessionId);
  const timeline = buildTimeline(traceId, sessions, observation);
  const spans = buildTraceSpans(traceId, sessions, observation);
  const contextSnapshots = buildContextSnapshots(traceId, observation);
  const contextUsageSnapshots = buildContextUsageSnapshots(traceId, sessions, observation);
  const cacheReports = buildCacheReports(traceId, sessions, observation);

  return {
    traceId,
    sessions: [...sessions].sort(),
    sources: sourceStatuses(observation),
    timeline,
    spans,
    contextSnapshots,
    contextUsageSnapshots,
    cacheReports,
    developerRequests: buildDeveloperRequests(observation, contextSnapshots, cacheReports),
  };
}

async function loadObservation(options: ObservationOptions): Promise<LoadedObservation> {
  const [logs, events] = await Promise.all([loadLogs(options), loadEventLog(options)]);
  return {
    logs,
    events,
    db: loadSqlite(options),
  };
}

function sourceStatuses(observation: LoadedObservation): SourceStatus[] {
  return [
    toSourceStatus(observation.logs),
    toSourceStatus(observation.events),
    toSourceStatus(observation.db),
  ];
}

function toSourceStatus<TRecord>(source: SourceLoadResult<TRecord>): SourceStatus {
  return {
    kind: source.kind,
    label: source.label,
    path: source.path,
    available: source.records.length > 0,
    recordCount: source.records.length,
    warning: source.warning,
  };
}

function buildTraceSummaries(
  observation: LoadedObservation,
  limit: number,
  projectId?: string,
): TraceSummary[] {
  const summaries = new Map<string, TraceSummaryDraft>();
  const allowedSessionIds = projectId
    ? sessionIdsForProject(observation.db.records[0], projectId)
    : undefined;

  for (const log of observation.logs.records) {
    if (!log.traceId) continue;
    const summary = ensureTraceSummary(summaries, log.traceId);
    summary.logCount += 1;
    addSession(summary, log.sessionId);
    addTime(summary, log.timestamp);
    summary.lastMessage = log.message ?? log.event ?? summary.lastMessage;
  }

  for (const event of observation.events.records) {
    if (!event.traceId) continue;
    const summary = ensureTraceSummary(summaries, event.traceId);
    summary.eventCount += 1;
    addSession(summary, event.sessionId);
    addTime(summary, event.timestamp);
    summary.lastMessage = event.type;
    recordFirstUserMessage(summary, firstUserMessageFromEvent(event), event.timestamp);
    const usage = extractUsage(event.payload);
    summary.cacheReadTokens += usage.cacheReadTokens;
    summary.cacheWriteTokens += usage.cacheWriteTokens;
  }

  enrichTraceSummariesFromDbMessages(summaries, observation.db.records[0]);

  return [...summaries.values()]
    .filter((summary) => {
      if (!allowedSessionIds) return true;
      return summary.sessionIds.some((sessionId) => allowedSessionIds.has(sessionId));
    })
    .sort((left, right) => compareIsoDesc(left.lastAt, right.lastAt))
    .slice(0, limit)
    .map(toTraceSummary);
}

function buildProjectSummaries(db?: DbObservation): ProjectSummary[] {
  if (!db) return [];
  const byProject = new Map<string, ProjectSummary>();

  for (const session of db.sessions) {
    const existing = byProject.get(session.projectId);
    if (!existing) {
      byProject.set(session.projectId, {
        projectId: session.projectId,
        label: projectLabel(session.directory),
        directory: session.directory,
        sessionCount: 1,
        updatedAt: session.updatedAt,
      });
      continue;
    }

    existing.sessionCount += 1;
    if (!existing.updatedAt || (session.updatedAt && session.updatedAt > existing.updatedAt)) {
      existing.updatedAt = session.updatedAt;
      existing.directory = session.directory;
      existing.label = projectLabel(session.directory);
    }
  }

  return [...byProject.values()].sort((left, right) =>
    compareIsoDesc(left.updatedAt, right.updatedAt),
  );
}

function sessionIdsForProject(db: DbObservation | undefined, projectId: string): Set<string> {
  const ids = new Set<string>();
  for (const session of db?.sessions ?? []) {
    if (session.projectId === projectId) ids.add(session.id);
  }
  return ids;
}

function projectLabel(directory: string): string {
  return basename(directory) || directory || "未命名项目";
}

function ensureTraceSummary(
  summaries: Map<string, TraceSummaryDraft>,
  traceId: string,
): TraceSummaryDraft {
  const existing = summaries.get(traceId);
  if (existing) return existing;
  const summary: TraceSummary = {
    traceId,
    sessionIds: [],
    eventCount: 0,
    logCount: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  summaries.set(traceId, summary);
  return summary;
}

function enrichTraceSummariesFromDbMessages(
  summaries: Map<string, TraceSummaryDraft>,
  db?: DbObservation,
): void {
  if (!db || summaries.size === 0) return;
  const bySessionId = new Map<string, TraceSummaryDraft[]>();
  const partsByMessageId = groupPartsByMessageId(db.parts);
  for (const summary of summaries.values()) {
    for (const sessionId of summary.sessionIds) {
      const existing = bySessionId.get(sessionId);
      if (existing) {
        existing.push(summary);
      } else {
        bySessionId.set(sessionId, [summary]);
      }
    }
  }

  for (const message of db.messages) {
    if (message.role !== "user") continue;
    const matchedSummaries = bySessionId.get(message.sessionId);
    if (!matchedSummaries) continue;
    const text = textFromDbMessage(message) ?? textFromDbParts(partsByMessageId.get(message.id));
    for (const summary of matchedSummaries) {
      recordFirstUserMessage(summary, text, message.createdAt);
    }
  }
}

function groupPartsByMessageId(parts: DbPartRecord[]): Map<string, DbPartRecord[]> {
  const byMessageId = new Map<string, DbPartRecord[]>();
  for (const part of parts) {
    const existing = byMessageId.get(part.messageId);
    if (existing) {
      existing.push(part);
    } else {
      byMessageId.set(part.messageId, [part]);
    }
  }
  return byMessageId;
}

function recordFirstUserMessage(
  summary: TraceSummaryDraft,
  text: string | undefined,
  at?: string,
): void {
  const normalized = text ? preview(text, 120) : undefined;
  if (!normalized) return;
  if (summary.firstUserMessageAt) {
    if (!at || compareIsoAsc(summary.firstUserMessageAt, at) <= 0) return;
  } else if (summary.firstUserMessage && !at) {
    return;
  }

  summary.firstUserMessage = normalized;
  summary.firstUserMessageAt = at;
}

function toTraceSummary(summary: TraceSummaryDraft): TraceSummary {
  return {
    traceId: summary.traceId,
    sessionIds: summary.sessionIds,
    eventCount: summary.eventCount,
    logCount: summary.logCount,
    firstAt: summary.firstAt,
    lastAt: summary.lastAt,
    firstUserMessage: summary.firstUserMessage,
    lastMessage: summary.lastMessage,
    cacheReadTokens: summary.cacheReadTokens,
    cacheWriteTokens: summary.cacheWriteTokens,
  };
}

function addSession(summary: TraceSummary, sessionId?: string): void {
  if (sessionId && !summary.sessionIds.includes(sessionId)) {
    summary.sessionIds.push(sessionId);
  }
}

function addTime(summary: TraceSummary, at?: string): void {
  if (!at) return;
  if (!summary.firstAt || at < summary.firstAt) summary.firstAt = at;
  if (!summary.lastAt || at > summary.lastAt) summary.lastAt = at;
}

function collectSessionsForTrace(
  traceId: string,
  observation: LoadedObservation,
  explicitSessionId?: string,
): Set<string> {
  const sessions = new Set<string>();
  if (explicitSessionId) sessions.add(explicitSessionId);
  if (traceId.startsWith("session:")) sessions.add(traceId.slice("session:".length));

  for (const log of observation.logs.records) {
    if (log.traceId === traceId && log.sessionId) sessions.add(log.sessionId);
  }
  for (const event of observation.events.records) {
    if (event.traceId === traceId && event.sessionId) sessions.add(event.sessionId);
  }

  return sessions;
}

function buildTimeline(
  traceId: string,
  sessions: Set<string>,
  observation: LoadedObservation,
): TimelineItem[] {
  const items: TimelineItem[] = [];

  for (const log of observation.logs.records) {
    if (log.traceId !== traceId) continue;
    items.push(timelineFromLog(log));
  }

  for (const event of observation.events.records) {
    if (event.traceId !== traceId) continue;
    items.push(timelineFromEvent(event));
  }

  const db = observation.db.records[0];
  if (db && sessions.size > 0) {
    for (const message of db.messages) {
      if (sessions.has(message.sessionId)) {
        items.push(timelineFromDbMessage(message));
      }
    }
    for (const part of db.parts) {
      if (sessions.has(part.sessionId)) {
        items.push(timelineFromDbPart(part));
      }
    }
  }

  return items.sort((left, right) => compareIsoDesc(left.at, right.at));
}

function timelineFromLog(log: LogRecord): TimelineItem {
  const label = log.event ?? log.message ?? "log";
  return {
    id: `log:${log.sourcePath}:${log.line}`,
    at: log.timestamp,
    source: "log",
    kind: log.event ?? "log",
    label,
    severity: normalizeLogLevel(log.level),
    traceId: log.traceId,
    sessionId: log.sessionId,
    turnId: log.turnId,
    spanId: log.spanId,
    parentSpanId: log.parentSpanId,
    toolCallId: log.toolCallId,
    summary: log.message ?? log.event ?? "结构化日志条目",
    payload: log.context ?? log.error,
  };
}

function timelineFromEvent(event: EventRecord): TimelineItem {
  return {
    id: `event:${event.id}`,
    at: event.timestamp,
    source: "eventlog",
    kind: event.type,
    label: event.type,
    traceId: event.traceId,
    sessionId: event.sessionId,
    turnId: event.turnId,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    toolCallId: eventToolCallId(event.payload),
    summary: summarizeEvent(event),
    payload: event.payload,
  };
}

function timelineFromDbMessage(message: DbMessageRecord): TimelineItem {
  return {
    id: `sqlite:message:${message.id}`,
    at: message.createdAt,
    source: "sqlite",
    kind: "message",
    label: `${formatRole(message.role)}消息`,
    sessionId: message.sessionId,
    summary: summarizeDbMessage(message),
    payload: message.data,
  };
}

function timelineFromDbPart(part: DbPartRecord): TimelineItem {
  return {
    id: `sqlite:part:${part.id}`,
    at: part.createdAt,
    source: "sqlite",
    kind: `part:${part.type ?? "unknown"}`,
    label: `${part.type ?? "未知"} 片段`,
    sessionId: part.sessionId,
    summary: summarizeDbPart(part),
    payload: part.data,
  };
}

function buildTraceSpans(
  traceId: string,
  _sessions: Set<string>,
  observation: LoadedObservation,
): TraceSpan[] {
  const spans: TraceSpan[] = [];
  const traceEvents = observation.events.records
    .filter((event) => event.traceId === traceId)
    .sort((left, right) => compareIsoAsc(left.timestamp, right.timestamp));

  spans.push(
    ...spansFromEventPairs(traceEvents, {
      lane: "turn",
      startType: "turn_started",
      endTypes: ["turn_complete", "turn_error"],
      label: (event) => `Turn ${event.turnId ?? event.sessionId ?? event.id}`,
      match: matchTurnEvents,
    }),
    ...spansFromEventPairs(traceEvents, {
      lane: "model",
      startType: "model_request",
      endTypes: ["model_complete", "model_error"],
      label: (event) => modelName(event.payload) ?? "模型请求",
      match: matchModelEvents,
    }),
    ...spansFromEventPairs(traceEvents, {
      lane: "tool",
      startType: "tool_call_started",
      endTypes: ["tool_call_result", "tool_call_error"],
      label: (event) =>
        eventToolName(event.payload) ?? eventToolCallId(event.payload) ?? "工具调用",
      match: matchToolEvents,
    }),
    ...spansFromEventPairs(traceEvents, {
      lane: "permission",
      startType: "permission_requested",
      endTypes: ["permission_resolved", "permission_denied"],
      label: (event) =>
        eventToolName(event.payload) ?? eventToolCallId(event.payload) ?? "权限请求",
      match: matchPermissionEvents,
    }),
    ...spansFromEventPairs(traceEvents, {
      lane: "subagent",
      startType: "subagent_spawned",
      endTypes: ["subagent_stopped"],
      label: (event) => subagentLabel(event),
      match: matchSubagentEvents,
    }),
  );

  for (const log of observation.logs.records) {
    if (log.traceId !== traceId) continue;
    const span = spanFromLog(log);
    if (span) spans.push(span);
  }

  return spans.sort((left, right) => compareIsoAsc(left.startAt, right.startAt));
}

type SpanPairConfig = {
  lane: TraceSpanLane;
  startType: string;
  endTypes: string[];
  label: (event: EventRecord) => string;
  match: (start: EventRecord, end: EventRecord) => boolean;
};

function spansFromEventPairs(events: EventRecord[], config: SpanPairConfig): TraceSpan[] {
  const spans: TraceSpan[] = [];

  for (const start of events) {
    if (start.type !== config.startType || !start.timestamp) continue;
    const end = findMatchingEndEvent(events, start, config.endTypes, config.match);
    spans.push({
      id: `span:event:${start.id}`,
      traceId: start.traceId,
      sessionId: start.sessionId,
      turnId: start.turnId,
      spanId: start.spanId ?? end?.spanId,
      parentSpanId: start.parentSpanId ?? end?.parentSpanId,
      toolCallId: eventToolCallId(start.payload) ?? eventToolCallId(end?.payload),
      lane: config.lane,
      label: config.label(start),
      source: "eventlog",
      startAt: start.timestamp,
      endAt: end?.timestamp,
      status: spanStatusFromEndEvent(end),
      summary: end ? summarizeEvent(end) : summarizeEvent(start),
      payload: {
        start: eventPayloadForSpan(start),
        end: end ? eventPayloadForSpan(end) : undefined,
      },
    });
  }

  return spans;
}

function eventPayloadForSpan(event: EventRecord): Record<string, unknown> {
  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    payload: event.payload,
  };
}

function findMatchingEndEvent(
  events: EventRecord[],
  start: EventRecord,
  endTypes: string[],
  match: (start: EventRecord, end: EventRecord) => boolean,
): EventRecord | undefined {
  const startAt = start.timestamp ?? "";
  return events.find((event) => {
    if (!endTypes.includes(event.type)) return false;
    if (startAt && event.timestamp && event.timestamp < startAt) return false;
    return match(start, event);
  });
}

function matchTurnEvents(start: EventRecord, end: EventRecord): boolean {
  return matchSessionTurn(start, end);
}

function matchModelEvents(start: EventRecord, end: EventRecord): boolean {
  const startId = eventCorrelationId(start.payload, ["modelRequestId", "requestId", "id"]);
  const endId = eventCorrelationId(end.payload, ["modelRequestId", "requestId", "id"]);
  if (startId && endId) return startId === endId;
  return matchSessionTurn(start, end);
}

function matchToolEvents(start: EventRecord, end: EventRecord): boolean {
  const startToolCallId = eventToolCallId(start.payload);
  const endToolCallId = eventToolCallId(end.payload);
  if (startToolCallId && endToolCallId) return startToolCallId === endToolCallId;
  return matchSessionTurn(start, end);
}

function matchPermissionEvents(start: EventRecord, end: EventRecord): boolean {
  const startPermissionId = eventCorrelationId(start.payload, ["permissionId", "requestId"]);
  const endPermissionId = eventCorrelationId(end.payload, ["permissionId", "requestId"]);
  if (startPermissionId && endPermissionId) return startPermissionId === endPermissionId;
  return matchToolEvents(start, end);
}

function matchSubagentEvents(start: EventRecord, end: EventRecord): boolean {
  const startSubagentId = eventCorrelationId(start.payload, [
    "subagentId",
    "subagentSessionId",
    "childSessionId",
    "sessionId",
  ]);
  const endSubagentId = eventCorrelationId(end.payload, [
    "subagentId",
    "subagentSessionId",
    "childSessionId",
    "sessionId",
  ]);
  if (startSubagentId && endSubagentId) return startSubagentId === endSubagentId;
  return matchSessionTurn(start, end);
}

function matchSessionTurn(start: EventRecord, end: EventRecord): boolean {
  if (start.sessionId && end.sessionId && start.sessionId !== end.sessionId) return false;
  if (start.turnId && end.turnId && start.turnId !== end.turnId) return false;
  return true;
}

function eventCorrelationId(
  payload: Record<string, unknown> | undefined,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = stringValue(payload?.[name]);
    if (value) return value;
  }
  return undefined;
}

function spanStatusFromEndEvent(event: EventRecord | undefined): TraceSpanStatus {
  if (!event) return "unknown";
  if (event.type.endsWith("_error") || event.type === "permission_denied") return "error";
  if (event.type.endsWith("_cancelled") || event.type.endsWith("_canceled")) return "cancelled";
  return "ok";
}

function spanFromLog(log: LogRecord): TraceSpan | undefined {
  if (!log.timestamp || log.durationMs === undefined || log.durationMs <= 0) return undefined;
  const lane = spanLaneFromLog(log);
  const endAt = log.timestamp;
  return {
    id: `span:log:${log.sourcePath}:${log.line}`,
    traceId: log.traceId,
    sessionId: log.sessionId,
    turnId: log.turnId,
    spanId: log.spanId,
    parentSpanId: log.parentSpanId,
    toolCallId: log.toolCallId,
    lane,
    label: log.event ?? log.message ?? "结构化日志",
    source: "log",
    startAt: subtractMs(endAt, log.durationMs),
    endAt,
    status: spanStatusFromLog(log),
    summary: log.message ?? log.event,
    payload: log.context ?? log.error,
  };
}

function spanLaneFromLog(log: LogRecord): TraceSpanLane {
  const subject = `${log.event ?? ""} ${log.module ?? ""} ${log.message ?? ""}`.toLowerCase();
  if (subject.includes("tool")) return "tool";
  if (subject.includes("model") || subject.includes("provider")) return "model";
  if (subject.includes("permission") || subject.includes("approval")) return "permission";
  if (subject.includes("subagent")) return "subagent";
  if (subject.includes("network") || subject.includes("http")) return "network";
  if (subject.includes("sqlite") || subject.includes("storage") || subject.includes("cache")) {
    return "storage";
  }
  if (subject.includes("turn")) return "turn";
  return "log";
}

function spanStatusFromLog(log: LogRecord): TraceSpanStatus {
  const normalized = log.status?.toLowerCase();
  if (normalized === "running" || normalized === "pending") return "running";
  if (normalized === "ok" || normalized === "success" || normalized === "completed") return "ok";
  if (normalized === "error" || normalized === "failed" || normalized === "failure") return "error";
  if (normalized === "cancelled" || normalized === "canceled" || normalized === "aborted") {
    return "cancelled";
  }
  if (log.level === "error") return "error";
  return "unknown";
}

function subtractMs(value: string, durationMs: number): string {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return value;
  return new Date(time - durationMs).toISOString();
}

function buildContextSnapshots(
  traceId: string,
  observation: LoadedObservation,
): ContextSnapshotView[] {
  const snapshots: ContextSnapshotView[] = [];

  for (const event of observation.events.records) {
    if (event.traceId !== traceId || event.type !== "model_request") continue;
    const messages = arrayValue(event.payload?.messages).filter(isRecord);
    const systemMessage = messages.find((message) => message.role === "system");
    const systemPrompt = stringValue(systemMessage?.content);
    const sections = systemPrompt
      ? deriveSectionsFromSystemPrompt(systemPrompt)
      : sectionsFromPayload(event.payload);
    snapshots.push(
      finalizeContextSnapshot({
        id: `event:${event.id}:context`,
        at: event.timestamp,
        traceId: event.traceId,
        sessionId: event.sessionId,
        turnId: event.turnId,
        model: modelName(event.payload),
        messageCount: messages.length,
        sections,
        systemPrompt,
        observationLevel: systemPrompt ? "full" : sections.length > 0 ? "metadata" : "inferred",
        warnings: systemPrompt ? [] : ["当前数据源里的 model_request 没有完整 system prompt。"],
      }),
    );
  }

  for (const log of observation.logs.records) {
    if (log.traceId !== traceId || !isContextBuiltLog(log)) continue;
    const sections = sectionsFromContextBuiltLog(log);
    const hasFullContent = sections.some((section) => section.content);
    snapshots.push(
      finalizeContextSnapshot({
        id: `log:${log.sourcePath}:${log.line}:context`,
        at: log.timestamp,
        traceId: log.traceId,
        sessionId: log.sessionId,
        turnId: log.turnId,
        messageCount: 0,
        sections,
        observationLevel: hasFullContent ? "full" : "metadata",
        warnings: hasFullContent
          ? []
          : ["结构化日志只包含 section 元数据，没有完整 section 文本。"],
      }),
    );
  }

  return snapshots.sort((left, right) => compareIsoAsc(left.at, right.at));
}

function buildContextUsageSnapshots(
  traceId: string,
  sessions: Set<string>,
  observation: LoadedObservation,
): ContextUsageSnapshotView[] {
  const snapshots: ContextUsageSnapshotView[] = [];

  for (const log of observation.logs.records) {
    if (log.traceId !== traceId || !isContextUsageSnapshotLog(log)) continue;
    const context = log.context ?? {};
    const categories = arrayValue(context.categories)
      .filter(isRecord)
      .map((category, index) => usageCategoryFromRecord(category, index));
    const totalTokens =
      numberValue(context.totalTokens) ??
      categories.reduce((sum, category) => sum + category.tokens, 0);
    const totalChars =
      numberValue(context.totalChars) ??
      categories.reduce((sum, category) => sum + category.chars, 0);
    const categoriesWithPercent = categories.map((category) => ({
      ...category,
      percentTokens:
        numberValue(category.percentTokens) ??
        (totalTokens > 0 ? category.tokens / totalTokens : 0),
    }));

    snapshots.push({
      id: `log:${log.sourcePath}:${log.line}:context-usage`,
      at: log.timestamp,
      traceId: log.traceId,
      sessionId: log.sessionId,
      turnId: log.turnId,
      model: stringValue(context.model),
      totalChars,
      totalTokens,
      tokenMethod: tokenMethodValue(context.tokenMethod),
      confidence: tokenConfidenceValue(context.confidence),
      tokenizer: stringValue(context.tokenizer),
      categories: categoriesWithPercent,
      systemTools: arrayValue(context.systemTools).filter(isRecord).map(usageToolFromRecord),
      mcpTools: arrayValue(context.mcpTools).filter(isRecord).map(usageToolFromRecord),
      skills: arrayValue(context.skills).filter(isRecord).map(usageSkillFromRecord),
      messageBreakdown: arrayValue(context.messageBreakdown)
        .filter(isRecord)
        .map(usageMessageBreakdownFromRecord),
      warnings: arrayValue(context.warnings).filter(
        (warning): warning is string => typeof warning === "string",
      ),
    });
  }

  if (snapshots.length === 0) {
    snapshots.push(...contextUsageSnapshotsFromDb(traceId, sessions, observation.db.records[0]));
  }

  return snapshots.sort((left, right) => compareIsoAsc(left.at, right.at));
}

function contextUsageSnapshotsFromDb(
  traceId: string,
  sessions: Set<string>,
  db?: DbObservation,
): ContextUsageSnapshotView[] {
  if (!db || sessions.size === 0) return [];
  const snapshots: ContextUsageSnapshotView[] = [];

  for (const part of db.parts) {
    if (!sessions.has(part.sessionId) || part.type !== "step-finish") continue;
    const tokens = isRecord(part.data.tokens) ? part.data.tokens : undefined;
    if (!tokens) continue;
    const inputTokens = numberValue(tokens.input) ?? 0;
    if (inputTokens <= 0) continue;

    snapshots.push({
      id: `sqlite:${part.id}:context-usage`,
      at: part.createdAt,
      traceId,
      sessionId: part.sessionId,
      totalChars: 0,
      totalTokens: inputTokens,
      tokenMethod: "provider_usage",
      confidence: "low",
      categories: [
        {
          id: `sqlite-input:${part.id}`,
          name: "模型输入（SQLite 聚合）",
          source: "other",
          chars: 0,
          tokens: inputTokens,
          percentTokens: 1,
          tokenMethod: "provider_usage",
          confidence: "low",
        },
      ],
      systemTools: [],
      mcpTools: [],
      skills: [],
      messageBreakdown: [],
      warnings: [
        "SQLite step-finish 只保存聚合 input token，无法拆分系统提示、技能、工具和消息。",
        "要看真实上下文分块，需要用 dev 运行形态重新运行被测 CLI。",
      ],
    });
  }

  return snapshots;
}

function usageCategoryFromRecord(
  category: Record<string, unknown>,
  index: number,
): ContextUsageCategory {
  const name = stringValue(category.name) ?? `分类 ${index + 1}`;
  return {
    id: stringValue(category.id) ?? slug(`${index}-${name}`),
    name,
    source: contextUsageSourceValue(category.source),
    chars: numberValue(category.chars) ?? 0,
    tokens: numberValue(category.tokens) ?? 0,
    percentTokens: numberValue(category.percentTokens) ?? 0,
    tokenMethod: tokenMethodValue(category.tokenMethod),
    confidence: tokenConfidenceValue(category.confidence),
    tokenizer: stringValue(category.tokenizer),
  };
}

function usageToolFromRecord(tool: Record<string, unknown>): ContextUsageToolDetail {
  return {
    name: stringValue(tool.name) ?? "unknown",
    source: stringValue(tool.source) === "mcp_tool" ? "mcp_tool" : "system_tool",
    chars: numberValue(tool.chars),
    tokens: numberValue(tool.tokens) ?? 0,
    tokenMethod: tokenMethodValue(tool.tokenMethod),
    confidence: tokenConfidenceValue(tool.confidence),
    tokenizer: stringValue(tool.tokenizer),
    readOnly: typeof tool.readOnly === "boolean" ? tool.readOnly : undefined,
    serverName: stringValue(tool.serverName),
    sideEffectScope: stringValue(tool.sideEffectScope),
  };
}

function usageSkillFromRecord(skill: Record<string, unknown>): ContextUsageSkillDetail {
  return {
    name: stringValue(skill.name) ?? "unknown",
    source: stringValue(skill.source),
    scope: stringValue(skill.scope),
    path: stringValue(skill.path),
    chars: numberValue(skill.chars),
    tokens: numberValue(skill.tokens) ?? 0,
    tokenMethod: tokenMethodValue(skill.tokenMethod),
    confidence: tokenConfidenceValue(skill.confidence),
    tokenizer: stringValue(skill.tokenizer),
  };
}

function usageMessageBreakdownFromRecord(
  message: Record<string, unknown>,
): ContextUsageMessageBreakdown {
  return {
    role: stringValue(message.role) ?? "unknown",
    count: numberValue(message.count) ?? 0,
    chars: numberValue(message.chars) ?? 0,
    tokens: numberValue(message.tokens) ?? 0,
    tokenMethod: tokenMethodValue(message.tokenMethod),
    confidence: tokenConfidenceValue(message.confidence),
    tokenizer: stringValue(message.tokenizer),
  };
}

function finalizeContextSnapshot(
  input: Omit<ContextSnapshotView, "totalChars" | "totalTokens">,
): ContextSnapshotView {
  const totalTokens = input.sections.reduce((sum, section) => sum + section.tokens, 0);
  const totalChars = input.sections.reduce((sum, section) => sum + section.chars, 0);
  const sections = input.sections.map((section) => ({
    ...section,
    percentTokens: totalTokens > 0 ? section.tokens / totalTokens : 0,
  }));
  return {
    ...input,
    totalChars,
    totalTokens,
    sections,
  };
}

function deriveSectionsFromSystemPrompt(systemPrompt: string): ContextSectionView[] {
  const matches = [...systemPrompt.matchAll(/^(#{1,2})\s+(.+)$/gm)];
  if (matches.length === 0) {
    return [
      makeSection({
        id: "system-prompt",
        name: "系统提示",
        source: "system_prompt",
        content: systemPrompt,
        observable: "full",
      }),
    ];
  }

  const sections: ContextSectionView[] = [];
  const firstIndex = matches[0]?.index ?? 0;
  if (firstIndex > 0) {
    const preamble = systemPrompt.slice(0, firstIndex).trim();
    if (preamble.length > 0) {
      sections.push(
        makeSection({
          id: "preamble",
          name: "系统提示",
          source: "system_prompt",
          content: preamble,
          observable: "full",
        }),
      );
    }
  }

  for (const [index, match] of matches.entries()) {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? systemPrompt.length;
    const name = match[2]?.trim() ?? "段落";
    const content = systemPrompt.slice(start, end).trim();
    sections.push(
      makeSection({
        id: slug(`${index}-${name}`),
        name,
        source: categorizeSection(name),
        content,
        observable: "full",
      }),
    );
  }

  return sections;
}

function sectionsFromPayload(payload?: Record<string, unknown>): ContextSectionView[] {
  const snapshot = isRecord(payload?.contextSnapshot) ? payload.contextSnapshot : undefined;
  const rawSections = arrayValue(snapshot?.sections).filter(isRecord);
  return rawSections.map((section, index) => sectionFromMetadata(section, `payload-${index}`));
}

function sectionsFromContextBuiltLog(log: LogRecord): ContextSectionView[] {
  const rawSections = arrayValue(log.context?.sections).filter(isRecord);
  return rawSections.map((section, index) => sectionFromMetadata(section, `log-${index}`));
}

function sectionFromMetadata(
  section: Record<string, unknown>,
  fallbackId: string,
): ContextSectionView {
  const name = stringValue(section.name) ?? fallbackId;
  const preview = stringValue(section.preview);
  return {
    id: stringValue(section.id) ?? slug(name),
    name,
    source: categorizeSection(stringValue(section.source) ?? name),
    chars: numberValue(section.chars) ?? preview?.length ?? 0,
    tokens: numberValue(section.tokens) ?? estimateTokens(preview ?? ""),
    percentTokens: 0,
    preview,
    content: stringValue(section.content),
    observable: stringValue(section.content) ? "full" : "metadata",
  };
}

function makeSection(input: {
  id: string;
  name: string;
  source: ContextSectionSource;
  content: string;
  observable: "full" | "metadata" | "inferred";
}): ContextSectionView {
  return {
    id: input.id,
    name: input.name,
    source: input.source,
    chars: input.content.length,
    tokens: estimateTokens(input.content),
    percentTokens: 0,
    preview: preview(input.content),
    content: input.content,
    observable: input.observable,
  };
}

function buildCacheReports(
  traceId: string,
  sessions: Set<string>,
  observation: LoadedObservation,
): CacheReport[] {
  const reports: CacheReport[] = [];
  const traceEvents = observation.events.records
    .filter((event) => event.traceId === traceId)
    .sort((left, right) => compareIsoAsc(left.timestamp, right.timestamp));
  const modelRequests = traceEvents.filter((event) => event.type === "model_request");

  for (const request of modelRequests) {
    const complete = findNextEvent(traceEvents, request, "model_complete");
    const turnComplete = findNextEvent(traceEvents, request, "turn_complete");
    const usage = extractUsage(complete?.payload);
    const cacheStats = isRecord(turnComplete?.payload?.cacheStats)
      ? turnComplete?.payload?.cacheStats
      : undefined;
    const messages = arrayValue(request.payload?.messages).filter(isRecord);
    reports.push({
      id: `cache:${request.id}`,
      at: complete?.timestamp ?? request.timestamp,
      traceId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      model: modelName(request.payload),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      hitRate: usage.inputTokens > 0 ? usage.cacheReadTokens / usage.inputTokens : null,
      segments: cacheSegmentsFromMessages(messages, cacheStats, usage.cacheReadTokens),
      limitations: cacheLimitations(messages, cacheStats, usage.cacheReadTokens),
    });
  }

  if (reports.length === 0) {
    reports.push(...cacheReportsFromDb(traceId, sessions, observation.db.records[0]));
  }

  return reports;
}

function findNextEvent(
  events: EventRecord[],
  current: EventRecord,
  type: string,
): EventRecord | undefined {
  const currentAt = current.timestamp ?? "";
  return events.find((event) => {
    if (event.type !== type) return false;
    if (current.turnId && event.turnId !== current.turnId) return false;
    return !currentAt || !event.timestamp || event.timestamp >= currentAt;
  });
}

function cacheSegmentsFromMessages(
  messages: Record<string, unknown>[],
  cacheStats: Record<string, unknown> | undefined,
  cacheReadTokens: number,
): CacheSegment[] {
  const cachedMessages = numberValue(cacheStats?.cachedMessages);
  const lastCacheHit = cacheStats?.lastCacheHit === true;

  return messages.map((message, index) => {
    const content = String(message.content ?? "");
    const hasPrefixStats = lastCacheHit && cachedMessages !== undefined;
    const status = hasPrefixStats ? (index < cachedMessages ? "hit" : "miss") : "unknown";
    return {
      id: `message-${index}`,
      status,
      role: stringValue(message.role),
      source: "message",
      tokens: estimateTokens(content),
      chars: content.length,
      preview: preview(content),
      reason: hasPrefixStats
        ? "根据 runtime 的 cachedMessages 前缀统计推断。"
        : cacheReadTokens > 0
          ? "Provider 返回了缓存 token，但没有逐文本归因。"
          : "这条消息没有缓存归因信息。",
    };
  });
}

function cacheLimitations(
  messages: Record<string, unknown>[],
  cacheStats: Record<string, unknown> | undefined,
  cacheReadTokens: number,
): string[] {
  const limitations: string[] = [];
  if (messages.length === 0) {
    limitations.push("当前观测源没有 provider 可见的 messages。");
  }
  if (!cacheStats) {
    limitations.push("缺少 turn_complete.cacheStats，无法判断逐文本命中状态。");
  }
  if (cacheReadTokens > 0) {
    limitations.push("Provider 的缓存 token 不会标出具体命中文本。");
  }
  return limitations;
}

function cacheReportsFromDb(
  traceId: string,
  sessions: Set<string>,
  db?: DbObservation,
): CacheReport[] {
  if (!db || sessions.size === 0) return [];
  const reports: CacheReport[] = [];

  for (const part of db.parts) {
    if (!sessions.has(part.sessionId) || part.type !== "step-finish") continue;
    const tokens = isRecord(part.data.tokens) ? part.data.tokens : undefined;
    if (!tokens) continue;
    const cache = isRecord(tokens?.cache) ? tokens.cache : undefined;
    const read = numberValue(cache?.read) ?? 0;
    const write = numberValue(cache?.write) ?? 0;
    const inputTokens = numberValue(tokens?.input) ?? 0;
    reports.push({
      id: `sqlite-cache:${part.id}`,
      at: part.createdAt,
      traceId,
      sessionId: part.sessionId,
      inputTokens,
      outputTokens: numberValue(tokens?.output) ?? 0,
      totalTokens: numberValue(tokens?.total) ?? 0,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      hitRate: inputTokens > 0 ? read / inputTokens : null,
      segments: [],
      limitations:
        read > 0 || write > 0
          ? ["SQLite 里有聚合缓存 token，但没有逐文本 cache report。"]
          : ["SQLite 里有 token usage，未观察到 cache read/write。"],
    });
  }

  return reports;
}

function buildDeveloperRequests(
  observation: LoadedObservation,
  snapshots: ContextSnapshotView[],
  reports: CacheReport[],
): DeveloperRequest[] {
  const requests: DeveloperRequest[] = [];
  const hasFullSnapshot = snapshots.some((snapshot) => snapshot.observationLevel === "full");
  const hasExactCache = reports.some((report) =>
    report.segments.some(
      (segment) =>
        Boolean(segment.contentHash) && (segment.status === "hit" || segment.status === "miss"),
    ),
  );

  if (!hasFullSnapshot) {
    requests.push({
      title: "在 model request 前产出 context_snapshot",
      eventName: "context_snapshot",
      reason: "当前数据源只能看到上下文元数据，或完全看不到 system prompt 文本。",
      schema: [
        "traceId/sessionId/turnId/modelRequestId",
        "sections[].name/source/chars/tokens/contentHash/preview/artifactRef",
        "messages[].role/chars/tokens/contentHash/sectionRefs",
      ],
    });
  }

  if (!hasExactCache) {
    requests.push({
      title: "产出逐文本 prompt cache report",
      eventName: "prompt_cache_report",
      reason: "Provider usage 只有缓存 token，没有说明哪些文本片段命中缓存。",
      schema: [
        "traceId/sessionId/turnId/modelRequestId",
        "usage.input/output/total/cacheRead/cacheWrite",
        "segments[].messageIndex/role/source/contentHash/tokens/cacheStatus/reason",
      ],
    });
  }

  if (observation.events.records.length === 0) {
    requests.push({
      title: "增加开发期 Session event JSONL sink",
      eventName: "session_event_jsonl_sink",
      reason: "结构化日志更像诊断索引；Session events 才是还原 trace 的事实来源。",
      schema: [
        "append-only JSONL through SessionEventSink",
        "same envelope fields as docs/design/v2/logging.md",
        "redacted artifact refs for large payloads",
      ],
    });
  }

  return requests;
}

function extractUsage(payload?: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const usage = isRecord(payload?.usage) ? payload.usage : payload;
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }

  return {
    inputTokens: numberValue(usage.inputTokens) ?? numberValue(usage.input) ?? 0,
    outputTokens: numberValue(usage.outputTokens) ?? numberValue(usage.output) ?? 0,
    totalTokens: numberValue(usage.totalTokens) ?? numberValue(usage.total) ?? 0,
    cacheReadTokens:
      numberValue(usage.cacheReadTokens) ??
      numberValue(isRecord(usage.cache) ? usage.cache.read : undefined) ??
      0,
    cacheWriteTokens:
      numberValue(usage.cacheWriteTokens) ??
      numberValue(isRecord(usage.cache) ? usage.cache.write : undefined) ??
      0,
  };
}

function summarizeEvent(event: EventRecord): string {
  const payload = event.payload;
  switch (event.type) {
    case "model_request": {
      const title = `模型请求 ${modelName(payload) ?? ""}`.trim();
      const messages = summarizeProviderMessages(payload);
      return messages ? `${title}\n${messages}` : title;
    }
    case "model_complete": {
      const usage = extractUsage(payload);
      const title = `模型完成，${usage.totalTokens || usage.inputTokens + usage.outputTokens} Token`;
      const content = textFromPayload(payload);
      return content ? `${title}\n${content}` : title;
    }
    case "tool_call_scheduled":
    case "tool_call_started":
    case "tool_call_result":
    case "tool_call_error":
      return [
        `${stringValue(payload?.toolName) ?? "工具"} ${stringValue(payload?.toolCallId) ?? ""}`.trim(),
        textFromPayload(payload),
      ]
        .filter(Boolean)
        .join("\n");
    case "turn_complete":
      return `轮次完成：${stringValue(payload?.resultType) ?? "success"}`;
    case "user_message":
    case "assistant_message":
      return textFromPayload(payload) ?? String(payload?.content ?? event.type);
    default:
      return [event.type, textFromPayload(payload)].filter(Boolean).join("\n");
  }
}

function summarizeDbMessage(message: DbMessageRecord): string {
  const text = stringValue(message.data.text) ?? stringValue(message.data.content);
  const title = `${formatRole(message.role)}消息 ${message.id}`;
  return text ? `${title}: ${text}` : title;
}

function summarizeProviderMessages(
  payload: Record<string, unknown> | undefined,
): string | undefined {
  const messages = arrayValue(payload?.messages).filter(isRecord);
  if (messages.length === 0) return undefined;

  return messages
    .map((message, index) => {
      const role = stringValue(message.role) ?? `message ${index + 1}`;
      const content = textFromPayload(message) ?? stringifyTimelineValue(message);
      return `${role}: ${content}`;
    })
    .join("\n");
}

function firstUserMessageFromEvent(event: EventRecord): string | undefined {
  if (event.type === "user_message") {
    return textFromPayload(event.payload);
  }

  const messages = arrayValue(event.payload?.messages).filter(isRecord);
  const userMessage = messages.find((message) => stringValue(message.role) === "user");
  return userMessage ? textFromPayload(userMessage) : undefined;
}

function textFromDbMessage(message: DbMessageRecord): string | undefined {
  return textFromPayload(message.data);
}

function textFromDbParts(parts: DbPartRecord[] | undefined): string | undefined {
  const textParts = parts
    ?.map((part) => textFromPayload(part.data))
    .filter((text): text is string => Boolean(text?.trim()));
  if (!textParts || textParts.length === 0) return undefined;
  return textParts.join("\n");
}

function textFromPayload(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  return (
    textFromContent(payload.content) ??
    textFromContent(payload.text) ??
    textFromContent(payload.message)
  );
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!isRecord(part)) return "";
        return textFromContent(part.text) ?? textFromContent(part.content) ?? "";
      })
      .filter(Boolean)
      .join(" ");
  }
  if (isRecord(content)) {
    return textFromContent(content.text) ?? textFromContent(content.content);
  }
  return undefined;
}

function formatRole(role?: string): string {
  switch (role) {
    case "system":
      return "system ";
    case "user":
      return "user ";
    case "assistant":
      return "assistant ";
    case "tool":
      return "tool ";
    default:
      return "";
  }
}

function summarizeDbPart(part: DbPartRecord): string {
  const text = stringValue(part.data.text) ?? stringValue(part.data.output);
  return text ? `${part.type ?? "片段"}: ${text}` : `${part.type ?? "片段"} ${part.id}`;
}

function eventToolCallId(payload?: Record<string, unknown>): string | undefined {
  return stringValue(payload?.toolCallId);
}

function eventToolName(payload?: Record<string, unknown>): string | undefined {
  return stringValue(payload?.toolName) ?? stringValue(payload?.name);
}

function subagentLabel(event: EventRecord): string {
  return (
    stringValue(event.payload?.name) ??
    stringValue(event.payload?.subagentId) ??
    stringValue(event.payload?.subagentSessionId) ??
    "子 Agent"
  );
}

function modelName(payload?: Record<string, unknown>): string | undefined {
  const modelSelection = isRecord(payload?.modelSelection) ? payload.modelSelection : undefined;
  return stringValue(modelSelection?.modelId) ?? stringValue(payload?.model);
}

function isContextBuiltLog(log: LogRecord): boolean {
  return log.message === "Context built" || log.event === "context.built";
}

function isContextUsageSnapshotLog(log: LogRecord): boolean {
  return log.message === "Context usage snapshot" || log.event === "context_usage_snapshot";
}

function contextUsageSourceValue(value: unknown): ContextUsageCategory["source"] {
  switch (value) {
    case "system_prompt":
    case "meta_user_context":
    case "skills":
    case "tool_prompt":
    case "system_tool_schemas":
    case "mcp_tool_schemas":
    case "messages":
    case "other":
      return value;
    default:
      return "other";
  }
}

function tokenMethodValue(value: unknown): TokenMethod | undefined {
  switch (value) {
    case "estimated":
    case "provider_count":
    case "proportional_estimate":
    case "provider_usage":
      return value;
    default:
      return undefined;
  }
}

function tokenConfidenceValue(value: unknown): TokenConfidence | undefined {
  switch (value) {
    case "high":
    case "medium":
    case "low":
      return value;
    default:
      return undefined;
  }
}

function categorizeSection(nameOrSource: string): ContextSectionSource {
  const normalized = nameOrSource.toLowerCase();
  if (normalized.includes("skill") || normalized.includes("技能")) return "skills";
  if (normalized.includes("tool") || normalized.includes("工具")) return "tools";
  if (
    normalized.includes("identity") ||
    normalized.includes("system") ||
    normalized.includes("instruction") ||
    normalized.includes("env") ||
    normalized.includes("project") ||
    normalized.includes("prompt") ||
    normalized.includes("user_instructions") ||
    normalized.includes("project_context")
  ) {
    return "system_prompt";
  }
  return "other";
}

function normalizeLogLevel(level?: string): TimelineItem["severity"] {
  switch (level) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return level;
    default:
      return undefined;
  }
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringifyTimelineValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function preview(text: string, maxLength = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function estimateTokens(text: string): number {
  const chineseChars = text.match(/[一-鿿]/g)?.length ?? 0;
  const otherChars = text.length - chineseChars;
  return Math.ceil((chineseChars * 2 + otherChars) / 3);
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "section"
  );
}

function compareIsoAsc(left?: string, right?: string): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.localeCompare(right);
}

function compareIsoDesc(left?: string, right?: string): number {
  return compareIsoAsc(right, left);
}
