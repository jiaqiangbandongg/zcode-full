# 23 Provider Refactor 决策缺口与设置事务收口

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。

> 状态：已完成（自动化收口；macOS Electron 交互复验随开发链进行）
>
> 日期：2026-08-27
>
> 来源：Provider Refactor 完成声明后的反向审查
>
> 关联任务：[`05`](./todo-05-model-ref-retirement.md)、
> [`07`](./todo-07-account-connection-selection-and-access-context-cutover.md)、
> [`12`](./todo-12-model-selection-validation-boundary-cutover.md)、
> [`13`](./todo-13-target-host-model-selection-authority.md)、
> [`14`](./todo-14-post-refactor-mechanical-zero.md)、
> [`15`](./todo-15-provider-release-validation.md)、
> [`20`](./todo-20-account-overlay-atomicity-and-review-closeout.md)、
> [`21`](./todo-21-zcode-builtin-config-ownership-and-model-activation-order.md)

## 0. 任务定位

本 Todo 收口已经明确、但没有完整进入当前实现的 Provider Refactor 决策。它不是新一轮架构重写，也不重新讨论已经正确
落地的 Provider group、Model enabled、Builtin-wins、Provider/Model order、专属 Rule、Access protocol 或 Host 权威来源。

本次审查发现的问题分为三类：

1. 旧抽象换名后仍在运行，例如 `ForkModelRef`；
2. Todo/Design 已声明完成，但实现没有满足，例如 Model 编辑原子保存和继承态；
3. 讨论中已经裁决，但没有进入正式 Todo/Design，例如公共 `accessId` 退役和普通 Built-in Provider 简化编辑器。

目标完成后，主链必须重新满足：

```text
未来执行意图
    ModelSelection
          |
          v
Provider Registry + ModelFactory
          |
          v
      Active Model
          |
          +--> Account 请求期鉴权（账号服务拥有当前连接和凭据）
          `--> Adapter / AI SDK

Provider/Model Settings
    Host View @ revision R1
          |
          v
      Local Draft
          |
          v
一次原子 Host Mutation
          |
          v
Persist + Registry @ revision R2
```

### 0.1 本轮不重新打开的裁决

- `modelMatch` 对完整 Model ID 做大小写不敏感的正则完整匹配；需要包含匹配时由 Rule 作者显式写前后 `.*`，Resolver
  不自动补；
- Provider group、Provider visibility、Provider/Model enabled 的既有语义不变；
- Provider/Model order、Builtin-wins、五个 Source Schema 和 `provider-model` 专属 Rule 不变；
- Model Config、Runtime 和 Protocol 继续共用 `properties.input_format/output_format`；
- Local workspace 使用 Local Host，remote workspace 使用 Remote Host；Renderer 不重新获得配置权威；
- 不建立 `ModelIdentity`、第二个 Registry、第二套 capability DTO 或新的 Config Document 抽象。

### 0.2 非目标

- Todo 22 中延期的 OpenRouter、OpenCode Zen、Azure、Volcano Ark、AWS Bedrock；
- Client Config 全局公共 Service 重构；
- Telemetry 总体设计重构；
- Off-Peak 字符串错误改为结构化协议；
- Conversation queue、continuous/replayable、workspace identity 或模型选择产品生命周期变更；
- 为当前未发布分支增加 dual-read、兼容别名或无必要 migration。

## 1. 已确认问题与目标状态

| 编号 | 当前问题                                                                                           | 目标状态                                                                         |
| ---- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| G1   | `accessId` 同时进入 Account Overlay、Provider Config、Protocol、Credential key、Request Auth 和 UI | 由 Todo 24 删除；账号服务按静态 family/planKind 解析当前兼容连接                 |
| G2   | `ForkModelRef { providerId, modelId, variant }` 是旧 `ModelRef` 的同形别名                         | 后续执行意图直接使用 `ModelSelection`，`variant` 退出                            |
| G3   | `formatModelSelection()` 不能保存 `maxOutputTokens`，字符串仍被当作可逆领域格式                    | 状态、协议和持久化只传结构化 `ModelSelection`；字符串只作为 Picker/Legacy 边界值 |
| G4   | Model 编辑提交后立即关闭，rename 与 config save 是两次 Mutation                                    | 完整 Draft 通过一次原子 Host Mutation 提交，Registry 观察成功后关闭              |
| G5   | 修改 Model ID 时没有先移动 Personal 专属 Rule 并重新预览 Effective Config                          | Host 提供无持久化 Preview；新 ID 立即刷新继承结果，Personal 显式值不变           |
| G6   | UI 把 Effective 值复制进 Personal Draft，继承、未设置和明确覆盖混淆                                | Draft 分离 Personal 值与 Effective Preview，四态语义可观察、可编辑、可恢复       |
| G7   | 普通 Built-in Provider 和 Personal-only Provider 复用完整编辑器                                    | “添加供应商”进入简化编辑器；“创建自定义供应商”保留完整编辑器                     |
| G8   | `adapterCompatibility.reasoningReplay` 把历史模型特例保留成正式 Config 维度                        | 删除整个 Compatibility 容器；所有 Adapter 只执行 canonical replay                |
| G9   | Adapter 执行文件和注释继续使用旧 Registry 命名，旧 Todo 完成声明与代码事实不符                     | 命名机械归零；历史 Todo 增加纠正说明，路线图与 Feature Graph 在实现后同步        |

## 2. Access：由 Todo 24 取代

本 Todo 最初提出的账号连接版本与旧 Active Model 失效设计已经撤销。Access 的唯一当前契约见
Todo 24（该文档只在官方版本保留），要点如下：

- Built-in 固定 `family + planKind`；Account Overlay 只投影 `enabled` 和 Start 账号模型成员；
- 当前账号、商品、Team scope 与动态凭据由账号服务管理，每个请求按当前兼容连接解析；
- 不保存账号连接 ID 或连接版本，也不因同一 `family + planKind` 下账号变化使旧 Active Model 人工失效；
- Local、Remote 与 Standalone 各自使用所在 Environment 的账号服务，缺少兼容连接时在网络前失败。

## 3. ModelSelection 与 `ModelRef` 机械归零

### 3.1 Fork 使用标准 `ModelSelection`

删除公共 `ForkModelRef` 及其 `variant`：

```text
Fork / Side Chat / Before-input Fork
    后续需要创建 Model
          |
          v
    保存 ModelSelection
    ├─ providerId
    ├─ modelId
    └─ options.reasoningLevel / maxOutputTokens（存在时）
```

历史消息只有实际 provider/model/reasoning 事实、但没有完整未来选择时，由该消费者明确决定是否能构造 Selection；不能新建
另一个 Ref/Identity 类型绕过语义判断。`Model.options` 仍是已绑定执行值，不能被一般性反投影为未来选择。

### 3.2 结构化 Selection 是唯一领域表示

`modelSelectionSchema` 继续是结构化对象的唯一严格 Schema。以下位置只能保存或传输对象：

- Protocol 命令和响应；
- Session/Task/Automation/Subagent/Repo Wiki 等产品状态；
- Fork/Compact/Child 等后续执行意图；
- Host 与 Agent 的模型设置、默认值和提交参数。

字符串只允许两类边界：

1. UI Select 控件要求的 Picker Value；
2. 明确已发布的 Legacy 字符串读取。

相关函数必须按真实语义命名为 `formatModelPickerValue`、`parseModelPickerValue` 或
`parseLegacyModelSelectionValue`，不得继续宣称 `parse(format(selection))` 能恢复包含 `maxOutputTokens` 的完整 Selection。
调用方必须同时持有结构化 Selection，不能从 Picker Value 重建并覆盖完整状态。

### 3.3 比较语义

不增加统一的 `sameModelSelection()` 或 `ModelIdentity` helper。各消费者继续显式比较自己真正关心的字段，并保持改造前行为：

- 判断执行目标是否变化时，可以只比较 `providerId/modelId`；
- 判断用户选择是否变化时，由该产品显式比较它保存的 option leaves；
- reasoning 不重新进入 identity；
- 不为了减少重复代码改变既有比较结果。

## 4. Settings：把 Model 编辑真正做成手动事务

### 4.1 唯一提交契约

Model 编辑弹窗继续使用手动保存。Host 暴露一次完整 Mutation，输入至少包含：

```ts
interface SavePersonalModelDraftInput {
  providerId: string;
  originalModelId: string;
  nextModelId: string;
  personalConfig: ModelConfigObject;
  basedOnRevision: string | number;
}
```

实际名称可遵循现有服务命名，但语义不可拆分。Host 在同一事务中完成：

1. 校验 Provider/Model membership、Builtin 冲突、Model ID 和 Source Schema；
2. Personal Model rename 时原子更新 `modelIds` 与 `modelOrder`；
3. 移动对应 Personal `provider-model` Rule；
4. 保存完整稀疏 Personal Model Config；
5. 持久化并发布 Registry revision；
6. 返回已经可观察的新 Host View/revision。

弹窗只有收到成功响应后才能关闭。校验、持久化、Registry 发布或 revision conflict 失败时保留 Draft 和弹窗，显示明确错误；
不在 Renderer 中通过两次调用补偿式回滚。

### 4.2 Model ID 实时 Preview

Host 提供无持久化、无 Registry mutation 的 Preview：

```text
Original Personal Rule + Local Draft
              |
              +--> 在预览态把 exact target 移到 nextModelId
              |
              v
按 nextModelId + Effective Provider api/baseURL 解析 Built-in Rules
              |
              v
叠加 Personal Draft 中明确存在的叶子
              |
              v
返回 Effective Preview + validation issues
```

修改 Model ID 后应进行去抖 Preview。旧响应必须按 request sequence 或 Draft revision 丢弃，不能覆盖更新的输入。Preview
不修改 Personal 文件、Provider membership、modelOrder 或正式 Registry。保存时 Host 必须重新执行权威解析与校验，不能信任
Renderer Preview。

### 4.3 Draft 与继承事实分离

Renderer Draft 不再把 Effective 值复制成 Personal value。每个字段至少保留：

```ts
interface ModelFieldDraft<T> {
  personal: T | null | undefined;
  inherited: T | undefined;
  effective: T | undefined;
}
```

不要求机械建立这个通用类型；可以按字段使用现有结构。必须保持的四种产品语义是：

| 状态                    | 保存事实                         | UI                             |
| ----------------------- | -------------------------------- | ------------------------------ |
| 上游有值、无 Personal   | 不写 Personal                    | 低强调展示继承值               |
| 上游无值、无 Personal   | 不写 Personal                    | “未设置”/短横线                |
| Personal 明确值         | 写对应稀疏叶子                   | 正常强调，可恢复继承           |
| Personal explicit clear | 写 `null`，仅限允许 clear 的字段 | 明确显示清除状态，不等同未覆盖 |

数值/文本输入使用继承值作为 placeholder；Boolean/Format 使用现有风格的 Toggle Chip/Selectable Tag，并用对勾、短横线、
描边和低干扰撤销入口区分状态，不能只靠颜色。PDF/Audio 继续隐藏但无损保留。`requiresMfjsToolSchema` 放在编辑器最后。

### 4.4 JSON 槽位

继续保留三个独立 JSON 编辑器：

- `optionSpecs.reasoningLevel`；
- `optionSpecs.maxOutputTokens`；
- `reasoningMapping`。

每个编辑器直接替换自己的 Personal 槽位，空内容恢复继承，不在编辑器内部按 key 合并。保存使用 Provider 权威 Schema 校验，
至少提供格式化和字段路径错误；如所选编辑器能够可靠提供行列，再显示行列。UI 不复制 Effective JSON 到 Personal 文本框，
Effective 结果使用单独的低强调预览。

## 5. Settings：区分 Built-in 添加与自定义创建

普通 Provider Settings 保持两个入口：

```text
添加供应商
└─ 从 group=standard-builtin 且尚无 Personal Overlay 的候选中选择
   └─ 创建/启用 Personal Overlay 后进入简化编辑器
      ├─ API Key
      └─ 模型列表与模型配置

创建自定义供应商
└─ 创建 group=standard-personal 的不完整 Provider
   └─ 进入完整编辑器
      ├─ Provider Name（唯一）
      ├─ API Schema
      ├─ Endpoint / Headers
      ├─ API Key
      └─ 模型列表与模型配置
```

普通 Built-in Provider 的 API Schema、默认 Endpoint 和身份来自 Built-in Config，不在主编辑路径中重复展示为普通可编辑字段。
删除始终只删除 Personal Overlay；Built-in Config 永远不被删除。Personal-only Provider 删除后因为没有 Built-in 底座而自然
消失。Provider ID 在所有界面只读。

简化编辑器与完整编辑器可以复用模型列表、API Key 和测试组件，但不能因为复用 `InlineEditableProviderCard` 而重新暴露完整
字段。Z.ai/BigModel Family 保持固定 Family UI，不进入这两个普通入口，也不提供 Provider disable 操作。

## 6. Adapter Compatibility 删除与命名归零

### 6.1 Reasoning replay

canonical 历史回放不需要任何 `reasoningReplay` 配置。最终裁决是完整删除
`adapterCompatibility`、`reasoningReplay` 与 synthetic empty-thinking 投影：

```text
Canonical Message
       |
       v
Adapter 标准编码
       |
       v
完整回放真实 reasoning；不删除、不补造空 thinking
```

Model Config Schema、Overlay、Resolver、Registry、Runtime、Built-in Config、Personal Config 和测试 fixture 均不得继续
接受或传播 Compatibility 容器。历史未发布格式不增加 importer；遇到旧字段按严格 Schema 拒绝。

### 6.2 Adapter 执行命名

当前 Adapter 文件实际承载 AI SDK Model Execution 装配，不再是业务 Registry。完成时应：

- Adapter 执行文件使用准确的 `model-execution.ts` / factory 命名；
- 删除“session registry”“provider registry cache”等已经不成立的注释；
- 保留确实属于 Adapter 私有的 transport/factory/cache，不因改名引入新的公共抽象；
- 不把业务 Provider Config、Model Config 重新复制为 Adapter 可查询 Registry。

## 7. Impact Brief

### 7.1 功能摘要

| 字段             | 结论                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Developer intent | 收口 Provider Refactor 已裁决但未实现的公共 access、ModelSelection 和 Settings 事务缺口                                               |
| Capability       | Provider Registry、Account Request Auth、Model Selection、Provider Settings                                                           |
| Change layer     | `draft-default`、`validation`、`commit-effect`、`persistence`、`presentation`                                                         |
| Operating mode   | planning / implementation handoff                                                                                                     |
| Primary seeds    | `ZhipuAccountAccessConfig`、`AccountProviderCredentialService`、`ForkModelRef`、`formatModelSelection`、`ProviderModelMetadataDialog` |
| Out of scope     | Provider 扩容、Telemetry 重构、Conversation recovery、Client Config 公共服务                                                          |

### 7.2 UI Surface Matrix

| 用户场景                    | UI 入口                                    | Draft/展示 owner                   | 默认/继承来源                   | 校验与提交                            | 权威 owner                   | 模式边界                   |
| --------------------------- | ------------------------------------------ | ---------------------------------- | ------------------------------- | ------------------------------------- | ---------------------------- | -------------------------- |
| 添加普通 Built-in Provider  | Provider Settings 固定操作                 | Renderer 选择态；无 Provider Draft | 目标 Host Built-in Config       | 创建 Personal Overlay                 | 目标 Environment Host        | Local/Remote 使用各自 Host |
| 创建 Personal-only Provider | 自定义创建界面                             | Renderer 创建态                    | 无默认 API Schema               | 立即创建不完整 Provider，后续自动保存 | 目标 Environment Host        | 同上                       |
| 编辑 Model                  | 大一档手动保存弹窗                         | Renderer Local Draft               | Host Effective Preview          | 一次原子 Model Mutation               | Personal Config + Registry   | Desktop/Mobile 同语义      |
| 模型选择                    | Conversation/Automation/Subagent/Repo Wiki | 各产品自己的 Draft                 | 目标 Host Selection View        | 各自 commit sink                      | 各自产品状态/Worker Registry | 不统一各产品生命周期       |
| Account 连接展示            | Family/Usage/Entitlement UI                | Host 投影状态                      | Account Connection/Availability | 既有登录/连接动作                     | Account 服务                 | 不读取 `accessId`          |

### 7.3 分级关系

| 等级           | 关系                                                      | 原因                                                           |
| -------------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| must-inspect   | Account Connection -> Account Overlay -> Request Auth     | 删除连接 ID 后仍须按当前兼容连接解析且缺失时 fail-closed       |
| must-inspect   | Model editor -> Host Mutation -> Personal Config/Registry | 当前分步保存会丢 Draft 并产生非原子状态                        |
| must-inspect   | Fork/Protocol/Persistence -> ModelSelection               | `ForkModelRef` 和字符串会继续制造第二种选择表示                |
| should-inspect | Usage/Telemetry/Family UI -> Account status               | 当前部分展示通过 `accessId` presence 推断连接                  |
| should-inspect | Automation/Subagent/Repo Wiki/Conversation picker         | 共享 Picker Value，但状态和提交落点必须继续分离                |
| conditional    | Standalone/Remote Host Request Auth                       | 每个 Environment 必须使用自己的账号服务                        |
| invariant-only | desktop continuous / mobile replayable                    | 本轮不改变 stream、snapshot、queue 或恢复语义                  |
| invariant-only | Off-Peak                                                  | 继续使用普通 ModelSelection/Registry/ModelFactory 和请求期鉴权 |

### 7.4 State owner 与 Commit sink

| 状态/事实                                  | 权威 owner                             | 镜像/缓存                   | Commit sink                                       |
| ------------------------------------------ | -------------------------------------- | --------------------------- | ------------------------------------------------- |
| Built-in/Personal Provider 与 Model Config | 目标 Environment Host Provider Service | Renderer Host View          | Provider Config Repository + Registry publication |
| Model 编辑 Draft                           | 当前弹窗 Renderer                      | 无持久缓存                  | 单次 Host Model Mutation                          |
| 当前账号连接与 identity                    | Account/Credential Services            | Account Provider snapshot   | 既有登录、连接、退出流程                          |
| 请求期凭据                                 | Account Request Auth Service           | 私有 Credential Store/cache | 每个 request attempt 解析，不写 Config            |
| 未来模型选择                               | 各产品结构化 `ModelSelection`          | Picker Value 仅展示         | 各产品既有提交入口                                |
| 当前执行模型                               | Agent Runtime Active Model             | 无反向可编辑镜像            | ModelFactory 创建                                 |

### 7.5 必须保持的不变量

1. 账号类型 Provider Config 不保存凭据或账号身份；API Access 仍可直接保存用户填写的 API Key；
2. 切换/退出账号后，旧 Active Model 只可使用当前兼容 family/planKind 的连接，否则网络前失败；
3. Local 与 Remote Environment 各自解析 Provider Registry、账号连接和请求凭据；
4. `ModelSelection` 只保存显式选择意图，缺省 option 继续由 ModelFactory 解析；
5. Model 编辑取消不写配置，失败不关闭弹窗，成功只发布一个最终 revision；
6. Built-in Model 不能删除，Provider ID 不能修改，Builtin Config 永远不被 Settings 删除；
7. UI 隐藏字段 PDF/Audio 和未编辑 Personal JSON 槽位无损保留；
8. 不改变各模型选择入口的状态归属、Queue、Recovery、Off-Peak admission 或 Telemetry 总体设计；
9. 不恢复 ModelRef、ModelIdentity、公共 connection key 或第二个 Registry；
10. 不因为清理旧命名把旧 Registry 的配置职责搬进新 execution/factory 抽象。

### 7.6 Graph drift 审查与同步结果

实施前 Feature Graph 仍声明 Account Overlay 发布 opaque `accessId`，Todo 05/21 也包含与当前代码不一致的完成结果。
这些 graph/spec drift 已随本 Todo 和 Todo 24 同步；审查范围包括：

- Design Tree 中 Account Access、Request Auth、Model Selection、Settings 和 Registry 文档；
- Feature Graph 的 Provider Registry、Model Selection、Off-Peak 与 Settings 节点和不变量；
- Todo 05、07、12–14、20、21 的纠正说明或 superseded 链接；
- Todo 00 路线图的最终完成结果。

同步不得把实现中的临时权衡提升为设计。除非出现客观不可实现、正确性冲突或新可靠事实，实施应忠实执行本 Todo；普通实现
歧义选择影响最小且可逆的方案继续，不阻塞目标，完成后再讨论。

## 8. 实施切片

### Slice A：失败测试与公共契约

1. 为 Todo 24 Access 契约、ModelSelection options 保真和原子 Model Mutation
   先写失败测试；
2. 建立 Settings Draft 四态、Model ID Preview 和 Built-in 简化编辑器的组件/服务契约测试；
3. 为 Local/Remote Host authority、Standalone Request Auth 和 Off-Peak 不变量补回归测试。

### Slice B：ModelSelection 归零

1. `ForkModelRef` 全部改为 `ModelSelection`，删除 `variant` 转换；
2. 协议、持久化和产品状态只保存结构化对象；
3. Picker/Legacy 字符串 helper 明确改名并限制边界；
4. 删除重复 Parser/Formatter，不新增统一比较 helper。

### Slice C：Access 契约

由 Todo 24 完整实施和验收，本 Todo 不再维护另一份 Access 实施列表。

### Slice D：Model 编辑事务与 Preview

1. 增加一次性 Host Preview 和一次性 Host Save Mutation；
2. rename、membership、order、专属 Rule 和 Personal Config 在同一事务提交；
3. Renderer 弹窗等待成功再关闭，冲突/失败保留 Draft；
4. Model ID Preview 防抖并拒绝 stale response；
5. 删除 `rename()` 后再 `save()` 的分步 helper 和乐观补偿逻辑。

### Slice E：Settings 语义与表现

1. Draft 分离 Personal 值、Inherited Preview 和 Effective Preview；
2. 实现继承、未设置、明确覆盖、explicit clear 四态；
3. 三个 JSON 槽位复用权威 Schema，增加格式化和路径错误；
4. 普通 Built-in Provider 使用 API Key + Model List 简化编辑器；Personal-only 使用完整编辑器；
5. `requiresMfjsToolSchema` 移到最后，完成 Light/Dark、Desktop/Mobile、键盘和中英文检查。

### Slice F：Compatibility、命名和文档机械归零

1. 完整删除 `adapterCompatibility`、`reasoningReplay` 和 synthetic empty-thinking 投影；
2. 校验 Adapter `model-execution.ts` 及注释均使用 execution/factory 命名，不改变 transport/factory 行为；
3. 执行机械残留搜索，删除死 helper、测试 fixture 和错误注释；
4. 同步 Design Tree、Feature Graph、Todo 状态与 superseded 关系；
5. 按切片提交 Conventional Commits，不把全部变化压成一个不可审查提交。

## 9. 测试与验收

### 9.1 Config、Account 与 Request Auth

- Zhipu Account Access Schema 不接受、序列化或要求 `accessId`；
- Account Overlay 只发布 enabled 和 Start 账号模型成员；
- Individual/Start/Team 各自能从当前账号服务取得正确凭据；
- 相同 Family/Plan 下切换账号时旧 Model 按当前兼容连接重新解析凭据；
- 账号凭据刷新不热改 Model 的 Endpoint、API type、Properties 或 Model Selection；
- Credential Store/in-flight cache 在不同账号、Provider、Team scope 间不串用；
- UI、Usage、Telemetry 不通过 access 字符串推断账号连接；
- Local、Remote、Standalone 与 Off-Peak 使用各自 Environment 的账号事实。

### 9.2 ModelSelection

- `modelSelectionSchema` 完整接受并保留 `reasoningLevel/maxOutputTokens`；
- Fork/Side Chat/Before-input Fork 不再产生 `variant` 或 Ref alias；
- Picker Value 不会覆盖调用方持有的完整 Selection options；
- Legacy 字符串只在明确 importer/codec 边界解析；
- Conversation、Automation、Subagent、Repo Wiki 的比较与提交语义保持原行为；
- Config 默认变化不会被反向固化到历史 Selection。

### 9.3 Settings Transaction 与 Preview

- 打开、编辑、取消/X/Esc 不写配置；
- 保存只产生一次 Host Mutation 和一个最终 Registry revision；
- rename 同时更新 Personal membership、modelOrder 和 exact Rule；
- 保存失败、revision conflict 和 Registry 发布失败均保留弹窗与 Draft；
- 修改 Model ID 先移动 Preview Rule，再解析新 Built-in 默认，Personal 明确值保持；
- Preview stale response 不覆盖最新 Model ID；
- 上游有值、上游无值、Personal 覆盖、explicit clear 四态 round-trip；
- PDF/Audio 和未编辑 JSON 槽位无损保留；
- 三个 JSON 编辑器独立替换、空内容恢复继承、非法内容阻止保存；
- `requiresMfjsToolSchema` 位于最后。

### 9.4 Provider Settings

- “添加供应商”只列普通 `standard-builtin` 未添加候选；
- 添加后只显示简化 API Key + Model 编辑主路径；
- “创建自定义供应商”创建不完整 `standard-personal` Provider 并显示完整编辑器；
- 删除任意 Provider 都只删除 Personal Overlay；Built-in Config 不变；
- Family UI、普通排序、Provider ID、Built-in Model 删除权限和 model enabled 行为保持原裁决；
- Desktop/Web/Mobile、Zai Light/Zai Dark、键盘、触屏和中英文通过回归。

### 9.5 Mechanical zero

完成时至少满足：

```text
生产公共链 accessId                       = 0
ForkModelRef / 公共同形 ModelRef alias     = 0
reasoning identity variant                = 0
当前写入路径的 Selection 字符串序列化      = 0
rename 后再 save 的 Model 编辑分步提交      = 0
adapterCompatibility / reasoningReplay         = 0
旧 Adapter Registry 命名与错误注释          = 0
```

允许保留的搜索命中必须逐条列入完成记录，并证明属于第三方字段、明确 Legacy 只读边界或历史文档引用；不能用宽泛 allowlist 掩盖
生产残留。

最终执行：

- 相关 Provider、Services、Shared、Core、Bootstrap、UI 单测；
- `pnpm typecheck`；
- `pnpm lint`；
- `pnpm fmt:check`；
- 受影响 Desktop E2E，以及 Local/Remote Host Provider Settings/Selection 回归；
- `pnpm knip` 与定向 `rg` 机械零检查；
- 必要时 `pnpm test:unit:affected` 和 `pnpm verify:pre-push`。

## 10. 完成定义

只有以下条件全部满足，才能把本 Todo 标记为“已完成”：

1. G1–G9 的代码、测试和机械零门禁全部完成；
2. `accessId` 没有以新名字重新进入 Provider Config、Model、Protocol、UI 或公共 Credential contract；
3. 账号切换、退出、凭据刷新和 Remote/Standalone 请求均有当前连接解析与缺失时 fail-closed 证据；
4. Fork、Picker、Protocol 和 Persistence 不再存在第二套 ModelSelection 表示；
5. Model 编辑保存是一次 Host Mutation，失败保留 Draft，Preview 不产生持久化；
6. Built-in 简化编辑器与 Personal-only 完整编辑器按 group 分流；
7. Design Tree、Feature Graph、路线图和相关旧 Todo 已同步真实实现，不再错误宣称未满足的事项已完成；
8. 必需测试、类型检查、Lint、格式检查、受影响 E2E 和机械残留检查通过；
9. 按可审查切片提交 Conventional Commits，并在实施记录中保留自主选择与验证证据。

## 11. 实施记录（2026-08-27）

- ModelSelection 统一保留结构化 `providerId/modelId/options`，Fork、Side Chat、Automation、Subagent 与
  Persistence 不再维护 Ref alias 或 reasoning identity variant；
- Model 编辑保存收口为一次带 `basedOnRevision` 的 Host Mutation，rename、membership、order 与精确 Personal Rule
  原子提交；Preview 只返回继承值和 Effective 值，不持久化、不接受 Renderer 提供 API/Endpoint 权威；
- Personal Model Draft 改为真正稀疏 Overlay：未触碰叶子不写入，PDF/Audio 和 JSON 槽位无损保留；“全部恢复默认”以
  当前模型 ID 的新继承结果为基线；
- Provider/Model 设置页完成既定简化、排序和弹窗交互；Provider 连续排序使用 UI 乐观投影，Environment owner 变化时
  丢弃旧 Pending，不形成第二份配置事实；
- `adapterCompatibility`、`reasoningReplay`、synthetic empty-thinking 以及相关 fixture/helper 已从当前生产链删除；
- Access 切片由 Todo 24 按最终裁决完成，ZAPI 退役由 Todo 25 完成。

> 后续反向审查补充：Host Preview 与 Model Draft 原子保存本身已按本 Todo 完成；Personal Match/Exact
> Rule 的稳定分组优先级，以及 Resolver 与写入侧三段顺序 helper 的机械归一，由
> [`Todo 28`](./todo-28-model-rule-precedence-and-order-canonicalization.md) 承接。

验证证据：

- 根 `pnpm typecheck` 通过；根 `pnpm lint` 为 0 error（34 条全仓既有 warning）；
- Model 设置定向测试 235/235、UI/Services 契约测试 47/47、CLI Provider/Adapter/Bootstrap 定向测试
  228/228 通过；
- 根全量 Unit 12,438/12,440 直接通过；仅失败的两个 Windows ZIP 用例是宿主缺少系统 `zip`，使用隔离的兼容 ZIP
  命令复跑 17/17 通过；
- 本轮 216 个修改文件经 `oxfmt` 修正后定向格式检查通过；根 `fmt:check` 仍被仓库既有二进制文件和 Electron 上游
  示例 HTML 解析错误阻塞；
- 根 `knip` 仍报告全仓既有 unused 基线；定向检查未报告本轮新增 Access、Credential 或 UI 拆分符号；
- 生产代码机械搜索确认 `ForkModelRef`、`adapterCompatibility`、`reasoningReplay`、
  `anthropic-empty-thinking` 与旧 Access Type 均为零。
