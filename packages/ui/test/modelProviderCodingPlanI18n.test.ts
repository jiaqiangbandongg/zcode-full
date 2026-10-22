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
});
