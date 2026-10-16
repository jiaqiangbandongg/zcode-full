# Assistant Code Comment Cards

## 状态

- 本文是 Assistant 输出 `::code-comment{...}` 在 ZCode Renderer 中解析、展示与只读 Code Review 跳转的功能规范。
- 本功能只派生 UI，不新增 ZCode Protocol、session snapshot、relay、Host 或 Agent runtime 状态。
- capability 默认关闭；Desktop 与手机 `/remote` 的 workspace bridge 显式开启，普通 Web Server
  入口保持关闭。关闭时保留现有原始 directive 展示，避免 Agent 已输出审查意见但 Renderer 静默吞掉。

## 功能摘要

| 字段 | 结论 |
| --- | --- |
| 改动层级 | presentation、validation、commit-effect |
| 输入 | 已持久化 Assistant text row 中的 `::code-comment{...}` |
| 输出 | 正文投影文本 + turn-local 单行代码审查卡片组 |
| 点击效果 | 直接打开 workspace-scoped `code-review` CodeViewer，定位行并用现有评论样式展示只读模型评论；不要求文件处于 Git 变更中 |
| 灰度 owner | Renderer Root capability `assistantCodeCommentCardsEnabled`，默认 `false`；Desktop 与手机 `/remote` workspace bridge 显式为 `true` |
| 恢复 | 从原始 row text 确定性重建，不持久化独立卡片状态 |
| 不涉及 | 卡片生成阶段文件存在性检查、Assistant Preview Cards 15→10 配额、Composer code-comment 草稿、Git diff 与历史 diff 快照 |

## Directive 契约

```text
::code-comment{title="[P1] 空指针风险" body="user 为空时仍会访问 user.id" file="src/user.ts" start=42 end=45 priority=1}
```

- 必填：`title`、`body`、`file`，trim 后必须非空。
- 可选：`start`、`end`、`priority`。
- `start` / `end` 是 1-based 正整数；只有 `start` 时 `end=start`；`end < start` 时不保留行范围，但评论卡片仍可展示并定位文件。
- `priority` 仅接受 `0`、`1`、`2`、`3`；非法值降级为无优先级，不丢弃整条评论。
- 暂时忽略其他语法正确的参数。
- 支持单/双引号、引号与反斜杠转义、Unicode、空格、Windows 盘符和 UNC 路径。
- 指令语法错误、缺少必填字段，或 latest Assistant row 进入 `failed` 时不生成卡片；failed turn 的整轮 directive 都不从正文删除，避免早段评论被静默丢失。
- fenced code、inline code、HTML code/pre 内的示例不作为真实指令。

## 正文投影与卡片归属

```text
raw assistant text rows
        |
        +--> projection per row --> visible Markdown（完整有效 directive 被删除）
        |
        `--> merge whole turn text --> comments[]
                                      |
                                      `--> latest terminal assistant text row
                                           complete / interrupted
```

- 灰度开启后，完整有效 directive 不进入正文 Markdown；独占一行时删除整行，内联时以一个空格替代。
- streaming 尾部未闭合的 `::code-comment{` 暂时从正文隐藏；只有 `complete` / `interrupted` 终态才形成卡片。`failed` row 和终态仍不合法的内容恢复为普通正文。
- 仅当未闭合内容仍是合法参数前缀时才隐藏；若缺失 `}` 的输出已经接着普通正文、参数格式已明显损坏，或协议位于代码示例中，则保留原文，避免模型异常输出吞掉后续回答。
- 卡片只挂到同一 turn 最后一条终态 Assistant text row：流式期间即使指令已经闭合，也只更新正文投影，不提前生成卡片；`complete` / `interrupted` 时一次性重建全部合法卡片。未闭合流式尾部、`failed`、非轮尾 row 不展示。轮尾 failed 时整轮正文关闭 directive 投影并恢复原文。
- 卡片按 directive 在正文中的正序排列，不沿用 Assistant Preview Cards 的逆序规则。
- 默认折叠，点击标题行后一次性展示全部评论；单轮最多投影 50 条，超过部分不展示。
- 不调用 `fileChanges`、`fileService.checkFilesExist`。目标文件只在点击后由 Preview Pane 通过当前 workspace service 读取。
- 复制与会话搜索只使用可见正文，不能命中或复制已经隐藏的 directive 原始语法；第一版不把仅存在于卡片或 Review 评论区的 title/body 加入会话全文搜索。

## 灰度语义

| 开关 | 正文 | 卡片 | 原因 |
| --- | --- | --- | --- |
| `false`（默认） | 保留当前原始 directive | 不显示 | 兼容已启动且仍可能输出 directive 的 Desktop Agent，避免评论被静默丢弃 |
| `true` | 隐藏完整有效 directive；流式半截不闪现 | 显示 | 灰度用户获得结构化审查体验 |

后续若要求“关闭时也绝不展示原始 directive”，必须让同一能力开关同时控制 Desktop context 的 directive 输出要求；仅在 Renderer 隐藏而不控制 Agent 输出是不安全的。

手机 `/remote` 有 external relay 与 token/WebSocket 两条 workspace bridge 装配路径，两者都必须显式开启；
普通 Web Server 和不承载会话正文的 home-only 入口保持默认关闭。该开关只控制 Renderer 对同一持久化
Assistant row 的派生展示，不进入 Host、relay、snapshot，也不改变 `web-remote-replayable` 恢复语义。

## 卡片界面

```text
┌──────────────────────────────────────────────┐
│  [>] 4 条评论                                  │
├──────────────────────────────────────────────┤
│              默认折叠，点击标题行展开          │
└──────────────────────────────────────────────┘
```

- 外层与 Git 状态卡片统一使用 `bg-card border-border rounded-xl shadow-none`；标题悬停使用 `bg-hover`。
- 顶部使用本地化评论数量（如 `2 comments` / `2 条评论`），不再单独显示“代码审查”和数量两段标题；默认显示 `>`，点击标题行展开全部评论并改为向下指示。
- 每条卡片只能占一行：`priority → title → path:range`，不显示右侧箭头；超长标题和路径在自身区段截断，路径使用普通 UI sans 字体，不用等宽字体。
- 展开列表使用 `border-t border-border`；每项由外层 `bg-background/50` 基础面和内层 `hover:bg-hover/30` 可点击行组成，保持与 Git 文件行一致的背景叠加关系。行之间不增加分割线。
- 卡片不在 Assistant 正文展示 `body`，避免审查正文和常规回答混排；`body` 仅在打开 `code-review` CodeViewer 后，以现有代码评论样式展示。
- 卡片文字显式允许选择。拖拽形成的同卡片文本选区不触发导航；点击空白处、未形成选区的点击，以及键盘 Enter/Space 仍打开 Review。
- `code-review` source 的 title、priority、行范围和 body 都来自本次 Renderer-local source；其中 CodeViewer 评论块只展示与用户评论一致的行范围和 body，title/priority 继续由卡片表达。不写入 Git、session snapshot 或 Composer comment store。
- P0-P3 使用文字 badge，颜色只作为辅助，不能成为唯一信息来源。
- 若 title 已以同一 `[P0]`…`[P3]` 开头，展示时去掉重复前缀，原始数据不变。
- 整行可点击并支持键盘 Enter/Space；手机窄屏仍保持单行，通过分段截断而非换行维持紧凑的审查列表。
- 卡片与 Assistant Preview Cards 分开渲染，不共享数量上限、文件校验和点击分流。

## Code Review Source 与导航状态机

点击产生 Renderer-local `CodeViewerSource`；不新增顶层 side-pane 类型：

```ts
interface CodeReviewAnchor {
  requestId: string;
  title: string;
  body: string;
  priority?: 0 | 1 | 2 | 3;
  startLine?: number;
  endLine?: number;
}

interface CodeReviewCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "code-review";
  title: string;
  path: string;
  review: CodeReviewAnchor;
}
```

```text
card click
  -> 构造 CodeReviewCodeViewerSource（path + workspace scope + review）
  -> openCodeViewerSidePane()
  -> Preview Pane 使用 workspace-scoped fileService.readTextFile()
  -> 合法行范围：复用 CodeViewer selectedLines + CommentAnnotation
  -> requestId 变化：滚动到目标行
  -> 无行号或越界：在代码区顶部展示同样的只读评论样式
```

- directive 的文件路径仍由卡片 builder 解析为 workspace 内绝对路径；`workspacePath` 用于文件读取和展示，tab 隔离使用 `workspaceKey = workspaceIdentity?.trim() || workspacePath`。
- `code-review` tab key 使用 `workspaceKey + code-review + path`，不包含 `requestId`：同一文件的另一条评论复用同一 tab 并更新锚点；普通 `file` tab 与 `code-review` tab 保持分离。
- 有合法行号且范围落在文件内：高亮 `startLine...endLine`，在结束行后展示现有 `CommentAnnotation`；评论继续随代码滚动，`requestId` 变化时调整纵向滚动，使评论位于可视区下沿附近，同时保持当前横向滚动位置。
- 没有行号：打开文件，在代码区顶部展示同样的只读评论块，不伪造行号或高亮。
- 行号超过文件范围：仍打开文件并在顶部展示评论，不伪造高亮，同时提示目标行不存在。
- 文件不存在：沿用 Preview Pane 的 workspace-scoped 读取错误；不刷新 Git，不回退到 Git Review。
- Markdown/HTML 在 `code-review` 模式下展示源码；binary/too-large 文件沿用 Preview Pane 既有错误状态。
- 模型评论只作为 source 内的临时只读数据传给 CodeViewer；不读取或写入 `useCodeCommentPreviewStore`，不提供 gutter、框选、添加或删除评论交互。
- Desktop local/remote 和手机 `/remote` 共用现有 code-viewer side pane / overlay；两条手机 workspace bridge Root 与 Desktop 一样显式开启 capability。remote 通过 source 携带的 `workspaceIdentity`、`workspaceRemoteSessionId` 选择正确 workspace service，delivery/replayable 状态不改变。普通 Web Server 入口继续使用 capability 默认值 `false`。

## UI Surface Matrix

| 场景 | UI 入口 | 展示 owner | gating | 点击/提交 | 权威状态 | 模式边界 | 必须隔离 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Assistant 正文 | `AssistantTextRowView` / `MessageResponse` | 原始 row 的纯投影 | feature flag + directive 合法性 | 无 | session row text | desktop continuous 与 mobile replayable 同规则重建 | 不修改 row/snapshot |
| 审查卡片 | `AssistantCodeCommentCards` | turn-local 派生 model | latest terminal row（complete / interrupted）、50 条上限 | 打开 `CodeReviewCodeViewerSource` | 无独立持久化 | 手机使用既有 side-pane overlay | 不占文件预览额度，不写 Composer store |
| 只读 Code Review | `PreviewPane` / `CodeViewer` / `CommentAnnotation` | source.review + workspace 文件内容 | workspace scope + 文件读取；行范围按实际内容裁决 | 复用 code-viewer tab、更新锚点并滚动 | workspace-scoped File Service | local/remote service 注入不同，UI 语义相同 | 不读写 Git，不创建 Composer 评论，不切 workspace |

## 影响简报

| Rank | 关系 | 结论 |
| --- | --- | --- |
| must-inspect | raw Assistant rows -> Markdown projection | directive 删除不能破坏 GFM、流式容错、复制与搜索 |
| must-inspect | turn projection -> code-comment cards | latest terminal row 上展示；流式只隐藏未闭合尾部，cold resume 确定性重建 |
| must-inspect | card click -> Code Review source | source key、workspace service、只读评论适配和行定位属于同一导航事务 |
| should-inspect | Desktop context prompt | 灰度关闭时仍可能输出 directive，不能静默删除 |
| conditional | remote/mobile | 复用 workspace-scoped File Service 和既有 code-viewer overlay，不改变 replayable 恢复 |
| invariant-only | Composer code comments | 用户向 Agent 附加代码评论的 store/event 不复用、不修改 |
| invariant-only | Assistant Preview Cards | 不调用 fileChanges/stat，不共享 15→10 配额；code-comment 点击后才读取目标文件 |

当前工具环境没有 codegraph，影响分析使用 feature graph 声明、精确源码调用方和 focused tests 作为证据；实现后更新图谱 code seeds 并运行完整图谱校验。

## 用例与剪枝

| ID | Setup | Action | Assertions | 状态 |
| --- | --- | --- | --- | --- |
| ACC01 | 开关开启，complete turn 含两条合法 directive | 渲染与框选卡片文字 | 正文无原始语法；卡片按正序以单行展示 priority/title/path/range，不展示 body；文字可选择且框选不触发导航 | accepted |
| ACC02 | workspace 中存在目标文件和合法行范围 | 点击卡片 | 打开 `code-review` CodeViewer、高亮并滚动目标范围；用现有评论样式只读展示 body；没有添加/删除交互且不写 Composer store | accepted |
| ACC03 | 开关关闭 | 渲染同一文本 | 不展示卡片，原始 directive 保持现状 | accepted |
| ACC04 | streaming 半截、已闭合 directive、complete、interrupted、failed | 推进状态 | 流式半截不闪现；流式期间不出卡；complete/interrupted 才出卡；failed 整轮和非法终态恢复正文 | accepted |
| ACC05 | 已持久化历史 turn | cold resume/虚拟行重挂 | 从 row text 重建同一正文与卡片，不新增 RPC | accepted |
| ACC06 | 文件无 Git 变更、没有行号、行号越界、文件不存在，或同一文件有多条评论 | 点击 | Git 状态不影响打开；无行号/越界时在顶部展示只读评论且越界有提示；缺失文件显示读取错误；同文件复用 code-review tab 并更新锚点，不切换 workspace | accepted |
| ACC07 | Desktop Host 已持久化含合法 directive 的终态 turn，手机通过 external relay 或 token/WebSocket `/remote` bridge hydration，并切换 local/remote workspace | 查看同一 turn 并点击卡片 | 两条手机 bridge Root 都开启 capability；正文不泄露原始 directive，卡片与 Desktop 确定性一致；workspace 切换后仍开启且导航保留 `workspaceIdentity` / `remoteSessionId`；普通 Web Server 入口仍关闭 | accepted |

剪枝：首版不做 Git diff 或历史 diff snapshot；不把 desktop/web/mobile 与所有 priority/path/source 做全排列；Windows/UNC 路径由 focused tests 覆盖，Desktop local 作为首批窗口 E2E 代表。E2E fixture 只需准备真实存在/缺失的 workspace 代码文件，不要求 Git 变更，也不 fake 卡片生成阶段的文件存在性检查。

## 主要实现文件

- `packages/ui/src/lib/assistantDirectiveParser.ts`
- `packages/ui/src/lib/assistantCodeComment.ts`
- `packages/ui/src/AssistantCodeCommentFeatureProvider.tsx`
- `packages/ui/src/AssistantCodeCommentCards.tsx`
- `packages/ui/src/lib/codeViewer.ts`
- `packages/ui/src/lib/workspaceSidePane.ts`
- `packages/ui/src/PreviewPane.tsx`
- `packages/ui/src/previewPaneCodeReview.ts`
- `packages/ui/src/previewPaneContent.tsx`
- `packages/ui/src/previewPaneCodeContent.tsx`
- `packages/ui/src/components/ui/code-viewer.tsx`
- `packages/ui/src/v4/ConversationRowView.tsx`
- `packages/ui/src/v4/ConversationTurnGroup.tsx`
- `packages/ui/src/v4/conversationRowContext.ts`
- `packages/ui/src/v4/SessionPane.tsx`
- `packages/ui/src/App.tsx` 与 app-shell 中旧 Git navigation callback wiring 的删除
