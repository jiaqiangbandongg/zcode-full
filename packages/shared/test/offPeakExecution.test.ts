import { describe, expect, it } from "vitest";
import { modelExecutionSchema } from "../src/model-execution.js";
import {
  offPeakLifecycleNotificationSchema,
  offPeakControlParamsSchema,
} from "../src/off-peak-execution.js";

describe("闲时驻内存执行协议", () => {
  it("接受后台执行元数据，生命周期通知严格拒绝凭据", () => {
    expect(
      modelExecutionSchema.parse({
        selectionScope: "execution",
        offPeak: { executionId: "run", ticketId: "ticket", providerErrorCode: "3102" },
        subagents: { foregroundModel: "submission", background: "allow" },
      }).offPeak?.executionId,
    ).toBe("run");
    const event = {
      sessionId: "session",
      executionId: "run",
      offPeakTaskId: "task",
      type: "ticket_needed",
      renewalId: 1,
      expiredTicketId: "ticket",
    };
    expect(offPeakLifecycleNotificationSchema.parse(event)).toEqual(event);
    expect(
      offPeakLifecycleNotificationSchema.safeParse({ ...event, requestAuth: { apiKey: "secret" } })
        .success,
    ).toBe(false);
  });
  it("换票强制执行身份和续票编号，取消不携带票据凭据", () => {
    const control = {
      sessionId: "session",
      executionId: "run",
      action: "replace_ticket",
      renewalId: 1,
      ticketId: "new",
      requestAuth: { headers: { ticket: "new" } },
    };
    expect(offPeakControlParamsSchema.parse(control)).toEqual(control);
    expect(offPeakControlParamsSchema.safeParse({ ...control, renewalId: undefined }).success).toBe(
      false,
    );
    expect(
      offPeakControlParamsSchema.safeParse({
        sessionId: "session",
        executionId: "run",
        action: "cancel",
      }).success,
    ).toBe(true);
    expect(offPeakControlParamsSchema.safeParse({ ...control, action: "cancel" }).success).toBe(
      false,
    );
  });
});
