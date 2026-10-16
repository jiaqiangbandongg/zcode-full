# 内置插件图标

内置插件的商店信息定义在
`apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts`。每个
`listing.icon` 使用官方插件资源 CDN：

```
https://cdn-zcode.z.ai/zcode/official-plugin/assets/<plugin-name>/icon.png
```

`computer-use` 复用已发布的 `assets/zcode-cua/icon.png`。插件标识从 `zcode-cua`
改为 `computer-use` 后，CDN 资源目录仍保留原名；不能随插件标识拼接出尚未发布的
`computer-use/icon.png`（会返回 404）。图标路径与插件标识可以独立维护。

资源文件由 `zcode-plugins` 仓库的 `assets/<plugin-name>/icon.png` 提供；该仓库的
`main` 分支发布流水线会将 assets 目录同步到 CDN。图标使用 HTTPS URL，以符合客户端
受信任图片地址校验。PNG 必须使用透明背景，并保留 Figma 原始颜色；商店使用语义化
`bg-hover` 容器承载图标，不再对整张图片做深色主题反相，避免 Android、iOS、ZCode
等品牌色在深色主题失真。Installed Strip 也不得根据插件启用状态对头像整体应用透明度；
启用状态由管理视图表达。若资源请求失败或没有配置图标，插件商店会继续显示默认图标。

Figma 节点 `5080:5352` 的 Installed Strip 定义了内置图标的视觉契约：36px 圆角容器
内居中放置 24px 图形。内置插件定义顺序与图标顺序必须保持一致：

1. `android-emulator` → `android`
2. `document-skills` → `dotpoints-01`
3. `ios-simulator` → `ios`
4. `restore-legacy-sessions` → `Frame`（归档盒上箭头）
5. `skill-creator` → `Frame`（立方体）
6. `zcode-guide` → ZCode 标志

Installed Strip 排序时，内置/inline 插件必须整体排在市场安装插件之前，并按当前语言
下的展示名称稳定排序；其余市场安装插件继续按安装时间倒序。排序依据使用运行时
`source`，不以是否缺失 `installedAt` 间接判断内置身份。

当前内置插件：`android-emulator`、`document-skills`、`ios-simulator`、
`restore-legacy-sessions`、`skill-creator`、`zcode-guide`。
