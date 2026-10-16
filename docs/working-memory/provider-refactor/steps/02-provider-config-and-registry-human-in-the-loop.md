# M2：Provider 配置与 Registry Human in the Loop

> 状态：持续维护
>
> 最近更新：2026-08-20

本篇记录 M2 实施过程中交由人裁决的架构、产品和公共契约问题。它不同于 implementation log：后者保存 Agent 为继续推进而自主作出的可逆决定；本篇保存会改变目标抽象或实施边界、必须由人确认的决定。

每项记录说明提出问题时的背景、人的裁决、目标设计和实施影响。确认后的结论同步进入对应 Design 节点；本篇保留裁决背景和当前实现与目标之间的距离。

## 1. Account Access 复用 Provider Config Overlay

> 裁决状态：已确认并落地；普通长期 Provider 已退出旧 Snapshot 来源

### 背景

Provider 的访问方式与公开 API 是两个独立维度：`access.type = "api-key"` 使用静态 API Key，`access.type = "zhipu-account"` 使用当前登录、套餐或团队连接；`api.type` 则描述 Anthropic Messages、OpenAI Responses 或 OpenAI Chat Completions。不同访问方式可以使用同一种 API。

最初的新 Registry 仍把账号状态放在独立的 `AccountProviderAccessEntry[]` 中，再由 Resolver 按 `providerId` 拼接 `modelIds` 和 `accessId`。第一次调整虽然把它改称 Runtime Overlay，却又建立了 `AccountProviderOverlay`、`AccountProviderAccess` 和 `allowedModelIds`，本质上仍是第二套 Provider 数据结构。

这与 Config Overlay 的目标相冲突：Official、Personal 和账号状态都在为同一个 Provider 补充字段，不需要三套形态和一条特殊过滤算法。

### 裁决

账号状态直接产出第三层稀疏 `ProviderConfigMap`，与 Official、Personal 使用完全相同的 Provider Config Overlay 数据结构和算法：

```text
Official ProviderConfigMap
        |
        | overlay
        v
Personal ProviderConfigMap
        |
        | overlay
        v
Account ProviderConfigMap
        |
        v
最终 ProviderConfigMap
```

三层的所有权仍然不同：Official 由官方管理，Personal 由用户管理，Account 由账号和套餐状态实时生成。Account 层不持久化，也不由设置页面编辑；这些差异由 Source 和生命周期表达，不再用另一套领域类型表达。

### Access Config

Account Access 是 `ProviderConfig.access` 的一种判别分支：

```ts
class ProviderConfig extends ConfigOverlay {
  access?: ProviderAccessConfig | null;
  api?: ProviderApiConfig | null;
  models?: readonly ModelId[] | null;
}

class ApiKeyAccessConfig extends ConfigOverlay {
  readonly type = "api-key";
  apiKey?: string | null;
}

class ZhipuAccountAccessConfig extends ConfigOverlay {
  readonly type = "zhipu-account";
  accessId?: AccountAccessId | null;
}
```

`accessId` 是非敏感的账号连接身份，用来区分 Start Plan、Personal Coding Plan 和具体 Team Plan。它不是 JWT、API Key 或 Header。

### Account 层提供模型成员

Official Account Provider 负责 `api.type`、`api.baseURL`、静态 Header 等受管理定义，不必提前列出当前账号最终可用的模型。Account 层同时提供当前连接的账号级 `accessId` 和 `models`：

```text
Official
A -> {
  access: { type: zhipu-account },
  api: { type: anthropic-messages, baseURL: ... }
}

Personal
A -> {
  label: "我的 Coding Plan"
}

Account
A -> {
  access: { type: zhipu-account, accessId: account-team-plan:... },
  models: [A, B]
}

Final
A -> {
  label: "我的 Coding Plan",
  access: { type: zhipu-account, accessId: account-team-plan:... },
  api: { type: anthropic-messages, baseURL: ... },
  models: [A, B]
}
```

`models` 遵循普通字段 Overlay 规则：Account 层提供该字段时整体覆盖前层，并直接决定最终成员和顺序。不再存在 `allowedModelIds`，也不再计算“配置模型与允许模型的交集”。模型 Properties、Option Specs 和 Reasoning Mapping 继续由 ModelConfigRules 解析，与 Provider 的模型成员列表是两个问题。

### Registry 与鉴权边界

Registry 只处理 Config：

```text
三层 ProviderConfigMap
        |
        | overlay + validateComplete
        v
Provider Registry
```

最终 `ProviderConfig` 具有完整的 `access.type`、账号级 `accessId` 和 `models` 时即可进入 Registry。Registry 不验证 `accessId` 是否对应真实权益，也不根据 Account Source 的成员关系建立额外的 `accessAllowed` 门禁。

即使有人手工写入一个无效 `accessId`，它也不会获得实际凭据。请求鉴权的最终权威是 Account Request Auth Service：

```text
Provider.config.access.accessId
        |
        | Model 创建时固定
        v
Model 内部执行身份
        |
        | 每个请求 attempt
        v
Account Request Auth Service
        |
        ├─ 找到当前 JWT / API Key / Header -> 发起请求
        └─ 无法解析或无权限             -> 请求失败
```

Registry 和 Model 不保存账号 Secret。账号身份内部的 Token 或 Runtime Key 可以刷新，但已经创建的 Model 不跟随全局当前连接切换到另一份 Personal 或 Team Plan。

### 最终 Provider

最终 Provider 不再嵌套另一份 Account Access 对象：

```ts
interface Provider {
  readonly providerId: ProviderId;
  readonly config: ProviderConfig;
  readonly models: readonly ProviderModel[];
}
```

当 `provider.config.access.type === "zhipu-account"` 时，TypeScript 将 Access Config 收窄为 `ZhipuAccountAccessConfig`，ModelFactory 直接读取 `provider.config.access.accessId`。`ProviderRegistryProvider` 改为领域名称 `Provider`。

### 对当前实施的影响

- Account Source 的输出改为稀疏 `ProviderConfigMap`，不再输出 `AccountProviderAccessEntry[]` 或 `AccountProviderOverlay[]`。
- Provider Config Snapshot 增加 Account Provider Config 层；Resolver 按 Official、Personal、Account 顺序调用同一 Overlay。
- 删除 Registry 中的 `AccountProviderAccess`、`allowedModelIds`、`accessAllowed` 和平铺 `accountAccessId`。请求协议仍使用 `accountAccessId` 把 Model 已固定的身份传给动态鉴权 Service。
- `ZhipuAccountAccessConfig` 包含 `accessId`；最终完整性校验要求账号 Provider 具备执行所需的 Config 字段。
- ModelFactory 从最终 `ProviderConfig.access` 固定 `accessId`；现有请求期动态鉴权链路保持不变。
- 该裁决落地早期曾允许旧 Snapshot 暂时投影正式的 Account `ProviderConfigMap`。M2.8 随后已经删除这条生产兼容链；当前 Account Source 直接产生正式 Config，本文不再把 Snapshot 投影视为可用实施方案。

## 2. Source 刷新失败时保留 Last-known-good View

> 裁决状态：已确认；人复核并批准实现阶段已经自主采用的策略

### 背景

Registry 将 Official、Personal 和 Account 三路 Provider Config 聚合为一份完整 View。任一路变化时，Registry 会在旁边重新读取、解析和校验全部输入，成功后再原子发布新 View。

```text
当前完整 View v1
        |
Source 发生变化
        |
        v
读取 Official / Personal / Account
        |
        v
构建并校验 View v2
        |
        | 全部成功
        v
原子发布 v2
```

Source 刷新可能因为文件暂时不可读、JSON 或 Schema 解析失败、Official 来源异常、账号与套餐服务超时而失败。此时系统只能确认“无法取得最新事实”，不能据此推断用户删除了 Personal Config、官方下线了 Provider，或者账号已经退出。

Overlay 各层通常只保存自己负责的字段。发布去掉失败 Source 的部分结果，会把读取异常错误解释为业务删除：Personal 失败可能让 API Key 和用户 Provider 消失；Official 失败可能使稀疏 Personal Config 无法形成完整 Provider；Account 失败可能使全部 Plan 模型瞬间消失。

实现阶段为了继续推进，`ProviderRegistryService` 已经自主采用 Last-known-good：刷新读取或解析失败时不替换当前 Snapshot，拒绝本次显式刷新并发出刷新错误事件；下一次成功刷新仍可以正常发布新 View。对应测试已经覆盖失败后旧 View 保持可用以及后续恢复。Design 当时仍将“保留旧 View还是发布部分结果”标为待裁决，因此需要由人复核这项实现选择是否成为正式设计。

### 裁决

人同意保留当前实现采用的 Last-known-good 策略，并将其升级为正式设计：Registry 已经拥有成功 View 后，任一 Source 的读取、解析或刷新失败都保留上一份完整 View，不发布缺少该 Source 的部分结果。

```text
刷新成功
└─ 原子发布新的完整 View

刷新失败
├─ 保留上一份成功 View
├─ 报告具体 Source 与错误
└─ 等待 watcher、主动刷新或后续状态变化恢复
```

“刷新失败”和“成功取得空状态”必须严格区分。Source 成功返回删除、禁用、空 Config Map 或账号失效状态时，这些都是明确的新事实，Registry 必须正常构建并发布新 View；Last-known-good 不能阻止有效状态变化。

首次启动没有可保留的成功 View。首次构建失败时，Registry 启动失败并暴露错误，不能把未知状态伪装成一份确定的空 View。

### 与请求鉴权的关系

Last-known-good View 可能短暂保留一个已经显示在模型列表中的 Account Provider，但它不会延长账号权限。Account Request Auth Service 仍在每次请求时按 Model 固定的 `accessId` 取得当前凭据，并且是账号权限的最终权威：

```text
旧 Registry View 中仍有 Account Provider
        |
        v
Model 发起请求
        |
        v
Account Request Auth Service
├─ 当前身份仍有效 -> 返回凭据
└─ 已退出或无权限 -> 请求失败
```

Registry 的 Last-known-good 负责避免投影因瞬时故障发生剧烈抖动；它不缓存、恢复或伪造 JWT、Runtime Key、一次性安全校验 Header 等请求鉴权材料。

### 对当前实施的影响

- Registry 每次只发布全部 Source 共同构建并通过校验的完整 View。
- 刷新失败保留当前 revision 和 View，同时通过错误事件与日志暴露失败原因。
- 主动刷新、文件 watcher 和 Account Source 更新继续进入同一刷新链路；revision 去重避免同一次变化重复发布。
- 成功的空状态、删除、禁用和账号失效必须发布，不能归类为刷新失败。
- Design 中“保留旧 View 还是发布部分结果”的待裁决表述应改为本结论。

## 3. 不再支持任意 Model Options

> 裁决状态：已确认；Agent 自主兼容方案已退出实现

### 背景

旧 CLI 配置与 Desktop Provider 配置都采用同一套旧版底层格式（`provider` → `models` 嵌套），因此两者都允许在模型配置中写入任意 `options`：

```json
{
  "models": {
    "model-id": {
      "options": {
        "arbitrary_field": "value"
      }
    }
  }
}
```

这个共同的底层格式容易造成误判：它既不是 CLI 独有格式，也不代表 CLI 或 Desktop 已经把任意 Model Options 建立为正式产品能力。

旧 CLI 会把部分 `model.options` 作为 Provider 参数带入模型请求。Desktop 的物理配置 Schema 同样接受并保留 `model.options`，但正式的 `ModelProviderModelConfig` 和设置页面没有提供任意 Options 能力；Desktop 当前明确解释的兼容字段主要是 `options.max_tokens`，并将其收敛为正式的 `maxOutputTokens`。现有内部评测配置也只使用 Provider 级 `apiKey`、`baseURL` 和模型容量字段，没有依赖任意 `model.options`。

因此，任意 Model Options 属于底层格式遗留的扩展口，而不是需要由新 Provider 架构继承的公共契约。

### Agent 自主方案

为了避免旧 CLI 配置迁移后丢失任意 `model.options`，Agent 在实现过程中增加了：

```ts
ModelConfig.requestParameters?: Record<string, unknown>;
```

该字段会经过 Config Overlay、Personal Config 投影和 Model 创建链路，最终重新形成一条任意 Provider 请求参数通道。这个方案提高了旧配置的兼容程度，但绕过了 `ModelOptionSpecs`、`ModelOptions` 和 `reasoningMapping` 已经建立的强类型边界，也会把尚未形成产品承诺的历史扩展能力固化到新架构中。

### 裁决

人否决上述兼容方案。新 Provider 架构不再支持任意 Model Options，也不保留通用 `requestParameters`。

新模型配置只承载经过正式定义的通用选项：

```text
reasoningLevel
maxOutputTokens
```

它们分别通过 `ModelOptionSpecs`、`ModelOptions` 和 `reasoningMapping` 完成能力声明、用户选择、请求级覆盖及 Provider 协议转换。旧配置中具有明确正式语义的字段可以迁移：

```text
options.max_tokens
        |
        v
maxOutputTokens
```

其他任意 `model.options` 不迁移、不透传，也不进入新的 Model Config。内部评测使用者可以调整尚未对外发布的 CLI 配置，不需要为这条历史扩展通道设计无损迁移。

### 对当前实施的影响

- 删除 `ModelConfig.requestParameters` 及其 Schema、Overlay、投影、测试和运行时传递逻辑。
- 删除旧 CLI Personal Config 导入器对任意 `model.options` 的迁移。
- 保留 `options.max_tokens` 到正式 `maxOutputTokens` 的语义迁移。
- Desktop 旧存储可以暂时原样保留未知 `model.options`，但新的 Config、Registry 和 Model 执行链不读取它们。
- Provider 级 `options` 中历史保存的 `apiKey`、`baseURL` 与本裁决无关；它们应迁移到正式的 Provider Config 字段。
- 后续新增模型选项时，先定义固定字段、Option Spec、校验规则和 Adapter 映射，再作为公共能力进入新架构。

## 4. 静态 Header 只属于 Provider Config

> 裁决状态：已确认；Agent 自主兼容方案已退出实现

### 背景

旧 CLI 与 Desktop 都采用同一套旧版底层 Provider 配置格式，因此同时允许 Provider 级 Header 和 Model 级 Header：

```text
Provider 级 Header
├─ provider.headers
└─ provider.options.headers

Model 级 Header
└─ provider.models.<modelId>.headers
```

旧 CLI 会将这些 Header 按层合并并用于模型请求。Desktop 的物理配置格式也接受模型级 Header，但正式模型类型和设置页面没有将其建立为产品能力。当前 Official Config、内部评测配置及主要产品链路均未使用模型级 Header。

Provider 级 Header 有明确的连接语义：访问某个 Provider 时，每次请求都需要携带的固定 HTTP Header。它可以表达企业代理的租户和项目路由、额外组织身份、客户端来源及协议版本。它是一个受约束的 `Record<string, string>`，与没有公共语义的任意 Provider Options 不同。

动态账号鉴权 Header 属于另一类数据。JWT、一次性安全校验材料和动态 Runtime Header 由 Account Request Auth Service 在每次请求时取得，不进入持久 Provider Config。

### Agent 自主方案

为了兼容旧 CLI 的 `model.headers`，Agent 在实施过程中增加了：

```ts
class ModelConfig {
  headers?: Record<string, string>;
}
```

Registry 创建 Model 时将这组 Header 固定到 Adapter 内部，并覆盖同名 Provider Header。公共 `Model` 和 `ModelRequest` 不暴露 Header。这个方案在抽象封装上没有泄露请求细节，但把尚未形成正式产品用例的模型级连接差异带入了新的 Model Config。

### 裁决

人确认保留 Provider 级静态 Header，并删除 Model 级 Header：

```text
ProviderConfig.headers
└─ 访问该 Provider 时固定携带的静态 Header

Account Request Auth Service
└─ 每个请求取得的动态鉴权 Header

ModelConfig
└─ 不包含 Header
```

旧配置中的 `provider.headers` 与 `provider.options.headers` 统一迁移到 `ProviderConfig.headers`。旧配置中的 `provider.models.<modelId>.headers` 不迁移，也不进入新的 Config、Registry 或 Model 执行链。

如果两个模型确实需要不同的固定连接 Header，应分别配置为两个 Provider。未来出现无法通过 Provider 边界表达的真实模型级路由需求时，再基于具体用例重新设计。

请求执行时，动态鉴权材料可以覆盖同名静态字段：

```text
ProviderConfig.headers
        |
        | 动态鉴权材料覆盖同名字段
        v
Account Request Auth Service headers
        |
        v
最终 HTTP 请求 Header
```

### 对当前实施的影响

- 保留 `ProviderConfig.headers` 及其 Schema、Overlay、迁移和 Adapter 投影。
- 将旧 `provider.headers` 与 `provider.options.headers` 合并迁移到 `ProviderConfig.headers`。
- 删除 `ModelConfig.headers` 及其 Schema、Overlay、投影和测试。
- 删除旧 CLI Personal Config 导入器对 `model.headers` 的迁移。
- 删除设置页迁移桥对模型级 Header 的隐式保留。
- 保留 Account Request Auth Service 的请求期动态 Header 机制。
- Provider 静态 Header 暂时可以只通过配置文件提供；设置页面无需立即增加高级 Header 编辑器。

## 5. OpenAI Compatible 固定请求流式 Usage

> 裁决状态：已确认并落地；Config 中的关闭开关已经退出

### 背景

OpenAI Compatible 的流式协议需要在请求中携带：

```json
{
  "stream_options": {
    "include_usage": true
  }
}
```

Provider 才会在流结束时返回准确的 Token Usage。Usage 是模型执行结果的一部分，后续会用于用量统计、Trace 和上下文预算等系统能力。

历史代码考虑到部分兼容服务可能不接受 `stream_options.include_usage`，在 Provider 配置中增加了：

```ts
includeUsage?: boolean;
```

当配置为 `false` 时，Adapter 不发送该字段。仓库中没有发现具体 Provider、正式产品用例或用户配置依赖这一关闭能力。

### Agent 自主方案

M2 实施过程中，Agent 将旧 `includeUsage` 作为兼容字段纳入新的 `ProviderConfig`，并沿配置迁移、Overlay、Registry 和 Model 创建链路继续传递。

该方案保留了旧配置的表达能力，但同时把“是否请求 Usage”变成了用户可以关闭的 Provider 配置。关闭后，系统可能无法取得准确的实际用量，与 Usage 在执行链中的基础语义不一致。

### 裁决

人确认 OpenAI Compatible 请求始终显式启用 `includeUsage: true`。Usage 是执行结果的一部分，不属于用户可关闭的 Provider 配置。新的 Provider Config 不包含 `includeUsage`，旧配置中的该字段不迁移。不支持 `stream_options.include_usage` 的兼容服务不在正式支持范围内，也不提供删除该字段后重试的降级路径。

## 6. Plan Entitlement 缓存需要账号级非敏感身份

> 裁决状态：已确认；`accessId` 标识具体账号连接

### 背景

Usage / Entitlement 已经使用 Account Provider 的非敏感 `accessId` 构造缓存身份，不再把 API Key 或 JWT 投影到 Renderer。当前 Personal 与 Start Plan 的 `accessId` 只表达连接种类：

```text
start-plan:<providerId>
coding-plan:<providerId>
```

它不包含具体账号身份。同一台机器先后登录两个账号时，两者会得到相同缓存键。Usage 页面会先显示十分钟短 TTL 缓存，再静默刷新；若新账号刷新失败，为避免网络抖动清空页面，现有 Hook 会继续保留已经显示的旧缓存。因此单靠后台刷新不能保证账号隔离。

### 裁决

`accessId` 标识一份具体的账号连接，而不只是 Start Plan、Personal Coding Plan 或 Team Plan 这种连接种类。具体登录账号变化时，`accessId` 必须变化；同一账号内部的 JWT、API Key、Runtime Key 或 OAuth Token 刷新不改变 `accessId`。

```text
账号 A 的连接
└─ accessId A
   ├─ Account Provider Config
   ├─ Usage Cache
   ├─ Credential Store
   └─ 已创建 Model 的请求身份

账号 B 的连接
└─ accessId B
   ├─ Account Provider Config
   ├─ Usage Cache
   ├─ Credential Store
   └─ 新创建 Model 的请求身份
```

Account Source 使用账号服务提供的非敏感稳定身份生成 `accessId`。它不能包含 JWT、API Key、动态 Header，也不使用 Secret 哈希充当 Renderer 身份。Team Plan 继续包含具体组织与项目连接；若相同组织/项目在不同账号下不应共享连接身份，则同时纳入账号作用域。

登录、登出和连接切换时仍可主动清理旧 Usage 缓存，但清理只是减少陈旧数据和存储占用的辅助措施，不承担身份隔离正确性。

### 实施影响

- Account Source 必须在生成 Personal、Start 和 Team `accessId` 时取得非敏感账号身份。
- Usage / Entitlement 缓存继续使用 `providerId + accessId`，不增加平行的 `accountCacheIdentity`。
- Account Credential Store 按新的账号级 `accessId` 隔离凭据。当前 provider 级稳定 key 属于尚未发布的 M2 中间实现，不为它设计迁移；Personal Coding Plan Key 按当前账号重新取得，Team Key 按账号与 organization/project 重新取得或缓存。
- 已创建 Model 固定旧 `accessId`。账号切换后，它不能静默使用新账号凭据；新 Agent Loop 从最新 Account Config 创建新 Model。
- Account Provider Config、Usage Source、Credential Store 与 Model Request Auth 共用同一个连接身份。
- Request Auth 除了按 `accessId` 查找凭据，还要核对当前凭据所属账号。旧 Model 的 `accessId(account-A)` 不能与切换后的 `credential(account-B)` 组合发起请求。

## 7. desktop-attached remote 使用远端 Provider Authority

> 裁决状态：已确认；第一步纳入 M2.8，持续同步与远程设置操作分别作为后续功能

### 背景

线上 `desktop-attached-remote` 由 Desktop 读取本地完整 Provider Registry Snapshot，再通过
`workspace/updateProviderRegistry` 下发给 Remote Host/Worker。Snapshot 可以携带 API Key、JWT、
Team Plan Key 和 Header；远端 Agent 的启动门禁也读取 Desktop base Host 的模型 View。

M2 一度把剩余问题表述为“Remote Worker 如何跨 Host 请求 Desktop Account Request Auth”，候选是
Renderer 中转或 Local Host 到 Remote Host 的 Auth Broker。两种方案都默认 Remote Worker 属于
Desktop Provider Environment。

### 裁决

Remote Environment 是独立 Provider Environment。它拥有自己的 Config、Credential、Account Source、
Registry 和 ModelFactory。Desktop 只远程控制 Session、显示 Remote View 和提交 ModelSelection，不提供
Remote Worker 的 Provider 事实或请求凭据。

```text
Desktop Entry
└─ remote control
        |
        v
Remote Host
├─ Remote Provider Config
├─ Remote Credential Store
├─ Remote Account Source
├─ Remote Registry
└─ Remote Worker
```

### 分阶段迁移

第一步先切换运行时权威并删除 Desktop -> Remote 的完整 Registry、runtimeModel、Account Config 与
Secret Snapshot 注入。若 Remote Environment 尚无可用配置，产品应明确报告远端尚未配置 Provider，
不能回退 Desktop 事实。

第二步由独立同步功能持续把本地 Config 与 Credential 写入 Remote Store。同步功能只负责 Provisioning；
Remote Source 监听自己的 Store、发布新 revision 并重建 Remote Registry。Registry 对象、Account Overlay、
Model 和请求 Header 不通过该同步链路传输。

第三步允许 App 直接调用 Remote Settings / OAuth Service，远程编辑 Remote Personal Config、发起远端
登录并查看 Remote Settings / Selection View。凭据交换和持久化发生在 Remote Environment。

### 实施影响

- 删除 `desktop-attached-remote` 禁用自身 Provider Registry 的 authority 特例。
- 远端 Workspace 的 readiness、模型菜单和设置读取 Remote Facade。
- Remote Worker 只从 Remote Registry 创建长期 Model。
- Remote Request Auth 只读取 Remote Credential Store。
- 删除 Renderer Auth 中转与 Host-to-Host Auth Broker 课题。
- `provider/updateAccountConfig` 只在同一 Environment 的 Host 与 Worker 之间使用。
- 本地到远端的持续同步与 App 远程设置能力不阻塞第一步的权威切换。

## 8. Usage / Entitlement 退出旧 Provider Config 与 Provider Service

> 裁决状态：已确认并落地；Usage 已退出旧 Provider Service，内部抽象后续再整理

### 当前行为

设置页 Usage 会列出当前账号能够查询的 Personal Coding Plan 和所有已订阅 Team Project，允许用户分别查看；侧栏与 Composer 只展示当前模型连接对应的额度。这个产品行为保持不变。

目前来源列表已经主要由 `ProviderSettingsView` 中的 Account Config、Entitlement 和 Team Products 产生，但 Host 的 `BigModelUsageQuotaProvider` 仍会读取旧 `ModelProviderService.getAllCached()`，再从 `ModelProviderConfig[]` 中重新查找 Provider、判断启用状态、读取 API Key、推断请求地址并刷新 Coding Plan Key。它使已经退出 UI 主链的旧 Provider 大对象继续成为 Usage 的执行事实源，也阻塞旧 Config 和旧 Provider Service 的删除。

```text
当前 UI 已选择的 Usage Source
├─ providerId
├─ accessId
├─ organizationId?
└─ projectId?
        |
        | 身份在现有链路中丢失或不完整
        v
BigModelUsageQuotaProvider
        |
        v
旧 ModelProviderService / ModelProviderConfig
└─ 再次猜测查询来源与请求凭据
```

### 裁决

Usage / Entitlement 必须退出旧 `ModelProviderService`、旧 `ModelProviderConfig` 和旧 Config。此次迁移以打平事实来源为第一目标：只要调用链完整使用新的 Provider Config、Account Config 和 Credential 事实，就不为等待最终 Usage 领域抽象而保留旧依赖；迁移后发现的内部职责问题可以作为独立重构继续处理。

UI 已经选定 Usage Source 时，请求应携带完整、非敏感的来源身份：

```text
Usage Source
├─ providerId
├─ accessId
├─ organizationId?
└─ projectId?
        |
        v
UsageStatsService
        |
        v
请求期鉴权
├─ Personal Coding Plan -> Account Credential Store
├─ Team Plan            -> Team Plan Request Key Resolver
└─ Start Plan           -> OAuth / ZCode JWT Store
        |
        v
Usage / Entitlement API
```

Host 不再根据旧 Provider 数组重新选择来源。Provider 是否被用于模型选择、是否在 Registry 中 selectable，以及当前 Session 正在使用哪个模型，都不作为设置页 Usage Source 的过滤条件。Account Provider 被用户关闭模型入口时，只要账号连接仍然存在，Usage 仍可查询。

普通 API Provider 如果仍需参加 monitor/usage 查询，只读取新的 Effective API Provider Config；Account Provider 的 Secret 始终由请求期 Credential/Account 服务取得。任何迁移适配器都只能从新的 Config、Account 和 Credential 事实投影窄输入，不能回读旧 Config 或旧 Provider Snapshot。

已知 Account Plan 的 Usage 路由在本轮可以继续使用现有 providerId/family 与服务地址构造逻辑，但不再通过模型 Endpoint 猜测账号套餐类型。Usage 路由是否进一步进入 Official Config，留给 Usage 领域后续重构，不阻塞旧 Provider 事实源退出。

### 本轮实施边界

- 为 Coding Plan Usage / Entitlement 请求补齐 `accessId`，保留现有 Team organization/project 上下文。
- `BigModelUsageQuotaProvider` 删除 `IModelProviderService` 依赖，以及 `getAllCached()`、`refreshCodingPlanApiKey()` 和 `ModelProviderConfig[]` 读取。
- Personal、Team、Start Plan 分别复用现有 Credential Store、Team Key Resolver 和 OAuth Token Store；不复制新的 Secret 缓存。
- 保持设置页、侧栏、Composer、套餐重置和现有缓存刷新行为。
- 本轮不要求先形成完美、通用的 Usage Source/Authorization 框架。打平完成后，若 `BigModelUsageQuotaProvider` 仍混合过多职责，再单独拆分。

完成标准是：删除旧 Provider Config 与 Provider Service 时，Usage / Entitlement 不再构成阻塞，也不会通过兼容 fallback 重新引入旧事实源。

## 9. Provider Access、API 与 Model API Adapter 分层

> 裁决状态：部分被取代；Provider `access/api` 分层继续有效，`ModelConfig.apiAdapter` 由第 11 项裁决撤回

### 背景

此前 Provider Config 用一个 `kind` 同时表达 API Key 或账号访问方式，又把 `apiFormat`、`baseURL` 平铺在 Provider 上；模型侧则把 `reasoningMapping` 直接放在 ModelConfig。这样会把“如何获得调用资格”“使用哪种公开 API”“该模型在该 API 上有哪些固定适配行为”混成一层。

### 裁决

Provider Config 拆成两个正交子配置：

```text
ProviderConfig
├─ access.type
│  ├─ api-key
│  └─ zhipu-account
└─ api.type
   ├─ anthropic-messages
   ├─ openai-responses
   └─ openai-chat-completions
```

判别字段统一使用 `type`。`access` 表达调用资格来源，`api` 表达公开请求协议；内部 Adapter 类型仍是执行实现，不进入对外 Config。

本项当时进一步决定把模型与 API 组合相关的固定行为收敛到
`ModelConfig.apiAdapter`。后续对 AI SDK、GLM 真实接口以及各厂商官方 Anthropic
兼容接口的审计表明，这一层混合了协议固有行为、厂商推理参数映射和消息回放，且最终只剩
`reasoningMapping` 一个需要配置的字段。该部分裁决已经撤回，以下结构仅保留为裁决演进轨迹，
当前设计以第 11 项为准：

```ts
interface ModelConfigRule {
  providerMatch?: string;
  modelMatch: string;
  apiMatch?: string;
  config: ModelConfig;
}

class ModelConfig extends ConfigOverlay {
  properties?: ModelPropertiesConfig | null;
  optionSpecs?: ModelOptionSpecsConfig | null;
  apiAdapter?: ModelApiAdapterConfig | null;
}

class ModelApiAdapterConfig extends ConfigOverlay {
  reasoningMapping?: ReasoningMappingConfig | null;
  preserveThinking?: boolean | null;
  reasoningContentField?: string | null;
}
```

`apiMatch` 与 `providerMatch`、`modelMatch` 使用相同的模式匹配语义，规则按顺序执行，后面的命中项继续 Overlay 前面的结果。`preserveThinking` 与 `reasoningContentField` 是固定 API 适配行为，不是用户可选的 Model Option。

Provider Config 把旧的 `kind/apiFormat/baseURL` 结构收敛到 `access/api`，把 `apiFormatMatch/reasoningMapping` 收敛到 `apiMatch/apiAdapter`。Official、Personal 与 Account 仍然复用同一种 ProviderConfig Overlay；Account 层只补充账号连接和当前模型成员，不持久化请求凭据。开发分支中间使用的 Schema 版本不构成发布契约，最终版本号由下一项裁决统一处理。

GLM-5.2 与 GLM-5.3 的 Anthropic API 按标准 adaptive thinking + effort 表达，不发送 budget。GLM-5-Turbo 暂时保留现有 1024 fixed-budget 兼容行为。OpenAI Chat 下的 reasoning 方言和推理回放通过精确 `apiMatch` 规则写入 `apiAdapter`；Anthropic Messages 与 OpenAI Responses 优先遵循各自官方协议。

## 10. Personal Config 保持原路径，并以 Schema Version 1 首次发布

> 裁决状态：已确认；取代开发阶段的独立文件路径和版本迁移链

### 背景

M2 开发阶段曾把新的 Personal Provider Config 写入独立的 `provider-config.json`，并随着内部 Schema 调整连续使用 v1、v2、v3、v4，下一轮结构还准备使用 v5。这样可以在开发过程中验证相邻版本迁移，但这些格式从未正式上线，不需要成为产品未来长期维护的历史版本。

同时，Desktop 正式用户原有的模型 Provider 配置已经位于：

```text
~/.zcode/v2/config.json
```

新建 `provider-config.json` 会改变用户熟悉的物理路径，并产生新旧两个文件的权威切换问题。最终架构不需要通过改文件名表达领域边界。

### 裁决

Personal Provider/Model Config 继续使用原来的 `config.json` 文件名和路径，不引入正式的 `provider-config.json`：

```text
旧格式 ~/.zcode/v2/config.json
        |
        | 迁移前先完整备份
        v
同路径 ~/.zcode/v2/config.json
└─ 新 ProviderConfigDocument
```

迁移开始前必须把用户的原始配置完整复制为同目录备份。备份成功是修改原文件的前置条件；备份失败则停止迁移，不覆盖原配置。备份文件不得静默覆盖已有备份，具体后缀和冲突命名可以由 Repository 在实现中确定。

完成 M2、准备首次发布时，新的 Provider Config 文档使用：

```json
{
  "schemaVersion": 1
}
```

开发阶段出现的 v1–v5 都属于未发布中间格式。M2 收尾时删除为这些内部版本保留的长期兼容分支和公开版本叙述，以最终完整 Schema 作为正式 v1。后续真正发布后的格式变化才从 v1 迁移到 v2。

这项裁决不要求为未正式开放的 Standalone CLI 历史格式设计无损兼容。内部评测使用者可以调整配置；若 Entry 对既有文件执行迁移，也必须遵守“先备份、后原子替换”的数据安全顺序。

## 11. 撤回 Model API Adapter 配置层，Reasoning Mapping 直接属于 ModelConfig

> 裁决状态：部分被第 12、13 项补充；撤回 `ModelConfig.apiAdapter` 的结论继续有效，`reasoningMapping` 的必填条件与语义以第 12 项为准，GLM-5-Turbo 的具体档位以第 13 项为准

### 背景

第 9 项裁决曾在 `ModelConfig` 中增加 `apiAdapter`，并计划由它承载
`reasoningMapping`、`preserveThinking` 和 `reasoningContentField`。继续审计后确认，
三者实际属于不同问题：

- `reasoningMapping` 描述用户选择的 Reasoning 档位如何形成特定 Provider/Model/API
  所需的请求参数；
- Anthropic Thinking Block、Signature 与 OpenAI Responses Reasoning Item 的保存和回放是
  对应协议的固有行为；
- GLM OpenAI Chat 的 `clear_thinking` 是具体请求参数，可以直接成为
  `reasoningMapping` 的输出。

AI SDK 已经能够在 OpenAI Compatible 消息和标准 Reasoning Part 之间转换
`reasoning_content`，Anthropic Adapter 也负责 Thinking Block 与 Signature 的协议回放。
因此，配置层不需要再声明响应字段名或重复表达消息回放策略。

对各厂商官方 Anthropic 接口的核对同时表明，基础 Messages 结构已经较为统一，但 Reasoning
控制并未统一：DeepSeek、Kimi、MiniMax、Qwen 和 MiMo 分别采用不同的开关、档位或 budget
语义。`reasoningMapping` 因而仍有价值，但它是按 Model Config Rule 选择的协议参数映射，
不是一个独立 Model API Adapter 配置对象。

### 裁决

撤回尚未发布的 `ModelConfig.apiAdapter` 和 `ModelApiAdapterConfig`。`ModelConfig` 保持展平，
可选的 `reasoningMapping` 直接放在其中：

```ts
class ModelConfig extends ConfigOverlay {
  properties?: ModelPropertiesConfig | null;
  optionSpecs?: ModelOptionSpecsConfig | null;
  reasoningMapping?: ReasoningMappingConfig | null;
}
```

`ModelConfigRule.apiMatch` 继续保留。它与 `providerMatch`、`modelMatch` 一起确定某条
`reasoningMapping` 适用于哪个 Provider、模型和公开 API：

```text
providerMatch + modelMatch + apiMatch
                    |
                    v
            ModelConfig Overlay
                    |
                    v
             reasoningMapping
```

运行时 Provider Adapter 继续存在。此次撤回的是配置 Schema 中的 `apiAdapter` 包装层，
不改变 Anthropic、OpenAI Responses 和 OpenAI Compatible Adapter 的执行边界。

第 12 项进一步确认：标准 OpenAI Responses、Anthropic Messages 和 OpenAI Compatible 的
Reasoning 参数映射也应由 Official Config 明确给出。运行时 Adapter 继续负责协议执行与消息
回放，不再隐藏一套从 `reasoningLevel` 生成请求参数的默认策略。

`preserveThinking` 和 `reasoningContentField` 退出目标 Config：

- GLM OpenAI Chat 需要的 `clear_thinking` 直接写入对应档位的 `reasoningMapping`；
- Reasoning 内容的解析和回放由消息模型与 Adapter 完成，不由 Config 指定字段名；
- 历史 DeepSeek/MiMo 空 `reasoning_content` 兼容补丁继续单独审计，不通过上述字段表达。

GLM-5.2 与 GLM-5.3 的 Anthropic API 使用现代 `adaptive thinking + effort`。GLM-5-Turbo
同样使用 adaptive thinking，但不对外承诺 effort 档位；具体依据和映射见第 13 项。三者均不发送
fixed budget。GLM-5-Turbo 已通过 BigModel Coding Plan 真实接口验证，覆盖单轮请求、当前
AI SDK 解析、Tool Call、Thinking Block、Signature 以及 Tool Result 后的第二轮回放。因此撤回
第 9 项中为 GLM-5-Turbo 保留 `1024 fixed budget` 的临时结论。

## 12. Reasoning Mapping 是必填的 AI SDK Provider Options 映射

> 裁决状态：已确认；模型声明 `reasoningLevel` 时必须提供完整的 `reasoningMapping`

ZCode 内部使用 AI SDK 调用模型。OpenAI Responses、Anthropic Messages 和 OpenAI Compatible
分别由对应的 AI SDK Provider 执行。用户选择统一的 `reasoningLevel`，`reasoningMapping`
负责把这个档位转换成当前 AI SDK Provider 接收的 Options：

```text
reasoningLevel
        |
        | reasoningMapping
        v
AI SDK Provider Options
        |
        v
AI SDK Provider
        |
        v
模型 API
```

当 `ModelConfig.optionSpecs.reasoningLevel` 声明了可选档位时，最终生效的 `ModelConfig`
必须同时提供 `reasoningMapping`，并覆盖所有可选档位。标准 API 的默认映射也写入 Official
Config，不隐藏在 Adapter 代码中。

例如：

```jsonc
// OpenAI Responses
"reasoningMapping": {
  "high": {
    "reasoningEffort": "high"
  }
}
```

```jsonc
// Anthropic Messages
"reasoningMapping": {
  "high": {
    "thinking": {
      "type": "adaptive"
    },
    "effort": "high"
  }
}
```

```jsonc
// GLM OpenAI Compatible
"reasoningMapping": {
  "high": {
    "reasoningEffort": "high",
    "clear_thinking": false
  }
}
```

`reasoningMapping[level]` 是交给当前运行时 Provider Adapter 的、与 Reasoning 有关的 AI SDK
Provider Options 内层对象。它不包含 `openai`、`anthropic` 等 AI SDK namespace，也不是最终的
HTTP Request Body。运行时 Adapter 根据当前 API 类型把它放进正确的 Provider Options
namespace，再由 AI SDK Provider 编码成实际协议字段。

`reasoningMapping` 直接属于 `ModelConfig`：

```ts
class ModelConfig extends ConfigOverlay {
  properties?: ModelPropertiesConfig | null;
  optionSpecs?: ModelOptionSpecsConfig | null;
  reasoningMapping?: ReasoningMappingConfig | null;
}
```

该映射只承载 Reasoning 相关的 Provider Options，例如 `reasoningEffort`、`effort`、`thinking`、
`enable_thinking` 和 `clear_thinking`。API Key、Header、Base URL 和其他模型请求参数不属于该映射。

## 13. GLM-5-Turbo 只提供 Thinking 开关

> 裁决状态：已确认；取代第 11 项中“GLM-5-Turbo 使用 effort”的部分

智谱官方文档明确声明 GLM-5-Turbo 支持 `thinking.type = enabled | disabled`，默认开启；开启时
由模型动态判断是否需要思考。`reasoning_effort` 的正式支持范围从 GLM-5.2 开始，未包含
GLM-5-Turbo。真实接口能够接受某个参数，不等同于该参数已经成为模型的公开契约。

因此 GLM-5-Turbo 的 `reasoningLevel` 只包含：

```text
enabled
disabled
```

OpenAI Compatible API 的映射使用 `thinking.type`。ZCode 作为长链 Coding Agent，在开启思考时
同时使用 `clear_thinking: false`，并由消息模型与 Adapter 完整、原样、按顺序回放历史
`reasoning_content`。该行为是固定协议配置，不作为用户 Option 暴露。

Anthropic Messages API 的映射为 `adaptive` 与 `disabled`。开启时不发送 `effort`，由服务端采用
默认推理策略；同时不发送 fixed budget。此前用于兼容旧 AI SDK 的 `budgetTokens: 1024` 不进入
新的 Official Config。

GLM-5.2 与 GLM-5.3 继续按照各自官方支持范围提供 effort 档位，不受本项裁决影响。

## 14. 闲时任务使用 Builtin Provider 与按 Turn 传入的鉴权材料

> 裁决状态：已确认；普通 Account 鉴权与闲时任务鉴权采用不同来源边界

### 背景

当前闲时任务由 Host 在每次派发前组装一份 `turnRuntimeModel`。它同时包含
Provider 与 Model 的静态配置，以及本次执行使用的 API Key、Ticket 和 Headers。
Core Worker 把它临时加入 Registry Overlay，为当前 Turn 创建执行 Model，Turn 结束后
再恢复先前的 Runtime Model 并清理 Overlay。

这条链路已经具有“每个 Turn 使用一份固定鉴权快照”的运行语义，但它把静态
Provider 事实与动态鉴权材料一起组装和传输，并依赖临时 `setModel`/恢复逻辑。

### 裁决

普通 Account Provider 的鉴权以 Core Worker / CLI 进程自己的 Account Request Auth Service
为事实来源。Host 或其他 Entry 只提交 `ModelSelection`，不随 Submission 传入或覆盖普通
Account Provider 的 API Key、Headers、Provider Config 或 Model Config。CLI 根据自己的
Registry 创建 Model，并在真实请求发生时由自己的鉴权 Service 取得当前连接的动态凭据。

```text
Host / Entry
└─ ModelSelection
        |
        v
CLI Registry
        |
        v
CLI Account Request Auth Service
        |
        v
Model Request
```

当前 Desktop Worker 通过协议回调 Host 取得普通 Account 鉴权材料，属于需要退出的迁移期
链路；它不构成目标架构中的第二事实来源。

闲时任务的 Provider 改为 Official Config 管理的 Builtin Provider。它的 Provider 身份、
API 类型、Base URL、模型列表、Model Properties 和 Option Specs 等静态事实进入正式
Registry。该 Provider 供闲时任务执行使用，不出现在普通模型选择和设置交互中。

Host 每次派发闲时 Turn 时，只额外传入本次执行所需的动态鉴权材料：

```text
Builtin Provider（Official Config / Worker Registry）
├─ Provider 与 Model 静态配置
└─ 不包含本次执行的 Secret

Host 派发 Turn
├─ ModelSelection
├─ API Key
└─ Headers
   ├─ Coding Plan API Key
   ├─ Off-Peak Ticket ID
   └─ 本次执行需要的其他 Header
```

Core Worker 使用 Registry 中的 Builtin Provider、本次 `ModelSelection` 和传入的鉴权材料
创建普通 `Model`。该 Model 被显式交给当前 Agent Loop，Loop 内的 Model Step 和自动
Compact 继续使用同一份 Model 与鉴权材料。

```text
Worker Registry 中的 Builtin Provider
        +
ModelSelection
        +
本 Turn 的 API Key / Headers
        |
        v
      Model
        |
        v
   Agent Loop
```

鉴权材料不写入 Official Config、Personal Config、Registry View 或 Session 持久状态。它只对
本次 Turn 有效，Turn 结束后不得被后续执行继续使用。闲时 Model 也不修改用户的
Session Model Selection 或 App Recent。

### Ticket 过期与续跑

当前 `3102` Ticket 过期语义保留：

```text
当前 Turn 收到 3102
        |
        v
当前 Turn 结束
        |
        v
同一 Off-Peak Task 回到 queued
        |
        v
Host 重新取得 Ticket
        |
        v
在同一 Session 提交 Resume Turn
        |
        v
新 Turn 使用新传入的 API Key / Headers 创建新 Model
```

这是同一闲时任务和同一 Session 中的新 Turn / Agent Loop，不是在正在运行的 Model
内替换 Ticket。普通 JWT 或 API Key 鉴权失败不自动等同于 `3102`；其是否需要自动
续跑不在本项裁决中。

### 执行模型切换横幅

模型切换横幅由相邻执行段实际使用的 Model 决定。每个 Agent Loop 持有自己的
Execution Model；Guide 在 Loop 内切换 Model 时会形成新的执行段。新执行段开始时，
系统将它的 `providerId/modelId` 与上一个执行段比较：身份不同则显示模型切换横幅，
身份相同则不显示。reasoning 档位变化不单独视为模型身份变化。

```text
上一执行段的 Execution Model
              |
              | 比较 providerId / modelId
              v
当前执行段的 Execution Model
              |
              +-- 相同：不显示横幅
              `-- 不同：显示模型切换横幅
```

闲时模型按照同一规则进入执行模型序列，不需要闲时任务专属的横幅状态：

```text
普通 Turn A
    |
    v
闲时 Turn Idle       -> A 与 Idle 不同，显示 A -> Idle
    |
    v
下一普通 Turn B      -> Idle 与 B 不同，显示 Idle -> B
```

如果闲时任务结束后尚未开始新的执行段，系统不会提前显示“恢复到 A”。此时没有 Model
正在执行；下一轮真正创建 A 或 B 后，再根据实际 Execution Model 生成横幅。这样用户在
闲时任务期间把 Session Selection 从 A 改为 B 时，时间线自然显示 `Idle -> B`，不会经过
没有真正执行过的 A。

Session Model Selection 只负责为后续执行创建 Model，不作为横幅的事实来源。每个 Turn
需要持久化实际 Execution Model 身份；实时投影与冷恢复都从同一执行序列归约横幅。
`lastExecutionModel` 只表示上一个实际执行模型，不承担 Session Selection 的持久状态。

横幅使用一个明确的公共入口：

```ts
recordExecutionModelChangeMarker({
  modelRef: activeModel.modelRef,
  traceContext,
});
```

该入口只比较本 Session 的当前 Execution Model 与 `lastExecutionModel`，在
`providerId/modelId` 变化时持久化 `model_change` Marker。普通主 Agent Loop 开始、闲时
主 Agent Loop 开始，以及 Guide 的新 Model 真正从下一 Model Step 生效时调用它。
Subagent 若复用该入口，只写入自己的 Child Session。Title、Memory、Wiki、Verifier 等
独立模型任务不调用它。

该入口不创建或切换 Model，也不修改 Session Selection、Provider Config 或 Registry。

Execution Model 在 Model 创建成功并正式进入主 Agent Loop，或在 Guide 后正式进入新的
Model Step 时生效。此时调用 `recordExecutionModelChangeMarker()`。如果 Model 创建失败，
或者 Submission 在进入 Agent Loop 前被 Admission、Hook 等边界阻止，则不建立新的执行
模型基线。进入 Loop 后即使在首个 Model Request 发出前被取消，该 Model 仍然是本执行段
已经生效的 Execution Model，可以产生横幅。

`3102` 续跑是同一闲时任务的新 Turn。如果新 Turn 继续使用相同 Idle Model，执行模型
身份没有变化，不增加中间横幅；整个闲时任务之后真正开始的下一执行段再与 Idle 比较。

### 鉴权边界

闲时任务不扩展普通 Account Request Auth Service 的职责。它首先复用 CLI Registry 中的
Builtin Provider 静态事实；如果现阶段难以由 CLI 自己取得闲时服务要求的整套动态材料，
Host 可以随本次 Turn 传入 execution-scoped Request Auth。该输入只表达这次闲时执行的
鉴权材料和 Ticket，不携带 Provider 或 Model 静态配置。

后续如果 CLI 能自然取得 JWT、Coding Plan Key 等材料，可以继续缩小 Host 输入；这项优化
不改变已经确认的边界，也不阻塞当前迁移。Off-Peak Ticket 由 Host 调度服务取得，继续随
本次 Turn 传入。

执行期鉴权需要满足：

- 普通 Account Provider 始终使用 CLI Account Request Auth Service，不接受外部鉴权覆盖；
- 闲时任务允许 Host 随本次 Turn 传入 API Key、Headers 与 Ticket；
- 不同 Turn 和并发执行之间的鉴权材料必须隔离；
- Model 在一个 Agent Loop 内使用固定的鉴权材料；
- Turn 结束、失败或取消后，本次鉴权材料必须退出可用状态；
- Provider 和 Model 仍然通过统一 ModelFactory 与 Adapter 链路执行，不建立闲时任务专属的
  模型请求协议。

## 15. 进程 Registry 启用后，旧 Workspace Catalog 退出 Provider Authority

> 裁决状态：已确认并完成

进程 Registry 已经从 Official、Personal 与 Account Config 构建 Provider 和 Model。此时旧
Workspace Catalog 继续参与成员判断、属性同步或投影合并，会让 Host Snapshot 重新成为第二
事实源。该问题不能因为代码位于旧协议兼容层就整体推迟；凡是会影响普通长期 Provider 的部分，
都属于 M2 当前高优收口范围。

确认后的边界是：

```text
进程 Registry 已启用
├─ Provider / Model 成员       -> Registry View
├─ Model Properties / Options -> Registry Model
├─ 模型切换可用性             -> App Registry View
├─ 当前执行的 context window  -> 当前 App Runtime / Model
└─ Provider revision          -> 不再使用旧 Workspace Catalog revision

Workspace Settings
└─ Workspace default / last-used / mode 等交互状态
```

Host 随旧协议携带的 `runtimeModel` 在 Registry 进程中不再写入 Workspace Catalog，也不再用来
补充普通长期 Provider。迁移期的闲时 `runtimeModel` 由后续切片收窄为 ModelSelection、Request Auth
与 Ticket；它不成为保留普通 Workspace Provider Snapshot 的理由。

本项同时确认以下实施原则：

- `syncAppWorkspaceModelCatalog()` 在进程 Registry 模式下不再安装旧 Overlay 或覆盖 Runtime；
- App 初始化不再由旧 Workspace Catalog 生成 `bootstrapModelConfig`；
- Session preflight 与跨 Provider 切换从 Registry-backed `app.listModels()` 判断当前成员；
- `workspace/readState` 只返回 `settings.model`，旧 `modelCatalog` 协议字段、Provider 投影与
  revision 已删除；
- App 不再公开 `setModelCatalogOverlay`，也不再保存 Workspace 级 Provider/Model Overlay；
  闲时等单次执行仍通过独立的 Turn Overlay 进入，不会恢复长期 Workspace Catalog；
- `createZCodeApp` 必须注入进程 Registry；测试与内部工具使用显式测试 Registry，不再通过缺少
  可选参数进入旧 Runtime Model Config 装配；
- 冷恢复 usage 的 context window 使用当前 App Runtime 已固定的模型属性；
- `workspace/readState` 是纯投影接口，不接收 `runtimeModel`，也不修改 Active Session；
- `workspace/setDefaultModel` 只写 ModelSelection，不接收 Provider 运行快照；
- V4 `createSession` 与 `switchModelConfig` 只提交 ModelSelection；目标 Provider 由 Worker
  Registry 校验，不再接受 Host `runtimeModel` 回落；
- Repo Snapshot 旁路只使用本次命令明确携带的 Selection 或 execution-scoped Model；缺少时
  允许模型元数据为空，不再读取 `workspace/readState` 猜测 Provider；
- default、last-used、mode 等选择/交互状态仍可留在 Workspace Settings 中，后续由 Interaction 设计
  继续收敛，不与 Provider 静态事实混为一谈。

不直接影响当前 Registry Authority 的清理可以后排，例如删除已经没有调用者的旧热更新辅助
函数、重构闲时鉴权、原子 Submission 与 Guide/Loop 内切换语义。判断标准是能否减少当前双轨，
而不是原先被标记在哪个阶段。

## 16. M1/M2 自主决策的产品语义追认

> 裁决状态：已确认

实施和复核过程中出现的五项自主决定，现按产品语义正式追认。

### Model Property 是请求发送前的统一检查

调用方可以提前读取 Property 选择执行策略；Model 在发送请求前仍会再次检查实际 Request。请求使用
模型明确声明为不支持的图片、PDF、视频、Tool Call 或 Structured Output 时，Model 返回明确错误。

目标 Registry 的 ModelConfig 必须完整，最终不保留 `unknown`。当前图片、PDF 和视频字段允许
`undefined`，只是因为默认配置和用户主动设置能力尚未完善：过渡期仅有明确 `false` 会阻止请求，
缺省值暂时放行。相应配置迁移完成后，字段改为必填并删除该兼容语义。

### 独立模型任务延续已有 reasoning 行为

Title、Git Commit Message 和 Memory Selector 在重构前已经关闭 reasoning，因此继续使用关闭
reasoning 的派生 Model。此次重构不改变这些任务的产品策略，也不允许它们绕过 Model 直接修改
Provider 参数。

### Account 查询按 Provider 保留 last-known-good

Start Plan、Personal Coding Plan 和 Team Plan 的远端查询分别产生 `available`、`unavailable` 或
`unknown`。某一路为 `unknown` 时，只保留该 Provider 的上一份成功结果；其他 Provider 已经得到的
确定结果继续发布。明确 `unavailable` 会删除对应 Provider。

### 目标设计不保留临时 Provider

闲时任务从 CLI Registry 选择 Official Builtin Provider，并随 Turn 接收必要的 Request Auth 与
Off-Peak Ticket。Submission 不携带完整 ProviderConfig 或 ModelConfig。M2 中仍存在的闲时
`runtimeModel` 是待收窄的兼容输入，不构成新的事实来源。

### Account Provider 的用户可见行为保持现状

此次重构保持当前 Provider 数量、Personal/Team 连接切换和模型可见性，不引入多个 Team 与 Personal
同时出现在模型选择器等新的产品形态。Config、Registry 和 Request Auth 的内部收敛不得改变这一行为。
