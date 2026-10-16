# Onboarding Session Unlimited Scan

## 背景

设置页“引导”里的数据迁移向导会扫描本机 Claude Code 原生会话。此前会话步骤只提供 `30`、`50`、`100` 三个返回数量选项；底层扫描服务已经支持不传 `limit` 时返回全部候选。

## 行为

- Onboarding 会话步骤的返回数量下拉展示：
  - `30`
  - `50`
  - `100`
  - `不限制`
- 选择 `不限制` 时，UI 不向 `scanImportableClaudeSessions` 传入 `limit`。
- 服务层继续按现有逻辑扫描、过滤并按 `updatedAt` 倒序排序；只有传入正数 `limit` 时才截断结果。

## 边界

- 该改动只影响 onboarding 数据迁移向导的会话扫描选项。
- 独立设置迁移页的数字输入仍保持当前最大 500 的交互。
- 不改变导入逻辑、workspace 筛选、时间范围筛选或 desktop/web 支持边界。
