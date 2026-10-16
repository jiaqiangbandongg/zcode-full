# 输入框模型、Provider 与 Team Plan 当前链路

更新日期：2026-07-15

> **历史链路说明，已被 Provider Refactor 取代。** 文中的 App Provider Snapshot、
> `modelProviderService` 和向 workspace 推送 Registry 的描述不再是当前事实。当前 UI 消费目标
> Environment 的 Model Selection View；Provider 与 Account Overlay 在该 Environment 内解析。
> 当前设计见 `docs/working-memory/provider-refactor/design/`。

## 结论

输入框不是 provider registry 或 session config 的事实源。当前链路分为三个边界：

```text
App modelProviderService + entitlement + family settings
  -> V4ComposerToolbar 构造可见模型目录
  -> 用户选择
      draft: draftConfigRef + workspace default + 预热 session CAS
      session: V4 switchModelConfig CAS
  -> CLI runtime config（会话权威）
  -> ConversationSnapshot.config（工具条当前值）
```

- app provider snapshot 决定“哪些 provider/model 可以展示和选择”。
- `ConversationSnapshot.config` 决定已有 session “当前实际是什么模型”。
- draft 没有历史 session 事实，使用全局上次选择、workspace 目录和本草稿显式选择建立初值。
- Team Plan 是 BigModel family 的一种连接身份，不是新的模型类型；runtime provider 仍是
  `builtin:bigmodel-coding-plan`，团队组织/项目只决定凭据和请求上下文。

## 当前代码入口

| 模块                                                                                       | 职责                                                                   |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`                                        | 合并 V4 config、provider snapshot、family 设置和 entitlement，构造菜单 |
| `packages/ui/src/ModelConfigSelect.tsx`                                                    | 纯展示、选择、锁定提示和“管理模型”入口                                 |
| `packages/ui/src/lib/modelSelectionGroups.ts`                                              | provider/model 分组、排序和 runtime id 映射                            |
| `packages/ui/src/chat-input-toolbar/modelSelection.ts`                                     | 存活的值归一化、family/Plan 可见性、不可用模型 fallback 纯函数         |
| `packages/ui/src/v4/composer/useDraftConfigControl.ts`                                     | draft 水合、乐观回显、workspace default 和首发 config                  |
| `packages/ui/src/v4/SessionPane.tsx`                                                       | V4 config command、provider registry 自动恢复和发送屏障                |
| `packages/ui/src/hooks/useModelProviders.ts`                                               | app provider snapshot 水合和共享更新                                   |
| `packages/ui/src/lib/modelProviderRuntimeSync.ts`                                          | 把 app registry 单向同步到已打开 workspace                             |
| `packages/services/src/model-provider/modelProviderService.ts`                             | provider registry、family domain、Team Plan runtime 投影               |
| `packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts` | Team Plan 产品、项目和 key 预热                                        |

## 模型菜单的数据源

### Provider 目录

`useModelProviders` 先读 `getAllCached()`，再后台读 `getAll()`；设置页保存后立即更新共享 snapshot，
关键 runtime 字段变化再同步到所有已打开 workspace。ZCode Agent 菜单只使用 app provider registry
构造 provider/model groups，不把 CLI 返回的 native available list 反向混入完整目录。

Provider 进入菜单前至少要满足：

- enabled；
- 有模型；
- 有可用 credential 或被 Coding/Start Plan 的专用鉴权规则允许；
- endpoint format 可被 ZCode Agent runtime 使用；
- provider family、当前 connection selection 和 entitlement 没有把它过滤掉。

目录仍在 entitlement/provider 水合时，不把暂时不可见的历史模型立即判为不可用。水合完成且模型确实不存在时，
已有 session 才能通过 `modelAutoPosition.ts` 选择首个可见 fallback，并把选择写回 CLI。

### Session 当前值

已有 session 的 provider/model/thought 只读 `snapshot.config`。workspace `configOptions` 提供目录和草稿
default，不再通过 `taskConfigOptionsByTaskId`、task meta 或 last-selected 覆盖一个已绑定 session。

草稿当前值由 `useDraftConfigControl` 合并：

1. 当前 workspace identity 下的全局上次选择；
2. workspace model catalog；
3. 本草稿用户显式选择（最高优先级）；
4. renderer draft mode 偏好和 app follow-up setting。

## Family 与连接方式

`providerFamilyDomain` 是当前登录/运行 family 的第一层边界，只允许 `zai | bigmodel`。family 内再由：

- `modelProviderFamilyModes[family]` 选择 OAuth/Plan 或 API Key 大类；
- `modelProviderFamilySelectedKeys[family]` 选择具体 Start、Individual、Team project 或 API Key 项。

输入框只展示当前连接方式对应的模型，不在菜单内切换连接方式。连接方式在 Model Provider 设置页修改，
输入框的 family header 只显示短 badge。自定义 provider 仍使用 provider 二级菜单；手机远控隐藏“管理模型”入口。

选择模型后：

- 已有 session：`SessionPane` 发送 `switchModelConfig`，revision/CAS 与 send barrier 保证顺序；
- draft：先更新 `draftConfigRef` 和 workspace 目录乐观值，有预热 session 时再发同一个 V4 command；
- CLI 返回 `provider.notInRegistry` 时，按 `workspaceIdentity` / `remoteSessionId` 同步 registry，解析
  `runtimeModel` 后只重试一次；
- 成功或 noop 最终都要由 snapshot config 确认，不能以 dropdown 本地值代替 runtime 事实。
- family 连接方式因 entitlement 刷新发生自动回退时，`SessionPane` 必须把当前 snapshot 中的旧
  runtime provider 通过 `switchModelConfig` CAS 切到新连接方式；不能只更新设置页 selected key
  或 provider registry，否则连接方式与输入框模型会分叉。

详细模型链路见 `docs/chat/model-resolution-chain-audit.md`。

## Coding Plan 与 Start Plan

- Z.ai Coding Plan 在 authenticated 或 snapshot 尚未水合时可保留；BigModel Coding Plan 必须有有效
  entitlement，Team selected key 走团队上下文专用判断。
- paid Coding Plan 有有效 entitlement 时隐藏同 family Start Plan；只有明确 `no_plan` 才允许 Start
  Plan fallback。查询中、网络失败、token 失效不能伪装成 `no_plan`。
- Start Plan 模型受白名单限制，避免缓存中的下线模型继续出现。
- context usage 只读取当前模型所属 plan identity；不能复用 sidebar 的另一个账号/family 用量。

## Team Plan 当前语义

Team Plan 只在 BigModel family 开放。一个账号可以有多个 organization/project；连接 key 必须同时包含
`organizationId + projectId`。可见名称优先使用真实 `organizationName`，缺失时不把 ID、项目名或通用
“Team Plan”伪装成组织名。

每个已购团队项目独立预热项目级 API key：

```text
GET /api/biz/v1/organization/{organizationId}/projects/{projectId}/api_keys
  -> 复用 name=zcode-team-api-key 且 keyType=2
  -> 不存在则 POST 创建
  -> 仅当前选中的团队项目按需 copy secret
  -> runtime 使用 apiKey.secretKey
```

- 请求必须携带 `bigmodel-organization` 与 `bigmodel-project` header。
- 不能复用个人 preset 的 `zcode-api-key`，也不能复用同名但 `keyType != 2` 的 key。
- 预热所有团队项目时只确保 key 存在，不批量复制 secret；单项目失败不阻断其他项目。
- `apiKeyStatus=available | unavailable` 是产品状态。unavailable 项在设置页保留并解释原因，但输入框和
  自动连接选择不能把它当成可发送连接。
- runtime/quota 只消费当前 `modelProviderFamilySelectedKeys.bigmodel` 指向的组织/项目，禁止把其他团队
  key 混入当前 Agent registry。

## 多端与身份边界

provider registry 权威在 app/desktop Local Host，并单向推送到承载目标 workspace scope 的 Local/Remote Host
及其 workspaceKey CLI。远程 workspace 同步、
V4 模型恢复和 runtime resolution 必须携带 `workspaceIdentity` 与 `remoteSessionId`；缓存 key 不能只使用
`workspacePath`。手机 `/remote` 附着现有 host/session，不创建另一份 provider registry 或 Agent runtime。
