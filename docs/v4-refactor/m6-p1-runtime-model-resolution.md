# M6 Phase 1 — CLI provider/凭据解析（runtimeModel）历史设计

> **状态：已被 Provider Refactor 取代，仅保留方案选择与迁移轨迹。** 当前常态由目标 Environment 的
> Provider Registry 与 ModelFactory 创建 Active Model；`workspace model catalog`、`runtimeModel` 回落、
> `workspace/updateProviderRegistry` 和凭据快照下发已经退出。当前事实见
> `docs/working-memory/provider-refactor/design/`。

补齐 v4 「切模型只支持同 provider 直切」的地基：让**跨 provider / 切连接方式**真正在 runtime 生效。
承 `m6-model-selection-parity.md`；用户裁决全量对齐 + 保留默认兜底与 coding-plan 逻辑。

## 0. 一句话结论（勘查两侧后的关键发现）

**app 从不手搓 runtimeModel。** 老版 toolbar 只推「模型 ref 选择」，真正的 `runtimeModel`
（凭据/endpoint/Start-Plan JWT 头/Team-Plan projectId+key/官方版本安全校验头/thought 收窄）由
**存活的 service 层**（`packages/services/.../zcodeAgentService.ts` + `modelProviderService.ts`）
在每次 RPC 派发时**从 app 的 provider registry 快照惰性解析**。该 service 层是**共享基建，
不是被删的 UI toolbar，也不在 CLI 的 `zcode-protocol/` 禁区**——v4 可整体复用。
→ **「保留 coding-plan + 默认兜底」几乎白送：只要复用 service 层的解析/registry 快照，不重写。**

## 1. 现状事实（两侧勘查）

### CLI 侧（apply 原语 + 兜底）

- v4 handler `zcode-protocol-v4/commands/handlers/model-config.ts:41` 只 `app.setModel(formatModelRef)`
  ——**只在当前 registry 内重选模型，不换 provider client**（注释 :36 自认）。
- 真正换 provider client 的核心原语（v4 可原生调，不碰禁区）：
  **`record.app.setModelCatalogOverlay(overlay)`（装带凭据的 provider registry → `modelAdapter.replaceRegistryConfig`，`app/model-catalog-overlay.ts:69`）→ 再 `app.setModel(...)` + 可选 `setThoughtLevel`。**
- overlay 由 `createModelCatalogOverlay(catalog, env)`（`zcode-protocol/workspace-model-catalog.ts:1181`）
  从 `context.workspaceModelCatalogs` 构建；catalog 由 `updateProviderRegistry` 推入。
- **无桥禁令**（`bootstrap/tests/v4-native-boundary.test.ts`）：v4 目录禁 import 任何 `zcode-protocol/`
  路径（含 server-operations **与** workspace-model-catalog）；但 `record.app.*` / `record.app.runtime.*`
  自由可调。**binder `v4-bridge.ts` 在旧目录，合法 import workspace-model-catalog 的原语** → overlay 构建走 host capability 注入。
- **要保留的 CLI 兜底**（都在 apply 写路径之外，本 Phase 不动、原样保留）：
  `reconcileResumedRuntimeSettings`（`server-operations.ts:3106`：`runtime_model_authoritative` :3136 + `persisted_model_unavailable` 保留当前值并 warn :3145）、
  `derivePersistedRuntimeSettings`（:3013）、`ensureSessionModelAvailableForNextTurn`（:2535，**已绑为 v4 `ensureModelReady` hook**）、`DEFAULT_MODEL`/`createModelConfigMissingError`（`model-config.ts:33/47`）。

### App/service 侧（解析 runtimeModel + coding-plan + 兜底）

- **两层**：toolbar（`modelChangeActions.ts` 三条 handler：推 model-ref + 决定 restart + 推 registry）
  → service（`zcodeAgentService.ts`：`const runtimeModel = params.runtimeModel ?? await resolveRuntimeModelConfig({...})`，从 `modelProviderService.getProviderRegistrySnapshot()` 惰性解析并随 RPC 下发）。
- **runtimeModel 解析引擎**（service，共享，**复用不重写**）：`resolveRuntimeModelConfig`（`zcodeAgentService.ts:1569`）+ `createRuntimeModelConfig`（:645）+ `modelProviderService.buildProviderRegistrySnapshot`（:803）。
- **coding-plan/start-plan/team-plan 凭据注入全在 service 层**（⚠️ 保留）：
  `pickResolvedFamilyProvider`（连接方式 Start/APIKey/Coding/Team 选型，:196）、
  `buildStartPlanRuntimeAuthorizationHeaders`（Start Plan `Authorization: Bearer <jwt>`，:541）、
  `resolveSelectedBigModelTeamPlanRuntimeApiKey`（Team Plan org/projectId + project key，:559）、
  剥离官方版本安全校验一次性头的 helper（:516）、
  `resolveSupportedRuntimeThoughtLevel`（目标模型不支持 thought 则丢弃，:615）、
  Team Plan 移除守卫（provider 被过滤则抛 unavailable 不静默兜底个人 key，:1615/:855）。
- **runtimeModel schema**（`shared/zcode-protocol/index.ts:523` `zcodeModelRuntimeConfigSchema`）：
  `{revision, generatedAt, model{providerId,modelId,variant?}, provider(providerId,kind,apiFormat?,baseURL?,apiKey?(inline/credential/env),apiKeyRequired?,headers?,providerOptions?,models[]…), thoughtLevel?}`。
- **service 契约**：`IZCodeAgentService.setModel({..., model, runtimeModel?, modelProviderFamilySelectedKeys?})` / `updateRuntimeModelConfig({..., runtimeModel, applyModelSelection?})` / `updateProviderRegistry({..., registry})`。
- **要保留的 app 兜底**（多数属 Phase 2，本 Phase 只需复用 service resolver 自带的那部分）：
  `resolveRuntimeModelConfig` 内建兜底（历史缺失→undefined 让 agent 恢复 :1583；provider 被移除→抛 unavailable :1615；stale 默认→registry 首个可用 :1678）。
  toolbar 侧的 `resolveUnavailableModelListFallback` / `resolveLoginProviderFirstModel` / `<synthetic>` / context-window guard / recovery path 归 **Phase 2**（本 Phase 不做，但设计不能挡它们）。

## 2. 核心设计：1c 混合（用户 2026-07-07 裁决）

runtimeModel（含凭据）怎么进 CLI，三方案对比后**选定 1c 混合**：常态走 1b（CLI 从已推
registry 解析），provider 不在 registry（刚加/竞态/远端）时回落 1a（app 解析 runtimeModel 随命令推）。
逐字落地用户「优先 app 传（registry）/ 没有用 CLI 现值 / 更新同步（re-push）」。

| 方案                            | app 侧                                                                                            | v4 协议                                                   | CLI 侧                                                                                                             | 评价                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **1a 每次切换推 runtimeModel**  | 复用 service resolver 解析 runtimeModel，塞进 `switchModelConfig` payload                         | `switchModelConfig` additive `runtimeModel?`（重 schema） | host capability 把 `runtimeModel.provider` 并入 catalog + 建 overlay + setModel                                    | 最贴老版（legacy `session/setModel` 恒带 runtimeModel）、最稳、支持远端；但每命令带凭据、v4 协议耦合重 schema |
| **1b CLI 从已推 registry 解析** | 只发 `{provider,model}`（现状），保证 registry 已推（连接/凭据变更时 re-push）                    | 零改动                                                    | host capability 从 `context.workspaceModelCatalogs` 建 overlay + setModel                                          | 最省（无协议改、无凭据满天飞）、最贴 v4「CLI 权威」；依赖 registry 时效性                                     |
| **1c 混合（推荐）**             | 常态走 1b（registry 权威）；provider 不在 CLI registry（刚加/竞态/远端）时回落 1a 带 runtimeModel | additive `runtimeModel?`（可选，仅回落用）                | host capability：payload 有 runtimeModel 用之；否则从 registry 建 overlay；都缺→抛 unavailable 让 app re-push 重试 | 正好落地用户三段式：**优先 app 传（registry）/ 没有用 CLI 现值 / 更新同步（re-push）**；回落链完整            |

**推荐 1c**：与用户心智（"优先 app 传给 cli；没有用 cli 返回；更新同步"）逐字对上，且 registry 常态、runtimeModel 仅作竞态/远端回落。若想先快落地，可先做 **1b 最小闭环**（依赖现有 registry 推送），再补 1a 回落。

## 3. 分步实现（1c）

**Layer A — v4 协议（additive）** `packages/shared/src/zcode-protocol-v4/command.ts:65`

- `switchModelConfig` 加 `runtimeModel?`（可选）。schema 复用 `@zcode/shared/zcode-protocol` 的 `zcodeModelRuntimeConfigSchema`（共享包内引用，非 CLI 服务桥；若嫌耦合可定义 v4 mirror——决策见 §5）。
- `createSession.config` 同样支持携带（首发即用正确 provider），`applyRequestedSessionConfig` 消费。

**Layer B — CLI binder + handler**

- `commands/types.ts:41` `V4CommandCoreHost` 加能力 `resolveAndApplyRuntimeModel(sessionId, { model, runtimeModel? }): Promise<{applied:boolean, reason?}>`（过渡 hook，死期=配置面 v4 化，与 `ensureModelReady` 同档）。
- `v4-bridge.ts:42` coreHost 实现（旧目录合法）：
  - payload 带 runtimeModel（1a 回落）→ `applyRuntimeModelConfigToWorkspace` 并入 catalog；
  - 否则从 `context.workspaceModelCatalogs.get(workspaceKey)` 取已推 registry；
  - `syncAppWorkspaceModelCatalog` → `app.setModelCatalogOverlay(overlay)`；provider 缺失→返回 `{applied:false, reason:"provider_not_in_registry"}`（不抛，交 handler 出结构化 ACK 让 app re-push 重试）。
- `handlers/model-config.ts:41` `switchModelConfig`：`app.setModel` **之前**调 `host.resolveAndApplyRuntimeModel(...)`；`applied:false` → `failed` ACK（reasonCode `provider.notInRegistry`）不静默；其余保持 setModel/setThoughtLevel/emitModelSelected。`applyRequestedSessionConfig` 同接。

**Layer C — renderer/service（app 侧）**

- 1b 常态：保证 registry 时效——沿用现有 `updateProviderRegistry` 推送；**连接方式变更（P4b）/加 provider 时触发 re-push**（对齐老版 `syncModelProviderRegistryBeforeCustomModelWrite`）。
- 1a 回落：暴露 service resolver 供 v4 调——`IZCodeAgentService` 加 `resolveRuntimeModelForV4({model, modelProviderFamilySelectedKeys})`（薄封装现有 `resolveRuntimeModelConfig`，**零重写 coding-plan/兜底**）；SessionPane `handleSelectModel` 在 `provider_not_in_registry` 回执时解析 runtimeModel 重发一次。
- 保留 toolbar 兜底（Phase 2 主体，但本 Phase 不得挡）：context-window guard 在会话态切小窗模型时的确认/压缩（`modelSwitchContextWindowGuard`，reserve 64k）；restart-runtime 决策（非 GLM 的外部 agent 类型切模型需 restart，**GLM 不 restart**——v4 主力 GLM 基本不触发）。

### 3.1 Phase 2 app fallback 收口语义（2026-07-09）

Phase 2 只恢复两条旧行为，不重建完整旧 toolbar 状态机：

```text
用户选模型
  -> SessionPane 发 switchModelConfig(provider, model, thought)
  -> CLI ACK: failed/provider.notInRegistry
  -> app 强制 syncWorkspaceModelProvidersToAgent(force=true)
  -> app 调 service resolver 解析 runtimeModel
  -> SessionPane 再发一次 switchModelConfig(provider, model, thought, runtimeModel)
  -> 第二次 ACK 作为最终结果，不再循环
```

约束：

- `provider.notInRegistry` 只自动恢复一次。第二次仍失败时保留原 failed ACK 和日志，由现有错误 UI/调试缓冲呈现。
- app 侧只同步 provider registry 并为本次 retry 附带 `runtimeModel`；不修改 stream、snapshot、queue 或 replay 语义。
- 桌面仍是 `desktop-continuous` 实时链路；手机 `/remote` 仍是 `web-remote-replayable` 恢复链路。provider registry 是 workspace 配置控制面，不得把 replayable 恢复消息拼接到桌面 continuous，也不得让手机绕过 replayable gap/snapshot 边界。
- 远程/分屏 pane 必须把 `remoteSessionId` 传给 provider registry sync；身份/隔离 key 统一 `workspaceIdentity?.trim() || workspacePath`，执行路径仍使用 `workspacePath`。

prepare/configOptions 失败时恢复 custom provider 选择：

```text
workspace configOptionsStatus=error
  -> 用户仍能在模型菜单点 custom provider value
  -> app 写 last-selected + selectedSupplierKey=custom:<providerId>
  -> app 写 workspace default model
  -> app restartWorkspaceProcess(bumpRuntimeEpoch=true)
  -> app force prepare/readWorkspaceState
  -> configOptions 回填，模型菜单恢复
```

这条路径只服务 prepare 失败恢复；不恢复旧版 `modelSwitchStage` 全量 UI、context-window guard、跨 provider busy lock 细节和旧 restart 决策矩阵。

## 4. 要保留的清单（验收对照）

- **coding-plan/连接方式**（复用 service resolver 即保留）：Start Plan Authorization 头、BigModel Team Plan org/projectId+project key、官方版本安全校验一次性头（`applyModelSelection:false` 子 agent 路径，边缘，先记 TODO）、family 连接选型、thought 收窄、Team Plan 移除不静默兜底。
- **默认兜底**：CLI resume `reconcileResumedRuntimeSettings`（两 bugfix）+ `ensureModelReady` + `DEFAULT_MODEL`/missing error（原样保留）；service `resolveRuntimeModelConfig` 三兜底（历史缺失/移除/stale 首个可用）。
- **P4b 协同**：连接方式 Select `onConnectionValueChange` = 写 `modelProviderFamilySelectedKeys`（AppSettings）→ registry cache 失效 → re-push（1b 常态生效）/ 或解析新连接 runtimeModel 重发（1a）。**P1 做完，P4b ≈ 只补「写 family key + 触发 re-push」。**

## 5. 决策点

1. ~~1a/1b/1c~~ **已定：1c 混合（2026-07-07 用户裁决）**。实现顺序：先 1b 核心闭环（CLI 从 registry 解析），再叠 1a 回落（app 解析 runtimeModel + `provider.notInRegistry` 重发）。
2. v4 命令 `runtimeModel` schema：**倾向引用共享 `zcodeModelRuntimeConfigSchema`**（DRY，共享包内非 CLI 服务桥）+ 注释溯源；实现时若发现耦合过重再改 v4 mirror。
3. 官方版本安全校验一次性头（Start Plan 子 agent，`applyModelSelection:false`）：**本 Phase 记 TODO 不接**（边缘场景，属子 agent 安全校验路径）。

## 7. 实现顺序（1c）—— 进度

1. ✅ **v4 协议 additive**（`command.ts` runtimeModel?，引用共享 schema）— commit `c9c67b061`。
2. ✅ **CLI binder host capability** `resolveAndApplyRuntimeModel`（v4-bridge 复用 workspace-model-catalog overlay 构建，无桥合规）+ types.ts 接口。
3. ✅ **CLI handler**（switchModelConfig/applyRequestedSessionConfig setModel 前调能力，`provider.notInRegistry`→结构化 failed ACK）。
4. ✅ **L2 + 无桥门禁**（4 新 case + 6 存量 applyRequestedSessionConfig 迁签名；model-config 18 / v4-commands 13 / shared-schema 8 / boundary 全绿；CLI turbo typecheck 20/20）。
5. 🚧 **app 回落（1a）——Phase 2 收口**：常态 1b 已够（registry 在 workspace prepare 推送，CLI catalog 有全部已配置 provider → `catalog.providers.has` 命中 → 跨切生效）。1a 覆盖「provider 在 app 但未推 CLI」的 desync 边缘（刚加/竞态/远端）：SessionPane 收 `provider.notInRegistry` → `syncWorkspaceModelProvidersToAgent({ force: true })` re-push registry → service `resolveRuntimeModelForV4` 解析 runtimeModel → `switchModelConfig` 带 runtimeModel 重试一次。prepare/configOptions 失败时只恢复 custom provider 选择、workspace default 写入、restart + prepare，不恢复旧全局 stage UI。
6. ⬜ **e2e**（攒批独占跑）：选 custom-key provider 模型→投影换 provider + 真发一轮——验证 1b 常态闭环。

> **P1 核心（跨 provider 切换的 CLI 使能）已完成并 L2 背书；1a 边缘回落 + e2e 为收尾项。**

## 6. 测试

- L2（v4 CLI）：跨 provider 切换 → overlay 应用 → `getModelRef` 换 provider；provider 不在 registry → 结构化 `provider.notInRegistry` ACK；同 provider 直切仍走既有路径；resume reconcile 两兜底回归。
- L1：service resolver 薄封装透传（coding-plan/team-plan 快照命中不回归——复用既有 modelProvider 测试）。
- e2e（攒批独占跑）：选 custom-key provider 模型 → 投影 config 换 provider + 真发一轮；切连接方式（P4b 落地后）。
- 先补 `docs/conversation-session-case-catalog.md` + coverage matrix。
