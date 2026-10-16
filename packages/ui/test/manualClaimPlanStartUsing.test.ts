import { describe, expect, it } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import type { ProviderSettingsView } from "@zcode/services";
import {
  resolveManualClaimPlanStartUsingTarget,
  type ManualClaimPlanStartUsingTarget,
} from "@/components/manual-claim-plan/manualClaimPlanStartUsing.js";

const providerId = BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;

function createView(overrides: Partial<ManualClaimPlanStartUsingTarget> = {}): ProviderSettingsView {
  const provider = {
    providerId,
    executable: overrides.providerExecutable ?? true,
    effectiveConfig: {},
    issues: [],
    models:
      overrides.modelCount === 0
        ? []
        : [
            {
              kind: "candidate" as const,
              modelId: "GLM-5.3-Flash",
              builtin: true,
              effectiveBuiltinConfig: {},
              effectiveConfig: {},
              enabled: true,
              executable: overrides.modelExecutable ?? true,
              selectable: overrides.modelSelectable ?? true,
              issues: [],
            },
          ],
  };
  return {
    revision: 1,
    providerTemplates: [],
    providerOrder: [providerId],
    providers: [provider],
  };
}

describe("resolveManualClaimPlanStartUsingTarget", () => {
  it("requires an executable and selectable target provider model", () => {
    expect(resolveManualClaimPlanStartUsingTarget(createView(), providerId)).toEqual({ ok: true });
    expect(
      resolveManualClaimPlanStartUsingTarget(createView({ modelExecutable: false }), providerId),
    ).toEqual({ ok: false, reason: "no-executable-model" });
    expect(
      resolveManualClaimPlanStartUsingTarget(createView({ modelSelectable: false }), providerId),
    ).toEqual({ ok: false, reason: "no-executable-model" });
  });

  it("rejects a missing, non-executable, or model-less provider", () => {
    expect(resolveManualClaimPlanStartUsingTarget(createView(), "missing-provider")).toEqual({
      ok: false,
      reason: "missing-provider",
    });
    expect(
      resolveManualClaimPlanStartUsingTarget(createView({ providerExecutable: false }), providerId),
    ).toEqual({ ok: false, reason: "provider-not-executable" });
    expect(
      resolveManualClaimPlanStartUsingTarget(createView({ modelCount: 0 }), providerId),
    ).toEqual({ ok: false, reason: "no-executable-model" });
  });
});
