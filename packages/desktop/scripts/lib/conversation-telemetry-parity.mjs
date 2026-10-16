/* oxlint-disable eslint(max-lines) -- final payload 的归一化、关系验证和结构化 diff 必须共享同一字段表，拆文件会让白名单与 invariant 漂移。 */
// 纯数据比较器：可由 Vitest、WDIO 或独立 Node runner 复用，不依赖测试框架全局变量。

export const CONVERSATION_TELEMETRY_DIFF_CATEGORIES = [
  "MISSING_EVENT",
  "EXTRA_EVENT",
  "MISSING_FIELD",
  "EXTRA_FIELD",
  "TYPE_MISMATCH",
  "VALUE_MISMATCH",
  "RELATION_MISMATCH",
  "ORDER_MISMATCH",
  "TIMING_INVARIANT_MISMATCH",
];

const CATEGORY_ORDER = new Map(
  CONVERSATION_TELEMETRY_DIFF_CATEGORIES.map((category, index) => [category, index]),
);

const MISSING_VALUE = Symbol("conversation-telemetry-missing");

// event_id/event_key 只标识单次上报，没有任何下游字段会引用它们。旧版并发执行
// reportEvent 时，不同事件拿到 ID 和完成 fetch 的顺序并不稳定，因此这里只保留字段与类型，
// 不给单次事件 ID 建立跨事件关系；真正需要验证关联的 request/message/session 等仍使用稳定 alias。
const NON_RELATIONAL_EVENT_ID_KEYS = new Set(["event_id", "eventId", "event_key", "eventKey"]);

const ID_KIND_BY_KEY = new Map([
  ["device_mid", "device"],
  ["deviceMid", "device"],
  ["event_id", "event"],
  ["eventId", "event"],
  ["event_key", "event"],
  ["eventKey", "event"],
  ["input_id", "input"],
  ["inputId", "input"],
  ["message_id", "message"],
  ["messageId", "message"],
  ["assistant_message_id", "message"],
  ["assistantMessageId", "message"],
  ["source_command_id", "message"],
  ["sourceCommandId", "message"],
  ["summary_message_id", "message"],
  ["summaryMessageId", "message"],
  ["entity_id", "message"],
  ["entityId", "message"],
  ["renderer_id", "renderer"],
  ["rendererId", "renderer"],
  ["query_id", "query"],
  ["queryId", "query"],
  ["request_id", "request"],
  ["requestId", "request"],
  ["session_id", "session"],
  ["sessionId", "session"],
  ["task_id", "session"],
  ["taskId", "session"],
  ["talk_id", "session"],
  ["talkId", "session"],
  ["child_session_id", "session"],
  ["childSessionId", "session"],
  ["tool_call_id", "tool"],
  ["toolCallId", "tool"],
  ["tool_id", "tool"],
  ["toolId", "tool"],
  ["parent_tool_call_id", "tool"],
  ["parentToolCallId", "tool"],
  ["child_tool_call_id", "tool"],
  ["childToolCallId", "tool"],
  ["turn_id", "turn"],
  ["turnId", "turn"],
  ["product_turn_id", "turn"],
  ["productTurnId", "turn"],
  // agent_step 的 step_id 是 renderer 生成的 turn 内不透明标识，也必须跨旧版/V4 归一。
  ["step_id", "turn"],
  ["stepId", "turn"],
]);

const APP_VERSION_KEYS = new Set(["app_version", "appVersion"]);
const TIMESTAMP_KEYS = new Set(["timestamp"]);
const ABSOLUTE_TIME_KEYS = new Set([
  "input_first_char_time",
  "input_send_time",
  "input_start_time",
  "request_time",
]);
const TIMING_VALUE_KEYS = new Set([
  "duration_ms",
  "generation_tail_finalize_ms",
  "metric_value",
  "stall_ms",
  "time_to_first_token",
  "total_ms",
  "ttft_ms",
  "waiting_ms",
]);
const TIMING_ARMS_EVENTS = new Set([
  "plan_request",
  "plan_ttft",
  "perf_ui_first_token",
  "perf_ui_message_complete",
  "perf_ui_stream_stall",
  "perf_ui_tool_call_detail",
  "perf_ui_turn_breakdown",
]);

class StableAliasRegistry {
  constructor() {
    /** @type {Map<string, Map<string, number>>} */
    this.aliases = new Map();
  }

  /**
   * @param {string} kind
   * @param {unknown} value
   * @returns {unknown}
   */
  normalize(kind, value) {
    if ((typeof value !== "string" && typeof value !== "number") || value === "") {
      return value;
    }
    const typedKey = `${typeof value}:${String(value)}`;
    let aliasesForKind = this.aliases.get(kind);
    if (!aliasesForKind) {
      aliasesForKind = new Map();
      this.aliases.set(kind, aliasesForKind);
    }
    let alias = aliasesForKind.get(typedKey);
    if (alias === undefined) {
      alias = aliasesForKind.size + 1;
      aliasesForKind.set(typedKey, alias);
    }
    return typeof value === "number" ? alias : `<${kind}:${alias}>`;
  }
}

/**
 * @param {string} key
 * @param {unknown} value
 * @returns {unknown}
 */
function normalizeDynamicScalar(key, value, context) {
  if (APP_VERSION_KEYS.has(key)) {
    if (typeof value === "string") return "<app-version>";
    if (typeof value === "number") return 0;
  }
  if (TIMESTAMP_KEYS.has(key)) {
    if (typeof value === "string") return "<timestamp>";
    if (typeof value === "number") return 0;
  }
  if (ABSOLUTE_TIME_KEYS.has(key)) {
    if (typeof value === "string" && value !== "") return "<absolute-time>";
    if (typeof value === "number") return 0;
  }
  const isStartedPlanMetric =
    context.channel === "arms" &&
    context.eventName === "plan_request" &&
    context.requestStatus === "started" &&
    (key === "metric_value" || key === "value");
  const isArmsTimingValue =
    key === "value" && context.channel === "arms" && TIMING_ARMS_EVENTS.has(context.eventName);
  // 旧版 reasoning 的开始/结束由两条异步 renderer 回调分别取 Date.now()。即使 SSE fixture
  // 留出了稳定间隔，事件循环仍可能把它们压到同一毫秒，因此这里只比较非负性；generation、
  // tool 等 step 的历史固定零值仍按原值严格比较，避免把真正的口径变化归一掉。
  const isReasoningStepDuration =
    context.channel === "report" &&
    context.eventName === "agent_step" &&
    context.stepType === "reasoning" &&
    key === "duration_ms";
  if (isReasoningStepDuration) {
    const numeric = numericValue(value);
    if (numeric !== null && numeric >= 0) {
      return typeof value === "number" ? 3 : "<nonnegative-reasoning-timing>";
    }
  }
  if (!isStartedPlanMetric && (TIMING_VALUE_KEYS.has(key) || isArmsTimingValue)) {
    const numeric = numericValue(value);
    if (numeric !== null && numeric > 0) {
      return typeof value === "number" ? 2 : "<positive-timing>";
    }
  }
  if (
    context.channel === "report" &&
    context.eventName === "context_compaction" &&
    (key === "pre_compact_tokens" || key === "true_post_compact_tokens")
  ) {
    const numeric = numericValue(value);
    if (numeric !== null && numeric > 0) {
      return typeof value === "number" ? 2 : "<positive-runtime-token-watermark>";
    }
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string | null} key
 * @param {StableAliasRegistry} aliases
 * @returns {unknown}
 */
function normalizeValue(value, key, aliases, context) {
  if (key && NON_RELATIONAL_EVENT_ID_KEYS.has(key) && value !== "") {
    if (typeof value === "string") return "<event-id>";
    if (typeof value === "number") return 0;
  }
  const aliasKind = key ? ID_KIND_BY_KEY.get(key) : undefined;
  if (aliasKind) {
    return aliases.normalize(aliasKind, value);
  }
  if (key) {
    const normalizedDynamic = normalizeDynamicScalar(key, value, context);
    if (normalizedDynamic !== value) return normalizedDynamic;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item, null, aliases, context));
  }
  if (isRecord(value)) {
    /** @type {Record<string, unknown>} */
    const normalized = {};
    for (const propertyKey of Object.keys(value)) {
      normalized[propertyKey] = normalizeValue(value[propertyKey], propertyKey, aliases, context);
    }
    return normalized;
  }
  return value;
}

/**
 * 每次调用使用独立 alias registry；同一次 capture 的 report/ARMS 共享关联表。
 * @param {{ report: readonly unknown[]; arms: readonly unknown[] }} capture
 * @returns {{ report: unknown[]; arms: unknown[] }}
 */
export function normalizeConversationTelemetryCapture(capture) {
  const aliases = new StableAliasRegistry();
  return {
    report: capture.report.map((payload) =>
      normalizeValue(payload, null, aliases, normalizationContext("report", payload)),
    ),
    arms: capture.arms.map((payload) =>
      normalizeValue(payload, null, aliases, normalizationContext("arms", payload)),
    ),
  };
}

/** @param {"report" | "arms"} channel @param {unknown} payload */
function normalizationContext(channel, payload) {
  const properties = isRecord(payload) && isRecord(payload.properties) ? payload.properties : null;
  const reportDetail =
    isRecord(payload) && isRecord(payload.event_extra_detail) ? payload.event_extra_detail : null;
  return {
    channel,
    eventName: eventName(channel, payload),
    requestStatus: readNonEmptyString(properties?.request_status) ?? "",
    stepType: readNonEmptyString(reportDetail?.step_type) ?? "",
  };
}

/**
 * @param {"report" | "arms"} channel
 * @param {unknown} payload
 * @returns {string}
 */
function eventName(channel, payload) {
  if (!isRecord(payload)) return `<invalid:${valueType(payload)}>`;
  if (channel === "report") {
    return (
      readNonEmptyString(payload.element_name) ??
      readNonEmptyString(payload.elementName) ??
      "<unknown>"
    );
  }
  const properties = isRecord(payload.properties) ? payload.properties : null;
  return (
    readNonEmptyString(payload.name) ??
    readNonEmptyString(payload.event_name) ??
    readNonEmptyString(properties?.event_name) ??
    "<unknown>"
  );
}

/**
 * @param {readonly unknown[]} events
 * @param {"report" | "arms"} channel
 * @returns {Map<string, number>}
 */
function inventory(events, channel) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const event of events) {
    const name = eventName(channel, event);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/**
 * @param {"report" | "arms"} channel
 * @param {readonly unknown[]} expected
 * @param {readonly unknown[]} actual
 * @param {Array<ConversationTelemetryParityDiff>} differences
 */
function compareChannel(channel, expected, actual, differences) {
  const expectedInventory = inventory(expected, channel);
  const actualInventory = inventory(actual, channel);
  const inventoryNames = [
    ...new Set([...expectedInventory.keys(), ...actualInventory.keys()]),
  ].sort();
  let inventoryMatches = true;
  for (const name of inventoryNames) {
    const expectedCount = expectedInventory.get(name) ?? 0;
    const actualCount = actualInventory.get(name) ?? 0;
    if (expectedCount === actualCount) continue;
    inventoryMatches = false;
    differences.push(
      createDiff({
        category: actualCount < expectedCount ? "MISSING_EVENT" : "EXTRA_EVENT",
        channel,
        eventIndex: null,
        path: `${channel}.inventory[${JSON.stringify(name)}]`,
        expected: expectedCount,
        actual: actualCount,
      }),
    );
  }

  const expectedByName = groupEventsByName(expected, channel);
  const actualByName = groupEventsByName(actual, channel);
  for (const name of inventoryNames) {
    const expectedEvents = expectedByName.get(name) ?? [];
    const actualEvents = actualByName.get(name) ?? [];
    const comparableLength = Math.min(expectedEvents.length, actualEvents.length);
    const expectedOrder = expectedEvents.map(({ payload }) =>
      stableEventOrderSignature(channel, payload),
    );
    const actualOrder = actualEvents.map(({ payload }) =>
      stableEventOrderSignature(channel, payload),
    );
    const stableOrderMatches = comparableLength <= 1 || sameStringArray(expectedOrder, actualOrder);
    if (inventoryMatches && !stableOrderMatches) {
      differences.push(
        createDiff({
          category: "ORDER_MISMATCH",
          channel,
          eventIndex: null,
          path: `${channel}.order[${JSON.stringify(name)}]`,
          expected: expectedOrder,
          actual: actualOrder,
        }),
      );
      continue;
    }

    for (let occurrence = 0; occurrence < comparableLength; occurrence += 1) {
      const expectedEvent = expectedEvents[occurrence];
      const actualEvent = actualEvents[occurrence];
      compareValue(
        expectedEvent.payload,
        actualEvent.payload,
        `${channel}[${expectedEvent.index}]`,
        channel,
        expectedEvent.index,
        differences,
        null,
      );
    }
  }
}

/**
 * 旧版同一个 terminal 会 fire-and-forget 两次异步 reportEvent；agent_step 与
 * message_completion 谁先完成网络请求不是统计口径。比较时按事件名配对，但同一事件名内部仍
 * 保留业务阶段顺序，例如 plan_request 的 started 必须先于 completed。
 * @param {readonly unknown[]} events
 * @param {"report" | "arms"} channel
 */
function groupEventsByName(events, channel) {
  /** @type {Map<string, Array<{ index: number; payload: unknown }>>} */
  const grouped = new Map();
  events.forEach((payload, index) => {
    const name = eventName(channel, payload);
    const group = grouped.get(name) ?? [];
    group.push({ index, payload });
    grouped.set(name, group);
  });
  return grouped;
}

/** @param {"report" | "arms"} channel @param {unknown} payload */
function stableEventOrderSignature(channel, payload) {
  if (!isRecord(payload)) return `<invalid:${valueType(payload)}>`;
  const detail =
    channel === "report"
      ? isRecord(payload.event_extra_detail)
        ? payload.event_extra_detail
        : isRecord(payload.eventExtraDetail)
          ? payload.eventExtraDetail
          : null
      : isRecord(payload.properties)
        ? payload.properties
        : null;
  if (!detail) return eventName(channel, payload);
  const fields =
    channel === "report"
      ? [detail.loop_index, detail.step_type, detail.tool_name, detail.status]
      : [detail.request_status, detail.result, detail.tool_name, detail.status];
  return JSON.stringify([eventName(channel, payload), ...fields.map((value) => value ?? null)]);
}

/**
 * @param {unknown} expected
 * @param {unknown} actual
 * @param {string} path
 * @param {"report" | "arms"} channel
 * @param {number} eventIndex
 * @param {Array<ConversationTelemetryParityDiff>} differences
 * @param {string | null} propertyKey
 */
function compareValue(expected, actual, path, channel, eventIndex, differences, propertyKey) {
  const expectedType = valueType(expected);
  const actualType = valueType(actual);
  if (expectedType !== actualType) {
    differences.push(
      createDiff({
        category: "TYPE_MISMATCH",
        channel,
        eventIndex,
        path,
        expected,
        actual,
      }),
    );
    return;
  }

  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      differences.push(
        createDiff({
          category: "VALUE_MISMATCH",
          channel,
          eventIndex,
          path: `${path}.length`,
          expected: expected.length,
          actual: actual.length,
        }),
      );
    }
    const length = Math.min(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      compareValue(
        expected[index],
        actual[index],
        `${path}[${index}]`,
        channel,
        eventIndex,
        differences,
        null,
      );
    }
    return;
  }

  if (isRecord(expected) && isRecord(actual)) {
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(actual).sort();
    const allKeys = [...new Set([...expectedKeys, ...actualKeys])].sort();
    for (const key of allKeys) {
      const expectedHasKey = Object.hasOwn(expected, key);
      const actualHasKey = Object.hasOwn(actual, key);
      const childPath = appendPath(path, key);
      if (!expectedHasKey || !actualHasKey) {
        differences.push(
          createDiff({
            category: expectedHasKey ? "MISSING_FIELD" : "EXTRA_FIELD",
            channel,
            eventIndex,
            path: childPath,
            expected: expectedHasKey ? expected[key] : MISSING_VALUE,
            actual: actualHasKey ? actual[key] : MISSING_VALUE,
          }),
        );
        continue;
      }
      compareValue(expected[key], actual[key], childPath, channel, eventIndex, differences, key);
    }
    return;
  }

  if (!Object.is(expected, actual)) {
    differences.push(
      createDiff({
        category:
          propertyKey && ID_KIND_BY_KEY.has(propertyKey)
            ? "RELATION_MISMATCH"
            : propertyKey &&
                (TIMING_VALUE_KEYS.has(propertyKey) ||
                  (channel === "arms" && propertyKey === "value"))
              ? "TIMING_INVARIANT_MISMATCH"
              : "VALUE_MISMATCH",
        channel,
        eventIndex,
        path,
        expected,
        actual,
      }),
    );
  }
}

/**
 * duration 的墙钟值可以因 Electron/CI 调度不同而变化，但每份 capture 内的旧公式必须成立。
 * @param {{ report: readonly unknown[]; arms: readonly unknown[] }} capture
 */
function collectTimingInvariantIssues(capture) {
  /** @type {{ report: string[]; arms: string[] }} */
  const issues = { report: [], arms: [] };
  /** @type {Map<string, number>} */
  const sendTimeByMessage = new Map();
  /** @type {{ duration: number | null; ttft: number | null; messageKey: string }[]} */
  const completions = [];

  capture.report.forEach((payload, index) => {
    if (!isRecord(payload)) return;
    const name = eventName("report", payload);
    const detail = isRecord(payload.event_extra_detail)
      ? payload.event_extra_detail
      : isRecord(payload.eventExtraDetail)
        ? payload.eventExtraDetail
        : null;
    if (!detail) return;
    const messageKey = reportMessageKey(payload);
    if (name === "send_btn") {
      const start = numericValue(detail.input_start_time);
      const first = numericValue(detail.input_first_char_time);
      const send = numericValue(detail.input_send_time);
      if (start !== null && first !== null && send !== null && !(start <= first && first <= send)) {
        issues.report.push(`report[${index}] send input_start<=input_first_char<=input_send`);
      }
      if (messageKey && send !== null) sendTimeByMessage.set(messageKey, send);
      return;
    }
    if (name === "agent_step") {
      const duration = numericValue(detail.duration_ms);
      const tail = numericValue(detail.generation_tail_finalize_ms);
      if (duration !== null && duration < 0) {
        issues.report.push(`report[${index}] agent_step duration_ms>=0`);
      }
      if (tail !== null && (tail < 0 || (duration !== null && tail > duration))) {
        issues.report.push(`report[${index}] 0<=generation_tail_finalize_ms<=duration_ms`);
      }
      return;
    }
    if (name === "context_compaction") {
      const pre = numericValue(detail.pre_compact_tokens);
      const post = numericValue(detail.post_compact_tokens);
      const truePost = numericValue(detail.true_post_compact_tokens);
      const ratio = numericValue(detail.compact_ratio);
      if (
        [pre, post, truePost].some((value) => value !== null && value < 0)
      ) {
        issues.report.push(`report[${index}] compaction token watermarks>=0`);
      }
      if (
        pre !== null &&
        pre > 0 &&
        post !== null &&
        ratio !== null &&
        ratio !== Number((post / pre).toFixed(4))
      ) {
        issues.report.push(`report[${index}] compact_ratio=post_compact_tokens/pre_compact_tokens`);
      }
      return;
    }
    if (name !== "message_completion") return;
    const duration = numericValue(detail.duration_ms);
    const ttft = numericValue(detail.time_to_first_token);
    const requestTime = numericValue(detail.request_time);
    if (duration !== null && duration < 0) {
      issues.report.push(`report[${index}] completion duration_ms>=0`);
    }
    if (ttft !== null && ttft !== -1 && (ttft < 0 || (duration !== null && ttft > duration))) {
      issues.report.push(`report[${index}] completion ttft=-1 or 0<=ttft<=duration`);
    }
    const sendTime = messageKey ? sendTimeByMessage.get(messageKey) : undefined;
    if (requestTime !== null && sendTime !== undefined && requestTime !== sendTime) {
      issues.report.push(`report[${index}] request_time=input_send_time`);
    }
    completions.push({ duration, ttft, messageKey: messageKey ?? `#${index}` });
  });

  let planTtftIndex = 0;
  capture.arms.forEach((payload, index) => {
    if (!isRecord(payload)) return;
    const name = eventName("arms", payload);
    const properties = isRecord(payload.properties) ? payload.properties : null;
    if (!properties) return;
    const value = numericValue(payload.value);
    const metric = numericValue(properties.metric_value);
    if (value !== null && metric !== null && value !== metric) {
      issues.arms.push(`arms[${index}] value=metric_value`);
    }
    if (name === "plan_request") {
      const status = readNonEmptyString(properties.request_status);
      const duration = numericValue(properties.duration_ms);
      if (status === "started" && value !== null && value !== 1) {
        issues.arms.push(`arms[${index}] plan_request started value=1`);
      }
      if (status === "completed" && duration !== null && value !== null && duration !== value) {
        issues.arms.push(`arms[${index}] plan_request completed duration_ms=value`);
      }
      return;
    }
    if (name === "plan_ttft") {
      const ttft = numericValue(properties.ttft_ms);
      if (value !== null && (value < 0 || (ttft !== null && ttft !== value))) {
        issues.arms.push(`arms[${index}] plan_ttft 0<=ttft_ms=value`);
      }
      const completion = completions[planTtftIndex];
      if (
        completion?.ttft !== null &&
        completion?.ttft !== undefined &&
        value !== null &&
        completion.ttft !== value
      ) {
        issues.arms.push(`arms[${index}] plan_ttft=completion.time_to_first_token`);
      }
      planTtftIndex += 1;
      return;
    }
    if (name === "perf_ui_first_token") {
      if (value !== null && value < 0) {
        issues.arms.push(`arms[${index}] perf_ui_first_token value>=0`);
      }
      compareMessageTimingToCompletion({
        payload,
        value,
        field: "ttft",
        invariant: "perf_ui_first_token=completion.time_to_first_token",
        index,
        completions,
        issues: issues.arms,
      });
      return;
    }
    if (name === "perf_ui_message_complete") {
      compareMessageTimingToCompletion({
        payload,
        value,
        field: "duration",
        invariant: "perf_ui_message_complete=completion.duration_ms",
        index,
        completions,
        issues: issues.arms,
      });
      return;
    }
    if (name === "perf_ui_stream_stall") {
      const stall = numericValue(properties.stall_ms);
      if (stall !== null && (stall <= 3000 || (value !== null && stall !== value))) {
        issues.arms.push(`arms[${index}] stream_stall stall_ms=value>3000`);
      }
      return;
    }
    if (name === "perf_ui_tool_call_detail") {
      const total = numericValue(properties.total_ms);
      if (total !== null && (total < 0 || (value !== null && total !== value))) {
        issues.arms.push(`arms[${index}] tool_call_detail total_ms=value>=0`);
      }
      return;
    }
    if (name !== "perf_ui_turn_breakdown") return;
    const duration = numericValue(properties.duration_ms);
    const ttft = numericValue(properties.ttft_ms);
    if (value !== null && duration !== null && value !== duration) {
      issues.arms.push(`arms[${index}] turn_breakdown duration_ms=value`);
    }
    if (duration !== null && ttft !== null && (ttft < 0 || ttft > duration)) {
      issues.arms.push(`arms[${index}] turn_breakdown 0<=ttft_ms<=duration_ms`);
    }
    compareMessageTimingToCompletion({
      payload,
      value,
      field: "duration",
      invariant: "turn_breakdown=completion.duration_ms",
      index,
      completions,
      issues: issues.arms,
    });
  });
  return issues;
}

/** @param {{ payload: Record<string, unknown>; value: number | null; field: "duration" | "ttft"; invariant: string; index: number; completions: { duration: number | null; ttft: number | null; messageKey: string }[]; issues: string[] }} input */
function compareMessageTimingToCompletion(input) {
  if (input.value === null) return;
  const messageKey = armsMessageKey(input.payload);
  if (!messageKey) return;
  const completion = input.completions.find((candidate) => candidate.messageKey === messageKey);
  const expected = completion?.[input.field];
  if (expected !== null && expected !== undefined && expected !== input.value) {
    input.issues.push(`arms[${input.index}] ${input.invariant}`);
  }
}

/** @param {Record<string, unknown>} payload */
function reportMessageKey(payload) {
  const talk = readScalar(payload.talk_id ?? payload.talkId);
  const message = readScalar(payload.message_id ?? payload.messageId);
  return talk !== null && message !== null ? `${talk}\0${message}` : null;
}

/** @param {Record<string, unknown>} payload */
function armsMessageKey(payload) {
  const properties = isRecord(payload.properties) ? payload.properties : null;
  if (!properties) return null;
  const talk = readScalar(properties.talk_id ?? properties.talkId);
  const message = readScalar(properties.message_id ?? properties.messageId);
  return talk !== null && message !== null ? `${talk}\0${message}` : null;
}

/** @param {unknown} value */
function numericValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** @param {unknown} value */
function readScalar(value) {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

/**
 * @param {{ report: string[]; arms: string[] }} expected
 * @param {{ report: string[]; arms: string[] }} actual
 * @param {Array<ConversationTelemetryParityDiff>} differences
 */
function compareTimingInvariantIssues(expected, actual, differences) {
  for (const channel of ["report", "arms"]) {
    if (sameStringArray(expected[channel], actual[channel])) continue;
    differences.push(
      createDiff({
        category: "TIMING_INVARIANT_MISMATCH",
        channel,
        eventIndex: null,
        path: `${channel}.timing_invariants`,
        expected: expected[channel],
        actual: actual[channel],
      }),
    );
  }
}

/**
 * @param {{ report: readonly unknown[]; arms: readonly unknown[] }} expectedCapture
 * @param {{ report: readonly unknown[]; arms: readonly unknown[] }} actualCapture
 * @returns {ConversationTelemetryParityResult}
 */
export function compareConversationTelemetryParity(expectedCapture, actualCapture) {
  const expectedTimingIssues = collectTimingInvariantIssues(expectedCapture);
  const actualTimingIssues = collectTimingInvariantIssues(actualCapture);
  const expected = normalizeConversationTelemetryCapture(expectedCapture);
  const actual = normalizeConversationTelemetryCapture(actualCapture);
  /** @type {Array<ConversationTelemetryParityDiff>} */
  const differences = [];
  compareChannel("report", expected.report, actual.report, differences);
  compareChannel("arms", expected.arms, actual.arms, differences);
  compareTimingInvariantIssues(expectedTimingIssues, actualTimingIssues, differences);
  differences.sort(compareDifferences);
  return { equal: differences.length === 0, expected, actual, differences };
}

/**
 * @param {readonly ConversationTelemetryParityDiff[]} differences
 * @returns {string}
 */
export function formatConversationTelemetryParityDifferences(differences) {
  return differences
    .map(
      (difference) =>
        `[${difference.category}] ${difference.path}: expected=${difference.expected} actual=${difference.actual}`,
    )
    .join("\n");
}

/**
 * @param {{ report: readonly unknown[]; arms: readonly unknown[] }} expected
 * @param {{ report: readonly unknown[]; arms: readonly unknown[] }} actual
 */
export function assertConversationTelemetryParity(expected, actual) {
  const result = compareConversationTelemetryParity(expected, actual);
  if (result.equal) return;
  throw new Error(
    `Conversation telemetry parity mismatch:\n${formatConversationTelemetryParityDifferences(result.differences)}`,
  );
}

/**
 * @typedef {object} ConversationTelemetryParityDiff
 * @property {"MISSING_EVENT" | "EXTRA_EVENT" | "MISSING_FIELD" | "EXTRA_FIELD" | "TYPE_MISMATCH" | "VALUE_MISMATCH" | "RELATION_MISMATCH" | "ORDER_MISMATCH" | "TIMING_INVARIANT_MISMATCH"} category
 * @property {"report" | "arms"} channel
 * @property {number | null} eventIndex
 * @property {string} path
 * @property {string} expected
 * @property {string} actual
 */

/**
 * @typedef {object} ConversationTelemetryParityResult
 * @property {boolean} equal
 * @property {{ report: unknown[]; arms: unknown[] }} expected
 * @property {{ report: unknown[]; arms: unknown[] }} actual
 * @property {ConversationTelemetryParityDiff[]} differences
 */

/**
 * @param {{ category: ConversationTelemetryParityDiff["category"]; channel: "report" | "arms"; eventIndex: number | null; path: string; expected: unknown; actual: unknown }} input
 * @returns {ConversationTelemetryParityDiff}
 */
function createDiff(input) {
  return {
    ...input,
    expected: displayValue(input.expected),
    actual: displayValue(input.actual),
  };
}

/**
 * @param {ConversationTelemetryParityDiff} left
 * @param {ConversationTelemetryParityDiff} right
 */
function compareDifferences(left, right) {
  return (
    (CATEGORY_ORDER.get(left.category) ?? 99) - (CATEGORY_ORDER.get(right.category) ?? 99) ||
    left.channel.localeCompare(right.channel) ||
    (left.eventIndex ?? -1) - (right.eventIndex ?? -1) ||
    left.path.localeCompare(right.path)
  );
}

/** @param {unknown} value */
function displayValue(value) {
  if (value === MISSING_VALUE) return "<missing>";
  if (value === undefined) return "undefined";
  if (typeof value === "number" && Number.isNaN(value)) return "NaN";
  return stableJson(value);
}

/** @param {unknown} value */
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

/** @param {unknown} value */
function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** @param {unknown} value */
/** @param {string} path @param {string} key */
function appendPath(path, key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

/** @param {unknown} value */
function readNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** @param {readonly string[]} left @param {readonly string[]} right */
function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
