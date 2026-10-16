import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArmsCustomEventPayload, IPlatformService } from "@zcode/shared";
import { resetMessageTelemetryForTest } from "@/lib/messageTelemetry.js";
import {
  clearSendFunnelArmsReporterForTest,
  SEND_FUNNEL_ARMS_GROUP,
  setSendFunnelArmsReporter,
} from "@/lib/sendFunnelArmsTelemetry.js";
import {
  ConversationTelemetrySupervisor,
  resolveSendAckSettlement,
} from "@/v4/telemetry/conversationTelemetrySupervisor.js";

// Composer 发送漏斗埋点：send_input_focus → send_click → send_result，只走 ARMS。
// 口径见 docs/monitoring/composer-send-funnel-telemetry.md。

function createPlatform() {
  const reportTelemetryEvent = vi.fn(async () => undefined);
  const reportArmsCustomEvent = vi.fn(async () => undefined);
  return {
    platform: {
      reportTelemetryEvent,
      reportArmsCustomEvent,
    } as unknown as IPlatformService,
    reportTelemetryEvent,
    reportArmsCustomEvent,
  };
}

function armsEventsNamed(
  calls: ReturnType<typeof createPlatform>["reportArmsCustomEvent"],
  name: string,
): ArmsCustomEventPayload[] {
  return calls.mock.calls
    .map(([payload]) => payload as unknown as ArmsCustomEventPayload)
    .filter((payload) => payload.name === name);
}

function reportsByElement(
  calls: ReturnType<typeof createPlatform>["reportTelemetryEvent"],
  elementName: string,
) {
  return calls.mock.calls
    .map(([payload]) => payload)
    .filter((payload) => payload.elementName === elementName);
}

const SEED_DETAIL = {
  ask_mode: "build",
  model_name: "seed-model",
  model_provider: "seed-provider",
  agent: "glm",
  plan_status: "unknown",
  plan_product_id: "",
} as const;

function createSupervisor(clock: { value: number }, options: { installReporter?: boolean } = {}) {
  const { platform, reportTelemetryEvent, reportArmsCustomEvent } = createPlatform();
  // ARMS reporter 是模块级单例（Root.tsx 里按 isDesktop 安装），测试需显式装上。
  if (options.installReporter !== false) {
    setSendFunnelArmsReporter(platform);
  }
  const supervisor = new ConversationTelemetrySupervisor({
    platform,
    workspaceScopeKey: "base workspace 1",
    now: () => clock.value,
  });
  return { supervisor, reportTelemetryEvent, reportArmsCustomEvent };
}

describe("Composer 发送漏斗埋点（ARMS）", () => {
  beforeEach(() => {
    resetMessageTelemetryForTest();
  });

  afterEach(() => {
    clearSendFunnelArmsReporterForTest();
  });

  describe("send_input_focus", () => {
    it("用户真实聚焦上报一条，带 focus_time 与会话 scope", async () => {
      const clock = { value: 1_000 };
      const { supervisor, reportArmsCustomEvent } = createSupervisor(clock);

      supervisor.recordComposerFocusClick({ sessionId: "session-1" });
      await supervisor.flushReportsForTest();

      const events = armsEventsNamed(reportArmsCustomEvent, "send_input_focus");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        name: "send_input_focus",
        group: SEND_FUNNEL_ARMS_GROUP,
        value: 1,
        properties: {
          focus_time: 1_000,
          composer_scope: "session",
          talk_id: "session-1",
        },
      });
    });

    it("草稿态不下发 talk_id 且 scope 记为 draft", async () => {
      const clock = { value: 1_000 };
      const { supervisor, reportArmsCustomEvent } = createSupervisor(clock);

      supervisor.recordComposerFocusClick({ sessionId: null });
      await supervisor.flushReportsForTest();

      const properties = armsEventsNamed(reportArmsCustomEvent, "send_input_focus")[0].properties;
      expect(properties?.composer_scope).toBe("draft");
      expect(properties?.talk_id).toBeUndefined();
    });

    it("每次真实聚焦各记一条，不做时间窗去重", async () => {
      const clock = { value: 1_000 };
      const { supervisor, reportArmsCustomEvent } = createSupervisor(clock);

      supervisor.recordComposerFocusClick({ sessionId: "session-1" });
      clock.value = 1_050;
      supervisor.recordComposerFocusClick({ sessionId: "session-1" });
      await supervisor.flushReportsForTest();

      const events = armsEventsNamed(reportArmsCustomEvent, "send_input_focus");
      expect(events.map((event) => event.properties?.focus_time)).toEqual([1_000, 1_050]);
    });

    // 程序性聚焦（切会话/挂载回焦）由 Composer 侧拦截，不进入本方法；
    // 既有的 recordComposerFocus 只写时间戳，必须保持零上报。
    it("recordComposerFocus 仍然不产生任何上报", async () => {
      const clock = { value: 1_000 };
      const { supervisor, reportTelemetryEvent, reportArmsCustomEvent } = createSupervisor(clock);

      supervisor.recordComposerFocus();
      supervisor.recordComposerTextChange("hi");
      await supervisor.flushReportsForTest();

      expect(reportTelemetryEvent).not.toHaveBeenCalled();
      expect(reportArmsCustomEvent).not.toHaveBeenCalled();
    });
  });

  describe("send_click", () => {
    it("点击发送上报一条并回填 sendClickId", async () => {
      const clock = { value: 2_000 };
      const { supervisor, reportArmsCustomEvent } = createSupervisor(clock);

      const seed = supervisor.recordSendClick({
        sessionId: "session-1",
        trigger: "button",
        seed: { sendTime: 2_000, extraDetail: { ...SEED_DETAIL } },
      });
      await supervisor.flushReportsForTest();

      expect(seed.sendClickId).toBeTruthy();
      const events = armsEventsNamed(reportArmsCustomEvent, "send_click");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        name: "send_click",
        group: SEND_FUNNEL_ARMS_GROUP,
        value: 1,
        properties: {
          ...SEED_DETAIL,
          send_click_id: seed.sendClickId,
          input_send_time: 2_000,
          send_trigger: "button",
          composer_scope: "session",
          talk_id: "session-1",
        },
      });
    });

    it("Enter 提交记为 shortcut", async () => {
      const clock = { value: 2_000 };
      const { supervisor, reportArmsCustomEvent } = createSupervisor(clock);

      supervisor.recordSendClick({
        sessionId: "session-1",
        trigger: "shortcut",
        seed: { sendTime: 2_000, extraDetail: { ...SEED_DETAIL } },
      });
      await supervisor.flushReportsForTest();

      expect(armsEventsNamed(reportArmsCustomEvent, "send_click")[0].properties?.send_trigger).toBe(
        "shortcut",
      );
    });

    it("每次点击的 sendClickId 互不相同", () => {
      const clock = { value: 2_000 };
      const { supervisor } = createSupervisor(clock);

      const first = supervisor.recordSendClick({
        sessionId: "session-1",
        trigger: "button",
        seed: { sendTime: 2_000, extraDetail: {} },
      });
      const second = supervisor.recordSendClick({
        sessionId: "session-1",
        trigger: "button",
        seed: { sendTime: 2_100, extraDetail: {} },
      });

      expect(first.sendClickId).not.toBe(second.sendClickId);
    });
  });

  describe("send_result", () => {
    it("落定成功时 value 即 send_cost_ms", async () => {
      const clock = { value: 3_000 };
      const { supervisor, reportArmsCustomEvent } = createSupervisor(clock);
      const seed = supervisor.recordSendClick({
        sessionId: "session-1",
        trigger: "button",
        seed: { sendTime: 3_000, extraDetail: { ...SEED_DETAIL } },
      });

      clock.value = 3_180;
      supervisor.settleSendResult({
        seed,
        sessionId: "session-1",
        commandId: "command-1",
        status: "success",
        ackStatus: "accepted",
      });
      await supervisor.flushReportsForTest();

      const events = armsEventsNamed(reportArmsCustomEvent, "send_result");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        name: "send_result",
        group: SEND_FUNNEL_ARMS_GROUP,
        value: 180,
        properties: {
          ...SEED_DETAIL,
          send_click_id: seed.sendClickId,
          status: "success",
          ack_status: "accepted",
          send_cost_ms: 180,
          send_queue_confirmed: false,
          talk_id: "session-1",
          message_id: "command-1",
        },
      });
      // 成功时不下发 reason_code，避免 ARMS 侧出现空串维度。
      expect(events[0].properties?.reason_code).toBeUndefined();
    });

    it("send_click_id 与 send_click 严格配对", async () => {
      const clock = { value: 3_000 };
      const { supervisor, reportArmsCustomEvent } = createSupervisor(clock);
      const seed = supervisor.recordSendClick({
        sessionId: "session-1",
        trigger: "button",
        seed: { sendTime: 3_000, extraDetail: {} },
      });
      supervisor.settleSendResult({
        seed,
        sessionId: "session-1",
        commandId: "command-1",
        status: "success",
        ackStatus: "accepted",
      });
      await supervisor.flushReportsForTest();

      const click = armsEventsNamed(reportArmsCustomEvent, "send_click")[0];
      const result = armsEventsNamed(reportArmsCustomEvent, "send_result")[0];
      expect(result.properties?.send_click_id).toBe(click.properties?.send_click_id);
    });

    it("落定时保留原始 ack_status", async () => {
      const clock = { value: 3_000 };
      const { supervisor, reportArmsCustomEvent } = createSupervisor(clock);
      const seed = supervisor.recordSendClick({
        sessionId: "session-1",
        trigger: "button",
        seed: { sendTime: 3_000, extraDetail: {} },
      });

      supervisor.settleSendResult({
        seed,
        sessionId: "session-1",
        commandId: "command-1",
        status: "success",
        ackStatus: "duplicate",
      });
      await supervisor.flushReportsForTest();

      expect(armsEventsNamed(reportArmsCustomEvent, "send_result")[0].properties).toMatchObject({
        status: "success",
        ack_status: "duplicate",
      });
    });

    it.each([
      ["attachment_not_ready", undefined],
      ["blocked", undefined],
      ["rejected", "rejected"],
      ["stale", "stale"],
      ["failed", "failed"],
      ["render_timeout", "accepted"],
      ["transport_error", undefined],
      ["provider_not_ready", undefined],
      ["composer_error", undefined],
    ])("失败原因 %s 如实上报", async (reasonCode, ackStatus) => {
      const clock = { value: 4_000 };
      const { supervisor, reportArmsCustomEvent } = createSupervisor(clock);
      const seed = supervisor.recordSendClick({
        sessionId: "session-1",
        trigger: "button",
        seed: { sendTime: 4_000, extraDetail: {} },
      });

      clock.value = 4_050;
      supervisor.settleSendResult({
        seed,
        sessionId: "session-1",
        status: "fail",
        reasonCode,
        ...(ackStatus ? { ackStatus } : {}),
      });
      await supervisor.flushReportsForTest();

      const event = armsEventsNamed(reportArmsCustomEvent, "send_result")[0];
      expect(event.value).toBe(50);
      expect(event.properties).toMatchObject({
        status: "fail",
        reason_code: reasonCode,
        send_cost_ms: 50,
      });
      expect(event.properties?.ack_status).toBe(ackStatus);
    });

    it("未进入 dispatch 的失败不下发 message_id", async () => {
      const clock = { value: 4_000 };
      const { supervisor, reportArmsCustomEvent } = createSupervisor(clock);
      const seed = supervisor.recordSendClick({
        sessionId: null,
        trigger: "button",
        seed: { sendTime: 4_000, extraDetail: {} },
      });

      supervisor.settleSendResult({ seed, sessionId: null, status: "fail", reasonCode: "blocked" });
      await supervisor.flushReportsForTest();

      const properties = armsEventsNamed(reportArmsCustomEvent, "send_result")[0].properties;
      expect(properties?.talk_id).toBeUndefined();
      expect(properties?.message_id).toBeUndefined();
    });

    it("同一 sendClickId 只落定一次（first-wins）", async () => {
      const clock = { value: 5_000 };
      const { supervisor, reportArmsCustomEvent } = createSupervisor(clock);
      const seed = supervisor.recordSendClick({
        sessionId: "session-1",
        trigger: "button",
        seed: { sendTime: 5_000, extraDetail: {} },
      });

      supervisor.settleSendResult({
        seed,
        sessionId: "session-1",
        status: "success",
        ackStatus: "accepted",
      });
      supervisor.settleSendResult({
        seed,
        sessionId: "session-1",
        status: "fail",
        reasonCode: "rejected",
      });
      await supervisor.flushReportsForTest();

      const events = armsEventsNamed(reportArmsCustomEvent, "send_result");
      expect(events).toHaveLength(1);
      expect(events[0].properties?.status).toBe("success");
    });

    it("经过队列二次确认时标记 send_queue_confirmed 并从首次点击计时", async () => {
      const clock = { value: 6_000 };
      const { supervisor, reportArmsCustomEvent } = createSupervisor(clock);
      const seed = supervisor.recordSendClick({
        sessionId: "session-1",
        trigger: "button",
        seed: { sendTime: 6_000, extraDetail: {} },
      });

      // 用户在确认弹窗上停留 2s 后才确认。
      clock.value = 8_000;
      supervisor.settleSendResult({
        seed: { ...seed, queueConfirmed: true },
        sessionId: "session-1",
        status: "success",
        ackStatus: "accepted",
      });
      await supervisor.flushReportsForTest();

      const event = armsEventsNamed(reportArmsCustomEvent, "send_result")[0];
      expect(event.value).toBe(2_000);
      expect(event.properties).toMatchObject({ send_queue_confirmed: true, send_cost_ms: 2_000 });
    });

    it("缺少 sendClickId 的 seed（后台任务）不落定", async () => {
      const clock = { value: 7_000 };
      const { supervisor, reportArmsCustomEvent } = createSupervisor(clock);

      supervisor.settleSendResult({
        seed: { sendTime: 7_000, extraDetail: {} },
        sessionId: "session-1",
        status: "success",
        ackStatus: "accepted",
      });
      await supervisor.flushReportsForTest();

      expect(armsEventsNamed(reportArmsCustomEvent, "send_result")).toHaveLength(0);
    });
  });

  // 「发送成功」= 用户消息真的画到对话历史里，不是 ACK 被 Host 受理。
  // z-code 没有乐观渲染，两者之间还隔着一次投影回流 + 一次 React 渲染。
  describe("待渲染等待（send_result 端到端口径）", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /** 走完「点击发送 → ACK」两步，返回 seed 与其余测试句柄。 */
    function ackedSend(
      clock: { value: number },
      options: { ackStatus?: string; sendTime?: number; ackAt?: number } = {},
    ) {
      const sendTime = options.sendTime ?? 10_000;
      clock.value = sendTime;
      const handles = createSupervisor(clock);
      const seed = handles.supervisor.recordSendClick({
        sessionId: "session-1",
        trigger: "button",
        seed: { sendTime, extraDetail: { ...SEED_DETAIL } },
      });
      clock.value = options.ackAt ?? sendTime + 120;
      handles.supervisor.awaitSendRender({
        seed,
        sessionId: "session-1",
        commandId: "command-1",
        ackStatus: options.ackStatus ?? "accepted",
      });
      return { ...handles, seed, sendTime };
    }

    it("ACK accepted 后不立即上报 send_result", async () => {
      const clock = { value: 0 };
      const { supervisor, reportArmsCustomEvent } = ackedSend(clock);
      await supervisor.flushReportsForTest();

      expect(armsEventsNamed(reportArmsCustomEvent, "send_click")).toHaveLength(1);
      expect(armsEventsNamed(reportArmsCustomEvent, "send_result")).toHaveLength(0);
    });

    it("用户消息渲染后才落定，value 为端到端耗时并单独留 ack_cost_ms", async () => {
      const clock = { value: 0 };
      const { supervisor, reportArmsCustomEvent } = ackedSend(clock, {
        sendTime: 10_000,
        ackAt: 10_120,
      });

      clock.value = 10_450;
      supervisor.notifyUserInputRendered("command-1");
      await supervisor.flushReportsForTest();

      const events = armsEventsNamed(reportArmsCustomEvent, "send_result");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        value: 450,
        properties: {
          ...SEED_DETAIL,
          status: "success",
          ack_status: "accepted",
          send_cost_ms: 450,
          ack_cost_ms: 120,
          talk_id: "session-1",
          message_id: "command-1",
        },
      });
      expect(events[0].properties?.reason_code).toBeUndefined();
    });

    it("duplicate ACK 与 accepted 走同一条等待路径", async () => {
      const clock = { value: 0 };
      const { supervisor, reportArmsCustomEvent } = ackedSend(clock, { ackStatus: "duplicate" });
      expect(armsEventsNamed(reportArmsCustomEvent, "send_result")).toHaveLength(0);

      clock.value = 10_300;
      supervisor.notifyUserInputRendered("command-1");
      await supervisor.flushReportsForTest();

      expect(armsEventsNamed(reportArmsCustomEvent, "send_result")[0].properties).toMatchObject({
        status: "success",
        ack_status: "duplicate",
      });
    });

    it("30s 内没等到渲染则报 render_timeout，send_cost_ms 取 30000", async () => {
      const clock = { value: 0 };
      const { supervisor, reportArmsCustomEvent } = ackedSend(clock, {
        sendTime: 10_000,
        ackAt: 10_120,
      });

      // 超时口径从点击发送起算，故定时器落在 sendTime + 30s。
      clock.value = 40_000;
      await vi.advanceTimersByTimeAsync(30_000);
      await supervisor.flushReportsForTest();

      const events = armsEventsNamed(reportArmsCustomEvent, "send_result");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        value: 30_000,
        properties: {
          status: "fail",
          reason_code: "render_timeout",
          ack_status: "accepted",
          send_cost_ms: 30_000,
          ack_cost_ms: 120,
        },
      });
    });

    it("渲染先到则超时定时器不再补报（first-wins）", async () => {
      const clock = { value: 0 };
      const { supervisor, reportArmsCustomEvent } = ackedSend(clock);

      clock.value = 10_500;
      supervisor.notifyUserInputRendered("command-1");
      await vi.advanceTimersByTimeAsync(60_000);
      await supervisor.flushReportsForTest();

      const events = armsEventsNamed(reportArmsCustomEvent, "send_result");
      expect(events).toHaveLength(1);
      expect(events[0].properties?.status).toBe("success");
    });

    it("超时先到则迟到的渲染信号不再上报（first-wins）", async () => {
      const clock = { value: 0 };
      const { supervisor, reportArmsCustomEvent } = ackedSend(clock);

      clock.value = 40_000;
      await vi.advanceTimersByTimeAsync(30_000);
      clock.value = 41_000;
      supervisor.notifyUserInputRendered("command-1");
      await supervisor.flushReportsForTest();

      const events = armsEventsNamed(reportArmsCustomEvent, "send_result");
      expect(events).toHaveLength(1);
      expect(events[0].properties?.reason_code).toBe("render_timeout");
    });

    // 历史消息回填 / 切会话重载都会推出一堆 userInput row，不能误当成本次发送的落定信号。
    it("未登记的 commandId 渲染信号不触发上报", async () => {
      const clock = { value: 0 };
      const { supervisor, reportArmsCustomEvent } = ackedSend(clock);

      clock.value = 10_500;
      supervisor.notifyUserInputRendered("command-from-history");
      await supervisor.flushReportsForTest();

      expect(armsEventsNamed(reportArmsCustomEvent, "send_result")).toHaveLength(0);
    });

    it("后台任务 seed（无 sendClickId）不登记待渲染", async () => {
      const clock = { value: 10_000 };
      const { supervisor, reportArmsCustomEvent } = createSupervisor(clock);

      supervisor.awaitSendRender({
        seed: { sendTime: 10_000, extraDetail: {} },
        sessionId: "session-1",
        commandId: "command-bg",
        ackStatus: "accepted",
      });
      clock.value = 10_300;
      supervisor.notifyUserInputRendered("command-bg");
      await vi.advanceTimersByTimeAsync(60_000);
      await supervisor.flushReportsForTest();

      expect(armsEventsNamed(reportArmsCustomEvent, "send_result")).toHaveLength(0);
    });

    it("dispose 后超时定时器不再上报", async () => {
      const clock = { value: 0 };
      const { supervisor, reportArmsCustomEvent } = ackedSend(clock);

      supervisor.dispose();
      clock.value = 40_000;
      await vi.advanceTimersByTimeAsync(60_000);
      await supervisor.flushReportsForTest();

      expect(armsEventsNamed(reportArmsCustomEvent, "send_result")).toHaveLength(0);
    });
  });

  describe("resolveSendAckSettlement（ACK → 落定口径）", () => {
    // accepted/duplicate 不再是终态：此时用户消息还没画到屏幕上，
    // 要等投影回流出 userInput row 才算「发送成功」。
    it("accepted 与 duplicate 转入待渲染等待", () => {
      expect(resolveSendAckSettlement({ status: "accepted" })).toEqual({
        kind: "awaitRender",
        ackStatus: "accepted",
      });
      expect(resolveSendAckSettlement({ status: "duplicate" })).toEqual({
        kind: "awaitRender",
        ackStatus: "duplicate",
      });
    });

    it.each([
      ["rejected", "rejected"],
      ["stale", "stale"],
      ["failed", "failed"],
    ])("%s 立即落定并原样落到 reason_code", (ackStatus, reasonCode) => {
      expect(resolveSendAckSettlement({ status: ackStatus })).toEqual({
        kind: "settle",
        status: "fail",
        ackStatus,
        reasonCode,
      });
    });

    // noop 不单列 reason_code，用户视角就是没发出去；原始值靠 ack_status 下钻。
    it("noop 归口到 failed 但保留原始 ack_status", () => {
      expect(resolveSendAckSettlement({ status: "noop" })).toEqual({
        kind: "settle",
        status: "fail",
        ackStatus: "noop",
        reasonCode: "failed",
      });
    });

    // 队列二次确认不是终态：落定会让 first-wins 吃掉随后真实的成败。
    it("队列二次确认的 ACK 既不落定也不等待渲染", () => {
      expect(
        resolveSendAckSettlement({
          status: "rejected",
          reasonCode: "guard.heldQueueConfirmationStale",
        }),
      ).toBeNull();
    });

    it("其余 reasonCode 不影响落定", () => {
      expect(
        resolveSendAckSettlement({ status: "rejected", reasonCode: "guard.somethingElse" }),
      ).toEqual({ kind: "settle", status: "fail", ackStatus: "rejected", reasonCode: "rejected" });
    });
  });

  describe("与 /event/report 通道的隔离", () => {
    it("三个漏斗事件完全不走 reportTelemetryEvent", async () => {
      const clock = { value: 100 };
      const { supervisor, reportTelemetryEvent } = createSupervisor(clock);

      supervisor.recordComposerFocusClick({ sessionId: "session-1" });
      const seed = supervisor.recordSendClick({
        sessionId: "session-1",
        trigger: "button",
        seed: { sendTime: 100, extraDetail: { ...SEED_DETAIL } },
      });
      supervisor.settleSendResult({
        seed,
        sessionId: "session-1",
        commandId: "command-1",
        status: "success",
        ackStatus: "accepted",
      });
      await supervisor.flushReportsForTest();

      expect(reportTelemetryEvent).not.toHaveBeenCalled();
    });

    it("新事件不改变 send_btn 的时机与字段", async () => {
      const clock = { value: 100 };
      const { supervisor, reportTelemetryEvent } = createSupervisor(clock);

      supervisor.recordComposerFocusClick({ sessionId: null });
      supervisor.recordComposerFocus();
      clock.value = 120;
      supervisor.recordComposerTextChange("hello");
      clock.value = 200;
      const seed = supervisor.recordSendClick({
        sessionId: null,
        trigger: "button",
        seed: { sendTime: 200, extraDetail: { ...SEED_DETAIL } },
      });
      clock.value = 260;
      supervisor.acceptPromptSeed({
        ...seed,
        sessionId: "session-1",
        sourceCommandId: "command-1",
      });
      supervisor.settleSendResult({
        seed,
        sessionId: "session-1",
        commandId: "command-1",
        status: "success",
        ackStatus: "accepted",
      });
      await supervisor.flushReportsForTest();

      const send = reportsByElement(reportTelemetryEvent, "send_btn");
      expect(send).toHaveLength(1);
      expect(send[0]).toMatchObject({
        eventRegion: "app",
        eventType: "ck",
        talkId: "session-1",
        messageId: "command-1",
        eventExtraDetail: {
          ...SEED_DETAIL,
          input_start_time: "100",
          input_first_char_time: "120",
          input_send_time: "200",
        },
      });
      // send_btn 不得混入漏斗字段。
      expect(send[0].eventExtraDetail).not.toHaveProperty("send_click_id");
      expect(send[0].eventExtraDetail).not.toHaveProperty("send_cost_ms");
    });

    it("后台自动任务不产生任何漏斗事件", async () => {
      const clock = { value: 100 };
      const { supervisor, reportTelemetryEvent, reportArmsCustomEvent } = createSupervisor(clock);

      supervisor.acceptPromptSeed(
        {
          sessionId: "session-1",
          sourceCommandId: "background-command",
          sendTime: 100,
          extraDetail: { message_source: "scheduled_task" },
        },
        { reportSendButton: false },
      );
      await supervisor.flushReportsForTest();

      expect(armsEventsNamed(reportArmsCustomEvent, "send_input_focus")).toHaveLength(0);
      expect(armsEventsNamed(reportArmsCustomEvent, "send_click")).toHaveLength(0);
      expect(armsEventsNamed(reportArmsCustomEvent, "send_result")).toHaveLength(0);
      expect(reportsByElement(reportTelemetryEvent, "send_btn")).toHaveLength(0);
    });
  });

  describe("reporter 未安装时静默", () => {
    // Web / 手机远控不装 reporter（Root.tsx 按 isDesktop 门控），整组必须静默。
    it("未安装 reporter 时不调用 platform", async () => {
      const clock = { value: 100 };
      const { supervisor, reportArmsCustomEvent } = createSupervisor(clock, {
        installReporter: false,
      });

      supervisor.recordComposerFocusClick({ sessionId: "session-1" });
      const seed = supervisor.recordSendClick({
        sessionId: "session-1",
        trigger: "button",
        seed: { sendTime: 100, extraDetail: {} },
      });
      supervisor.settleSendResult({
        seed,
        sessionId: "session-1",
        status: "success",
        ackStatus: "accepted",
      });
      await supervisor.flushReportsForTest();

      expect(reportArmsCustomEvent).not.toHaveBeenCalled();
    });
  });

  describe("dispose 后静默", () => {
    it("dispose 后三个事件都不再上报", async () => {
      const clock = { value: 100 };
      const { supervisor, reportArmsCustomEvent } = createSupervisor(clock);
      const seed = supervisor.recordSendClick({
        sessionId: "session-1",
        trigger: "button",
        seed: { sendTime: 100, extraDetail: {} },
      });
      await supervisor.flushReportsForTest();
      reportArmsCustomEvent.mockClear();

      supervisor.dispose();
      supervisor.recordComposerFocusClick({ sessionId: "session-1" });
      supervisor.recordSendClick({
        sessionId: "session-1",
        trigger: "button",
        seed: { sendTime: 200, extraDetail: {} },
      });
      supervisor.settleSendResult({
        seed,
        sessionId: "session-1",
        status: "success",
        ackStatus: "accepted",
      });
      await supervisor.flushReportsForTest();

      expect(reportArmsCustomEvent).not.toHaveBeenCalled();
    });
  });
});
