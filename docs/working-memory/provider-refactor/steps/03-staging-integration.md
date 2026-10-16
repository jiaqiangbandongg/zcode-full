# M3.0：staging 集成与 Provider 配置所有权

> 状态：已完成本地 merge 实现与验证；随本次 merge commit 提交
>
> 最近更新：2026-08-22
>
> 集成基线：`origin/staging@bcb119437370b74b6460b89975afae2ef5cdea33`

## 1. 目标

M3 需要同时完成两件事：

1. 吸收 staging 已经加入的 Video Input、模型输入类型设置、`ox-alpha` reasoning 等产品能力；
2. 把 staging 和旧代码中仍由远端配置、Catalog、Workspace Snapshot 或具体模型名 hardcode 承担的 Provider / Model 事实，统一迁入新的 Provider Config 与 Model Config Rules 体系。

本文是这次 staging 集成的设计事实源。较早的实现日志只记录当时实现，不覆盖本文已经确认的新裁决。

本轮按用户裁决只做本地 merge 和提交，不 push、不改写任何远端分支。

## 2. 核心边界

所有配置的共同目标，是帮助 ZCode 封装一次正确的模型 API 调用：选择 Provider、确定 Endpoint 和 API 类型、确定模型成员、解析模型能力与选项，并形成最终请求。

配置体系不把“凭据”一概排除在外：普通 API Provider 可以在 Personal Provider Config 中直接保存静态 API Key。账号类型 Provider 的 Config 不管理账号凭据，只表达账号连接标识和账号态模型成员；实际账号凭据由 Services 在请求期解析并注入，模型服务负责最终鉴权与授权裁决。

因此必须区分：

```text
模型调用配置
├─ Provider 身份、Endpoint、API 类型、模型成员
├─ 模型能力、限制、选项和 reasoning 映射
├─ 普通 API Provider 的静态 API Key（允许）
└─ 账号连接标识

账号访问执行
├─ 根据账号连接标识解析账号凭据
├─ 请求期注入凭据
└─ 由模型服务最终决定账号能否访问目标模型
```

账号配置不是客户端安全边界。Personal 配置允许用户做最终覆盖；覆盖后的配置是否真的可用，仍由服务端响应决定。

## 3. 领域词汇

设计层只保留有业务含义的配置来源和派生结果，不引入额外的“配置文档”概念。序列化版本、文件外壳和读写格式属于实现细节，不进入领域模型。

### 3.1 Provider 配置

| 名称                           | 建议代码名              | 含义                                                       |
| ------------------------------ | ----------------------- | ---------------------------------------------------------- |
| ZCode Built-in Provider Config | `zcodeBuiltinProviders` | ZCode 随产品提供的 Provider 静态默认值和账号 Provider 声明 |
| Account Provider Config        | `accountProviders`      | 对 Built-in 中账号相关 Provider 的账号态补充或约束         |
| Personal Provider Config       | `personalProviders`     | 用户自定义 Provider，以及对已有 Provider 的最终覆盖        |
| Effective Provider Config      | `effectiveProviders`    | 三层 Provider 配置叠加后的最终 Provider 集合               |

当前实现中的 `officialProviders` 对应目标语义里的 `zcodeBuiltinProviders`。是否在 M3 内完成机械改名由实现阶段决定，但新增设计和测试统一使用本文词汇。

### 3.2 Model 配置

| 名称                              | 建议代码名               | 含义                                                      |
| --------------------------------- | ------------------------ | --------------------------------------------------------- |
| ZCode Built-in Model Config Rules | `zcodeBuiltinModelRules` | ZCode 随产品提供的模型静态事实和默认行为规则              |
| Personal Model Config Rules       | `personalModelRules`     | 用户对模型事实和行为的追加覆盖规则                        |
| Effective Model Config Rules      | `effectiveModelRules`    | 两组规则按顺序拼接后的最终规则序列                        |
| Effective Model Config            | `effectiveModelConfig`   | 针对一个最终 Provider / Model / API type 解析出的模型配置 |

Provider Config 的 `models[]` 回答“这个 Provider 有哪些模型以及展示顺序”；Model Config Rules 回答“这些模型如何调用、具有什么能力和限制”。Model Config Rules 不负责把模型加入或移出 Provider。

## 4. 两路配置如何汇合

```text
Provider 配置路径                              Model 规则路径

ZCode Built-in Provider Config                ZCode Built-in Model Config Rules[]
              |                                            |
              v                                            |
     overlay Account Provider Config                       +
              |                                            |
              v                                            v
    overlay Personal Provider Config             Personal Model Config Rules[]
              |                                            |
              v                                            v
     Effective Provider Config                 Effective Model Config Rules[]
              |                                            |
              +----------------------+---------------------+
                                     |
                                     | 对 final provider.models[] 中每个 model
                                     | 使用 final providerId / modelId / api.type
                                     v
                          Effective Model Config
                                     |
                                     v
                              Provider Registry
                                     |
                                     v
                            封装最终模型 API 调用
```

这里只强调三个真正有意义的派生概念：Effective Provider Config、Effective Model Config Rules 和 Effective Model Config。加载快照、上次成功值、解析缓存等中间态继续作为实现细节，不升级为领域概念。

## 5. Provider 覆盖规则

最终顺序固定为：

```ts
effectiveProviders = zcodeBuiltinProviders.overlay(accountProviders).overlay(personalProviders);
```

优先级为：

```text
Personal > Account > ZCode Built-in
```

### 5.1 Account 的职责边界

Account Provider Config 只处理 ZCode Built-in Provider Config 已经声明的账号类型 Provider：

- 可以补充账号连接标识；
- 可以在账号接口确实返回模型集合时，覆盖该 Provider 的 `models[]`；
- 不提供模型 context、modalities、reasoning、max output 等静态能力；
- 不读取、约束或改写 Personal 新建的自定义 Provider；
- 不保存或管理账号凭据。

因此 Account Provider Service 的输入必须是 ZCode Built-in Provider Config，而不是已经叠加 Personal 的 Provider 集合。

### 5.2 Personal 为什么最后生效

Personal Provider Config 是用户对本地调用封装的最终表达。它既可以新建普通 API Provider，也可以覆盖已有 Provider 的 Endpoint、API 类型、模型成员或静态 API Key。

Account 层提供账号态事实，但不承担客户端强制授权。即使 Personal 最终覆盖了账号返回的模型集合，服务端仍会对真实请求做最终鉴权和授权。

### 5.3 `models[]` 的覆盖语义

`models[]` 是 Provider 成员列表，采用整列表覆盖，不做隐式交集：

```text
Built-in Provider.models
└─ 静态/默认模型成员

Account Provider.models（存在时）
└─ 当前账号接口返回的动态模型成员，整列表覆盖 Built-in

Personal Provider.models（存在时）
└─ 用户最终声明的模型成员，整列表覆盖 Account/Built-in
```

不额外引入 `allowedModelIds` 作为第二套 Registry 语义，也不在客户端把 Account models 解释成授权白名单。

## 6. Model Config Rules 的合并与解析

两组 Model Config Rules 是数组拼接关系，Personal 规则在后：

```ts
effectiveModelRules = new ModelConfigRules([
  ...zcodeBuiltinModelRules.rules(),
  ...personalModelRules.rules(),
]);
```

规则按顺序匹配；后命中的字段覆盖前面规则已经给出的同名字段。解析对象必须来自 Effective Provider Config：

```text
effectiveModelRules.resolve(
  effectiveProvider.id,
  modelId,
  effectiveProvider.api.type,
)
```

这保证 Personal 对 Provider API type 的最终覆盖，也会进入对应的模型规则分支。不能先按 Built-in Provider 解析模型规则，再叠加 Account 或 Personal Provider。

模型静态事实包括但不限于：

- context window、max output tokens；
- image、video、PDF 等输入能力；
- reasoning 可用档位、默认档位；
- API Schema 下的 reasoning 参数映射；
- 模型排序或优先级等 Registry 元数据。

本轮不增加 Account Model Config Rules。账号接口只影响 Provider 连接态和模型成员，不下发模型静态能力。

## 7. Account 接口和 Start Plan

目前账号 availability 接口的实际差异如下：

| 账号类型            | availability 来源               | 是否返回动态模型 ID |
| ------------------- | ------------------------------- | ------------------- |
| Z.AI Start Plan     | `/billing/balance`              | 是                  |
| BigModel Start Plan | `/billing/balance`              | 是                  |
| Coding Plan         | `/subscription/list`            | 否，只返回可用状态  |
| Team Plan           | customer / project / quota 接口 | 否，只返回可用状态  |

Start Plan 从余额桶的 `capabilities` 中提取 `model:<id>`，做大小写无关的去重并形成 Account Provider `models[]`。接口返回的是账号当下可见的模型集合，不能据此写死“Start Plan 只能使用某一个模型”。

当前旧兼容在余额桶没有 `model:` capability 时，会把 `show_name` 当作模型 ID。`show_name` 更像展示字段，但在服务端契约没有进一步澄清前，本轮先保留兼容，不把它扩大为新的模型身份规则。

由于 Coding Plan 和 Team Plan 不返回动态模型集合，不能把这些 Built-in Provider 的 `models[]` 清空。Start Plan 也保留 Built-in 默认成员，以保证 availability 暂时没有返回模型 ID 时仍有明确的产品默认值；Account `models[]` 存在时再按整列表覆盖。

## 8. `/client/configs` 的所有权收口

`/api/v1/client/configs` 是通用远端产品配置中心，不是认证服务。认证相关接口可能与它协作，但不能因此把其中的 Provider / Model 静态事实继续视为账号认证结果。

### 8.1 `builtinProviders` 与 `providers`

两者表达同一类 Provider 配置权威，只是协议代际不同：

- `builtinProviders`：较新的规范化结构，主要包含 Provider 元数据和模型 ID；
- `providers`：旧的单体兼容结构，把 Provider 和模型配置混在一起；
- 当前 staging 在 `builtinProviders` 非空时优先使用它，`providers` 只作为 fallback。

目标不是长期保留两套入口，而是把仍有效的静态事实迁入 ZCode Built-in Provider Config 和 ZCode Built-in Model Config Rules，然后删除远端 Provider 同步和旧协议 fallback。

### 8.2 字段迁移裁决

| 远端配置                      | 当前作用                                             | M3 目标                                                     |
| ----------------------------- | ---------------------------------------------------- | ----------------------------------------------------------- |
| `builtinProviders`            | Provider ID、名称、模型成员、Endpoint、API Schema    | 迁入 ZCode Built-in Provider Config 后删除远端入口          |
| `providers`                   | 旧协议下的 Provider + Model 混合配置                 | 迁入现有体系后删除兼容入口                                  |
| `builtinModels`               | context、max output、modalities、reasoning、priority | 迁入 ZCode Built-in Model Config Rules                      |
| `magic_name`                  | 按模型名匹配 reasoning 策略                          | 删除远端 matcher；有效行为写成通用 Model Config Rules       |
| `offPeak.allowed_models`      | 闲时任务模型白名单                                   | 不再作为模型事实权威；静态成员进入 Built-in Provider Config |
| `modelContextBudget.strategy` | Agent 上下文预算灰度                                 | 与模型配置无关，本轮不动                                    |
| 商品、套餐、折扣              | SKU、展示和商业配置                                  | 继续由独立远端产品配置管理                                  |
| 安全校验开关、forceUpdate     | 风控和发布策略                                       | 继续远端管理                                                |
| computerUse、功能开关         | 产品灰度                                             | 继续远端管理                                                |

旧远端 Provider 类型里的 `apiKey` 字段不需要另做迁移设计：真实访问方式已经由现有访问体系负责；删除旧协议时一并删除该遗留字段。

## 9. 删除具体模型 hardcode

本次收口不只处理 `ox-alpha`。所有“识别具体模型 ID，再决定 reasoning 档位、默认值或请求参数”的旧代码都应退出。

目标结构是：

```text
具体模型的静态行为
└─ ZCode Built-in / Personal Model Config Rules
             |
             v
      Effective Model Config
             |
             v
通用 API Adapter 按配置序列化请求
```

Adapter 可以保留协议级映射，例如：

- Anthropic Messages 的 `output_config.effort`、adaptive thinking；
- OpenAI Chat Completions / Responses 的 reasoning 参数；
- 不同 API Schema 对同一通用选项的序列化差异。

Adapter 不再拥有“某个具体模型应该用哪些 reasoning 强度”的产品策略。

这里的 wire 只是网络工程常用语，指最终在线路上发给模型服务的 HTTP 请求体；Provider reasoning 链路里没有一个特殊的 `wire()` 领域函数。已有 `*-wire.test.ts` 通过截获最终请求体，证明配置经通用 Adapter 后仍保持 staging 已验证的真实请求行为。

`ox-alpha` 当前需要保留的行为是：

```text
reasoning levels = low / high / max
default = max
openai-chat-completions -> reasoningEffort
anthropic-messages      -> adaptive thinking + effort
openai-responses        -> 暂不启用专属 reasoning
```

这些行为写入 ZCode Built-in Model Config Rules；按模型名识别的 helper、远端 regex matcher、Default Policy 特例和 Catalog 特例删除。规则本身可以使用通用的 model match 表达式，它只是声明式匹配条件，不是业务代码中的模型特判。

## 10. 闲时任务边界

闲时任务的最新目标是把“模型静态事实”和“单次执行访问材料”分开：

```text
ZCode Built-in Provider Config + ZCode Built-in Model Config Rules
└─ builtin:offpeak-idle-plan 的静态 Provider / Model 事实

Execution context
└─ 单个闲时回合所需的 Request Auth / ticket / attribution 等请求输入
```

`builtin:offpeak-idle-plan` 是 `visibility: "hidden"` 的完整 Built-in Provider。它进入同一个 Registry，但被
Settings 和 Model Selection Facade 隐藏；内部闲时能力按精确 `providerId/modelId` 创建普通 Model。它不改写
Session 常驻模型。`enable_offpeak_task` 可以继续作为远端产品灰度；`allowed_models` 不再承担 Registry 模型事实。

Provider Config 必须声明完整的 `api.type`、生产 Endpoint、模型成员与静态模型事实，并使用
`access.type = "request-auth"` 表达请求期注入动态鉴权。缺少 Request Auth 时，Model 在网络请求前明确失败。
`visibility` 不代表受信、权限或完整性豁免。

本轮将 staging 带来的静态 Provider / Model 信息纳入现有配置体系，但不顺手重写整套闲时任务状态机，也不处理 `modelContextBudget.strategy`。

## 11. staging 产品能力的吸收方式

### 11.1 Video Input

保留 staging 的视频附件识别、上传、持久化、恢复、Tool Result 投影、请求转换、预算、脱敏和错误处理。模型是否支持 Video，只读取 Effective Model Config 中的模型属性，不再由旧 Catalog、Workspace Snapshot 或 Runtime fallback 补齐。

### 11.2 模型输入类型设置

保留 Text 固定、Image/Video 可切换、输出 Text 固定、context/max output 默认值以及主题、国际化、键盘和可访问性意图。设置保存到 Personal Model Config Rules。

不引入 `modalitiesConfigured`。规则字段的三态已经能够表达：

```text
undefined -> Personal 对该能力没有意见
false     -> Personal 明确关闭
true      -> Personal 明确开启
```

未展示的 PDF 与 Audio 能力不能被页面保存静默改写。Audio 进入完整 Model Property 契约，但本轮
不新增附件入口、内容块投影或 Provider 编码；详细结构见
[`../design/model/input-output-format.md`](../design/model/input-output-format.md)。

### 11.3 生效生命周期

Provider 或 Model 设置保存后更新 Registry revision，但不热改已经创建的 Active Model。下一次创建 Model 时读取新配置。Video、reasoning、Endpoint、API Key 和其他模型选项遵循同一生命周期。

### 11.4 Local / Remote

```text
Local Environment  -> 使用本地 Config / Registry
Remote Environment -> 使用远端环境自己的 Config / Registry
```

媒体附件和 Submission 可以经过远程控制协议，但 Desktop 不把本地 Provider Config、账号凭据或 Registry Snapshot 当成远端执行事实下发。

## 12. 集成后的实现结果

| 区域                          | M3 结果                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------ |
| Provider overlay              | 固定为 `built-in -> account -> personal`                                       |
| Account Provider Service 输入 | 只读取 ZCode Built-in Provider Config，不读取 Personal                         |
| Model rules                   | ZCode Built-in 与 Personal 两组数组拼接，Personal 在后                         |
| Model rules 的解析对象        | 使用 Effective Provider 的最终 `providerId / modelId / api.type`               |
| `/client/configs`             | 删除 Provider / Model 静态事实、旧协议 fallback 与 `magic_name` 解析           |
| reasoning                     | 具体模型策略进入 Built-in Rules；Adapter 只保留协议级序列化                    |
| OffPeak                       | hidden Built-in Provider 进入普通 Registry；Request Auth 按请求注入            |
| Video                         | 能力只读取 Effective Model Config；媒体处理、持久化与请求转换保留 staging 行为 |
| 模型设置                      | Text 固定，Image / Video 可编辑，保存为 Personal Model Config Rules            |

较早文档若仍记录 Account 最后覆盖、远端事实同步或具体模型 hardcode，只能作为历史实现记录，不能作为当前语义依据。

## 13. 影响范围与不变量

本次变化属于 `option-source + validation + persistence + commit-effect`，不直接改变对话协议、队列或 replay 语义。

| 等级           | 影响面                                                           | 原因                                      |
| -------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| must-inspect   | `packages/provider` resolver、Account Provider Service、Registry | 配置覆盖和最终事实 owner                  |
| must-inspect   | `/client/configs` Provider / Model 同步                          | 旧远端事实源需要退出                      |
| must-inspect   | CLI ModelFactory、reasoning policy、API adapters                 | Model Rules 必须生成相同最终请求          |
| must-inspect   | OffPeak execution-scoped model source                            | 静态配置与单回合访问材料分界              |
| should-inspect | Provider Settings、模型选择候选                                  | 都消费 Registry，但各自保存语义不同       |
| should-inspect | Start/Coding/Team Plan availability                              | 只有 Start Plan 返回动态模型 ID           |
| conditional    | Video / modality 设置                                            | staging 新能力接入 Effective Model Config |
| invariant-only | desktop continuous / mobile replayable                           | Provider 收口不能改变消息恢复语义         |
| invariant-only | local / remote workspace                                         | 远端环境继续拥有自己的执行配置            |

必须保持：

1. Personal Provider Config 最后生效；
2. Account 只约束 Built-in 中的账号 Provider，不碰 Personal 自定义 Provider；
3. Personal Model Config Rules 在 ZCode Built-in Rules 后；
4. Model Rules 解析 Effective Provider Config 的最终 API type；
5. `models[]` 是 Provider 成员整列表覆盖，不被悄悄改成授权交集；
6. 普通 API Provider 仍可保存静态 API Key；账号类型 Provider Config 不管理账号凭据；
7. 服务端始终是最终鉴权与授权权威；
8. 已创建的 Active Model 不被设置热更新；
9. Desktop 不向 Remote Environment 下发本地 Provider/凭据 Snapshot；
10. 不恢复旧 Provider Store、Catalog、Workspace Snapshot 或 Runtime fallback 作为模型事实源。

## 14. 实施顺序

M3 按以下顺序执行：

1. 先把本文裁决写成 Provider resolver、Account Service、Model Rules 和 wire 层测试；
2. 执行用户决定的 staging 集成方式，保留 Provider 领域外的 staging 产品实现；
3. 将 staging 的 Provider / Model 静态事实翻译到 Built-in Config 和 Model Rules；
4. 接入 Video 与 input/output format UI，但不恢复旧 Store、Catalog 或 Snapshot；
5. 删除 `/client/configs` 的 Provider/Model 同步、旧协议 fallback 和具体模型 hardcode；
6. 收口 OffPeak 的静态事实来源；完整 Provider 进入 Registry，访问材料按请求注入；
7. 用引用审计确认旧入口和模型特判已经退出；
8. 更新仍使用旧层级顺序的架构文档。

## 15. 验收

实现完成需要证明：

- Provider overlay 顺序是 Built-in -> Account -> Personal；
- Account Service 不读取 Personal Providers；
- Model Rules 是 ZCode Built-in + Personal 数组拼接，且作用于 Effective Provider；
- Start Plan 动态模型集合正确覆盖 Built-in 默认集合，Coding/Team Plan 仍保留 Built-in models；
- 普通 API Key 与账号凭据走各自正确的配置/解析路径；
- `/client/configs` 不再下发 Provider / Model Registry 静态事实；
- 所有具体模型 reasoning hardcode 已删除；
- `ox-alpha` 和其他已支持模型的最终 HTTP 请求行为未回退；
- OffPeak 静态模型事实来自 Built-in/Rules，单回合访问材料不持久化为普通 Provider；
- Video、Image 等能力来自 Effective Model Config；
- 当前 Active Model、Local/Remote 所有权和 desktop/mobile 消息语义保持不变；
- Typecheck、Lint、Provider/Registry/Account/Adapter wire/OffPeak/Settings 相关测试通过。

本轮集成拓扑已经裁决为本地 merge；远端分支后续如何处理仍由用户单独决定，不属于本次提交。

## 16. 实施记录

本轮以 `origin/staging@bcb119437370b74b6460b89975afae2ef5cdea33` 为本地 merge 基线完成实现：

- Provider resolver 与 Account Provider Service 已按 Built-in -> Account -> Personal 收口；
- `ox-alpha`、`GLM-x-preview-f`、`x-preview-f-free` 的 reasoning 行为进入 Built-in Rules；
- Default Policy 不再按模型名合成 Registry 静态事实；
- `/client/configs` 的 Provider / Model 事实解析、同步与远端 matcher 已删除；
- `builtin:offpeak-idle-plan` 当前以未发布的 `executionOnly` 中间实现提供静态成员；M4 将其改为通用
  `visibility: "hidden"`、完整 Endpoint 与 `request-auth`，不保留该中间字段；
- Video、Image 和 reasoning 只消费 Effective Model Config；
- staging 的 Video、模型模态编辑和其他 Provider 域外产品变更均保留。

### 16.1 验证结果

| 验证范围                                                    | 结果                                                                                                                               |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                            | 通过                                                                                                                               |
| `pnpm --dir apps/zcode-cli -r --if-present typecheck`       | 通过；具有 typecheck script 的 CLI workspace package 全部通过                                                                      |
| `pnpm lint`                                                 | 通过；0 error，39 条 staging 既有 warning                                                                                          |
| Provider / Account / Registry / OffPeak / Settings 聚焦单测 | 9 个文件、117 个测试通过                                                                                                           |
| CLI Video / reasoning / Registry 聚焦单测                   | 13 个文件、185 个测试通过                                                                                                          |
| Provider 设置冲突收口聚焦单测                               | 5 个文件、93 个测试通过                                                                                                            |
| `pnpm test:unit`                                            | 12,296 通过、25 跳过、30 失败；失败仅位于 7 个 Windows 打包、macOS 公证和 CUA 原生环境测试文件，与本轮 Provider / Model 改动无交集 |
| 本轮 78 个修改/新增文件的 `oxfmt --check`                   | 通过                                                                                                                               |
| `git diff --check`                                          | 通过                                                                                                                               |

仓库级 `pnpm fmt:check` 仍会被既有的二进制 `apps/zcode-cli/tests/gb2312.js` 和用于测试解析失败的 Electron HTML fixture 阻断，因此本轮以实际修改/新增文件的格式检查作为变更门禁，没有改写这些无关 fixture。

本轮只生成本地 merge commit，不 push、不改写远端分支。
