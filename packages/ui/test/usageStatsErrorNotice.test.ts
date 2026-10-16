// @vitest-environment jsdom
// 修复原因：团队套餐业务错误（如"仅企业主账号可查询企业汇总数据"、
// "您当前暂无有效的团队套餐授权记录，无法创建API Key"）原先被 generic 文案
// 掩盖，且后者含"授权"会被误判为 credential 错误走翻译文案。本文件锁定
// 报错条参考 Plan Card teamUnavailable 样式原文展示业务错误的行为。

import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { UsageStatsErrorNotice } from "../src/settings/usage-stats/UsageStatsErrorNotice.js";

vi.mock("../src/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("../src/lib/settingsNavigation.js", () => ({
  setPendingSettingsSection: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

function renderNotice(error: string): string {
  return renderToStaticMarkup(
    createElement(UsageStatsErrorNotice, {
      error,
    } satisfies ComponentProps<typeof UsageStatsErrorNotice>),
  );
}

describe("UsageStatsErrorNotice 团队套餐业务错误", () => {
  it("原文展示企业主账号权限错误，参考 teamUnavailable 内联样式（InfoIcon + warning，无容器）", () => {
    const html = renderNotice("仅企业主账号可查询企业汇总数据");

    expect(html).toContain("仅企业主账号可查询企业汇总数据");
    expect(html).not.toContain("usage.error.stats.generic");
    expect(html).toContain("lucide-info");
    expect(html).toContain("text-warning");
    // 参考 Plan Card teamUnavailable：内联展示，无边框无背景容器
    expect(html).not.toContain("rounded-lg");
    expect(html).not.toContain("border-warning/30");
    expect(html).not.toContain("bg-warning/10");
    // 业务错误不是凭据问题：不出现检查 API Key 入口
    expect(html).not.toContain("settings.usage.checkApiKey");
    expect(html).not.toContain("border-destructive");
  });

  it("原文展示团队 API Key 创建失败 msg，即使包含授权字样也不走 credential 翻译", () => {
    const html = renderNotice("您当前暂无有效的团队套餐授权记录，无法创建API Key");

    expect(html).toContain("您当前暂无有效的团队套餐授权记录，无法创建API Key");
    expect(html).not.toContain("usage.error.stats.credential");
    expect(html).not.toContain("settings.usage.checkApiKey");
    expect(html).toContain("lucide-info");
    expect(html).not.toContain("rounded-lg");
  });

  it("凭据错误保持翻译文案与检查 API Key 入口", () => {
    const html = renderNotice("token expired");

    expect(html).toContain("usage.error.stats.credential");
    expect(html).toContain("settings.usage.checkApiKey");
    expect(html).not.toContain("token expired");
  });

  it("其他错误保持 generic 文案", () => {
    const html = renderNotice("Request timed out after 15000ms");

    expect(html).toContain("usage.error.stats.generic");
    expect(html).not.toContain("Request timed out after 15000ms");
  });
});
