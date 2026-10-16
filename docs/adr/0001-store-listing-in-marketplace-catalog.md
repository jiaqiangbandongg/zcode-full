# Store Listing 元数据放在市场目录层，展示时目录优先、manifest 回退

插件商店化重设计需要 icon、hero 图、示例提示词、隐私/条款链接等展示元数据。我们决定把这些字段放在**市场目录**（marketplace.json 条目）而不是插件包内的 plugin.json：官方 CDN 只改目录 JSON 就能调整商店呈现（含 featured 名单），无需重新打包发布 zip；内置插件的目录由仓内 `official-plugin-definitions.ts` 生成，同样在仓内补字段。展示时目录 listing 字段优先，缺失则回退到 plugin.json 已有的 author/homepage——这让从未写过 listing 的个人来源插件也能免费获得开发者/网站信息行。

## Considered Options

- **manifest 内嵌**（listing 写进 plugin.json）：改一个作者名/换一张图都要重发 zip + 改 sha256，运营成本不可接受；个人来源插件依然不会有 icon，问题没解决。
- **独立 listing 服务/接口**：多一个网络依赖与失败模式，目录 JSON 本来就是逐条描述插件的地方，没必要。

## Consequences

- CDN marketplace.json 与内置 seed 生成逻辑成为商店呈现的事实来源；wire 类型（AvailablePluginSummary 等）需要把 listing 字段和 manifest 回退字段一路透传到 UI。
- 同一信息可能在两处存在且不一致（目录说作者是 A，manifest 说是 B）——按本决定，UI 永远信目录。
