# SelectedKey Migration E2E Network Isolation Design

## 问题与目标

`conversation-session-model-provider-selected-key-migration.test.ts` 的 I32～I34
只验证本地 `modelProviderFamilySelectedKeys` 启动迁移，但 WDIO 默认 fixture 会写入
`oauth:active_provider=zai`、Z.AI access token 与 `zcodejwttoken`。应用重载后因此进入
OAuth 恢复刷新，并使用假的 `e2e-oauth-token` 请求真实 Z.AI provider、API Key 与权益接口。

本次修复的目标是让 I32～I34 完全不依赖外部网络，同时保持真实 App 重载和本地设置迁移
链路不变。OAuth 恢复后的远端刷新语义由已有 UI 单测独立覆盖，不在这三个迁移 case 中重复。

## 选定方案

为 selectedKey migration spec 增加显式的启动凭据策略：

- 保留 fake `auth_token`，兼容仍读取 legacy token 的通用 E2E 辅助链路。
- 不写 `oauth:active_provider`。
- 不写 `oauth:zai:access_token`、OAuth user info 或 `zcodejwttoken`。
- 继续使用现有 fake settings、model provider 与 replay fixture。

凭据选择逻辑抽成无副作用的纯函数，由 WDIO `seedE2EStartupState()` 调用。单元测试直接断言
selectedKey migration spec 的结果不包含任何可触发恢复刷新或 Plan 网络请求的凭据。

## 启动时序

修复前：

```text
fake active OAuth session
  -> restoreCachedSession
  -> refreshCodingPlanApiKey(Z.AI Coding + Start)
  -> 真实 provider/API Key/权益请求
  -> 再次按 selectedKey 刷新
  -> 本地 selectedKey migration
```

修复后：

```text
fake local settings/providers + legacy auth_token
  -> restoreCachedSession: active provider 不存在
  -> 跳过 OAuth provider family 刷新
  -> 本地 selectedKey migration
  -> I32/I33/I34 读取 setting.json 断言
```

## 状态组合与剪枝

| 组合 | 处理 | 原因 |
| --- | --- | --- |
| 本地 mode/selectedKey 冲突 + 无 active OAuth | 保留 | I32～I34 的最小产品语义 |
| 本地迁移 + Z.AI OAuth 恢复成功 | 剪枝 | OAuth 恢复刷新已有 `rootOAuthCallbackHandling.test.ts` 覆盖 |
| 本地迁移 + 真实 Z.AI 网络成功/失败/超时 | 剪枝 | 与 selectedKey 迁移算法无关，且会引入外部不确定性 |
| BigModel Team 完整/畸形 identity | 保留 | 分别对应 I33/I34 的核心边界 |

## 代码与测试范围

- 新增纯函数 helper：根据 worker specs 构造默认或 network-isolated credentials fixture。
- WDIO 启动 seed 改用该 helper；其他 spec 的默认 OAuth fixture 保持兼容。
- 单测先验证当前实现会错误地产生 active OAuth 凭据，再实现 helper 使其通过。
- 运行 I32～I34 的目标 E2E，确认用例完成且运行日志中不出现
  `model-provider.refreshCodingPlanApiKey` 或真实 `billing/balance` 请求。
- 执行项目强制的 `pnpm typecheck` 与 `pnpm lint`。

## 非目标

- 不修改产品 OAuth、provider 刷新、重试或超时逻辑。
- 不缩短真实网络请求超时。
- 不为该迁移 spec 搭建完整 OAuth HTTP mock server。
- 不改变桌面 continuous、手机 remote replayable、workspace identity 或 Agent runtime 语义。
