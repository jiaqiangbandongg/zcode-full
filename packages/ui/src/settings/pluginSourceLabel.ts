import type { ZCodePluginMarketplaceSummary } from "@zcode/shared";
import { DEFAULT_MARKETPLACE_ID } from "@/settings/recommendedPlugins.js";

// 官方插件在 agent 侧的 source 取值；其余取值（如 inline 本地目录）一律按「内置」处理。
// 注意: 从市场安装的插件 source 为 "cache"，其真实归属在 plugin.marketplace 上。
const MARKETPLACE_INSTALLED_SOURCE = "cache";

/**
 * 把 marketplace id 解析为对用户友好的展示名：
 * 优先用 marketplaces 概览里的 name，缺失时回落到原始 id。
 * 纯函数，便于在目录标题栏与已安装来源标签间复用同一套命名。
 */
export function resolveMarketplaceDisplayName(
  marketplaceId: string,
  marketplaces: readonly ZCodePluginMarketplaceSummary[],
  claudeCodePluginsLabel: string,
): string {
  if (marketplaceId === DEFAULT_MARKETPLACE_ID) {
    return claudeCodePluginsLabel;
  }
  const matched = marketplaces.find((marketplace) => marketplace.id === marketplaceId);
  return matched?.name ?? marketplaceId;
}

/**
 * 已安装插件的来源标签，只分两类：
 * - 从市场安装 (source==="cache") → 「从 {市场名} 安装」；
 * - 其它 (official / inline 等) → 「内置」。
 */
export function resolvePluginSourceLabel(input: {
  source: string;
  marketplace: string;
  marketplaces: readonly ZCodePluginMarketplaceSummary[];
  builtinLabel: string;
  claudeCodePluginsLabel: string;
  formatFromMarketplace: (marketplaceName: string) => string;
}): string {
  if (input.source !== MARKETPLACE_INSTALLED_SOURCE) {
    return input.builtinLabel;
  }
  const marketplaceName = resolveMarketplaceDisplayName(
    input.marketplace,
    input.marketplaces,
    input.claudeCodePluginsLabel,
  );
  return input.formatFromMarketplace(marketplaceName);
}
