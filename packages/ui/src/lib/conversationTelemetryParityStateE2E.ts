import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  buildSessionQuotaBannerDismissKey,
  buildSessionQuotaBannerState,
} from "@/v4/sessionQuotaBannerState.js";

export function runQuotaParityStateAssertions(): string[] {
  const assertions: string[] = [];
  const providerId = BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan;
  const exhausted = buildSessionQuotaBannerState({
    activeProviderId: providerId,
    snapshot: null,
    modelId: "glm-5.2",
    serverQuotaExhausted: true,
  });
  assertState(
    exhausted.visible && exhausted.kind === "daily-exhausted" && !exhausted.dismissible,
    "quota:daily-exhausted",
    assertions,
  );

  const concurrent = buildSessionQuotaBannerState({
    activeProviderId: providerId,
    snapshot: null,
    modelId: "glm-5.2",
    serverConcurrentLimited: true,
    serverConcurrentLimitBusinessCode: "3010",
    serverConcurrentLimitReason: "retry-exhausted-busy",
  });
  assertState(
    concurrent.kind === "concurrent-limit" &&
      concurrent.dismissible &&
      !concurrent.blocksSubmit &&
      concurrent.priority === 60,
    "quota:concurrent-dismissible-nonblocking",
    assertions,
  );

  const providerLimited = buildSessionQuotaBannerState({
    activeProviderId: providerId,
    snapshot: null,
    modelId: "glm-5.2",
    serverProviderLimitedBusinessCode: "1308",
    serverProviderLimitedMessage: "[1308][余额不足][request-id]",
  });
  assertState(
    providerLimited.kind === "provider-limited" &&
      providerLimited.providerLimitedMessage === "余额不足",
    "quota:provider-limited-message",
    assertions,
  );
  assertState(
    buildSessionQuotaBannerDismissKey(concurrent, "error-a") !==
      buildSessionQuotaBannerDismissKey(concurrent, "error-b"),
    "quota:dismiss-key-instance",
    assertions,
  );
  return assertions;
}

function assertState(condition: boolean, label: string, assertions: string[]): void {
  if (!condition) {
    throw new Error(`conversation telemetry parity state assertion failed: ${label}`);
  }
  assertions.push(label);
}

export { runRequestVerificationParityAssertions } from "@/request-security-edition/parity.js";
