# Windows 电脑控制设置设计

> 2026-08-17 更新：macOS 设置面已收敛（见
> `2026-08-17-cua-settings-surface-minimization.md`）——画中画/后台模式/Helper 状态/
> Input controller 行全部下线，macOS 与 Windows 现在同为「总开关 + macOS 权限行」的精简形态。

## 目标

在 Windows 桌面端设置页展示「电脑控制」分区，并复用 macOS 现有的官方
`zcode-cua` 插件总开关。Windows 分区只展示总开关，不展示系统授权相关内容
（Windows 无 macOS TCC 权限模型）。

## 产品边界

- macOS 桌面端展示总开关 + Accessibility / Screen Recording 两个权限行（2026-08-17 起
  不再包含画中画、后台模式、Helper 状态或 Input controller）。
- Windows 桌面端展示同一个「电脑控制」导航入口，但内容只包含总开关。
- Windows 总开关与 macOS 共用插件管理状态和启停逻辑；切换时同步启用或禁用官方
  `zcode-cua` 插件及其 MCP、Skill。
- Linux、普通 Web 和手机远控不展示「电脑控制」导航入口。
- 不新增 Windows 专属设置字段、文案、协议或 runtime 生命周期。
- 不改变远程 workspace、手机 `/remote`、replayable 消息流、owner、queue、snapshot 或
  `workspaceIdentity` 语义。

## 页面与状态边界

设置页导航按明确的桌面平台 props 生成，避免仅依赖 user agent 后让 Windows 浏览器误显示
桌面能力。`ComputerUseSection` 组件继续作为两端共享实现，在组件内部把“插件开关能力”和
“macOS 高级设置能力”拆开。

```text
SettingsPage(isMacDesktop, isWindowsDesktop)
  |
  +-- macOS Desktop ------> 电脑控制导航 ------> 共享 zcode-cua 总开关
  |                                                |
  |                                                +--> macOS 权限行（Accessibility / Screen Recording）
  |
  +-- Windows Desktop ----> 电脑控制导航 ------> 共享 zcode-cua 总开关
  |
  +-- Linux / Web / 手机 -> 不生成电脑控制导航

共享总开关
  -> pluginManagementStore.setEnabled(zcode-cua, next)
     -> 成功：store 确认新状态，插件的 MCP 与 Skill 同步启停
     -> 失败：保留原状态并沿用现有 toast 错误提示
```

本地 Windows workspace 允许初始化插件管理状态并切换总开关，但不会启动 macOS TCC
权限查询或授权引导。远程 workspace 继续被现有本地能力边界拒绝。

## 实现范围

### 设置页配置

将设置分区配置改为由调用方传入的桌面平台能力生成：macOS 或 Windows 桌面端包含
`computerUse`，其他端过滤该分区。设置页首次落点和运行时导航意图都必须回退到当前平台
实际可见的分区，不能因为不可见的 `computerUse` 偏好而渲染空白页面。

### 电脑控制分区

`ComputerUseSection` 接收 Windows 桌面端标记：

- macOS 本地 workspace：渲染总开关 + 权限行（沿用现有权限能力判断）。
- Windows 本地 workspace：初始化官方插件状态并只渲染总开关卡片。
- 非本地或不受支持的平台：不渲染内容。

Windows 不通过 CSS 隐藏高级设置；组件渲染与副作用本身都必须受平台能力边界约束，避免执行
无意义的 macOS 权限刷新。

## 交互与错误处理

- 开关无 workspace 时保持禁用，和 macOS 现有行为一致。
- 插件正在切换时保持禁用，避免并发启停。
- 插件管理服务失败时沿用现有 store 错误和 toast，不增加 Windows 专属兜底。
- Windows 不显示空的高级设置容器或占位说明。
- 复用现有 `SettingsGroupCard`、`SettingsRow` 和 `Switch`，不新增视觉样式或文案。

## 测试与验收

自动化测试至少覆盖：

1. macOS 和 Windows 桌面配置都包含 `computerUse`，Linux/Web/手机配置不包含。
2. Windows `ComputerUseSection` 只渲染总开关，不渲染授权内容；macOS 不再渲染已下线的
   画中画/后台模式/Helper/controller 行。
3. Windows 总开关调用官方 `zcode-cua` 插件的现有 `setEnabled` 流程。
4. macOS 权限行的渲染条件保持不变。
5. 不可见分区的初始偏好或导航意图回退到 `general`，设置页不出现空白。
6. 相关单元测试、`pnpm typecheck` 和 `pnpm lint` 全部通过。

## 非目标

- 为 Windows 增加授权 UI 或任何 CUA 专属设置行。
- 修改 Windows CUA runtime、安装、签名、broker 或工具能力。
- 为 Linux 或 Web 开放 CUA 设置。
- 改变插件页中的 `zcode-cua` 管理行为。
