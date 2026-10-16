# CUA `request_access` 实时权限引导 Spec

- 日期：2026-08-25
- 状态：实现中
- 关联：producer `zcode-cua` !576、consumer `z-code` !2315

## 产品合同

`request_access` 是只读权限快照，不直接触发 native prompt。Producer 在 macOS 成功结果的
namespaced `_meta` 中提供版本化状态；Consumer 只在 official-CUA authority、精确工具名、严格
schema 和本地 `desktop-continuous` live event 同时成立时生成一次权限观察。

```text
live official request_access
  -> typed metadata
  -> authority-gated CLI projection
  -> desktop-only live observation
  -> fresh Host status
  -> ZCode confirmation
  -> fresh Host status
  -> existing onboarding
  -> Helper restart + refresh

history / recovery / mobile / remote / ordinary error -> no side effect
```

## 状态与副作用

- Accessibility 的 `denied`、`stale` 和 Screen Recording 的 `denied` 是确定缺权；`unknown`
  不触发该权限的引导。
- 所有当前桌面窗口管理的本地 live task 都可以触发，不要求任务可见或 workspace 当前激活。
- 同一 `workspaceKey + sessionId + turnId + missingPermissions` 只确认一次；确认或 onboarding
  进行中合并并发观察。未来新 turn 的新 `request_access` 可以再次提醒。
- 确认前和确认后都调用 `getStatus(..., {includeFunctionalProbes:false})`，只以新鲜状态决定权限列表。
- 两项都缺失时顺序固定为 Accessibility、Screen Recording。
- 用户取消不打开系统设置；授权返回后仅按现有 owner 合同重启对应 Helper 并刷新状态。
- 不调用 conversation command，不自动 continuation，不重放 `request_access` 或此前动作。

## 交付与身份边界

- Wire observation 只由 live `ToolCallResult` 生成，不进入 snapshot、transcript 或 recovery。
- `desktop-continuous` 的可信 renderer 可以订阅；`web-remote-replayable` 返回空事件。
- `workspaceKey = workspaceIdentity?.trim() || workspacePath` 用于隔离；执行和 Helper 查询继续使用
  `workspacePath`。携带 `remoteSessionId` 或远程 identity 的 workspace 直接剪枝。
- 第三方同名 MCP、malformed metadata、普通 `permission_denied`、历史
  `CUA_PERMISSION_REQUIRED` 文本和 Tool Card JSON parser 均不能触发。

## UI

复用全局 ConfirmDialog 和既有 onboarding，不新增 modal 体系。文案说明正在运行的电脑操作任务
需要 macOS 权限，操作为“前往授权 / 暂不授权”。后台窗口只排队显示确认框，不主动抢焦点。

## 验证

- Producer：metadata schema、文本不变、只读/跨平台 fail closed。
- Core/Protocol：authority、工具名、strict schema、live-only 和 clientMode 边界。
- UI：新鲜状态双检查、并发合并、同 turn 去重、取消/确认、Helper 恢复与零任务重放。
- E2E：后台任务、cold restore、mobile replayable 和普通错误代表 case。
