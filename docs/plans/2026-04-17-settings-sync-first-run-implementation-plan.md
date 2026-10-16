# 首次启动设置同步（配置类导入）Implementation Plan

> **状态：历史计划，未按本文落地。** 依赖的 ACP/多 Agent 设计稿及本文列出的
> `settings-sync` 模块已经退役或未创建；本文只保留决策背景，不可作为当前实现入口。

更新日期：2026-04-17

## 执行前复核

原计划基于后来删除的 `docs/plans/2026-04-17-settings-sync-first-run-design.md`；该设计只可从 Git 历史追溯。

需要在实现中尽早钉死的一条工程约束：

- 各来源配置导入时，只做“最小安全映射”，不追求把来源系统的全部语义一比一复制到 ZCode。

原因：

- `providers / skills / plugins` 三类配置的来源布局不同
- 现有仓库已经分别有镜像、落盘、启用状态管理逻辑
- 如果在同步功能里临时发明一套“全量直拷 + 兼容解释”逻辑，后续维护风险会明显升高

因此本次实现统一采用：

- 来源 repo 负责发现与读取
- `settings-sync` service 负责归一化与任务编排
- 目标落地始终复用现有业务 service 或其 repo 能力

## 批次策略

按 `executing-plans` 规则，默认先执行前 3 个任务，再停下来汇报校验结果。

Batch 1：Task 1 ~ Task 3

完成后汇报：

- 已实现内容
- 验证结果
- 剩余风险

## Task 1：定义 shared 类型与 RPC 频道

### 目标

为 `settings-sync` 建立独立的 shared 协议面，避免 UI / services 直接共享内部结构。

### 修改文件

- Modify: `packages/shared/src/channels.ts`
- Create: `packages/shared/src/settings-sync.ts`
- Modify: `packages/shared/src/index.ts`

### 实现步骤

1. 在 `ServiceChannels` 增加 `SettingsSync`
2. 新建 `settings-sync.ts`，定义以下类型：
   - `SettingsSyncAgent`
   - `SettingsSyncCategory`
   - `SettingsSyncCategorySummary`
   - `SettingsSyncAgentSummary`
   - `SettingsSyncDiscoveryResult`
   - `SettingsSyncSelection`
   - `SettingsSyncProgressEvent`
   - `SettingsSyncImportResult`
   - `SettingsSyncFirstRunPromptState`
3. 类型命名保持中性，不夹带 UI 状态字段
4. 从 `packages/shared/src/index.ts` 导出这些类型

### 验证

- `pnpm typecheck --filter @zcode/shared` 若不支持则走根级 `pnpm typecheck`

## Task 2：建立 services 骨架与注册链路

### 目标

把 `settings-sync` 服务接入现有 channel -> descriptor -> accessor -> proxy 链路。

### 修改文件

- Create: `packages/services/src/settings-sync/settingsSync.ts`
- Create: `packages/services/src/settings-sync/settingsSyncService.ts`
- Create: `packages/services/src/settings-sync/types.ts`
- Modify: `packages/services/src/accessor.ts`
- Modify: `packages/services/src/index.ts`
- Modify: `packages/services/src/node.ts`
- Modify: `packages/client/src/remoteServiceAccess.ts`

### 实现步骤

1. 在 `settingsSync.ts` 里定义 `ISettingsSyncService` 和 `createServiceDescriptor`
2. 在 `types.ts` 中定义服务内部辅助类型：
   - 来源 repo 条目
   - 导入任务
   - 任务结果
3. 在 `settingsSyncService.ts` 中先实现最小骨架：
   - `detect()` 返回空结果
   - `importSelected()` 返回空统计
   - `getFirstRunPromptState()` 与 `markFirstRunPromptHandled()` 暂时透传 settingService
4. 在 `accessor.ts`、`index.ts`、`node.ts`、`remoteServiceAccess.ts` 完成注册与导出

### 验证

- 根级 `pnpm typecheck`

## Task 3：补齐首启设置状态

### 目标

让“首启提示只弹一次”有明确持久化状态，不和导入结果耦合。

### 修改文件

- Modify: `packages/services/src/setting/setting.ts`
- Modify: `packages/services/src/setting/settingService.ts`

### 实现步骤

1. 在 `AppSettings` 中新增：
   - `settingsSyncFirstRunPromptHandled?: boolean`
2. 在 `settingService` 中保留旧 settings 兼容
3. 为 `settingsSyncService` 提供两个调用路径：
   - 读取 prompt state
   - 写入 handled state
4. 注释说明：
   - 这是“提示是否已消费”，不是“是否导入成功”

### 验证

- 根级 `pnpm typecheck`
- 根级 `pnpm lint`

## Task 4：实现来源 repo 的 discovery 能力

### 目标

分别发现 `Claude Code / Codex / OpenCode` 的 Providers / Skills / Plugins 来源配置。

### 修改文件

- Create: `packages/services/src/settings-sync/repo/claudeSettingsSyncSourceRepo.ts`
- Create: `packages/services/src/settings-sync/repo/codexSettingsSyncSourceRepo.ts`
- Create: `packages/services/src/settings-sync/repo/opencodeSettingsSyncSourceRepo.ts`
- Create: `packages/services/src/settings-sync/repo/shared.ts`
- Modify: `packages/services/src/settings-sync/settingsSyncService.ts`

### 实现步骤

1. 为每个来源 repo 提供统一返回结构：
   - 是否发现来源
   - 各分类的 discovered item 列表
2. `skills` 发现优先复用现有 skills 目录规则，不重新发明路径
3. `plugins` 发现优先复用已有 native root / mirror root 规则
4. `providers` 发现按来源已有 workspace/user config 入口做最小读取
5. 在 service 中聚合成 `Agent -> Category` 摘要

### 验证

- 新增对应 service 单测或最少 smoke test
- 根级 `pnpm typecheck`

## Task 5：实现导入任务模型与 progress 事件

### 目标

把用户选择转换成稳定的顺序任务队列，并输出可驱动 UI 的进度事件。

### 修改文件

- Modify: `packages/services/src/settings-sync/types.ts`
- Modify: `packages/services/src/settings-sync/settingsSyncService.ts`

### 实现步骤

1. 把 `selection` 转成 `agent/category` 任务列表
2. 过滤未勾选或 discovered 为空的项
3. 为每个任务定义状态：
   - `pending`
   - `running`
   - `success`
   - `skipped`
   - `failed`
4. 每个任务开始和结束时都发 `onProgress`
5. 汇总 `successCount / skippedCount / failedCount`

### 验证

- 单测验证任务顺序与汇总统计

## Task 6：实现 Providers 导入

### 目标

完成 `Providers` 从来源到 ZCode 的安全导入，并遵守“已存在则跳过”。

### 修改文件

- Modify: `packages/services/src/settings-sync/settingsSyncService.ts`
- Optional Modify: `packages/services/src/model-provider/*` 仅在确需复用 helper 时

### 实现步骤

1. 从 discovery 结果读取来源 provider 条目
2. 和 ZCode 当前 provider 列表做冲突判断
3. 只对缺失项调用现有 model provider 落地能力
4. 不直接在同步服务里写 provider 存储文件

### 验证

- 单测覆盖“导入缺失项 / 跳过已存在项”

## Task 7：实现 Skills 与 Plugins 导入

### 目标

完成 `Skills`、`Plugins` 两类导入，并保持与现有镜像/启用体系一致。

### 修改文件

- Modify: `packages/services/src/settings-sync/settingsSyncService.ts`
- Optional Modify: 相关 `skillsService` / `plugins*Repo` helper，仅在复用不足时

### 实现步骤

1. `Skills`：基于现有来源目录规则，把缺失技能复制/镜像到 ZCode 受管位置
2. `Plugins`：基于已有插件镜像或 marketplace 安装信息做最小导入
3. 已存在项统一记 `skipped`
4. 失败项不阻断其他任务

### 验证

- 单测覆盖 skills/plugins 两类成功/跳过/失败

## Task 8：新增 UI hook 与首启弹层状态机

### 目标

在 UI 侧建立独立的首启设置同步流，不侵入现有 settings page 逻辑。

### 修改文件

- Create: `packages/ui/src/hooks/useSettingsSync.ts`
- Create: `packages/ui/src/settings-sync/SettingsSyncFirstRunDialog.tsx`
- Create: `packages/ui/src/settings-sync/SettingsSyncDiscoveryStep.tsx`
- Create: `packages/ui/src/settings-sync/SettingsSyncSelectionStep.tsx`
- Create: `packages/ui/src/settings-sync/SettingsSyncImportingStep.tsx`
- Create: `packages/ui/src/settings-sync/SettingsSyncCompleteStep.tsx`

### 实现步骤

1. hook 管理 discovery / selection / importing / complete 四阶段状态
2. 组件使用现有 design tokens 和按钮体系
3. 折叠列表采用 `Agent -> Category`
4. 至少选中一项才允许导入

### 验证

- 组件测试覆盖步骤切换和按钮可用性

## Task 9：接入 Root 首启触发逻辑

### 目标

只在真正首次打开且存在可导入项时弹出一次导入向导。

### 修改文件

- Modify: `packages/ui/src/Root.tsx`
- Optional Modify: `packages/ui/src/root/useRootPlatformEffects.ts`
- Optional Modify: 相关 app-shell 初始化入口

### 实现步骤

1. 在 root 稳定后检查：
   - 是否是首次打开场景
   - prompt state 是否已消费
   - `detect()` 是否有可导入分类
2. 满足条件时挂出 dialog
3. 用户点击“暂不导入”或成功导入后，统一标记 handled
4. 加 UI logger，方便排查首启时序问题

### 验证

- 手工验证首次打开/跳过/重启不再弹出

## Task 10：补测试与收尾验证

### 目标

补齐核心单测、组件测试和最终静态校验。

### 修改文件

- Create/Modify: 对应 test 文件

### 实现步骤

1. 覆盖 detect、导入汇总、首启 prompt state
2. 覆盖 UI 四步流与主按钮禁用逻辑
3. 运行：
   - `pnpm typecheck`
   - `pnpm lint`

## Batch 1 执行范围

本轮先执行：

- Task 1：定义 shared 类型与 RPC 频道
- Task 2：建立 services 骨架与注册链路
- Task 3：补齐首启设置状态

完成后停下汇报，等待下一批反馈。
