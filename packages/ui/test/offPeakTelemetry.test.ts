import { describe, expect, it, vi } from "vitest";
import type { IPlatformService, OffPeakTaskCreateResult } from "@zcode/shared";
import {
  buildOffPeakCreateResultTelemetryPayload,
  createAndReportOffPeakTask,
  freezeOffPeakCreateTelemetrySnapshot,
  reportOffPeakCreateResult,
} from "@/lib/offPeakTelemetry.js";

const success = {
  ok: true,
  task: {
    offPeakTaskId: "offpeak-stable-1",
    serverTicketId: "forbidden-ticket",
    title: "forbidden title",
    prompt: "forbidden prompt",
    permissionMode: "build",
    workspaceKey: "/forbidden/workspace",
    workspacePath: "/forbidden/workspace",
    status: "queued",
    queuedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  },
  ticketInitialState: "queued",
  providerName: "api.example.com",
} satisfies OffPeakTaskCreateResult;

describe("Off-Peak create telemetry V1", () => {
  it("冻结首页模板、Automations 模板和直接创建三种来源", () => {
    expect(
      freezeOffPeakCreateTelemetrySnapshot({
        source: { eventRegion: "app.session", templateId: "standupGitSummary" },
        model: " GLM-5.2 ",
        providerId: "account:zai-offpeak-idle-plan",
      }),
    ).toEqual({
      eventRegion: "app.session",
      templateId: "standupGitSummary",
      modelName: "GLM-5.2",
      modelProvider: "offpeak-idle-plan",
    });
    expect(
      freezeOffPeakCreateTelemetrySnapshot({
        source: { eventRegion: "app.automations", templateId: "ciFlakyReport" },
        model: "GLM-5.2",
      }),
    ).toMatchObject({
      eventRegion: "app.automations",
      templateId: "ciFlakyReport",
    });
    expect(freezeOffPeakCreateTelemetrySnapshot({ model: "GLM-5.2" })).toMatchObject({
      eventRegion: "app.automations",
      templateId: "",
    });
  });

  it("成功 payload 必填空 key、无 event_value，且只投影隐私 allowlist", () => {
    const snapshot = freezeOffPeakCreateTelemetrySnapshot({
      source: { eventRegion: "app.session", templateId: "template-1" },
      model: "GLM-5.2",
      providerId: "account:zai-offpeak-idle-plan",
    });
    const payload = buildOffPeakCreateResultTelemetryPayload(snapshot, success);
    expect(payload).toEqual({
      elementName: "off_peak_task_create_result",
      eventRegion: "app.session",
      eventType: "result",
      eventText: "",
      eventExtraDetail: {
        result: "success",
        template_id: "template-1",
        model_name: "GLM-5.2",
        model_provider: "offpeak-idle-plan",
        provider_name: "api.example.com",
        off_peak_task_id: "offpeak-stable-1",
        ticket_initial_state: "queued",
        queue_position: "",
      },
    });
    expect(payload).not.toHaveProperty("eventValue");
    const serialized = JSON.stringify(payload);
    for (const forbidden of [
      "forbidden-ticket",
      "forbidden title",
      "forbidden prompt",
      "/forbidden/workspace",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("失败 payload 只含稳定 stage/category/code，不含 success 字段", () => {
    const payload = buildOffPeakCreateResultTelemetryPayload(
      freezeOffPeakCreateTelemetrySnapshot({ model: "GLM-5.2" }),
      {
        ok: false,
        failureStage: "ticket_request",
        errorCategory: "quota_3103",
        errorCode: "3103",
        providerName: "api.example.com",
      },
    );
    expect(payload.eventExtraDetail).toMatchObject({
      result: "failure",
      failure_stage: "ticket_request",
      error_category: "quota_3103",
      error_code: "3103",
    });
    expect(payload.eventExtraDetail).not.toHaveProperty("off_peak_task_id");
    expect(payload.eventExtraDetail).not.toHaveProperty("ticket_initial_state");
  });

  it("一次调用只报告一次，reporter 失败被 best-effort 边界吞掉", async () => {
    const reportTelemetryEvent = vi.fn().mockRejectedValue(new Error("network"));
    const platform = {
      reportTelemetryEvent,
    } as unknown as Pick<IPlatformService, "reportTelemetryEvent">;
    await expect(
      reportOffPeakCreateResult(
        platform,
        freezeOffPeakCreateTelemetrySnapshot({ model: "GLM-5.2" }),
        success,
      ),
    ).resolves.toBeUndefined();
    expect(reportTelemetryEvent).toHaveBeenCalledOnce();
  });

  it("每次 submit 等业务结果后只调度一个 final result event", async () => {
    const reportTelemetryEvent = vi.fn(async () => undefined);
    const create = vi.fn(async () => success);
    const platform = {
      reportTelemetryEvent,
    } as unknown as Pick<IPlatformService, "reportTelemetryEvent">;
    const snapshot = freezeOffPeakCreateTelemetrySnapshot({
      source: { eventRegion: "app.session", templateId: "frozen-template" },
      model: "GLM-5.2",
    });
    await expect(createAndReportOffPeakTask(platform, snapshot, create)).resolves.toBe(success);
    await vi.waitFor(() => expect(reportTelemetryEvent).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledOnce();
    expect(reportTelemetryEvent.mock.calls[0]?.[0]).toMatchObject({
      eventRegion: "app.session",
      eventExtraDetail: { template_id: "frozen-template" },
    });
  });
});
