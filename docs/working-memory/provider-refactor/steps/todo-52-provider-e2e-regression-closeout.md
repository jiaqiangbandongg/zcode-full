# Todo 52：Provider E2E 回归统一收口

> 当前状态（2026-09-09）：本验证 Todo 已关闭，剩余事项由 [Todo102](todo-102-verification-debt-closeout.md) 唯一承接，不再独立排期。下文状态及失败为历史记录，关闭不表示原失败已通过。

> 状态：已完成
>
> 日期：2026-08-31
>
> 证据来源：[`../research/e2e-regression-analysis-2026-08-31.md`](../research/e2e-regression-analysis-2026-08-31.md)

## 1. 目标

Provider 重构破坏的 37 条 Desktop E2E 并不是 37 个独立产品问题。本 Todo 统一处理它们的测试基础设施漂移、过时产品
行为和少量待裁决边界，不再按单个 Case 分散修补。

本轮曾以未来展平 Provider 的假设为依据，提前删除了一部分仍属于当前产品的 Family 行为覆盖。后续裁决明确
Z.ai / BigModel Family、结构化 Connection Selection 和 Family 内连接切换继续保留，因此本 Todo 的最终边界修正为：

```text
当前 Family / Connection Selection 行为
                └── 按当前结构化 selection 恢复覆盖

旧 mode / selectedKey 未发布兼容行为
                └── 继续删除，不恢复兼容

账号、模型、请求和恢复行为
                └── 按独立 Provider 身份修复
```

恢复 Family Case 不新增兼容层，也不把旧 `mode/selectedKey` 翻译成另一套过渡结构。所有 Case 直接使用现行
`providerFamilyConnectionSelections`、正式账号 mock 和当前 Resolver。

## 2. 已确认的共性根因

| 根因                                                    | 影响范围                                  | 处理方向                                                                         |
| ------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| Account 场景被伪装为 Personal API-key Provider          | CTP、QR、CPUW、Restart、Transition、Turbo | 只准备账号 API、Credential 和产品事实，由正式 Resolver 生成正式 Account Provider |
| 测试仍写旧 Family mode/selectedKey                      | Migration                                 | 删除旧格式兼容，不恢复                                                           |
| 当前 Family connection selection 缺少覆盖               | CTP、Restart、Transition、Off-Peak        | 使用结构化 `providerFamilyConnectionSelections` 恢复正式行为证明                 |
| CW/OTB/I08 等待已删除的 Workspace Registry push 日志    | CW、OTB、I08                              | 冷启动由真实请求证明；Personal 热更新统一等待 2 秒                               |
| Bot harness 返回空 Model Selection View                 | 4 条 Bot E2E                              | 共用最小非空 Selection fixture                                                   |
| Subagent E2E 仍读写旧双 map                             | I20 及相邻 Settings E2E                   | 删除兼容 reader，统一当前 structured selection                                   |
| Upgrade WebView helper 把可见页面 origin 当 mock 控制面 | CPUW-01/03                                | 使用显式 mock control URL，观察正式账号刷新结果                                  |

## 3. 正式 E2E 输入链

```text
E2E 场景输入
├─ Built-in Config（真实文件）
├─ Personal Provider Overlay（仅用户配置）
├─ Account API / Credential Mock（账号与套餐事实）
└─ Persisted Model Selection（仅冷启动 Case）
                |
                v
        正式 Resolver / Registry
                |
                v
         Model Selection View
                |
                v
       UI 操作 / 正式 Model 请求
                |
                v
     请求、恢复、卡片与产品状态断言
```

禁止 E2E 直接构造 Effective Provider、Registry Snapshot、Account Personal API Key 或测试专用 executable 状态。

## 4. 公共测试基础设施

### 4.1 Personal Provider fixture

本轮复用并收窄现有 `seedPersonalProviderConfig(...)`、`seedReplayProvider(...)` 与
`createAndConfigurePersonalProvider(...)`，职责是：

- 创建 Personal Provider；
- 为普通 Built-in Provider 写 Personal Overlay；
- 保存 API Key、Endpoint、Schema、Personal model members/order/rules；
- 复用现有 Personal Config Repository/codec，不复制文件格式。

正式修复 Case 不再用它们伪造 Account Provider。仍处于 manual-review pending、尚未晋升的历史 Case 不构成本轮正式覆盖；它们会在对应
产品行为晋升或 Family 展平时单独迁移，不能作为恢复旧兼容的理由。

### 4.2 Account 场景 fixture

本轮没有再造一个总括式 `seedAccountScenario(...)`。现有 Coding Plan mock 已经是账号上游场景编排器，继续由
`coding-plan-mock-env.ts`、`wdio.conf.ts` 和测试 Credential Store 共同提供场景，而不是注入 Account Config。

职责：

- 控制账号、套餐、quota、activity、reset opportunity 等现有 mock；
- 写正式测试 Credential Store；
- 提供 Start Plan allowed models、Individual/Team entitlement 和必要的组织/项目信息；
- 由正式 Account Resolver 生成多个 Account Provider。

它不写 Family Selection，不向 Personal Config 写 Account Provider，不直接控制 Registry。

### 4.3 `seedPersistedModelSelection(...)`

仅用于冷启动、重启恢复 Case，原子保存：

```ts
{
  providerId,
  modelId,
  options: { reasoningLevel },
}
```

退役分离的 `seedLastSelectedModel()` / `seedLastSelectedThoughtLevel()`，避免测试制造撕裂选择。

### 4.4 `waitForSelectableModel(...)`

通过正式 Selection View 等待 `providerId/modelId` 可选择。它不查询或注入 Registry 中间态，不用 Settings 卡片代替可执行事实。

### 4.5 `waitForProviderConfigPolling()`

Personal Config 被已运行 Agent 消费时允许存在时间差：

```ts
const PROVIDER_CONFIG_POLLING_SETTLE_MS = 2_000;
```

- 当前生产轮询约 1 秒，E2E 统一留 2 秒调度余量；
- 如 CI 实证 2 秒仍偶发不足，只能在这一处统一提高到 3 秒；
- 只用于 Personal Config 热更新；
- 冷启动、Account 显式刷新和已有正式完成信号的流程不用；
- 等待结束不是通过条件，最终仍由真实请求、模型选择或产品断言证明。

### 4.6 Bot 最小 Selection Fixture

Bot service harness 和 standalone streaming-card harness 共用一个最小、非空、合法的 Model Selection View。它只负责让 Bot
进入正式模型执行，不引入完整 Account 环境，也不改变卡片/terminal 断言。

## 5. 删除 Subagent 未发布兼容

8 月 25 日将：

```text
builtInModelOverrides
builtInThoughtLevelOverrides
```

合并为：

```text
builtInModelSelectionOverrides
```

时保留了旧 `agents-state.json` reader。该格式尚未上线，本轮不承担兼容迁移：

1. `readAgentStateFile()` 只读取 `builtInModelSelectionOverrides`；
2. `normalizeBuiltInSelectionOverrides()` 删除 legacy model/thought 参数，必要时收缩为当前结构 parser；
3. 删除 legacy reader 单测；
4. I20、Settings Subagent E2E 和 `wdio.conf.ts` fixture 全部只写、只断言当前结构；
5. `rg` 证明旧双 map 在正式代码、单测和 E2E 中归零。

I20 本身保留：它继续证明 Settings 保存选择后，冷启动 child request 使用完整 Provider/Model/Reasoning Selection。

## 6. Case 处置矩阵

### 6.1 继续删除：3 条旧格式兼容 Case

这些 Case 只验证未发布的旧 `mode/selectedKey` 存储迁移，不属于当前 Family 产品行为。不得为了恢复 Family
而恢复旧格式兼容。

| 原编号 | Case       | 删除原因                            |
| -----: | ---------- | ----------------------------------- |
|     27 | I32/MP-M01 | 旧 mode/selectedKey 迁移            |
|     28 | I33/MP-M02 | Team Plan selectedKey identity 迁移 |
|     29 | I34/MP-M03 | 缺 organization 的 selectedKey 修复 |

可整文件删除：

- `conversation-session-model-provider-selected-key-migration.test.ts`；
  Family 设置切换、当前连接恢复与回退仍是正式产品行为，必须使用当前结构化 selection 恢复原 Case 或建立等价覆盖。

### 6.2 明确修复：24 条

| 原编号 | Case 组                            | 明确处理                                                                                                                                             |
| ------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1-4    | Bot                                | 使用共享最小 Selection fixture，保留原卡片、terminal、AskUserQuestion 断言                                                                           |
| 5-17   | CTP/QR                             | 使用正式 Account Scenario；恢复 Family 连接菜单、个人/团队切换与 OAuth 恢复，并保留 activity、quota、Context、reset opportunity 和 Composer 提醒断言 |
| 20     | I20 Subagent                       | 删除旧双 map 兼容，改为 structured selection，保留冷启动 child request                                                                               |
| 21     | CW01-CW04                          | 删除旧 Registry 日志 parser；启动后由 limits、Compact 和冷恢复请求证明                                                                               |
| 22     | OTB                                | 删除 revision 日志比较；Personal 热更新后统一等待 2 秒，保留预算/请求断言                                                                            |
| 23     | I08                                | 删除旧 revision barrier；模型出现后等待 2 秒并断言首发 Provider 身份                                                                                 |
| 24     | I26/MP-R02                         | 使用正式 Account Provider 和原子 persisted selection，保留非首个模型恢复                                                                             |
| 25-26  | I27/MP-R03、I28/MP-R04             | 使用结构化 Family selection 恢复当前连接回退语义                                                                                                     |
| 30-32  | I29/MP-S01、I30/MP-S02、I31/MP-S03 | 使用结构化 Family selection 恢复连接切换、草稿保留与 Plan reconciliation                                                                             |
| 33-37  | Turbo                              | 使用正式 Account Provider 和原子 selection，保留二态 reasoning、切换、迟到回包和请求断言                                                             |

模型 ID 可以作为真实 Built-in Config fixture 事实出现在测试中；生产代码不得恢复按具体模型 ID 分支。

### 6.3 已修复：Upgrade WebView 2 条

CPUW-01/CPUW-03 保留，购买完成后的用户可见行为收口为：

```text
购买完成
    |
    v
关闭 WebView + 刷新 Account 数据
    |
    +--> 刷新当前账号 Provider
    +--> Z.ai 场景同时刷新 Team Plan products
    `--> 不再读取或断言 Account Provider 的 Personal API Key / enabled 旧状态
```

对应技术修复：

- mock control plane 使用显式 `ZCODE_CODING_PLAN_UPGRADE_MOCK_BASE_URL`；
- 不从 Personal Config 查 Account Provider API Key；
- 不断言旧 `enabled`、Family current selection 或 private credential；
- 使用刷新请求作为 WebView 完成事件的正式结果；模型选择变化不由购买弹窗测试代为定义。

## 7. 实施顺序

1. 更新 E2E case catalog、coverage matrix，正式删除 11 条过时行为；
2. 增加统一 Personal Config polling barrier 和 Bot 最小 Selection fixture；
3. 删除 Subagent 未发布双 map reader，并迁移相邻 Settings、Runtime 与 CLI bootstrap 测试；
4. 修复 Bot 4 条与 CTP/QR 保留场景；
5. 修复 CW、OTB、I08、I26、Turbo Recovery 与 Turbo Switch；
6. 修复 2 条 Upgrade WebView Case；
7. 恢复 Off-Peak Team Plan pending Case，改为使用当前结构化 Family Selection；
8. 清除已删除 catalog mock / fixture 对应的 unit contract 残余；
9. 在 macOS 实机逐组运行正式 Desktop E2E，再运行根 typecheck、lint、unit 与覆盖审计。

## 8. 测试与验收

### 8.1 机械清理

`rg` 证明以下内容在正式代码与相关 E2E 中归零：

- `modelProviderFamilyModes`；
- `modelProviderFamilySelectedKeys`；
- 旧 `modelProviderFamilyModes` / `modelProviderFamilySelectedKeys` 兼容依赖；当前
  `providerFamilyConnectionSelections` 是正式产品状态，必须保留；
- `builtInModelOverrides`；
- `builtInThoughtLevelOverrides`；
- 本轮晋升/修复的正式 Case 中的 `seedReplayProvider(account:*)`；
- `workspace_update_provider_registry.completed`；
- Account Provider Personal API Key fixture。

### 8.2 行为验收

- Account E2E 只准备上游账号事实，由正式 Resolver 生成 Account Provider；
- Bot harness 能进入真实模型执行，原交互生命周期断言恢复；
- Subagent 只持久化完整 structured selection；
- Personal 热更新只共用一个 2 秒 settle helper；
- 冷启动和 Account 刷新不依赖固定 sleep；
- 被保留 Case 必须执行原始业务断言，不能只断言 fixture 准备成功；
- 被删除 Case 从 catalog、coverage matrix、Docker preset 和 fixture manifest 一并退出。

### 8.3 验证命令

- 受影响 case 的 fixture check；
- 原生 Desktop E2E 与必要的 case-local replay；
- 删除/修改 formal Case 后运行 `pnpm audit:conversation-session-coverage`；
- `pnpm --filter @zcode/desktop typecheck:e2e`；
- `pnpm typecheck`；
- `pnpm lint`；
- 本轮文件格式检查与 `git diff --check`。

## 9. 完成结果

- Todo 53 已合并进本 Todo，不存在第二份 Registry polling 计划；
- 11 条失去产品对象的原失败 E2E 已删除，另删除 1 条同类 pending Off-Peak Team Plan Case；
- 24 条有效 E2E 使用正式输入链并恢复原业务断言；
- 2 条 Upgrade E2E 已按“关闭 WebView + 正式刷新账号数据”收口；
- E2E helper 没有复制 Effective Provider/Registry Snapshot，也没有新增 Family Selection 兼容；
- 未发布 Subagent 双 map reader 与测试输入归零；
- Turbo Case 明确区分 Composer 下一次提交意图与 accepted submission 后的 recent selection 持久化；
- 全量 unit 暴露的已删除 fixture/catalog mock 单测残余已同步清除。

## 10. 验证证据

> 2026-09-01：Todo 57 已在 MacBook Pro 上重新实跑本 Todo 保留的 Provider Case，并修正 Todo 55/56 后暴露的
> Account Draft Selection、Provider Template Fixture 与 OpenAI `max_completion_tokens` 漂移。最新 Case 级 artifact
> 与环境 blocker 以 Todo 57 第 9 节为准；下列 2026-08-31 结果保留为首次收口轨迹。

macOS 原生 Desktop E2E：

| 范围                              |  结果 | Artifact                          |
| --------------------------------- | ----: | --------------------------------- |
| Bot automation / Feishu lifecycle |   5/5 | 分组运行通过                      |
| Coding Plan Team / quota reset    | 15/15 | `desktop-e2e-20260831-171119-096` |
| Built-in Subagent model selection |   1/1 | `desktop-e2e-20260831-173054-696` |
| Provider restart recovery         |   2/2 | `desktop-e2e-20260831-174125-075` |
| Turbo recovery                    |   3/3 | `desktop-e2e-20260831-175604-388` |
| Turbo switch                      |   3/3 | `desktop-e2e-20260831-180819-116` |
| Upgrade WebView refresh           |   2/2 | `desktop-e2e-20260831-180913-613` |
| Custom Provider add/send          |   1/1 | `desktop-e2e-20260831-152917-333` |

仓库验证：

- `pnpm typecheck`：通过；
- `pnpm lint`：通过，只有仓库既有 warning；
- `pnpm --filter @zcode/desktop typecheck:e2e`：通过；
- 修改文件 `oxfmt`：通过；全仓 `pnpm fmt:check` 被 Electron 文档示例的既有 HTML 语法和 `gb2312.js` 读取问题阻断；
- `pnpm audit:conversation-session-coverage`：本轮 generated docs、manifest 与 fixture 均一致；仍被独立的
  `conversation-session-hooks-lifecycle` request ledger 顺序/metadata 基线问题阻断；
- `pnpm test:unit`：首次复跑发现并清除 8 个旧 fixture/catalog mock contract 残余；最终 1492 个 Test Files、12745 个 Tests 通过，1 个文件与 25 个测试按仓库既有配置跳过。
