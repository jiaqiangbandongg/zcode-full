# CUA 设置面收敛（helper 状态与实验性开关下线）

- 日期：2026-08-17
- 状态：已实现（MR z-code!2068 配套）
- 范围：仅 CUA 相关面；不触碰非 CUA 设置与其它功能区

## 背景

2026-08-15 的 Helper 实例隔离设计（zcode-cua `docs/refactor-port-specs/CUA-HELPER-INSTANCE-ISOLATION-PLAN.md` 第 7 步）
把 controller 状态/接管/停止暴露到权限服务，并在桌面端渲染了两处 UI：

1. 设置页「电脑控制」分区的 Input controller 行（owner 徽章 + Take control/Stop 按钮）；
2. 工作区标题栏的 `CuaControllerStatusControl` 常驻状态胶囊。

此外设置页还引入了三个 Helper 启动开关（Agent pointer feedback / Picture-in-Picture /
Background mode）。产品评审结论：这些面都是多余的——

- Helper 运行状态对用户没有可操作价值（权限引导自有状态行，故障自愈走重启链）；
- controller lease 是 Helper 侧的安全仲裁机制，自动生效即可，用户不需要手动 take/stop；
- Agent pointer 反馈与画中画默认开启即可，不存在需要用户关掉它们的产品场景；
- Background mode（AX-only、不抢焦点）不符合当前交互模型，不再提供。

## 目标行为

### 设置页（macOS / Windows 一致收敛）

「电脑控制」分区只保留：

1. 总开关（zcode-cua 插件 enablement，联动 MCP + skill）；
2. macOS Accessibility / Screen Recording 两个权限行（含 Grant 引导、stale 时的
   Helper 重启 + 重启 ZCode 兜底——沿用现行恢复链，不受本变更影响）。

未授权时，权限行右侧的操作顺序固定为 `[Open… 按钮] [状态徽章]`；按钮与状态属于
同一 control 区，不再把 Open 按钮放到行下方的 detail 区。stale 的 Helper/ZCode
重启恢复操作仍保留在 detail 区，但不重复渲染 Open 按钮。
该宽 control 布局只用于 Computer Use 权限行：宽屏使用 280px 操作列，按钮和状态不换行；
窄屏改为单列，整个 control 区移到描述下方。其他 `SettingsRow` 继续使用 192px 操作列。
Open 操作复用 MCP “打开授权”的按钮视觉：`link` 尺寸、蓝色链接态、ExternalLink 图标，
小屏只保留图标但继续通过 `aria-label` / `title` 暴露完整操作名称。

移除的行：Helper 运行态行（版本/路径/Running 徽章/重启图标）、Input controller 行、
Agent pointer feedback 行、Picture-in-Picture 行、Background mode 行。

### 标题栏

移除 `CuaControllerStatusControl` 及其在 `WorkspaceHeader` /
`WorkspaceHeaderActionSection` 的 `showCuaControllerStatus` 接线。标题栏不再出现任何
CUA 状态。

### 运行时默认值（不再可配）

| 能力                                  | 之前                           | 现在                                       |
| ------------------------------------- | ------------------------------ | ------------------------------------------ |
| Agent pointer overlay（ghost cursor） | `cuaGhostCursorEnabled` 默认开 | 常开（producer product factory 固定 true） |
| Picture-in-Picture 浮窗               | `cuaPipMode` 默认开            | 常开（producer product factory 固定 true） |
| Background mode（不抢焦点）           | `cuaBackgroundMode` 默认关     | 移除（host 不再传该启动参数）              |

### 设置存储

`AppSettings.cuaGhostCursorEnabled` / `cuaPipMode` / `cuaBackgroundMode` 三个 key 从
`packages/shared/src/protocol.ts` 与 `validationAppSettings.ts`（全量 + patch schema）删除。
存量用户配置里的旧 key 由 zod strip 语义自然忽略，不做迁移。

## 边界（明确不做的事）

- **controller lease 本体保留**：zcode-cua Helper 侧的用户级 lease 仲裁（多实例共存、
  仅 owner 可派发副作用与 overlay）是安全机制，本次只下线桌面端的手动 UI。
- **desktop controller facade 已退役**：producer 0.5.7 已从 `ICuaPermissionService` 删除
  `takeController/stopController/getHelperStatus`，z-code 同步删除零调用实现。raw broker
  controller protocol、lease/admission 与 Helper 内部显式 takeover 安全机械不受影响。
- 权限引导流（onboarding、授权返回恢复、stale 验证、重启 ZCode 兜底）行为不变；
  `restartHelper` / `getStatus` 服务面不变。

## 影响面清单

- UI：`packages/ui/src/CuaControllerStatusControl.tsx`（删除）、
  `WorkspaceHeader*.tsx/shared.ts`（去接线）、`settings/ComputerUseSection.tsx`（删行 + 删
  helper 心跳轮询）、i18n `settings.computerUse.controller*/pipMode*/backgroundMode*/
ghostCursor*/helper{Label,Running,NotRunning}` 键（zh/en 同步删除）。
- 协议/校验：`AppSettings` 三 key 删除。
- services：producer product factory 固定 ghost cursor/PiP=true，`node.ts` 不再传伪动态
  getter；删除 desktop controller 查询/命令 facade，保留 raw broker controller 安全边界。
- 测试：删除 `cuaControllerStatusControl.test.ts`；改写
  `computerUseWindowsSettings.test.ts`（断言收敛后的行集）、
  `computerUseNoAutoPermissionModal.test.ts`、`workspaceHeader.test.ts`、
  `appSettings.test.ts`；`cuaGhostCursorSettingsWiring.test.ts` 改为锁定"常开"接线。

## 验证

- `pnpm vitest run`（ui/shared/services 的 CUA 相关套件）
- `pnpm typecheck`、`pnpm lint`
- 三完整性门（skill-sync / version-coherence）在合并基上保持绿
