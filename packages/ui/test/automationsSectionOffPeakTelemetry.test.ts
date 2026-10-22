// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildOffPeakCreateResultTelemetryPayload,
  freezeOffPeakCreateTelemetrySnapshot,
} from "@/lib/offPeakTelemetry.js";

describe("offPeakTelemetry helpers used by AutomationsSection (smoke)", () => {
  it("灰度门禁失败 payload 含 failure_stage=client_validation", () => {
    const snapshot = freezeOffPeakCreateTelemetrySnapshot({
      source: { eventRegion: "app.automations", templateId: "ciFlakyReport" },
      model: "GLM-5.2",
    });
    const payload = buildOffPeakCreateResultTelemetryPayload(snapshot, {
      ok: false,
      failureStage: "client_validation",
      errorCategory: "client_validation",
      errorCode: "",
      providerName: "",
    });
    expect(payload.eventExtraDetail).toMatchObject({
      result: "failure",
      failure_stage: "client_validation",
      error_category: "client_validation",
    });
  });
});
