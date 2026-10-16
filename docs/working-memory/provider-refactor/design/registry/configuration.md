# Provider 与 Model 配置

> 当前有效设计；Provider Template 切换已纳入本文。

Provider 配置由 ZCode Built-in、Account Built-in 和 Personal 三层组成。三层共享字段级 Overlay 语言。
正常装配按字段含义维护成员：Account Built-in 更新 Built-in 集合，Personal 更新 Personal 集合。五个输入来源各自
通过严格边界 Schema 验证字段所有权，再进入共同领域 Overlay 类型；Runtime 不复制五套配置类型。
ZCode Built-in 与 Personal 提供 Model Config Rules，Account Built-in 不提供模型静态能力。

设计层不建立“配置文档”领域概念。Config Map、Rules 和 Effective Config 是领域对象；JSON 外壳、
`schemaVersion`、文件名、缓存和序列化格式属于 Source/Repository 实现。

## 配置来源

| 来源                              | 所有者           | 持久化 | 主要内容                                                   |
| --------------------------------- | ---------------- | ------ | ---------------------------------------------------------- |
| ZCode Built-in Provider Config    | ZCode 产品发布   | 是     | Account Provider 定义与 Provider Template                  |
| Account Built-in Provider Config  | 当前账号连接状态 | 否     | Built-in account Provider 的 Account Access 与动态模型成员 |
| Personal Provider Config          | 用户             | 是     | 自定义 Provider、API Key、对已有 Provider 的最终覆盖       |
| ZCode Built-in Model Config Rules | ZCode 产品发布   | 是     | 模型静态事实、缺省 Options、per-option raw-body map        |
| Personal Model Config Rules       | 用户             | 是     | 对具体 Provider/Model 的稀疏覆盖                           |

Catalog、Preset、Provider Family、远端 `builtinProviders/builtinModels` 和业务 hardcode 不能成为额外
Registry Source。仍有效的系统事实迁入 ZCode Built-in Config/Rules；用户显式配置迁入 Personal；账号
连接事实进入 Account Built-in Config。

### ZCode Built-in 的内容组织

ZCode Built-in 在物理上继续使用一份完整、原子的 JSON，不拆成按 Provider、模型或规则层级划分的多份
源文件，也不引入额外的生成/拼装流水线。Provider Map 的声明顺序和 Model Config Rules 的数组顺序就是
发布内容的一部分；具体 Rule 类型、物理写作顺序、Endpoint 特化、证据和默认启用目录规范见
[`zcode-builtin-provider-config.md`](./zcode-builtin-provider-config.md)。这些规范不新增 Rule priority 或动态重排。

Built-in Release 按以下产品来源组织：

```text
providers
├─ Z.ai / BigModel Individual、Team、Start Plan Account Provider
└─ Off-Peak 隐藏 Account Provider

providerTemplates
├─ Z.AI API / BigModel API
├─ Moonshot / MiniMax / DeepSeek
├─ Alibaba Model Studio CN / International / Xiaomi MiMo
└─ OpenAI / Anthropic / xAI
```

Off-Peak 继续通过 `visibility=hidden` 保持普通设置页和模型选择器不可见。普通 API 服务只发布为
Provider Template；Template 不是 Provider，不进入 Registry，也不具备 `providerId` 或执行状态。用户从 Template
创建 Personal Provider 后，Template 仅作为其官方继承基线。Provider 顶层没有 `enabled`；Account Provider 的动态
套餐资格由 Account Overlay 写入 `access.entitled`，最终执行准入由资格、配置完整性和 Model `enabled` 共同决定。

这一顺序首先服务于配置可读性和稳定的默认展示顺序；设置页将来是否增加显式分组属于独立交互设计，不能
反向改变 Provider 身份、Registry 成员或 Model Rule 解析。

### ZCode Built-in Release 与活动缓存

Bundled、Remote 与 Environment Active Cache 使用同一个两层 Release 契约：

```ts
interface ZCodeBuiltinRelease {
  schemaVersion: 3;
  revision: number;
  config: {
    providers: Record<string, ProviderConfigObject>;
    providerTemplates: Record<
      string,
      {
        nameMap: Partial<Record<"zh-CN" | "en-US", string>>;
        config: ProviderConfigOverlayObject;
      }
    >;
    modelConfigRules: StructuredModelConfigRuleGroups;
  };
}
```

Provider Template 是领域壳：`nameMap` 是 Template 自身的多语言选择元数据，`config` 继续复用正式
Provider Config Overlay。Template 不吸收 Model Config Rules；后者仍集中保存，以保持 Match、Template、
Provider 与 Personal Rule 的应用顺序直观可见。Template 名称按当前 Locale、`en-US`、`templateId` 的顺序回退。

`config` 原子包含 Account Provider Map、Provider Template Map 与 Model Rules；`schemaVersion` 和单调递增的 `revision`
属于 Source 发布外壳，不进入 Provider Overlay。Remote 是完整替换，不能与 Bundled 交叉拼接 Provider
和 Rules。已发布的同一 revision 必须对应唯一内容，内容回滚也要发布更高 revision。

Environment 在
`<config-root>/provider/zcode-builtin/<platform>/<appVersion>/<endpointKey>/active.json` 保存当前活动
Release；该文件同时承担 LKG。`endpointKey` 由规范化后的 ZCode 控制面 Origin 确定性生成，Active 与
`refresh-control.json` 必须位于同一个 Endpoint 目录。启动时严格解析 Bundled 与当前 Endpoint 的 Active，选择 revision 更高的兼容候选并物化到
Active。Active 是可丢弃的缓存/LKG，不是启动前提：Active 缺失、损坏、更旧、与 Bundled 的同 revision
内容冲突，或 Active 目录的锁、监听、读取、删除、写入失败时，都直接使用可信 Bundled 完成 ready；能够写入时
再用 Bundled 重建 Active。只有 Bundled 本身也无法通过 Release Schema 与现有 Provider/Rule Parser 时才允许
启动失败。客户端不增加发布者业务完整性规则；未来如需发布门禁，另立基于最终发布流程的新任务。

不同 Endpoint 的 Active/LKG 和 revision 互不比较、互不回退。切换到没有 Active 的 Endpoint 时先使用
Bundled 完成 ready，再后台刷新该 Endpoint；切回旧 Endpoint 可以复用它自己的 LKG。旧的未分区缓存尚未
形成正式发布兼容，不提供 dual-read。

Personal Provider Config 是用户配置而不是缓存。文件损坏、Schema 不受支持或一次性迁移失败时，运行时必须在
能够读取原文时先保留确定性恢复备份，再以空 Personal Overlay 启动；备份或重写失败时也可以只在本轮以内存空
Overlay 降级，不能让 Personal 文件拖垮 Bundled 与 Account Provider。后续 Personal 保存仍走正常原子写并将
持久化错误返回给该次操作，不能伪造保存成功。不同进程通过异步 content revision 轮询观察 Personal Config；同进程
保存仍即时发布，其他进程最迟在一个轮询周期内追上，不依赖平台相关的文件事件。

Environment 的 Model Selection Configured Default 只是一个可重建偏好。确认 JSON、Schema 或版本损坏时只在仍持有
文件锁的范围内删除；锁、读取或 Legacy importer 的暂时失败只忽略本轮偏好，不删除文件。随后由当前 Registry 的普通
fallback 重新选择；Configured Default 不能阻断 Registry、Model Selection View 或 Agent 启动。

## Provider Overlay

```text
ZCode Built-in Provider Config
              |
              v
overlay Account Built-in Provider Config
              |
              v
Effective Built-in Provider Config
              |
              v
 overlay Personal Provider Config
              |
              v
      Effective Provider Config
```

```ts
effectiveBuiltinProviders = zcodeBuiltinProviders.overlay(accountBuiltinProviders);
effectiveProviders = effectiveBuiltinProviders.overlay(personalProviders);
```

优先级是 `Personal > Account Built-in > ZCode Built-in`。

### 有序 Map

ProviderConfigMap 是有序 Map：

- 后层覆盖已有 providerId 时保留原位置；
- 后层新增 providerId 时按后层顺序追加；
- Personal-only Provider 因此排在 Built-in Provider 之后；
- Account Built-in 不改变 ZCode Built-in Provider 的基础顺序。

Account Built-in 对每个账号 Provider 显式写入 `access.entitled`：有权益为 `true`，无权益为 `false`；未知状态有
上一份成功 Overlay 时保留上一份，没有时以 `entitled=false` fail-closed。Start Plan 账号接口返回的非空
模型集合整体覆盖 `builtinModelIds`；Individual/Team 不写该字段并继承 Built-in。Start Plan 已确认可用但
没有解析出模型时只能保留上一份成功 Overlay，首次则禁用，不能回退到宽泛 Built-in 成员。

示例：

```text
Built-in: [A, B, C]
Account Built-in: [A-account]
Personal: [Y, C-personal, X, A-personal]

Effective: [A-personal, B, C-personal, Y, X]
```

### 配置项 Overlay 原则

Config Overlay 使用三态：

```text
undefined -> 本层不覆盖
具体值    -> 覆盖前层
null      -> 明确清除前层
```

Overlay 的基本单位不是 JavaScript 对象的任意叶子，而是产品明确暴露给用户的一个配置项：

- 一个字段如果作为完整配置项呈现给用户，用户能够看到完整继承值并整体修改，那么 Personal 一旦显式
  提供该字段，就整体替代下层值；数组、Map 和对象都不做隐式 merge；
- 一个嵌套对象如果把多个叶子分别暴露为独立配置项，则按这些叶子分别 Overlay。例如
  `input_format.support_image` 与 `support_video` 是两个独立开关；
- `undefined` 表示继续继承，具体值表示显式替代，允许清除的字段使用 `null` 表示显式清除；
- 设置页展示完整继承值不等于产生 Personal 覆盖。只有用户实际修改该配置项时才物化完整替代值；
  “恢复默认”删除 Personal 字段，重新继承最新 Built-in/Account Built-in 值；
- UI 是否主动开放一个配置项，只决定产品交互，不决定 Config Schema 的表达能力。设置页隐藏、只读或
  不提供编辑入口的字段，不因此成为 Personal Schema 的禁写字段；用户手工修改配置时仍按通用 Overlay、
  结构校验和完整性校验处理；
- 如果一个集合中的成员由多个层分别拥有，且上游新增、删除、重排会与用户意图并存，就不能把它建模为
  一个整体 Overlay 字段。必须按所有权拆分数据结构，并单独定义组合顺序、冲突、上游变化和删除语义。

因此 `api.headers`、`reasoningLevel.values` 等作为一个完整配置项时继续整体替代；Option Spec 的
`type/values/max/map` 则是分别暴露的叶子，按叶 Overlay。Provider 模型成员因 Built-in 与 Personal
拥有不同成员而拆成两个字段。

Personal Config 始终保持稀疏，Effective View 不得反向展开并污染 Personal。

### `builtinModelIds` 与 `modelIds`

Provider 模型成员按所有权拆分：

```text
ZCode Built-in builtinModelIds
└─ ZCode 在线配置声明的成员

Account Built-in builtinModelIds（存在时）
└─ 当前账号接口返回的动态成员，整体替换 ZCode Built-in

Personal modelIds
└─ 用户自行添加、删除和排序的成员
```

Effective Provider 同时保留 `builtinModelIds` 和 `modelIds`。正常装配中 Account Built-in 维护前者，
Personal Settings 维护后者；两者不再争用一个 `models[]`。这不是 Source 字段权限系统。Resolver 生成
带来源的 Model Inventory，正常顺序是 Built-in 在前、Personal 在后。

两个字段继续遵循 Config Overlay 三态：`undefined` 不覆盖、`null` 显式清空本来源集合、数组提供成员和
顺序。Resolver 生成 Inventory 时把最终缺失或 `null` 的集合归一化为 `[]`；空集合是合法成员事实，不属于
Provider 完整性错误。单集合重复 ID 与双集合同 ID 都作为 Model 级成员问题隔离，不能让整个 Provider
失效；Account/Resolver 不得静默去重。Model ID 去除首尾空格后以大小写敏感的精确字符串作为身份。

同一 ID 同时出现在两个字段时采用 Built-in-wins，只形成一个 Built-in 成员；单集合重复保留第一次出现。
后项读取时确定性忽略，正常 Settings 禁止写入，并在下一次保存相关 Provider 时规范化。系统不建立冲突 DTO、
暂停身份或第二个同名模型。满足 enabled、完整性和 Provider visibility 时，Built-in 模型进入 Selection。

Account 返回的 `builtinModelIds` 不是客户端不可绕过的授权白名单。Personal 仍可以通过 `modelIds`
添加其他 ID，服务端对真实请求做最终授权。完整成员、冲突和启停语义见
[`model-membership-and-enablement.md`](./model-membership-and-enablement.md)。

## Account Built-in Provider Config

AccountProviderService 的输入必须是 ZCode Built-in Provider Config，而不是已经叠加 Personal 的集合。
它只处理 Built-in 声明的账号 Provider：

- 只根据当前结构化连接设置匹配的 Start、Individual 或 Team Built-in Provider 的 `access.entitled`；
- 权益接口确实返回模型集合时可以覆盖 `builtinModelIds`；
- 不提供 context、max output、输入输出格式、Reasoning 或其他模型静态能力；
- 不读取、约束或改写 Personal-only Provider；
- 不覆盖 `access`，也不保存 product、organization、project、账号身份、Token、Runtime Key、JWT 或
  一次性安全校验 Header。

Account Built-in Provider Config 是同一次账号与连接解析产生的原子 Snapshot。解析全部成功时整体发布；
任一外部依赖失败时整体保留上一版成功 Snapshot，不混合多个解析代次，也不实现按 Family 或 Provider
的局部 last-known-good。账号状态模型与套餐拓扑继续演进时不能改变这项原子发布边界。

## ProviderConfig

目标字段：

```ts
interface ProviderConfigInput {
  templateId?: string | null;
  group?: "standard-personal" | "zai-family" | "bigmodel-family" | null;
  label?: string | null;
  logo?: { type: "builtin"; key: string } | null;
  visibility?: "visible" | "hidden" | null;
  access?: ProviderAccessConfig | null;
  api?: ProviderApiConfig | null;
  builtinModelIds?: readonly string[] | null;
  modelIds?: readonly string[] | null;
}
```

`logo` 是最终 Provider 的展示配置。Template 在内部 `config` 中提供默认 Logo，Account Provider 在自己的
Built-in Config 中提供 Logo，Personal Overlay 可以覆盖或用 `null` 清除。`builtin` key 是开放字符串：客户端
不认识远端新发布的 key 时只回退通用图标，不影响配置解析、完整性或执行；未知 `type` 仍由当前 Schema 拒绝。
打包资源可按主题为同一 key 提供 light/dark 文件，但主题分支不进入 Provider Config。

`group` 是 Concrete Provider 的产品组织事实，不由 Host、Renderer 或 Provider ID 白名单临时推断。Account
Provider 根声明使用 `zai-family` 或 `bigmodel-family`；Template 创建与完全自定义的 Personal Provider 使用
`standard-personal`。`templateId` 只引用官方 Template 基线，不把 Template 变成 Provider。Resolver 得到的完整
Effective Provider、Registry Config 与 Settings DTO 中，`group` 必须完整。Provider 不另存 `builtin` boolean 或
顶层 `enabled`。

这是一份共同领域字段全集。ZCode Built-in 与 Account Built-in 的正常代码维护 `builtinModelIds`，Personal
正常代码维护 `modelIds`，Effective Provider 保留两者。Source 边界使用各自严格 Schema 拒绝越权字段；进入领域后
仍复用共同 Provider Config/Overlay，不建立五套 Runtime 类型。

`visibility` 缺省为 `visible`，只控制用户 Settings/Selection Facade。Provider 是否进入可执行 Registry 由
配置完整性与 Access 事实决定：hidden Provider 仍可由内部能力精确执行，visible Provider 也可能因缺少访问材料而
只在 Settings 中展示问题。

### API

```ts
interface ProviderApiConfig {
  type?: "anthropic-messages" | "openai-chat-completions" | "openai-responses" | null;
  baseURL?: string | null;
  headers?: Readonly<Record<string, string>> | null;
}
```

`api.type` 描述公开协议；`baseURL` 是当前 Environment 中该 Provider 的静态请求入口；`headers` 是静态
Header。Endpoint 不能由 Model ID 推断，也不能放入普通 Turn 的 Runtime Provider 快照。

### Access

```ts
type ProviderAccessConfig =
  | {
      type: "api-key";
      apiKey?: string | null;
      apiKeyManagementUrl?: string | null;
    }
  | {
      type: "zhipu-account";
      accountType: "zai" | "bigmodel";
      mode: "start-plan" | "individual-coding-plan" | "team-coding-plan" | "off-peak";
    };
```

`access.type` 描述访问材料的一级来源，和 `api.type` 正交。`zhipu-account.mode` 是智谱账号产品的
有限枚举：官方版本请求安全校验的准入与 Off-Peak 协议都由 Mode 分派。Z.AI API 与
BigModel API Template 创建的实例使用普通 `api-key` Access，不进入 V4，也不建立所有 Access 可填的伪通用字段。
动态安全校验材料、
Off-Peak Ticket 和远端 rollout 不持久化进 Config。
完整执行边界见
[`request-compatibility-and-access-protocols.md`](./request-compatibility-and-access-protocols.md)。

#### api-key

Config 直接管理调用模型 API 所需的静态访问材料；当前正式字段是 API Key。
Effective Config 缺少非空 `apiKey` 时不完整；Settings 可以展示并修复，但 Provider 不进入
Registry。它与 `api.type` 正交：`access.type` 描述访问材料来源，`api.type` 描述线路协议。

#### zhipu-account

ZCode Built-in Provider 固定声明 `accountType + mode`；Start、Individual、Team 分别是独立 Provider。Account
Connection Resolver 使用这些字段、结构化 Settings 选择、当前账号与权益，只投影 `access.entitled` 以及 Start
接口确实返回的模型成员。Model 创建时固定 Built-in 声明的 `family + mode`。

每个请求 attempt 由 Account Request Auth Service 按静态 `family + mode` 检查当前兼容连接，再从当前
Connection 取得 Team scope，并解析 JWT、Runtime Key、API Key 或一次性安全校验 Header 等材料。账号身份、
product、organization、project 和动态凭据不进入 Provider Config 或 Active Model。

Personal 对普通 `api-key` Access 使用整体替代语义；固定 `account:*` Provider 的 Personal Source
不允许写入 `access`。当前账号是否存在兼容连接由 Request Auth 在请求期判断，服务端做最终授权。

### 凭据原则

准确边界是：

> Provider Config 是模型 API 调用的装配输入，可以按 Access Type 保存静态访问凭据或稳定凭据引用；
> 它不是统一凭据中心，不负责所有动态凭据的生命周期，也不承担服务端最终授权裁决。

## Visibility

```text
visible
├─ Provider Settings 可见
└─ Model Selection 可见（同时满足 enabled/完整性）

hidden
├─ Provider Settings 不可见
└─ Model Selection 不可见
```

Visibility 是 presentation/option-source 配置，不是安全门禁。Registry 内部保留完整 hidden Provider，
内部产品能力可以按精确 ID 创建。Hidden 不豁免 Access、Endpoint、模型成员或 Model Config 完整性。

尚未发布的 `executionOnly` 同时承担可见性、Registry 排除和完整性豁免，M4 直接删除，不保留 legacy
兼容读取。

## Model Config Rules

Effective Rules 在领域边界确定性组合：Built-in 保留发布顺序，Personal `provider-model` 保留内部顺序并统一后置：

```ts
effectiveModelRules = ModelConfigRules.composeEffective(zcodeBuiltinModelRules, personalModelRules);
```

Built-in 与 Personal 使用共同的 Rule 结构：

```ts
type ModelConfigRule =
  | {
      type: "provider-model";
      providerId: string;
      modelId: string;
      config: ModelConfig;
    }
  | {
      type: "match";
      providerMatch?: string;
      modelMatch: string;
      apiMatch?: string;
      baseURLMatch?: string;
      config: ModelConfig;
    };
```

匹配是声明式配置能力，不等于业务代码中的具体模型特判。Rules 按顺序应用；后命中字段覆盖前面。
ZCode Built-in 通用规则补齐所有模型必需事实，具体规则覆盖差异，Personal 精确规则最后覆盖。

GLM-5.3 系列当前包含 `glm-5.3` 与 `glm-5.3-flash`。Flash 必须进入全部 Z.ai/BigModel Provider：API
Provider 遵循现有小写 wire ID，账号套餐与 Off-Peak Provider 遵循现有 `GLM-*` 展示/线路 ID。它继承
GLM-5.3 的 context、输出上限、reasoning、工具与其他完整模型事实，只覆盖输入格式为支持 Image 和 Video。
该关系必须由连续的 Built-in Model Rules 表达，Runtime、Adapter 和 UI 不得按模型 ID 再建立特判。

Model Config 是模型能力、Options 和请求参数映射的唯一配置归属，但不把这些事实误写成“只能按
modelId 匹配”。一项能力可以是模型本身的公共事实，也可以只在特定 Provider、API 或 Endpoint 接入组合
下成立；Rule 应按真实支持范围选择 `modelMatch`、`providerMatch`、`apiMatch` 和 `baseURLMatch` 的最小
充分组合。

`baseURLMatch` 是正式 Schema 支持的可选匹配维度，但 Built-in Rule 不因字段存在就必须使用。稳定的
Built-in Provider 身份能够准确表达差异时优先使用 `providerMatch`；只有同一 Provider 身份和 API type
之下仍存在由 Endpoint 部署决定的真实差异时，才使用 `baseURLMatch`。是否为某项事实启用 URL 匹配必须
逐条裁决，不能建立按 URL 猜厂商、猜模型或猜 Reasoning 的通用逻辑。

`providerMatch` / `modelMatch` / `baseURLMatch` 是本地 Rule Resolver 使用的正则表达式文本，并分别对
完整 Provider ID、Model ID 和 Effective Provider `api.baseURL` 做完整匹配。`modelMatch` 固定使用
ASCII 大小写不敏感匹配；它只影响配置解析，不改写发给 Provider 的真实 Model ID。规则若确实需要包含
匹配，必须显式写出前后 `.*`；Resolver 不自动把每个精确模型规则扩成 contains，因为 `k3`、`glm-5`
等短 ID 会与更具体的模型产生重叠，并按数组顺序错误覆盖能力事实。

`providerMatch` 与 `apiMatch` 保持大小写敏感。`baseURLMatch` 也保持大小写敏感，但匹配目标不是用户输入
的原始字符串：Resolver 先使用标准 URL parser 规范化 scheme、hostname、默认端口和尾部斜杠，再对
规范化结果匹配；path 与 query 的大小写原样保留。Rule 作者因此应针对规范化后的 URL 写 pattern，不能
通过对整个 URL 使用忽略大小写匹配来掩盖 Host 的大小写差异。

`provider-model` 可以出现在 Built-in 或 Personal Source，精确声明一个 Provider/Model 组合。Built-in 专属 Rule 由
ZCode Built-in Release 管理；Personal 专属 Rule 由 Settings 管理。`match` 负责让一条声明式 Rule 覆盖一组模型，
不是远端配置 matcher，也不会在业务代码中触发某个模型的专属分支。设置页写入单个 Provider/模型时只创建结构化
`type="provider-model"`，不把 ID 编码成正则。

只有 Personal 专属 Rule 跟随 Personal 生命周期：Personal Model 重命名时移动、删除时删除；删除 Provider 的 Personal
Overlay 时删除该 Provider 的全部 Personal 专属 Rule。Built-in 专属 Rule 和 Built-in Match Rule 都不由这些操作自动重写或
删除。恢复某个字段默认值只删除 Personal 专属 Rule 中对应叶子；Rule 变空后删除整条 Rule。

解析必须读取 Effective Provider：

```ts
effectiveModelRules.resolve({
  providerId: effectiveProviderId,
  modelId,
  apiType: effectiveProvider.api.type,
  baseURL: effectiveProvider.api.baseURL,
});
```

Renderer、Shared、协议和 Adapter 不通过字符串 helper 猜测某个模型支持什么能力或 Reasoning 强度。

### Built-in Model Rules 的写作与排列

ZCode Built-in Rules 继续保存在同一个数组中，但不再按“所有模型事实 / 所有 API 特化 / 所有 Provider
特化”拆成相距很远的全局区段。除完整兜底和真正跨模型的服务规则外，属于同一模型家族的规则连续排列，
让维护者能够在一个位置看到该模型的完整声明。数组后命中规则覆盖前命中规则，因此排列顺序同时是可读性
规范和运行语义：

```text
Complete Fallback
        |
        v
GLM family
├─ family common
├─ model A
│  ├─ model common facts
│  ├─ model + API schema
│  ├─ provider + model
│  ├─ provider + model + API schema
│  └─ provider + model + API schema + Endpoint（确有需要时）
└─ model B ...
        |
        v
GPT -> Claude -> Grok -> Kimi -> MiniMax -> DeepSeek -> Qwen -> MiMo
        |
        v
Cross-model Provider / Service Rules（仅在无法归入单一模型家族时）
```

模型家族的稳定阅读顺序跟随前述 Provider 产品顺序：先 GLM，再依次排列 GPT、Claude、Grok、Kimi、
MiniMax、DeepSeek、Qwen 和 MiMo；新增模型家族追加到相应产品位置。GLM 家族同时承载 ZCode 产品使用的
GLM 模型与公开 GLM 模型的共同事实，但账号、Endpoint 或 API Schema 差异仍由更窄规则表达。

每个家族内部按以下覆盖层级连续书写：

| 顺序 | 典型匹配                                                         | 主要职责                                                       |
| ---- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| 1    | 家族范围 `modelMatch`                                            | 多个同家族模型共享、且已确认相同的事实                         |
| 2    | 具体 `modelMatch`                                                | 模型固有的 Properties、输入输出格式、上下文、Option Specs      |
| 3    | `modelMatch + apiMatch`                                          | 该模型在公开 API Schema 下的 Option Map、Replay 和请求字段差异 |
| 4    | `providerMatch + modelMatch`                                     | 某家服务实际部署该模型时的差异                                 |
| 5    | `providerMatch + modelMatch + apiMatch`，按需增加 `baseURLMatch` | 同一服务下 API Schema 或 Endpoint 仍造成的最终差异             |

同一模型具有多种 API Schema 时，API 特化紧跟该模型的公共事实连续排列，使用稳定顺序：
`anthropic-messages`、`openai-chat-completions`、`openai-responses`。不存在的组合不写空规则。限定到某个
家族的 Provider/Service 规则仍放在该家族内；只有确实覆盖多个无关模型家族的规则才放到数组末尾的
Cross-model 区域。

必须遵守：

- 完整兜底位于首位，补齐全部必需字段且只提供保守默认值；家族宽规则位于具体模型规则之前，精确规则之后
  不得再次追加会覆盖它的宽规则；
- 同一匹配条件只保留一条 Rule。判断重复时，`modelMatch` 按其大小写不敏感语义处理；重复内容合并到同一
  配置对象，不能依赖两条等价 matcher 的偶然先后顺序；
- 通用模型事实与 API-independent Properties 写在具体模型规则；请求方言差异写在紧邻的 API 特化；
  Provider、Service 或 Endpoint 特化只覆盖差异叶子，不复制整份模型配置；
- OpenAI-compatible 只说明基础请求形状相似，不说明 `enable_thinking`、`thinking`、
  `reasoningEffort` 等厂商扩展字段相同；此类参数必须约束到被官方服务事实支持的最小组合；
- JSON 数组顺序已经表达分组和覆盖关系，不为排版增加 `group`、`section`、`name` 等运行时无意义字段，
  也不把 Built-in 拆成多文件或增加生成流水线；
- Personal Rules 始终整体追加在全部 Built-in Rules 之后，继续拥有最终用户覆盖优先级。

重排现有 Built-in Rules 时必须把它视为行为改动：针对 Built-in 中实际存在的
`providerId/modelId/api.type/baseURL` 组合，对比重排前后的 Effective Model Config。纯重排应保持解析结果
等价；合并重复 Rule 可以消除偶然覆盖，但任何配置值变化必须作为独立、明确的事实修正处理。这里要求的是
当前配置重排的等价性检查，不是逐 commit、逐叶子的历史迁移审计。

### 事实来源与旧实现收口

整理 Built-in 时按以下证据优先级核对：

```text
ZCode 产品/账号服务契约
        >
厂商 Models API 的实时成功响应
        >
厂商当前官方 API 与模型文档
        >
当前 AI SDK 官方契约 + 实际请求体
        >
可复现的服务请求
        >
旧配置、Catalog、Preset 和 hardcode
```

旧实现只用于发现可能遗漏的事实，不自动成为新配置的正确答案。不要求建立逐 commit、逐叶子的重型迁移
审计表；但每项非显然的 Reasoning、兼容开关或 Provider 特化都必须能由官方契约、产品服务事实或可复现
请求解释。确认已由 Built-in Config 承接后，旧业务 hardcode 必须删除，不能作为第二事实源继续兜底。

Models API 的证据范围以响应实际字段为准：ID 集合可以证明当前访问材料可见的成员；只有接口明确返回的
capability、context 或 output 上限才可证明相应模型事实。文档示例响应不是实时目录，服务接受请求但忽略内容也
不是能力证明。Models API 用于发布校验和差异报告，不直接参与 Runtime Overlay；正式静态事实仍只由现有
Built-in、Account 与 Personal 层进入 Resolver。

### OpenAI Responses Reasoning

OpenAI Responses 的通用选项仍使用 `Model.options.reasoningLevel`，具体等级由对应 Model Rule 的
`optionSpecs.reasoningLevel.map` 映射为原始请求体 `reasoning.effort`。Built-in
不得把 OpenAI Chat、第三方 OpenAI-compatible 服务中的字面量直接复制到 Responses：例如产品通用等级
`max` 是否映射为 OpenAI 的 `xhigh`，必须按具体模型当前支持的 effort 集合声明。

OpenAI/Anthropic Provider 加入 Built-in 时，必须同时补齐其模型的 API-independent Facts、API-specific
Option Map 和请求体契约测试。测试应观察最终 HTTP 请求体，而不能只断言内部 SDK 参数。
对自定义 Base URL 或 SDK 未识别的 reasoning 模型，协议差异必须进入更窄的 Model Config Rule，不建立
Runtime 全局猜测规则。

## ModelConfig

```ts
interface ModelConfig {
  enabled?: boolean | null;
  properties?: ModelPropertiesConfig | null;
  optionSpecs?: ModelOptionSpecsConfig | null;
}
```

`modelId` 来自 Provider 的 source-aware Model Inventory 和解析上下文，不在 ModelConfig 中重复。
`enabled` 是执行门禁，不属于 API Properties，也不表达服务端授权或成员关系。模型不再拥有独立 visibility；
用户可见性由 Provider visibility 和模型是否 executable 的 Selection View 统一表达。ModelConfig 的其余字段描述公共契约中的模型 Properties、
用户可选择 Options，以及每个 Option 到目标 API 原始请求体的映射。

Built-in 通用 Rule 必须补齐完整的 `enabled=true` 默认值，具体 Built-in Rule 可以为淘汰或不建议继续使用的模型声明
`enabled=false`。Personal 专属 Rule 可以后置覆盖该叶子；正常新增 Personal Model 时明确写入 `enabled=true`。

Model Config 不包含通用 Compatibility 容器。历史 reasoning 统一保留 canonical 事实并交给 Adapter 标准编码；不得按
具体模型删除真实 reasoning，也不得为 tool-call 补造 synthetic empty-thinking。OpenAI-compatible reasoning 不再使用
独立 `openai-reasoning-content` 模式；旧 GitHub Copilot `omitMaxOutputTokens` 和 Snowflake
`maxOutputTokensRequestField` 删除。官方版本请求安全校验与 Off-Peak 执行协议由
`zhipu-account.mode` 的有限枚举分派，不再出现在 Model Config，也不作为伪通用 Access 字段。准确边界见
[`request-compatibility-and-access-protocols.md`](./request-compatibility-and-access-protocols.md)。

### Properties

```ts
interface ModelPropertiesConfig {
  contextWindow?: number | null;
  input_format?: {
    support_text?: boolean | null;
    support_image?: boolean | null;
    support_video?: boolean | null;
    support_audio?: boolean | null;
    support_pdf?: boolean | null;
  } | null;
  output_format?: {
    support_text?: boolean | null;
  } | null;
  supportsToolCall?: boolean | null;
  supportsJsonSchemaOutput?: boolean | null;
  supportsNativeWebSearch?: boolean | null;
  supportsMidConversationSystem?: boolean | null;
}
```

Rule 可以逐叶缺省或覆盖。Effective Model Config 必须得到完整 `input_format` 和 `output_format`；
Runtime、Adapter、Compact、Memory、Subagent 和 UI 都读取相同字段，不创建派生 capability map。详细
契约见 [`../model/input-output-format.md`](../model/input-output-format.md)。

### Option Specs

Option Specs 声明可配置项的候选顺序、硬上限和请求映射，例如：

```ts
interface ModelOptionSpecsConfig {
  reasoningLevel?: {
    type?: "enum" | null;
    // 按推理强度从低到高；首项是最低公开档位。
    values?: readonly string[] | null;
    map?: string | null;
  } | null;
  maxOutputTokens?: {
    type?: "limit" | null;
    max?: number | null;
    map?: string | null;
  } | null;
}
```

Core 只理解通用 `reasoningLevel` 和 `maxOutputTokens`，不理解 Provider 方言字段。
`reasoningLevel.values` 是从最低到最高的有序列表。普通缺省选择在 Host Selection 边界取末项；明确使用
最低档的辅助调用显式选择首项。不能按档位名称推断 Provider 是否支持关闭 Reasoning。

每个 Option 的 `map` 使用受限 CEL 读取与所属 Option 同名的最终变量：Reasoning Map 读取
`reasoningLevel`，Max Output Map 读取 `maxOutputTokens`，并返回 RFC 7396 JSON Merge Patch Object。
ModelFactory 创建 Active Model 时编译 Map；Adapter 在 AI SDK 已序列化的最终 JSON Body 上应用 Patch，随后才
进入动态鉴权和签名。`reasoning_effort`、`thinking.type`、`max_tokens` 等具体 wire 字段只存在于
Map 结果，不进入 Core，也不再经过独立 `reasoningMapping` 或 AI SDK Provider Options。完整契约见
[`../model/model-option-map.md`](../model/model-option-map.md)。

所有按具体模型识别 Reasoning 强度的旧代码都应退出。有效差异进入 ZCode Built-in Model Config Rules。

## 完整性校验

Schema 校验字段格式和未知字段；Registry 完整类型创建入口递归检查 Overlay 后的最终结果，并将结果表达为
`{ ok: true, config } | { ok: false, issues }`。Resolver 复用这一次结果生成 Settings 诊断或 Registry Value；
失败候选不进入 Registry，成功结果在静态类型上不再包含稀疏 Rule 的 optional 必填字段。不能用
`issues.length === 0` 过滤后继续裸断言同一个稀疏 Config 类型。

稀疏 `ProviderConfig`、`ModelConfig` 继续作为 Overlay 输入；Registry 使用
`RegistryProviderConfig`、`RegistryModelConfig` 表达已经验证的事实。完整创建入口只收紧 Effective Config
的静态类型，不增加持久化 Config Source、Runtime DTO 或第二份配置权威。

```ts
interface RegistryProviderConfig extends ProviderConfig {
  readonly access: CompleteProviderAccessConfig;
  readonly api: CompleteProviderApiConfig;
}

interface RegistryModelConfig extends ModelConfig {
  readonly enabled: boolean;
  readonly properties: RegistryModelProperties;
  readonly optionSpecs: RegistryModelOptionSpecs;
}
```

完整类型还必须提供返回完整对象类型的序列化契约。不能只用 `extends ModelConfig` 收紧属性，却继续继承
返回稀疏 `ModelConfigObject` 的 `toJSON()`，否则 Selection/Protocol 会重新看到 optional Properties。
实现可以让完整类型覆盖序列化返回类型，或提供唯一 `toRegistryJSON()`；不能重新复制并维护另一份 DTO。

Provider 最低完整性：

- `access.type` 及相应静态字段；
- `api.type`；
- `api.baseURL`；
- Resolver 产生合法、有序的 Model Inventory；重复项按 Built-in-wins/保留第一次的规则归一化。

Model 最低完整性：

- 完整 `enabled`；
- 完整 Properties；
- 完整 input/output format；
- 完整 max output Option Spec（含正整数 max 和可编译并返回 Object Patch 的 map）；
- 完整 reasoningLevel Option Spec；values 非空、无空白项、无重复项并按低到高排列，map 可编译；客户端不根据名称猜测语义；
- 所有正整数和枚举值合法。

Runtime、Adapter 和 Telemetry 均不得扫描 `disabled`、`off`、`nothink`、`none` 等名称来猜测开关语义。
Map 只读取当前 Option 的最终值；不接收其他 Option、上下文、Provider、Model 或凭据。
Settings Resolution 允许保留 disabled、incomplete 和成员问题。Registry 发布 enabled、完整的模型；
跨集合重名发布 Built-in 身份，单集合重复保留第一次。Model 不具有 hidden 状态。Registry 后的消费者不得重新检查或补齐 Properties、Option Specs
和 Provider 执行字段。

最终设计中，enabled 的 `zhipu-account` 必须具有完整 `family + mode`；Team scope 不属于静态完整性。
账号动态材料缺失时，Adapter 必须在网络前失败。

Personal Config 不要求自身完整，可以继承 Built-in；Settings Preview 和 Registry 都在完成 Overlay 后检查。
Hidden Provider 使用同一完整性规则。

## 设置与稀疏保存

Settings 同时读取：

```text
Personal explicit value
Effective inherited value
validation issues
```

输入框真实值只表达 Personal 显式字段；Effective Built-in 值可以作为 placeholder。完整集合或对象作为
一个配置项暴露时，UI 可以展示其完整继承值，但只有用户实际修改后才把修改后的完整值写入 Personal。
用户输入恰好等于 Built-in 默认值，仍保存为显式 Personal；“恢复默认”通过删除 Personal 字段完成。

模型格式编辑直接维护嵌套 `input_format/output_format`。Text 锁定，Image/Video 可编辑，PDF/Audio
隐藏但原样保留；保存生成逐叶稀疏 Personal Rule。

设置交互和重排见 [`settings.md`](./settings.md)。

## Source 与物理存储

领域 Service 只消费普通 Config Snapshot，不感知文件、数据库或远端服务：

```text
ZCode Built-in Config Source ─┐
Personal Config Repository ───┼─> ProviderConfigService
                              └─> ProviderRegistry

Account Built-in Config Source ───> ProviderRegistry
```

Built-in 发布文件统一命名为 `config/provider/zcode-builtin.json`。Desktop、CLI/TUI、测试和 SEA 各自显式
注入可访问的 Source 路径或普通对象，`@zcode/provider` 不读取文件。Provider Config 链不保留
`official.json`、旧环境变量或旧协议字段兼容；原子切换计划见
[`../../steps/todo-10-zcode-builtin-provider-config-naming-cutover.md`](../../steps/todo-10-zcode-builtin-provider-config-naming-cutover.md)。

Personal Config 使用当前 Environment 的 `.zcode/v2/provider_config.json`，与其他综合配置文件物理隔离。
Repository 提供读取、变化通知和原子 `update()`；文件锁、原子写、重试和 content-revision 轮询属于
Repository 实现。

## 旧配置迁移

已发布旧 `config.json` 只在新目标文件缺失时，由 Host/Standalone 组合根在 Repository 锁内执行一次性导入：

```text
legacy config + current Built-in baseline
                  |
                  v
     project explicitly represented facts
                  |
                  v
       sparse Personal Config + Built-in Rules
                  |
                  v
             validate -> atomic create
```

没有 Built-in 基线的 Custom Provider 整体进入 Personal；有基线的 Provider 只保存差异。动态账号凭据、
Runtime Snapshot、Catalog enrichment 和旧 hardcode 不参与迁移。独立旧 Provider Store 及其中的 Coding Plan
Key 不再读取。旧文件没有明确表达的 Model Property 不写 Personal Override，由 Built-in 通用 Rule 提供默认；
Importer 不增加 `COMPATIBILITY_*`，也不按 Catalog、modelId、Provider 类型或 Endpoint 猜值。解析失败或
Overlay 后完整校验失败时不修改原文件。

无版本 Legacy importer 是过渡发布设施。强制升级窗口结束，且最低支持版本/升级链已经保证用户经过带
importer 的版本，或者产品明确接受更早版本用户重新配置后，删除 importer、旧 parser、Catalog 依赖、
迁移专用常量和测试。正式 Config 的相邻 `schemaVersion` migration 仍然保留，不属于这条退役链。

当前分支尚未发布的 Provider Config Schema 直接修改为最终结构，不建立 `models[]` 的内部版本历史、不增加
相邻 schema migration，也不双读开发中的中间格式。只有正式发布后的格式变化才增加相邻 migration。

## Provider 与模型调序

设置页只允许拖动 Personal-only Provider。Built-in/Account Built-in Provider 保持 Built-in 顺序；
Personal 对它们的覆盖不改变位置。模型拖动只重排 `modelIds`；`builtinModelIds` 保持 ZCode/Account
Built-in 的管理顺序。模型拖动不修改 Model Config Rules 的优先级顺序。

## 不变量

- 领域层没有“Config Document”中间概念。
- Provider Overlay 是 ZCode Built-in -> Account Built-in -> Personal。
- Account Built-in 只处理 ZCode Built-in account Provider。
- Model Rules 是 Built-in + Personal，并作用于 Effective Provider。
- Sparse Rule 只存在于 Overlay 之前；Registry 只发布 `requireComplete` 成功后的静态完整 Config。
- 完整暴露的单个配置项整体替代；多层分别拥有成员的集合必须拆分数据结构并定义组合语义。
- UI 是否开放编辑与 Schema 是否允许表达相互独立；Personal Schema 不按 UI 可见性或字段来源增加禁写
  规则，手工配置只接受通用结构/完整性校验和请求期失败。
- 正常装配中 Built-in/Account Built-in 维护 `builtinModelIds`，Personal 维护 `modelIds`；这不是 Source
  字段权限系统，重名仍是显式冲突。
- Visibility 只控制用户 View。
- Access 与 API type 正交。
- API Key 可以保存在 Personal Config；账号与调用级动态凭据不进入 Config。
- Account Connection 产生当前账号、商品与 Team scope；`zhipu-account` Access 只固定执行所需的
  `family + mode`，请求期再验证当前连接是否兼容。
- Hidden Provider 不获得完整性或鉴权豁免。
- 模型能力和 Reasoning 只来自 Model Config Rules，不来自具体模型 hardcode。
- Legacy importer 只迁移明确旧事实、不猜能力，并在强制升级兼容窗口结束后整体删除；正常版本化 migration
  保留。
