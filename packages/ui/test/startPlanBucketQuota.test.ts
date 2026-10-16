import { describe, expect, it } from "vitest";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  type UsageEntitlementSnapshot,
  type UsageQuotaLimit,
} from "@zcode/shared";
import { buildSessionQuotaBannerState } from "@/v4/sessionQuotaBannerState.js";

const providerId = BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
const now = 1000;
function bucket(id: string, remaining: number, number = 100): UsageQuotaLimit {
  return {
    type: id,
    bucketId: id,
    periodStart: 0,
    periodEnd: 2000,
    nextResetTime: 2000,
    number,
    remaining,
    percentage: remaining / number,
    period: "daily",
    usageDetails: [{ modelCode: "glm-flash", displayName: "GLM Flash", usage: number - remaining }],
  };
}
function build(limits: UsageQuotaLimit[], extra = {}) {
  const snapshot: UsageEntitlementSnapshot = {
    generatedAt: now,
    serverTime: now,
    authenticated: true,
    provider: { id: providerId, name: "Start" },
    remaining: null,
    subscription: null,
    quota: { level: "Start", limits },
  };
  return buildSessionQuotaBannerState({
    activeProviderId: providerId,
    modelId: "glm-flash",
    snapshot,
    ...extra,
  });
}

describe("Start Plan 按 bucket 提醒", () => {
  it("活动桶与日桶独立计算，活动桶耗尽不误报模型耗尽", () => {
    expect(
      build([bucket("event", 0, 300_000_000), bucket("daily", 5_000_000, 5_000_000)]).visible,
    ).toBe(false);
    const low = build([bucket("event", 0, 300_000_000), bucket("daily", 500_000, 5_000_000)]);
    expect(low).toMatchObject({
      kind: "model-very-low",
      remainingPercent: 10,
      remainingTokens: 500_000,
      modelName: "GLM Flash",
      quotaPeriod: "daily",
      dismissible: true,
    });
    expect(low.reminderKey).toBe(JSON.stringify(["daily", 0, 2000]));
  });
  it("仅全部模型桶归零才提示模型耗尽，全部桶归零优先总耗尽", () => {
    const other = { ...bucket("other", 100), usageDetails: [{ modelCode: "glm-other", usage: 0 }] };
    expect(build([bucket("event", 0), bucket("daily", 0), other]).kind).toBe("model-exhausted");
    expect(build([bucket("event", 0), bucket("daily", 0)]).kind).toBe("daily-exhausted");
    expect(build([bucket("daily", 100)], { serverQuotaExhausted: true }).kind).toBe(
      "daily-exhausted",
    );
  });
  it("余额与排列不影响周期键，新周期和新桶独立提醒，跳过已提醒桶", () => {
    const a = bucket("a", 10);
    const b = bucket("b", 9);
    const key = build([a]).reminderKey;
    expect(build([{ ...a, remaining: 8, percentage: 0.08 }]).reminderKey).toBe(key);
    const skip = { isReminderHidden: (candidate: string) => candidate === key };
    expect(build([a], skip).visible).toBe(false);
    expect(build([a, b], skip).reminderKey).toBe(build([b, a], skip).reminderKey);
    expect(build([{ ...a, periodStart: 1000, periodEnd: 3000 }], skip).visible).toBe(true);
  });
  it("过期和未生效桶排除，未知余额不误判耗尽，缺失周期不弹低额度", () => {
    expect(
      build([{ ...bucket("expired", 0), nextResetTime: now }, bucket("healthy", 100)]).visible,
    ).toBe(false);
    expect(
      build([{ ...bucket("future", 0), periodStart: now + 1 }, bucket("healthy", 100)]).visible,
    ).toBe(false);
    expect(
      build([{ ...bucket("unknown", 0), remaining: undefined, percentage: undefined }]).visible,
    ).toBe(false);
    expect(
      build([{ ...bucket("invalid", 0), remaining: Number.NaN, percentage: Number.NaN }]).visible,
    ).toBe(false);
    expect(build([{ ...bucket("legacy", 10), bucketId: undefined }]).visible).toBe(false);
    expect(build([{ ...bucket("legacy", 10), periodEnd: undefined }]).visible).toBe(false);
    expect(build([{ ...bucket("legacy", 10), periodStart: 2000, periodEnd: 1000 }]).visible).toBe(
      false,
    );
  });
});

it.each([1000, undefined])("候选桶和展示记录共用 snapshot 时间（serverTime=%s）", (serverTime) => {
  let observedTime: number | undefined;
  const snapshot: UsageEntitlementSnapshot = {
    generatedAt: serverTime === undefined ? 1000 : 2500,
    serverTime,
    authenticated: true,
    provider: { id: providerId, name: "Start" },
    remaining: null,
    subscription: null,
    quota: { level: "Start", limits: [bucket("clock", 10)] },
  };
  const state = build([], {
    snapshot,
    isReminderHidden: (_key: string, referenceTime: number) => {
      observedTime = referenceTime;
      return false;
    },
  });
  expect(state.visible).toBe(true);
  expect(state.reminderReferenceTime).toBe(1000);
  expect(observedTime).toBe(1000);
});
