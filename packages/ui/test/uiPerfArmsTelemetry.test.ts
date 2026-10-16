import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArmsCustomEventPayload } from "@zcode/shared";
import {
  INPUT_LAG_REPORT_THRESHOLD_MS,
  INPUT_LAG_SANITY_MAX_MS,
  LAUNCH_TO_INPUT_SANITY_MAX_MS,
  STREAM_STALL_REPORT_THRESHOLD_MS,
  UI_PERF_ARMS_GROUP,
  UI_PERF_EVENT_INPUT_LAG,
  UI_PERF_EVENT_LAUNCH_ELECTRON_INIT,
  UI_PERF_EVENT_LAUNCH_REACT_COMMIT,
  UI_PERF_EVENT_LAUNCH_STARTUP_GATE,
  UI_PERF_EVENT_LAUNCH_TO_INPUT,
  UI_PERF_EVENT_TOOL_CALL_DETAIL,
  UI_PERF_EVENT_TURN_BREAKDOWN,
  clearStreamStallTracking,
  clearUiPerfArmsReporterForTest,
  recordStreamChunkArrival,
  recordInputLag,
  reportUiFirstToken,
  reportUiLaunchToInput,
  reportUiMessageComplete,
  reportUiToolCallDetail,
  reportUiTurnBreakdown,
  setUiPerfArmsReporter,
  shouldReportInputLag,
} from "@/lib/uiPerfArmsTelemetry.js";

function makeReporter() {
  const calls: ArmsCustomEventPayload[] = [];
  return {
    calls,
    reportArmsCustomEvent: vi.fn(async (payload: ArmsCustomEventPayload) => {
      calls.push(payload);
    }),
  };
}

function makeTimings(
  overrides?: Partial<{
    createdAt: number;
    mainStart: number;
    appReady: number;
    loadUrl: number;
    rendererStart: number;
    reactCommit: number;
    inputReady: number;
  }>,
) {
  const base = {
    createdAt: 1000,
    mainStart: 1600, // electron_init = 600
    appReady: 1780, // app_ready = 180
    loadUrl: 2020, // window = 240
    rendererStart: 2930, // renderer_load = 910
    reactCommit: 3005, // react_commit = 75
    inputReady: 3820, // startup_gate = 815, total = 2820
    ...overrides,
  };
  return {
    marks: {
      createdAt: base.createdAt,
      mainStart: base.mainStart,
      appReady: base.appReady,
      loadUrl: base.loadUrl,
    },
    rendererStart: base.rendererStart,
    reactCommit: base.reactCommit,
    inputReady: base.inputReady,
    sessionId: "sess-1",
  };
}

afterEach(() => {
  clearUiPerfArmsReporterForTest();
  vi.restoreAllMocks();
});

describe("uiPerfArmsTelemetry: 通用", () => {
  it("未注入 reporter 时静默不抛错", () => {
    expect(() => reportUiLaunchToInput(makeTimings())).not.toThrow();
  });

  it("reportUiFirstToken 带 model/talk_id/message_id", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    reportUiFirstToken({
      ttftMs: 800,
      model: "glm-4.6",
      talkId: "t1",
      messageId: "m1",
    });
    expect(reporter.calls[0]).toMatchObject({
      name: "perf_ui_first_token",
      group: UI_PERF_ARMS_GROUP,
      value: 800,
      properties: { model: "glm-4.6", talk_id: "t1", message_id: "m1" },
    });
  });

  it("未命中白名单的模型归一为 custom，不原样透传", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    reportUiFirstToken({ ttftMs: 800, model: "internal-preview-model", talkId: "t1" });
    expect(reporter.calls[0]?.properties?.model).toBe("custom");
  });

  it("自定义 provider 的编码模型值不泄露 provider 名与模型名", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    reportUiMessageComplete({
      durationMs: 1000,
      result: "success",
      model: "custom:%E5%86%85%E7%BD%91%E4%BB%A3%E7%90%86:secret-model",
      talkId: "t1",
    });
    const model = reporter.calls[0]?.properties?.model;
    expect(model).toBe("custom");
    expect(String(model)).not.toContain("secret-model");
  });

  it("supervisor 投影出的旧报表身份复合值与编码值保留白名单模型", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    reportUiFirstToken({ ttftMs: 800, model: "builtin:zai-start-plan/GLM-5.3", talkId: "t1" });
    reportUiFirstToken({
      ttftMs: 800,
      model: "custom:builtin%3Azai-start-plan:glm-5.3",
      talkId: "t1",
    });
    expect(reporter.calls.map((call) => call.properties?.model)).toEqual(["glm-5.3", "glm-5.3"]);
  });

  it("model 缺失时保持留空，不引入 custom 噪音", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    reportUiFirstToken({ ttftMs: 800, talkId: "t1" });
    expect(reporter.calls[0]?.properties?.model).toBeUndefined();
  });

  it("reportUiMessageComplete 带 result/model", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    reportUiMessageComplete({
      durationMs: 5000,
      result: "success",
      model: "glm-4.6",
      talkId: "t1",
      messageId: "m1",
    });
    expect(reporter.calls[0]).toMatchObject({
      name: "perf_ui_message_complete",
      group: UI_PERF_ARMS_GROUP,
      value: 5000,
      properties: {
        result: "success",
        model: "glm-4.6",
        talk_id: "t1",
        message_id: "m1",
      },
    });
  });

  it("reportUiTurnBreakdown 每轮只上报归因汇总字段", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    reportUiTurnBreakdown({
      durationMs: 9000.4,
      result: "success",
      model: "glm-4.6",
      talkId: "task-1",
      messageId: "message-1",
      ttftMs: 1200.5,
      waitingMs: 300.4,
      toolCallTotal: 2,
      toolCallFailed: 1,
      agentStepCount: 4,
      retryCount: 1,
      fileChangeCount: 3,
      generatedCodeLines: 20,
    });

    expect(reporter.calls[0]).toEqual({
      name: UI_PERF_EVENT_TURN_BREAKDOWN,
      group: UI_PERF_ARMS_GROUP,
      value: 9000,
      properties: {
        result: "success",
        model: "glm-4.6",
        talk_id: "task-1",
        message_id: "message-1",
        duration_ms: 9000,
        ttft_ms: 1201,
        waiting_ms: 300,
        tool_call_total: 2,
        tool_call_failed: 1,
        agent_step_cnt: 4,
        retry_cnt: 1,
        file_change_cnt: 3,
        generated_code_lines: 20,
      },
    });
  });

  it("reportUiToolCallDetail 上报工具内部阶段耗时和脱敏聚合字段", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    reportUiToolCallDetail({
      toolName: "Bash",
      status: "completed",
      talkId: "task-1",
      messageId: "message-1",
      toolCallId: "tool-1",
      parentToolCallId: "parent-tool-1",
      childToolCallId: "child-tool-1",
      childSessionId: "child-session-1",
      agentId: "agent-1",
      agentType: "Explore",
      totalMs: 1500,
      permissionWaitMs: 120,
      commandRunMs: 1300,
      firstOutputMs: 40,
      noOutputMs: 40,
      exitCode: 0,
      timedOut: false,
      outputBytes: 512,
      commandCategory: "test",
      commandName: "npm",
      commandCount: 1,
      commandStatus: "completed",
      fsReadMs: 1,
      fsWriteMs: 2,
      patchMatchMs: 3,
      fileCount: 1,
      totalBytes: 100,
      maxFileBytes: 100,
      hunkCount: 2,
      matchAttempts: 1,
      workspaceKind: "local",
    });

    expect(reporter.calls[0]).toEqual({
      name: UI_PERF_EVENT_TOOL_CALL_DETAIL,
      group: UI_PERF_ARMS_GROUP,
      value: 1500,
      properties: {
        tool_name: "Bash",
        status: "completed",
        talk_id: "task-1",
        message_id: "message-1",
        tool_call_id: "tool-1",
        parent_tool_call_id: "parent-tool-1",
        child_tool_call_id: "child-tool-1",
        child_session_id: "child-session-1",
        agent_id: "agent-1",
        agent_type: "Explore",
        total_ms: 1500,
        permission_wait_ms: 120,
        command_run_ms: 1300,
        first_output_ms: 40,
        no_output_ms: 40,
        exit_code: 0,
        timed_out: false,
        output_bytes: 512,
        command_category: "test",
        command_name: "npm",
        command_count: 1,
        command_status: "completed",
        fs_read_ms: 1,
        fs_write_ms: 2,
        patch_match_ms: 3,
        file_count: 1,
        total_bytes: 100,
        max_file_bytes: 100,
        hunk_count: 2,
        match_attempts: 1,
        workspace_kind: "local",
      },
    });
  });

  it("reporter 抛错被吞掉不向上传播", () => {
    const reporter = {
      reportArmsCustomEvent: vi.fn(() => {
        throw new Error("boom");
      }),
    };
    setUiPerfArmsReporter(reporter);
    expect(() => reportUiLaunchToInput(makeTimings())).not.toThrow();
  });
});

describe("agent step ARMS volume guard", () => {
  afterEach(() => {
    clearUiPerfArmsReporterForTest();
  });

  it("不再暴露逐 step ARMS 上报入口，避免长消息按 step 数放大 IPC 和自定义事件量", async () => {
    const telemetry = await import("@/lib/uiPerfArmsTelemetry.js");
    expect("reportUiAgentStep" in telemetry).toBe(false);
  });
});

describe("reportUiLaunchToInput: 7 段", () => {
  it("发 7 条，各段 value 正确，total = inputReady - createdAt", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    reportUiLaunchToInput(makeTimings());
    expect(reporter.calls).toHaveLength(7);
    const byName = new Map(reporter.calls.map((c) => [c.name, c]));
    expect(byName.get(UI_PERF_EVENT_LAUNCH_TO_INPUT)).toMatchObject({
      group: UI_PERF_ARMS_GROUP,
      value: 2820,
      properties: { session_id: "sess-1" },
    });
    expect(byName.get(UI_PERF_EVENT_LAUNCH_ELECTRON_INIT)?.value).toBe(600);
    expect(byName.get(UI_PERF_EVENT_LAUNCH_REACT_COMMIT)?.value).toBe(75);
    expect(byName.get(UI_PERF_EVENT_LAUNCH_STARTUP_GATE)?.value).toBe(815);
  });

  it("某段为负（时钟回拨/跨进程偏移）→ 整批丢弃", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    // appReady 早于 mainStart：app_ready 段为负，整批丢弃
    reportUiLaunchToInput(makeTimings({ appReady: 1500, mainStart: 1600 }));
    expect(reporter.calls).toHaveLength(0);
  });

  it("总时长超哨兵阈值 → 整批不发", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    reportUiLaunchToInput(makeTimings({ inputReady: 1000 + LAUNCH_TO_INPUT_SANITY_MAX_MS + 1 }));
    expect(reporter.calls).toHaveLength(0);
  });
});

describe("stream stall", () => {
  it("首个 chunk 不上报(无前序)", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    recordStreamChunkArrival("t1", { now: 1000 });
    expect(reporter.calls).toHaveLength(0);
  });

  it("间隔未超阈值不上报", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    recordStreamChunkArrival("t1", { now: 1000 });
    recordStreamChunkArrival("t1", {
      now: 1000 + STREAM_STALL_REPORT_THRESHOLD_MS,
    });
    expect(reporter.calls).toHaveLength(0);
  });

  it("间隔超阈值上报真实时长", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    recordStreamChunkArrival("t1", { now: 1000 });
    recordStreamChunkArrival("t1", {
      now: 1000 + STREAM_STALL_REPORT_THRESHOLD_MS + 500,
      waitingTool: true,
      messageId: "m1",
      model: "glm-4.6",
      chunkType: "thought",
    });
    expect(reporter.calls).toHaveLength(1);
    expect(reporter.calls[0]).toMatchObject({
      name: "perf_ui_stream_stall",
      value: STREAM_STALL_REPORT_THRESHOLD_MS + 500,
      properties: {
        waiting_tool: true,
        model: "glm-4.6",
        talk_id: "t1",
        message_id: "m1",
        chunk_type: "thought",
      },
    });
  });

  it("messageId 缺省时 message_id 留空", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    recordStreamChunkArrival("t1", { now: 1000 });
    recordStreamChunkArrival("t1", {
      now: 1000 + STREAM_STALL_REPORT_THRESHOLD_MS + 500,
    });
    expect(reporter.calls[0]?.properties?.message_id).toBeUndefined();
  });

  it("clearStreamStallTracking 后重置(下一个 chunk 视为首个)", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    recordStreamChunkArrival("t1", { now: 1000 });
    clearStreamStallTracking("t1");
    recordStreamChunkArrival("t1", { now: 100000 });
    expect(reporter.calls).toHaveLength(0);
  });
});

describe("input lag - shouldReportInputLag", () => {
  it("低于阈值不上报", () => {
    expect(
      shouldReportInputLag({
        lagMs: INPUT_LAG_REPORT_THRESHOLD_MS,
        isProgrammatic: false,
        isComposing: false,
      }),
    ).toBe(false);
  });

  it("超过阈值上报", () => {
    expect(
      shouldReportInputLag({
        lagMs: INPUT_LAG_REPORT_THRESHOLD_MS + 1,
        isProgrammatic: false,
        isComposing: false,
      }),
    ).toBe(true);
  });

  it("超过哨兵上限不上报", () => {
    expect(
      shouldReportInputLag({
        lagMs: INPUT_LAG_SANITY_MAX_MS + 1,
        isProgrammatic: false,
        isComposing: false,
      }),
    ).toBe(false);
  });

  it("程序化改写即使超阈也不上报", () => {
    expect(
      shouldReportInputLag({
        lagMs: INPUT_LAG_REPORT_THRESHOLD_MS + 1000,
        isProgrammatic: true,
        isComposing: false,
      }),
    ).toBe(false);
  });

  it("IME 组合态即使超阈也不上报", () => {
    expect(
      shouldReportInputLag({
        lagMs: INPUT_LAG_REPORT_THRESHOLD_MS + 1000,
        isProgrammatic: false,
        isComposing: true,
      }),
    ).toBe(false);
  });
});

describe("input lag - recordInputLag", () => {
  it("超阈上报,payload 字段正确", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    recordInputLag({
      lagMs: 642.7,
      textLength: 1280,
      isProgrammatic: false,
      isComposing: false,
      taskId: "t1",
    });
    expect(reporter.calls).toHaveLength(1);
    expect(reporter.calls[0]).toMatchObject({
      name: UI_PERF_EVENT_INPUT_LAG,
      group: UI_PERF_ARMS_GROUP,
      value: 643,
      properties: {
        lag_ms: 643,
        text_length: 1280,
        task_id: "t1",
      },
    });
  });

  it("不满足上报条件时静默", () => {
    const reporter = makeReporter();
    setUiPerfArmsReporter(reporter);
    recordInputLag({
      lagMs: 100,
      textLength: 5,
      isProgrammatic: false,
      isComposing: false,
    });
    expect(reporter.calls).toHaveLength(0);
  });

  it("无 reporter 时不抛", () => {
    clearUiPerfArmsReporterForTest();
    expect(() =>
      recordInputLag({
        lagMs: 9999,
        textLength: 10,
        isProgrammatic: false,
        isComposing: false,
      }),
    ).not.toThrow();
  });

  it("reporter 抛错时只 warn 不向上传播", () => {
    const reporter = {
      reportArmsCustomEvent: vi.fn(() => {
        throw new Error("boom");
      }),
    };
    setUiPerfArmsReporter(reporter);
    expect(() =>
      recordInputLag({
        lagMs: INPUT_LAG_REPORT_THRESHOLD_MS + 1000,
        textLength: 10,
        isProgrammatic: false,
        isComposing: false,
      }),
    ).not.toThrow();
    expect(reporter.reportArmsCustomEvent).toHaveBeenCalledTimes(1);
  });
});
