import { beforeEach, describe, expect, it, vi } from "vitest";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { logger } from "@/logger.js";

vi.mock("@/logger.js", () => ({ logger: { info: vi.fn(), debug: vi.fn() } }));

beforeEach(() => vi.clearAllMocks());

describe("UI telemetry privacy", () => {
  it.each(["agent_step", "message_completion", "automation_create_result", "future_event"])(
    "%s 在 IPC 和日志之前移除错误原文",
    async (elementName) => {
      const reportTelemetryEvent = vi.fn(async () => {});
      const payload = {
        elementName,
        eventRegion: "app",
        eventType: "result",
        eventExtraDetail: {
          error_msg: "Authorization: Bearer FAKE_PRIVATE_VALUE /Users/private/file",
          error_type: "TOOL_EXEC_ERROR",
        },
      };
      await reportAppTelemetryEvent({ reportTelemetryEvent }, payload, "test");
      expect(reportTelemetryEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventExtraDetail: { error_msg: "[redacted]", error_type: "TOOL_EXEC_ERROR" },
        }),
      );
      expect(logger.info).not.toHaveBeenCalled();
      expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain(
        "FAKE_PRIVATE_VALUE",
      );
      if (elementName === "agent_step" || elementName === "message_completion") {
        expect(logger.debug).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            eventExtraDetail: { error_msg: "[redacted]", error_type: "TOOL_EXEC_ERROR" },
          }),
        );
      }
      expect(payload.eventExtraDetail.error_msg).toContain("FAKE_PRIVATE_VALUE");
    },
  );

  it("旧调用方传入完整登录 URL 也不会穿过 IPC", async () => {
    const reportTelemetryEvent = vi.fn(async () => {});
    await reportAppTelemetryEvent(
      { reportTelemetryEvent },
      {
        elementName: "app_login_ck",
        eventRegion: "app",
        eventType: "ck",
        eventExtraDetail: {
          login_url: "https://user:secret@login.example.com:443/oauth?state=secret#secret",
        },
      },
      "test",
    );
    expect(reportTelemetryEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventExtraDetail: { login_url: "login.example.com" },
      }),
    );
  });
});
