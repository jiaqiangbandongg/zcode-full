import { expect, it } from "vitest";
import zhCNMessages from "@/i18n/locales/zh-CN.js";
import { getSourceServerManagementErrorMessage } from "@/lib/sourceServerManagementError.js";

it("侧栏与设置管理错误只输出本地化原因，不泄漏 Host 原文", () => {
  const formatMessage = ({ id }: { id: string }) => zhCNMessages[id] ?? id;
  expect(
    getSourceServerManagementErrorMessage(
      new Error("Source Server management is unavailable"),
      formatMessage,
    ),
  ).toBe(zhCNMessages["settings.source.operationFailed"]);
  expect(
    getSourceServerManagementErrorMessage(
      Object.assign(new Error("Connection profile unavailable"), {
        code: "connection-profile-unavailable",
      }),
      formatMessage,
    ),
  ).toBe(zhCNMessages["settings.source.error.connection-profile-unavailable"]);
  expect(
    getSourceServerManagementErrorMessage(
      { code: "unknown-private-code", message: "private debug details" },
      formatMessage,
    ),
  ).toBe(zhCNMessages["settings.source.operationFailed"]);
});
