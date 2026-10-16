import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { EnterpriseCodingPlanProductDisplay } from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";

// 2026-09: 原生购买面板（CodingPlanPurchasePanel）整体下线，购买流程切换为内嵌官网
// webview。本文件迁出该面板中仍被设置页（Detail.tsx）与登录恢复逻辑使用的
// 企业套餐分组/档位展示 helper，避免活代码依赖 6200 行死面板文件。

export type PurchaseAudience = "personal" | "team";

export interface EnterpriseCodingPlanProductGroup {
  key: string;
  title: string;
  products: EnterpriseCodingPlanProductDisplay[];
}

export interface EnterpriseTierFormatOptions {
  locale: string;
  formatMessage?: EnterpriseTierMessageFormatter;
}

export type EnterpriseTierMessageFormatter = (id: string, fallback: string) => string;

export function formatEnterpriseTier(
  tier: string,
  options: EnterpriseTierFormatOptions | string = "en-US",
): string {
  const normalized = tier.trim();
  if (!normalized) {
    return tier;
  }
  const { formatMessage } = normalizeEnterpriseTierFormatOptions(options);
  const upper = normalized.toUpperCase();
  const fallback = normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
  const messageId = resolveEnterpriseTierMessageId(upper);
  if (messageId && formatMessage) {
    // Bugfix: 企业 pricing 只返回 PRO/MAX 这类技术档位，展示名必须走 i18n 文案。
    // 不能在 helper 里写死中文，否则团队套餐状态卡和购买页无法随 locale/运营命名一起更新。
    return formatMessage(messageId, fallback);
  }
  return fallback;
}

export function resolveEnterpriseTierMessageId(normalizedTier: string): string | null {
  const key = normalizedTier.trim().toLowerCase();
  if (key === "lite" || key === "pro" || key === "max") {
    return `settings.modelProvider.codingPlan.enterprise.tier.${key}`;
  }
  return null;
}

function normalizeEnterpriseTierFormatOptions(
  options: EnterpriseTierFormatOptions | string,
): EnterpriseTierFormatOptions {
  return typeof options === "string" ? { locale: options } : options;
}

export function createEnterpriseTierMessageFormatter(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): EnterpriseTierMessageFormatter {
  return (id, fallback) => {
    const message = intl.formatMessage({ id });
    return message === id ? fallback : message;
  };
}

function resolveEnterpriseTierRank(tier: string): number {
  const normalized = tier.trim().toLowerCase();
  if (normalized === "lite") {
    return 0;
  }
  if (normalized === "pro") {
    return 1;
  }
  if (normalized === "max") {
    return 2;
  }
  return 99;
}

export function groupEnterpriseCodingPlanProductsByTier(
  products: EnterpriseCodingPlanProductDisplay[],
  options: EnterpriseTierFormatOptions | string,
): EnterpriseCodingPlanProductGroup[] {
  const formatOptions = normalizeEnterpriseTierFormatOptions(options);
  const groups = new Map<string, EnterpriseCodingPlanProductGroup>();
  for (const product of products) {
    const key = product.tier.trim().toLowerCase() || product.productId;
    const current = groups.get(key);
    if (current) {
      current.products.push(product);
      continue;
    }
    groups.set(key, {
      key,
      title:
        (product.staticCatalogAvailable ? product.productName?.trim() : undefined) ||
        formatEnterpriseTier(product.tier, formatOptions),
      products: [product],
    });
  }
  return [...groups.values()].sort(
    (left, right) => resolveEnterpriseTierRank(left.key) - resolveEnterpriseTierRank(right.key),
  );
}
