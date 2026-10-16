# Coding Plan 升级入口解耦

## 背景

历史上多个入口点击“升级 Coding Plan”后都会跳到 Model Provider 设置页，再通过 Model Provider target 上的升级字段让 `ModelProviderSection` 选中对应 provider 并展开购买面板。这样会把购买流程和模型配置页的导航状态绑在一起，导致外部升级入口依赖 provider family 的 selected key、连接方式 fallback 和设置页水合时序。

## 目标

- “升级 Coding Plan”入口由 UI 级弹窗能力统一承载，不挂载在 `SettingsPage`、`App`、workspace shell 或 `ModelProviderSection` 的外部跳转意图上。
- 升级入口不再使用 `codingPlanUpgrade*` settings intent；入口组件直接调用 `useCodingPlanUpgradeDialog().openCodingPlanUpgrade(target)`。
- 旧的 Model Provider / Settings 升级跳转字段不保留兼容；升级行为必须由实际入口直接唤起。
- Model Provider 设置页继续只负责 provider 配置、连接方式切换、状态卡展示；状态卡内部的 Subscribe / Upgrade 只是一个本地入口，不作为外部入口的宿主。
- 外部入口不再打开 Settings，关闭升级面板后自然停留在当前 workspace。

## 交互链路

统一入口：

```text
Sidebar / Chat quota / Input toolbar / Settings model provider status card
  -> useCodingPlanUpgradeDialog().openCodingPlanUpgrade({ providerId })
  -> CodingPlanUpgradeDialog
```

## 实现约束

- `SettingsPage` 不识别 `codingPlanUpgradeProviderId` / `codingPlanUpgradeReturnTarget` / `codingPlanUpgradeFunnelContext` 作为升级入口。
- `ModelProviderSection` 只接收普通 `modelProviderId` 定位意图，不再接收升级购买意图。
- 独立升级宿主使用 provider id 解析 OAuth provider、产品源 provider、当前套餐状态和购买 token 状态。
- Start Plan 打开升级时，产品列表必须映射到同 family 的 paid Coding Plan provider。
- 购买完成后刷新 provider 列表和权益状态，避免面板关闭后 Settings / Usage 仍显示旧套餐。
- Workspace 外部入口不得为了打开升级面板切到 Settings；入口只调用弹窗能力，关闭后自然停留在当前上下文。
- Settings 内部状态卡 Subscribe / Upgrade 直接调用弹窗能力，不持有购买弹窗状态，也不向上层传递购买弹窗 props。

## Todo103 整合边界

- 保留 staging 删除原生购买面板、统一使用官网 WebView 的方向；原生 SKU 选择、支付轮询和专属遥测不再作为客户端功能恢复。
- 保留仍在使用的商品源解析、企业档位展示、入口遥测与购买完成刷新；Start 升级指向同域具体 Individual Provider，不恢复旧 Coding Plan 身份。
- 设置页使用 ProviderSettingsView 与 Personal 写入接口，模板创建、动态模型编辑/排序及失效连接手动切换不因购买界面删除而回退。
- Team 状态卡发起升级时仍指定 team audience；普通状态卡默认 personal。已有具体团队购买入口传入的 Team key 继续保留。删除原生面板不能把 Team 升级静默改成个人购买。
- 按入口、购买宿主、完成刷新联合验证；原生组件专属测试随对应功能退役，仍被当前入口使用的测试继续保留。
- 全连接套餐统计复用根 Environment 的 ProviderSettingsView 与套餐只读查询，不读取旧 Provider.apiKey、不要求 current/executable。Start 与具体 Individual 分开查询，Team 使用既有 authenticated pricing；Settings 首次读取失败不作为空清单放行，重试仍只加载数据。
