import { describe, expect, it } from "vitest";
import { normalizeZCodeUiError } from "@/lib/zcodeUiError.js";
import {
  getProviderBusinessErrorMessageId,
  isProviderBusinessErrorCode,
  resolveGlmQuotaBannerBusinessCode,
  resolveStartPlanConcurrentLimitBusinessCode,
  resolveStartPlanConcurrentLimitBannerReason,
  resolveStartPlanQuotaExhaustedBusinessCode,
  shouldRefreshQuotaOnProviderBusinessRetry,
  START_PLAN_BUSY_AUTO_RETRY_EXHAUSTED_MESSAGE,
} from "@/lib/providerBusinessError.js";

describe("providerBusinessError", () => {
  it("refreshes quota snapshot before retrying upstream failures", () => {
    expect(shouldRefreshQuotaOnProviderBusinessRetry("2007")).toBe(true);
    expect(shouldRefreshQuotaOnProviderBusinessRetry("1005")).toBe(true);
    expect(shouldRefreshQuotaOnProviderBusinessRetry("3007")).toBe(false);
  });

  it("只把 GLM 额度套餐类错误码归一到聊天升级横幅", () => {
    expect(resolveGlmQuotaBannerBusinessCode("1308")).toBe("1308");
    expect(resolveGlmQuotaBannerBusinessCode("1309")).toBe("1309");
    expect(resolveGlmQuotaBannerBusinessCode("1321")).toBe("1321");
    expect(resolveGlmQuotaBannerBusinessCode(" 1315 ")).toBe("1315");
    expect(resolveGlmQuotaBannerBusinessCode("1302")).toBeUndefined();
    expect(resolveGlmQuotaBannerBusinessCode("1305")).toBeUndefined();
    expect(resolveGlmQuotaBannerBusinessCode("1000")).toBeUndefined();
  });

  it("recognizes provider business codes for localized banners", () => {
    expect(isProviderBusinessErrorCode("3007")).toBe(true);
    expect(getProviderBusinessErrorMessageId("1005")).toBe(
      "zcode.error.providerBusiness.1005",
    );
    expect(isProviderBusinessErrorCode("3010")).toBe(true);
    expect(getProviderBusinessErrorMessageId("3010")).toBe(
      "zcode.error.providerBusiness.3010",
    );
    expect(isProviderBusinessErrorCode("invalid_model_request")).toBe(false);
  });

  it("3010 shares the Start Plan concurrent upgrade banner path", () => {
    expect(resolveStartPlanConcurrentLimitBusinessCode("3008", "concurrent limit")).toBe(
      "3008",
    );
    expect(resolveStartPlanConcurrentLimitBusinessCode("3009", "concurrent limit")).toBe(
      "3009",
    );
    expect(resolveStartPlanConcurrentLimitBusinessCode("3010", "concurrent limit")).toBe(
      "3010",
    );
    expect(
      resolveStartPlanConcurrentLimitBusinessCode(
        "unknown_error",
        "model concurrency limit exceeded",
      ),
    ).toBe("3009");
    expect(resolveStartPlanConcurrentLimitBusinessCode("unknown_error", "concurrent limit")).toBe(
      "3008",
    );
  });

  it("区分 Start Plan 首轮繁忙和自动重试耗尽文案", () => {
    expect(resolveStartPlanConcurrentLimitBannerReason("普通并发上限")).toBe(
      "initial-busy",
    );
    expect(
      resolveStartPlanConcurrentLimitBannerReason(
        START_PLAN_BUSY_AUTO_RETRY_EXHAUSTED_MESSAGE,
      ),
    ).toBe("retry-exhausted-busy");
  });

  it("把 Start Plan 旧形态 exceed limit 错误归一成 1005", () => {
    expect(resolveStartPlanQuotaExhaustedBusinessCode("1005", "exceed limit")).toBe("1005");
    expect(
      resolveStartPlanQuotaExhaustedBusinessCode("PROVIDER_BUSINESS_ERROR", "exceed limit"),
    ).toBe("1005");
    expect(
      resolveStartPlanQuotaExhaustedBusinessCode("unknown_error", "exceed quota limit"),
    ).toBe("1005");
    expect(
      resolveStartPlanQuotaExhaustedBusinessCode("unknown_error", "quota exceeded"),
    ).toBe("1005");
    expect(resolveStartPlanQuotaExhaustedBusinessCode("SEND_FAILED", "exceed limit")).toBe("1005");
    expect(resolveStartPlanQuotaExhaustedBusinessCode("unknown_error", "exceed limit")).toBe(
      "1005",
    );
    expect(resolveStartPlanQuotaExhaustedBusinessCode("SEND_FAILED", "network down")).toBe(
      undefined,
    );
  });

  it("从 detail provider_code 读取 GLM 业务码供横幅分类使用", () => {
    const normalized = normalizeZCodeUiError({
      code: "PROVIDER_BUSINESS_ERROR",
      message: "Provider request failed",
      detail: "provider_code=1308 upstream quota limit",
    });

    expect(normalized.code).toBe("1308");
    expect(resolveGlmQuotaBannerBusinessCode(normalized.code)).toBe("1308");
  });
});
