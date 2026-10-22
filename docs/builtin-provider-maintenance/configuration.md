# 模板与模型规则配置规范

## 配置怎样成为一次调用

模板回答“通过哪个产品入口、协议和访问方式调用哪些模型”；模型规则回答“这些模型具有什么能力、逻辑选项怎样编码为请求参数”。两条路径在 Resolver 汇合，设置页和执行目录使用同一份解析结果，不能各自按型号或域名猜测能力。

| 概念            | 含义与维护边界                                                               |
| --------------- | ---------------------------------------------------------------------------- |
| Builtin Release | 随包或动态下载的完整配置，Provider 模板/固定 Provider 与模型规则共同版本化   |
| Template        | 普通供应商的连接与成员基线；`templateId` 是稳定模板身份，不是用户实例身份    |
| Provider 实例   | 由 `providerId` 标识的一组具体连接配置；模型身份是 `providerId + modelId`    |
| Account         | 只对已知固定账号 Provider 投影动态配置与资格，不向普通模板写入用户凭据       |
| Personal        | 用户的显式覆盖与个人模型成员；未声明字段继续继承，不保存整份解析结果         |
| Effective       | 按顺序叠加得到的生效配置，可以仍不完整；不是应写回用户文件的配置             |
| Registry        | 完整且可执行的 Provider/Model 集合；设置页还保留不完整候选及问题以供修复     |
| 执行 Model      | 从目标执行环境的 Registry 创建的不可变执行事实；后续刷新只影响新创建的 Model |

```mermaid
flowchart TD
    T[普通模板 + Personal实例] --> P[有效Provider：身份/成员/API/Access]
    A[固定Provider + Account + Personal] --> P
    B[Builtin模型规则 + Personal精确规则] --> R[Resolver]
    P --> R
    R --> S[设置候选与完整性问题]
    R --> G[完整且可执行的Registry]
    G --> M[目标环境创建不可变Model]
    M --> H[Adapter编码并应用参数Map]
```

普通模板实例继承模板后再叠加 Personal；固定 Provider 先叠加 Account，再叠加 Personal。Account 只能作用于内置固定身份。配置更新不能覆盖用户显式地址、名称或选项，不能把本地 Host 的凭据或解析结果用于替代远程 Host 的事实。手机界面使用目标 Host 的投影。账号动态凭据在请求期取得，供应商仍对每次请求作最终授权。

## 文件和类型的唯一来源

| 文件                                                                          | 职责                                              |
| ----------------------------------------------------------------------------- | ------------------------------------------------- |
| [正式 JSON](../../config/provider/zcode-builtin.json)                         | 唯一手工编辑源，包含模板、固定 Provider、模型规则 |
| [测试 JSON](../../config/provider/zcode-builtin.test.json)                    | 从正式配置生成的完整 Release，不独立编辑模型      |
| [生成脚本](../../scripts/sync-test-builtin-provider-config.mjs)               | 测试端点映射和相应 Site 规则派生                  |
| [规则 Schema](../../packages/provider/src/config/rule-data-schema.ts)         | 每层字段、匹配格式和来源写权限                    |
| [Provider Schema](../../packages/provider/src/config/provider-data-schema.ts) | API、Access、模板元数据                           |
| [Model Schema](../../packages/shared/src/model-config.ts)                     | 能力、选项与完整性                                |
| [Resolver](../../packages/provider/src/resolver.ts)                           | 模板继承、成员及最终可执行配置                    |

文件外壳是 `{schemaVersion: 1, revision, config}`。配置内容变化要使用新 revision，避免同号异内容；纯文档整理不递增。revision 与产品版本号不同，具体交付见[交付规范](./delivery.md)。不手工扩展 Schema 未接受的字段。

## 模板、成员和规则

`providerConfigRules.templateRules` 定义普通 API 模板。维护 `templateId`、本地化名称、Logo、`access`、`api.type/baseUrl`、Key 管理链接与 `builtinModelIds`。模板不携带用户 Key，不是直接可执行的 Provider；实例从模板继承，再叠加 Personal。

当前 API 类型只有 `anthropic-messages`、`openai-chat-completions`、`openai-responses`。Access 仍包含普通 `api-key`、手工套餐 `zhipu-coding-plan-api-key` 和固定账号 `zhipu-account`。手工套餐统一为普通 Key 的后续方案不能提前写成当前实现。

新增 Logo key 时核对[资源映射](../../packages/ui/src/settings/model-provider-section/ProviderLogo.tsx)、主题资源和来源记录；新名称核对本地化。纯配置动态更新不能凭空增加安装包内的图片资源。

`builtinModelIds` 决定模板成员；`templateModelRules` 的 `templateId + modelId` 决定该成员默认启停及差异。增加规则不会添加成员；`modelOrder` 只排序已有成员。当前所有模板成员都有精确启停声明，新增时保持这一可审查性。

### 字段归属与身份稳定性

模板外层只有 `templateId`、`templateNameMap`、`config`；名称 Map 支持 `zh-CN` / `en-US`。模板的 `config` 只接受 `logo`、`access`、`api`、`builtinModelIds`，其中 Access 禁止携带 `apiKey`。不要把实例字段、账号状态或个人模型写入模板。

实例规则外层保存 `providerId`、可选 `templateId/providerName/enabled` 和 `config`。`enabled` 的实例总开关与模型 `config.enabled` 不同；固定账号 Provider 不使用总禁用开关，仍受账号资格和模型启停约束。`group` 是产品分组，`visibility` 是展示控制，二者都不能替代鉴权或完整性检查。

`api` 保存 `type/baseUrl` 及可选静态 `headers`，URL 必须对应具体产品和协议，不将供应商宣传首页当作 API 地址。模板 ID、原始模型 ID 和实例名称分别维护；改模板展示名不能重命名已保存实例。模型 ID 中的前缀、斜杠和大小写原样用于请求。

成员按内置在前、个人在后的来源顺序组成；单集合去重保留第一次，个人与内置重名时保留内置来源。`modelOrder` 排序已有成员，不创建成员。缺模板、缺 Key、坏 URL 或能力不完整的候选可以在设置页显示，但不能因此进入 Registry；禁用模型也不能执行。`selectable` 还受 Provider 可见性限制，隐藏不是删除或失去内部精确查找身份。

## 规则层级

```text
modelRules                    型号通用能力
  → modelApiRules             型号 × API 协议差异
  → providerSiteRules         具体 Base URL 的差异，可限定型号和协议
  → templateModelRules        templateId + modelId 精确覆盖
  → builtinProviderModelRules 固定 providerId + modelId 精确覆盖
  → Personal 精确规则         用户覆盖
```

同层按数组顺序执行，后项只覆盖声明字段，无“最具体匹配优先”、长度排序或额外 priority。省略表示继承，`null` 表示显式清除，具体值表示覆盖；数组值按字段合同替换，不能期待自动合并思考档位。设置页的 Effective 值不能整份写回 Personal。

各数组中的记录使用下面的匹配字段和 `config`；文件不重复写内存层的 `type`，不使用 `providerMatch` 或跨层条件：

| 数组                        | 匹配字段                                         |
| --------------------------- | ------------------------------------------------ |
| `modelRules`                | `modelMatch`                                     |
| `modelApiRules`             | `modelMatch + apiTypeMatch`                      |
| `providerSiteRules`         | `modelMatch + baseUrlMatch`，可选 `apiTypeMatch` |
| `templateModelRules`        | `templateId + modelId`                           |
| `builtinProviderModelRules` | `providerId + modelId`                           |

Personal 只允许具体 Provider/Model 的智能精确覆盖或手动配置，同一身份不能同时进入两种集合，也没有个人全局正则层。手动模式固定产品开放的可编辑字段，系统字段仍由规则提供；维护 Builtin 不能顺带重写这些用户意图。智能/手动切换的字段归属可核验[手动配置实现](../../packages/provider/src/config/manual-model-config.ts)。

### 匹配与简化

- Model/Model+API 按有限维护集合使用简单前后缀正则，如 `.*deepseek-flash.*`；字面小数点仍转义。解析器对完整字符串匹配，模型名匹配忽略大小写，但请求 ID 不改变。
- 通用规则在前，具体变体在后。不能只按字符串长度自动排序；必须验证继承后的完整结果。
- 同一具体 Base URL 的规范化等价形式可以共用一条 Site 规则；不同域名或路径不以 alternation 合并。模型或协议条件不同而必须拆分时保留多条。
- Template/Provider 精确规则按完整身份匹配，不放宽成模型通配。Site 的 `modelMatch` 仍按 Schema 支持匹配，不能误写成只允许精确模型。
- 通用基线目前是 `contextWindow=1000000`、`maxOutputTokens.max=128000`。已知较小窗口/输出限额必须显式覆盖；基线不是上游实测承诺，也不是每次请求的输出预算。
- 只删除真正可继承的重复值。若前层家族改成较小值，具体型号恢复到通用值仍需显式覆盖。
- 保留有语义的例外，如 GLM-4.6 Messages 规则对视觉型号的 `(?!v)` 排除、Flash 与 FlashX 的覆盖顺序。历史别名转换不能随 matcher 放宽而扩大适用范围。

这些选择基于有限维护集合：用明确顺序表达家族与变体差异，减少重复声明和复杂边界，而不是承诺无限未知型号都准确。revision 32 将通用窗口从 200000 调为 1000000、输出上限从 32000 调为 128000；删除了仅为 `[1m]` 设置百万窗口、仅为预览别名设置 128000 上限的两条 Model 规则，因为可以继承新基线。协议层的推理映射、成员身份和显式请求预算不因这两条规则删除而改变。

### 能力与 Option Map

Properties 包括上下文容量、输入/输出形态、工具调用、结构化输出、原生搜索、对话中途 System 消息和 MFJS Schema 要求。不同字段分别核实：原生视觉徽标不等于媒体输入开关，支持图片不等于支持视频/PDF，支持工具不等于支持原生搜索。

完整执行配置需要 `enabled`、完整 properties、非空有序 `reasoningLevel.values/map` 和 `maxOutputTokens.max/map`。无推理模型也需要合法选项合同，不按型号猜默认值。

| 字段组                        | 必须核对的叶子                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `properties`                  | `contextWindow`、`requiresMfjsToolSchema`、`supportsToolCall`、`supportsJsonSchemaOutput`、`supportsNativeWebSearch`、`supportsMidConversationSystem` |
| `properties.inputFormat`      | `supportsText`、`supportsImage`、`supportsVideo`、`supportsAudio`、`supportsPdf`                                                                      |
| `properties.outputFormat`     | 当前只有 `supportsText`；不能借此声明图像或音频生成支持                                                                                               |
| `optionSpecs.reasoningLevel`  | 有序 `values` 与 `map`；不另存 `type`，不自动改名已有关闭档位                                                                                         |
| `optionSpecs.maxOutputTokens` | 能力上限 `max` 与 `map`；不另存请求默认预算                                                                                                           |

稀疏规则只写差异，完整性由解析后的配置证明。新模型应核对所有能力，即使最终借用了家族规则，也应留下继承值适用的依据。MFJS 是工具参数 Schema 要求，MCS 是允许对话中途 System 消息；二者不能从“支持工具调用”推导。

```text
Adapter 编码基础请求
  → reasoningLevel.map
  → maxOutputTokens.map
  → 最终 HTTP Body
```

Map 使用受限 CEL，输入是对应选项值，输出是 JSON Merge Patch；无 IO、环境读取或动态代码。`{}` 不修改请求，Patch 中的 `null` 删除字段。`values` 按低到高排列，`none/disabled` 等原始值不全局改名。每个合法值都要验证最终请求，不能只测表达式能编译；Map 也不能替代 Adapter 对媒体、流式工具调用和响应的支持。实现见 [Option Maps](../../packages/model-option-map/src/option-maps.ts)和[请求应用点](../../apps/zcode-cli/packages/adapters/src/model/model-option-map-fetch.ts)。

## 正式与测试配置

```text
编辑正式 JSON → sync-test → 测试 JSON → check-test → 同一 MR
```

生成器从完整正式文件重新派生，不在旧测试文件上增量修补：

- 仅转换固定 `zhipu-account` Provider 的已知正式端点，包括个人/团队、Start、闲时和加速卡；未知账号端点明确失败。
- 普通手工 API 模板、第三方地址和 Key 管理链接保留原值。因此测试包中的普通模板仍可能请求正式供应商并产生真实费用。
- 保留正式 Site 规则，紧随其后追加测试端点规则，继承相同型号/API 条件、能力和 Map。
- 模板、模型成员、其余规则、schemaVersion、revision 保持同源。测试环境差异不能用来维护第二套模型能力。

```bash
pnpm provider:config:sync-test
pnpm provider:config:check-test
```

新普通模板若确需不同测试端点，先确认环境要求，再修改生成策略及脚本测试；不能手工改测试 JSON。

### 当前账号端点映射

| 正式 Base URL                                    | 测试 Base URL                                            |
| ------------------------------------------------ | -------------------------------------------------------- |
| `https://api.z.ai/api/anthropic`                 | `https://api.z.ai/api/anthropic`                 |
| `https://open.bigmodel.cn/api/anthropic`         | `https://open.bigmodel.cn/api/anthropic`                  |
| `https://zcode.z.ai/api/v1/zcode-plan/anthropic` | `https://zcode.z.ai/api/v1/zcode-plan/anthropic` |
| `https://zcode.z.ai/api/v1/off-peak/anthropic`   | `https://zcode.z.ai/api/v1/off-peak/anthropic`   |
| `https://zcode.z.ai/api/v1/highspeed/anthropic`  | `https://zcode.z.ai/api/v1/highspeed/anthropic`  |

此表只驱动固定账号 Provider 地址转换及对应 Site 规则派生，不改同 URL 的普通模板。新增测试地址还需核对现有 Adapter 的官方版本请求安全校验准入；产品环境开关本身不授予新域名访问行为。

### 构建选源与最终资源

共同[构建入口](../../scripts/builtin-provider-config.mjs)拥有环境选源职责：显式非空 `ZCODE_ENV` 优先；否则先读取 `.env`，再按 `NODE_ENV=production` 读取 `.env.production`，其他情况依次读取 `.env.development`、`.env.development.local`。后读文件中的值覆盖前值，缺失文件跳过。最终值去空白、转小写，空值默认 `test`，非法非空值报错。

`production` 选 `config/provider/zcode-builtin.json`，`test` 选 `config/provider/zcode-builtin.test.json`。`NODE_ENV` 只决定上述环境文件组，不直接决定产品环境；分支名也不参与选择。

```text
ZCODE_ENV与环境文件 → 选择完整JSON → 复用Release Decoder校验
                                     ↓
                   包资源或嵌入常量 → Builtin Source → Registry
```

| 消费形态                   | 配置落点与核验要求                                       |
| -------------------------- | -------------------------------------------------------- |
| Desktop 安装包             | `resources/config/provider/zcode-builtin.json`           |
| 普通 CLI                   | `dist/provider/zcode-builtin.json`，构建刷新相邻资源     |
| SEA 单可执行文件           | 资源 key 为 `zcode-provider/zcode-builtin.json`          |
| HTTP / Remote / Server CLI | 完整 JSON 编译为常量，检查最终 JS/打包产物               |
| Desktop 开发态             | 按同一编译环境定位仓库源文件；显式配置路径注入优先级不变 |

读取、JSON 解析或 Schema 校验失败直接终止构建，不跨环境回退。构建只读选定本地文件，不下载在线配置、不隐式执行同步、不覆写源文件。Windows 加载解码器时先把文件路径转为 `file:` URL，避免盘符被当作协议。

构建缓存必须覆盖 `ZCODE_ENV`、环境文件、两份配置和公共构建工具。当前 CLI 的 Turbo 输入及 Desktop E2E 指纹包含这些相关输入，Server 嵌入内容参与产物 hash；bootstrap 重新构建 Agent JS 并刷新相邻配置资源。不同环境并行构建使用独立 worktree/输出目录，不能并发写同一个 dist。

构建只决定包内初始配置；客户端是否采用它还受有效缓存与 revision 影响，见[交付与恢复](./delivery.md)。环境变更的回归必须用内容不同的 Release 检查实际选源、坏文件失败、缓存失效和最终嵌入内容，不能因两份文件偶然相同就宣称通过。
