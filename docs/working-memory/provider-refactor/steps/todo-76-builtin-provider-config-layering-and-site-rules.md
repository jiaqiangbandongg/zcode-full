# Todo 76：Builtin Provider Config 分层与 Provider Site 规则

> 状态：已完成
>
> 日期：2026-09-04

## 目标

在不改变既有顺序 overlay 机制的前提下，重新整理 `zcode-builtin.json` 的规则语义。明确区分模型基础、API Schema、Provider Site（具体 Base URL）、Provider Template 和 Provider 实例，避免把站点配置误写成泛化模型规则。

## 固定 overlay 顺序

```text
Model ID
    -> Model ID + API Schema
    -> Provider Site / Base URL
    -> templateId + modelId
    -> Built-in Provider Instance Model overlay
    -> Personal Provider Instance Model overlay
```

顺序保持不变。后层只覆盖自己明确声明的字段；不因为某层更靠后就自动拥有所有字段。

`Personal Provider Instance` 是产品概念，表示用户创建的具体 Provider 实例；其模型修改仍使用同一个 `ModelConfigOverlay`，不再另造一套 Personal Rule 结构。

## 各层职责

### Model ID

提供模型本身的基础事实：上下文窗口、最大输出上限、基础输入模态和基础 reasoning values。`maxOutputTokens.max` 是能力上限，不是请求默认值。

### Model ID + API Schema

提供协议级基线：reasoning map、输出长度字段映射、JSON Schema 编码、工具调用格式和媒体序列化。这里的配置是默认基线，不假设所有站点完全一致。

### Provider Site / Base URL

按具体站点 URL 匹配真实服务行为。它可以覆盖前面的协议基线，例如某个 URL 的 reasoning map、搜索能力、PDF、JSON Schema、工具调用或额外请求字段。它不是模型成员或模板启停配置。

当前 `zcode-builtin.json` 中以 `modelMatch: ".*"` + `apiMatch` + `baseURLMatch` 写入 Z.ai/BigModel Anthropic 能力的规则，应按 Provider Site 语义重新归类和整理。

### templateId + modelId

表示内置模板的模型成员和默认启停，例如 `enabled`。Template 不是可执行 Provider，也不应无意覆盖具体 Site 已确认的协议行为。
当前维护范围内 Template Model Rule 只使用 `enabled`；不额外禁止底层 `ModelConfigOverlay` 的其他字段，但没有明确需求时不向 Template 添加运行时能力覆盖。

### Built-in Provider Instance Model overlay

表示 ZCode Builtin Config 为某个确定 `providerId + modelId` 提供的精确模型覆盖。

### Personal Provider Instance Model overlay

表示用户在 Personal Config 中为某个确定 `providerId + modelId` 保存的精确模型覆盖。两层复用同一个 `provider-model` Rule 类型和 `ModelConfigOverlay`；区别只由 Builtin/Personal 配置来源表达。

Personal Config 只允许精确的 `providerId + modelId` 覆盖；不支持、也不读取或写出任何 Personal 全局 `match` 规则。用户可以修改任意 Model Config 叶子，但不能借 Personal Config 新建一层全局规则。

## 官方模板的 API Schema 选择原则

同一供应商可能同时支持多个 API Schema。官方模板统一优先选择 Anthropic Messages；只有供应商或具体模型/Endpoint 不支持
Anthropic 时，才选择该入口实际支持且验证最充分的其他 Schema。这个判断以模板实际请求证据为准，不以“OpenAI-compatible”等
宣传标签推断。若同一站点不同模型必须使用不同 Schema，则拆分模板身份，或先提出明确的每模型 API 配置设计；不得把不同协议
模型塞进一个固定 `api.type`。

## 维护范围与完备性边界

维护范围只用一张简短的 Builtin Provider 入口库存表表达，不在设计文档中重复抄写完整 Provider Config。具体清单见
[`Builtin Provider 维护清单`](../../design-v2/builtin-provider-inventory.md)。表格格式为：

```text
供应商 | 类型 | templateId / providerId | Base URL | 产品维护模型
```

- 普通 API 入口填写 `templateId`；Account 入口填写具体 `providerId`。
- 表中的模型就是产品主动维护的模型；Template 的 `builtinModelIds` 是配置中的对应事实，不再另维护“模型属于哪些 Template”的重复列。
- 不额外维护模型展示名、Provider Site Catalog 或 Legacy/Compatibility 模型清单。
- 供应商目录中未出现在表内的历史模型不进入 Builtin Template，也不做兼容迁移。
- 小型中转站和自建推理服务仍可使用通用 Model/API 基线，但需要用户自行配置未被产品维护的模型。

入口库存表中的模型集合是完备性校验的输入：每个表中模型都要有 Model baseline、三种 API Schema
baseline，并在对应 Template/Account Provider 中逐项声明 `enabled`。不要求维护供应商完整目录，也不要求
制作 Model × URL × Schema 的全量矩阵。

这张表必须由设计文档维护，不能由代码中偶然出现的 Rule 推断。Provider URL 特殊规则不单独形成一张
“Site 清单”：只有实际存在差异时，才在配置中写 `providerSiteRules`；没有规则就沿用前层基线。
Research 文档只记录证据。

## 逐字段讨论清单

实现前逐项确认以下字段的基线、是否允许 Site 覆盖及默认策略：

| 字段 | 先取的基线 | Site 是否可覆盖 | 未确认时 |
| --- | --- | --- | --- |
| `contextWindow` | Model | 可以 | 使用已知 Model 值 |
| `maxOutputTokens.max` | Model | 可以 | 使用已知上限 |
| `reasoningLevel.values` | Model | 可以 | 保守，不新增档位 |
| `reasoningLevel.map` | Model + API Schema | 可以 | 无可靠映射则不可用 |
| `maxOutputTokens.map` | API Schema | 可以 | 无可靠映射则不可用 |
| `support_pdf` | Model | 可以 | 不声明支持 |
| `supportsToolCall` | Model/API | 可以 | 不能关闭 ZCode 必需能力 |
| `supportsJsonSchemaOutput` | Model/API | 可以 | 未确认不声明支持 |
| 搜索/系统消息能力 | API 基线 | 可以 | 未确认不声明支持 |

“可以覆盖”表示配置能力，不表示每个站点都必须写一份覆盖；没有覆盖时继续使用前层基线。

## Match 规则原则

`match` 只用于表达“同一个对象存在多种等价写法”，不用于通过复杂正则推断供应商、能力或产品语义。前后缀匹配只允许
用于 Model Rule（`modelRules`）和 Model+API Rule（`modelApiRules`）两层；Template Model、Provider Model 必须使用完整
`templateId/providerId + modelId` 精确匹配，Provider Site 必须使用 URL 规则匹配，不套用模型通配逻辑。

模型 ID 属于缓慢更新的封闭维护集合，因此 Model Rule 默认允许使用前后缀匹配，例如 `.*GLM-5\\.3.*`，以覆盖供应商命名空间
或已确认的版本后缀。模型规则之间允许有重叠，采用简单的书写顺序处理：通用模型族规则先写，具体模型/变体规则后写；例如
`.*GLM-5.*` 先于 `.*GLM-5\\.3.*`，后者再先于 `.*GLM-5\\.3-Flash.*`。这样 `GLM-5.3-Flash` 可以继承通用配置，再由
更具体规则覆盖差异。不引入运行时“最相似”排序，也不为了未知 Provider 编写无限宽泛的规则。具有不同产品语义的后缀
（如 `-flash`、`-turbo`、`-thinking`、`:free`）仍应写明确的具体规则，不能当作普通别名吞掉。

例如，模型 ID 的大小写或确实等价的分隔符写法可以通过规范化或窄匹配处理；不能因为一个 URL 看起来像某家服务，就自动推断其模型、搜索或 JSON Schema 能力。

## Base URL 匹配边界

Base URL 使用标准 WHATWG URL 解析后再进行规则匹配。当前规范化行为为：协议和 Host 按 URL 语义处理，默认端口与末尾斜杠不造成额外差异；Path、Query 和 Fragment 不做业务猜测。Query/Fragment 是否参与具体规则由显式规则决定，不新增代理 URL 自动继承或 URL 重写逻辑。

Provider Site 规则应保持简单、具体、可读；代理地址不会因为“看起来像”官方地址就自动继承官方 Site 配置，除非命中同一显式规则或另有明确配置。

## 对 Builtin Config 的拟议整理

1. 保留现有顺序 overlay，不引入动态优先级算法。
2. 将 `baseURLMatch` 命中的规则按 Provider Site 语义集中整理，并从 `matchRules` 正式拆成独立 `providerSiteRules`，避免站点规则继续伪装成普通 Model Rule。
3. `templateModelRules` 继续承载模板模型成员和 `enabled`，不把它扩展成所有能力的第二份事实源。
4. API Schema 的通用 map 只作为基线；具体站点有差异时由 Site 规则覆盖。
5. `providerModelRules` 继续作为精确 Provider 实例覆盖，Personal Overlay 最后应用。
6. 不在 Runtime、Adapter 或 UI 中按模型名、URL 或 API Schema 临时猜测能力。

## 执行阶段

1. **维护范围落盘**：在设计文档中维护一张“供应商、类型、ID、Base URL、产品维护模型”入口库存表，并列出三种 API Schema；不建立 Legacy/Compatibility 模型清单或重复的 Site Catalog。
2. **类型拆分**：正式拆分 `modelRules`、`modelApiRules`、`providerSiteRules`、`templateModelRules` 和 `providerModelRules`；各层建立独立外层 Rule 类型，内部复用 `ModelConfigOverlay`；Builtin Provider Instance 与 Personal Provider Instance 复用同一个 `provider-model` 类型。
3. **Builtin Config 迁移**：按固定顺序把现有规则放入对应分组，保持每条 overlay 的顺序语义。
4. **完备性校验**：校验维护清单中的 Model baseline、Model×Schema baseline、Site 差异和 Template enabled；未列入清单的 Provider 模型不进入 Builtin Template，也不要求未知 Provider 建矩阵。
5. **回归验证**：新增 Config Schema、分组顺序和 overlay 单元测试；运行现有 Provider Config、Resolver、Registry、Settings/Selection 相关测试，证明本次格式调整没有改变现有消费行为。没有 UI 行为变化时不新增一套业务 E2E；复用已有 Provider E2E 做最终烟测。

## 当前不在范围内

- 不重新讨论已完成的 Option `default` 退役、Reasoning 完整化和请求预算显式化。
- 不在本 Todo 中直接实现 PDF、工具调用或 JSON Schema；这些能力的具体修改由 Todo 74 负责，本 Todo 只提供其配置分层约束。
- 不改变 Provider Template 不是可执行 Provider 的现有抽象。
- 不在本 Todo 中决定 PDF、工具调用或 JSON Schema 的具体能力值；这些由 Todo 74 执行，但必须遵守本 Todo 的分层和完备性约束。
- 当前配置尚未正式上线，Personal 通用 match 规则直接从新 Schema 删除，不增加迁移或兼容读取；未维护的 Provider 历史模型也不做迁移。

## 验收标准

- 文档维护的每个主流 Model 都有 Model baseline。
- 文档维护的每个主流 Model 都有三种 API Schema 的 API baseline；组合不适用时不强制伪造一条配置。
- 文档维护的 Provider Site 只有在存在明确差异时才添加 Site override；小型或未知站点沿用通用基线。
- 每个 Template 的模型成员都有显式 `enabled`。
- 每条 Builtin Rule 都能说明自己属于 Model、API Schema、Provider Site、Template 或 Provider Instance。
- URL 规则表达具体站点行为，不再伪装成所有 Provider 的通用能力。
- 同一 Effective Model Config 在 Settings、Model Selection、Runtime 和 Adapter 中使用同一 overlay 结果。
- 现有顺序 overlay 行为保持可预测，并有针对规则冲突的单元测试。
- 维护清单之外的 Provider 不需要新增 Site Rule，能够使用 Model/API baseline。

## 实施记录（2026-09-04）

- Built-in Model Config 的序列化输出和实际 `config/provider/zcode-builtin.json` 已拆为 `modelRules`、`modelApiRules`、`providerSiteRules`、`templateModelRules` 和 `providerModelRules`，Resolver 仍按约定顺序逐组追加，未引入动态优先级。
- Builtin 的三类匹配规则仍在内部复用同一个 `match` Rule 与 `ModelConfigOverlay`；Personal 不再进入这条通用 match 管线。
- `parseZCodeBuiltinModelConfigRules` 读取新分组并按固定顺序合并；旧 `matchRules` 读取分支仅保留给尚未同步的开发期测试 Fixture，编码输出不会再生成旧字段。正式内置文件已不再使用旧字段。
- `toZCodeBuiltinJSON` 按字段存在情况把无 API/URL 条件的规则归入 `modelRules`，带 `apiMatch` 的归入 `modelApiRules`，带 `baseURLMatch` 的归入 `providerSiteRules`。
- 新增跨层顺序测试、实际文件分组完整性测试，并通过 Provider/Provider Node/Runtime 相关测试（此前 54 tests，本次迁移回归 30 tests）。`pnpm typecheck` 通过，`pnpm lint` 通过（0 error）。

本轮没有改动 Runtime、Adapter 或 Model Selection 的消费路径；它们继续消费同一个 `ModelConfigRules.resolve` 结果。134 条现有 Builtin 规则已按字段语义完成机械归类，规则内容和组内顺序保持不变。Personal 配置另行收敛为仅精确 `provider-model`，不再保留全局 match；74/79 的能力规则调整仍随各自 Todo 收口。
