# Todo 69：Provider 重构实用回滚兼容

> 2026-09-10 数据库范围补充裁决：后续实施以 [Todo109](./todo-109-database-migration-consolidation-and-rollback-readability.md) 为准，旧基线固定为 staging_backup@790884b1ce。尽量不双写，但回滚后单条任务/消息/会话内容打不开时须最小必要兼容写入；配置丢失可重选。所有相关库迁移收口，原旧字段/值保留，新版正常读取不再重复补迁。本文“一律不双写”及允许个别内容不可读的旧范围不再约束这次数据库工作；历史证据和非数据库裁决保留。

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。

> 状态：实现与阶段验收完成（2026-09-03）；未运行完整旧 App 回滚，证据范围见实施报告。
>
> 更新：2026-09-03。本文取代此前的多领域持续双写方案。
>
> 审查基线：当前分支 `eb8b9deee500` 及工作区；回滚目标仅为 `origin/staging@6e781fdd9029`。
>
> 2026-09-09 后续裁决：用户明确旧字段不能因新选择接入被删除或清空，Off-Peak 编辑 / Wiki 保存两处需保留旧值，不要求持续反向双写；Session 已裁决改为原 entry.data 新增 modelSelection 并保留旧身份 / 档位字段。Subagent Markdown 沿用 [Todo97](./todo-97-subagent-markdown-in-place-migration-and-legacy-read-audit.md) 已裁决的可读性取舍及用户目录原字段迁移；此前将其列为待复审项是误记，已撤销。见 [Todo104 §6.18](./todo-104-pre-release-schema-review.md)（m2 原 Todo99）。这些是待实施补充，不修改本文冻结 Reader 的既有验证事实，也不恢复 Bot 原文件写入。

## 1. 目标和最终裁决

回滚到上述 staging 版本后，旧 App 能够启动，升级前的主要数据仍能打开。允许新版创建或修改的个别
消息、任务、模型选择发生退化；不要求旧版完整理解当前 Provider 架构。

只处理会让整个文件、集合或 App 无法读取的关键兼容问题，不为单条新版记录的语义损失维护大量旧代码。

```text
当前版本写入数据
        |
        v
staging 的真实 Reader
        |
        +-- 可以忽略新字段 / 新列 / 新文件
        |      `--> 不增加兼容写入
        |
        +-- 只影响个别新版消息或任务
        |      `--> 接受明确列出的退化，不增加兼容写入
        |
        `-- 一条新版记录导致整份文件或集合被拒绝
               `--> 修复物理兼容边界
```

最终范围：

- Provider Config、Session、Off-Peak、Automation、Account Settings、Subagent、Repo Wiki 均不持续双写旧字段。
- SQLite 保持增量、可空的 Schema 变更，不执行破坏性降级。
- **Bot Config 和 State 是此次审查中唯一确定的整域失败风险，采用文件版本隔离，不持续双写。**
- Model/Reasoning 随所属记录处理，不新建通用旧版 Encoder、兼容 DTO 或第二套模型事实。
- 当前版本对旧数据的单向升级读取仍需保留；取消降级双写不等于删除升级 Importer。

## 2. 已核实的读取边界

本轮对照了当前 Writer 与冻结 staging 提交的文件名、严格 Schema、空值处理、列表解析和失败范围。
下表是代码事实，不再以“如果旧版不支持”作为实施依据。

| 领域               | staging 的真实读取行为                                               | 允许的回滚退化                                     | 裁决           |
| ------------------ | -------------------------------------------------------------------- | -------------------------------------------------- | -------------- |
| Provider Config    | 读取旧 `config.json`；当前版本只写新 `provider_config.json`          | 使用升级前配置，看不到新版 Provider/Template 修改  | 不双写         |
| Session            | 已认识 `runtime/model_selection`；消息、Part、Entry 是宽松 JSON 读取 | 新模型元数据、Reasoning 或个别新版消息展示可能退化 | 不双写         |
| Off-Peak           | 旧 `model/thought_level` 可空，额外列不影响读取                      | 新任务可能使用 staging 原有默认模型                | 不双写         |
| Automation         | 旧 `model/provider/thought_level` 可空，额外列不影响读取             | 新任务和 Run 不能精确保留新版冻结选择              | 不双写         |
| Account Settings   | 非 strict Schema，忽略新字段，为缺失旧字段提供空值默认               | 账号连接或套餐选择可能需要重新选择                 | 不双写         |
| 自定义 Subagent    | Frontmatter 只读取已知字段，不因新 `modelSelection` 拒绝整个文件     | 新式显式模型选择退化为继承或默认                   | 不双写         |
| 内置 Subagent 状态 | 宽松挑选字段，忽略新版模型覆盖字段                                   | 模型覆盖丢失，`disabledAgentIds` 仍保留            | 不双写         |
| Repo Wiki          | 新旧 Reader 都宽松解析 JSON                                          | Wiki 内容可读，重新生成可能需要重选模型            | 不双写         |
| Bot Config/State   | 同一文件内的新旧 Options 均 strict，但字段集合互不兼容               | 不接受整份 Bot 配置/状态被拒绝                     | 版本化文件隔离 |
| Model/Reasoning    | 没有独立持久化介质                                                   | 随所属领域决定                                     | 不建通用兼容层 |

这里证明的是 Provider 重构相关字段不会被旧 Reader 整域拒绝，不等于已经完成完整旧 App 启动、展示与执行的
实机验收。实施记录必须区分静态审查、定向测试和实机回滚证据。

### 2.1 Provider Config

当前正式文件为 `provider_config.json`。旧 `config.json` 只用于一次性升级输入，当前 Repository 不改写它、
也不生成备份。现有 `packages/services/test/providerConfigRuntime.test.ts` 的
“从旧 config.json 导入同目录 provider_config.json，不改写旧文件且不备份”测试固定了这个事实。

因此 staging 回滚后继续使用升级前配置。新版新增的 Template 实例、Provider 和 Personal Model Rule 不反向
同步。禁止因为部分新模型回滚后无法执行而恢复双 Provider 配置权威。

### 2.2 Session

冻结 staging 已定义 `runtime/model_selection`；Session Store 对 `message.data`、`part.data` 和
`session_entry.data` 使用 `JSON.parse` 后按消费路径读取，不对整份 Session 执行严格的新旧互斥 Schema。

Session Selection 的 Provider/Model 身份字段仍可读，当前 `options.reasoningLevel` 可能被旧版忽略。
User/Assistant/Timeline/Subtask 的新版模型元数据也可能不被旧展示或执行路径理解，但不能据此推导为数据库
或整个会话列表无法读取。

不新增以下回滚别名：

- User Message 的旧 `model.providerID/modelID/variant`；
- Assistant Message 的旧 `providerID/modelID/variant`；
- Timeline/Subtask 的旧 Selection 字段；
- Session Entry 的旧 `thoughtLevel`。

当前版本读取旧 Session、识别失效选择、保证历史可打开由 Todo 70 处理，不在本 Todo 扩展为双写。

### 2.3 Off-Peak

当前 `off_peak_tasks` 增加了可空 `model_selection`，保留原有旧列。当前创建逻辑写入：

```text
model_selection = 完整 ModelSelection
model            = NULL
thought_level    = NULL
```

冻结 staging 的 Row 类型和 `rowToTask()` 明确接受旧列为空，分别映射为 `undefined`。因此即使 `list()`
直接 `map(rowToTask)`，这些新版行也不会因为缺少旧模型字段而拖垮列表。

staging 的派发路径只在旧模型字段存在时使用它们，否则走自己的既有缺省逻辑。回滚后新任务可能不再使用
原来精确选定的 Provider/Model/Reasoning；这是本次明确接受的退化，不双写 `model/thought_level`。

注意方向区别：旧行没有当前 `model_selection` 导致**当前版本**恢复失败，是升级 Decoder/恢复容错问题，
不是要求当前 Writer 反向双写的理由。

### 2.4 Automation

当前 `automations` 同样保留可空旧列，并新增可空 `model_selection`；新建任务的旧
`model/provider/thought_level` 为空。冻结 staging Reader 对这些列作空值兼容映射，能够加载列表。

回滚后新任务可能采用 staging 默认模型，`automation_runs.model_selection` 也无法被旧版精确理解。
不为此实现当前 Registry Provider ID 到旧 Agent Provider 枚举的反向映射，不双写旧模型列。

### 2.5 Account Settings

当前字段是 `providerFamilyConnectionSelections`；staging 使用
`modelProviderFamilyModes/modelProviderFamilySelectedKeys`。冻结 staging 的 Settings Schema 非 strict，
会忽略新字段，并把缺失旧字段缺省为空对象，整份 Settings 仍可加载。

用户回滚后可能需要重新选择账号连接。staging 后续保存 Settings 还可能移除它不认识的新版字段，再次升级时
需要重选。这属于可重建设置退化，不维护新旧 Family 选择的持续反向投影。

### 2.6 Subagent

自定义 Agent Markdown 的 staging Parser 只挑选已知 Frontmatter 字段，忽略当前 `modelSelection`，不会因此
拒绝整个 Agent。模型选择可以退化为继承或默认。

`agents-state.json` 的 staging Reader 也只是宽松解析并挑选：

```text
staging                              当前版本
-------                              --------
builtInModelOverrides                builtInModelSelectionOverrides
builtInThoughtLevelOverrides
disabledAgentIds                     disabledAgentIds
```

因此内置 Agent 的禁用状态仍可读，当前模型覆盖会被 staging 忽略，不会导致整个 Agent 集合消失。
两种存储都不双写旧模型字段。

### 2.7 Repo Wiki

`repoWikiStorage.ts` 对 Wiki 与 Draft 使用宽松 `JSON.parse`，不是严格的新旧互斥 Schema。回滚后 Wiki 主体
仍可读取，当前 `modelSelection` 不被识别时，重新生成可能使用旧版默认或要求重选。

不反向生成 `generationModel/generationOptions.thoughtLevel`。

### 2.8 Bot：确定的硬例外

当前和 staging 都使用 `bot-config.json`、`bot-state.v2.json`。但
`botCurrentOptionsSchema/botDraftOptionsSchema` 是 `.strict()`：

```text
staging Options                    当前 Options
---------------                    ------------
model / thoughtLevel               modelSelection
mode / ...                         mode / ...
```

当前版本把同名文件写成新结构后，staging 会因未知 `modelSelection` 拒绝文件。其 Repository 随后把 Bot
Config 回退为空，把 Bot State 回退到 legacy 文件或空状态。这会影响整份 Bot 数据，不是单个新选择丢失。

同时写新旧字段无效：staging 拒绝新字段，当前 strict Schema 也拒绝旧字段。必须隔离物理文件。

额外核实：当前已经删除 Bot Model Cache Repository，不再写 `bots-model-cache.v2.json`；旧缓存保持不动，
staging 可继续使用，不需要新增缓存文件兼容方案。

## 3. Bot 最小实施设计

```text
升级前文件（不再改写）
├─ bot-config.json
└─ bot-state.v2.json
          |
          | 对应 v3 文件不存在时，单向导入
          v
当前版本文件
├─ bot-config.v3.json
└─ bot-state.v3.json
          |
          `--> 当前 Repository 读写的唯一权威

回滚 staging
└─ 继续读取升级前旧文件，不认识也不触碰 v3
```

实施要求：

1. Config 与 State 都版本隔离，不能只迁移 State 而遗漏 strict Config。
2. 文件名与内容版本一起提升到 v3。
3. 对应 v3 文件不存在时，从原有旧文件读取，复用单向转换，写出 v3；旧文件不改写、不删除。
4. v3 存在后不再从旧文件补充、修复或覆盖当前数据；不得因当前文件损坏而偷偷回退陈旧配置。
5. 没有旧文件时从空 v3 正常开始，不创建假的旧版副本。
6. 创建、编辑、删除 Bot 和更新 Draft/State 都只写 v3。
7. 可确定的旧模型字段转换为当前 ModelSelection；无法确定的选择留空，主体 Bot 数据保留，不猜测 Provider。
8. 继续复用现有文件写入和 Repository 边界，不增加两文件分布式事务或通用双写调度器。

“复用单向转换”不等于原样调用 `bots/storageMigration.ts`：现有 `findUniqueProviderByModel` 在旧
Provider 不匹配时会按模型名寻找其他 Provider，`migrateDraftOptions` 还会让旧 `thoughtLevel` 覆盖已有
新 `modelSelection.options.reasoningLevel`。两条旧逻辑必须在接入 v3 前删除/修正，按 Todo 72 的明确身份
转换替代；已有新选择只认自身字段，无法确定就留空，不按模型名改路由。

旧文件是升级前快照，并不是同步副本。回滚后用户看见升级前的 Bot 配置和状态；新版期间新增、删除或修改的
Bot 不保证体现在回滚版本中。这是明确接受的产品边界。

首次导入可以在下一次启动补齐尚未生成的另一个 v3 文件；不得把这种一次性导入误实现为每次保存持续回写。
各文件写入继续使用既有安全写入机制，失败不伪装为成功。

导入上下文由服务组装层注入：普通 Bot 默认配置使用所属 Host 的模型与当前登录连接；带
`workspaceIdentity` 的旧状态只能使用该远端的模型事实，不能拿本地账号解释旧 Coding Plan。
若当时远端不可连接或没有可取得的账号上下文，无法确认的绑定留空，主体状态照常导入。
新文件的解析/IO 错误向调用方暴露，不回读旧文件，也不把损坏文件改写为空。

## 4. 范围约束及与相邻 Todo 的关系

生产改动只针对 Bot Config/State 文件隔离及其单向升级入口。其他领域保留当前单向升级读取，不新增降级写入。

禁止：

- Provider Config 反向同步；
- Session、Off-Peak、Automation、Settings、Subagent、Repo Wiki 持续写旧别名；
- 为兼容旧版静默变换 Reasoning 档位或猜测旧 Agent Provider；
- 通用旧版 Selection Encoder、兼容 DTO、第二份 Config/Registry 权威；
- 整库副本、破坏性 SQLite 降级迁移；
- 当前版本持续读取冻结旧文件修复当前数据。

```text
Todo 69：当前版本 -> staging 降级回滚
└─ 防止整域数据被旧 Reader 拒绝；当前硬点是 Bot 文件隔离

Todo 70：旧 Session -> 当前版本升级恢复
└─ 新旧字段判定、可靠迁移、失效 Selection 与历史可打开性

Todo 71：当前版本内 Composer -> Submission
└─ 持久草稿和提交状态，不承担跨版本字段双写

Todo 72：旧 Provider 配置与持久化选择 -> 当前身份
└─ 修正内置分类、只迁 Built-in API Key、按迁移时当前连接转换旧 Coding Plan 身份
```

升级身份规则见 [Todo 72](./todo-72-legacy-builtin-provider-and-model-selection-migration.md)，
包括 Bot 一次性导入所需的身份转换；不扩大本文的降级兼容范围，不恢复持续双写。

取消 Todo 69 原来的双写范围，不撤销已经确认的升级原则：当前结构存在时不从旧字段补值；真正旧记录才允许
确定性 Decoder；无法可靠恢复时按所属领域报告或交由用户修复。

不改变 Provider/Model Registry、Account Family、队列、Selection 生命周期或任何执行链。Bot 的本地和远端
调用继续通过同一个 Repository，不能在 Remote/Bot Bridge 重新增加旧文件旁路。

## 5. 测试和验收

### 5.1 Bot 测试先行

- 以冻结 staging 的代表性 Config/State 为输入，证明导入前的同文件 strict 冲突。
- 首次启动生成 v3，主要 Bot 数据和能确定的 Selection 正确转换。
- 当前版本创建、编辑、删除 Bot，以及更新 Draft/State 后，两个旧文件字节保持不变。
- v3 已存在时不回读旧文件补值；当前 v3 读写符合当前 strict Schema。
- Config/State 只有一个已生成时，下一次启动只导入缺失项，不覆盖已有项。
- 单个旧 Bot 的 Selection 无法转换，不拖垮其他 Bot 或丢失主体配置。
- 即使只有另一个 Provider 提供同名模型，也不把旧选择迁到它；当前 Selection 与旧 thoughtLevel 冲突时当前值不变。
- 用冻结 staging 的 strict Reader 读取保留的旧文件，能够得到升级前 Bot 数据。
- 旧文件缺失时正常创建当前空配置，不生成旧副本。

只固定当前 staging 的必要读取契约，不建立多版本兼容框架，不要求反向恢复新版 Bot 修改。

### 5.2 其他领域最小验证

- 复用 Provider Config 测试，证明旧 `config.json` 不变。
- 用 staging 的 Off-Peak/Automation Row Reader 验证旧模型列为空的新版代表行可读；不要求得到精确新选择。
- 确认新增 SQLite 列为旧版可忽略的可空列，旧表/列不做破坏性删除。
- 对 Session、Settings、Subagent、Wiki 使用代表性新字段输入，验证旧读取入口不会整域拒绝；优先复用现有
  测试，只补没有直接证据的边界。
- 不新增“所有新旧模型值必须语义等价”的测试，那不是本 Todo 目标。

### 5.3 完整检查

- 受影响 Bot、Services、存储适配层定向测试；
- `pnpm typecheck`；
- `pnpm lint`；
- 本轮修改文件格式检查和 `git diff --check`；
- 临时目录内执行“当前版本导入并修改 Bot -> staging Reader 读取冻结旧文件”的回滚冒烟。

不要在用户真实目录、Bot 账号或运行中的数据库上做破坏性回滚测试。未运行旧 App 的实机启动时，实施记录
只能写 Reader/存储冒烟通过，不能宣称旧 App 全链路验收完成。

## 6. 实施顺序与完成标准

实施顺序：

1. 核对冻结 staging 目标，加入 Bot 失败测试。
2. 衔接 Todo 72 已测试的旧 Provider 身份转换，再实现两个 v3 文件的 Schema、路径及一次性 Import。
3. 收口所有 Bot 当前读写入口，确认旧文件不变。
4. 执行其余领域的最小回归，确认未引入持续双写。
5. 更新实施记录、回滚允许退化和验证结果后提交。

联合顺序见 Todo 72：其身份转换基础先于 Bot 首次导入验收，其他持久化入口随后接入。
不先生成身份错误的 v3 再补迁移；v3 一旦存在就不回读旧文件的边界保持不变。

完成标准：

- Bot 当前只以 v3 为权威，升级前旧文件始终不变，staging 不再因新版字段拒绝整份 Bot 数据。
- 除 Bot 版本隔离外，不新增持续双写和通用兼容抽象。
- 当前单向升级读取没有因缩减回滚范围被误删。
- SQLite 物理结构保持增量兼容。
- 所有允许的单条记录/可重建设置退化均在本文列明。
- 定向测试、类型、Lint、格式和差异检查通过；实机验证状态如实记录。

## 7. 本轮代码证据索引

以下路径以本节顶部冻结提交为基准，后续重构导致行号变化不影响读取契约：

| 领域       | 主要证据路径                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider   | `packages/services/src/model-provider/providerConfigRuntime.ts`；`packages/services/test/providerConfigRuntime.test.ts`                                       |
| Session    | `apps/zcode-cli/packages/adapters/src/storage/session-store/codecs.ts`；`apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts`              |
| Off-Peak   | `packages/services/src/session/offPeakTaskRepo.ts` 的 Schema、create、rowToTask/list                                                                          |
| Automation | `packages/services/src/session/automationRepo.ts` 的 Schema、create、rowToAutomation/list                                                                     |
| Settings   | `packages/shared/src/validationAppSettings.ts`                                                                                                                |
| Subagent   | `packages/services/src/subagents/subagentMarkdown.ts`；`packages/services/src/subagents/subagentsService.ts`                                                  |
| Wiki       | `packages/services/src/repo-wiki/repoWikiStorage.ts`                                                                                                          |
| Bot        | `packages/shared/src/bots.ts`；`packages/services/src/bots/config.ts`；`packages/services/src/bots/repo.ts`；`packages/services/src/bots/storageMigration.ts` |

实施证据见 [68–72 实施报告](./68-72-implementation-report.md)。Bot v3、一次性导入及旧文件保留已实现；
不再由运行中的 Service 重写旧状态。回滚验收是严格读取/文件字节边界，不是完整旧 App 实机验收。
