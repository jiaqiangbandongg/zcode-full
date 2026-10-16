# Provider 配置与 Registry

> 状态：当前有效设计
>
> 最近更新：2026-08-26

Provider Registry 回答两个问题：当前 Environment 有哪些完整 Provider/Model，以及给定一个
ModelSelection 时能否定位并校验对应的完整配置。Model 的创建由 ModelFactory 负责。

```text
ZCode Built-in Provider Templates + Account Providers
              |
              v
Account Built-in Provider Config + Personal Provider Config
              |
              v
    Effective Provider Config ------------------+
                                                  |
ZCode Built-in Model Config Rules                |
              +                                  |
Personal Model Config Rules                      |
              |                                  |
              v                                  |
Effective Model Config Rules --------------------+
              |
              v
      Provider Registry
      ├─ ordered Provider / Model View
      ├─ lookup by providerId / modelId
      ├─ visible Settings / Selection projection
      └─ validate selection
              |
              v
         ModelFactory
              |
              v
         Active Model
```

Registry 管理静态、可重建的 Provider/Model View。Token、Ticket、一次性安全校验 Header、网络状态、余额、
限流和服务端最终授权在请求期处理，不进入 Registry。

## 输入来源

### ZCode Built-in Provider Config

ZCode 随产品提供的 Provider Template 与账号 Provider 声明。领域、代码和物理命名统一使用
`zcodeBuiltin*` / `zcode-builtin`；发布文件为 `config/provider/zcode-builtin.json`。`official` 不作为这条
Provider Config 链的别名，也不保留兼容入口。实施切换见
[`../../steps/todo-10-zcode-builtin-provider-config-naming-cutover.md`](../../steps/todo-10-zcode-builtin-provider-config-naming-cutover.md)。

### Account Built-in Provider Config

AccountProviderService 只读取 ZCode Built-in 中 `access.type = "zhipu-account"` 的 Provider，根据
当前账号、套餐和团队连接投影 Account Built-in Provider Config。它在 ZCode Built-in 之后、Personal 之前
参与 Overlay：

Provider Config Snapshot 必须分别携带 `zcodeBuiltinRevision` 与 `personalRevision`；Account Snapshot 必须
携带 `basedOnZCodeBuiltinRevision`。Registry 只有在二者相等时才能解析和发布：

```text
B0 + A0
   |
   | Built-in -> B1
   v
B1 + A0  -- 不发布，继续服务旧 Registry
   |
   | Account -> A1 basedOn B1
   v
B1 + A1  -- 原子发布
```

这个 revision 只证明客户端 Account Overlay 的派生来源，不要求 Account 服务端与 Built-in 发布接口共享
版本。Personal-only 更新不改变 `zcodeBuiltinRevision`，因此继续立即解析并发布。首次启动在正式 Account
Snapshot 到达前，进程可以基于当前 Built-in 生成同 revision、账号 Provider 全部 `access.entitled=false` 的初始
Overlay，以 fail-closed 方式完成 Registry ready；禁止 wildcard revision。

```text
ZCode Built-in account Provider
        +
current account connection
        +
entitlement result
        |
        v
Account Built-in Provider Config
├─ access.entitled（当前结构化选择与账号权益是否允许使用）
└─ builtinModelIds（接口确实提供时）
```

Account 不读取、约束或改写 Personal-only Provider，不提供模型 Properties、Reasoning、context 或
max output。Account Built-in Config 不保存账号 Token、Runtime Key 或 Header。Account Connection 是
上述连接字段的来源权威；Account Built-in Provider Config 则是 Provider 执行侧的结构化快照。

### Personal Provider Config

Personal 保存由 Template 创建或完全自定义的 Personal Provider，以及对 Account Provider 允许修改的最终覆盖。普通
API Provider 可以在这里保存 API Key。Personal 共享字段级 Overlay 语言；正常设置写入维护 `modelIds`，不提供修改
`builtinModelIds` 的交互。这是维护职责，不是 Source 字段权限系统。

### Model Config Rules

ZCode Built-in 和 Personal Model Config Rules 按数组顺序拼接，Personal 在后。Rules 只解析 Effective
Provider source-aware Inventory 中的成员，不会把模型加入或移出 Provider。跨集合重名时只保留 Built-in
身份；相同 `providerId/modelId` 的 Personal 专属 Rule仍是用户对该 Built-in Model 的正常 Overlay。

## 两轮解析

### 第一轮：Provider

```ts
const effectiveBuiltinProviders = zcodeBuiltinProviders.overlay(accountBuiltinProviders);
const effectiveProviders = resolveProviderTemplates(
  zcodeBuiltinProviderTemplates,
  effectiveBuiltinProviders,
  personalProviders,
);
```

Overlay 保留前层已有 key 的位置；后层同 key 逐字段覆盖；后层新增 key 按自身顺序追加。
模型成员按所有权组合，不对一个共享列表做 Overlay：

```text
ZCode Built-in builtinModelIds
      |
      v  Account Built-in 提供时整列表覆盖
Effective Built-in builtinModelIds
      |
      +------------------+
                         |
Personal modelIds -------+
                         |
                         v
             source-aware Model Inventory
```

Account Built-in 模型集合是该账号 Provider 当前允许使用的动态成员事实。Personal 仍可声明自己的
`modelIds`，服务端在真实请求时做最终鉴权和授权。

两个成员字段在 Config 中保持稀疏三态；生成 Inventory 时，最终缺失或 `null` 的集合归一化为空数组。
空成员集合合法。同一集合重复保留第一次；跨集合重复采用 Built-in-wins，只产生一个 Built-in 身份。
正常 Settings 禁止制造重复，保存相关 Provider 时会规范化重复和 stale 项。重复不会制造冲突 DTO，也不会
让整个 Provider 失效。

### 第二轮：Model

```ts
const effectiveModelRules = new ModelConfigRules([
  ...zcodeBuiltinModelRules.rules(),
  ...personalModelRules.rules(),
]);

for (const [providerId, provider] of effectiveProviders) {
  for (const entry of resolveModelInventory(provider)) {
    const modelId = entry.modelId;
    effectiveModelRules.resolve(providerId, modelId, provider.api?.type);
  }
}
```

最终 `api.type` 参与 Rule 匹配，因此 Personal 对 Provider API 的覆盖会改变最终 Option Map 和
原始 Request Body 字段。Renderer、Shared 工厂、协议和 Adapter 不按 modelId 写业务特判；需要按名称约定提供
缺省时，使用声明式 Built-in Rule。

## 完整性

Registry 在发布 Provider 前递归校验 Effective Provider Config 和每个 Effective Model Config。

Resolver 调用唯一完整类型创建入口，并复用其联合结果生成 Resolved/Settings 诊断或可执行 Registry
Value。失败候选可以留在 Settings 中修复，但不能进入 Registry；成功后下游不得再次把 Properties 或
Option Specs 视为 optional。完整类型只是校验结果的类型表达，不是新的配置层、持久化对象或独立权威。

所有 Provider，不论 `visibility`，都必须具备：

- `access.type`；
- `api.type`；
- 非空 `api.baseURL`；
- Resolver 已从 `builtinModelIds` 与 `modelIds` 产生合法、有序的 Model Inventory；
- 每个可执行身份具有完整 `enabled`、`properties`、`optionSpecs` 及当前类型所需字段。

Registry 发布类型为 `RegistryProviderConfig` 与 `RegistryModelConfig`。它们是同一个 Effective Config 对象
通过完整性校验后的静态类型表达，不形成新的配置层、持久化对象或 Runtime DTO。Provider 类型只收紧
Access/API/Endpoint 等执行必需字段；成员资格已经投影为 `Provider.models`，执行消费者不重新读取成员数组。
完整类型的序列化必须同样返回完整静态结构，不能通过稀疏基类 `toJSON()` 把 optional Properties 重新
泄漏到 Selection 或 Protocol。

跨集合 Model ID 重复采用 Built-in-wins，只发布 Built-in 身份；单集合重复保留第一次出现。后项读取时确定性忽略，
Settings 保存相关 Provider 时规范化，不建立冲突对象或暂停的第二身份。

Access-specific 要求：

| Access type     | Config 完整性要求    | 请求期要求                                      |
| --------------- | -------------------- | ----------------------------------------------- |
| `api-key`       | 非空 `apiKey`        | 使用 Config 中的静态 Key                        |
| `zhipu-account` | 完整 `family + mode` | Account Request Auth 从当前兼容连接解析动态材料 |

账号动态材料缺失不是 Config 不完整，而是请求期鉴权错误；Adapter 必须在发网络请求前失败。
网络不可达、Token 过期、余额不足、限流和服务商错误也不属于静态 Registry 过滤。

## Visibility

Provider 使用一个通用用户可见性字段：

```ts
type ProviderVisibility = "visible" | "hidden";
```

默认 `visible`。Visibility 只影响面向用户的 Facade：

```text
Provider Registry
├─ visible Provider
└─ hidden Provider
       |
       +--> Settings Facade filters hidden
       +--> Selection Facade filters hidden
       `--> internal lookup keeps hidden
```

Hidden 不代表受信、系统权限、临时执行或无需鉴权。它不会绕过 `enabled`、Config 完整性或 ModelFactory。
内部产品能力知道精确 Selection 时使用 Registry 普通 lookup，并通过同一个 ModelFactory 创建；不增加特殊
Model 创建接口或第二个 Registry。

当前未发布的 `executionOnly` 同时承担可见性和完整性豁免，M4 直接删除，不进入正式兼容历史。

## Registry View 与索引

Registry 的完整内部 View 保留顺序和身份：

```ts
interface Provider {
  providerId: ProviderId;
  config: RegistryProviderConfig;
  models: readonly {
    modelId: ModelId;
    config: RegistryModelConfig;
  }[];
}
```

Model Config 不再具有 visibility。`enabled=false` 与配置不完整的模型不进入 Registry View；Settings 使用配置解析
结果单独保留这些成员，供编辑和重新启用。

内部索引只引用这份 View：

```text
Provider[]
└─ providerById
   └─ modelById
      └─ lookup / validate
```

索引不形成第二份配置事实。任一 Config Source 更新后，Registry 创建新的 View 和索引；已经创建的
Model 继续持有旧配置，直到自己的生命周期结束。

## Settings 与 Selection Facade

```text
Provider Config Service ─ Personal Config ─┐
                                            ├─ Provider Settings Facade
Provider Registry ─ Effective View ─────────┘

Provider Registry
└─ Model Selection Facade
```

Settings Facade：

- 过滤 hidden Provider；
- 保留 disabled Model，供编辑和重新启用；
- 返回 Effective Built-in、Personal 显式字段、Effective Config、明确 `builtin` 的模型成员、完整性问题以及
  enabled/executable/selectable；
- Provider 与 Model 分开保存：Provider 操作只写 Personal Provider Config，单模型操作只写精确 Personal
  Model Config Rule；新增、删除、重命名和调序模型使用成员领域原子操作；
- 同一 Provider 的写入按用户操作顺序完成，不同 Provider 可以并行；
- 保存完成后等待 Registry 观察到新 revision。

Selection Facade：

- 过滤 hidden Provider，以及 disabled 和不完整 Model；
- 对 `enabled=false` 和不完整模型不生成候选；跨集合重名继续使用 Built-in candidate；
- 按 Provider 组织候选；
- 校验 `providerId`、`modelId` 和通用 Options；
- 不管理 Composer Draft、App Recent、Session Selection 或 Active Model。

Selection Facade 只投影 visible candidates 和 revision/change event，不提供通用 `validate()`。Renderer
可以据此展示 unavailable，但不能复制权威 option validator。真正开始执行时，当前 Agent 的 ModelFactory
必须用完整 Registry 重新校验 Selection；内部产品能力可以在保存或派发前按精确 ID 做窄检查。内部产品按精确 ID 直接使用
Registry。这个差异是 View/调用场景差异，不是安全授权边界。

## Account 动态连接

Provider Config 的 `zhipu-account` Access 只固定 `family + mode`。账号身份、具体商品和 Team scope
由 Account Connection/Subscription Service 拥有，不进入 Registry 或 Active Model。每个 request attempt
根据静态约束读取当前兼容连接；没有兼容连接或凭据时在网络前失败。服务端仍是最终授权权威。

## Access 与 API 正交

`access.type` 描述访问材料如何取得，`api.type` 描述公开请求协议。二者正交：API Key、账号连接和
请求期注入都可以访问 Anthropic Messages、OpenAI Responses 或 OpenAI Chat Completions。

```text
ProviderConfig
├─ access.type -> credential acquisition
└─ api.type    -> Adapter/request shape
```

Adapter 的内部 SDK 类型不进入 Provider Config。静态 Header 属于 Provider Config；动态账号或调用级
Header 属于 Request Auth，在请求期合并。

## 变化通知与生命周期

Registry 同时订阅 Config Source 和 Account Source：

```text
Built-in / Personal changed ─┐
Account changed ─────────────┼─> invalidate -> rebuild -> new revision
                             └─> notify Facades / Model runtime
```

首次读取是 ready barrier。刷新失败时 Source 按自己的 last-known-good 规则处理；Registry 不从旧
Provider Store、Workspace Catalog 或 Runtime Snapshot 恢复另一份事实。

具体 Source、进程和刷新链见 [`runtime.md`](./runtime.md)，Model 创建与动态鉴权见
[`model-creation.md`](./model-creation.md)，设置交互见 [`settings.md`](./settings.md)。

## 不变量

- Provider Overlay 是 ZCode Built-in -> Account Built-in -> Personal。
- Account Built-in 只读取 ZCode Built-in account Provider，不读取 Personal。
- Model Rules 是 Built-in + Personal，并作用于 Effective Provider。
- 正常装配中 Built-in/Account Built-in 维护 `builtinModelIds`，Personal 维护 `modelIds`；不建立 Source
  字段权限系统。
- 同 ID 双来源是显式冲突；普通 disabled 模型不进入 Selection，Settings 始终可见。
- Built-in/Personal 同 ID 时 Built-in 身份继续执行；冲突 Personal 精确 Rule 暂停。
- Provider/Model Visibility 只影响用户 Facade；hidden 的完整 enabled 成员仍在 Registry。
- 所有 visible/hidden Provider 使用同一完整性校验、Registry 和 ModelFactory。
- Access 获取方式与 API 协议正交。
- 静态 Account Access 只保存 family、mode；Team Scope 在请求期从当前 Connection 读取。
- UI 是否开放编辑不改变 Schema 表达能力；Personal 手工配置不接受来源资格校验。
- 动态凭据不进入 Registry；服务端做最终授权。
- Config 更新不热改已经创建的 Model。
