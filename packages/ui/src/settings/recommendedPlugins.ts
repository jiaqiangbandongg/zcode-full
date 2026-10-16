import recommendedPluginsConfig from "@/settings/recommendedPlugins.json" with { type: "json" };

// 客户端精选「推荐」区已下线（产品决策：个人分段不再置顶策展名单）；
// 这里只保留默认市场 id——它是官方之外的默认个人市场，多个视图据此做归属判断。
// 策展名单如需恢复，git 历史里有完整的 selectRecommendedPlugins 实现。

/** 默认市场 id：UI 默认就展示该市场，并据此匹配推荐插件。 */
export const DEFAULT_MARKETPLACE_ID = (recommendedPluginsConfig as { marketplace: string })
  .marketplace;
