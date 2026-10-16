/**
 * runner-status.ts 顶到 oxlint max-lines 上限（400 行），把「请求归因 header」一族
 * （header 常量、内部前缀剥离、session-type 推断）拆到本文件；公开面仍从 runner-status.ts 导出。
 *
 * 与 runner-status.ts 的依赖方向：本文件只 `import type` 它的 `ModelStatusContext`，运行时不成环。
 */

import type {
  ModelRequestSessionType as ModelRequestSessionTypeValue,
  ResolvedModelApiCallObservation,
} from "@zcode/contracts";
import { ModelApiActorKind, ModelApiOperation, ModelRequestSessionType } from "@zcode/contracts";
import { isOpenCodeGoBaseUrl } from "./opencode-session.js";
import { MODEL_QUERY_SOURCE_HEADER } from "./model-request-headers.js";
import type { ModelStatusContext } from "./runner-status.js";

const MODEL_TRACE_HEADER = "x-zcode-trace-id";
const MODEL_REQUEST_HEADER = "x-request-id";
const MODEL_SESSION_HEADER = "x-session-id";
const MODEL_QUERY_HEADER = "x-query-id";
// Coding Plan 服务端使用该请求级 Header 区分 main/subagent/side_chat/other 来源。
// 它不是 Provider 静态能力或鉴权材料，必须由调用上下文生成并覆盖同名静态 Header。
const MODEL_SESSION_TYPE_HEADER = "x-zcode-session-type";
const SESSION_ID_INTERNAL_PREFIX = "sess_";
const SESSION_ID_SUBAGENT_PREFIX = "subagent_agent_";
const QUERY_ID_INTERNAL_PREFIX = "query_";
const QUERY_SOURCE_HEADER_VALUE_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/u;

export function createModelRequestAttributionHeaders(
  statusContext: ModelStatusContext,
): Record<string, string> {
  const sessionHeaderValue = normalizeModelSessionIdForAttribution(statusContext.sessionId);
  const queryHeaderValue = modelQueryHeaderValue(statusContext.queryId);
  const querySource = statusContext.querySource?.trim();
  // querySource 是观测标识；非法字符或过长值只省略，避免 HTTP 头校验阻断模型请求。
  const querySourceHeaderValue =
    querySource && QUERY_SOURCE_HEADER_VALUE_PATTERN.test(querySource) ? querySource : undefined;
  const openCodeSessionHeaderValue = isOpenCodeGoBaseUrl(statusContext.baseURL)
    ? sessionHeaderValue
    : undefined;
  // 只把跨 provider 网络边界需要的观测归因字段写入 header，span 等细粒度信息仍留在事件和日志里。
  return {
    [MODEL_REQUEST_HEADER]: statusContext.requestId,
    [MODEL_SESSION_TYPE_HEADER]: isModelRequestSessionType(statusContext.modelRequestSessionType)
      ? statusContext.modelRequestSessionType
      : ModelRequestSessionType.Other,
    [MODEL_TRACE_HEADER]: statusContext.traceId,
    ...(queryHeaderValue ? { [MODEL_QUERY_HEADER]: queryHeaderValue } : {}),
    ...(querySourceHeaderValue ? { [MODEL_QUERY_SOURCE_HEADER]: querySourceHeaderValue } : {}),
    ...(sessionHeaderValue ? { [MODEL_SESSION_HEADER]: sessionHeaderValue } : {}),
    ...(openCodeSessionHeaderValue ? { "x-opencode-session": openCodeSessionHeaderValue } : {}),
  };
}

export function resolveModelRequestSessionType(
  explicitType: unknown,
  modelCall: Pick<ResolvedModelApiCallObservation, "actorKind" | "operation">,
): ModelRequestSessionTypeValue {
  if (isModelRequestSessionType(explicitType)) return explicitType;
  if (modelCall.operation !== ModelApiOperation.AgentStep) {
    return ModelRequestSessionType.Other;
  }
  if (modelCall.actorKind === ModelApiActorKind.MainAgent) {
    return ModelRequestSessionType.Main;
  }
  if (modelCall.actorKind === ModelApiActorKind.Subagent) {
    return ModelRequestSessionType.Subagent;
  }
  return ModelRequestSessionType.Other;
}

function isModelRequestSessionType(value: unknown): value is ModelRequestSessionTypeValue {
  return (
    value === ModelRequestSessionType.Main ||
    value === ModelRequestSessionType.Subagent ||
    value === ModelRequestSessionType.SideChat ||
    value === ModelRequestSessionType.Other
  );
}

export function normalizeModelSessionIdForAttribution(
  sessionId: ModelStatusContext["sessionId"],
): string | undefined {
  if (!sessionId) return undefined;
  // 内部 SessionId/QueryId 前缀只服务于 CLI 存储和事件归因；provider header
  // 是跨网络观测字段，不能把 query_/subagent_agent_ 这类实现前缀暴露给上游。
  return stripHeaderInternalPrefixes(sessionId, [
    SESSION_ID_INTERNAL_PREFIX,
    SESSION_ID_SUBAGENT_PREFIX,
  ]);
}

function modelQueryHeaderValue(queryId: ModelStatusContext["queryId"]): string | undefined {
  if (!queryId) return undefined;
  return stripHeaderInternalPrefixes(queryId, [QUERY_ID_INTERNAL_PREFIX]);
}

function stripHeaderInternalPrefixes(value: string, prefixes: string[]): string {
  let headerValue = value;
  for (const prefix of prefixes) {
    if (headerValue.startsWith(prefix) && headerValue.length > prefix.length) {
      headerValue = headerValue.slice(prefix.length);
    }
  }
  return headerValue || value;
}
