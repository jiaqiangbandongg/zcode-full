# 3.9.0 模型输入输出类型设置设计

> Provider Refactor 已将正式模型事实收口为
> `properties.input_format` / `properties.output_format`。本文保留 staging UI 决策和历史实施记录；
> 当前数据契约以
> [`../../working-memory/provider-refactor/design/model/input-output-format.md`](../../working-memory/provider-refactor/design/model/input-output-format.md)
> 为准。

## 状态

- 目标版本：3.9.0
- 当前阶段：已实施并完成单元/集成验证
- 关联现状：`ModelProviderModelConfig.modalities` 支持 `input` / `output`，公共枚举为 `text`、`image`、`video`、`audio`、`pdf`；模型编辑弹窗提供 Text/Image/Video 输入类型和固定 Text 输出类型入口。
- 关联文档：
  - `docs/superpowers/specs/2026-06-04-model-provider-model-editor-design.md`
  - `docs/model-provider-client-config-remote-model-facts.md`
  - `docs/superpowers/plans/2026-06-24-model-media-capability-projection.md`
  - `docs/ssh-remote-app-global-state-authority.md`

## 目标

在模型供应商设置的“添加模型”和“编辑模型配置”弹窗内增加类型选择交互，使用户可以声明模型支持的输入、输出类型。底层继续使用 provider schema 的 `modalities` 字段；保存后的类型事实必须进入现有 provider registry，并在当前运行时已经支持的能力边界内生效。

本功能不是单纯展示字段。用户显式取消图片或 PDF 输入时，配置必须能与旧版“未声明能力”区分，避免 UI 显示 text-only、运行时却仍按未知能力透传媒体。PDF 使用现有底层能力事实，并在设置页提供独立切换入口。

## 非目标

- 不在本设置功能中新增 Audio 附件发送、编码或 provider request 转换能力；Video 附件能力由独立的视频输入功能提供。
- 不新增图片、音频或视频输出的渲染链路。
- 不改变模型候选分组、当前模型选择、任务恢复和手机 replayable 语义。
- 不让远端 workspace 的 `~/.zcode/v2` 成为模型设置权威源。
- 不把 provider registry 或能力状态下沉到 relay、desktop main 或 renderer 队列。

## 当前事实与设计缺口

`ModelProviderModelConfig.modalities` 当前总会被归一化为数组；未配置时缺省为：

```json
{
  "input": ["text"],
  "output": ["text"]
}
```

但对 legacy/custom provider，这个 text-only 缺省并不代表“明确不支持图片”。`convertModelProviderConfigToZCodeProviderInput` 会保留媒体能力未知态，防止第三方 vision 模型因为历史默认值被误判为 text-only。

因此下面两种状态当前在内存配置中不可区分：

```text
旧配置没有 modalities ──归一化──> input=[text] ──> 能力未知，允许媒体透传
用户明确只选 text ─────归一化──> input=[text] ──> 期望明确不支持 image/pdf
```

只增加 UI 和数组保存会产生错误交互：取消 image 后，运行时仍可能继续发送 image。3.9.0 必须同时保留“模态是否由用户显式配置”的来源事实。

## 已确认产品语义

### 分组交互

- 模型弹窗按以下顺序展示模型配置：
  1. 模型 ID
  2. 启用
  3. 上下文窗口
  4. 最大输出 Token
  5. 输入类型
  6. 输出类型
  7. 模型能力
  8. Reasoning、Mapping 与 MFJS Tool Schema
- 所有配置均使用无标题分组卡片，不提供折叠入口。
- 输入类型、输出类型与模型能力的标签到选项区域统一使用 `mb-1` 垂直间距，不能让分组容器的 `space-y-3` 放大模型能力标题下方留白。
- 模型 ID 与“启用”组成同一行双列布局：模型 ID 输入框占满剩余宽度，“启用”使用 `w-24` 稳定操作列，标签与 Switch 在该列内水平居中。窄屏继续保持同一行，模型 ID 列允许收缩，不能把 Switch 挤出弹窗。
- 模型列表项统一使用 `px-3 py-2` 内边距；拖拽中的浮起项不显示行底部分隔线，使用透明底边框保留原始占位尺寸，避免拖动时产生纵向抖动。
- 模型弹窗底部操作复用编辑 Subagent 的 `SettingsFormActions` 层级：恢复默认留在左侧；右侧“保存”在前并使用 `default + lg`，“取消”在后并使用 `ghost + lg`。窄屏允许上下排列，但不能改变主次关系或丢失操作。
- Provider 与模型保存成功反馈使用与 Loading 状态一致的整行宽度、`rounded-xl` 圆角和中性浮层，不使用整块绿色背景、绿色边框或绿色正文；仅成功图标保留 `text-success` 语义。失败反馈继续保留高辨识度的 destructive 样式。
- 弹窗正文独立滚动，Header 与 Footer 固定。滚动容器向右延伸到弹窗内侧留白，卡片与 overlay/native scrollbar 之间保留独立 gutter；滚动条不得紧贴或覆盖分组卡片右边框。
- 新增模型打开时只有模型 ID 为空，其余字段都有可见默认值：
  - 上下文窗口：`1000000`
  - 最大输出 Token：`128000`
  - 输入类型：Text
  - 输出类型：Text
- 输入类型固定展示顺序为 Text、Image、Video、PDF。Text 默认选中且不可取消，Image/Video/PDF 可以独立切换；Audio 暂不在设置页展示。
- 输出类型暂不支持其他选项，只展示固定、不可操作的 Text，不使用下拉或 Popover。
- 输入类型选项下方不展示泛化的附件能力提示。Image/Video 是否可以作为对话附件，由模型显式能力与当前 provider adapter 的实际编码能力共同决定；设置页不重复声明一个可能过时的全局结论。
- 输入类型的四个图标选项全部直接可见并允许换行，不使用下拉或 Popover。每项复用共享 Button 的 `outline + lg` 外壳，固定 `h-8`（32px）、`rounded-lg` 和左右 `12px`（`px-3`）内边距；内部使用 `size-4` 模态图标与文本，不展示 checkbox。选中态使用 `bg-selected border-primary/20`，并以 `background-clip: border-box` 覆盖共享 Button 的 padding-box 裁剪，使半透明状态边框实际叠加在选中背景上；Hover 只增强为 `border-border-hover`，选中项 Hover 时继续保持 `bg-selected`；未选中态使用 `bg-transparent border-border`。Personal Overlay 不覆盖模态选项的状态边框。Text 保持选中并通过原生 disabled 禁止点击，在选项末尾展示弱化的锁图标以表达不可取消；其余选项点击或按 Space 切换。
- 输出类型使用相同的“图标 + 文本 + 锁图标”结构，只展示固定选中且 disabled 的 Text。
- 模型能力使用与输入/输出类型一致的“图标 + 文本”胶囊选项，不展示方形 checkbox；工具调用、结构化输出、原生联网搜索、对话中系统消息分别使用 Wrench、Layers、Search、MessageSquareText 图标。选中态统一使用 `bg-selected border-primary/20`，未选中态使用 `bg-transparent border-border`，Hover 只将边框增强为 `border-border-hover`，选中 Hover 保持 `bg-selected`。控件继续保留 `role="checkbox"` 与 `aria-checked`，确保键盘交互和辅助技术可以读取选择状态。Personal Overlay 不改变这套状态颜色。
- 推理档位的静态文字与编辑输入统一使用 `text-ui-sm` 普通 UI 字体，不使用等宽字体。编辑输入按内容宽度伸缩并沿用档位的 `h-7` 外壳，进入编辑态时字号、高度和宽度不得突跳；新增入口使用与档位同高的 `size-7` Outline 图标按钮，保留紧凑方形边框。
- 底层 schema、旧配置读取和远端权威事实继续兼容 Audio/PDF。编辑旧模型时，未触碰类型不得删除隐藏值；用户切换可见类型时也保留已有 Audio 值，避免 UI 收窄造成静默数据丢失。
- 编辑模型时回显已保存的上下文窗口、最大输出 Token 和输入模态；旧模型缺少最大输出 Token 时显示 `128000`。输出模态按 3.9.0 产品边界固定为 Text。
- 可编辑本地模型成功保存后 output 统一为 `["text"]`；只读的 catalog/远端权威模型保持服务端原始 output 事实，不参与这次归一化。
- catalog 查询命中明确 `maxOutputTokens` 时，只能在用户尚未手动编辑该字段时覆盖 `128000`；未命中、未声明、查询失败或迟到结果均保留当前值，不再清空为无默认值。
- Image/Video 输入选择会影响现有运行时媒体能力投影；旧配置或权威事实里的 PDF 继续参与现有投影。
- Video 输入作为 provider 模型事实保存，并通过现有 `supportsVideo` 能力投影参与对话附件校验；不支持 Video 编码的 provider adapter 仍在运行时拒绝或降级，不能只凭设置页勾选绕过。
- 只读的内置套餐/权威远端模型继续展示服务端事实，不开放本地编辑，避免用户配置与后续远端同步互相覆盖。

### 显式来源

推荐给 `ModelProviderModelConfig` 增加可选来源字段，例如：

```ts
modalitiesConfigured?: boolean;
```

语义：

- `true`：用户或权威 catalog 明确提供了模态事实；input 中缺少 image/pdf 可以投影为显式 `false`。
- `undefined`：历史 custom/legacy 配置没有可靠模态事实；即使归一化数组是 text-only，也继续保持媒体能力未知。
- catalog-backed/远端权威模型不依赖用户标记，仍按现有权威来源规则投影。

字段需要通过 `zcode` 扩展保存，避免污染 OpenCode 公共字段；顶层 `modalities` 继续保存真实 input/output 数组。命名可在实现前调整，但必须保留同等的来源区分，不能复用粗粒度的 `modified`：用户只修改 context window 时不应被误判为显式 text-only。

草稿需要单独跟踪模态是否被用户触碰。打开旧模型后只修改 context window，不得自动写入 `modalitiesConfigured=true`；只有用户改变模态，或新增模型时主动确认模态选择，才写入显式来源。

### 视觉能力标识

- 当模型配置的 `modalities.input` 包含任意非 `text` 类型时，UI 将该模型标记为视觉模型。该判定只消费模型已经声明的输入类型，不依赖 `modalitiesConfigured`、输出类型、provider adapter 或附件编码能力。
- 标识文案随系统语言切换：中文为“视觉”，英文为“Vision”；可访问名称和悬停标题复用同一国际化文案。
- 标识展示在两个共享入口：
  1. 模型选择菜单中紧跟完整模型名，位于左侧内容区；选中对号继续固定在行尾。
  2. 模型设置的紧凑模型行中，与上下文窗口容量徽标并列展示；从左到右固定为“视觉 / Vision”、上下文窗口容量，容量徽标保持在最右侧。
- 两处复用同一 `rounded-md`、语义边框/表面色和紧凑字号样式；上下文窗口继续使用等宽字体，视觉文案使用普通 UI 字体。
- 两处视觉标识必须复用同一个国际化键；英文环境下均显示精确文案 `Vision`，不得在任一入口回退为中文或使用不同英文名称。
- 模型 ID 是不透明字符串。`openrouter/ox-alpha`、`openrouter/nvidia/model` 等包含一个或多个 `/` 的 ID 必须原样展示、编码和选择，不得为了标识投影按 `/` 拆分或反向匹配。
- 该标识只描述模型配置中的输入类型事实，不新增附件入口、不绕过运行时 capability guard，也不改变模型选择值、provider registry、请求参数或持久化格式。

## 状态与同步链路

```text
模型设置弹窗
  local draft
  ├─ inputModalities
  ├─ outputModalities=[text]
  └─ modalitiesTouched
          |
          | 保存 + 校验
          v
本地 modelProviderService（唯一权威）
  ~/.zcode/v2/config.json
  ├─ model.modalities.input/output
  └─ model.zcode.modalitiesConfigured
          |
          | provider registry revision
          +-------------------------------+
          |                               |
          v                               v
桌面本地 runtime                    desktop-attached 远端 runtime
workspace/updateProviderRegistry     本地快照显式下发，不写远端配置
          |                               |
          +---------------+---------------+
                          v
协议模型能力投影
  catalog-backed 或 modalitiesConfigured=true
    ├─ input 包含 image -> supportsImages=true
    ├─ input 不含 image -> supportsImages=false
    ├─ input 包含 pdf   -> supportsPdf=true
    ├─ input 不含 pdf   -> supportsPdf=false
    ├─ input 包含 video -> supportsVideo=true
    └─ input 不含 video -> supportsVideo=false

  legacy custom 且未显式配置
    └─ 不下发 supportsImages/supportsPdf/supportsVideo，保持 unknown
                          |
                          v
当前 session 热更新 modelInputMediaCapabilities
                          |
                          v
provider-visible request 媒体保留或文本化
```

### 客户端边界

- Desktop local 与 desktop-attached remote 使用相同 provider registry revision 语义。
- 远端 workspace 必须继续使用 `workspaceIdentity?.trim() || workspacePath` 隔离同步状态，并携带 `remoteSessionId`；`workspacePath` 只用于执行和展示。
- 手机 `/remote` 仍附着桌面已有 host；不新增独立 runtime，也不把模态设置写入 replayable snapshot。
- 本功能不修改 `clientMode` / `deliveryKind`，必须用回归用例证明 desktop continuous 与 web remote replayable 均未被改变。

## UI Surface Matrix

| 场景           | UI 入口                                                  | 草稿 owner                  | 默认/回显                                     | 校验                                   | commit sink         | 权威落点             | 边界                                |
| -------------- | -------------------------------------------------------- | --------------------------- | --------------------------------------------- | -------------------------------------- | ------------------- | -------------------- | ----------------------------------- |
| 添加自定义模型 | `ProviderModelsSection` -> `ProviderModelMetadataDialog` | add draft state             | context=1M、maxOutput=128K、input/output=Text | ID 必填、数字为正整数、Text input 锁定 | `onAddModel`        | 本地 provider config | 新模型显式保存类型                  |
| 编辑自定义模型 | `ModelRowInput` -> `ProviderModelMetadataDialog`         | row draft state             | 已保存 input + 固定 Text output               | Text input 不可取消                    | `onModelCommit`     | 本地 provider config | 未触碰输入模态不得改变 unknown 语义 |
| 内置/套餐模型  | provider settings read-only row                          | 无可编辑草稿                | catalog/remote facts                          | 服务端 schema                          | 不提交              | 本地权威同步缓存     | 不允许本地覆盖权威事实              |
| 对话模型运行时 | 无新增 UI                                                | 当前 session runtime config | provider registry projection                  | existing capability guard              | registry hot update | Agent runtime memory | 消费 image/pdf/video input          |

共享模型选择器、自动化、Subagent、Repo Wiki 只读取 provider registry 候选，并在候选模型声明任意非 Text 输入类型时展示“视觉 / Vision”标识。本次不改变它们的 draft、default 或 commit sink；需要做候选与默认隔离回归，但不新增模态编辑入口。

## 数据与验证规则

- `ProviderModelDraftValues` 增加 input 模态数组和 `modalitiesTouched`（或等价局部状态）；output 在可编辑模型提交时固定为 `["text"]`。
- 模态按公共枚举固定顺序去重保存，不接受 UI 之外的未知枚举。
- input 必须包含 Text，UI 不提供取消路径，commit resolver 仍做防御性校验。
- 上下文窗口和最大输出 Token 都必须是正整数，不再允许最大输出 Token 留空。
- 取消弹窗丢弃模态草稿，不修改 provider registry。
- 模态变更与现有 ID、API format、context window、max output tokens 一次原子提交。
- 编辑其他 metadata 时必须保留已有 input modalities 和显式来源；output 按已确认边界归一化为固定 Text。
- Video 必须只映射到 `supportsVideo`；Audio/输出类型不得被错误映射到 `supportsImages` / `supportsPdf` / `supportsVideo`。
- 不新增 ZCode Protocol 字段；当前协议已有 optional `supportsImages`、`supportsPdf`、`supportsVideo`。Audio 若要立即生效，必须先扩展协议 schema 和 runtime 能力，该要求不属于本 spec。

## 必须保持的不变量

- legacy custom 模型的媒体能力未知态不因升级或编辑其他字段变成明确 false。
- 用户显式取消 Image 后，当前匹配 session 无需重启或重新选模型即可收到能力刷新；隐藏的 PDF 事实不得因编辑其他可见类型而丢失。
- provider settings 是唯一编辑入口；对话工具栏、自动化、Subagent、Repo Wiki 不获得新的模态 commit 权限。
- 本地和远端 workspace 使用同一份本地 app-global provider 权威事实。
- 主题、国际化、键盘操作和手机 Web 小屏布局可用；输入类型选项允许换行，UI 使用 `text-ui-*` 与语义色 token。
- 视觉标识不得占用模型行尾的选中对号位置；长模型 ID（包括多段 `/`）仍作为完整值参与选择，只有可见文本可以按现有布局截断。
- 设置更新不改变任务消息、队列、snapshot、owner/lease 或 delivery semantics。

## 已裁决边界

- 所有字段按无标题卡片分组，不额外引入层级。
- 新增模型除模型 ID 外都有默认值：1M context、128K max output、Text input/output。
- 输入 Text 锁定，Image/Video/PDF 独立可选；Audio 暂不展示但保持数据兼容。
- 输出只支持固定 Text，不提供其他选项。
- 任意非 Text 输入类型触发“视觉 / Vision”展示；text-only 和缺少结构化模态事实的 legacy 字符串模型不展示。
- 权威 catalog 模型继续沿用现有只读/authoritative 边界，不开放本地覆盖。

feature graph 已补充 `capability.model-capabilities` 到共享模型候选和 provider settings 的视觉标识投影关系；既有 `surface.provider-settings -> capability.provider-registry` 显式模态来源关系保持不变。

## 验收证据

- UI 单测：添加/编辑、默认值、回显、多选、键盘、取消、校验、i18n。
- 展示单测：text-only 与任意非 Text 输入类型判定、模型菜单左侧徽标/行尾对号布局、设置行容量徽标并列、中英文文案、含多段 `/` 的模型 ID round-trip。
- draft 单测：排序去重、原子提交、保留未修改字段、旧模型未触碰模态保持 unknown。
- shared/services 单测：schema、OpenCode config 读写、`zcode` 来源标记 round-trip、legacy migration。
- protocol/bootstrap 单测：正向/负向 image/pdf/video 投影、active session 热更新、未知态保留。
- 桌面 E2E：真实设置页保存、配置落盘、provider registry revision、最终 provider request。
- 远端 E2E/集成：本地 provider snapshot 下发远端 runtime，远端配置文件不成为权威源。
- 回归：模型选择、自动化、Subagent、Repo Wiki、desktop continuous、mobile replayable 均无副作用。
