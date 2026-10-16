# Model 输入输出格式

## 状态

- 本文是 Provider Refactor 中 Model 输入输出格式的目标事实规范。
- 改动层级：`option-source + validation + persistence + commit-effect`。
- 本文覆盖较早设计中的 `modalities` 数组、平铺 `supportsImages` / `supportsPdf` /
  `supportsVideo`，以及 Runtime 的独立媒体 capability 投影。

## 唯一事实结构

Config、Registry、Model、Runtime 和跨进程协议共享同一份字段名称与嵌套结构：

```ts
interface ModelInputFormat {
  support_text: boolean;
  support_image: boolean;
  support_video: boolean;
  support_audio: boolean;
  support_pdf: boolean;
}

interface ModelOutputFormat {
  support_text: boolean;
}

interface ModelProperties {
  input_format: ModelInputFormat;
  output_format: ModelOutputFormat;
  // 其他既有 Model Properties 保持原有职责。
}
```

这些 snake_case 名称是真实 Schema 名称，不在 Runtime 中转为 camelCase，也不投影成另一套
`supports*` 字段。

## Config Rule 与 Overlay

ZCode Built-in Model Config Rules 和 Personal Model Config Rules 使用同一结构。Rule 可以只声明
需要覆盖的叶子字段；嵌套字段逐叶 overlay，Personal 规则拼接在 Built-in 规则之后：

```text
ZCode Built-in Model Config Rules ─┐
                                    ├─ resolve against Effective Provider Config
Personal Model Config Rules ────────┘
                                              |
                                              v
                                  Effective Model Config
```

Rule 中叶子字段的三态语义：

```text
undefined -> 本层没有意见
false     -> 本层明确关闭
true      -> 本层明确开启
null      -> 显式清除；若最终仍缺失则完整性校验失败
```

Built-in 通用规则负责提供完整默认事实，具体模型规则只保存差异。Effective Model Config 必须形成
完整的 `input_format` 和 `output_format`，Registry 不接受缺失叶子字段的 Model。

### 稀疏 Rule 与完整执行事实的边界

Rule 的 `undefined/null` 只表达 Overlay 指令，不构成 Model Property 的第三种取值：

```text
Sparse Built-in / Personal Rule
          |
          | resolve + validateComplete
          v
Effective Model Config
          |
          v
Registry / Protocol / Active Model / Runtime / Adapter
└─ support_* 只能是 true 或 false
```

完整性校验成功后，不再允许 `properties?`、`input_format?`、optional `support_*` 或“能力 unknown”继续向
下游传播。缺字段是 Config 错误，不得由 Registry、Protocol Mapper、Settings Draft、Runtime 或 Adapter
通过 `?? true` / `?? false` 补齐。Registry 发布的 Model 类型必须静态表达这一完整性，使下游无需重复
`requireCompleteProperties()` 或“字段齐全才发送 Properties”的兼容分支。

这里不影响 Account availability 的 `unknown`、开放 JSON 值使用的 TypeScript `unknown`，也不取消
Personal Rule 的稀疏覆盖。一次性 legacy importer 只能把旧文件明确表达的格式事实转换成 Personal Rule；
旧文件没有声明的字段不写 Override，继续继承 Built-in 通用 Rule。Importer 不能补迁移专用默认，也不能按
Catalog、modelId、Provider 类型或 Endpoint 猜能力；Overlay 后仍不完整则迁移失败。

`validateComplete()` 负责为 Settings Preview 产生完整性诊断；Registry 发布前还必须经过类型收紧的
`requireComplete` 边界。成功结果在静态类型上具有完整 Properties，失败候选只留在 Settings/diagnostics，
不能进入 Registry。函数名可以由实现确定，但不能继续以同一个稀疏 `ModelConfig` 类型表达验证后的结果。

不增加 `modalitiesConfigured`。旧版已发布配置中的 `modalities.input/output` 只能由一次性 legacy
importer 转换；未发布的平铺 `supportsImages` / `supportsPdf` / `supportsVideo` 中间格式不作为新
Provider Config 的兼容输入。

## Model 与 Runtime

```text
Effective Model Config
        |
        v
ModelFactory
        |
        v
Active Model.properties
        |
        +--> Core 输入检查 / 媒体投影
        +--> Compact / Memory / Child Agent
        +--> Adapter 请求检查与协议编码
```

ModelFactory 把 Effective Model Config 的完整 Properties 固定到不可变 Active Model。正常请求、
Compact、Memory、子 Agent 和闲时回合都读取本轮 Active Model 的
`properties.input_format`，不从 Session 默认配置、Catalog 或 modelId 重新推断。

异步链路需要冻结本轮事实时，优先持有 Active Model；无法持有执行对象时保存同结构的不可变
`properties` 快照。快照只冻结生命周期，不产生新的领域字段。

以下迁移期概念不属于目标架构：

- `ModelInputMediaCapabilities`；
- Runtime Config 的 `modelInputMediaCapabilities`；
- Turn 的平铺媒体 capability 字段；
- AI SDK Registry 中按 `providerId/modelId` 保存的 `inputMediaCapabilities` map；
- 从 Catalog、Provider 类型、URL 或具体 modelId 补齐输入格式的 Runtime helper。

Adapter 的协议实现能力仍是独立约束。例如 `support_video` 表示模型接受 Video，并不表示任意
Adapter 都已经能编码 Video；真实请求必须同时满足 Model Property 和目标 Adapter 的实现边界。

## 格式边界

| 格式        | Config / Model / Runtime | 设置页             | 本轮执行行为                                   |
| ----------- | ------------------------ | ------------------ | ---------------------------------------------- |
| Text input  | 支持                     | 固定展示、不可关闭 | 参与请求检查                                   |
| Image input | 支持                     | 可切换             | 参与现有媒体检查和编码                         |
| Video input | 支持                     | 可切换             | 参与现有媒体检查；仍受 Adapter 编码约束        |
| Audio input | 支持                     | 不展示             | 本轮不新增内容块投影、附件入口或 Provider 编码 |
| PDF input   | 支持                     | 可切换             | 参与现有媒体检查和编码                         |
| Text output | 支持                     | 固定展示、不可关闭 | 当前唯一输出格式                               |

本轮不增加 Image、Video、Audio 或 PDF 输出字段。

## 设置页与协议

设置页草稿直接维护 `input_format` / `output_format`。可见控件只修改 Text、Image、Video、PDF；保存
任何其他字段或切换可见格式时，隐藏的 Audio 必须原样保留。保存结果形成稀疏 Personal
Model Config Rule，未触碰的隐藏字段不应被写成覆盖值。

Draft 从 Service 返回的完整 Effective Properties 初始化。设置页不能因为字段缺失而自行补
Text=`true` 或其他格式=`false`；不完整 Config 应作为权威校验问题展示。

跨进程模型信息传输相同的嵌套 Properties，不再传输平铺 `supportsImages` / `supportsPdf` /
`supportsVideo`。普通可选择 Model Option 必须携带完整 Properties；冲突等不可选择诊断使用明确的状态
分支，不能用 `properties = undefined` 暗示未知能力。序列化是传输行为，不构成第二份能力事实。

现有 Vision 标识只是 Model Property 的展示投影，不参与 Registry 准入、Runtime 判断、模型选择
或持久化权威。Provider Settings 是唯一格式编辑入口；对话工具栏、自动化、Subagent 和 Repo Wiki
继续只读模型事实。

## 客户端与状态边界

- Desktop、Web 和手机设置页使用同一 Service 契约。
- 本轮不改变 local / remote Environment 的 Provider Config 权威关系。
- 本轮不改变 desktop continuous、mobile replayable、任务队列、owner / lease 或恢复语义。
- Config 更新只影响后来创建的 Model；已经创建的 Active Model 保持不可变。

## 影响简表

| 等级           | 关系                                      | 原因                                       |
| -------------- | ----------------------------------------- | ------------------------------------------ |
| must-inspect   | Provider Config / Model Rules -> Registry | 新 Schema 与完整性校验的权威入口           |
| must-inspect   | Registry -> ModelFactory -> Active Model  | Properties 必须原样固定且不可重新推断      |
| must-inspect   | Active Model -> Core / Adapter            | 删除 Runtime capability 副本后的执行消费者 |
| must-inspect   | Provider Settings -> Personal Model Rules | 可见字段修改和隐藏字段保留                 |
| should-inspect | Model option protocol / remote runtime    | 跨进程使用同一嵌套结构                     |
| invariant-only | Queue / replay / workspace identity       | 本轮不得改变既有状态与恢复语义             |

## 验收用例

1. Built-in 完整规则与 Personal 稀疏规则逐叶合并，Personal 只覆盖明确声明的格式。
2. Effective Model 缺少任一必填格式叶子时，Registry 完整性校验失败。
3. Registry 创建的 Model 原样持有 Effective Properties；配置更新不修改已经创建的 Model。
4. 普通请求、Compact、Memory、子 Agent 和闲时模型均读取本轮 Model Properties，不继承另一模型的
   媒体事实。
5. Image、PDF、Video 的允许与拒绝在 generate/stream 链路一致；Video 不能绕过 Adapter 编码限制。
6. Audio 字段可以 overlay、保存、传输和读取，但不产生未实现的 Audio 请求。
7. 设置页展示 Text/Image/Video/PDF input 和 Text output；编辑后隐藏 Audio 保持不变。
8. Legacy `modalities` 只有在旧文件明确提供时才由 importer 转换；正式 Config Schema 拒绝旧平铺字段，
   importer 不为缺失事实猜默认。
9. 本地与远端协议携带相同 Properties；desktop continuous 与 mobile replayable 行为不变。
10. Effective Config 以后所有 `support_*` 都是必填 boolean；UI、Protocol、Runtime 和 Adapter 不存在
    optional capability 或 `?? true/false` fallback。
