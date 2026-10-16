# OAuth 登录失败文案与失败态交互

## 背景

OAuth 登录失败时，底层服务可能返回 provider、网络、token exchange 或业务账号状态的具体错误。登录入口面向用户只需要给出可重试的明确反馈，不应把底层错误原文直接展示在登录页。

## 规则

- 登录入口展示的 OAuth 失败文案统一为：`登录失败，请重试`。
- Root 层 OAuth 回调失败、登录入口发起 OAuth 失败都使用同一份共享文案。
- 具体错误原因只写入 UI logger，不进入 `oauthError` store 或 `useOAuth` 的可见 `error` 状态。

## 失败态交互（2026-09-07 起）

- 失败态 UI 为三件套：warning Alert + 「重新登录」（default，沿用最近失败渠道重试）+ 「取消」（outline，样式与等待态取消一致）。
- 失败期间渠道按钮列表不渲染（渲染条件 `status === "idle" && !oauthError`）。此前 Root 层 `oauthError` 触发的失败会把本地状态 reset 回 idle，导致失败块与渠道按钮同屏、状态纠缠；三个失败入口（init 失败 / 轮询失败 / deep link 回调失败）统一为同一视觉。
- 「取消」对齐等待态取消语义：结束本次失败流程回到渠道列表，登录入口不关闭；用户换渠道走「取消 → 渠道列表」，原渠道重试走「重新登录」。此前失败态只有沿原渠道的「重新登录」，容易反复失败且无换渠道出口。
- 新登录发起前（`startTrackedLogin`）统一清掉 store 残留 `oauthError`，避免失败提示与新流程的等待态同屏（如失败后关闭登录入口、再从设置页自动续接登录）。
- 重试、切换登录方式（API key）等其余交互保持不变。

## 兼容性

- 桌面端和 Web 端共用 `packages/ui` 登录入口，因此文案收敛在 UI 层完成。
- 不修改 OAuth 协议、host process、relay、session/task realtime 链路，不影响 desktop `continuous` 或 mobile remote `replayable` 语义。
