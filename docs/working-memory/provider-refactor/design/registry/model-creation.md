# Model 创建与请求鉴权

Model 创建只有一条公共链路：

```text
ModelSelection
      |
      v
当前 Agent Registry lookup + validation
      |
      v
ProviderConfig + ModelConfig + ModelOptions
      |
      v
ModelFactory
      |
      v
Model
```

普通会话、设置页连通性测试、Subagent、Compact、Goal、Background、Repo Wiki 和闲时任务都使用这条
链。Visibility 只影响用户 Facade，不产生第二个 Registry、ModelFactory 或 execution-only create API。

## ModelSelection

```ts
interface ModelSelection {
  providerId: string;
  modelId: string;
  options?: {
    reasoningLevel?: string;
  };
}
```

Selection 不携带 Endpoint、Access Secret、Provider Config、Model Config、Adapter 类型或模型能力。
Registry 根据 `providerId + modelId` 查找当前 Effective Config，并按 Option Specs 校验 options。

Selection 中的 options 是选择事实，不是 Provider/Model Config 快照：

- 正式 Selection 必须携带合法 `reasoningLevel`；创建全新缺省选择时，只允许 Host Initial Selection Resolver 按 `values.at(-1)` 补全一次；
- `maxOutputTokens` 不属于 Selection；Agent/调用方根据模型的 `optionSpecs.maxOutputTokens.max` 与当前任务预算，为每个 Model Request 显式决定；
- `options: {}` 归一化为字段缺失，正式 Selection 不保存 `null`；patch 的 `null` 只表达删除覆盖；
- ModelFactory 只校验和冻结，不从 Option Spec 补执行默认值，也不反写 Selection 或任意产品 record。

历史运行需要记录实际值时使用 Model/execution facts；不能用后来变化的 Option Spec 重新解释旧 Selection。

Registry lookup 同时执行 Model Config `enabled` 门禁。`enabled=false` 的模型仍可在 Settings 中编辑和重新
启用，但不能进入普通候选、默认/fallback 选择，也不能通过内部精确 ID 创建 Model。Visibility 只控制用户
界面暴露范围，不绕过 enabled。

只有 Provider 具有 `visibility`，缺省为 `visible`。用户入口使用 Selection Facade，只能选择 visible Provider
中的 executable Model；内部产品能力可以按精确 ID 使用 Registry 中 hidden Provider 的 enabled Model。这个差异是
候选 View 的差异，不是鉴权或安全边界。

## ModelFactory 输入

运行时 `ModelFactory` 接收 `ModelSelection`，并在真正创建 Model 前向当前 Agent Registry 做最终完整
校验。校验通过后，内部装配层再把已经查好的完整输入交给 Adapter；Adapter 不反向查询 Registry：

```ts
interface AdapterModelFactoryInput {
  providerId: string;
  modelId: string;
  providerConfig: RegistryProviderConfig;
  modelConfig: RegistryModelConfig;
  options: Pick<ModelOptions, "reasoningLevel">;
  requestDependencies: ModelRequestDependencies;
}
```

用户 `ModelSelectionFacade` 只提供 visible candidates，不暴露执行校验方法。内部产品可以在保存或派发前
使用具体 Service 的窄 Registry 检查，但不能替代 ModelFactory 的最终校验。

`RegistryProviderConfig` / `RegistryModelConfig` 是同一个 Effective Config 通过唯一完整性边界后的静态
收窄结果；Factory 不接受稀疏 Overlay Config，也不在 Bootstrap/Adapter 中再次补字段或证明完整性。

`ModelRequestDependencies` 包含进程级网络/签名 Service，也允许装配本次执行作用域的 Request Auth
Source。Source 是 Model 的执行依赖，不是 Config、Selection 或新的 Model 类型；Model 在每个 request
attempt 上向它取当前材料。普通公共 `ModelRequest` 不增加凭据字段。

这样 Factory 可以在测试、不同 Entry 和同一 Registry 的 visible/hidden Provider 间复用。Registry 更新后
只影响后续输入；已经创建的 Model 持有旧 Config、Options 和执行资源，继续完成当前生命周期。

## Provider Config 到执行装配

ModelFactory 把 Registry 中同一个完整 Provider/Model Config 引用直接交给 Adapter；Bootstrap 不复制
Provider map，也不先编译同形执行 DTO：

```text
RegistryProviderConfig + RegistryModelConfig
          |
          | same complete objects
          v
Adapter private execution closure
├─ SDK kind / factory
├─ baseURL / static headers
├─ api static credential
├─ signing / network infrastructure
└─ model factory cache
```

私有执行闭包没有独立 Source，不参与 Config Overlay、模型选择、Visibility 或 Model Properties 解析。
Adapter 只持有进程级网络、签名、路由、重试等执行基础设施；它不持有 Provider 列表，也不存在可供业务
调用方更新的 `replaceRegistryConfig()`。

## Access 类型

### api-key

```text
Personal/Built-in Provider Config
└─ access.type = api-key
   └─ apiKey
        |
        v
ModelFactory / Adapter
        |
        v
Provider Request
```

API Key 是静态 Config 字段。缺少 Key 的 Effective Provider 不完整，不进入 Registry。Settings 可以展示
问题并补齐；测试连接使用保存后的正式 Model。

### zhipu-account

```text
ZCode Built-in Provider Config
└─ access.type = zhipu-account
   └─ family + mode
        |
        v
ModelFactory 固定静态账号访问类别
        |
        v
每个 request attempt
        |
        v
Account Request Auth Service(current compatible connection)
        |
        v
ModelRequestAuth { apiKey, headers }
```

Access 显式保存调用装配所需的 Family 和 Mode。账号身份、商品和 Team scope 由 Account Connection
Service 拥有；每个 attempt 根据静态类别解析当前兼容连接。切换到不兼容的 Family/Plan 或退出账号时在
网络前失败；同一 Family/Plan 的当前连接和刷新后的凭据可以被旧 Active Model 使用。

Start Plan、Individual Coding Plan 和 Team Plan 可以共享 Account Provider 基础设施，但分别对应固定类型
的独立 Built-in Provider。Account Built-in Overlay 只为当前账号投影 `access.entitled`。Account Service
决定如何取得请求材料；服务端决定最终是否授权。

Provider 顶层不存在 `enabled`；账号套餐资格通过 `zhipu-account.entitled` 表达。Start Plan 还可以用账号接口返回的
非空 `builtinModelIds` 约束成员；Individual/Team 继承 Built-in 成员。任何这类
Account Overlay 必须与产生它的 ZCode Built-in revision 匹配后，才允许 Registry 创建后续 Model。

### Off-Peak 请求期材料

```text
Provider Config
└─ access.type = zhipu-account
   └─ mode = off-peak
        |
        v
ModelFactory 创建普通 Model
        |
        v
每个 Model request attempt
        |
        v
ModelRequestDependencies.requestAuth.resolve()
        |
        +-- Request Auth present -> Adapter request
        `-- missing              -> typed auth error before network
```

Off-Peak 不保存 Secret。它的动态材料由本次闲时执行在 Model 创建时装配，而普通
`zhipu-account` Mode 由 Account Request Auth Service 在调用时解析。

Request Auth 是执行作用域内、按 request attempt 读取的依赖：

- 不进入 ProviderConfig、ModelConfig 或 Registry View；
- 不进入 Session Selection、App Recent 或 Personal Config；
- 不进入 conversation event、snapshot 或日志；
- Retry 只能在当前有效调用/执行上下文内复用或刷新；
- 缺少、过期或无法解析时在网络前失败。

## 静态与动态 Header

```text
ProviderConfig.api.headers          -> static headers
Account / Off-Peak request source   -> dynamic auth headers
ModelRequest / Adapter options      -> protocol request fields
```

Adapter 按固定优先级合并并保护鉴权字段。Renderer、Core 业务逻辑和 Model Config Rules 不拼 JWT、Ticket、
一次性安全校验、organization/project 或 Provider 方言 Header。

## 闲时任务

`account:zai-offpeak-idle-plan` 与 `account:bigmodel-offpeak-idle-plan` 是两个完整的 ZCode Built-in Provider；
Scheduler 按当前账号 Family 精确选择其中一个，Provider 本身不在执行期切换 Family：

```text
ProviderConfig
├─ visibility = hidden
├─ access.type = zhipu-account
├─ access.mode = off-peak
├─ api.type
├─ api.baseURL
├─ static headers（如有）
└─ builtinModelIds

Model Config Rules
└─ properties / optionSpecs（含 per-option raw-body map）
```

Host/Scheduler 派发普通 ModelSelection，并为本次自动 Turn 提供 Request Auth、Ticket 和必要归因。它不
携带 Provider/Model 静态快照，也不建立临时 Provider Source：

```text
Core Submission
├─ idle ModelSelection
└─ execution context
   ├─ Request Auth
   ├─ Off-Peak Ticket
   └─ optional Subagent override
            |
            v
Registry lookup + ModelFactory
            | 装配本轮 requestAuth source
            |
            v
Idle Active Model
```

Request Auth/Ticket 只对当前有效派发生效。Ticket 过期、取消、失败、成功、抢占或进程重启后，Scheduler
结束当前执行上下文；重新取票后用新的 Submission 创建新 Model。任务排队、续跑和 settle 不属于
Provider/Registry。

## Active Model

ModelFactory 返回的 Model 是不可变执行对象：

```text
Model
├─ fixed providerId / modelId
├─ fixed ProviderConfig / ModelConfig
├─ fixed Selection/Binding Options
├─ fixed account family / mode（若适用）
└─ request-time dependency ports
```

普通 Config 更新、Composer 选择变化或账号全局切换不修改旧 Model。Guide 在明确 Step 边界创建并切换
新的 Active Model；已经发出的请求继续由旧 Model 完成。

闲时任务创建自己的 Loop Active Model，但不写 Session Selection。Automatic Compact 使用当前 Active
Model；Subagent 按最终 Selection 创建自己的 Model。

## Subagent

```text
Core Server override
        >
Subagent Profile Selection
        >
Parent Active Selection
        |
        v
Registry / ModelFactory
        |
        v
Child-owned Model
```

每个 Child 拥有自己的 Model，不借用父级可变对象。闲时任务通过通用 override 固定 Foreground Child
的 idle Selection，并把当前 Request Auth/Ticket context 传到 Child request；Background 由 Tool Policy
在模型请求前拒绝。

## Adapter

Adapter 只负责 Provider 协议和 IO：

```text
ModelRequest
      |
      v
Adapter
├─ API Schema serialization
├─ reasoning parameters
├─ input media validation/encoding
├─ request auth resolution
├─ retry / stream handling
└─ error normalization
```

Core 不理解 `reasoning_effort`、`enable_thinking`、`thinkingBudget` 或具体 Header 名；Model Config Rules
给出公共 Options 到 Adapter 参数的映射。输入输出格式直接读取 Model.properties，不按 modelId 推断。

## Usage、Trace 与错误

每次请求记录实际 Model 身份：

```text
providerId
modelId
effective options
request source / task attribution
usage
error
```

Off-Peak taskId、Goal、Compact、Subagent 和 Repo Wiki 是执行来源维度，不替代 Provider/Model 归因。Retry
不能把一次请求归因到另一个 Model；如果产品明确切换 Model，必须创建新 Model 和新的执行边界。

## 错误边界

| 阶段            | 典型错误                                    |
| --------------- | ------------------------------------------- |
| Config parse    | schema/unknown field                        |
| completeness    | access/api/baseURL/models/model config 缺失 |
| Selection       | provider/model/options 不存在或非法         |
| ModelFactory    | Adapter/执行依赖无法装配                    |
| request auth    | Account Access 无效、Request Auth 缺失/过期 |
| Adapter/network | 鉴权拒绝、限流、服务错误、协议解析、流中断  |

每层只报告自己的错误，不使用旧 Runtime Snapshot、Catalog 或默认 Provider 静默兜底。

## 不变量

- 所有 Model 都通过同一 Registry/ModelFactory 链创建。
- Visibility 只影响用户 Facade。
- Hidden Provider 仍使用普通完整性和 Access 校验。
- Disabled Model 不进入候选、fallback 或 ModelFactory 创建；内部精确 lookup 也不能绕过。
- Adapter 私有 Factory 不反向查询 Registry；运行时 ModelFactory 必须在创建边界查询当前 Agent Registry 并
  完整校验 Selection。
- Config 更新不热改已创建 Model。
- API Key 可以由 Config 保存；Account 和 Off-Peak 动态材料在请求期取得。
- Account Provider 固定 `family + mode`；当前账号、商品和 Team scope 不进入 Model。
- Request Auth 缺失必须在网络前失败。
- Submission 不携带完整 ProviderConfig 或 ModelConfig。
- Adapter 执行投影没有独立事实源。
- Usage、Trace 和错误归因到实际 Model。
