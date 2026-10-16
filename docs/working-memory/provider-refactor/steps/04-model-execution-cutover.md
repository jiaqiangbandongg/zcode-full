# M4 模型执行链收口

> 状态：已完成；静态、单元与 OP10 Desktop 网络 E2E 门禁通过
>
> 日期：2026-08-24
>
> 目标设计：[`../design/design.md`](../design/design.md)

## 1. 阶段目标

M4 把闲时任务和 Subagent 等特殊执行接入已经建立的标准模型调用链：

```text
ModelSelection
      |
      v
Provider Registry
      |
      v
ModelFactory
      |
      v
Model
      |
      v
ModelRequest -> Adapter -> Provider API
```

M4 不建立第二种 Model、第二个 Registry 或通用临时 Provider。阶段完成后，普通会话、闲时任务、
Compact 和 Subagent 都用同一套 Effective Provider Config、Effective Model Config、ModelFactory、
Adapter、Usage 和 Trace 语义。

M4 的主要迁移对象是闲时任务原有的 `turnRuntimeModel` 链。M4 前，Host 会为每次派发拼装一份完整
Runtime Provider 快照，CLI 再把它注入 Runtime Overlay、临时切换 Session model，并在 Turn 结束时
恢复。M4 已将这条兼容链物理删除。

## 2. 已确认的配置基础

### 2.1 Provider Config

Provider Config 固定按以下顺序 Overlay：

```text
ZCode Built-in Provider Config
              |
              v
     Account Provider Config
              |
              v
    Personal Provider Config
              |
              v
    Effective Provider Config
```

```ts
const effectiveProviders = zcodeBuiltinProviders
  .overlay(accountProviders)
  .overlay(personalProviders);
```

Account 只补充或约束 ZCode Built-in 中的账号 Provider，不读取 Personal 自定义 Provider。
Personal 最后生效，表达用户对模型 API 调用封装的最终配置。

### 2.2 Model Config Rules

Model Config Rules 是数组拼接，Personal 在后：

```ts
const effectiveModelRules = new ModelConfigRules([
  ...zcodeBuiltinModelRules.rules(),
  ...personalModelRules.rules(),
]);
```

Rules 作用于 Effective Provider Config：

```ts
for (const [providerId, provider] of effectiveProviders) {
  for (const modelId of provider.models ?? []) {
    effectiveModelRules.resolve(providerId, modelId, provider.api?.type);
  }
}
```

Provider Config 回答“有哪些 Provider、每个 Provider 有哪些模型、使用什么 API 和访问方式”；
Model Config Rules 回答“模型具有什么能力、选项和请求参数映射”。两路最终形成完整 Model。

## 3. Provider 可见性

M4 用通用用户可见性替换 `executionOnly`：

```ts
type ProviderVisibility = "visible" | "hidden";
```

缺省为 `visible`。

```text
visibility = visible
├─ 出现在 Provider Settings
└─ 出现在 Model Selection 候选

visibility = hidden
├─ 不出现在 Provider Settings
└─ 不出现在 Model Selection 候选
```

`visibility` 只控制面向用户的展示和候选列表，不表达鉴权、调用权限、运行来源或 Config 完整性。
Hidden Provider 仍参与普通 Provider/Model 解析，仍进入内部 Registry，并使用同一个 ModelFactory。
内部产品能力知道精确 `providerId + modelId` 时可以创建它，不需要“受信 Provider”或另一种创建接口。

`executionOnly` 是尚未发布的中间字段，M4 直接删除，不保留 importer 或长期兼容读取。

## 4. Access 与凭据边界

Provider Config 是模型 API 调用的装配输入。它可以保存静态凭据或稳定凭据引用，但不是统一凭据
中心，不管理所有动态凭据的生命周期，也不承担服务端最终授权裁决。

M4 后的 Access 类型至少包括：

| Access type     | Config 保存内容                          | 请求时行为                                       |
| --------------- | ---------------------------------------- | ------------------------------------------------ |
| `api-key`       | 静态 `apiKey`                            | Adapter 使用 Config 中的 Key                     |
| `zhipu-account` | 稳定、非敏感的 `accessId`                | Account Request Auth Service 解析当前动态凭据    |
| `request-auth`  | 不保存具体凭据，只声明请求期必须提供鉴权 | ModelRequest 执行时消费调用方提供的 Request Auth |

`request-auth` 是普通 Access 类型，不与 `visibility`、闲时任务或所谓“受信执行”绑定。任何 Provider 都可以
采用这种访问方式。执行 context 在创建 Model 时把本次作用域的 Request Auth Source 装配进
`ModelRequestDependencies`；公共 `ModelRequest` 不增加凭据字段。它的完整性规则是：

```text
Config / Registry 完整性
├─ access.type = request-auth
├─ api.type 完整
├─ api.baseURL 完整
├─ models[] 完整
└─ Effective Model Config 完整

ModelRequest 执行
├─ 本轮 Source 能解析 Request Auth -> 合并动态 Header，发送请求
└─ 未装配 Source / 无法解析 -> 网络请求前返回类型化鉴权缺失错误
```

Hidden Provider 不再获得 `access` 或 `baseURL` 的校验豁免。

## 5. 闲时 Built-in Provider

`builtin:offpeak-idle-plan` 是普通的 ZCode Built-in Provider，只是用户不可见并使用请求期鉴权：

```json
{
  "label": "Idle plan",
  "visibility": "hidden",
  "access": {
    "type": "request-auth"
  },
  "api": {
    "type": "anthropic-messages",
    "baseURL": "https://zcode.z.ai/api/v1/off-peak/anthropic"
  },
  "models": ["GLM-5.2", "GLM-5-Turbo"]
}
```

生产 Endpoint 是 Built-in Provider Config 的静态事实。测试和 mock 通过注入测试用 Built-in Config
Source 改写整份测试配置，不把 Endpoint 重新放入单次 Turn payload。

模型的 context、max output、输入输出格式、reasoning levels 和 reasoning mapping 来自 ZCode
Built-in Model Config Rules。Host 不再按 modelId、Provider family 或远端 `builtinModels` 重新推断。

`enable_offpeak_task` 可以继续作为闲时任务产品灰度。远端 `allowed_models` 不再作为 Provider.models、
模型能力或 Registry 的事实源；服务端仍可在 ticket 或模型请求边界执行自己的最终准入。

## 6. 闲时 Submission

闲时任务是一份带有执行期上下文的普通 Core Submission：

```text
Host / Scheduler
├─ prompt / attachments / mode
├─ idle ModelSelection
├─ execution-scoped Request Auth
├─ Off-Peak Ticket
└─ optional Subagent Model override
             |
             v
       Core Submission
             |
             v
   Registry / ModelFactory
             |
             v
       Loop Active Model
```

Submission 始终只有一份 `ModelSelection`。Request Auth、Ticket、Off-Peak attribution 和 Subagent
override 是特殊执行的附加 context，不产生第二份模型绑定、Selection 或完整 Provider/Model Config。

协议的最终字段形状在实施时复用现有严格 schema 和 Request Auth Port 固定，但必须满足：

- 不携带 Provider/Model 静态事实；
- 不写入 Session Selection；
- 不进入 Personal Config、Registry View 或 Session 持久化；
- 不进入普通用户 busy queue、Guide 或 held queue；
- 不把 Secret、Ticket 明文写入日志、Telemetry 或 conversation event。

## 7. Session Selection 与 Active Model

闲时任务从不修改再恢复用户 Session Selection：

```text
Session Selection = 用户模型 U

闲时任务开始
├─ Session Selection 仍为 U
└─ Idle Loop Active Model = I

闲时任务结束
├─ Model I 生命周期结束
└─ Session Selection 仍为 U

下一条普通用户 Submission
└─ 根据 Session Selection U 创建新 Model
```

因此 M4 删除“保存 previous model -> 临时 setModel -> finally restore”的完整状态机。Active Model 是
当前 Loop 的唯一模型执行事实；Session Selection 只表达该 Session 后续普通主执行使用什么模型。

闲时派发只在 Session 当前可以 start-now 时接收。若遇到 busy race，Core 返回类型化 admission
rejection，Scheduler 稍后重新派发；闲时 Request Auth/Ticket 不进入普通 CommandInbox/FIFO。

运行中的用户补充输入继续进入现有普通队列。闲时 Turn terminal 后，队列项根据自己保存的普通
Submission 和用户 Session Selection 执行，不继承闲时 Provider、Request Auth、Ticket 或归因。

## 8. Compact、Subagent、Goal 与 Background

### 8.1 Compact

Automatic Compact 属于当前 Loop，直接使用当前 Active Model，包括相同的 Provider、Model Config、
Options 和请求期鉴权上下文。它不读取 Session Selection，也不接收 `TurnExecutionModel` 快照。

手动 Compact 是新的普通 Submission，继续根据该 Submission 的 ModelSelection 创建 Model。

### 8.2 Subagent

Subagent Selection 优先级保持：

```text
Core Server Submission override
        >
Subagent Profile Selection
        >
Parent Loop Active Selection
```

Selection 确定后，每个 Child 通过同一 Registry/ModelFactory 创建自己的 Model。Parent 与 Child 不共享
同一个可变 Model 对象。

闲时任务通过通用 Core Server override 把允许的 Foreground Child 固定到本轮 idle Selection，并把
本轮 Request Auth/Ticket context 传给 Child 的模型请求。这样 Explore、general-purpose 和 custom
Foreground Child 都使用相同的 idle Provider、model 和动态访问材料，不读取 Profile 中另一个
Provider。Background Child 在发出模型请求前由 Tool Policy fail-closed。

### 8.3 Goal 与 Background

普通 Background 任务在启动时取得自己的 Model，并在自己的生命周期内保持。它完成后唤醒的新主
Loop 使用届时的 Session Selection。Goal 的每次自动续轮同样是新的主 Loop，使用续轮发生时的
Session Selection；二者都不把自己的模型反向写入 Session Selection。

## 9. Permission / elicitation

闲时任务保持 D44：permission/elicitation 使用普通 Session 阻塞交互，同一个自动 Turn 在用户响应后
继续，仍使用 idle Active Model。

```text
Idle Turn
└─ permission / elicitation requested
       ├─ 普通 Session 展示并收集响应
       ├─ Off-Peak task 保持 running
       └─ approve / deny / skip
              └─ 同一个 Turn 继续，仍使用 Idle Model
```

M4 不增加 `awaiting_approval` 闲时状态，不在批准后切用户 Provider，不建立 mid-turn Provider handoff。
只有当前自动 Turn 结束后，后续普通用户 Submission 才使用用户 Session Selection。

## 10. Ticket 过期、取消和重新派发

Ticket、任务排队、续跑和 settle 属于 Off-Peak Scheduler/Repo，不进入 Provider Config 或 Registry：

```text
Idle Model Request
      |
      v
Ticket 过期 / 当前派发失效
      |
      v
当前自动 Turn 结束
      |
      v
Scheduler 保留 Task、Session 与 transcript
      |
      v
重新取得 Ticket 并派发新的 Core Submission
      |
      v
Registry / ModelFactory 创建新的 Idle Model
```

成功、失败、取消、抢占、Ticket 过期或进程重启后，旧 Request Auth 不能进入下一次重新派发。
具体取票、重排、3 小时时间盒和 continuation 仍使用当前 Off-Peak 领域实现。

## 11. Registry 与 Facade

M4 后只有一份完整 Registry：

```text
Effective Provider / Model Config
             |
             v
       Provider Registry
       ├─ visible Provider
       └─ hidden Provider
             |
             +--> Settings Facade：只投影 visible
             +--> Selection Facade：只投影 visible
             `--> 内部精确 lookup / create：visible、hidden 共用
```

Visibility 过滤属于 Facade，不改变 Registry 成员和 ModelFactory。不存在特殊 Model 创建接口、Execution
Registry、execution-scoped Provider Source 或临时 Registry 注入。

## 12. Adapter 与归因

`request-auth` Model 在每次真正请求前从本轮作用域的 Request Auth Source 取得动态鉴权材料，并与 Provider Config 中的静态
Header 合并。缺少材料时在网络请求前失败；Retry 只能在当前有效执行上下文内继续使用或刷新材料。

Usage、Trace 和错误必须归因到实际 Model：

```text
providerId = builtin:offpeak-idle-plan
modelId    = 本轮实际 idle model
```

`offPeakTaskId`、Ticket ID 和 run type 是任务/执行维度，不替代 Model 身份，也不能把用户队列项归因到
闲时 Provider。

## 13. 状态所有权

| 状态或事实                    | 权威 Owner                                            | 生命周期           | 不得写入                                      |
| ----------------------------- | ----------------------------------------------------- | ------------------ | --------------------------------------------- |
| Provider 静态事实             | Effective Provider Config                             | Config revision    | Turn payload 的静态快照                       |
| Model 静态事实                | Effective Model Config                                | Config revision    | Host hardcode、modelId 特判                   |
| 用户后续主模型                | Session Selection                                     | Session            | 闲时执行 context                              |
| 当前执行模型                  | Loop Active Model                                     | Loop               | Session 持久偏好                              |
| Account 连接身份              | Account Provider Config `accessId`                    | Account connection | API Key/JWT/Header                            |
| Account 动态凭据              | Account Request Auth Service                          | Request attempt    | Provider Config                               |
| 闲时动态凭据与 Ticket         | Off-Peak Scheduler / Request Auth context             | 有效派发           | Config、Registry View、Session snapshot、日志 |
| Queue、Ticket、任务与续跑状态 | CLI CommandInbox / Off-Peak Scheduler / Off-Peak Repo | 各自领域生命周期   | Registry                                      |

## 14. UI Surface Matrix

| 场景                      | 候选/配置来源                         | 可见性与校验                      | 提交/执行 Owner              | 必须隔离                              |
| ------------------------- | ------------------------------------- | --------------------------------- | ---------------------------- | ------------------------------------- |
| Provider Settings         | Settings Facade                       | 只显示 `visibility=visible`       | Personal Config Repository   | hidden Provider、Session Selection    |
| Conversation Model Picker | Selection Facade                      | 只显示完整、enabled、visible 模型 | Composer/Submission          | hidden Provider、Active Model         |
| Off-Peak 创建页           | Built-in idle Provider 的产品投影     | 产品灰度；不成为 Registry 事实源  | Off-Peak Service/Scheduler   | Personal Config、普通模型选择器       |
| Off-Peak 自动 Turn        | 精确 idle ModelSelection              | Core start-now admission          | CLI Loop Active Model        | Session Selection、普通 Queue         |
| Subagent 设置             | visible Registry candidates / Profile | 保存 Profile，不改变当前 Session  | Subagent Config/Markdown     | Off-Peak 单轮 override                |
| Off-Peak Foreground Child | 当前 idle override                    | Background 由 Tool Policy 拒绝    | Child Runtime / ModelFactory | Profile 的其他 Provider、Session 状态 |

## 15. 必须保持的不变量

- Provider Overlay 始终是 Built-in -> Account -> Personal。
- Model Rules 始终是 Built-in + Personal，并作用于 Effective Provider。
- `visibility` 只影响用户 View，不改变完整性、Access 或 ModelFactory。
- 所有 Provider 都必须具备自己的完整 Access、API、Endpoint、models 和 Model Config。
- `request-auth` 缺少请求期凭据时必须在网络前失败。
- 闲时任务从不修改再恢复 Session Selection。
- Automatic Compact 使用当前 Loop Active Model。
- 每个 Subagent 创建自己的 Model；闲时 Foreground Child 使用通用 override。
- Permission approve/deny 后同一个闲时 Turn 继续使用 idle Model。
- 用户 busy 输入进入唯一 CLI Queue，并在闲时 Turn 结束后使用自己的普通 Submission。
- Provider 重构不改变 desktop continuous、web remote replayable 或 workspace identity 语义。

## 16. 需要删除的旧生产结构

M4 完成时通过 `dep:refs`、`rg` 和 `knip` 审计以下闲时用途：

- `ProviderConfig.executionOnly`；
- `sendText.turnRuntimeModel`；
- 闲时用途的完整 `ZCodeModelRuntimeConfig`；
- `buildOffPeakTurnRuntimeModel`；
- `TurnExecutionModel`；
- `ExecutionScopedModelSource` / `createTurnExecutionModelSource`；
- Turn Runtime Model Overlay；
- 临时 Provider Registry 投影与替换；
- `applyTurnRuntimeModel` / `clearTurnRuntimeModel`；
- `previousModel`、临时 `setModel` 和 restore `finally`；
- Compact/Subagent 对旧 Turn 快照的读取；
- Host 对 Endpoint、properties、reasoning 和模型限制的重复拼装。

若旧公共类型还有非闲时消费者，先证明每个消费者的语义并迁移，不能只按类型名批量删除。

## 17. 实施顺序

### M4.1：Config、Visibility 与 Access

1. 先写失败测试。
2. `executionOnly` 迁移为 `visibility`，Facade 负责 visible/hidden 过滤。
3. 新增 `request-auth` Access 及完整性校验。
4. 补齐 `builtin:offpeak-idle-plan` 的 Access、Endpoint、models 和 Built-in Model Rules。
5. Registry 收录完整 hidden Provider，普通 Settings/Selection View 不投影。

### M4.2：标准 Model 创建与请求鉴权

1. 内部闲时调用按精确 Selection 使用现有 Registry lookup/ModelFactory。
2. Model/Adapter 支持调用级 Request Auth。
3. 缺少 Request Auth 返回类型化错误；动态材料不进入 Config 或 Registry。
4. generate/stream、Retry、Usage 和 Trace 使用同一 Adapter 边界。

### M4.3：切换闲时生产派发

1. Host 不再构造 `turnRuntimeModel`。
2. Core Submission 携带标准 Selection 与最小执行 context。
3. CLI admission 直接创建 Idle Active Model，不临时 `setModel`。
4. Automatic Compact、Foreground Subagent 和 permission continuation 使用正式 Active Model/Selection。
5. Ticket 过期、取消、失败和成功沿现有 Off-Peak 状态机结束当前执行 context。

### M4.4：删除双轨

1. 删除 Runtime Overlay、Turn 快照、临时 Registry 注入和 restore 状态机。
2. 删除 Host 对 Provider/Model 静态事实的重复组装。
3. 用引用审计确认没有生产消费者从旧 Runtime Model 读取事实。
4. 更新 Design、Feature Graph、Off-Peak/Subagent spec 和测试矩阵。

## 18. 验收用例

| Case  | Setup                                | Action                            | Assertions                                                      | 证据层            |
| ----- | ------------------------------------ | --------------------------------- | --------------------------------------------------------------- | ----------------- |
| M4-01 | hidden idle Provider 配置完整        | 读取 Settings/Selection/Registry  | 两个用户 View 不包含 idle；Registry 可精确 lookup               | domain unit       |
| M4-02 | `request-auth` Provider 无调用级凭据 | generate/stream                   | 网络前返回类型化鉴权缺失；无请求发出                            | adapter unit      |
| M4-03 | 闲时 Session 的用户 Selection=U      | 派发 idle Selection=I             | Active Model=I；Session Selection 仍为 U                        | protocol/runtime  |
| M4-04 | 闲时 Turn running                    | 用户发送普通 prompt               | 输入进入唯一 Queue；terminal 后使用 U                           | protocol/network  |
| M4-05 | 闲时 Turn 触发 Automatic Compact     | Compact 请求                      | 请求使用 I、idle Endpoint 与当前 Request Auth                   | runtime/network   |
| M4-06 | Profiles 配置其他模型                | 闲时父轮启动多个 Foreground Child | Child 各自创建 Model，但都使用 idle override；Background 无请求 | runtime/network   |
| M4-07 | 闲时 Turn 请求 permission            | approve / deny                    | Off-Peak task 保持 running；同一 Turn 仍命中 idle Endpoint      | protocol/network  |
| M4-08 | 当前 Ticket 失效                     | Scheduler 重新取票并 resume       | 新派发、新 Model、新动态材料；Session/transcript 延续           | service/runtime   |
| M4-09 | 闲时 Turn 结束                       | 用户继续普通对话                  | 使用 U；无 idle Header、Ticket 或归因泄漏                       | network/telemetry |

不对主题、语言、操作系统、Provider family、workspace 类型和 delivery kind 做全笛卡尔积。M4 的共享
Core/Adapter 行为由 focused tests 证明；Desktop continuous 使用现有 Off-Peak 代表 E2E，Mobile
replayable 只验证协议字段没有进入恢复状态，不新增闲时移动端产品能力。

## 19. 完成门禁

M4 只有同时满足以下条件才完成：

1. 闲时 Provider/Model 静态事实只从 Effective Config/Rules 进入执行。
2. Hidden 只是用户可见性，不再绕过 Config 完整性和 Access。
3. 闲时 Model 通过标准 Registry/ModelFactory 创建。
4. 闲时 Request Auth/Ticket 不进入 Config、Registry View 或 Session 持久化。
5. 闲时任务不修改、不恢复 Session Selection。
6. Compact、Subagent 和 permission 保持本篇规定的继承语义。
7. `turnRuntimeModel`、Runtime Overlay、Turn 快照和 restore 生产链物理退出。
8. Usage、Trace 和错误归因到实际 Model。
9. 相关单测、`pnpm typecheck`、`pnpm lint`、`pnpm fmt:check` 和受影响 E2E 通过。

## 20. 明确排除

- Remote Provisioning、远程设置、远端登录和跨 Environment 配置同步产品；
- Account Provider 身份、权益和套餐拓扑重构；
- Management Service 下发 Built-in Config；
- `modelContextBudget.strategy`；
- Off-Peak UI 重做；
- Queue、snapshot、reconnect、continuous/replayable 产品语义变化；
- Audio 内容块、附件入口或 Provider 编码。

## 21. Impact Brief

### 21.1 Feature Summary

| Field            | Value                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------ |
| Developer intent | 删除闲时 Runtime Model 双轨，使特殊执行复用正式 Provider/Model 链                          |
| Capability       | Provider Registry、Model execution、Off-Peak、Subagent                                     |
| Change layer     | option-source、validation、commit-effect、persistence、recovery invariant                  |
| Operating mode   | implementation                                                                             |
| Primary seeds    | `ProviderConfigResolver`、`buildOffPeakRequestAuth`、`sessionFlowHandlers`、`agentHandler` |
| Out of scope     | Remote Provisioning、Account 产品重构、普通 Queue/恢复语义、Agent 参数灰度                 |

### 21.2 Shared And Divergent Behavior

| Concern         | Shared across surfaces                          | Deliberately different                      | Why it matters                  |
| --------------- | ----------------------------------------------- | ------------------------------------------- | ------------------------------- |
| Option source   | 所有 Model 都来自同一 Registry/ModelFactory     | hidden Provider 不进入用户 Facade           | 避免第二套执行 Registry         |
| Validation      | 所有 Provider 都做完整性与 Adapter 校验         | `request-auth` 额外要求调用级凭据           | 可见性不能成为鉴权豁免          |
| Commit effect   | 所有 Loop 都持有 Active Model                   | 闲时 start-now 不写 Session Selection       | 删除 set/restore 状态机         |
| Child execution | 每个 Child 自行创建 Model                       | 闲时前台 Child 强制 idle override，后台拒绝 | 防止凭据和 Provider 越界        |
| Persistence     | Config 保存静态事实，Session 保存普通 Selection | Ticket/Auth 只属于一次派发                  | Secret 和闲时模型不进入恢复状态 |

### 21.3 Feature Relationships

| Rank           | From                     | Semantic edge                  | To                      | Why inspect it                              | Evidence                                    |
| -------------- | ------------------------ | ------------------------------ | ----------------------- | ------------------------------------------- | ------------------------------------------- |
| must-inspect   | Off-Peak scheduler       | dispatches Selection + context | CLI admission           | 当前 Host 构造完整 Runtime Model，M4 要删除 | `offPeakRuntimeModel.ts`、`session-flow.ts` |
| must-inspect   | hidden Built-in Provider | creates through                | Registry/ModelFactory   | 可见性只属于 Facade                         | Registry Design §§3、11                     |
| must-inspect   | idle Active Model        | inherited by                   | Automatic Compact       | Compact 不能回退 Session Selection          | Execution Design §8.1                       |
| must-inspect   | idle execution context   | overrides                      | Foreground Child        | Child 自建 Model 但共享本轮访问边界         | OP10、Execution Design §8.2                 |
| must-inspect   | permission response      | continues                      | same idle Turn          | D44 禁止 Provider handoff                   | OP03、Execution Design §9                   |
| should-inspect | Request Auth             | validates before               | Adapter network I/O     | 缺凭据必须 fail-closed                      | Model Creation Design                       |
| invariant-only | M4                       | must not mutate                | desktop/mobile delivery | 不改变 continuous/replayable                | AGENTS、Feature Graph                       |
| invariant-only | M4                       | must not own                   | Remote Provisioning     | 远程配置同步是独立产品能力                  | Environment Design                          |

### 21.4 Code Evidence And Graph Drift

当前工具集没有可调用的 codegraph，因此本轮以功能图已声明 seed、`rg` 精确引用和深度 2 的人工调用链
核对替代；完成门禁使用 `dep:refs`、`knip` 和受影响测试补齐符号级删除证明。

| Seed                      | Key path                                                      | Depth | Interpretation                          |
| ------------------------- | ------------------------------------------------------------- | ----- | --------------------------------------- |
| `buildOffPeakRequestAuth` | Desktop Host → `sendText.modelExecution` → Model dependencies | 2     | 只提供当前派发的动态鉴权材料            |
| `sessionFlowHandlers`     | admission → Core Submission → Active Model                    | 2     | 单次执行 Selection 不改 Session         |
| `agentHandler`            | override → Child runtime → child ModelFactory                 | 2     | 普通 override 与 idle override 的汇合点 |
| `ProviderConfigResolver`  | Built-in → Account → Personal → Registry                      | 2     | M4 静态事实的唯一来源                   |

| Candidate                                            | Live-code evidence                          | Graph action                                                                  |
| ---------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| Feature Graph 旧 code seed 指向已删除双轨            | M4 已删除旧 Builder 与 Source               | 已改为 Request Auth、派发、Submission 与 Registry Model Runtime 的 live seeds |
| Provider Registry 不变量把最终授权写成 model service | Config 只装配访问材料，最终结果由服务端裁决 | 已改为 server                                                                 |
| OP03 仍记录批准后切用户 Provider                     | Off-Peak spec D44 与用户裁决相反            | 已同步 case catalog 与 coverage matrix                                        |

未解决且会改变 M4 范围的问题：无。协议字段的物理名称、类型化错误枚举与 Request Auth Port 方法签名属于
实现细节，必须服从本篇不变量，不构成新的产品裁决。

## 22. Planning Handoff

### 22.1 Boundary Decisions

| Boundary            | Decision                                  | Includes                       | Excludes / prunes                     | Source            |
| ------------------- | ----------------------------------------- | ------------------------------ | ------------------------------------- | ----------------- |
| Provider visibility | `visible/hidden` 通用可见性               | Settings/Selection Facade 过滤 | 权限、受信、完整性豁免                | 用户裁决          |
| Access              | `request-auth` 请求级动态鉴权             | 网络前缺失校验、Retry 生命周期 | Secret 持久化、Account 同步           | 用户裁决 + Design |
| Idle selection      | 一份标准 ModelSelection                   | 同 Registry/Factory/Model      | 第二份模型绑定、Selection 或 Registry | 用户裁决          |
| Session state       | 闲时不写也不恢复                          | 普通 Session Selection 保持    | 临时 setModel/finally restore         | 用户裁决          |
| Permission          | 同一闲时 Turn 继续                        | approve/deny/skip              | Provider handoff、专用 awaiting 状态  | D44               |
| Child               | Foreground idle override，Background 拒绝 | 每个 Child 自建 Model          | 共享父 Model、Profile 逃逸            | OP10              |

### 22.2 Dimensions And Pruning

| Dimension                                          | Included classes                    | Pruning reason                                  |
| -------------------------------------------------- | ----------------------------------- | ----------------------------------------------- |
| visibility                                         | visible / hidden                    | 只验证 Facade 与 Registry 差异，不展开主题/语言 |
| request auth                                       | present / absent / expired          | 影响是否发出请求                                |
| admission                                          | idle / busy race                    | busy 直接拒绝，不展开普通 Queue 排列            |
| child                                              | foreground / background             | 改变模型权威和凭据生命周期                      |
| permission                                         | approve / deny / skip               | 三者都必须保持同一闲时 Turn                     |
| delivery                                           | desktop continuous / web replayable | 只做隔离证明；不新增移动端闲时产品能力          |
| provider family、workspace kind、OS、theme、locale | 不展开                              | 不改变共享 Core/Adapter 语义                    |

Accepted cases 固定为 M4-01 至 M4-09；case catalog 的 OP03、OP10 和 coverage matrix 已同步。E2E 交接继续
复用 Off-Peak mock gateway：OPA 证明 permission 后仍命中 idle endpoint，OPS 证明前台 Child 继承与
后台拒绝，OPB 证明普通用户输入和终态后对话不继承闲时 Provider/Auth/归因。其余 Config、Registry、
Request Auth 和 Adapter 行为由 focused unit/runtime/network tests 证明。

## 23. 实施结果

### 23.1 最终命令边界

Host 派发的模型相关字段已经收口为一份标准 Selection 和一份窄执行上下文：

```text
sendText
├─ modelSelection
│  ├─ providerId
│  ├─ modelId
│  └─ options
└─ modelExecution
   ├─ selectionScope = execution
   ├─ requestAuth
   │  ├─ apiKey?
   │  └─ headers?
   └─ subagents
      ├─ foregroundModel = submission
      └─ background = deny
```

严格协议拒绝在 `modelExecution` 中携带 Endpoint、Provider Config、Model Config 或 properties。
`modelExecution` 只允许 idle Session 的 start-now admission，不进入 busy Queue、Guide 或 held Queue。

### 23.2 标准执行链

```text
Host idle ModelSelection + Request Auth
                    |
                    v
             Core Submission
                    |
                    v
       Provider Registry / ModelFactory
                    |
                    v
             Loop Active Model
              /           \
             v             v
   Automatic Compact   Foreground Child
                         |
                         v
                  Child ModelFactory
```

Execution-scoped Submission 不执行 Session 模型预检，不读取或修复 Session restore warning；它由自己的
精确 Selection 在标准 Registry/ModelFactory 中完成校验。普通 Submission 仍保留原 Session 模型预检。

### 23.3 已删除双轨

以下生产结构及其专用测试已经删除：

- `turnRuntimeModel` 与 `ZCodeModelRuntimeConfig` 单轮快照；
- `TurnExecutionModel`；
- `ExecutionScopedModelSource`；
- `runtime-model-factory.ts`；
- `turn-model-overlay.ts` 与 `turn-execution-model-source.ts`；
- Session Facade / V4 Bridge 的 apply、clear、set/restore 接口；
- Compact、Subagent 和 Host 对旧快照的读取与静态模型事实拼装。

### 23.4 Mock 与凭据边界

`ZCODE_OFFPEAK_MOCK=1` 的 Desktop E2E 会从正式 `official.json` 派生一份测试 Official Config，只改写
`builtin:offpeak-idle-plan.api.baseURL` 指向进程内 mock gateway，再通过 Official Config Source 路径注入 Host 和
Worker。Mock Endpoint 因此仍属于测试 Config，不回到单次 Turn payload。

命令账本只持久化普通 input intent、附件和 Selection；`requestAuth` 不进入 input ledger、conversation
event、Session snapshot 或 repo sidecar。生产日志只记录命令生命周期、ID 和长度，不记录鉴权材料。

### 23.5 验证结果

2026-08-24 完成以下验证：

- `pnpm typecheck` 通过；Desktop Host、E2E 类型与 CLI Contracts/Core/Bootstrap 构建均通过；
- `pnpm lint` 通过，仓库保留 39 条与 M4 无关的既有 warning，新增 0 error；
- M4 focused tests：根仓 5 files / 135 tests、CLI 7 files / 109 tests 全部通过；此前 Compact
  7 files / 168 tests、Registry/Adapter 2 files / 19 tests 也已通过；
- `test:unit:affected` 因 staging 基线包含已删除文件而自动升级为全量单测：1454 files 中 1445
  passed，12,298 tests passed；唯一 M4 相关失败是 M2 守卫仍许可旧 Overlay，守卫收紧后已单独复跑通过。
  其余 30 条是当前 Linux 环境缺 `zip`、macOS 公证/CUA 原生 fixture 不匹配等基线失败；
- 全仓 `fmt:check` 仍会被既有 vendored Electron HTML 与 GB2312 fixture 阻断；本次 65 个变更文件的
  `oxfmt --check` 全部通过，`git diff --check` 通过；
- `dep:refs` 已确认 `buildOffPeakRequestAuth`、`ApiProviderModelRuntime` 和
  `applySubmissionExecutionState` 的 live references；旧双轨生产符号搜索为零。全仓 `knip` 与 Feature
  Graph 完整性检查仍有本轮之外的既有漂移，M4 节点自身全部可解析。
- 最终封口复验覆盖 Adapter、Core lifecycle、Bootstrap、Provider Selection、Services 与 Desktop Bundle
  共 10 files / 189 tests；`typecheck:e2e`、OP10 fixture 检查和本次变更文件格式检查均通过。

OP10 代表性 Desktop E2E 已在隔离 Xvfb 图形环境实际执行通过（1 spec / 1 test，26.5 秒；artifact：
`packages/desktop/.e2e-artifacts/desktop-e2e-20260824-074156-374`）。该用例通过闲时 mock gateway 与
DeepSeek replay 网络代理共同证明：父回合和 foreground Child 使用同一 idle Selection 与请求鉴权，
background Child 被拒绝，闲时完成后同一 Session 的普通 Prompt 恢复用户配置的 DeepSeek Model，且
真实请求到达网络代理。

验收过程中另外发现并修正了三个集成边界：

- Protocol Agent 与 CLI/TUI 一样读取 Environment 级 Model Selection Config；显式 configured default
  可以引用 hidden Provider，只有无显式选择时的用户 fallback 跳过 hidden 候选；
- Desktop main/host/scheduler bundle 内联 `@zcode/provider` 与 `@zcode/provider-node`，避免 Electron
  worker 在干净运行环境中从 TypeScript source export 解析不存在的 `.js` 文件；
- Adapter 只有在 Active Model 绑定 `accountAccessId` 时才消费 Host 的账号 runtime-header Port；普通
  API-key Model 直接使用 Provider Config 的静态访问材料，`request-auth` Model 使用创建时冻结的
  request auth source。

复现命令：

```text
ZCODE_E2E_CONTAINER=1 \
ZCODE_E2E_SPEC=./test/e2e/conversation-session/manual-review/pending/\
conversation-session-offpeak-subagent-model-inheritance.test.ts \
pnpm --filter @zcode/desktop test:e2e:serial
```
