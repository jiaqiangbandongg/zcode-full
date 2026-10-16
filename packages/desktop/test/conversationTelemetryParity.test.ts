import { describe, expect, it } from "vitest";
import {
  assertConversationTelemetryParity,
  compareConversationTelemetryParity,
  formatConversationTelemetryParityDifferences,
  normalizeConversationTelemetryCapture,
} from "../scripts/lib/conversation-telemetry-parity.mjs";
import type { ConversationTelemetryFinalCapture } from "../scripts/lib/conversation-telemetry-parity.mjs";

function tdp02Capture(ids: {
  device: string;
  eventPrefix: string;
  message: string;
  renderer: string;
  request: string;
  session: string;
  step: string;
  timestamp: number;
}): ConversationTelemetryFinalCapture {
  const reportCommon = {
    app_version: `${ids.eventPrefix}-app-version`,
    device_mid: ids.device,
    talk_id: ids.session,
  };
  const armsCommon = {
    app_version: `${ids.eventPrefix}-app-version`,
    device_mid: ids.device,
    renderer_id: ids.renderer,
  };
  return {
    report: [
      {
        ...reportCommon,
        event_id: `${ids.eventPrefix}-send`,
        timestamp: ids.timestamp,
        element_name: "send_btn",
        event_region: "app",
        event_type: "ck",
        event_text: "",
        event_extra_detail: {
          ask_mode: "build",
          input_send_time: "100",
          model_name: "provider/model",
        },
        message_id: ids.message,
      },
      {
        ...reportCommon,
        event_id: `${ids.eventPrefix}-step`,
        timestamp: ids.timestamp + 1,
        element_name: "agent_step",
        event_region: "app",
        event_type: "agent_trace",
        event_text: "",
        event_extra_detail: {
          step_id: ids.step,
          step_type: "generation",
          status: "success",
          tool_call_id: "",
        },
        message_id: ids.message,
      },
      {
        ...reportCommon,
        event_id: `${ids.eventPrefix}-completion`,
        timestamp: ids.timestamp + 2,
        element_name: "message_completion",
        event_region: "app",
        event_type: "agent_trace",
        event_text: "",
        event_extra_detail: {
          agent_step_cnt: "1",
          status: "success",
          time_to_first_token: "50",
        },
        message_id: ids.message,
      },
    ],
    arms: [
      {
        name: "plan_request",
        type: "custom",
        group: "plan_usage",
        value: 1,
        properties: {
          ...armsCommon,
          event_name: "plan_request",
          event_key: `${ids.eventPrefix}-model-start`,
          metric_value: "1",
          request_id: ids.request,
          input_id: ids.message,
          query_id: ids.message,
          request_status: "started",
          task_id: ids.session,
        },
      },
      {
        name: "plan_request",
        type: "custom",
        group: "plan_usage",
        value: 20,
        properties: {
          ...armsCommon,
          duration_ms: "20",
          event_name: "plan_request",
          event_key: `${ids.eventPrefix}-model-completed`,
          metric_value: "20",
          request_id: ids.request,
          input_id: ids.message,
          query_id: ids.message,
          request_status: "completed",
          task_id: ids.session,
        },
      },
      {
        name: "perf_ui_first_token",
        type: "custom",
        group: "ui_perf",
        value: 50,
        properties: {
          ...armsCommon,
          event_name: "perf_ui_first_token",
          message_id: ids.message,
          metric_value: "50",
          talk_id: ids.session,
          ttft_ms: "50",
        },
      },
      {
        name: "perf_ui_message_complete",
        type: "custom",
        group: "ui_perf",
        value: 500,
        properties: {
          ...armsCommon,
          duration_ms: "500",
          event_name: "perf_ui_message_complete",
          message_id: ids.message,
          metric_value: "500",
          result: "success",
          talk_id: ids.session,
        },
      },
      {
        name: "perf_ui_turn_breakdown",
        type: "custom",
        group: "ui_perf",
        value: 500,
        properties: {
          ...armsCommon,
          agent_step_cnt: "1",
          duration_ms: "500",
          event_name: "perf_ui_turn_breakdown",
          message_id: ids.message,
          metric_value: "500",
          talk_id: ids.session,
          ttft_ms: "50",
        },
      },
    ],
  };
}

describe("conversation telemetry parity comparator", () => {
  it("覆盖 TDP02 inventory，并仅归一动态值和不透明 ID", () => {
    const legacy = tdp02Capture({
      device: "legacy-device",
      eventPrefix: "legacy-event",
      message: "legacy-message",
      renderer: "legacy-renderer",
      request: "legacy-request",
      session: "legacy-session",
      step: "legacy-step",
      timestamp: 1_000,
    });
    const v4 = tdp02Capture({
      device: "v4-device",
      eventPrefix: "v4-event",
      message: "v4-message",
      renderer: "v4-renderer",
      request: "v4-request",
      session: "v4-session",
      step: "v4-step",
      timestamp: 9_000,
    });

    const result = compareConversationTelemetryParity(legacy, v4);
    expect(result.equal).toBe(true);
    expect(result.differences).toEqual([]);
    expect(() => assertConversationTelemetryParity(legacy, v4)).not.toThrow();
    expect(result.expected.report[0]).toMatchObject({
      app_version: "<app-version>",
      device_mid: "<device:1>",
      event_id: "<event-id>",
      message_id: "<message:1>",
      talk_id: "<session:1>",
      timestamp: 0,
    });
  });

  it("稳定 ID alias 能发现同一 model request 内的关联断裂", () => {
    const expected = tdp02Capture({
      device: "device-a",
      eventPrefix: "event-a",
      message: "message-a",
      renderer: "renderer-a",
      request: "request-a",
      session: "session-a",
      step: "step-a",
      timestamp: 100,
    });
    const actual = structuredClone(expected) as { report: unknown[]; arms: unknown[] };
    const planProperties = (actual.arms[0] as { properties: Record<string, unknown> }).properties;
    planProperties.query_id = "a-different-query";

    const result = compareConversationTelemetryParity(expected, actual);
    expect(result.equal).toBe(false);
    expect(result.differences).toEqual([
      expect.objectContaining({
        category: "RELATION_MISMATCH",
        channel: "arms",
        path: "arms[1].properties.query_id",
        expected: '"<query:1>"',
        actual: '"<query:2>"',
      }),
    ]);
  });

  it("允许旧版 fire-and-forget 的异类 terminal 交错，但同类业务阶段乱序仍失败", () => {
    const expected = tdp02Capture({
      device: "device",
      eventPrefix: "event",
      message: "message",
      renderer: "renderer",
      request: "request",
      session: "session",
      step: "step",
      timestamp: 100,
    });
    const reordered = structuredClone(expected) as { report: unknown[]; arms: unknown[] };
    [reordered.report[1], reordered.report[2]] = [reordered.report[2], reordered.report[1]];

    const orderResult = compareConversationTelemetryParity(expected, reordered);
    expect(orderResult.differences).toEqual([]);

    const reorderedPlanRequest = structuredClone(expected) as {
      report: unknown[];
      arms: unknown[];
    };
    [reorderedPlanRequest.arms[0], reorderedPlanRequest.arms[1]] = [
      reorderedPlanRequest.arms[1],
      reorderedPlanRequest.arms[0],
    ];
    const planOrderResult = compareConversationTelemetryParity(expected, reorderedPlanRequest);
    expect(planOrderResult.differences).toEqual([
      expect.objectContaining({
        category: "ORDER_MISMATCH",
        channel: "arms",
        path: 'arms.order["plan_request"]',
      }),
    ]);

    const missing = structuredClone(expected) as { report: unknown[]; arms: unknown[] };
    missing.arms.pop();
    const missingResult = compareConversationTelemetryParity(expected, missing);
    expect(missingResult.differences.map((difference) => difference.category)).toEqual([
      "MISSING_EVENT",
    ]);
  });

  it("严格区分 key set、类型、missing/empty/null 与普通值", () => {
    const expected: ConversationTelemetryFinalCapture = {
      report: [
        {
          element_name: "message_completion",
          event_extra_detail: {
            empty: "",
            nullable: null,
            typed: 1,
            value: "success",
            required: "present",
          },
        },
      ],
      arms: [],
    };
    const actual: ConversationTelemetryFinalCapture = {
      report: [
        {
          element_name: "message_completion",
          event_extra_detail: {
            empty: null,
            nullable: "",
            typed: "1",
            value: "failed",
            extra: true,
          },
        },
      ],
      arms: [],
    };

    const result = compareConversationTelemetryParity(expected, actual);
    expect(result.differences.map((difference) => difference.category)).toEqual([
      "MISSING_FIELD",
      "EXTRA_FIELD",
      "TYPE_MISMATCH",
      "TYPE_MISMATCH",
      "TYPE_MISMATCH",
      "VALUE_MISMATCH",
    ]);
    expect(formatConversationTelemetryParityDifferences(result.differences)).toContain(
      "[MISSING_FIELD] report[0].event_extra_detail.required",
    );
  });

  it("timestamp 类型不被归一吞掉，动态正 duration 只比较公式", () => {
    const expected: ConversationTelemetryFinalCapture = {
      report: [{ element_name: "send_btn", timestamp: 100, duration_ms: 10 }],
      arms: [],
    };
    const actual: ConversationTelemetryFinalCapture = {
      report: [{ element_name: "send_btn", timestamp: "100", duration_ms: 11 }],
      arms: [],
    };

    const result = compareConversationTelemetryParity(expected, actual);
    expect(result.differences).toEqual([
      expect.objectContaining({ category: "TYPE_MISMATCH", path: "report[0].timestamp" }),
    ]);
  });

  it("固定零值不被正 duration 归一吞掉，且 ARMS 内部公式断裂会失败", () => {
    const expected = tdp02Capture({
      device: "device",
      eventPrefix: "event",
      message: "message",
      renderer: "renderer",
      request: "request",
      session: "session",
      step: "step",
      timestamp: 100,
    });
    const actual = structuredClone(expected) as { report: unknown[]; arms: unknown[] };
    const completion = actual.arms[1] as {
      value: unknown;
      properties: Record<string, unknown>;
    };
    completion.value = 0;
    completion.properties.metric_value = "20";

    const result = compareConversationTelemetryParity(expected, actual);
    expect(result.differences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "TIMING_INVARIANT_MISMATCH",
          path: "arms[1].value",
        }),
        expect.objectContaining({
          category: "TIMING_INVARIANT_MISMATCH",
          path: "arms.timing_invariants",
        }),
      ]),
    );
  });

  it("只允许 reasoning step 的零/正毫秒抖动，不放宽 generation 固定零值", () => {
    const reasoningExpected: ConversationTelemetryFinalCapture = {
      report: [
        {
          element_name: "agent_step",
          event_extra_detail: { step_type: "reasoning", duration_ms: "0" },
        },
      ],
      arms: [],
    };
    const reasoningActual = structuredClone(reasoningExpected);
    (
      reasoningActual.report[0] as { event_extra_detail: Record<string, unknown> }
    ).event_extra_detail.duration_ms = "25";
    expect(compareConversationTelemetryParity(reasoningExpected, reasoningActual).differences).toEqual(
      [],
    );

    const generationExpected = structuredClone(reasoningExpected);
    const generationActual = structuredClone(reasoningActual);
    (
      generationExpected.report[0] as { event_extra_detail: Record<string, unknown> }
    ).event_extra_detail.step_type = "generation";
    (
      generationActual.report[0] as { event_extra_detail: Record<string, unknown> }
    ).event_extra_detail.step_type = "generation";
    expect(compareConversationTelemetryParity(generationExpected, generationActual).differences).toEqual([
      expect.objectContaining({
        category: "TIMING_INVARIANT_MISMATCH",
        path: "report[0].event_extra_detail.duration_ms",
      }),
    ]);
  });

  it("独立运行产生的 tool/stall 正耗时与 compaction runtime 水位只比较公式", () => {
    const expected: ConversationTelemetryFinalCapture = {
      report: [
        {
          element_name: "context_compaction",
          event_extra_detail: {
            status: "completed",
            pre_compact_tokens: "5000",
            post_compact_tokens: "250",
            true_post_compact_tokens: "5100",
            compact_ratio: "0.0500",
          },
        },
      ],
      arms: [
        {
          name: "perf_ui_tool_call_detail",
          value: 80,
          properties: { event_name: "perf_ui_tool_call_detail", metric_value: "80", total_ms: "80" },
        },
        {
          name: "perf_ui_stream_stall",
          value: 3990,
          properties: { event_name: "perf_ui_stream_stall", metric_value: "3990", stall_ms: "3990" },
        },
      ],
    };
    const actual: ConversationTelemetryFinalCapture = {
      report: [
        {
          element_name: "context_compaction",
          event_extra_detail: {
            status: "completed",
            pre_compact_tokens: "5002",
            post_compact_tokens: "250",
            true_post_compact_tokens: "5102",
            compact_ratio: "0.0500",
          },
        },
      ],
      arms: [
        {
          name: "perf_ui_tool_call_detail",
          value: 20,
          properties: { event_name: "perf_ui_tool_call_detail", metric_value: "20", total_ms: "20" },
        },
        {
          name: "perf_ui_stream_stall",
          value: 4010,
          properties: { event_name: "perf_ui_stream_stall", metric_value: "4010", stall_ms: "4010" },
        },
      ],
    };

    expect(compareConversationTelemetryParity(expected, actual).differences).toEqual([]);

    const broken = structuredClone(actual);
    (
      broken.report[0] as { event_extra_detail: Record<string, string> }
    ).event_extra_detail.compact_ratio = "0.5000";
    expect(compareConversationTelemetryParity(expected, broken).differences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "TIMING_INVARIANT_MISMATCH",
          path: "report.timing_invariants",
        }),
      ]),
    );
  });

  it("normalizer 不修改输入对象", () => {
    const capture = tdp02Capture({
      device: "device",
      eventPrefix: "event",
      message: "message",
      renderer: "renderer",
      request: "request",
      session: "session",
      step: "step",
      timestamp: 100,
    });
    const before = structuredClone(capture);
    normalizeConversationTelemetryCapture(capture);
    expect(capture).toEqual(before);
  });
});
