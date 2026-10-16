# 新建 Task 的当前模型判定链路

更新日期：2026-07-16

V4 中“新建 task”先表现为未绑定 session 的 draft pane。模型事实来自 renderer draft intent 与
last-selected 配置种子；首发后才由 CLI session projection 成为权威。旧
`createTaskWithSessionControl` 和 legacy `runtimeModel` 首发链路已不再是 UI 主路径。

## 草稿配置来源

草稿配置由 `useDraftConfigControl` 维护：

1. mode 从 renderer 的 draft mode 偏好读取，不以 workspace catalog 为持久事实。
2. 模型和 thought 优先读取该 workspace 身份下的全局 last-selected 配置元组。
3. workspace `configOptions` 提供可选目录并校验选择；目录未加载时
   `prepareWorkspaceWithZCodeSessionService` 负责水合。
4. 用户本次显式选择写入 reactive draft intent，优先于初始种子和异步目录回包。
5. `followupMode` 来自 app 设置，并随 create config 传递。

last-selected 的 model 与 thought 是一个不可拆分元组：

- thought 必须按该模型的能力过滤，不能把全局独立 thought 应用到另一模型；
- 跨模型 intent 先清空 thought，由目标 runtime 决定实际默认/兼容档位；
- 外部 custom provider 的上次模型仍可用时，Z.ai/BigModel family 的连接记忆不能把它覆盖；
- 上次模型属于当前 family 时，Coding/Team Plan 只约束该 family 内的 provider 与可用模型；
- 当前 Plan provider 暂不可用时，不退回同 family 的旧连接。

所有 workspace 级隔离使用 `workspaceKey = workspaceIdentity?.trim() || workspacePath`；文件和命令
执行仍使用 `workspacePath`。

## 显式选择与偏好确认

草稿切换先更新 intent；有 prewarm session 时再对明确 `targetSessionId` 发送 V4 CAS。偏好写入遵守：

```text
draft intent: { model: B, thought: null }
  -> switchModelConfig(target prewarm session)
  -> accepted/noop: last-selected = { B, null }
  -> state.updated: last-selected = { B, actualThought }

synthetic empty thought ----------------X
failed/stale/superseded ----------------X
历史 session snapshot -----------------X
```

pending intent 绑定发起 session；迟到 ACK 或投影不能覆盖更新的用户选择。用户显式选择非空 thought
时，accepted/noop 提交完整 `{ model, thoughtLevel }`。自动 fallback、打开历史 session、App 重启和
后台 selected-key 迁移都不构成用户选择。

Model Settings 的 family 连接切换也不等于聊天工具条选模型：当前草稿使用 family 外且仍可用的模型时，
保留原 draft session；只有草稿属于变化的 family，或当前模型已无法识别时，才关闭未使用的 deferred
session 并按目标连接重建。目标 Plan 内仍可用的具体模型继续保留。

## 预热路径

draft pane 后台创建一个纯内存、deferred 的 draft session：

```text
draft pane mount
  -> createSession { workspaceId, config: initialDraftConfig }
  -> CLI 创建 deferred session（不落 SQLite、不进 sessions-index）
  -> conversation snapshot 到达
  -> draft intent 如有更新，再用 CAS 对齐 config
  -> 首发 sendText
  -> promote，pane 原地绑定 sessionId
```

预热 session 未使用就切走时调用 `deleteSession` 清理。创建仍在飞时，ACK 到达后只能条件清理
`deferred` session；首发已经提升为 `immediate` 后不得被迟到 cleanup 删除。提交 prepare 结果前也要
重新核对 pane/session binding，避免旧 workspace 回包覆盖已创建 task。

## 首发路径

首发按以下优先级执行：

1. 有预热 session：等待配置屏障，再对预热 session 执行 `sendText`；accepted 后提升并绑定。
2. 无预热且无附件：执行
   `createSession { workspaceId, config, firstInput: { text } }`，配置必须在 firstInput 前应用。
3. 无预热且附件 ready：先创建空 session，再用 `sendText` 提交附件引用；点击发送时不启动上传。
4. `/goal` 等需要 session 的 draft slash command：复用预热 session，或创建空 session，再派发命令。

`buildDraftCreateConfigPayload` 合并当前 intent、app follow-up 设置和同步可读的初始配置。用户显式写入
的 draft 值优先，避免目录水合晚于立即首发时退回 builtin 模型。首发经过同一个 config barrier，
不能越过最新模型/mode/thought 命令。

## CLI 创建语义

`commands/handlers/session-mgmt.ts` 创建 deferred session 后，在首条输入之前调用
`applyRequestedSessionConfig`：

- 请求 config 覆盖 runtime 缺省；
- 跨模型时安装/解析 provider client，并采用目标模型支持的实际 thought；
- mode 只接受 `build | edit | plan | yolo`；
- 非默认 follow-up mode 写入 runtime；
- `ModelSelected` / `SessionModeChanged` 等事件让 projection 可冷恢复。

配置应用失败时 create ACK 仍可成功，session 保持 runtime 缺省并记录 warn。因此 UI 的预热与首发
屏障仍要检查配置 ACK 和最终 projection，不能只相信本地选择器。

如果 last-selected 元组在当前 registry 已不可解析，renderer 不按菜单第一项另写一份 fallback。
`createSession` 使用可用 runtime 缺省；registry 在 session 创建后变化时，由 Agent 在 idle/next-turn
安全边界执行同一套 fallback，并以目标模型实际 thought 的 `ModelSelected` 校准草稿 projection。

## 多端边界

桌面和手机附着到同一 shared-host/CLI session 事实。区别只在 topic delivery：桌面是 continuous，
手机远控是 replayable recovery。relay/main 不创建另一份 draft runtime，也不保存草稿模型或 session
queue。远程链路必须贯穿 `workspaceIdentity` 和 `remoteSessionId`。

## 当前代码入口

- `packages/ui/src/v4/composer/useDraftConfigControl.ts`
- `packages/ui/src/v4/composer/useDraftSessionPrewarm.ts`
- `packages/ui/src/v4/composer/draftGlobalModelSeed.ts`
- `packages/ui/src/v4/composer/modelConfigPreferenceConfirmation.ts`
- `packages/ui/src/hooks/workspacePrepareModelPreference.ts`
- `packages/ui/src/v4/SessionPane.tsx`
- `packages/ui/src/lib/zcodeModelPreference.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-mgmt.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/model-config.ts`
