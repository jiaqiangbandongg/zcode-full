import { describe, expect, it } from "vitest";
import { hostResponseMessageSchema, providerProvisioningResultSchema } from "@zcode/shared";

describe("Provisioning 安全错误码契约", () => {
  it.each([undefined, "target-refresh-failed"])("兼容结果的可选错误码 %s", (errorCode) => {
    const result = {
      syncId: "fixture",
      status: "failed",
      personalProviderCount: 0,
      credentialCount: 0,
      rolledBack: true,
      ...(errorCode ? { errorCode } : {}),
    };
    const hostResult = {
      type: "provider-provisioning-execution-result",
      requestId: "fixture",
      environmentKey: "fixture",
      status: "failed",
      ...(errorCode ? { errorCode } : {}),
    };
    expect(providerProvisioningResultSchema.safeParse(result).success).toBe(true);
    expect(hostResponseMessageSchema.safeParse(hostResult).success).toBe(true);
    expect(
      providerProvisioningResultSchema.safeParse({ ...result, errorCode: "token=fixture-secret" })
        .success,
    ).toBe(false);
    expect(
      hostResponseMessageSchema.safeParse({ ...hostResult, errorCode: "token=fixture-secret" })
        .success,
    ).toBe(false);
  });
});
