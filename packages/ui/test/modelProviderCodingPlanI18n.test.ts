import { describe, expect, it } from "vitest";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

describe("model provider Coding Plan i18n", () => {
  it("keeps Coding Plan message ids localized in zh-CN", () => {
    const prefix = "settings.modelProvider.codingPlan";
    const enKeys = Object.keys(enUS).filter((key) => key.startsWith(prefix));

    for (const key of enKeys) {
      // Bugfix: Coding Plan 新增文案时只补了英文 locale，中文界面会直接显示 message id。
      // 这里用英文 key 集合作为基准，避免后续再漏掉中文翻译。
      expect(zhCN[key], `zh-CN missing ${key}`).toBeTruthy();
    }
  });

  it("keeps Z.ai payment copy in English without changing BigModel copy", () => {
    // Bugfix: Z.ai 海外支付文案需要独立于 BigModel，即使中文界面也保持英文。
    expect(zhCN["settings.modelProvider.codingPlan.overseasPayment.renewalPolicyTitle"]).toBe(
      "Renewal Policy",
    );
    expect(zhCN["settings.modelProvider.codingPlan.overseasPayment.accountPolicyTitle"]).toBe(
      "Account Usage Policy",
    );
    expect(zhCN["settings.modelProvider.codingPlan.overseasPayment.amount.payAmount"]).toBe(
      "Amount due",
    );
    expect(zhCN["settings.modelProvider.codingPlan.paymentDialog.payAmount"]).toBe("实付金额");
    expect(zhCN["settings.modelProvider.codingPlan.paymentDialog.ruleTitle"]).toBe(
      "账号使用规范",
    );
  });
});
