# Model Provider Model Editor Design

## Goal

模型供应商设置页的“添加模型”和“编辑模型”统一使用同一个弹窗编辑器。字段按模型身份、Token 限制、输入输出、模型能力和模型选项的任务顺序分区，避免不同配置混排；分区不展示额外标题，直接通过间距和边框建立层级。添加模型时不再先插入空白行，只有用户确认并通过校验后才写入模型列表。底层模态来源与运行时投影边界见 `docs/superpowers/specs/2026-08-21-model-provider-modality-settings-design.md`。

## Current State

- `ProviderModelsSection` 当前点击添加模型会打开 `ProviderModelMetadataDialog`，校验通过后再调用 `onAddModel`。
- `ModelRowInput` 已经维护模型 draft，并通过 `ProviderModelMetadataDialog` 编辑模型 ID、上下文窗口和最大输出 Token。
- `ProviderModelDraftValues.maxOutputTokensValue`、正整数校验和保存到 `ModelProviderModelConfig.maxOutputTokens` 的链路已经存在；当前缺少模态输入入口，且新增默认仍是 200K context / 空 max output。
- 模型支持的 API 格式存储在 `ModelProviderModelConfig.kinds`，`ModelProviderApiFormat` 到 `ModelProviderKind` 的映射由 `mapModelProviderApiFormatToKind` 提供。
- 添加模型时的 API 格式由当前设置页 API 格式推导；弹窗不展示 API 格式多选。

## UX

- 点击“添加模型”直接打开模型编辑弹窗，标题使用“添加模型”。
- 点击现有模型行的编辑按钮打开同一个弹窗，标题使用“编辑模型配置”。
- 弹窗分组及顺序：
  1. 基本信息：模型 ID 与启用模型使用两个独立的纵向字段，先展示“模型 ID + 输入框”，再展示“启用模型 + 开关”。模型 ID 必填，保存时 trim；新增时是唯一的空字段。
  2. Token 限制：上下文窗口与最大输出 Token。两者均使用无步进按钮的数字文本输入且必须为正整数；新增默认分别为 `1000000` 与 `128000`。
  3. 输入与输出：输入类型直接平铺并允许换行；Text 默认选中且不可取消，其余可见输入类型可选择。输出类型只展示固定 Text，不提供其他选项。
  4. 模型能力：展示“模型能力”字段 Label，下方提供 Tool Call、Structured Output、Native Web Search 与 Mid-conversation System 选项。
  5. 模型选项：Reasoning Levels、Reasoning Mapping 与 MFJS Tool Schema，直接展示。
- Audio/PDF 暂不在设置页展示；底层继续兼容旧配置与远端权威事实，编辑可见类型不得静默删除已有隐藏值。
- 各分区始终展示且不提供折叠入口。
- 分组使用间距和轻量边框建立层级，保持透明背景，不引入额外卡片底色。桌面端保持紧凑密度，窄屏下字段与选项自然换行且不改变语义。
- 添加弹窗打开后默认聚焦模型 ID；编辑弹窗默认聚焦并全选上下文窗口，便于快速替换常用数值。
- 弹窗不展示 API 格式选择。Reasoning Levels、Reasoning Mapping 与 MFJS Tool Schema 作为普通模型配置直接展示。
- 添加和编辑弹窗 footer 都展示“取消”和“保存”。取消关闭弹窗并丢弃当前弹窗草稿；保存通过校验后提交模型 draft 并关闭弹窗，provider 持久化继续由现有外层保存链路负责。
- 添加模型时，API 格式默认选择当前设置页的 API 格式。编辑现有模型时，默认使用模型已有 `kinds`。
- 添加模型时，最大输出 Token 从 `128000` 开始可编辑。模型 ID 停止输入 300ms 后，通过现有 model provider catalog service 按完整模型 ID（trim 后忽略大小写）查询；查询期间保留所有默认值和草稿、禁用保存并展示紧凑 loading。
- catalog 只有明确声明 `maxOutputTokens` 且用户尚未编辑该字段时才回填；未匹配、未声明、查询失败或迟到结果保持当前值，不清空 `128000` 默认值。不得把运行时 32K fallback 展示或写入表单。
- catalog 自动回填只发生在添加模式。编辑模式展示已保存值并允许手动修改，不触发 catalog 查询。
- 模型 ID 改变时，如果当前最大输出值来自上一模型的 catalog 自动回填且用户未编辑，则恢复 `128000` 默认值再查询；用户手动输入的值不清空。关闭弹窗或输入继续变化后，旧查询结果不得覆盖当前草稿。
- catalog 查询不得修改表单中的上下文窗口；新增模型 draft 默认使用 1M，`[1m]` 模型继续沿用强制 1M 规则。本次不为 Context window 增加 catalog 回填或保存后重读。
- 弹窗取消或关闭时不新增模型、不提交编辑草稿。保存时校验通过才关闭；校验失败保持弹窗打开并显示错误。

```text
打开新增弹窗 ──> ID 为空 + Context=1M + Max output=128K + Input/Output=Text
模型 ID 改变 ──> pending ── 300ms 稳定 ──> 查询 catalog
                                               ├─ 明确值且用户未编辑 ──> 回填
                                               └─ 未命中/失败/已编辑 ──> 保持当前值
输入再次变化或关闭弹窗 ─────────────────────────────────────> 忽略旧查询结果

点击保存 ──> 校验失败 ──> 保持弹窗
        └─> 校验成功 ──> 提交模型 draft + 关闭弹窗
                              └─> 现有外层 provider 保存链路
```

## Data Rules

- 保存 API 格式时转换为 `ModelProviderModelConfig.kinds`。
- `kinds` 按固定顺序保存：`anthropic`、`openai-compatible`、`openai`。
- `defaultKind` 优先使用当前设置页 API 格式对应的 kind；如果该 kind 没有被选择，则使用已选 `kinds` 的第一项。
- API 格式至少选择一项；否则返回 `invalid`，字段为 `kinds`。
- `resolveProviderModelDraftCommit` 不解析弹窗草稿中的 reasoning JSON；提交时通过 `...currentModel` 保留已有 `reasoning`。
- `resolveProviderModelDraftCommit` 要求最大输出 Token 为正整数并保存为 `maxOutputTokens`；新增默认值为 `128000`。
- 编辑旧模型时若 `maxOutputTokens` 缺失，草稿显示 `128000`；成功保存后写入该值。
- 可编辑本地模型保存时 output modalities 固定写为 `["text"]`；只读权威模型不经过该提交路径。
- 添加模型校验通过后调用父级 `saveModels` 写入完整模型；不创建中间空行。
- 编辑模型校验通过后复用现有 `onModelCommit` 更新指定行。

## Components

- `ProviderModelDraftValues` 保留 `kindsValue` 用于提交规则，增加输入模态与是否触碰的草稿状态，不包含 `reasoningJsonValue`。
- 扩展 `resolveProviderModelDraftCommit`，校验并提交 `kinds`、`defaultKind`、input modalities、固定 Text output 和显式来源。
- `ProviderModelMetadataDialog` 保持添加和编辑两种标题，按模型身份、Token 限制、输入输出、模型能力和模型选项组织现有字段；各分区不提供折叠入口。
- `ProviderModelsSection` 管理添加弹窗的 open 状态、新增 draft 和 catalog 查询时序，点击添加按钮时创建默认 draft。
- `ModelRowInput` 继续负责现有行的编辑弹窗，并传入当前 API 格式 kind，用于保存 `defaultKind`。

## Validation And Errors

- 模型 ID 为空：添加时显示模型 ID 错误，不提交；编辑时不再通过空 ID 删除模型，删除仍由垃圾桶按钮负责。
- API 格式为空：显示 API 格式错误，不提交。
- 上下文窗口无效：沿用当前上下文窗口错误。
- 最大输出 Token 不是正整数：显示最大输出 Token 错误，不提交。
- 输入模态缺少 Text：不提交；正常 UI 中 Text 不可取消，commit resolver 保留防御性校验。
- 不再有弹窗侧推理强度 JSON 校验错误。

## Testing

- 单测覆盖添加和编辑弹窗全部平铺字段，以及新增模型的 1M、128K、Text input/output 默认值。
- 交互单测覆盖模型 ID 为空、300ms debounce、catalog 命中、未命中/未声明、查询失败和迟到结果隔离。
- 交互单测覆盖查询 pending、用户覆盖自动回填值、模型 ID 再变化时保留用户值，以及未命中/失败时保持 `128000`。
- 单测覆盖编辑模式不查询 catalog，并可修改已有最大输出 Token。
- 单测覆盖弹窗不再渲染高级折叠，并覆盖输入 Text 不可取消、输出只展示固定 Text。
- 单测覆盖新增模型默认选择当前设置页 API 格式。
- 单测覆盖 draft commit 会保存模型 ID、`kinds`、`defaultKind`、上下文窗口、最大输出 Token、输入模态和固定 Text 输出，并保留已有 `reasoning`。
- 单测覆盖 API 格式为空时不提交。
- 保留现有模型行 tag、测试按钮 disabled、metadata draft 校验相关测试。
- 桌面 E2E 复用 I08 的真实设置页新增 provider 链路，覆盖字段平铺、1M/128K/Text 默认值、查询 pending/loading、catalog 真实回填、用户覆盖、输入模态选择、固定 Text 输出、编辑模式回显与修改、配置持久化，以及最终 provider 请求的 `max_tokens`。
- catalog 未命中、未声明、查询失败和迟到结果隔离保留在可控 service mock 的交互单测中；E2E 不为这些异常分支新增 catalog 注入、缓存或重试能力。
