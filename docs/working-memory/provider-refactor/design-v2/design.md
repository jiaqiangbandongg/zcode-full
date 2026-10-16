# Provider Refactor 核心设计

> 状态：现行设计
> 本文只描述最终架构与不变量，不复述迁移过程。历史来源与矛盾裁定见
> [`evidence-and-contradictions.md`](./evidence-and-contradictions.md)。

## 1. 目的

Provider 配置体系的唯一目的，是把用户对某个模型 API 的选择和配置，稳定地装配成一次可执行的模型调用。

它需要回答：

- 有哪些 Provider，每个 Provider 有哪些模型；
- Provider 使用哪种 API Schema、Endpoint 和访问方式；
- 模型具有什么静态能力，接受哪些选项，逻辑选项怎样映射到协议参数；
- 当前账号和用户配置怎样影响最终 Provider；
- 一次提交最终使用哪个 Provider、Model 和 Options；
- 配置更新、账号刷新和执行并发时，哪一份事实生效。

它不是统一凭据中心，也不是最终授权方。API Key Provider 可以直接保存 API Key；账号类型的 Provider Config
只描述静态访问类型，登录态 Token、Team Project Key、Start Plan JWT 和闲时 Ticket 等动态材料由账号与执行期服务取得。
模型服务端仍然对每次请求作最终鉴权和授权裁决。

## 2. 核心原则

### 2.1 一份配置事实，两条解析路径

Provider 和 Model 的配置分别解决不同问题，最后在同一个模型身份上汇合：

```text
Provider Config 路径                              Model Config 路径
====================                              =================

Provider Templates + Account Providers            ZCode Built-in Model Config Rules
                |                                                  |
                v                                                  +
      Account Provider Config                      Personal Model Config Rules
                |                                                  |
                v                                                  v
      Personal Provider Config                     Effective Model Config Rules
                |                                                  |
                v                                                  |
      Effective Provider Config                                 |
                |                                                  |
                +-----------------------+--------------------------+
                                        |
                                        | providerId / modelId /
                                        | api.type / baseUrl
                                        v
                              Effective Model Config
                                        |
                                        v
                         完整性、启用状态和执行资格判断
                              |                       |
                              v                       v
                    Provider Settings View      Provider Registry
                                                        |
                                                        v
                                                 ModelFactory
                                                        |
                                                        v
                                                不可变 Active Model
                                                        |
                                                        v
                                                    Adapter
```

Provider 路径决定“最终有哪些 Provider、成员模型是谁、如何访问 API”。Model Rule 路径决定“模型有什么能力、
选项和协议映射”。不得为设置页、闲时任务、连接测试或某种 Adapter 再复制一套模型能力事实。

### 2.2 Overlay 是稀疏意图，Effective 是解析结果

Provider 的生效顺序固定为：

```ts
effectiveProviders = resolveProviderTemplates(
  zcodeBuiltinProviderTemplates,
  zcodeBuiltinAccountProviders.overlay(accountProviders),
  personalProviders,
);
```

- ZCode Built-in 提供普通 Provider Template 与 Account Provider 静态基线；
- Account 只投影账号连接与套餐造成的动态约束；
- Personal 最后生效，表达用户显式配置；
- `undefined` 表示本层不覆盖，`null` 表示本层显式清除，具体值表示显式覆盖；
- Overlay 自身可以不完整，只有进入 Registry 的 Effective Config 必须完整。

Model Rules 全部是有序 Overlay。Builtin 的有效顺序为：

```text
modelRules
    -> modelApiRules
    -> providerSiteRules
    -> templateModelRules
    -> builtinProviderModelRules
    -> Personal providerModelRules / manualProviderModelRules
```

其中 `providerSiteRules` 按具体 Base URL 匹配站点行为，`templateModelRules` 按
`templateId + modelId` 匹配模板成员和默认 `enabled`，两者不是同一种身份匹配。
Personal Config 只允许具体 `providerId + modelId` 的精确覆盖，不再提供、读取或写出 Personal 全局 Match Rules。
所有规则继续保持数组书写顺序，不引入动态优先级算法。

### Match 配置维护原则（2026-09-10 裁决）

- Built-in Match 以主流配置和官方能力为依据，官方优先；不为了落后或不完整的第三方兼容实现，降低已知模型的默认能力。
- 已知模型在相应 API Schema 下支持的能力，写入模型／模型 API 规则，沿用前后缀匹配。不能仅因为通过第三方代理访问就默认关闭；代理不支持时，用户通过具体模型的 Personal 配置覆盖关闭。
- 官方优先不等于同品牌所有型号都支持：不同型号、API Schema 的明确支持边界必须保留，不能把某型号能力用宽泛品牌正则授予全部型号。
- 站点专有行为写入 `providerSiteRules`，按“一具体 Base URL 一条规则”维护；不同域名或 endpoint 不用正则 alternation 合并。同一 URL 可在一条规则中声明多项已经确认的能力；因模型／API 条件不同而必须拆分的规则仍分别保留。
- 同一 URL 的规范化等价形式（例如尾斜杠）可以在同一规则处理，但不能借此放宽到整站所有路径或任意子域。
- 能力继续经统一 Overlay/Resolver 形成最终 Model properties；不在 Runtime 恢复按模型名或域名猜测能力的旁路。迁接旧行为时分别核对各项能力，不能把删除旧判断误作取消原有能力。

### 2.3 Builtin Provider 维护清单

Builtin 的维护范围用一张简短的入口库存表表达，不在文档中重复抄写完整 Provider Config，具体内容见
[`Builtin Provider 维护清单`](./builtin-provider-inventory.md)：

```text
供应商 | 类型 | templateId / providerId | Base URL | 产品维护模型
```

- 普通 API 入口填写 `templateId`；Account 入口填写具体 `providerId`。
- 表中模型就是产品主动维护的模型；Template 的 `builtinModelIds` 是配置中的对应事实。
- 不额外维护模型展示名、模型所属 Template 的重复字段或 Provider Site Catalog。
- 供应商目录中未出现在表内的历史模型不进入 Builtin Template，也不做兼容迁移。
- URL 特殊规则只在配置中作为 `providerSiteRules` 存在；它不是另一份供应商清单。

### API Schema 选择原则

同一供应商可能同时提供多种 API Schema。官方模板统一优先选择 Anthropic Messages；只有供应商或具体模型/Endpoint 不支持
Anthropic 时，才选择该入口实际支持且验证最充分的其他 Schema。这个判断以模板实际请求证据为准，不以
“OpenAI-compatible”等宣传标签推断。若同一站点不同模型必须使用不同 Schema，则拆分模板身份，或先提出明确的每模型 API
配置设计；不得把不同协议模型塞进一个固定 `api.type`。模板确定的 Schema 仍可按既定 overlay 顺序被更具体的配置覆盖。

### 聚合 Provider 的模型清单原则

聚合服务商的模型清单可以参照上游供应商的维护清单：上游已经维护的模型，只要聚合站点实际提供，就应纳入聚合入口。
例如当前 OpenRouter 的模型 ID 可能写成 `openai/gpt-5.6-sol`，而上游模型 ID 是 `gpt-5.6-sol`；这只是该聚合服务商当前的
清单和命名对应关系，不表示所有聚合服务商都必须带前缀，也不要求运行时先剥掉前缀再解析。聚合入口仍然维护自己的 Model/API/Site
配置，因为同一个模型经过聚合站点后，协议、能力和参数映射可能不同。

### 2.3 Sparse 与 Complete 必须分开

写入边界接收稀疏 Config；执行边界只接收经过完整性证明的类型。完整类型是同一份 Config 的类型收窄，
不是另一套 DTO，也不是第二个 Registry。

Model 的字段以 `@zcode/shared/model-config` 的完整数据 schema 为唯一来源；稀疏 schema 从同一字段派生
缺省/null 覆盖语义。构造输入、JSON 输出及 Registry 完整类型使用 schema 推导，行为类只保留冻结、overlay
和序列化行为。完整性检查复用该 schema，不再手写第二份字段/值域检查表。纯数据 schema 不引用行为类，
避免 codec 与类之间循环依赖。Provider/API/Access 同样由 `config/provider-data-schema.ts` 提供单一数据合同；
CLI 的 ModelProperties/OptionSpecs 类型及协议媒体字段投影同样从共享 Model schema 派生，
不反向依赖 Provider 行为实现。共享层只依赖纯表达式编译器，不包含状态或 IO。
Provider 完整性只加强已有执行必填项，不要求所有展示/成员字段必填，来源写权限通过同一 schema 派生。
Personal 暂存未完成 endpoint 的边界保留，坏地址只阻断该 Provider 的 Registry 准入。规则由 `rule-data-schema.ts` 按来源派生；数据文件不带内存层标识 `type`，也不根据字段有无重新猜规则层次。

```text
Sparse Config / Rules
        |
        v
      Resolver
        |
        +--> Resolved candidates + issues  -> Settings
        |
        `--> Complete executable configs   -> Registry
```

不完整、禁用或暂不可执行的 Provider/Model 可以保存并在设置页显示；它们不能进入可执行 Registry。

### 2.4 身份、能力、状态和展示正交

- `providerId + modelId` 是模型身份；同一 `modelId` 可以存在于不同 Provider。
- Provider 顶层没有 `enabled`；Personal 定义存在即属于 Settings，Account Provider 固定属于对应 Family。
- 完整性表达是否具备构造执行对象所需事实。
- `executable` 由 Account Access 权益（账号类型）、Provider 完整、Model 启用和 Model 完整共同决定。
- `selectable` 在 `executable` 基础上再受 Provider `visibility` 影响。
- `visibility` 是 Provider 的展示投影，不是权限、鉴权或完整性豁免。
- Model 没有独立 `visibility`；Model 是否出现在普通选择中由其执行资格和 Provider 可见性共同决定。

### 2.5 已创建的 Model 是执行事实

Registry 是创建 Model 的目录，不是一次执行过程中持续回读的可变状态。ModelFactory 从目标 Environment 的当前
Registry 取得完整 Provider/Model 配置并创建不可变 Model。之后 Config 或 Registry 更新只影响后来创建的 Model，
不静默改变已经运行的请求、Compact、Memory 或子 Agent。

## 3. 配置契约

### 3.1 Provider Config

Provider Config 的正式字段是：

```ts
interface ProviderConfig {
  group?: "standard-personal" | "zai-family" | "bigmodel-family" | null;
  logo?: { type: "builtin"; key: string } | null;
  access?: ProviderAccessConfig | null;
  api?: {
    type?: "anthropic-messages" | "openai-chat-completions" | "openai-responses" | null;
    baseUrl?: string | null;
    headers?: Readonly<Record<string, string>> | null;
  } | null;
  builtinModelIds?: readonly string[] | null;
  personalModelIds?: readonly string[] | null;
  modelOrder?: readonly string[] | null;
  visibility?: "visible" | "hidden" | null;
}
```

字段含义：

| 字段               | 含义                                                             |
| ------------------ | ---------------------------------------------------------------- |
| `group`            | Personal 或 Account Family 分组；不是 Access Mode                |
| `logo`             | 展示资源 key，未知 key 回退通用图标                              |
| `access`           | 调用所需访问材料的静态取得方式                                   |
| `api`              | 最终 API Schema、Base URL 和静态 Header                          |
| `builtinModelIds`  | ZCode 或 Account 层拥有的模型成员                                |
| `personalModelIds` | Personal 层拥有的模型成员                                        |
| `modelOrder`       | 用户对最终成员集合表达的总顺序意图                               |
| `visibility`       | Provider 是否进入普通设置/选择投影；不影响内部精确 Registry 查找 |

成员集合保留来源：Built-in 成员在前，Personal 成员在后；单集合内重复只保留第一次；Personal 与 Built-in
同名时保留 Built-in 身份并丢弃 Personal 重复项。`modelOrder` 只排序已存在成员，不创造模型。

实例外层规则为 `{ providerId, templateId?, providerName?, config }`；模板为
`{ templateId, templateNameMap, config }`。身份、继承关系和名称不是 Config 叶子。
模板创建时按当前语言 → en-US → templateId 生成实例名称，并在 Personal 文件锁内去重。
之后只改连接字段不写继承名称；显式改名才写外层 `providerName`，语言变化不改已保存名称。

### 3.2 Provider Access

正式 Access 联合类型只有两种：

```ts
type ProviderAccessConfig =
  | {
      type: "api-key";
      apiKey?: string | null;
      apiKeyManagementUrl?: string | null;
    }
  | {
      type: "zhipu-account";
      accountType?: "zai" | "bigmodel" | null;
      mode?: "start-plan" | "individual-coding-plan" | "team-coding-plan" | "off-peak" | null;
      entitled?: boolean | null;
    };
```

`group`、`accountType` 和 `mode` 不重复：

- `group` 是 Provider 的静态产品分组；
- `accountType` 是智谱账号体系的访问身份；
- `mode` 是该账号 Provider 的访问模式。

`entitled` 是当前账号是否具有该固定 Account Provider 产品资格的唯一配置事实。Provider 顶层不存在 `enabled`。
`zhipu-account` Config 不保存账号连接 ID、商品 ID、组织/项目 Scope、Token 或请求安全校验协议。账号运行协议中仍可有
`planKind`、`productId` 等字段，但它们属于账号、套餐或请求期上下文，不是 Provider Config Schema。

### 3.3 Model Config

```ts
interface ModelConfig {
  enabled?: boolean | null;
  properties?: {
    requiresMfjsToolSchema?: boolean | null;
    contextWindow?: number | null;
    inputFormat?: {
      supportsText?: boolean | null;
      supportsImage?: boolean | null;
      supportsVideo?: boolean | null;
      supportsAudio?: boolean | null;
      supportsPdf?: boolean | null;
    } | null;
    outputFormat?: {
      supportsText?: boolean | null;
    } | null;
    supportsToolCall?: boolean | null;
    supportsJsonSchemaOutput?: boolean | null;
    supportsNativeWebSearch?: boolean | null;
    supportsMidConversationSystem?: boolean | null;
  } | null;
  optionSpecs?: {
    reasoningLevel?: EnumOptionSpec | null;
    maxOutputTokens?: LimitOptionSpec | null;
  } | null;
}
```

这些字段从 Config、Registry、跨进程协议到 Active Model 使用同一名字和同一嵌套结构。Runtime 不派生
`supportsImages`、capability map 或另一份媒体 DTO。

Effective Model Config 必须补齐：

- `enabled`；MFJS 是 `properties.requiresMfjsToolSchema`，不在 ModelConfig 顶层重复保存；
- 完整 `properties` 及所有 input/output format 叶子；
- `maxOutputTokens` Option Spec 及其完整 `map`；
- `reasoningLevel` Option Spec 及其非空有序 `values`、完整 `map`；不支持推理的模型使用
  `values: ["disabled"]` 与空 Patch `map: "{}"`。

`reasoningLevel` 的字段仅为 `values`/`map`，`maxOutputTokens` 仅为 `max`/`map`；成员名已经确定选项形态，
不再持久化重复的 `type: "enum"/"limit"`。这不影响 Provider API/Access 的联合类型 discriminator。

具体模型的 reasoning 行为只能由 Model Config Rules 表达，生产 Runtime 不按具体模型 ID 硬编码思考强度、
请求补丁或重放策略。每个 Option Spec 的受限 CEL `map(value)` 直接生成最终原始 Request Body 的 JSON Merge
Patch；Adapter 只在 AI SDK 生成基础 Body 后、请求安全校验前应用同一映射，并负责协议编码与其真实编码能力边界。

### 3.4 Model Config Rule

规则所属集合明确表达层次；文件内各记录不再重复 `type`：

| 集合                              | 匹配身份                                     | 内容                                   |
| --------------------------------- | -------------------------------------------- | -------------------------------------- |
| modelRules                        | modelMatch                                   | 稀疏 ModelConfig                       |
| modelApiRules                     | modelMatch + apiTypeMatch                    | 稀疏 ModelConfig                       |
| providerSiteRules                 | modelMatch + baseUrlMatch，可选 apiTypeMatch | 稀疏 ModelConfig                       |
| templateModelRules                | templateId + modelId                         | 稀疏 ModelConfig                       |
| builtinProviderModelRules         | providerId + modelId                         | 稀疏 ModelConfig                       |
| Personal providerModelRules       | providerId + modelId                         | 智能配置的精确覆盖                     |
| Personal manualProviderModelRules | providerId + modelId                         | 完整手动配置，仅 enabled 允许继承/null |

三种 Match 的严格 schema 拒绝越层条件及 `providerMatch`。正则整串匹配，模型名忽略大小写，URL 使用规范化值；各集合数组顺序保持。
同身份不能同时处于智能/手动集合。手动配置不继承其他参数，仅保留 enabled 的既有独立启停语义；保存时所有必需嵌套叶子及表达式共同校验。

## 4. 解析、设置投影与 Registry

### 4.1 Resolver 是唯一汇合点

Resolver 负责：

1. 只允许 Account Overlay 作用于 ZCode Built-in Provider；
2. 计算 `Built-in -> Account -> Personal` 的 Effective Provider；
3. 组合 Effective Model Rules；
4. 解析最终模型成员、来源和顺序；
5. 为每个 `providerId/modelId/api.type/api.baseUrl` 解析 Effective Model Config；
6. 分别计算 issues、enabled、entitled、executable 和 selectable；
7. 同时产出设置候选和 Registry 可执行集合。

Renderer、Usage UI、套餐卡、ModelFactory 和 Adapter 都不得重新实现这套 Overlay 或成员推导。

### 4.2 Settings View 与 Registry 是同一解析的两个投影

```text
                    ProviderConfigResolution
                      /                 \
                     /                   \
       resolvedProviders                 registryProviders
       完整 + 不完整候选                  仅完整可执行项
              |                                  |
              v                                  v
    Provider Settings Facade               Provider Registry
```

Settings View 需要保留：

- Effective Provider；
- Account 生效后的 Built-in 基线；
- Personal Provider Overlay；
- 每个模型的 Effective、Effective Built-in 与 Personal 精确覆盖；
- 完整性问题和执行状态。

因此设置页可以编辑或修复尚未进入 Registry 的配置。Registry 只保留启用、完整且至少拥有一个可执行模型的
Provider，以及其中可执行的模型。

### 4.3 Account Provider Config

Account Provider Config 是正式 Provider Overlay，但它只投影账号上游事实对 Built-in 账号 Provider 的影响：

```text
账号登录、Family 选择、套餐选择、权益接口
                    |
                    v
       Account Connection Resolver
       ├─ providerId
       ├─ entitled / not-entitled / unknown
       `─ 服务端明确返回的账号模型集合
                    |
                    v
         Account Provider Config
       └─ access
          ├─ type / accountType / mode（继承 Built-in）
          ├─ entitled
          `─ builtinModelIds（若服务端返回）
```

具体规则：

- Account Provider 由 Built-in 固定声明并进入对应 Family；
- 当前账号明确拥有该产品时写 `access.entitled=true`，明确无资格时写 `false`；
- Individual / Team 默认沿用 Built-in 模型成员；
- Start Plan 的模型因账号而异，成功时使用接口返回的模型集合约束 `builtinModelIds`；
- Start Plan 没有可靠模型集合时保留上一份可用 Account Overlay；首次无可用事实时 fail-closed；
- 临时查询失败的 `unknown` 保留上一份 Account Overlay，避免抖动；首次无历史事实时 fail-closed；
- 动态凭据不写入 Account Provider Config。

Account State 的可选 `unavailableReason` 随同一份快照传递，Host 与 CLI 的严格协议复用 shared 原因 schema。
个人套餐服务端明确无权益显示未开通；已登录但获取 Key 失败显示获取失败并复用手动刷新重试，不能仅凭缺 Key
推断 OAuth 失效或强制重新登录。Z.ai 与 BigModel 使用一致分类。原因只属于运行态事实，不写 Provider Config；
具体裁决与验证见 [Todo114](../steps/todo-114-account-status-sync-and-key-retry.md)（上游原 Todo105）。

Account 与 Built-in revision 必须配对。Built-in 更新而 Account 仍基于旧 revision 时，Registry 继续服务上一份完整快照，
等待 Account Source 重算后原子发布，不能发布“新 Built-in + 旧 Account”的中间态。

### 4.4 设置页不理解 Account Overlay

设置页直接消费 Provider Settings View 中的最终 Effective Provider/Model；它不读取、重放或推断 Account Overlay。
套餐、额度、连接错误和购买状态是独立产品投影，只能控制状态卡及相应操作，不能决定 Effective Provider 配置区、
模型列表或模型编辑入口是否存在。

Individual / Team Coding Plan 可以在产品 UI 中隐藏 Endpoint 和 API Schema，但这些字段仍完整存在于 Effective
Provider Config，并被 Registry、ModelFactory 和 Runtime 消费。隐藏是展示决策，不是删字段后的 Account DTO。

这项页面收口已由 Todo 32 完成：Team / Individual 详情按 `providerId` 从 Provider Settings View 精确解析；套餐状态卡
不再控制 Provider 配置区和模型列表是否存在；页面隐藏 Endpoint/API Schema 时不删减 Effective Provider Config。

### 4.5 Start 独立 Provider（Todo154）

2026-09-16 用户完成逐层裁决：Start 复用当前 App 登录，免单独连接，与当前个人／团队套餐同时可用；不启动 Todo101 的个人／多团队全面并存。

- 保留两家 Start Provider ID，统一显示名称，logo 各自沿用 Z.ai／BigModel。按当前品牌过滤，在现有“智谱”分组独立展示，复用详情，只去掉连接／断开。无虚拟 Provider、ID 合并或展示身份映射。
- 保留 current，解释为匹配当前账号访问上下文。Start 不依赖付费 selection；个人／团队仍依赖当前付费选择。允许 Start 与一个付费套餐同时 current=true；权益、模型完整性、启用及请求凭据独立校验。Start connectionKey 不包含付费选择。
- Start 按保存的 Provider ID／modelId／options 解析，退出唯一当前付费连接映射；个人／团队继续原映射。Start 失效或跨品牌后不自动替换 Provider。
- Start 请求直接复用当前对应品牌登录的 zcodeJwtToken，解除 selection.kind 必须等于 Start 的条件；保留原鉴权，不复制 token、不新增切账号竞态校验或中断机制。
- 不迁移模型数据，不建立升级连接快照、额外迁移版本或全库转换。旧 kind:start-plan 保持可读而不控制 Start 执行；不再写此值启用 Start。首次付费初始化保持原顺序，旧值不得被当成新用户空态误选套餐。
- 提交／创建时，若当前为付费套餐、同模型在 Start 有明确可用额度且思考选项兼容，提示“切换套餐／不了”和“不再提示”。切换只修改当前入口的模型选择，再继续原提交／保存，不改变全局付费连接；未知额度不阻断原提交。
- 推荐覆盖对话新提交、定时任务创建／修改模型保存、Wiki 手动新生成，以及自定义 Subagent 保存、内置／插件 Subagent 显式模型的即时保存。继承／默认不变。Bot、立即运行、后台触发／执行、闲时、已提交队列执行、原请求重试及 Wiki 失败页补齐不提示；保存并运行仅在保存阶段提示一次。
- 不再提示是当前 App／Host 的统一持久化偏好，跨入口和重启生效，同 Host 手机遵守，不增加跨设备账号云同步；只关闭推荐，不指定默认套餐、不改其他入口模型，下次仍按各入口保存的选择执行，不屏蔽实际额度／凭据错误。
- Start 保留现有额度横幅与不可用反馈；全局连接失效通知只观察个人／团队，保留付费间建议，删除通过写 Start 连接来切换的动作。

普通 Session／草稿已有提交写回，Automation／显式 Subagent 长期配置不一定回写。不迁移是已确认的新行为选择，不表示所有旧配置的有效结果都不变；具体证据与撤回的全量迁移推断见 [C25](./evidence-and-contradictions.md#c25-start-独立-provider-与现行单连接语义)。

本节目标已按 2026-09-16 的实施授权落地。完整按钮语义、入口矩阵、状态归属与验证证据由 [Todo154](../steps/todo-154-start-plan-independent-provider.md) 维护。Start 在共用 node facade 中按 ordinary 精确解析；推荐复用 UsageEntitlement 与 SettingService，偏好字段为 startPlanRecommendationDismissed。Built-in → Account → Personal、目标 Environment Registry、continuous／replayable 与原提交 owner 保持。

## 5. 选择、创建与执行

### 5.1 Model Selection 是稀疏用户意图

Model Selection 只保存：

```ts
interface ModelSelection {
  providerId: string;
  modelId: string;
  options?: {
    reasoningLevel?: string;
  };
}
```

它不复制 Endpoint、API Schema、能力、凭据、Provider Snapshot 或 Effective Config。提交时必须在目标 Environment 的
当前 Registry 校验；远程工作区不能在本地 Registry 预判后把本地执行事实发送过去。

### 5.2 ModelFactory 固定完整执行事实

```text
ModelSelection
      |
      v
目标 Environment Provider Registry
      |
      v
ModelFactory
├─ Provider API / Endpoint / Access
├─ Model properties / optionSpecs
├─ 默认与用户 options
├─ optionSpecs.*.map -> 最终原始 Request Body
`─ 本次请求依赖
      |
      v
不可变 Model
```

- API Key Provider 使用 Config 中保存的 Key；
- 智谱账号 Provider 在请求期通过账号访问服务取得当前动态凭据；
- Off-Peak 仍使用固定 Provider ID 表达精确产品身份，并以 `zhipu-account + mode=off-peak` 表达访问方式；
- 缺少动态访问材料时在网络请求前明确失败；
- Retry 可以刷新同一访问方式的动态材料，但不能改变 Provider、Model 或静态配置身份。

### 5.3 所有执行分支使用同一个 Model

正常请求、Compact、Memory、子 Agent 和 Off-Peak 都必须使用正式 Model/ModelFactory：

- Compact 使用本轮 Active Model，不回退到 Session 默认 Model；
- Memory 等异步工作保留创建它的 Model 或同结构不可变执行事实；
- 子 Agent 默认继承父 ModelFactory；显式选择时通过同一个 Registry 创建自己的 Model；
- Off-Peak 用标准 ModelSelection 和固定隐藏 Provider 精确创建 Model，不修改普通 Session Selection；
- 媒体 gating 读取 `Model.properties.inputFormat`，同时尊重 Adapter 的真实编码能力。

不存在 ModelRef、ModelConnectionPort、AI SDK 执行 Registry、Legacy Model Catalog、Runtime capability map 或
为特殊执行建立的第二个 Registry。

## 6. 状态所有权与提交边界

模型选择必须区分四种状态：

```text
Composer Draft Selection
        |
        | 提交时原子冻结
        v
Submission Selection
        |
        v
Session Current Selection
        |
        | 创建本次执行
        v
Active Model
```

- Composer Draft 是未提交草稿；
- Submission Selection 是本次用户提交接受的精确选择；
- Session Current Selection 是后续默认；
- Active Model 是已经创建并冻结的执行事实。

队列、Guide 步骤、恢复和模型切换不得把这四层合并。Off-Peak 等辅助执行也不得借机修改 Session Current Selection。

Guide 携带选择时仍通过现有 Factory 重新解析并创建 Model，保证配置更新用于后续请求。
切模前缀重建仅比较当前 Loop 与新执行 Model 的 Provider、模型、推理档位；对象重新创建或
输出上限变化不等于切模。Session 选择事件仍比较提交前后的 Session，不能代替 Loop 比较。
本轮不改变真实切模的输出风格冻结行为，也不改变 Guide admission/归属与多端传输。

## 7. Environment、刷新与持久化

### 7.1 执行 Environment 拥有自己的事实

每个真正执行模型的 Environment 拥有自己的：

- ZCode Built-in Config Source；
- Personal Config Repository；
- Account Provider Source；
- Resolver、Registry 和 ModelFactory。

Local、SSH、WSL、Docker 或 Server 由各自 Host/Worker 读取本环境配置。Host 不向 Worker 发送 Registry Snapshot，
也不让 Renderer 成为配置权威。Remote Provisioning、远程编辑和登录同步是独立产品能力，不属于 Provider 核心重构。

### 7.2 Config 更新必须原子、自愈

- Repository 使用版本外壳、原子写入、文件锁和 revision；这些是存储实现，不是 Provider 领域中的 Config Document。
- Source watcher 只通知“事实可能变化”；Registry Service 重新读取完整 Config 与 Account 快照后一次性解析发布。
- 刷新期间继续服务上一份完整 Registry；失败不发布半成品，后续事件必须能够自愈重试。
- Built-in 远端发布使用两层结构：版本/刷新元数据外壳 + 纯 Provider/Model Config 内容。
- Built-in 活跃缓存按 ZCode Endpoint 隔离，避免不同 Environment 复用错误配置。
- 设置写入完成后，执行入口必须观察到对应 Environment 的新 Registry；连接测试应通过正式 Host
  Registry/ModelFactory 创建模型，不能在 Renderer 临时拼装另一个 Model。

### 7.3 Config 名称与物理外壳

领域名称固定为：

- ZCode Built-in Provider Config；
- Account Provider Config；
- Personal Provider Config；
- Effective Provider Config；
- ZCode Built-in Model Config Rules；
- Personal Model Config Rules；
- Effective Model Config Rules；
- Effective Model Config。

不使用 `Official Config` 作为现行别名，也不把 `Document` 建成领域中间态。`schemaVersion`、`revision`、远端刷新时间和
文件迁移只属于发布或 Repository 外壳。

最终 Builtin 文件为 `{ schemaVersion: 1, revision, config }`：config 内
`providerConfigRules` 包含 `templateRules/providerRules`，`modelConfigRules` 包含上述五个 Builtin 集合。
Personal 文件为 `{ schemaVersion: 1, config }`：config 内 `providerConfigRules.providerRules`、
`modelConfigRules.providerModelRules/manualProviderModelRules` 均必需（可为空），另有可选 `providerOrder/defaultModelSelection`。
默认选择适配器复用同一个 Personal Repository，不再独立文件、锁或 watcher。普通字段更新保留未修改成员；
全量分发替换整份 config，缺省默认选择即清除。分发失败按整份文件 CAS 回滚，用户期间改写的新内容不得覆盖。

环境配置目录中的程序维护文件统一为：

```text
runtime/provider/
  <platform>/<appVersion>/<endpoint-key>/
    zcode-builtin.json
    zcode-builtin-refresh.json
  provisioning.json
  bundled/zcode-builtin.json
```

随包副本固定路径，内容相同复用、变化原子替换；下载/刷新仍三维隔离。升级以退出旧进程为前提，不保留 hash 历史副本。
运行时 Builtin revision 包含 Active 规范化路径范围及发布序号，Host 与读取该路径的 Worker 一致；
不同 Endpoint 同序号不再被 Registry 误去重。磁盘发布序号继续单调，同来源同序号必须同内容。
刷新记录、分发状态和分发信封的 schemaVersion 也为1；Bot 仍保留现有 version3，不纳入重置。

## 8. 设置写入与交互边界

- 设置页通过 Facade/Hooks 读取 Provider Settings View，不直接访问 Repository。
- 编辑 Draft 属于 Renderer；保存由 Host 的 Provider Config Service 原子执行。
- Built-in Provider 的静态字段可以展示为只读；Personal Overlay 只写用户明确改动。
- Provider/Model 重命名、创建、删除和排序是显式领域操作，普通保存不承担创建或复活语义。
- 同一 Provider 的写操作串行化；Model Draft 以 revision 防止迟到保存覆盖新编辑。
- 连接测试先保存当前 Draft、等待正式 Registry 更新，再通过 ModelFactory 发起真实协议探测；它作为
  低成本辅助请求使用 `reasoningLevel.values[0]`，并显式使用
  `min(5000, optionSpecs.maxOutputTokens.max)`。
- 保存、连接成功或失败的反馈属于当前 Provider 详情列的底部横幅；同一操作的新状态替换旧状态，不能被长模型列表推离
  当前窗口。具体视觉交互不改变 Config 或 Registry 权威。

## 9. 兼容与删除边界

允许存在的兼容只有明确的一次性边界：

- 旧 Personal Config importer 可以读取已发布历史字段，并立即投影成新 Personal Overlay；
- 历史账号、商品和 Usage 协议可以继续使用自己的 `planKind/productId`，但不得重新进入 Provider Config；
- Adapter 内部可以使用协议局部 helper，但不得把旧 capability 类型重新暴露成 Model 事实源。

正式 Config、Registry、Model 和 Runtime 中禁止重新出现：

- `Official Config` 双轨；
- `ProviderConfigDocument` / `ModelSelectionConfigDocument` 领域对象；
- `request-auth` / `execution-provided` Access；
- `accessId`、静态 `planKind`、`challenge`、`requestSigning`、`executionProtocol`；
- `executionOnly` 或“受信执行”逃逸开关；
- Model `visibility`；
- `adapterCompatibility`、`reasoningReplay` 和具体模型 Runtime hardcode；
- `modalities`、平铺 `supportsImages/Pdf/Video` 或第二套 capability DTO；
- `ModelRef`、`ModelConnectionPort`、Legacy Catalog/Preset 和第二个执行 Registry。

## 10. 核心不变量

1. Provider 静态事实只有 ZCode Built-in、Account Overlay 和 Personal Overlay 三层来源。
2. Model 静态事实只有 ZCode Built-in Rules 与 Personal Rules；Personal 在后，精确 Personal 最后。
3. Effective Model Config 必须在 Effective Provider 的 API 上下文中解析。
4. Settings 与 Registry 来自同一次 Resolver 解析；Settings 不从 Registry 反推不完整配置。
5. Registry 只含完整可执行项，但 hidden Provider 仍可被内部精确执行。
6. Account Overlay 只约束 Built-in 账号 Provider；Start Plan 的模型集合可以因账号而异。
7. 动态账号凭据不进入 Config；API Key Config 可以持有 API Key；最终授权由服务端决定。
8. ModelFactory 只消费当前 Registry 的完整配置；Active Model 创建后冻结。
9. Provider/Model 身份始终是 `providerId/modelId`，不能只按 modelId 路由。
10. 产品 UI、套餐卡、Usage 和连接错误不得成为 Provider/Model 配置事实源。
11. 不为 Off-Peak、连接测试、Compact、Memory、子 Agent 或远程执行建立第二套模型事实。
12. 当前代码若与已裁决设计不同，应视为实现漂移，而不是新的隐式设计。

## 11. 尚未完成但不改变设计的工作

### Provider 启动/读取边界（Todo128）

`ProviderRuntime`、`NodeProviderConfigRuntime`、`NodeProviderRegistryRuntime`、
`ProviderRegistryService` 及 Services 的 Config 转交层统一 `start(): Promise<void>`。
它只等待首次就绪并保留既有去重/失败重试/释放；不返回供业务长期缓存的启动快照。
业务显式读取 `configService.read()` 或 `registryService.getSnapshot()`，显式刷新仍走
`refresh()`。当前指最近已完成状态，不隐式等待将来的账号请求。闲时资格与派发沿用同一
Registry-backed 凭据解析，不新增状态 owner。

### 其他待办

- Todo 15：历史发布验证范围记录，已废弃，不再作为独立 Todo；
- Todo 19：历史 Built-in Release 门禁讨论，已废弃，不再作为独立 Todo；
- Todo 22：新增 Built-in Provider 与云平台 Access，仍是草案；
- Todo 11 / 11A：Runtime 组合清理草案与释放问题，不能在未裁决前改变本设计；
- 与最新 `origin/staging` 的最终集成和真实产品验证。

这些事项可以补充验证、产品投影或实现清理，但若要改变本文的配置层级、Access Schema、Registry 权威或 Model
生命周期，必须先形成新的明确裁决并更新本文。
