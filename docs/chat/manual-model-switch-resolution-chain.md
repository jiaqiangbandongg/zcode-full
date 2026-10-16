# 手动切换模型的当前判定链路

更新日期：2026-08-24

> **历史链路审计，已被 Provider Refactor 取代。** 本文中的 workspace catalog、App Registry
> 同步和 `runtimeModel` 恢复不再是当前实现。当前候选由目标 Environment 的 Model Selection View
> 提供，切换后由同一 Environment 的 Registry/ModelFactory 创建 Active Model。当前设计见
> `docs/working-memory/provider-refactor/design/`。

本文描述 V4 conversation 主链路中的当前实现。旧 `ChatInputToolbar`、`useToolbarModelChange`、
`session/setModel` 和 task stream 链路已删除，不再作为实现依据。

## 权威边界

- 已绑定 session 的工具条展示值来自 `ConversationSnapshot.config`，模型目录来自 workspace
  `configOptions`。桌面工具条、模型切换 toast 和聊天区 marker 的模型文案规则为：Z.ai /
  BigModel 内置供应商只显示模型名，避免重复展示产品内置连接名称；其他供应商（包括自定义
  供应商）在宽 composer 中显示 `provider.name/modelId`，保留供应商身份。工具条触发器
  统一按 composer 容器宽度裁剪：超窄宽度只显示图标，中宽只显示 `modelId`，宽屏显示完整身份；
  模型菜单仍按供应商分组，toast、marker 和模型身份比较不受这项展示裁剪影响。
- 用户选择通过 V4 `switchModelConfig` 写入 CLI session；renderer 不直接修改 conversation 事实。
- 下一轮真实请求使用 CLI runtime 当前配置；snapshot 只把权威结果投影回 UI。
- renderer 的 last-selected `{ model, thoughtLevel }` 元组只为后续草稿提供种子，不覆盖已有 session。
- workspace `setDefault*` 只保留兼容用途，不是 V4 草稿或已绑定 session 的第二份选择权威。

## Turn 原子执行上下文

已开始的 Turn 同时固定执行模型和稳定 context prefix。运行中更新 session 的 model、language 或
outputStyle 只更新下一 Turn 的配置；当前 Turn 仍使用开始时的 model/context 组合。Turn 内产生的
assistant、tool result、steering 和 runtime reminder 仍可按既有流程追加到动态消息尾部，不属于稳定
context prefix。

```text
Turn N 入口
  └─ capture model + stable context configuration A
       ├─ 当前请求 / tool follow-up / Compact retry -> A + context A
       └─ 运行中配置更新 -> future config B，不改写 context A

Turn N+1 入口
  └─ 检测 context configuration A != B
       └─ 重建 context B，再使用 model B 发起首个请求
```

这里不为 model、language、outputStyle 分别维护 pending flag；runtime 只保留一个与当前已物化
context 对应的配置快照，用于下一 Turn 判断是否需要重建。Manual Compact 与普通 Turn 使用同一
生命周期边界。

## 会话中切换

```text
V4ComposerToolbar
  -> SessionPane.handleSelectModel
  -> configCommandBarrier（与 sendText 按用户操作顺序串行）
  -> switchModelConfig { provider, model, thought, baseRevision }
  -> CLI commands/handlers/model-config.ts
  -> session model-config 串行临界区
  -> app.setModel / app.setThoughtLevel
  -> ModelSelected { modelRef, supportedThoughtLevels, contextWindow, origin? }
  -> ConversationSnapshot.config + usage.contextWindow.maxTokens
  -> toolbar 与偏好种子收口
```

关键规则：

1. `provider` 与 `model` 都必须有值；空值不会下发。
2. 跨模型切换不沿用源模型的 thought。CLI 让目标模型选择兼容档位，再发布最终实际值。
3. 只有 provider/model 未变时，`thought` 才表示显式切换思考深度；过期工具条帧不能把旧模型的
   thought 写到新模型。
4. 同值切换返回 `noop / config.unchanged`，不是伪造一次 accepted 变更。
5. 配置命令携带 snapshot revision；stale 时 `SessionPane` 根据 `revisionAtDecision` 有限重试，
   不能无限重放。
6. 模型、thought 使用 latest-wins scheduler，并与 mode 命令共享发送屏障；“切模型 → 发送”时
   `sendText` 不会越过未收口配置。
7. 只有已绑定 session 中显式切换 `provider + model` 身份时才显示性能提示；草稿态不显示
   模型切换 toast。已绑定 session 仅在 provider/model 元组完全相同时不提示；toast 的身份比较
   始终使用完整 provider/model 元组，展示时 Z.ai / BigModel 内置供应商只显示 modelId，其他
   供应商显示 `provider.name/modelId`。Agent 自动 fallback 使用相同的 changed + warning 文案，
   但只在已绑定 session 的当前聚焦 pane 通过实时 `online` 帧首次观察到带 fallback 来源的
   A→B 权威跃迁时显示；草稿 prewarm、initial/recovery、历史 snapshot、重复 delta 和后台
   pane 都不提示。model-change marker 仍只由 CLI 在已有
   session 后续 turn 的权威投影中生成，UI 不自行插 timeline 行。marker 已携带起止
   provider/model ID；renderer 使用相同展示规则，其他供应商配置缺失时回落为
   `providerId/modelId`；
   marker 必须订阅 provider snapshot，目录稍后水合或供应商改名时要原地刷新名称。
8. create/resume/fork、legacy compatibility、registry fallback 和 provider runtime refresh 也必须经过同一
   session 临界区；runtimeModel 只是 provider/header 派生缓存，model 或 thought 与当前 runtime 不一致时
   不能覆盖用户切换。
9. Service 只在本次 `accepted/noop` 后按目标重建 runtimeModel 缓存；`duplicate` 不代表旧命令仍是当前
   配置，不能写缓存。并发 ACK 的缓存重建按 Agent decision 顺序提交，较早请求即使最后完成也会被丢弃。
10. `contextWindow` 是已应用 runtime 模型能力的一部分，必须与 `modelRef`、实际 thought 和
    `supportedThoughtLevels` 通过同一条 `ModelSelected` 原子发布。历史会话切换模型后，投影保留已有
    `usedTokens`，立即把 `usage.contextWindow.maxTokens` 切到目标模型；不能等下一次 `ModelComplete`，
    也不能由 renderer 用 workspace catalog 再推导一份分母。
11. running session 的模型命令不能为了准备 provider client 而替换整个 adapter registry。目标模型已在
    当前 session overlay 时，只更新下一 turn 的 session 选型；最新 workspace overlay 在 ready 边界应用。
    目标只存在于尚未应用的新 catalog 时，命令显式返回 `provider.notInRegistry`，不得以 dispose 在途
    signer 为代价强行成功；当前 turn 结束后重试即可。请求级 runtime headers 不走这条配置命令语义。

## 用户偏好的两阶段确认

ACK 通常早于 `state.updated`。为了避免新草稿在两者之间继承源模型或源 thought，显式模型选择按
同一个 last-selected 元组两阶段提交：

```text
用户选择模型 B
  -> pending intent（绑定 targetSessionId）
  -> accepted/noop ACK
       -> 保存 { model: B, thoughtLevel: null }
  -> B 的权威 projection
       -> 保存 { model: B, thoughtLevel: actualThought }

历史 session 投影 --------------------X 无显式 intent，不写偏好
模型 A 的迟到 ACK/projection --------X 不能覆盖更新的模型 B/C intent
受控 Select 产生的空 thought --------X synthetic change，不进入 scheduler
```

- pending intent 必须绑定发起操作的 session，不能由另一个恰好同模型的历史 session 确认。
- projection 先于 ACK 时先完成权威写入并清除 pending；迟到 ACK 不得把实际 thought 降回 `null`。
- 用户显式选择非空 thought 时，accepted/noop 直接提交目标模型与 thought 的完整元组。
- `failed`、`stale`、`superseded` 不更新用户偏好。自动 fallback 不从 Agent 直接写 renderer
  偏好；当前聚焦 pane 仅在 projection store 应用同一条实时 `online` fallback 事件的回调中，
  且没有显式模型 intent 在途时，按 compare-and-set 晋升实际模型元组。普通 snapshot 差异、
  initial/recovery/历史投影和建立订阅首个 applied base 的完整 online snapshot 都不得写偏好。

## Provider registry 自动恢复

目标 provider 不在 CLI workspace registry 时，第一次命令返回 `provider.notInRegistry`。
`SessionPane.switchModelConfigWithRecovery` 只恢复一次：

```text
failed(provider.notInRegistry)
  -> 按 workspaceIdentity / remoteSessionId 同步 provider registry
  -> zcodeSessionService.resolveRuntimeModelForV4(...)
  -> 带 runtimeModel 和最新 revision 重试一次
  -> 成功收口；仍失败则停止，不循环
```

远程 workspace 必须贯穿 `workspaceIdentity` 和 `remoteSessionId`。这条恢复只补齐 provider client
overlay，不改变 desktop continuous 与 mobile replayable 的投递边界。

## 草稿态切换

草稿态先同步写 reactive draft intent；跨模型时立即把 thought 清空。草稿尚未形成实际对话，
因此普通选择、custom provider 恢复和 Agent prewarm fallback 都不显示模型切换 toast。随后按
预热状态分流：

- `configOptions` 失败时真正 custom provider 会走 restart/force-prepare 重恢复，但只更新草稿
  选择与运行时准备状态，不显示性能提示。
- 已有 prewarm session：对这个明确 `targetSessionId` 执行 V4 CAS；
- 尚无 prewarm session：intent 留给后续 `createSession.config`；
- prewarm projection 到达：只补投仍不一致的字段，不能用旧 snapshot 遮住新 intent；
- 首发前：`ensureDraftPrewarmConfigBeforeSend` 等待最新配置屏障。

```text
旧：比较 modelId                  新：比较 providerId + modelId
    A/glm-5.2 → B/glm-5.2            A/glm-5.2 → B/glm-5.2
              └─ 不提示                        └─ 草稿态仍不提示

catalog / draft intent / projection
              -> Toolbar effectiveConfig（用户点击时可见身份）
              -> onSelectModel(sourceModel, targetModel)
                   └─ CAS 继续使用 SessionPane 最新 snapshot revision
```

Target Host 的 ModelSelectionView 只提供可选 provider/model/reasoning 展示投影。last-selected 元组只有在显式操作得到
ACK/projection 确认后才更新；打开历史 task、目录水合和后台连接迁移都不能反向改写它。

聊天区 marker 的展示链路与 toast 共用同一身份格式，但不改变 marker 的生成时机：

```text
Turn N 实际使用 provider-A/glm-5.2
  -> ModelSelected(provider-B/glm-5.2)
  -> Turn N+1 started
  -> CLI marker { fromProvider: A, fromModel: glm-5.2,
                  toProvider: B,   toModel: glm-5.2 }
  -> renderer 订阅 provider snapshot
  -> 内置 Z.ai/BigModel：「模型已切换 glm-5.2 → ...」
     其他供应商：「模型已切换 B名称/glm-5.2 → ...」
```

Bug 原因：协议和 CLI 投影已保留完整 provider/model 元组，但聊天区 renderer 只消费
`fromModel/toModel`，曾导致自定义供应商的同名模型无法区分。renderer 仍订阅现有 provider
snapshot，并对其他供应商保留供应商名称；Z.ai / BigModel 内置供应商按产品文案规则主动省略
固定入口名称。初次缺少目录时，其他供应商先回落 provider ID，目录水合或改名后原地重渲染。
普通 A→B marker 的完整起止身份与投影时机不变，也不改变 desktop continuous 或 mobile
replayable 的交付语义；下节只增加显式 `∅→X` 模型边界的 source 共同缺失分支。

### Subagent 首次实际模型

普通 Main session 的首次选型仍只建立模型基线，不生成 marker。Fresh Subagent child 是唯一例外：
child runtime 在最终解析 inherited、`lite` 或显式 profile override 后，把实际
`childModelRef` 同时写入实时事件与持久 timeline。

```text
resolveEffectiveSubagentModelRef -> childModelRef X
  |-- ModelSelected(previousModelRef=null, modelRef=X) -> live projection
  `-- model_change(fromModel=undefined, toModel=X) -> transcript

first TurnStarted
  -> modelChange { fromProvider/fromModel absent, toProvider/toModel=X }
  -> renderer: no switch icon + "正在使用 X" / "Using X"

cold hydration
  -> source-less model_change synthesizes previousModelRef=null
  -> first TurnStarted rebuilds the same marker exactly once
```

- `previousModelRef` 缺失只更新当前 config，不改变 turn 模型基线；显式 `null`
  表示 `∅→X` 边界。公共投影只消费边界，不识别 Subagent 身份；fresh child 只是该边界
  当前唯一的实时生产者。
- turn 模型基线分为普通 Main 首轮静默、显式 source-less 和上一轮已知模型三态。
  多次选型不会覆盖上一轮实际模型：`A→B→C` 在下一轮显示 `A→C`，`∅→X→Y`
  在首轮显示 `Using Y`。
- V4 `modelChange` keeps the existing destination tuple. Its source provider and
  model are jointly present for A→B switches or jointly absent for Subagent
  initial usage; half-present source tuples are invalid.
- Source-less markers use the same provider/model display formatter as the
  destination side of normal switches. Z.ai / BigModel omit the fixed provider
  name; other providers retain `provider.name/modelId` and fall back to the
  provider ID until catalog hydration. They omit the switch icon and the redundant
  trailing “model”; normal A→B markers keep the existing switch icon and wording.
- Only fresh child sessions persist this initial timeline fact. `resumeFromStore`
  does not write it again, and histories created before this contract are not
  inferred or backfilled.
- The marker remains child-owned and is not mirrored into the parent Agent card
  or parent conversation timeline. It does not update last-selected preferences
  and does not produce a model-change toast.

## 不可用模型的 Agent 兜底

UI 可见目录会受 entitlement 水合、过滤和菜单排序影响，不能据此改写会话。最新 workspace provider
registry 生效后，Agent 是自动 fallback 的唯一决策者：

```text
registry 删除当前模型
  -> active turn：保持在途请求，等待安全边界
  -> idle / next-turn admission
  -> 按 default → last-used → catalog first 选可用模型
  -> app.setModel（解析目标实际 thought）
  -> ModelSelected { modelRef, supportedThoughtLevels, contextWindow,
                     origin: "registryFallback" }
  -> ConversationSnapshot.config + usage.contextWindow.maxTokens
  -> toolbar 只读展示
  -> 当前聚焦 pane 在实时 online 帧首次观察到该事件
  -> 复用手动切换的 changed + warning toast
```

与显式切换并发时按进入 Agent 临界区的顺序线性化；无论谁先进入，后执行者都会重新读取当前 runtime：

```text
fallback C 先进入 -> 用户 B 后进入 -> 最终 B
用户 B 先进入     -> fallback 重读发现 B 可用 -> no-op，最终 B
旧 runtime A 迟到 -> 与当前 B / thought 不符 -> 丢弃，不发布事件
```

renderer 不再从菜单第一项派发“automatic” `switchModelConfig`，因此目录 loading/重排不能覆盖用户正在
进行的显式选择。没有任何可用模型时 Agent 保持当前值并让后续 admission 暴露不可用错误；这里的
“可用”只指 registry/catalog 可解析，不包含真实 provider 网络探活。自动 fallback 不从 Agent 直接写
last-selected 用户偏好；当前聚焦 pane 可在消费同一条实时权威跃迁且没有显式模型 intent 在途时，按
compare-and-set 晋升实际配置。

自动提示不从 `config` 的任意 A→B 差异猜测来源。CLI 只给 registry fallback 的
`ModelSelected` 标记 `origin`，V4 projection 保留稳定事件 ID 和起止 provider/model；renderer store
在成功应用实时 `online` 帧后按事件 ID 去重并通知当前聚焦 pane。`initial`、`recovery`、历史 snapshot
与 duplicate/gap 帧只更新已观察基线，不触发 toast；若 initial 丢失，随后到达的完整 `online`
snapshot 只是建立该订阅的首个 applied base，也只能播种观察基线。只有 base 建立后的新 `online`
跃迁才同时触发当前 pane 的 toast 和偏好 CAS，因此重开历史 task、手机重连或 relay 恢复不会重放
旧提示或改写选择。桌面和手机仍消费同一 Agent 模型事实，只在各自现有 delivery 链路本地决定是否展示。

`online` transition 是不重放的一次性事件。`SessionPane` 必须在取得 session lease 的同一个 effect
中同步安装 transition listener，再允许 subscribe activation 释放 initial/online 帧；不能先
`setLease`、等待下一轮 effect 才注册。keep-warm store 重入也遵守同一顺序。这里不能通过读取或重放
`snapshot.modelTransition` 补偿 listener 空窗，否则 initial/recovery/历史 transition 会被误当成实时事件。

## 尚未实现的产品能力

V4 当前没有“目标模型 context window 小于已用上下文时，先停止/压缩再切换”的 guard。当前代码允许
running session 切模型。待实现语义以
`docs/superpowers/specs/2026-06-10-model-switch-context-window-guard-design.md` 为准，catalog 中
N05、N09–N14 仍应标为 planned；旧 legacy implementation plan 不能视为现行覆盖。

## 当前代码入口

- `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`
- `packages/ui/src/v4/SessionPane.tsx`
- `packages/ui/src/v4/configCommandBarrier.ts`
- `packages/ui/src/v4/composer/modelConfigPreferenceConfirmation.ts`
- `packages/ui/src/v4/composer/useDraftConfigControl.ts`
- `packages/ui/src/lib/zcodeModelPreference.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/model-config.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`
- `packages/shared/src/zcode-protocol-v4/rows.ts`
- `packages/shared/src/zcode-protocol-v4/command.ts`
