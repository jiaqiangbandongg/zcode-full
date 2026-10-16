# Provider 与 Model 配置体系综述

> 状态：当前决策综述；不替代各专题设计中的精确字段契约
>
> 最近更新：2026-09-01

本文用一条完整叙事说明 ZCode Provider 与 Model 配置体系已经确认的产品和领域决策。它只回答“系统是什么、各项
事实属于哪里、最终怎样生效”，不描述旧代码如何迁移，也不保存实施步骤。

## 1. 系统最终要完成什么

Provider 与 Model 配置都服务于同一个目标：帮助用户封装一次模型 API 调用。

```text
Provider Config 路径                         Model Config 路径
====================                       =================

ZCode Built-in Provider Templates          ZCode Built-in Model Config Rules
        + Account Providers                             |
              |                                         +
              v                            Personal Model Config Rules
Account Built-in Provider Config                        |
              |                                         v
              v                            Effective Model Config Rules
    Personal Provider Config                            |
              |                                         |
              v                                         |
    Effective Provider Config                           |
    ├─ identity / template / group                     |
    ├─ API schema / Endpoint                           |
    ├─ Access                                           |
    ├─ visibility                                       |
    ├─ Built-in / Personal model members                |
    └─ model order                                      |
              |                                         |
              +-------------------+---------------------+
                                  |
                                  | providerId / modelId /
                                  | api.type / baseURL
                                  v
                       Effective Model Config
                       ├─ enabled
                       ├─ properties
                       ├─ optionSpecs
                       │  └─ per-option raw-body map
                       └─ 必要的请求编码事实
                                  |
                                  v
                    Provider / Model 完整性校验
                                  |
                                  v
                         Provider Registry
                                  |
                                  | ModelSelection
                                  v
                            ModelFactory
                                  |
                                  v
                           Model -> Adapter -> API
```

左路回答“当前 Environment 最终有哪些 Provider、每个 Provider 有哪些模型、怎样访问服务”；右路回答“某个模型
具有什么能力、可选择什么参数、这些参数如何映射到目标 API”。两路只在最终模型解析时汇合，不互相冒充。

最终调用所需的访问材料可能直接来自 Config，也可能在请求期取得。账号类型的 Provider Config 不管理账号动态凭据；
账号连接与请求鉴权服务在执行期提供材料，服务端仍负责最终授权。普通 API Provider 可以在 Personal Config 中直接
保存 API Key。

## 2. 五个配置输入来源

系统只有五个配置输入来源：

| 来源                              | 含义                                                          |
| --------------------------------- | ------------------------------------------------------------- |
| ZCode Built-in Provider Config    | ZCode 发布的 Account Provider，以及可复用的 Provider Template |
| Account Built-in Provider Config  | 当前账号对 Built-in 账号 Provider 的进一步约束                |
| Personal Provider Config          | 用户创建的 Provider，以及用户对已有 Provider 的最终覆盖       |
| ZCode Built-in Model Config Rules | ZCode 发布的模型静态事实和 API 映射                           |
| Personal Model Config Rules       | 用户对模型事实的稀疏后置覆盖                                  |

每个来源都有自己的严格输入 Schema。五个 Schema 负责约束“这个来源可以写什么”，但进入领域解析后仍使用共同的
Provider Config、Model Config 与 Overlay 语言；不建立五套 Runtime 类型。

Provider Overlay 顺序固定为：

```text
Provider Template? -> ZCode Built-in Account Provider? -> Account Overlay? -> Personal
                                                                      |
                                                                      v
                                                       Effective Provider Config
```

因此 Personal 永远是最终用户覆盖。Account 的职责只是进一步约束 ZCode Built-in 中账号相关的 Provider，不读取、
修改或约束 Personal-only Provider。

Model Rules 的关系不是三层 Provider Overlay，而是两个有序数组的拼接：

```text
ZCode Built-in Model Config Rules
                  +
Personal Model Config Rules
                  |
                  v
Effective Model Config Rules
```

Personal Rules 排在后面。每条 Rule 只覆盖自己明确提供的配置项；Rule 不负责创建模型成员。

Overlay 是一套自然、可复用的配置合成语义与机制：它规定同一配置槽位如何在多层输入之间继承、覆盖和清除。
Provider/Model 领域利用这套机制实现自己的领域语义，并自行定义配置空间、成员构成、默认状态和生命周期操作。Overlay
不是能够自然表达一切业务语义的万能抽象；配置结构必须服从领域模型，不能由 Overlay 的现成能力反向塑造产品语义。

## 3. Built-in 的准确含义

`Built-in` 只表示该 Provider 或 Model 成员由 ZCode 内置事实提供，不表示：

- 使用 ZCode 账号；
- 已经拥有访问权限；
- 已经配置凭据；
- 默认启用；
- 一定出现在模型选择器。

Provider Template 不是 Provider，也没有 `providerId`、`group`、执行状态或 Registry 身份。它只是在创建 Personal
Provider 时提供可复用的 Built-in 继承基线。Template 使用领域壳保存自身 `nameMap` 与内部 `config` Overlay；
Model Config Rules 继续集中维护，不进入该壳。真正的 Provider 根只有 Account Built-in Provider 和 Personal Provider。
Account Provider 使用显式 `group` 表达 Family；普通 Personal Provider 固定使用 `standard-personal`。

这里必须区分稀疏输入与完整结果：

```text
Provider Template
└─ 以 templateId 为键；不声明 group，也不进入 Registry

Account Built-in Provider 根声明
└─ group = zai-family | bigmodel-family

Personal Provider 根声明
├─ group = standard-personal
└─ templateId? 指向可选的 Built-in Template 基线

Account / 已有 Provider 的 Personal Overlay
└─ 不提供 group，也无权改变它

Effective Provider / Registry / Settings DTO
└─ group 必须是完整值
```

所以 Provider 不再保存额外 `builtin` boolean，也不存在 `standard-builtin` Concrete Provider。Settings View 直接返回
准确的 `templateConfig?`、`effectiveBuiltinConfig?`、`personalConfig?` 与 `effectiveConfig`，Renderer 不按 ID 或分组猜来源。
Model 的 Built-in 来源也不写进 Model Rule；Host 根据成员来自 `builtinModelIds` 还是 `modelIds` 产生展示与操作所需的
派生来源。Built-in 与 Personal 同 ID 时只形成一个 Built-in 成员。

## 4. Provider Config 负责什么

Provider Config 负责模型 API 调用的 Provider 侧装配事实：

```text
Provider Config
├─ providerId / templateId? / group / label / logo
├─ visibility
├─ api.type / baseURL / static headers
├─ access
├─ builtinModelIds
├─ modelIds
└─ modelOrder
```

`visibility=hidden` 只隐藏普通 Settings 与 Selection；配置完整且启用的 hidden Provider 仍可由内部产品通过普通
Registry 和 ModelFactory 精确使用。系统不保存 Provider `selectable`。

Provider 顶层没有 `enabled`。Personal Provider 一旦创建，其定义就固定留在 Settings；配置不完整时仍可继续编辑，只是
不会进入可执行 Registry。Account Provider 固定进入对应 Family，账号资格只由 `zhipu-account access.entitled`
表达。Model 的执行开关仍由 Model Config `enabled` 表达。

## 5. 模型成员、启用和顺序

Provider 中的三个模型数组各自只有一个含义：

```text
builtinModelIds
└─ ZCode Built-in 或 Account Built-in 管理的成员

modelIds
└─ 用户管理的 Personal 成员

modelOrder
└─ 用户整理后的完整显示顺序
```

成员只来自 `builtinModelIds + modelIds`。`modelOrder` 不能创建或启用成员；Model Config Rule 也不能创建成员。

Built-in 与 Personal 成员同 ID 时 Built-in 优先。单个数组内重复 ID 时保留第一次出现。读取时确定性忽略重复后项，
不建立冲突对象；正常设置页禁止用户写出重复，下一次保存相关 Provider 数组时顺手规范化。

模型启用属于 Model Config 的 `enabled`。Built-in 通用 Rule 提供完整默认值；具体 Built-in Rule 可以把淘汰或不建议
继续使用的旧模型默认设为 `false`；Personal 专属 Rule 排在 Built-in Rules 之后，可以只覆盖某个 Provider/Model 的
`enabled` 叶子。停用模型仍保留在 Settings 中，也保留自己的配置与排序，但不能执行、测试、fallback 或精确创建。

模型基础顺序统一为：

```text
未出现在 modelOrder 中的 Built-in
                +
modelOrder 中仍有效的成员
                +
未出现在 modelOrder 中的 Personal
```

正常设置页新建 Personal Model 时，会在同一次原子保存中更新 `modelIds`、完整 `modelOrder`，并创建该模型的
Personal 专属 Rule，明确写入 `enabled=true`。因此“未排序 Personal”只处理用户手写、不完整或绕过正常设置页写入
的配置；正常新增模型不会掉进第三段。用户拖动时也保存当前全部有效成员的完整顺序，并清理 stale/duplicate ID。

Provider 顺序使用 Personal 顶层 `providerOrder`，不再借 Provider Map 的插入顺序表达用户排序。Z.ai/BigModel
Account Family 继续作为固定产品区域，不参与普通 Provider 拖动；所有 Personal Provider 统一参与普通排序。创建
Template 实例或完全自定义 Provider 时，应把当前完整普通 Provider 顺序一并写入 `providerOrder`；未排序尾段只承担
外部手写或异常输入的确定性归一化。

## 6. Enabled、Executable 与 Selectable

三个词属于不同层级：

```text
Enabled
└─ Effective Model Config.enabled

Executable
└─ 当前目标 Host 完成成员、启用和完整性解析后的 Registry 结果

Selectable
└─ Executable 结果再经过普通用户可见性过滤后的 Selection View
```

集合关系是：

```text
Selectable Models
    ⊆
Executable Models
    ⊆
Enabled Models ⊆ Provider Model Members
```

`executable` 和 `selectable` 都不是 Config 字段。进入 Registry 本身表示 executable；进入 Model Selection View
本身表示 selectable。Settings 为展示问题可以返回派生状态和具体 issues，但不能把它们重新保存为事实。

Provider 不需要独立 selectable。一个 Provider 是否出现在模型选择界面，只取决于它是否 visible 且至少拥有一个
selectable Model。

## 7. Model Config Rules 负责什么

Model Config 只负责模型或模型/API 组合的事实：

```text
Model Config
├─ enabled
├─ properties
│  ├─ contextWindow
│  ├─ input_format / output_format
│  ├─ supportsToolCall
│  ├─ supportsJsonSchemaOutput
│  ├─ supportsNativeWebSearch
│  └─ supportsMidConversationSystem
├─ optionSpecs
│  ├─ reasoningLevel.values/map
│  └─ maxOutputTokens.max/map
├─ requiresMfjsToolSchema
└─ 经证据确认、确属请求编码的窄兼容事实
```

每个 Option 的 `map` 直接生成目标 API 原始 JSON Request Body 的 RFC 7396 Patch；独立
`reasoningMapping`、AI SDK Provider Options 映射和重复 max-output 字段权威均不存在。精确契约见
[`../model/model-option-map.md`](../model/model-option-map.md)。

Model Config 不包含模型 `visibility`、Provider Access、凭据、成员或排序。模型没有第二套 visibility；普通用户是否能看见
模型由 Provider visibility 与 Model enabled 共同形成的 Selection View 决定。

Personal Rules 分为两类：

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

Effective 组合固定为 `ZCode Built-in Rules + Personal provider-model Rules`。
Personal 只允许精确 `providerId + modelId` 覆盖；设置页不得通过改写 JSON 物理排列制造全局匹配规则。

Built-in 与 Personal 两个 Rule Source 都可以使用 `type="provider-model"`：它表达事实只属于一个精确
Provider/Model 组合。Built-in 专属 Rule 由 ZCode Built-in Release 管理，不受设置页生命周期操作影响；Personal 专属
Rule 由设置页管理，Personal Model 重命名时移动、删除时删除，删除 Provider Personal Overlay 时一并删除。

只有 Built-in Source 可以使用 `type="match"` 表达一组目标。Personal 不保存、不读取全局 Match Rule；专属 Rule 使用结构化 ID，
不需要把 ID 转义成正则，也不使用容易误解的 `exclusive=true` 标记。

Rule 可以根据真实事实使用 `modelMatch`、`providerMatch`、`apiMatch` 和按需的 `baseURLMatch`。这不等于在业务代码
中硬编码模型：匹配与配置值都属于 Built-in/Personal Rules，Adapter 和 Runtime 只读取最终解析结果。

Built-in Rules 的稳定组织顺序是发布文件的作者规范，不是运行时动态优先级：完整保守兜底之后，依次放置
Model Match、Model + API Match、Model + API + Endpoint Match、对全部成员成立的 Provider-scoped Match 和
少量 Provider-Model Exact Rule；同一模型家族连续排列。`modelMatch` 对完整 Model ID 做 ASCII 大小写不敏感的
正则匹配；其他 matcher 按各自契约匹配。Rule 仍只按物理数组顺序应用，后命中覆盖前命中。完整维护规范见
[`zcode-builtin-provider-config.md`](./zcode-builtin-provider-config.md)。

## 8. 模型输入输出格式

Config、Registry、Model、Runtime、Adapter 与协议共同使用同一个真实结构：

```ts
properties: {
  input_format: {
    support_text: boolean;
    support_image: boolean;
    support_video: boolean;
    support_audio: boolean;
    support_pdf: boolean;
  }
  output_format: {
    support_text: boolean;
  }
}
```

不建立平铺 capability DTO，也不从 modelId、Provider 类型或 Session 默认模型派生另一份媒体事实。PDF 继续参与真实
请求检查和现有编码链；Audio 当前只作为完整静态事实存在。设置页只展示锁定 Text 和可编辑
Image/Video/PDF，隐藏的 Audio 在编辑其他字段时必须原样保留。

## 9. Provider Access 与请求兼容

`access.type` 描述访问材料怎样取得，`api.type` 描述请求使用哪种公开协议；两者正交。
智谱产品协议使用有限的 Access Mode：

```text
zhipu-account/start-plan
└─ 官方版本访问安全校验

zhipu-account/individual-coding-plan | team-coding-plan
└─ ZCode V4 transport 请求证明准入；不扩散给普通 api-key Provider

zhipu-account/off-peak
└─ Off-Peak 排队、Ticket 与重试协议入口
```

这些字段都不是 Model capability。动态安全校验材料、Runtime Key、JWT、Off-Peak Ticket 与远端 rollout
不进入 Config。

已经确认的兼容决策是：

- OpenAI-compatible reasoning 使用真实 canonical 历史和当前 SDK 原生编码，删除 ZCode 特殊回放；
- GitHub Copilot `omitMaxOutputTokens` 删除；
- Snowflake Cortex 当前不支持，删除专属输出字段改写；
- 官方版本请求安全校验与 Off-Peak execution protocol 由 `zhipu-account.mode` 分派；
- `requiresMfjsToolSchema` 留在 Model Config，显式开启才转换，失败报错；
- DeepSeek Anthropic synthetic empty thinking 已删除；只保留真实 canonical reasoning 回放；
- 未进入当前基线的 Z.ai text/tool signature 候选不采用。

默认历史回放原则是：服务端真实返回什么，同一模型续轮就完整传回什么。Adapter 可以无损投影真实字段，但不能制造
不存在的 reasoning、thinking 或 signature。

## 10. Settings 的产品语义

设置页只编辑目标 Environment Host 拥有的 Personal Config。Local workspace 使用 Local Host；remote workspace 使用
Remote Host。Renderer 不自行 Overlay、排序、判断来源、制造 fallback 或用本地配置冒充远端事实。

设置页提供两个入口：

```text
添加供应商
└─ 从 Provider Templates 中选择
   └─ 使用当前语言的 Template 名称作为种子，原子创建具有唯一 providerId/label 的 Personal Provider 并进入编辑

创建自定义供应商
└─ 立即创建 Personal-only Provider 并进入编辑
```

创建是立即生效的，不建立仅存在于 Renderer 的临时 Provider Draft，也不再要求用户在相似页面里点击第二次“创建”。
Provider ID 永远不可编辑；Provider Name 是独立、可编辑且大小写不敏感唯一的 label。Z.ai/BigModel Family 保持现有
账号产品组织，不因普通 Provider Template 生命周期而拆散。Z.AI API 与 BigModel API 也只是普通 Template，不占用
Family 连接方式。

Template 选择通过顶部入口在右侧详情区完成，直接使用 Settings View 发布的 Template 顺序和多语言名称，不新增
Catalog 数据源。Provider 品牌图只由 Effective Provider Config 的 `logo` 决定；UI 资源表只负责把开放的 Built-in
key 加载为打包素材，未知 key 回退通用图标且不影响执行。

Provider 顶层没有 `enabled`。Personal Provider 的定义存在就表示它属于 Settings；API Key、Endpoint 等尚未补齐时仍可
保存和编辑，但不会进入可执行 Registry。Account Provider 固定显示在 Family，`access.entitled` 只表达账号权益。
Settings placement 与 Registry executable 消费同一组事实，但不是同一个结论。

UI 中“删除供应商”的 Provider 领域语义是删除该 Personal Provider 实例：

```text
group = standard-personal
└─ 删除其 Personal 根定义、模型专属 Rule 与顺序成员

group = zai-family | bigmodel-family
└─ Account Provider 由 Built-in 发布，不提供删除操作
```

系统从不删除 Provider Template 或 Account Built-in Config。Built-in Model 不显示删除按钮；Personal Model 可以删除或修改 ID。两类模型都
可以启用/停用和排序。Personal Model Config Rule 只记录用户修改后的稀疏覆盖，不负责授予编辑权限；字段能否编辑与
模型成员能否改名/删除是两条独立产品边界。

Model 编辑页只维护稀疏 Personal Rule。文本、数值和 JSON 的继承/生效值显示为 placeholder，不另建只读预览，
并提供一次清空该模型全部 Personal Rule 覆盖的“全部恢复默认”；模型列表的 `enabled` 开关始终保存明确布尔值且
不展示单项“恢复默认”。其他允许继承的布尔叶子使用统一控件：Effective 值决定勾选，显式 Personal 叶子以高饱和
边框表达，不追加“默认/已修改”文字。产品开放的 Model Properties 与 Option 值首版都允许编辑；Option Spec
Map 是隐藏配置，编辑其他字段时原样保留。`requiresMfjsToolSchema` 放在最后。Provider Access 产品协议不进入
普通 Model 编辑页。

Personal Model ID 改变时，必须先在预览语义中把对应 Personal exact Rule 移到新 ID，再使用新 ID 与最终 Provider
API/Endpoint 重新解析 Built-in Rules，最后叠加原 Personal 稀疏值。这样只有继承默认值变化，用户已经填写的值不会被
覆盖。

## 11. Built-in 发布与 Client Config

ZCode Built-in Provider Config 与 Model Config Rules 作为一个原子 Release 发布，不拆成两个彼此可能错配的远端字段。
仓库/安装包配置是拉取前和拉取失败时的基础兜底；当前 Environment 最近一次成功接受的远端 Release 作为 Active/LKG；
远端成功结果整体替换同一份 Built-in Source，不与 Bundled 交叉拼接。

每个 Environment 使用自己的控制面 Endpoint、Active/LKG 与 Registry。远程 Host 自行选择和刷新远程 Environment 的
Built-in Release；Desktop Renderer 不把本地 Release 推给远程执行环境。

LKG 只表示 Last Known Good，不保证比安装包更新。只有 Schema 兼容且 revision 高于 Bundled 的 Active/LKG 才能优先；
不兼容、损坏或更旧时回退到 Bundled。

## 12. 当前仍待裁决的事实

以下问题尚未成为当前设计事实：

1. DeepSeek Anthropic-compatible 是否真实要求 synthetic empty thinking；必须用真实 A/B 请求回答。
2. OpenRouter、OpenCode Zen、Azure、Volcano Ark 与 AWS Bedrock 已拆入
   [`Todo 22`](../../steps/todo-22-additional-builtin-providers-and-cloud-access.md)，不再扩大 Todo 21。Google 原生
   Provider 与 Vertex AI 当前不支持。

这些问题会改变保存事实或支持范围，应先裁决再写进精确 Schema 与交互设计；其余实现细节不能反向替代裁决。
