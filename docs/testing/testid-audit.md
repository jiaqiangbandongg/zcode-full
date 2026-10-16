# UI 组件 testid 审计报告

> **状态：2026-03-31 历史审计快照。** 表中的 `ChatView`、`ChatMessage`、`ChatInputToolbar`
> 等组件已被 V4 conversation UI 取代；本文不再代表当前缺口清单。当前 E2E 定位必须以
> `packages/shared/src/test-ids.ts`、V4 组件和现行 E2E 为准。

> 审计时间：2026-03-31  
> 审计范围：`packages/ui/src/**/*.tsx`，排除 `components/ui/`  
> testid 单一来源：`packages/shared/src/test-ids.ts`

## 规范说明

- 每个 React 级别的组件（对应一个用户可见的功能区）应有一个根容器 testid
- 动态列表项用 `testId(BASE, suffix)` 拼接，如 `testId(TID_TASK_ITEM, taskId)`
- testid 常量统一在 `test-ids.ts` 声明，组件中不硬编码字符串
- E2E 测试和 DOM 定位全部通过 `data-testid` 属性查找

---

## 审计结果

### 缺少 testid 的组件

| 组件文件 | 缺少的 testid | 说明 |
|---------|--------------|------|
| `SettingsPage.tsx` | `TID_SETTINGS_BACK_BUTTON` | `test-ids.ts` 已定义，但组件没有加上返回按钮的 testid |
| `PermissionDialog.tsx` | 容器 testid | 权限确认对话框整体没有 testid，E2E 无法定位 |
| `ChatPlan.tsx` | 容器 testid | 计划展示面板没有 testid |
| `ChatErrorBanner.tsx` | 容器 testid | 错误提示条没有 testid |
| `ChatInputToolbar.tsx` | 容器 testid | 底部配置工具栏（model/mode/thought 选择器）没有 testid |
| `DebugInfoBar.tsx` | 容器 testid | 调试信息栏没有 testid |
| `NewTaskButtonGroup.tsx` | dropdown trigger 按钮 testid | 切换 provider 的下拉箭头按钮没有 testid，仅主按钮有 `TID_TASK_NEW_BUTTON` |
| `WorkspaceSidebar.tsx` | 空状态 testid | 空状态提示 div 没有 testid |

### 已定义但实际未使用的 testid

| 常量名 | 问题 |
|--------|------|
| `TID_PREVIEW_PREV_BUTTON` | `PreviewPane` 用自动滚动加载，没有显式"上一段"按钮，testid 定义多余 |
| `TID_PREVIEW_NEXT_BUTTON` | 同上 |
| `TID_WORKSPACE_PATH` | 未在任何组件中使用 |
| `TID_LOCALE_TOGGLE` | `LocaleSwitcher.tsx` 没有使用此 testid |

---

## 覆盖良好的组件（供参考）

| 组件 | testid 覆盖情况 |
|------|--------------|
| `WelcomeScreen.tsx` | 完整：form、username、password、button、error |
| `Terminal.tsx` | 完整：容器、关闭按钮 |
| `SSHDialog.tsx` | 完整：触发按钮、弹窗容器、所有输入框、确认/取消 |
| `FileTree.tsx` | 完整：根容器、每个 item（动态后缀） |
| `EmbeddedBrowserPane.tsx` | 完整：容器、地址栏、前进/后退/刷新/调试、webview |
| `PreviewPane.tsx` | 部分：有容器和关闭按钮，但定义了 PREV/NEXT 却未实现 |
| `TaskList.tsx` | 完整：容器、每个 item、删除按钮、空状态、设置按钮 |
| `NewTaskButtonGroup.tsx` | 部分：主按钮有 testid，下拉 trigger 没有 |
| `ChatView.tsx` | 完整：容器、消息列表、空状态、输入框、附件按钮、发送/停止、loading |
| `ChatMessage.tsx` | 部分：仅工具调用里的"查看代码"按钮，消息气泡本身没有 testid |
| `App.tsx` | 完整：header、sidebar、tabs、workspace header、ZCode 状态徽章 |
| `WorkspaceSidebar.tsx` | 部分：主容器、工作区列表/item/close、打开按钮，但空状态缺 testid |
| `SettingsPage.tsx` | 部分：页面容器有，返回按钮缺 |

---

## 修复优先级建议

**P0（E2E 流程强依赖）**
- `PermissionDialog` 容器 testid —— 权限流程无法自动化测试
- `ChatErrorBanner` 容器 testid —— 错误场景无法断言，也无法机械执行“正向 conversation case 默认不得出现 `ChatViewErrorBanner`”的验证标准

**P1（功能区定位）**
- `ChatInputToolbar` —— 覆盖模型/模式选择器
- `ChatPlan` —— 计划步骤面板
- `DebugInfoBar` —— 调试信息栏
- `NewTaskButtonGroup` dropdown trigger

**P2（清理冗余）**
- 删除 `TID_PREVIEW_PREV_BUTTON`、`TID_PREVIEW_NEXT_BUTTON`（或真正实现翻页按钮）
- 删除 `TID_WORKSPACE_PATH`（无对应 UI）
- 在 `LocaleSwitcher.tsx` 补上 `TID_LOCALE_TOGGLE`，或从 `test-ids.ts` 删除

---

## 修复步骤模板

1. 在 `test-ids.ts` 补充新常量（带中文注释）：
   ```ts
   /** PermissionDialog 权限确认容器 */
   export const TID_PERMISSION_DIALOG = "permission-dialog";
   ```

2. 在组件根元素加 `data-testid`：
   ```tsx
   import { TID_PERMISSION_DIALOG } from "@zcode/shared";
   
   <Confirmation data-testid={TID_PERMISSION_DIALOG} ...>
   ```

3. 如果组件不支持 `data-testid` prop（如 ai-elements 组件），包一层 `<div>`：
   ```tsx
   <div data-testid={TID_CHAT_PLAN}>
     <Plan ...>
   ```
