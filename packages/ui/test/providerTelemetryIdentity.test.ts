import { describe, expect, it, vi } from "vitest";
import { encodeCustomModelValue, type ZCodeAutomation } from "@zcode/shared";
import {
  buildV4ConversationPromptTelemetryExtraDetail,
  resolveLegacyRuntimeModelValue,
} from "@/v4/telemetry/conversationPromptTelemetry.js";
import {
  resolveAutomationSelectionTelemetry,
  reportAutomationActionClick,
  reportAutomationCreateResult,
} from "@/lib/automationTelemetry.js";
import { freezeOffPeakCreateTelemetrySnapshot } from "@/lib/offPeakTelemetry.js";
import { buildCompactionTelemetryExtraDetail } from "@/lib/messageTelemetry.js";

// 790884b1ce：Team 使用 canonical Coding Plan 身份；两家闲时共用同一 ID。
const identities = [
  ["zai-api", "builtin:zai"],
  ["bigmodel-api", "builtin:bigmodel"],
  ...["zai", "bigmodel"].flatMap((family) => [
    [`account:${family}-individual-coding-plan`, `builtin:${family}-coding-plan`],
    [`account:${family}-team-coding-plan`, `builtin:${family}-coding-plan`],
    [`account:${family}-start-plan`, `builtin:${family}-start-plan`],
    [`account:${family}-offpeak-idle-plan`, "offpeak-idle-plan"],
  ]),
  ["personal-uuid", "personal-uuid"],
  ["builtin:zai-coding-plan", "builtin:zai-coding-plan"],
  ["account:future-plan", "account:future-plan"],
];

describe("Provider 埋点旧口径", () => {
  it.each(["zai", "bigmodel"])(
    "%s 自动化成功/失败/立即运行的实际报告同桶，模型保持纯 ID",
    async (family) => {
      const platform = { reportTelemetryEvent: vi.fn(async () => {}) };
      const modelSelection = {
        providerId: `account:${family}-team-coding-plan`,
        modelId: "vendor/model:1%",
      };
      const modelFields = resolveAutomationSelectionTelemetry(modelSelection, null);
      await reportAutomationCreateResult(platform, {
        automationId: "automation",
        cronExpr: "0 * * * *",
        modelFields,
      });
      await reportAutomationCreateResult(platform, {
        error: "failed",
        cronExpr: "0 * * * *",
        modelFields,
      });
      await reportAutomationActionClick(platform, {
        action: "run_now",
        source: "list",
        automation: { automationId: "automation", modelSelection } as ZCodeAutomation,
        providerSettingsView: null,
      });
      expect(platform.reportTelemetryEvent).toHaveBeenCalledTimes(3);
      for (const [payload] of platform.reportTelemetryEvent.mock.calls) {
        expect(payload.eventExtraDetail).toMatchObject({
          model_provider: `builtin:${family}-coding-plan`,
          model_name: modelSelection.modelId,
          provider_name: "",
        });
      }
    },
  );
  it.each(identities)("%s → %s，模型 ID 无损且选择不变", (providerId, legacy) => {
    const modelId = "vendor/a:b%2F模型";
    const selection = Object.freeze({ providerId, modelId });
    const send = buildV4ConversationPromptTelemetryExtraDetail({
      configProvider: providerId,
      modelName: modelId,
    });
    expect(send.model_provider).toBe(legacy);
    expect(send.model_name).toBe(encodeCustomModelValue(legacy, modelId));
    expect(resolveLegacyRuntimeModelValue({ configProvider: providerId, modelName: modelId })).toBe(
      `${legacy}/${modelId}`,
    );
    expect(resolveAutomationSelectionTelemetry(selection, null)).toEqual({
      model_provider: legacy,
      model_name: modelId,
      provider_name: "",
    });
    expect(selection).toEqual({ providerId, modelId });
  });
  it.each(["zai", "bigmodel"])("%s 闲时冻结旧桶，纯模型值不变", (family) => {
    expect(
      freezeOffPeakCreateTelemetrySnapshot({
        providerId: `account:${family}-offpeak-idle-plan`,
        model: "GLM-5.3-Flash",
      }),
    ).toMatchObject({ modelProvider: "offpeak-idle-plan", modelName: "GLM-5.3-Flash" });
  });
  it("压缩保留原模型形式，不增 hostname", () => {
    const detail = buildCompactionTelemetryExtraDetail({
      timeline: { status: "completed", trigger: "manual" },
      modelName: "account:bigmodel-team-coding-plan/GLM-5.3",
      modelProvider: "account:bigmodel-team-coding-plan",
    });
    expect(detail).toMatchObject({
      model_name: "builtin:bigmodel-coding-plan/GLM-5.3",
      model_provider: "builtin:bigmodel-coding-plan",
    });
    expect(detail).not.toHaveProperty("provider_name");
  });
});
