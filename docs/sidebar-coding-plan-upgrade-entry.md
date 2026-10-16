# Sidebar Coding Plan 升级入口

## 背景

侧边栏头像菜单保留 Coding Plan 升级入口，用于让用户从账号菜单稳定进入套餐购买/续费流程。入口不再依赖 quota / remaining / subscription 快照决定是否展示，避免未登录、普通 API Key 或套餐状态暂不可用时入口消失。

## 可见性

“升级”菜单项始终展示在头像菜单中。它不再因为以下状态隐藏：

- 未登录或 OAuth 恢复中。
- 当前模型不是 Coding Plan。
- Coding Plan provider 不可用、未配置或 entitlement 正在加载。
- entitlement 返回 `no_plan` / `unavailable` / 已有套餐 / Team / Enterprise / Max。

## 行为

点击“升级”后直接调用现有 `CodingPlanUpgradeDialog`：

- 如果当前上下文能解析出 Z.ai / BigModel Coding Plan provider，则打开对应 provider。
- 如果无法解析 provider，则默认打开 Z.ai Coding Plan。
- 如果当前 entitlement 可识别为 Max，文案仍显示续费；否则显示升级。
