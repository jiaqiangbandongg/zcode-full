# PPTX 预览

## 目标

第一期在工作区 Preview Pane 中提供 `.pptx` 只读预览。预览使用
`@aiden0z/pptx-renderer` 在 Renderer 内解析 OOXML，并将选中幻灯片渲染为 DOM。用户可以显式进入
“选择元素”模式，把具体元素作为结构化引用加入当前主 Composer；Agent 再通过官方 PPTX skill 对
引用做 fingerprint 校验、OOXML 定位和窄范围写回。

Preview Pane 内不提供 DOM 编辑、PPTX 导出或直接写回；Desktop 可以把当前只读渲染结果导出为新的
PDF，但接口必须按能力拆分，后续实现不能依赖 `@aiden0z/pptx-renderer` 的私有 DOM 结构。Preview Pane
顶栏保留与
XLSX、DOCX 相同的通用“在外部编辑器打开”按钮；该操作离开内置预览，不属于 PPTX 内部编辑能力。

## 产品边界

- 仅支持 `.pptx`；`.ppt`、`.pptm`、加密或损坏文件不在第一期范围内。
- 内置 PPTX 预览保持只读，不展示 DOM 编辑、PPTX 保存或协作入口。Desktop 在平台同时提供
  `printPageToPdf` 与 `saveFile` 时展示“导出为 PDF”；Web 和手机 `/remote` 不展示 Electron-only 入口。
- PDF 导出创建新的本地 `.pdf`，不覆盖源 PPTX，也不写回远程 workspace。输出表达当前
  `pptx-renderer` DOM 的 Chromium 打印效果，不承诺 PowerPoint/WPS 原生或无损转换。
- 元素引用首期只支持 slide-owned `shape`、`picture`、`chart`、`table` 与 `table-cell`。master/layout
  元素、group 本身及组内非文本子元素不生成可选引用；组内文本可作为 shape 文本引用。
- 普通点击继续承担超链接等预览交互；只有用户显式开启“选择元素”模式后，元素 overlay 才接管点击。
- 选择一个元素后先显示本地选中态，再由用户执行“添加到当前任务”；不会自动发送 prompt。
- 引用只加入当前 focused/primary Composer，按 `workspaceKey + remoteSessionId + draft/session scope`
  隔离；相同 source path、fingerprint、slide part、node id 与 table cell 坐标精确去重。
- Composer 聚合 chip 只负责展开引用列表；列表中的具体引用项可打开对应 PPTX，并尝试定位引用时的
  `slideIndex`。草稿引用与历史 user row 中恢复的只读引用使用相同导航语义。
- 引用导航开始前必须退出 Preview Pane 的元素选择模式并清除本地选中元素。导航只定位文件与页码，
  不自动恢复选择模式、不高亮旧元素，也不修改结构化引用。
- 文件不存在与引用页码不存在使用两个独立 toast。只要文件仍可打开，即使引用页码已不存在，也必须
  展开文件预览；新打开的文件停留在默认页，已打开的同文件保留当前页，不能把 clamp 后的其它页伪装成
  定位成功。
- 文件 fingerprint 已变化但原页码仍存在时，继续按原页码定位，并以非阻塞 toast 提示内容可能与引用时
  不同。文件/页码导航失败不影响 Composer 草稿或历史引用。
- 顶栏展示 Preview Pane 通用的“在外部编辑器打开”按钮，与 XLSX、DOCX 使用相同的编辑器选择、
  能力判断和 `IPlatformService.openInEditor()` 链路；该入口不改变内置预览的只读边界，也不承担
  原文件写回语义。
- 不承诺 PowerPoint 完整保真。动画、切换、公式、OLE、完整 EMF/WMF、真实 3D 等内容按
  `pptx-renderer` 的当前能力降级。
- UI 相关最终验收由人工在 Desktop 和手机 Web 上完成。

## 已打开文件的变化自动重载

已在 Preview Pane 标签页中打开的 PPTX 必须监听源文件所在目录。Host 文件监听事件命中当前
`source.path` 后，Preview Pane 重新读取完整文件字节，并把新的 `ArrayBuffer` 交给 viewer generation
生命周期。不能把 watcher、文件读取或预览状态放进 desktop main、relay、Agent runtime 或 conversation
snapshot。

```text
open PPTX tab
  -> workspace-scoped fileWatcherService.watch(parent directory)
  -> watcher subscription ready
  -> initial stat + range read + final stat
  -> viewer generation N

target file changed / renamed / recreated
  -> debounced directory event
  -> reload generation latest-wins
  -> stat + range read + final stat
     |-- complete -> dispose viewer N -> reset local preview state -> viewer N+1
     |-- stale read -> ignore; latest generation owns the result
     |-- missing/invalid -> show existing localized read error; keep directory watcher alive
```

### 边界决策

| 边界          | 决策                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------- |
| 监听对象      | 监听父目录而不是文件句柄，兼容 PowerPoint/WPS 的临时文件加原子 rename 保存方式                                        |
| 目标过滤      | `FileWatchEvent.changedPath` 可选；明确为其它文件时忽略，旧 Host 或未知路径事件保守重载                               |
| 首次读取      | 先建立 watcher 订阅再读取，避免订阅建立前的保存事件导致预览长期停留在旧版本                                           |
| 并发          | watcher 事件只增加 reload generation；旧 range read、旧解析和旧 render 均不得提交状态                                 |
| 状态重置      | 成功接收新字节后回到第 1 页、100% 缩放并退出元素选择，清除选中元素和未确认 AI 编辑草稿                                |
| Composer 引用 | 已加入 Composer 或历史消息的结构化引用保留原 fingerprint，不随预览重载删除或改写                                      |
| 本地/远程     | 继续通过 `useWorkspaceServices(workspacePath, remoteSessionId, workspaceIdentity)` 选择已有 Host watcher/file service |
| delivery      | 预览重载是 renderer-local 投影，不进入 desktop continuous 或 web remote replayable 消息流                             |
| PDF 导出      | 本轮不改变导出事务；导出中的 document generation 不因异步 watcher 回调被错误复用，失败仍走既有导出错误路径            |

### 状态组合与剪枝

| Case ID        | Setup                                         | Event                                    | Expected result                                                    | 状态                     |
| -------------- | --------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------ | ------------------------ |
| PPTX-RELOAD-01 | 本地 PPTX 标签页已打开                        | 同一文件保存                             | 重新读取并以全新 viewer generation 从默认状态显示                  | accepted                 |
| PPTX-RELOAD-02 | SSH/WSL/Docker 或手机 `/remote` 附着已有 Host | 同一远程文件保存                         | 只调用对应 workspace-scoped watcher/file service，不读取本机同路径 | accepted                 |
| PPTX-RELOAD-03 | PPTX 已打开                                   | 同目录其它文件变化且事件含 `changedPath` | 不重新读取 PPTX                                                    | accepted                 |
| PPTX-RELOAD-04 | 旧 Host 或平台 watcher 不提供具体变化路径     | 收到目录事件                             | 保守重新读取当前 PPTX                                              | accepted                 |
| PPTX-RELOAD-05 | 连续保存或写入期间发生多次事件                | 多个读取并发                             | 只有最新 reload generation 可以提交字节、错误和 loading 状态       | accepted                 |
| PPTX-RELOAD-06 | 文件被删除后标签页仍打开                      | 删除后重新创建                           | 先显示缺失错误；父目录 watcher 保留，重建后恢复预览                | accepted                 |
| PPTX-RELOAD-07 | 已存在 Composer PPTX 引用                     | 源文件重载                               | viewer-local 选择清空，Composer 引用保持原 fingerprint             | accepted                 |
| PPTX-RELOAD-08 | 未打开或标签页已关闭                          | 文件变化                                 | 不存在 watcher，不触发读取                                         | pruned：无可见预览 owner |

该能力不涉及 conversation/session 状态组合，不新增 conversation E2E case catalog 或 coverage matrix；
自动化覆盖 service、hook 和 viewer lifecycle，真实 Office 保存行为与 UI 刷新由人工在各平台验收。

## PDF 导出

Desktop PDF 导出复用同一 `PresentationPreviewDocument`，在 Renderer 中创建一次性的全量打印 DOM，
等待页面 render handle、字体、图片解码和两个绘制帧就绪后，再由 Desktop Main 对当前
`webContents` 调用 `printToPDF()`。保存对话框只在 PDF 字节生成成功后出现；取消保存不报错，打印或
保存失败使用统一失败反馈。打印 DOM 与 render handle 在成功、失败和取消路径都必须释放。

```text
viewer(document ready)
  -- export --> render pages serially in print host
               -> materialize printable font families
               -> await fonts/images/paint frames
               -> desktop main printToPDF
               -> dispose print host
               -> saveFile dialog
                  |-- canceled -> viewer(document ready)
                  |-- saved ----> success toast
                  `-- failed ---> failure toast
```

字体处理只作用于一次性打印 DOM，不修改主预览 DOM：

- 已安装、可测量且能进入 Chromium PDF 的首选字体保持不变，避免无条件统一字体造成版式退化。
- 若 PPTX 指定字体在当前系统不可用或已知无法进入当前 Chromium PDF，从原字体栈中选择首个真实可
  打印字体；若整条字体栈均不可用，按 CJK/Latin 文本和 sans/serif/monospace/narrow 类别选择当前
  操作系统可用的确定性 fallback。macOS `PingFang SC` 在当前 Skia/PDF m146 可用于屏幕绘制但不会写入
  PDF，导出时必须跳过并选择 `Hiragino Sans GB`、`Arial Unicode MS` 等可打印 CJK 字体。
- 打印前必须移除不可用字体前缀，把真实可用字体放在 `font-family` 首位。仅等待
  `document.fonts.ready` 不能证明系统字体存在，也不能证明 Chromium PDF 管线会保留屏幕端的隐式
  fallback。
- 字体替换可能改变字符宽度与换行，因此 PDF 仍以“当前预览能力下的可读导出”为边界；不能把 fallback
  描述为原字体保真或 Office 原生转换。

## 界面

```text
┌──────────────────────────────────────────────────────────────┐
│ Preview Pane header                                          │
│                                      [Open in editor]         │
├──────────────┬───────────────────────────────────────────────┤
│              │                                               │
│  1 [thumb]   │                                               │
│              │       [Select element] selected slide         │
│              │             ┌───────────────┐                  │
│              │             │   AI 编辑     │                  │
│              │             └──────┬────────┘                  │
│              │             ┌──────┴────────┐                  │
│              │             │ selected node │                  │
│  2 [thumb]   │                                               │
│              │                                               │
│  3 [thumb]   │                                               │
│              ├───────────────────────────────────────────────┤
│  ...         │  ‹  [page] / total  ›     −   100%   +       │
└──────────────┴───────────────────────────────────────────────┘
```

- 左侧是固定语义的垂直缩略图列表；选中项使用 `bg-selected` 和可见边框。
- 主区域一次只挂载一页，保持页面纵横比并在可用区域内居中。
- PPTX 预览的缩略图栏和底部工具栏统一使用 `bg-surface/30`；幻灯片外框、缩略图画布和主预览画布保持原有背景层级，幻灯片渲染内容、选中态和 hover 语义保持独立。
- 主区域下方工具栏支持上一页、下一页、输入页码跳转、缩小、显示倍率和放大。
- 工具栏提供显式“选择元素”开关；打开后，hover/selected overlay 使用稳定 element bounds，不读取
  `pptx-renderer` 私有 DOM class、子节点顺序或 store。
- 多层元素按 slide z-order 命中最上层；table cell 比 table 容器优先。选中元素上方先展示只包含
  “AI 编辑”的上下文悬浮条；点击后只进入 viewer-local 编辑意见草稿，不立即向 Composer 分发引用。
  原悬浮条替换为沿用代码评论样式的多行评论框、“取消”和“添加到对话”二阶段悬浮条：取消只丢弃本次意见并回到
  “AI 编辑”菜单；确认后才把结构化引用加入当前 Composer，不自动发送 prompt，并保留元素高亮。
  输入为空也允许添加纯元素引用；非空输入 trim 后保存为 `comment`。评论框展开期间，键盘输入归输入框
  所有：方向键只移动光标、不翻页，Esc 与“取消”同义，只丢弃本次评论草稿并回到“AI 编辑”菜单；中文/日文
  输入法组合态下的 Esc 属于取消候选词，既不关闭悬浮条也不丢弃草稿（同时读取 composition 事件维护的本地
  状态与平台 `isComposing`，避免事件时序让其中一个提前失效）；未展开评论框时 Esc 才退出选择模式。
- 已高亮的 `shape` 或 `table-cell` 含有文本时，其 bounds 内恢复浏览器原生文字划选；高亮框和“AI 编辑”
  悬浮条继续保留。拖拽划选不改变结构化元素选择，也不触发 PPTX 内的超链接或页面跳转；点击 bounds 外
  的其它元素仍切换当前高亮。picture、chart、table 容器等无文本元素维持 overlay 接管指针的行为。
- 执行“AI 编辑”时若浏览器存在非空文字选区，引用的 `selectedText` 只保存当前高亮元素 bounds 内且
  可由该元素完整文本复核的划选文本；跨越其它 shape 或 table cell（包括 bounds 重叠元素）的选区必须
  过滤掉其它元素内容。`text` 与 `textFingerprint` 始终对应当前高亮元素的完整文本，Agent inspect
  使用完整文本 fingerprint 做冲突校验，`selectedText` 只作为模型理解用户编辑意图的上下文。若没有
  可归属到当前高亮元素的非空选区，则不生成 `selectedText`。
- `comment` 对齐代码视图评论的既有语义，只保存用户针对当前元素输入的修改意见，是引用的可选模型
  指令；它与
  `selectedText` 都不参与 `sourceFingerprint`、`textFingerprint`、OOXML 定位、去重或冲突校验。
  模型必须先按原始引用 inspect 完整元素，再结合 `selectedText` 与 `comment` 生成完整替换文本。
- 悬浮条以选中元素 overlay 作为定位锚点，通过应用层 Portal 渲染，保持稳定 UI 尺寸，不跟随
  幻灯片 zoom 缩放，也不受页面 `overflow-hidden` 裁切。默认显示在元素上方，空间不足时翻转到下方，
  并在 Preview viewport 内做边界避让；缩放、滚动和 viewport resize 时跟随锚点重新定位。
- 若当前运行环境无法可靠维护缩放后的锚点定位，缩放操作必须退出元素选择模式并关闭悬浮条，不能让
  菜单停留在旧坐标。当前 Radix Popover/Floating UI 路径支持 transform 后的 DOM 锚点，应优先跟随。
- 左右方向键切页；页码输入框内保留文本光标语义。
- 窄屏仍保留缩略图、主预览和全部核心操作；缩略图栏收窄，“AI 编辑”悬浮条保持同一语义并限制在
  Preview viewport 内，不改为独立的底部 action sheet。
- 外部打开按钮复用 Preview Pane 的通用顶栏行为；是否可用由当前平台、工作区类型和已发现的外部
  编辑器共同决定，PPTX 不增加独立的选择或 fallback 规则。
- 引用列表项使用真实按钮语义，支持鼠标、Enter 与 Space；删除引用是独立兄弟按钮，不能因为事件冒泡
  触发文件导航。Desktop、手机 Web、Zai Light 与 Zai Dark 保持相同语义。

## 抽象边界

Presentation 能力按接口隔离：

```text
PresentationCapabilities
├─ preview: PresentationPreviewEngine       # 第一期实现
├─ edit?: PresentationEditEngine             # 后续 DOM 编辑
├─ export?: PresentationExportEngine         # 后续 DOM -> PPTX
└─ persistence?: Host document service       # 后续 workspace 写回
```

`PresentationPreviewEngine` 暴露稳定的页面级契约：

- `open(data)`：解析二进制并返回 preview document。
- `pageCount` / `pageSize`：页面列表与画布尺寸。
- `renderPage(pageIndex, container)`：把单页渲染到指定容器并返回可释放 handle。
- `getPageElements(pageIndex)`：返回应用自有的稳定元素模型，包括 slide part、OOXML node id、类型、
  名称、文本摘要、bounds、z-order，以及 table cell 坐标；只返回当前产品范围内的 slide-owned 元素。
- `dispose()`：销毁文档级资源。

调用方不得读取第三方生成 DOM 的 class、子节点顺序或内联样式来实现业务逻辑。后续编辑通过独立
`PresentationEditEngine` 和稳定 element ID 建模；导出通过独立 Export DOM 完成。

`renderPage` 的 `container` 必须是没有 React 子节点的独立 leaf mount。第三方 renderer 及其
`dispose`/cleanup 只能增删该节点内部的 DOM；selection overlay、悬浮操作条等 React 管理节点必须作为
leaf mount 的兄弟节点存在，禁止与 renderer 共用容器或 ref，避免命令式清理破坏 React DOM 所有权。

## 结构化引用与 Composer

```text
Preview source bytes + source metadata
  -> sha256 source fingerprint
  -> PresentationPreviewDocument.getPageElements(page)
  -> explicit selection overlay
  -> PPTX_ELEMENT_REFERENCE_ADD event
  -> focused/primary ConversationComposer
  -> chip + hidden `# Presentation element comments:` prompt tail
```

引用最小结构：

```text
PptxElementReference
├─ id
├─ workspacePath / workspaceIdentity / remoteSessionId
├─ sourcePath / sourceTitle / sourceFingerprint
├─ slideIndex / slidePart
├─ nodeId / nodeType / nodeName / bounds / zIndex
├─ rowIndex? / cellIndex?                  # table-cell only
├─ text? / selectedText? / comment? / textFingerprint?
└─ capturedAt
```

- `sourceFingerprint` 为完整预览字节的 `sha256:<hex>`，不是 size/mtime 的近似值。
- 权威定位键是 `sourcePath + sourceFingerprint + slidePart + nodeId`；table cell 再加
  `rowIndex + cellIndex`。
  `nodeName`、完整 `text`、`textFingerprint` 和 bounds 只作复核、解释与冲突诊断，不得在歧义时猜测；
  `selectedText` 只表达用户关注的文本片段，`comment` 只表达用户对该元素的修改意见；二者均不
  参与定位或冲突校验。Agent 必须先 inspect 完整元素文本，再结合这两个上下文字段生成传给
  `update-text` 的完整替换文本，不能把子串或修改意见当成独立 OOXML 目标。
- 新发送的 prompt 尾块复用代码评论的模型语义，标题为 `# Presentation element comments:`，并在 JSON
  前固定声明：每个非空 `comment` 都是针对该条引用的独立用户修改要求，必须逐条处理且禁止跨引用混用。
  该声明与 `comment` 字段直接进入用户 prompt，不依赖模型加载 PPTX skill。历史
  `# Presentation elements:` JSON 尾块继续支持反解析，但新引用不再生成旧标题。
- Composer 聚合 chip 的悬浮列表沿用代码评论附件的层级：元素摘要和定位信息之后展示非空 `comment`，
  便于发送前核对每条元素引用与修改意见的绑定关系。
- prompt 尾块与附件协议分离，不上传 PPTX 二进制；历史 user row 反解析后只展示正文与引用 chip，隐藏
  内部结构化块。selection、code comment、web element 与 presentation element 使用固定尾块顺序，
  parser 按相反顺序消费。
- source 切换会清除 viewer 内的 hover/selected 状态；已加入 Composer 的引用保留，直到用户删除、
  发送成功或 scope 切换。引用不进入 task snapshot/replayable 运行态。

状态与时序：

```text
viewer idle
  -- enable selection --> selecting(no selection)
  -- click overlay ----> selecting(selected reference + anchored AI Edit bar)
  -- scroll/resize/zoom> floating bar follows transformed anchor
  -- AI Edit ---------> editing local instruction draft; composer unchanged
                       |-- arrow keys -> caret only; never paginate
                       |-- Esc while IME composing -> IME cancels candidates; draft kept
                       |-- cancel/Esc -> discard draft; return to AI Edit bar
                       `-- add to conversation -> composer receives immutable reference
                                                  with optional comment;
                                                  discard local draft and keep selection
  -- unsupported zoom -> viewer idle; floating bar closes
  -- page/source change> clear local selection
  -- Esc(no draft)/disable -> viewer idle

composer(scope A, focused)
  -- add matching A --> append/dedupe chip
  -- add scope B -----> ignore
  -- open reference ---> close viewer selection; open source file; try referenced page
                       |-- file missing -> file-missing toast
                       |-- page missing -> keep file preview + page-missing toast
                       `-- fingerprint changed + page exists -> navigate + stale toast
  -- send accepted ---> serialize tail, then clear A references
  -- blocked/error ----> keep A references
  -- switch scope -----> clear renderer-local reference draft
```

引用导航使用 renderer-local 一次性请求，不进入 prompt、task snapshot 或 replayable runtime：

```text
PptxReferencePreviewNavigation
├─ requestId                         # 同一引用重复点击仍重新定位
├─ pageIndex                         # zero-based，与引用 slideIndex 一致
└─ expectedSourceFingerprint
```

Code Viewer tab 继续只按 `workspaceKey + sourcePath` 复用；文件树产生的通用 `file` source 与
引用反向打开产生的 `pptx` source，只要最终指向同一个 `.pptx` 路径，就必须归一为同一个 PPTX
resource key，不能把入口携带的 source type 当成不同文件身份。`requestId`、页码与
`expectedSourceFingerprint` 都不得进入稳定 tab key。
同文件的新导航请求只驱动已加载 viewer 的本地页码状态，不应重新 range-read 或解析整个 PPTX。远程
workspace 继续使用引用携带的 `workspaceIdentity` 与 `remoteSessionId` 选择既有 Host file service；
renderer、relay 和 desktop main 不新增文件读取或导航状态。

## Agent resolver 与写回

> 现状：内置 document-skills 插件已对齐市场版 `pptx` 生产 skill，不再随包分发
> `scripts/pptx_reference.py`。本节记录的 resolver 契约（fingerprint 校验、`--replace-source`
> 与 `--output` 互斥、fail-closed 冲突处理）仍是该能力的设计基线，但当前无内置实现承载；
> Preview Pane 结构化引用照旧注入 Composer，写回由 Agent 侧自行完成。

官方 `pptx` skill 提供 inspect-before-update 的窄接口；Preview Pane 仍保持只读：

```text
reference from prompt
  -> pptx_inspect_element(source, reference)
  -> read one source byte snapshot and compute whole-file sha256
  -> locate slidePart + cNvPr@id (+ table cell coordinates)
  -> validate node kind/name/text fingerprint
  -> update shape text or table-cell text in a temporary PPTX
  -> reopen/validate ZIP + OOXML + target
  -> choose output policy
     |-- default structured-reference edit -> replace source path
     |-- user explicitly requests a copy  -> requested new .pptx path
  -> replace-source rechecks source fingerprint
  -> atomic replace selected output path
```

- 首期可写范围为 shape 文本和 table-cell 文本；picture/chart/table 容器可精确 inspect，但没有未经
  定义的通用 mutation。更新命令不得把整个 slide 或相似文本当作 fallback。同一 source revision 的
  多个引用必须作为一次 batch 写入同一临时 PPTX，不能逐次从原文件覆盖输出而丢失前序修改。
- 文件 fingerprint 不一致、slide/node 不存在、类型不符、table 坐标越界、零匹配或多匹配时必须
  fail closed，并提示用户重新打开预览、重新选择；禁止继续写入。
- fingerprint 与 OOXML 定位/复制必须消费同一份源字节快照，禁止 hash 后按路径再次打开，以免并发
  替换把校验 revision 与实际写入 revision 分离。
- Agent resolver 必须在任何 ZIP 条目解压前完成集中预检：压缩文件不超过 `64MB`，非目录条目不超过
  `4000`，单条解压大小不超过 `32MB`，总解压大小不超过 `256MB`，`ppt/media/` 总大小不超过
  `192MB`，单条压缩比不超过 `200:1`。前五项与 Preview Pane 当前读取上限及
  `RECOMMENDED_ZIP_LIMITS` 对齐；压缩比是 resolver 防止高压缩率条目消耗 Agent/Host 资源的独立边界。
- Resolver 必须拒绝重复条目名、绝对路径、反斜杠、NUL、`.`/`..` 路径段和加密条目。虽然 resolver
  不会把条目解压到目录，异常名称仍会破坏按 OOXML part 定位和重打包的一致性。
- slide XML 读取和 archive 重打包必须使用固定大小分块，并按实际读取字节再次执行单条/总量限制；
  禁止通过 `ZipFile.read()` 将媒体或嵌入对象完整载入内存。超限和异常 ZIP 返回稳定的
  `pptx_update_failed`，其中 `reason` 为 `zip_limit_exceeded` 或 `invalid_zip_entry`，且不得产生输出。
- Preview Pane 结构化元素引用编辑默认覆盖引用中的 `sourcePath`；用户明确要求“另存为”、保留原稿或
  指定新 `.pptx` 路径时才写入副本。该默认值只属于结构化引用编辑，不扩散到普通 PPTX 创建、转换、
  PDF 导出或未来原生编辑器。
- 覆盖源文件必须使用显式 `--replace-source`，另存副本使用 `--output <path>`，两种模式互斥；禁止把
  缺失输出参数静默解释为破坏性覆盖。两种模式都必须先写同目录临时文件并完成 ZIP/XML/目标复验。
- `--replace-source` 在最终原子替换前必须再次读取源路径并校验最初的 `sourceFingerprint`。若外部
  PowerPoint/WPS 或另一 Agent 在临时文件生成期间保存了新 revision，resolver 必须删除临时文件、
  fail closed 并保留当前源文件，禁止用模型基于旧 revision 的结果覆盖新内容。
- 覆盖模式不自动创建备份或撤销记录；用户需要保留原稿时必须明确要求副本。远程 workspace 的执行由
  既有 Agent/Host 工作区承担，不把 IO 放进 Renderer、relay 或 desktop main。
- OOXML 写回只承诺上述窄范围文本替换，不承诺 PowerPoint 无损编辑、版式重排、动画或协作语义。

### 写回状态组合与剪枝

| Case ID       | Setup                                          | Event                                      | Expected result                                                         | 状态                 |
| ------------- | ---------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------- | -------------------- |
| PPTX-WRITE-01 | 单个或同 revision 多个结构化元素引用           | 用户未指定保存策略                         | 一次 batch 使用 `--replace-source`，临时文件验证后原子覆盖 `sourcePath` | accepted             |
| PPTX-WRITE-02 | 结构化元素引用                                 | 用户明确要求另存、保留原稿或指定新路径     | 使用 `--output` 写新 `.pptx`，源文件保持不变                            | accepted             |
| PPTX-WRITE-03 | 引用捕获后源文件已变化                         | update 开始时 fingerprint 不匹配           | 不创建可信输出，提示重新打开预览并重新选择                              | accepted             |
| PPTX-WRITE-04 | 初始校验通过，临时输出生成期间源文件被外部保存 | replace-source 提交前 fingerprint 再次变化 | 删除临时输出，保留外部新 revision，返回稳定冲突                         | accepted             |
| PPTX-WRITE-05 | 同 source revision 包含多个引用                | 模型执行修改                               | 仅允许一次 `update-texts` batch，禁止逐个覆盖导致前序修改丢失           | accepted             |
| PPTX-WRITE-06 | 普通 PPTX 创建、转换、PDF 导出或未来原生编辑器 | 未携带 Preview Pane 结构化引用             | 不继承本节覆盖默认值，继续遵守各自 artifact/save contract               | pruned：独立产品边界 |

## 数据与进程边界

```text
PreviewPane
  -> workspace-scoped IFileService.stat(path)
  -> readFileRange(path, offset, length)
  -> Uint8Array
  -> PresentationPreviewEngine.open()
  -> preview DOM
```

- 路径执行继续使用 `workspacePath/path`。
- workspace 隔离继续使用 `workspaceIdentity?.trim() || workspacePath`，远程链路保留
  `remoteSessionId`。
- 手机 `/remote` 通过 shared-host attachment 使用桌面窗口已有 Host 的文件服务；不创建独立
  local/remote Host 或 Agent runtime。
- 文档预览与未发送引用不进入 conversation task 的 continuous/replayable 消息流；发送后的结构化
  prompt 文本沿既有 conversation 路径传输，不新增 relay/main 业务状态。
- `pptx-renderer` 需要完整 ArrayBuffer。第一期按 `256KB` 分段读取，文件上限为 `64MB`；旧远端缺少
  `stat.size/readFileRange` 时，只回退现有 `readMediaPreview` 的 `8MB` 兼容通道。这个版本偏差无法由
  Renderer 再次 `stat` 消除：旧 Host 不会返回真实 size，也没有 range 能力。
- 旧远端的 `readMediaPreview` 超限错误必须映射为 PPTX 专属、可国际化的 `8MB` 兼容上限文案，不能
  复用 `64MB` 文案误报真实阈值，也不能把 service 返回的绝对路径直接展示给用户。
- 分段读取必须满足“实际已读字节数等于首次 `stat.size`”的不变式；空 chunk 或读取完成后二次
  `stat.size` 变化均按文件不完整处理，不得把裁剪后的 buffer 交给 ZIP 解析器。

## 性能和资源管理

- PPTX React 组件和 `@aiden0z/pptx-renderer` 必须懒加载，不进入普通代码/图片预览的初始 bundle。
- 解析使用 `RECOMMENDED_ZIP_LIMITS`、lazy slide 和 lazy media 能力。
- 主预览只挂载当前页；切页和卸载时调用 render handle 的 `dispose()`。
- 缩略图使用 IntersectionObserver 近屏挂载，离屏时释放 slide handle。
- 文档切换或 Pane 卸载时释放所有图片 Blob URL、图表实例和字体资源。
- 文档解析和页面渲染都必须绑定到当前 viewer generation。切换文档或卸载后，即使旧
  `open()` / render handle 的 `ready` Promise 才完成或失败，也只能释放旧资源，不能再写入当前
  viewer 的 document 或 load error 状态。

```text
generation N             cleanup / data changed             generation N+1
open(N) ────────────────> invalidate N + dispose handles ──> open(N+1) -> render(N+1)
render(N).ready ── late reject ─────────────────────────────> generation mismatch -> ignore
open(N) ───────── late resolve ─────────────────────────────> dispose old document -> ignore
```

- `readFileRange` 暂无底层 abort 协议；切换文档后在每次 range RPC 返回时检查 effect 的 disposed
  状态，立即停止后续分段读取和旧 source 的状态写入。

## 错误与日志

- 文件不存在、`64MB` 通用上限、旧远端 `8MB` 兼容上限、读取不完整、其它读取失败、解析失败分别
  显示可国际化的只读错误。
- 其它 PPTX 读取错误若包含当前源文件路径，用户可见文案只保留文件名；完整路径只允许进入本地日志，
  防止手机 `/remote` 或远程 workspace 把服务端目录暴露到界面。
- UI 日志统一通过 `packages/ui/src/logger.ts`；不得直接调用 `console.log` 或
  `window.zcode?.log`。
- 高频逐节点渲染信息不落生产日志；第一期只记录一次加载/解析失败。

## 后续能力预留

- DOM 编辑：文本、移动、缩放、删除、层级和 undo/redo，由 `PresentationEditEngine` 管理命令状态。
- 当前上下文悬浮条只实现“AI 编辑”，不展示禁用或占位的格式控件。未来只有在对应
  `PresentationEditEngine` mutation capability 存在时，才可把真实可用的行内编辑 action 加入同一操作条；
  `canSelect`、`canReference` 与 `canMutate` 必须继续分离。
- 导出：`PresentationExportEngine` 消费规范化 Export DOM，输出新的 PPTX 副本。
- Preview Pane 原生保存：未来若加入，必须新增 workspace-scoped Host 文档服务，负责 edit lease、
  source fingerprint、冲突检查、临时文件和原子替换；不扩展 `IFileService` 承担编辑事务。

## 验证

自动化检查：

- `.pptx` 路径识别、source 升级和大小限制。
- `.pptx` 与 XLSX、DOCX 的通用外部打开按钮保持相同的显示、禁用和调用语义。
- 翻页、页码 clamp、缩放 clamp 的纯逻辑。
- 连续切换文档时，旧解析结果会被释放，旧页面的迟到渲染错误不会污染新文档状态。
- watcher 必须先于首次 PPTX 读取进入 ready；关闭标签页或切换 source 后释放订阅并调用 `unwatch`。
- 目标文件事件触发重新读取，同目录其它明确路径事件被过滤；未知路径事件兼容旧 Host 并保守重载。
- 连续 watcher 事件采用 latest-wins generation，旧读取的成功、失败和 loading 收尾均不能覆盖新读取。
- 自动重载成功后重置页码、缩放、元素选择模式、选中元素与未确认 AI 编辑草稿；Composer 引用不变。
- 元素模型过滤、table cell bounds、z-order hit-test、source generation 清理。
- 引用 payload 校验、workspace/remote/scope 隔离、精确去重、prompt 序列化与反解析。
- 草稿与历史引用项的按钮/键盘导航、删除按钮事件隔离、同文件 tab 复用与重复请求重新定位。
- 导航前退出元素选择；有效页定位；文件不存在、页码不存在、fingerprint 变化的独立反馈语义。
- 同文件页码导航不重新读取 PPTX；跨文件导航仍复用现有 generation 清理和迟到结果防护。
- 部分文字划选保留完整元素 `textFingerprint`，`selectedText` 可无损进入 Composer 上下文；带部分选区的
  shape/table-cell 引用仍能完成 inspect 和完整文本更新。
- resolver 的 fingerprint mismatch、node 歧义/缺失、shape text 与 table-cell 更新、临时文件验证。
- `--replace-source` 与 `--output` 互斥；原路径覆盖成功；提交前源 fingerprint 变化时保持外部新 revision；
  明确另存时保持源文件不变。
- 中英文文案和 UI 字体 token。
- `pnpm typecheck`、`pnpm lint`。

人工 UI 验收：

- Desktop 本地、SSH/WSL/Docker 远程工作区。
- 手机 `/remote`。
- Zai Light / Zai Dark。
- 普通、图表、SmartArt、嵌入字体、大文件、损坏文件。
- 缩略图选择、上一页/下一页、页码跳转、按钮和快捷键缩放。
- 选择模式与普通超链接点击互不污染；重叠元素、table cell、切页/切文件、添加/删除 Composer chip。
- 从草稿和历史 user row 点击具体引用项；同文件重复点击；定位前选择模式关闭；文件缺失、页码缺失与
  fingerprint 变化 toast；仅能定位文件时 Preview Pane 仍展开。
- Desktop 主 Composer 与分屏非 focused Composer、手机 `/remote` shared-host 场景的引用隔离。
- PPTX、XLSX、DOCX 顶栏外部打开按钮的可见性、禁用状态、提示文案和实际打开结果一致。
- PowerPoint/WPS 原地保存与临时文件 rename 保存均触发重载；连续保存最终展示最后版本。
- 已打开文件删除、重建后能恢复；关闭标签页后不再触发 Host watcher 或文件读取。
