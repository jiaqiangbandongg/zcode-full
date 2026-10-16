# Todo 64：Provider E2E 真实运行修复与证据收口

> 当前状态（2026-09-09）：本验证 Todo 已关闭，剩余事项由 [Todo102](todo-102-verification-debt-closeout.md) 唯一承接，不再独立排期。下文状态及失败为历史记录，关闭不表示原失败已通过。

> 状态：已完成
>
> 日期：2026-09-02
>
> 基线：`64d48f6eee`
>
> 实施报告：执行时同步创建
> `todo-64-provider-e2e-real-run-repair-closeout-implementation-report.md`
>
> 前置：Todo 52 已完成第一轮 E2E 迁移；Todo 59 已删除 Renderer 的 Account-first 选择规则；Todo 60 已删除固定 reasoning budget；Todo 63 已收口 Selection 失效语义与请求预算。本 Todo 以 MacBook Pro 上的真实 WDIO 运行结果为准，修复测试漂移、残余实现和确有必要的产品 Bug。

## 1. 目标

本轮不是把失败断言机械改绿，而是让正式 Desktop E2E 重新证明当前 Provider 架构：

```text
真实 Config / Account / Personal 输入
                    |
                    v
          Effective Provider Registry
                    |
                    v
     Host preferredSelection / Active Model
                    |
                    v
       Desktop UI 与真实模型请求行为
```

完成后必须能够区分：

- 测试仍在构造已经删除的旧 Account API Provider 或旧 Selection 状态；
- 共享 Helper 仍在断言已经删除的请求字段；
- 测试等待条件没有等到正式 Registry/Selection 状态；
- 与 Provider 无直接关系、但被本次真实运行发现的独立产品或测试问题；
- 真正违反当前 Design 的生产代码。

不为通过测试恢复 Family 旧 Schema、Account-first Renderer 分支、固定 `budget_tokens`、旧 Provider seed 或第二套 Registry。

## 2. 执行原则与停止边界

本 Todo 同时承担“修复”和“定位”，但二者必须严格区分：

```text
已经明确根因、契约和修复方向
                |
                v
先固定失败测试或保留现有失败证据
                |
                v
彻底修复生产代码 / Fixture / Helper
                |
                v
删除同源残余并完成回归

尚未明确根因
                |
                v
单 Case 隔离 + 运行时证据
                |
                v
根因是否唯一、修复是否自然且符合既有 Design？
        |                           |
       是                          否
        |                           |
        v                           v
固定失败证据后直接修复        不改生产语义和断言
                              记录证据并请求裁决
```

执行时遵守以下硬边界：

1. 已裁决问题必须完整修复，不以放宽断言、恢复旧字段或增加产品特化作为捷径；Personal Config polling 按后续裁决允许 1–3 秒有界传播时间。
2. 未定位问题必须先证明最早失败点，不能依据最终 UI 超时猜测生产根因。
3. 如果证据唯一指向测试 Fixture、Helper、等待条件或 case isolation，且修复不改变产品契约，可以直接修复。
4. 如果修复会改变 Provider、Model Selection、Repo Wiki、Compact、Quota 或 Account 产品语义，立即停止该项并请求裁决。
5. 每项修复后审查同源调用方和测试，删除已经失效的兼容分支、重复 Helper 和残余断言。
6. 已经通过的 Case 不得为了迁就失败 Case 而改变语义；必须用受影响分组和最终集合证明没有回归。
7. 执行全程同步维护实施报告，不能在结束时凭记忆补写。

## 3. 真实运行基线

MacBook Pro 使用干净运行目录和提交 `64d48f6eee`，按 spec 分组执行 Desktop WDIO。每个 spec 取最后一次运行结果：

| 结果     | 数量 |
| -------- | ---: |
| 通过     |   43 |
| 失败     |   12 |
| 环境跳过 |    1 |

环境跳过的是 Remote SSH 场景。它不能计为通过，但也不能在缺少目标凭据时误判为产品失败；最终继续标记为 `blocked-environment`，并保留可复现命令。

已经通过的 Provider 关键链路包括：

- Bot terminal、飞书交互卡片与 streaming lifecycle；
- Coding Plan/Team Plan 主页面、Usage、Quota、OAuth 恢复的大部分场景；
- Context Window 冷恢复；
- Model Output Token 主预算与两组真实多轮 smoke；
- Turbo 恢复和切换；
- Coding Plan Upgrade WebView 在修正运行环境后通过；
- Automation 创建管理。

因此不得重新改动这些已通过链路来迁就失败用例。

## 4. 当前 12 个失败的裁决状态

| 类别                | Case               | 当前失败                                         | 当前裁决                                                                 |
| ------------------- | ------------------ | ------------------------------------------------ | ------------------------------------------------------------------------ |
| Template/UI         | MP-UI-01           | 创建后没有恢复到新 Provider 详情                 | 已定位并修复：测试用 Provider 详情可无名称编辑按钮，改按选中导航身份断言 |
| Model JSON UI       | MP-UI-06           | 期望 `"{}"`，实际空字符串                        | 已明确：更新 placeholder 旧断言                                          |
| Template + 首发     | I08                | Personal Rule 保存等待永远不满足                 | 已定位并修复：Helper 错读 `maxOutputTokens.default`，正式字段是 `.max`   |
| Repo Wiki           | Repo Wiki settings | 未出现 `ready-empty`                             | 已明确：删除非核心的无模型 E2E 断言，不新增无 Provider Fixture           |
| Repo Wiki           | Repo Wiki produces | 生成按钮仍 disabled                              | 已明确：模型选择丢失 reasoning，复用统一 Selection 补全                  |
| Output Token        | OTB08-OTB10        | OTB09 仍断言旧的 41,665 cap                      | 已定位并修复：usage anchor 已覆盖上一轮 assistant，正确值为 41,671       |
| Reasoning           | I20                | Helper 要求 `thinking.budget_tokens`             | 已明确：删除无契约依据的共享断言                                         |
| Restart Selection   | I26                | 完整 Team Plan Recent 没有恢复                   | 已明确：完整 seed + Registry readiness；仍失败才修生产恢复链             |
| Restart Fallback    | I27                | 旧 Start Plan Recent 失效后仍期待 Account 首模型 | 已修正为回退 Host Configured Default，不恢复 Renderer Account-first      |
| Restart Fallback    | I28                | 已删除模型 Recent 失效后仍期待 Account 首模型    | 已修正为回退 Host Configured Default，不恢复 Renderer Account-first      |
| Settings Transition | I31                | Team Plan 内非首个模型没有保持                   | 已明确：改为设置页往返保持，删除无消费者 transition state                |
| Quota Reminder      | QR-E2E-09          | 首次 reset opportunity reminder 未显示           | 单独及整份 Coding Plan spec 已通过，属于旧运行隔离噪声，无生产改动       |

CPUW-01/03 首次运行失败来自 WebView 运行环境，按相同代码重跑后 2 条均通过，不列入代码修复范围。若再次失败，先修运行环境或 Fixture，不恢复旧 Account API 行为。

12 个初始失败均已取得明确证据。修复仅涉及当前契约下的生产 Bug、测试/Fixture/Helper 漂移和运行隔离；没有需要新增产品语义的未决项。

## 5. 唯一模型选择语义

### 5.1 通用优先级

```text
当前 Draft 的显式选择（有效）
              |
              v
Workspace Recent Selection（有效）
              |
              v
Host ModelSelectionView.preferredSelection
```

Host 的 `preferredSelection` 继续只有一条通用规则：

```text
有效 Configured Default
          |
          +-- 存在 --> 使用它
          |
          `-- 不存在/失效
                    |
                    v
          有序 Registry 的首个可见 Provider
                    |
                    v
          该 Provider 的首个可用模型
```

Account Provider 本来就排在普通 Provider 前，推荐模型本来就排在同 Provider 的其他模型前。因此没有有效 Configured Default 时，通用 Registry fallback 自然可以落到当前 Account Provider 的推荐模型。这是统一排序的结果，不是 Renderer 的 Account-first 特化。

Account Overlay 只改变 Provider 的账号访问事实、entitlement 和模型成员；Renderer 不理解 Start、Individual 或 Team，也不自行读取 Account Connection 选择 `models[0]`。

### 5.2 新 Selection 的 reasoning 补全

`completeNewModelSelection()` 是新建完整 Selection 的唯一补全入口：

```text
输入 providerId + modelId
          |
          v
Registry 中找到目标 Model
          |
          +-- 已有 reasoningLevel --> 原样保留
          |
          `-- 缺少 reasoningLevel --> 取有序 values.at(-1)
```

`reasoningLevel.values` 按强度从低到高排列，因此普通用户新选择默认取最后一档。标题、Git Commit 等辅助模型明确使用最低可用档时仍直接取 `values[0]`；两类行为不得混成全局策略。

Repo Wiki 模型选择必须复用该入口，不能只保存 `providerId/modelId`，也不能在 Renderer 复制 `values.at(-1)` 推导。

### 5.3 I26

I26 的 Recent Selection 指向当前 Team Plan 内仍有效的非首个模型。目标不变：冷启动后保留该完整选择。

修复步骤：

1. Seed 写入完整 `providerId + modelId + reasoningLevel`。
2. Account Scenario 明确提供该 Team Provider 及模型成员。
3. 等待 Effective Registry revision 已包含该模型，再断言工具栏。
4. 首发后断言真实请求仍路由到该 Provider/Model/Reasoning。

如果上述完整输入仍回到默认模型，才是生产恢复链路 Bug；不能先修改期望。

### 5.4 I27 / I28

两个 Case 的旧期望隐含了已经删除的 Account-first 规则。当前正式语义为：

```text
Recent 已失效
    +
Configured Default = DeepSeek 且有效
                    |
                    v
              Host preferredSelection
                    |
                    v
             Configured Default
```

- I27：Recent 是已失效的旧 Start Plan 选择。
- I28：Recent 是已从 Provider 成员中移除的模型。

修复 Fixture 补齐 DeepSeek replay，并按 Provider/Model 身份等待和断言真实请求；不得在 Renderer 恢复 Account-first 分支。只有 Configured Default 不存在或失效时，Registry 的发布顺序才承担最终 fallback。

### 5.5 I31

当前 I31 实际做的是：已选择 Team Plan/`GLM-5.3-Flash`，打开设置页后再次选择同一个 Team Plan，再期待模型保持。

原问题有两层：

1. 原生 Select 对“再次选择当前值”不保证触发 `onValueChange`，测试不应把它当作一次连接切换。
2. `modelProviderFamilyConnectionTransitionSeq` 目前只有生产者，没有真实消费者；它不能形成 reconciliation，只是残余状态。

I31 改为验证“设置页往返不会破坏当前 Team Plan 内的有效非首个模型”：

- Seed 完整 Team Selection；
- 进入设置页并确认仍是同一个 Team Connection；
- 返回工作区，不依赖重复选择当前 option；
- 验证工具栏和首发请求仍为原模型及 reasoning。

真正切换到另一个 Team identity 时，原模型是否还属于新 Provider 并无保证，不纳入 I31。若未来需要该产品规则，另建独立用例。

确认无消费者后，删除 transition sequence、mark action、unchanged-selection reconciliation helper 及相应伪测试，不保留“以后可能有用”的状态。

## 6. Reasoning 请求断言收口

正式 Model Option Map 已不承诺生成固定 `thinking.budget_tokens`。I20 捕获到的请求事实是：

```text
Parent                thinking.type=enabled, output_config.effort=max
Child                 thinking.type=enabled, output_config.effort=high
Parent continuation   thinking.type=enabled, output_config.effort=max
```

这已经完整证明父子 Agent reasoning 隔离与父会话延续。修复 `assertUpstreamThoughtLevelCapture()`：

- 保留 route、model、text、`thinking.type` 和 `output_config.effort` 断言；
- 删除共享 Helper 对 `thinking.budget_tokens > 0` 的硬要求；
- 如果某个具体 Model Rule 将来明确映射 budget，只在该模型专属 Fixture 中断言；
- 同步检查所有引用这个 Helper 的正式与 pending Case，避免同一旧断言在下一批复发。

辅助模型“使用最低可用 reasoning 档位”继续直接取有序 `values[0]`；普通新选择的默认档位继续由当前 Selection 规则决定。两者不能混写成一个全局默认策略。

## 7. E2E 共性基础设施修复

### 7.1 Selection Seed

正式 `seedPersistedModelSelection()` 默认只允许写完整 Selection：

```ts
{
  providerId,
  modelId,
  reasoningLevel,
}
```

- `reasoningLevel` 改为必填，更新所有正式调用点。
- 专门验证旧数据迁移时，使用名字明确的 raw/legacy seed，不让常规 Helper 默默制造非法数据。
- 不在 Helper 中根据模型名猜 reasoning，也不读取 UI 后反写 Fixture。

### 7.2 Account Scenario Seed

统一由 `seedAccountScenario(...)` 表达 Account Provider、Team identity、entitlement 和动态模型成员。当前仍需保留的 Family 展示与连接选择继续走正式 Schema；测试不得再直接拼已经删除的 Account API Provider 或已失效的旧字段。

### 7.3 Registry/Selection 等待

统一提供或收口下面的语义等待：

```text
waitForEffectiveProvider(providerId)
waitForSelectableModel(providerId, modelId)
waitForSelectedModel(providerId, modelId, reasoningLevel)
```

这些等待观察用户真正可见的 Registry/Selection 结果，不创建 E2E 专属 Registry，也不读取生产内部 Snapshot。

Personal Config 保存到 Worker 生效允许最多 1–3 秒时间差；可以使用有上限的轮询/等待，但不以固定 sleep 代替最终状态断言。

### 7.4 Template 创建

MP-UI-01 与 I08 先共同复现 Template 卡片到底触发一次还是两次创建：

```text
一次用户点击
    |
    +--> 一次 create mutation
    +--> 一份 Personal Provider Overlay
    `--> 自动进入新 Provider 详情
```

- 若 E2E helper 先点卡片又重复提交，则删除重复动作。
- 若生产事件冒泡/重入产生两次 mutation，则先写失败 E2E/组件测试，再修生产事件边界。
- 创建成功的等待以返回的 Provider ID 或新 Personal Overlay 为准，不能依赖名称模糊匹配。
- 创建后再添加模型并等待 Registry 可选择，最后完成 I08 首发请求断言。

### 7.5 JSON Placeholder

MP-UI-06 应按当前契约区分：

- 空 Overlay：textarea value 为空，`{}` 只作为 placeholder 展示；
- 用户显式写入 `{}`：value 才是 `"{}"`；
- Effective 只读 JSON：继续显示真实解析值。

更新断言，不把 placeholder 当成已保存的 Personal Config。

## 8. 已明确问题的具体修复

### 8.1 Repo Wiki settings

该 Case 的核心职责是生成设置控件，不再承担“没有 Provider”的产品 E2E：

- 删除 `ready-empty` 横幅与生成按钮必须禁用的断言；
- 不新增无 Provider Fixture；
- 使用普通 E2E Provider 完成设置默认值、选择和输入边界断言；
- 保留 `repoWikiModelState` 单测对空 Ready View 的覆盖；
- 同步删除 Repo Wiki E2E 文档中的专门无 Provider 条目。

### 8.2 Repo Wiki produces

当前真实 Bug 是用户从模型菜单选择后只保存身份，覆盖了 Host 已补全的完整 Selection：

```text
完整 preferredSelection
        |
用户点击模型菜单
        |
parseModelPickerValue() 只返回 providerId/modelId
        |
reasoningLevel 丢失
        |
invalid-explicit -> Generate disabled
```

修复要求：

- 模型选择事件调用 `completeNewModelSelection(modelSelectionView, identity)`；
- 将完整 `providerId/modelId/options.reasoningLevel` 写入 Repo Wiki Draft；
- 不放宽 Generate 的 `ready` 门禁；
- 不新增 Repo Wiki 专属 fallback 或 reasoning 默认算法；
- 增加测试证明重新选择当前模型、切换模型和切换 reasoning 后均保持完整 Selection。

## 9. 尚未定位问题的证据计划

### 9.1 MP-UI-01 / I08

一次真实用户点击期间记录：

- Template 卡片 pointer/click 激活次数；
- create mutation 调用次数和返回 Provider ID；
- Personal Overlay 写入次数；
- 导航选中值；
- E2E Helper 是否在点击后又执行一次创建动作。

若生产 mutation 只有一次，删除测试重复动作或修正等待；若生产发生重入，先固定组件/E2E 失败再修事件边界。不得用名称模糊匹配掩盖重复实例。

### 9.2 OTB08-OTB10

保留 21K reserve、preflight cap 与 reactive compact 的产品目标。对第二次请求收集：

- 实际请求是否发出；
- replay lane 是否匹配；
- compact 是否完成；
- assistant completion 是否被 admission、fixture 或 UI wait 丢失。

只有证据证明生产预算/compact 行为错误时才改生产代码；若请求正确而回放缺响应，则修 Fixture 或等待 Helper。

### 9.3 QR-E2E-09

它的上游确实依赖 Account Provider、Model Selection 和 entitlement，但断言目标是 `initial` reset opportunity reminder。QR-E2E-10、QR-E2E-04 及大部分 Coding Plan/Quota 主链已经通过，因此不能先假设 Provider 整体损坏。

先单 Case 隔离，再与整份 spec 对比：

- reset opportunity 请求是否发出；
- status/opportunity Fixture 是否返回有效数量和过期时间；
- `displayedProviderId`、entitlement 和 Context trigger 是否存在；
- reminder DOM 是否创建后被 pointer 事件立即收起；
- 窗口级 dismissal store 是否已经记录同一 opportunity；
- 前序 Case 是否污染状态。

单 Case 通过、分组失败时按 case isolation 修复；单 Case 仍失败时按 Account source、Fixture、initial reminder 实现的顺序定位。不得通过修改 Account Provider 排序来让 reminder 出现。

## 10. 实施阶段

### 阶段 A：建立实施报告与修共性基础设施

1. 创建实施报告，写入基线 SHA、运行目录、命令、初始 artifact 和 12 条 Case 状态表。
2. 让正式 Selection seed 强制携带 reasoning。
3. 收口 Account Scenario 与 Provider/Model readiness Helper。
4. 修正 JSON placeholder 断言。
5. 删除 reasoning shared helper 的固定 budget 断言。

阶段完成后先 review：确认没有新增旧字段、模型名 hardcode、直接 Registry 注入或无上限等待；已裁决的 1–3 秒 polling 传播窗口除外。

### 阶段 B：修 Selection Case

1. 修复 Repo Wiki 完整 Selection，并删除多余无模型 E2E 断言。
2. 修 I26 的完整 Recent 恢复。
3. 按通用 Host preferred + Configured Default 修 I27/I28 Fixture 与断言。
4. 重写 I31 为设置页往返保持，并删除无消费者 transition state。
5. 用真实请求确认 Provider/Model/Reasoning 身份。

阶段完成后 review：确认 Renderer 没有 Account-first 分支，Configured Default 仍优先于 Registry fallback。

### 阶段 C：运行时定位并处理未决根因

1. 联合定位 MP-UI-01/I08，确定重复创建发生在 Helper 还是生产 mutation。
2. 定位 OTB08-10 的请求、replay、compact 和 completion 最早失败点。
3. 单独及分组运行 QR-E2E-09，定位 Account source、Fixture 或 reminder 隔离问题。

每项根因唯一且修复自然时，先固定失败证据后直接执行；拿不准或需要改变既有 Design 时，不修改该项，写入实施报告并请求裁决。

### 阶段 D：证据、实施报告和文档收口

1. 更新 Conversation Case Catalog 与 Coverage Matrix 的真实状态。
2. 在 Todo 57 保留历史运行记录，并引用本 Todo 的当前基线，不能覆盖旧证据伪装成当时已通过。
3. 保存本次 MacBook Pro artifact 路径、命令、提交 SHA 和结果摘要。
4. SSH 环境 Case 继续记录 `blocked-environment` 及补跑条件。
5. 完成实施报告：逐项写明根因、改动文件、删除的残余、测试命令、artifact、结果和遗留风险。

## 11. 实施报告契约

实施报告必须是独立文件，不把 Todo 的计划状态改写成事后叙述。至少包含：

```text
实施基线
├─ 开始/结束 SHA
├─ MacBook Pro 运行目录与工具版本
└─ 初始 43 pass / 12 fail / 1 blocked 证据

逐 Case 记录
├─ 原始失败和 artifact
├─ 最早失败点
├─ 根因分类：production / fixture / helper / isolation / environment
├─ 是否涉及既有产品裁决
├─ 实际修复与删除项
├─ 定向、分组和全量结果
└─ 未修改项及原因

最终审查
├─ Provider/Selection 抽象检查
├─ 已删除旧字段与特化逻辑搜索
├─ typecheck/lint/unit/E2E 结果
├─ blocked-environment 条件
└─ 剩余风险与待裁决项
```

任何尚未定位或未通过的 Case 都必须在报告中明确保留，不能以“与 Provider 无关”或“环境波动”概括带过。

## 12. 验证计划

按风险递增执行：

1. 受影响 Helper/Store/Selection 单测。
2. `pnpm --filter @zcode/desktop typecheck:e2e`。
3. Fixture 与 case-local 配置校验。
4. 单独运行 12 个原失败 Case，保留每条 artifact。
5. 按 spec 重跑受影响分组，确认无 case-order 污染。
6. 重跑当前受影响清单，目标为具备本地环境条件的 Case 全部通过；SSH 仅在凭据齐备后计入。
7. `pnpm typecheck`。
8. `pnpm lint`。
9. `pnpm test:unit`。
10. `pnpm audit:conversation-session-coverage`。
11. 修改文件格式检查与 `git diff --check`。

如果单 Case 通过但分组失败，按状态泄漏/Fixture 隔离 Bug 处理，不能把分组运行从门禁中删除。

## 13. 完成标准

- Selection seed 不再默认制造缺 reasoning 的非法新数据。
- I26 保留有效的 Team Plan 非首个模型。
- I27/I28 通过 Host preferred 回退到有效 Configured Default，不存在 Renderer Account-first 特化。
- I31 不依赖重复选择同一 Select option，无消费者 transition 状态被清理。
- DeepSeek reasoning 共享 Helper 不再要求已从正式 Option Map 删除的 `budget_tokens`。
- Template 一次点击只创建一个 Provider，并原子进入其详情；I08 能按实例身份首发。
- JSON 空 Overlay 与 placeholder 的断言一致。
- Repo Wiki 选择模型始终形成完整 Selection；设置 E2E 不再携带无必要的无模型场景。
- MP-UI-01/I08、OTB08-10、QR-E2E-09 有明确根因和对应测试，不通过猜测改断言。
- 当前受影响清单中所有具备环境条件的 Case 通过；环境跳过项单独列明。
- 不删除当前仍需保留的 Family 展示与连接选择，也不恢复已经删除的 Account API Provider；不新增第二套配置或 Registry 权威，不用具体模型 ID 驱动生产行为。
- 独立实施报告完整记录每条失败的处理结果、运行证据、未决项和最终审查。
- 最终提交使用 Conventional Commit，并附当前 Agent 会话 trailer；没有可确认 Session ID 时不得猜测或提交。
