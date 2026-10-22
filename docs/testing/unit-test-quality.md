# 单测质量与删减规格

## 目标与范围

保留能发现行为错误的单测，删除仅锁定实现写法、没有独立保护价值的断言。
本次清理只修改测试及其覆盖、验证文档，不修改产品源码、测试入口、架构策略或 E2E 代码。
不以删除比例、覆盖率、文件长度或 mock 数量决定去留。

## 删减标准

逐文件审查测试执行了什么，以及断言实际能证明什么：

| 类型                                                          | 处理                                                 |
| ------------------------------------------------------------- | ---------------------------------------------------- |
| 读取组件源码，检查 class 字符串、属性顺序、组件名或局部变量名 | 删除纯文本守卫；这些断言不能证明实际渲染、布局或交互 |
| 仅检查某段实现采用指定 hook、函数调用或分支写法               | 无独立行为证据时删除，不用另一份文本断言替代         |
| 测试自行创建替身，再断言替身返回预设值，没有调用被测实现      | 删除                                                 |
| 同一输入、边界与结果已经由保留测试覆盖                        | 合并或删除，记录保留测试                             |
| 实际调用解析、校验、业务函数，验证独立规则、边界或失败结果    | 保留；短测试也可能有独立价值                         |
| 只逐字复制常量表、图标或标签映射、展示默认值，没有独立规则    | 删除重复定义；调用了真实函数也不自动代表有保护价值   |
| getter 或简单透传只比对实现中的同一个字段，未验证边界接线     | 无独有契约价值时删除，不因方法存在就逐方法配一条测试 |
| 权限、安全、协议兼容、身份隔离、持久化、竞态或真实 IO 接线    | 保留独有保护；不能仅因使用 mock 或读取文件而删除     |
| 架构契约、发布资源清单、生成产物等静态约束                    | 按其约束价值审查，不归入普通源码字符串清理           |
| 混合了源码守卫与真实行为的文件                                | 保留真实行为；只有能明确分离时才删除低价值用例       |

历史缺陷的测试也需检查断言能力。只断言源码出现某个词，不能视为已复现该缺陷。
删除此类断言不表示相应行为已有完整自动化覆盖，也不为每个删除项强行新增测试。
局部配置测试若重复断言整个默认目录，需先确认目录归属及独立覆盖，再收窄无关部分。
MCP 局部接线测试只可明确排除已有独立验证的四个内置文档 server；仍保留一次启动、目标顺序、
未知额外 server 拒绝，以及请求身份、用户覆盖、退役 server 排除等断言。
保留架构要求的 `contract.test.ts` 和已有 E2E case、catalog；coverage matrix 仅校正失效的单测覆盖声明。

## 执行与验收

1. 记录任务起点，先完成只读审查与本规格，再删除已审查的测试。
2. 删除清单按实际断言说明理由；混合文件不能整文件误删。
3. 核对测试间 import、运行配置和当前覆盖文档是否引用删除文件，修正当前失效引用。
   历史运行记录保留其历史语义，不将旧验证结果改写为本次验证。
4. 执行根 typecheck、lint、变更架构检查、格式检查，以及任务起点的 affected 单测。
   affected 未选中或跳过全量必须如实报告；不能据此声称保留测试全部通过。
5. 定向执行相关保留行为测试，验证清理没有破坏测试装配；不自动扩展为全量单测。
6. 自查仅有约定范围内的测试与文档变更，检查通过后提交本地 commit。

## 剩余单测逐文件审查合同

第三轮从 `0cd29a0ab4` 建立当前测试库存。范围是 Git tracked 的 TS/JS test/spec 文件，
排除 E2E、浏览器验收、夹具、生成产物与第三方副本。源码旁未注册测试也纳入质量审查，
实际执行数量仍按各测试入口分别统计。当前库存 3578 个文件，共 1069334 行。

语言入口复核另发现 7 个 Go、Python、Kotlin 测试，共 2270 行，补入
`unit-test-review/extra-languages.jsonl`；完整审读范围因此为 3585 个文件、1071604 行。
Android instrumentation 属于设备验收，不纳入本次单测删减；空的 `action-settler.test`
没有源码或注册用例，也不计入文件审读数量。原始 TS/JS 库存数保留，便于核对分组账本。

本轮不以扫描结果代替审查完成。每个文件必须读完测试、setup 与本地 helper，按实际被测调用
阅读对应实现或契约，并检查重复场景是否真的给出不同输入、顺序或边界。
大文件分段阅读，不能用截断输出、标题列表或 imports 摘要标记为已审。

逐文件审查账本分组写入 `docs/testing/unit-test-review/`：

- 每条记录包含文件路径、审查时内容哈希、实际阅读行数、覆盖的行为组、实现依据及保留/删除/精简结论。
- 精简或删除必须列出具体用例及理由；声称重复时指明保留用例和相同输入的证据。
- 强制 `contract.test.ts` 保留，但仍须审查并记录；唯一安全、身份和时序保护不能因写法简单而删除。
- 局部阅读过的混合文件不能记为全文完成；遇到无法判断的契约继续查证，不能用通用结论填账本。
- 每批审查后先核对清单并收集用例，再删除；验证失败不能直接成为删除理由。
- 只有库存每个文件都有完整语义审查记录，才宣称剩余单测审查完成。途中仅报告已完成和剩余数量。

## 本次清理记录

### 第一轮：源码文本守卫

2026-10-15：基线 `f540bccfa6`。三个审查组逐项检查断言后，删除 64 个测试文件，
精简 28 个混合文件。产品源码、配置、测试入口和 E2E 文件均不变。

清理前 Vitest 实际收集上述 92 个文件共 608 条用例，清理后剩余 289 条。
共删除 319 条，其中 1 条原本为 skipped。不以静态 `it` 次数代替参数化展开数量。

验证：根 typecheck、lint（210 条 warning、0 error）、变更架构检查、变更文件格式检查通过。
任务起点的 affected 实际选中并运行 28 个文件，289/289 用例通过；另外三个保留的配置完整性、
参数映射与数据边界测试文件通过 87/87 用例。未运行全量单测或产品 E2E。

下表路径记录已删除测试的位置，不作为当前文件链接或运行入口。

#### 整文件删除

| 文件                                                                | 理由                                                                                           |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/desktop/test/cuaHelperOperationsDocs.test.ts`             | 锁定文档旧名称、命令示例和 feature graph 原文，不验证 Helper 操作或签名。                      |
| `packages/desktop/test/hostMediaPreviewLogging.test.ts`             | 只断言限额字面值及日志文本，未运行限流或授权路径。                                             |
| `packages/desktop/test/rendererMessageHandler.test.ts`              | 四个 case 只断言源码命名、调用与属性文本；顶部 mock 未被实际业务调用消费。                     |
| `packages/provider-node/test/zcode-builtin-map-formatting.test.ts`  | 主要锁 CEL 表达式排版和缩进；实际编译和解析仍由 builtin integrity 与 option-map 行为测试保护。 |
| `packages/services/test/cuaProducerSurfaceSimplification.test.ts`   | 只对旧 facade 与别名做源码禁词扫描；不验证 consumer 行为。                                     |
| `packages/ui/test/appQuickPickCommandStability.test.ts`             | 只锁定 useMemo、依赖名称和 props 装配，未执行重渲染或验证引用稳定性                            |
| `packages/ui/test/appearanceSettingsLayout.test.ts`                 | 复制布局 class、locale key 与文案常量，未验证设置或语言切换行为                                |
| `packages/ui/test/assistantMarkdownTypeScale.test.ts`               | 跨组件逐字匹配字号、class 和 token 声明，未验证实际排版                                        |
| `packages/ui/test/automationCardBorderTokens.test.ts`               | 逐字匹配多处 Card Border class 和阴影写法                                                      |
| `packages/ui/test/automationCustomRepeatTestIds.test.ts`            | 匹配 Input 源码属性、test id 及数字常量，未输入或验证调度规则                                  |
| `packages/ui/test/automationEditSubtitle.test.ts`                   | 匹配标题/subtitle class、i18n key 和源码先后次序                                               |
| `packages/ui/test/automationFormInputSurface.test.ts`               | 匹配输入框高度、圆角和颜色 class                                                               |
| `packages/ui/test/automationMenuIconAssets.test.ts`                 | 匹配 Lucide 名称、尺寸、描边和图标 JSX                                                         |
| `packages/ui/test/automationNewTaskHistoryInteraction.test.ts`      | 匹配三目表达式、标签和源码字符串，未切换 history 或发起加载                                    |
| `packages/ui/test/automationScheduleInputHeight.test.ts`            | 截取源码后锁高度、溢出、间距及描边 class                                                       |
| `packages/ui/test/automationShowcaseTemplates.test.ts`              | 复制翻译文案、Lucide 名称、源码组件和渲染分支字符串                                            |
| `packages/ui/test/automationsMainDragRegion.test.ts`                | 锁定布局 class、源码条件和组件出现次数，未执行拖窗或测量布局                                   |
| `packages/ui/test/codeFontStack.test.ts`                            | 复制 CSS 字体栈和 viewer token 的源码字符串                                                    |
| `packages/ui/test/desktopTopOverlaySidebarWidth.test.ts`            | 锁定变量、hook、API 名称和 class 写法，未触发 resize 或读取原生窗口指标                        |
| `packages/ui/test/dialogRadius.test.ts`                             | 正则逐组件扫描 rounded class，未渲染或测量圆角                                                 |
| `packages/ui/test/dropdownMenuContentWidth.test.ts`                 | 复制宽度 class，未渲染长文案或窄屏布局                                                         |
| `packages/ui/test/executeToolCallBlockStyle.test.ts`                | 只断言 collapsed command 的 font class 源码                                                    |
| `packages/ui/test/floatingOverlayLayering.test.ts`                  | 复制 z-index 和 shadow class，未打开浮层或验证堆叠                                             |
| `packages/ui/test/hookCreateButtonSize.test.ts`                     | 匹配共享组件名、props 排列及 class，未验证按钮大小                                             |
| `packages/ui/test/hookIconStyle.test.ts`                            | 只复制 Anchor 图标名与跨行 JSX 字符串，不渲染组件或验证图标可见性                              |
| `packages/ui/test/hooksHintStyle.test.ts`                           | 匹配菜单名称、分隔线和 count 属性，未验证交互                                                  |
| `packages/ui/test/interactionThemeTokens.test.ts`                   | 复制 token 字面量并统计 CSS 声明次数                                                           |
| `packages/ui/test/markdownTableLayoutRoot.test.ts`                  | 匹配 data 属性、CSS inset 与源码顺序，未测量表格布局                                           |
| `packages/ui/test/menuOptionSpacing.test.ts`                        | 统计 gap class 的源码出现次数                                                                  |
| `packages/ui/test/menuRadius.test.ts`                               | 逐组件截取源码并锁 rounded class，未渲染菜单                                                   |
| `packages/ui/test/modelProviderSettingsWidth.test.ts`               | 只断言 SettingsPage 与 ModelDialog 的宽度 class                                                |
| `packages/ui/test/newTaskDraftHelpButtonLayout.test.ts`             | 只检查组件名、prop 字符串和按钮装配；没有渲染或触发真实行为。                                  |
| `packages/ui/test/occupationOnboardingWindowControls.test.ts`       | 只匹配窗控 JSX 及 class/prop；不验证窗口操作及跨平台显示。                                     |
| `packages/ui/test/offPeakFigmaLayout.test.ts`                       | 30 个用例全部读源码，匹配 class、图标名、组件装配及写法；无实际渲染、操作或布局测量。          |
| `packages/ui/test/pluginDetailHeroStyle.test.ts`                    | 只检查 Hero class 和组件名；不能证明真实视觉。                                                 |
| `packages/ui/test/pluginDetailResourceIconStyle.test.ts`            | 只复述图标映射源码字符串。                                                                     |
| `packages/ui/test/rootWebRemoteTaskSyncBoundary.test.ts`            | 只禁止一条完整 Zustand selector 字符串；不验证流式更新唤醒次数，等价写法可绕过。               |
| `packages/ui/test/selectTriggerStyle.test.ts`                       | 只断言源码不含某 class。                                                                       |
| `packages/ui/test/settingsBreadcrumbReplacesBackNavigation.test.ts` | 只检查组件名与标题字号 class；不执行导航。                                                     |
| `packages/ui/test/settingsCommandRowContent.test.ts`                | 只检查路径字段不存在和头像/class 字符串。                                                      |
| `packages/ui/test/settingsEditFormDeleteAction.test.ts`             | 只匹配删除按钮 JSX 风格；不验证删除结果。                                                      |
| `packages/ui/test/settingsEmptyStateStyle.test.ts`                  | 只匹配虚线边框 class 与空态组件名。                                                            |
| `packages/ui/test/settingsFormActions.test.ts`                      | 只统计源码保存文案次数、顺序、class 和 canSave 表达式；没有真实渲染和保存调用。                |
| `packages/ui/test/settingsHelpMenuEntry.test.ts`                    | 只检查 import、组件装配、注释和 class 字符串。                                                 |
| `packages/ui/test/settingsHookRowContent.test.ts`                   | 只匹配显示表达式及 typography class。                                                          |
| `packages/ui/test/settingsItemSecondaryText.test.ts`                | 只断言多个源码存在相同 text class。                                                            |
| `packages/ui/test/settingsListCardColors.test.ts`                   | 只检查容器 class 和委托组件名。                                                                |
| `packages/ui/test/settingsListCreateAction.test.ts`                 | 只拆源码匹配按钮/菜单 JSX；不点击、不执行创建或导入。                                          |
| `packages/ui/test/settingsListHeaderActionSize.test.ts`             | 只统计按钮 size/variant/class 和共享组件名。                                                   |
| `packages/ui/test/settingsListRowActionSize.test.ts`                | 只匹配按钮 size/class 字符串。                                                                 |
| `packages/ui/test/settingsResourceFormContainer.test.ts`            | 只复述表单 class、组件名及 Select JSX 属性。                                                   |
| `packages/ui/test/settingsResourceRowNavigation.test.ts`            | 只匹配键盘处理及 cursor class 源码；真实交互 helper 单测继续保留。                             |
| `packages/ui/test/settingsUsageProviderTabs.test.ts`                | 源码切片匹配 unavailableReason 与 SegmentPill；不计算实际可见项或切换 tab。                    |
| `packages/ui/test/tabsLayoutSpacing.test.ts`                        | 只比较一个 tabs class 字符串。                                                                 |
| `packages/ui/test/toolCommandTypography.test.ts`                    | 只匹配 code 元素 class 字符串。                                                                |
| `packages/ui/test/uiFontTokenMigration.test.ts`                     | 只锁定文档句子及一组 class 源码；迁移写法测试。                                                |
| `packages/ui/test/v4ConversationTimelineScrollbarGutter.test.ts`    | 只检查 class/prop 条件源码；不验证 gutter、滚动锁或导航可见结果。                              |
| `packages/ui/test/workspaceFileTreeStickyLayout.test.ts`            | 只匹配布局源码及特定 hook/DOM 调用写法；没有验证滚动结果或 sticky 几何。                       |
| `packages/ui/test/workspaceShellRenderStabilitySource.test.ts`      | 只断言 useMemo 变量名；不测稳定性或 render 次数。                                              |
| `packages/ui/test/workspaceShellResizeAutoCollapse.test.ts`         | 只断言 timeout/ref 变量及 setTimeout 写法；不执行 resize/折叠。                                |
| `packages/ui/test/workspaceShellSidebarResizePerformance.test.ts`   | 只检查 useCallback 体中 DOM/状态调用名字；没有性能或 render 验证；还含已下线 skip 用例。       |
| `packages/web/test/homeOnlyMediaPreviewService.test.ts`             | 只验证服务字段及泛型装配写法，没有执行 unsupported service。                                   |
| `packages/zcode-cua/test/maas-tool-result-completeness.test.ts`     | 只扫描 smoke 脚本的重试常量、字段名及日志原文，未执行 probe。                                  |
| `packages/zcode-cua/test/native/pip-window-chrome.test.ts`          | 只锁定 Objective-C++ 圆角数值、layer 属性与曲率常量，没有渲染原生面板。                        |

#### 混合文件精简

| 文件                                                                       | 删除范围与保留边界                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `packages/ui/test/appTaskQueryCacheSubscription.test.ts`                   | 删除源码 API 名称守卫，保留选择 task 不清理 workspace slash command 目录的行为守卫               |
| `packages/ui/test/appUsageDailyModelTrendChart.test.ts`                    | 删除图表组件名称源码断言和 tooltip case 内 class 断言；保留真实 view model、过滤和数字格式化测试 |
| `packages/ui/test/appUsageModelPieChart.test.ts`                           | 删除尺寸/class 源码复制，保留真实模型合并和份额计算                                              |
| `packages/ui/test/appUsagePanel.test.ts`                                   | 删除图表 class 与源码顺序，保留真实组件的用量和范围切换测试                                      |
| `packages/ui/test/automationTypographyTokens.test.ts`                      | 只删除 class/图标/组件写法检查；保留 session-created schedule 持久化配置不覆盖的独有行为守卫     |
| `packages/ui/test/browserUseTabIcon.test.ts`                               | 删除动画 CSS 源码复制，保留 fake timer 驱动真实组件的 favicon 恢复测试                           |
| `packages/ui/test/confirmDialogClosingContent.test.ts`                     | 删除纯宽高 class 检查，保留关闭动画保留内容的时序守卫                                            |
| `packages/ui/test/conversationSelectionGuard.test.ts`                      | 删除 class 和文案复制，保留真实选区边界函数测试                                                  |
| `packages/ui/test/feedbackCenter.test.ts`                                  | 源码 import 缺失已有真实 mount 不调用 watcher 的测试；其余只复制 JSX 和翻译文案                  |
| `packages/ui/test/offPeakUiPresentation.test.ts`                           | 仅移除独立的源码/class/组件装配字符串用例；保留实际组件渲染、交互及业务 helper 用例。            |
| `packages/ui/test/overlayWindowControls.test.ts`                           | 仅移除独立的源码/class/组件装配字符串用例；保留实际组件渲染、交互及业务 helper 用例。            |
| `packages/ui/test/pluginDetailHeaderLayout.test.ts`                        | 仅移除独立的源码/class/组件装配字符串用例；保留实际组件渲染、交互及业务 helper 用例。            |
| `packages/ui/test/pluginSettingsSection.test.ts`                           | 仅移除独立的源码/class/组件装配字符串用例；保留实际组件渲染、交互及业务 helper 用例。            |
| `packages/ui/test/pluginStoreManageEntry.test.ts`                          | 仅移除独立的源码/class/组件装配字符串用例；保留实际组件渲染、交互及业务 helper 用例。            |
| `packages/ui/test/pluginStoreSourcesDialog.test.ts`                        | 仅移除独立的源码/class/组件装配字符串用例；保留实际组件渲染、交互及业务 helper 用例。            |
| `packages/ui/test/previewPane.test.ts`                                     | 仅移除独立的源码/class/组件装配字符串用例；保留实际组件渲染、交互及业务 helper 用例。            |
| `packages/ui/test/rewardsMenuIcon.test.ts`                                 | 仅移除独立的源码/class/组件装配字符串用例；保留实际组件渲染、交互及业务 helper 用例。            |
| `packages/ui/test/settingsSearchInput.test.ts`                             | 仅移除独立的源码/class/组件装配字符串用例；保留实际组件渲染、交互及业务 helper 用例。            |
| `packages/ui/test/sidePaneTabStripLayout.test.ts`                          | 仅移除独立的源码/class/组件装配字符串用例；保留实际组件渲染、交互及业务 helper 用例。            |
| `packages/ui/test/v4ConversationTurnGroup.test.ts`                         | 仅移除独立的源码/class/组件装配字符串用例；保留实际组件渲染、交互及业务 helper 用例。            |
| `packages/ui/test/v4SessionPaneLayoutParity.test.ts`                       | 仅移除独立的源码/class/组件装配字符串用例；保留实际组件渲染、交互及业务 helper 用例。            |
| `packages/ui/test/v4WorkspaceDraftDragDrop.test.ts`                        | 仅移除独立的源码/class/组件装配字符串用例；保留实际组件渲染、交互及业务 helper 用例。            |
| `packages/ui/test/workspaceSidebarFooterWebRemoteControlTooltip.test.ts`   | 仅移除独立的源码/class/组件装配字符串用例；保留实际组件渲染、交互及业务 helper 用例。            |
| `packages/ui/test/workspaceSidebarTerminologyI18n.test.ts`                 | 仅移除独立的源码/class/组件装配字符串用例；保留实际组件渲染、交互及业务 helper 用例。            |
| `packages/web/test/conversationShareRoute.test.ts`                         | 这些 case 仅检查 JSX 文本及语句写法；保留路由解析、locale 结果、OAuth 与 dev 路由接线检查。      |
| `packages/web/test/shareHeaderLayout.test.ts`                              | 只检查 CSS 标记、变量与属性文本；保留8个真实 layout 函数行为测试。                               |
| `packages/web/test/webRemoteControlAssistantCodeCommentCapability.test.ts` | 只按源码切片核对 JSX boolean prop；保留实际 replay 内容投影与卡片点击路由行为。                  |
| `packages/web/test/webRemoteControlBootstrapShell.test.ts`                 | 只做 CSS 字符串包含判断；保留真实 HTML 资源字节验证与运行内嵌主题脚本的JSDOM用例。               |

删除 `rendererMessageHandler` 和 `workspaceShellRenderStabilitySource` 等文本守卫后，
相应竞态或渲染稳定性不能靠原有标识符匹配宣称已覆盖。SL-02 的语言标签覆盖也已在
[语言覆盖矩阵](settings-language-e2e-coverage-matrix.md)中明确标为待补行为验证。

### 第二轮：扩大到常量、透传与重复覆盖

基线 `d027277ea8`。第一轮没有逐条审查全库单测，不能把源码文本候选审查表述为全量质量审计。
第二轮先读取全部 Git tracked 测试命名文件的结构，再对候选及其对照实现做语义审查。
索引排除 E2E 与夹具目录后有 3678 个文件；其中仍含命名式 E2E 和构建副本，不能视为活跃单测数。
根 Vitest 官方实际列出 2587 个 specifications；CLI、文档站、Node 原生测试和源码旁未注册测试分别核对入口。

| 审查组                               | 结构扫描文件 | 深读候选及对照文件 | 范围                                                   |
| ------------------------------------ | ------------ | ------------------ | ------------------------------------------------------ |
| UI                                   | 1193         | 100                | 排除 browser 验收目录；包含源码旁测试，保留 contract   |
| 服务、共享、Provider、Client、RPC    | 590          | 70                 | 七个包的测试命名文件                                   |
| 桌面、CUA、Web、Server、其他包及脚本 | 873          | 65                 | 排除 E2E、夹具、构建副本和强制 contract                |
| CLI                                  | 917          | 11                 | 全部命名文件结构扫描；按包与原生 Node 测试入口分开收集 |

结构扫描包括 imports、测试声明、mock、文件读取和逐 token 完全相同的回调检查。
深读列表只记录实际裁决范围；混合文件只保证相关用例及其对照已审查，不表示文件内每条用例均读完。
本轮删除固定展示字典、简单透传回声、自造算法测试、退役遗留与确证重复场景。
相同 describe 中回调完全相同的 OAuth、模型协议和媒体保活测试只保留一份，不删除其独有边界覆盖。
根配置未收集的 `.test.tsx` 和指向已退役 CLI 源路径的孤儿测试，不计作实际执行过的用例。

文档站复杂度测试的原始版本也出现 `136 != 137`：测试把缺失节点的边计为跨群边，而实现
只统计有效节点及有效分组。本轮保留该规则验证，改用固定小图的独立期望，覆盖跨群、同群、
缺失节点与缺失分组；不复制统计实现，不修改产品算法，不因原有失败删除这条测试。

#### 第二轮删除与保留清单

本轮删除 59 个文件，精简 64 个混合文件；另修正当前覆盖矩阵中的失效单测引用。
官方 MCP 权威 origin 下发的三条源码接线守卫经交叉复核恢复；手工构造 env 的测试不能替代真实装配约束。

按各自真实入口收集和执行，本轮已注册用例从 1104 条降到 829 条，删除 275 条。
另清理两个未注册文件中的 7 个静态声明，未把它们计入上述执行数量。
两轮累计删除 123 个测试文件、594 条已注册用例（含第一轮原有的 1 条 skipped），测试代码净减 8305 行。

根 affected 57 个文件先通过 721 条；恢复三个安全守卫后，该文件定向 21/21 通过，最终根保留集合为 724 条。
CLI Vitest 70/70、Office profile 1/1、TUI 原生 33/33、文档站固定图 1/1 均通过。
根 typecheck、lint（210 warning）、架构检查通过；CLI typecheck 的 32 个任务及 lint（68 warning、0 error）通过。
本机 CLI script 缺少 Turbo 可执行路径，改从 CLI 目录使用锁文件版本 Turbo 2.9.14 执行同一任务。
格式按根与 CLI 各自入口检查；CUA 测试沿用根 formatter 的既有排除规则。
未运行全量单测或产品 E2E；没有修改产品源码、公共协议、测试入口或架构策略。

删除文件的位置记录如下，不作为当前文件链接或运行入口。

| 文件                                                                           | 删除理由                                                                                                                                                                                      |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dev-docs/test/capabilityMapCurrentFeatures.test.ts`                      | 逐项复制文档站能力地图的节点说明、图边和关键词，没有与生产实现对照；不能证明所写当前功能事实真实。保留图计算、几何与YAML解析测试。                                                            |
| `apps/dev-docs/test/capabilityMapOfficeComputerUse.test.ts`                    | 复制能力地图手工维护的数据分组、1200行估计、节点/边及说明原文；并未验证Office或CUA功能。                                                                                                      |
| `apps/zcode-cli/packages/adapters/tests/runner-debug-storage-rollback.test.ts` | 只锁旧目录拼接源码写法，不执行debug storage路径解析。                                                                                                                                         |
| `apps/zcode-cli/packages/bootstrap/tests/official-plugin-categories.test.ts`   | 从定义表取固定插件后复制category/defaultEnabled常量，无独立装配行为。                                                                                                                         |
| `apps/zcode-cli/packages/contracts/tests/model-options.test.ts`                | 仅给本地类型对象赋值再断言原对象，无运行时被测实现；类型同源由model-schema-contract保留。                                                                                                     |
| `apps/zcode-cli/packages/debug/tests/gantt-style.test.ts`                      | 直接复制最小宽度常量及其CSS字符串；没有实际时间轴尺寸验证。                                                                                                                                   |
| `apps/zcode-cli/tests/core.unit.test.ts`                                       | 旧根目录src/core已移除，测试仍指向不存在的旧模块且不属于当前Turbo包测试入口；清理退役测试遗留。                                                                                               |
| `packages/client/test/conversationShareRemoteServiceAccess.test.ts`            | 构造accessor后只检查请求过某descriptor和getter truthy；未调用代理方法，也未验证实际频道收发。                                                                                                 |
| `packages/desktop/test/app-launch-telemetry.test.ts`                           | 仅让 createRendererContext mock 返回预设 DTO，再断言另一个 mock 收到相同字段；生产函数只有一行 bridge.syncTelemetryContext(createRendererContext())。真实启动时序与 renderer 隔离测试仍保留。 |
| `packages/desktop/test/armsRumShared.test.ts`                                  | development运行态与production产品环境得到local的同一输入输出，已由 armsBrowserInit 装配测试实际验证传给SDK的env，保留后者。                                                                   |
| `packages/desktop/test/cuaPermissionPanelMessages.test.ts`                     | 两个case逐字段复制中英文文案字典，resolver只有locale/permission索引与字段展开；没有执行权限授权、原生窗口或交互。权限流程相关测试不动。                                                       |
| `packages/desktop/test/desktopTelemetryFetch.test.ts`                          | 仅复述 createDesktopTelemetryFetch 的单层透传：预设 mock Response 原样返回并核对同一组 URL/init；没有验证 Electron、网络或失败分支。                                                          |
| `packages/services/test/clientScenesService.test.ts`                           | 薄包装只调用 readApiJson 并原样返回自造响应；测试大部分复制伪响应，既不验证业务变换也不验证错误或真实HTTP。                                                                                   |
| `packages/services/test/nodeCuaInstallerExports.test.ts`                       | 5个用例都读取源码，匹配类型导出、函数名、配置写法及注释字样；没有实际安装、退出或定时器运行证据。                                                                                             |
| `packages/services/test/providerM2LegacyBoundary.test.ts`                      | 对5个早已删除的固定旧文件路径断言ENOENT；不验证当前实现、数据迁移或导入路径，属于一次性清理的残留。                                                                                           |
| `packages/shared/test/cuaPermissionDragChannels.test.ts`                       | 复制两个共享IPC通道常量字面值并检查四个常量不重复；消费者两端均导入同一常量，测试没有调用实际拖拽链路。                                                                                       |
| `packages/shared/test/modelConfigBuildClosure.test.ts`                         | 只检查Dockerfile COPY文字和相对行序；没有构建、安装或产物导入，不能证明裁剪构建闭包。                                                                                                         |
| `packages/shared/test/modelProviderTypes.test.ts`                              | 仅断言一个退役字符串不在常量枚举及直接枚举比较helper；不执行Provider解析或合法性准入。                                                                                                        |
| `packages/shared/test/offPeakTaskIdentity.test.ts`                             | 3个用例逐项复述单行 Boolean(task.offPeakTaskId) getter；没有任务创建、恢复、持久化或UI身份行为。                                                                                              |
| `packages/shared/test/pluginMarketplaces.test.ts`                              | 复制默认市场静态对象及单元素数组includes的分类结果；没有市场加载、安装、异常或交互验证。                                                                                                      |
| `packages/shared/test/zcodeAgentRuntime.test.ts`                               | 直接复制静态spawnArgs常量与Windows二进制后缀映射；没有解析运行时资源或启动Agent。                                                                                                             |
| `packages/ui/test/automationAddScheduleIcon.test.ts`                           | 真实渲染后只复制 Plus 图标 viewBox、class 和 stroke 常量；没有图标选择、事件或布局结果。                                                                                                      |
| `packages/ui/test/automationDesignPrimitives.test.tsx`                         | 三个用例仅复制第三方 Lucide SVG 的默认尺寸、描边和容器 class；不验证业务行为。                                                                                                                |
| `packages/ui/test/automationTemplateSkeletonGrid.test.ts`                      | 只锁四个静态 skeleton、传入 label 原样显示和 class；没有异步加载状态或布局测量。                                                                                                              |
| `packages/ui/test/button.test.ts`                                              | 非空字符串断言以及 transition-colors/transition-all 字面量复述 cva 配置；不执行按钮交互或测量动画性能。                                                                                       |
| `packages/ui/test/codingPlanEnterpriseTiers.test.ts`                           | 只对技术档位直接大小写/label 映射复述文案；权益、购买、组合分组测试保持。                                                                                                                     |
| `packages/ui/test/collapsible.test.ts`                                         | 只对固定 defaultOpen/forceMount 的服务端 HTML 锁定 Radix 标记与动画 class；没有开关动作或动画生命周期。                                                                                       |
| `packages/ui/test/commandsSettings.test.ts`                                    | 两个用例原样复制 COMMAND_AGENT_SOURCES 和元数据常量；不验证命令发现、来源隔离、加载或执行。                                                                                                   |
| `packages/ui/test/contextTrigger.test.ts`                                      | 只断言传入 aria-label 原样透传、图标大小和无摘要文案；不触发 Context 或验证用量。                                                                                                             |
| `packages/ui/test/desktopWindowFrame.test.ts`                                  | 平台参数表只复述背景/clip/radius class；未操作窗口、测量透明度或验证原生窗控。                                                                                                                |
| `packages/ui/test/enabledStatusFilter.test.ts`                                 | 两用例完整复述 all/enable/disable 三分支布尔比较；无列表筛选组合、实际输入或来源隔离。                                                                                                        |
| `packages/ui/test/modelConfigHelpCopy.test.ts`                                 | 把整段帮助文案复制成第二份 expected 字典；文案修改时必须同步改测试，无法验证模型配置行为。                                                                                                    |
| `packages/ui/test/modelProviderPresetVisibility.test.ts`                       | 仅断言预置常量数组不含一个已下线 ID；不执行 provider 选择或运行门禁。                                                                                                                         |
| `packages/ui/test/modelTrajectoryPane.test.ts`                                 | mock 空轨迹和所有 hooks 后只检查 overflow class，不加载轨迹或执行滚动。                                                                                                                       |
| `packages/ui/test/offPeakHistoryStatus.test.ts`                                | 参数表逐字复制 completed/failed/cancelled 到展示 key 的纯映射；不验证历史成员、持久化或运行态。                                                                                               |
| `packages/ui/test/offPeakTemplateIcons.test.ts`                                | 参数表逐项复制模板到 Lucide 图标名映射及 SVG 常量；动态图标加载和未知图标回退由 automationTemplateRemoteIcons 保留。                                                                          |
| `packages/ui/test/onboardingWelcomeI18n.test.ts`                               | 参数表复制按钮和标题文案；不执行 onboarding，也不验证消息插值。                                                                                                                               |
| `packages/ui/test/pluginDetailHeaderLayout.test.ts`                            | 只按 PDF/CSV 关键词重复简单图标分类正则，不验证解析、文件类型或打开文档。                                                                                                                     |
| `packages/ui/test/pluginStoreManageEntry.test.ts`                              | 固定插件 fixture 静态渲染只锁搜索/卡片/分隔线 DOM 与 class；没有管理入口行为。                                                                                                                |
| `packages/ui/test/previewPaneI18n.test.ts`                                     | 逐字复制预览按钮/错误文案及尺寸说明；实际预览大小边界、路径和格式错误用例保持。                                                                                                               |
| `packages/ui/test/providerKeyLinks.test.ts`                                    | 只数静态获取 Key 按钮及 locale key 次数；传入的 Key 内容不参与任何鉴权或显隐验证。                                                                                                            |
| `packages/ui/test/providerStatusIndicator.test.ts`                             | 把 enabled/executable 的直接三目映射再次写成 data 属性期望；真实 provider 可执行性、水合和空 Registry 行为保留于 modelProviderAvailability。                                                  |
| `packages/ui/test/readToolCallBlock.test.ts`                                   | 两种 clickable 输入最终都只检查文件名颜色 class；真实文件定位/打开行为未触及。                                                                                                                |
| `packages/ui/test/remoteConnectionEntryBehavior.test.ts`                       | 源函数忽略参数固定返回 open-workspace；两个布尔输入只是重复 getter 常量，不测试连接过程。                                                                                                     |
| `packages/ui/test/remoteConnectionTags.test.ts`                                | 只复制 transport 到颜色/label key 的展示查表；完整远程 presentation 时序、recovery 与详情组件测试保留。                                                                                       |
| `packages/ui/test/remoteDeviceTerminologyI18n.test.ts`                         | 只检查删除的字典 key 和产品术语词句；远程身份、连接状态、迁移和 key 完整性校验保持。                                                                                                          |
| `packages/ui/test/selectItemLayout.test.ts`                                    | 先 mock Radix DOM，再检查 SelectItem 的 px/pr class；不验证任何 Select 行为。                                                                                                                 |
| `packages/ui/test/settingsCloseToTrayI18n.test.ts`                             | 只锁定说明文字包含的词句；跨平台托盘能力和关闭行为测试保持。                                                                                                                                  |
| `packages/ui/test/settingsFormTextarea.test.ts`                                | 真实渲染无逻辑 Textarea 包装后只复述 DOM 外壳及颜色/圆角 class。                                                                                                                              |
| `packages/ui/test/settingsHttpProxyI18n.test.ts`                               | 只匹配代理帮助文案的固定词句；不设置代理或验证系统代理跟随。                                                                                                                                  |
| `packages/ui/test/settingsSkillScopeBadge.test.ts`                             | 仅匹配源码中的图标、Badge、分组 helper 名字及 JSX 文本；真正 scope 路由与 marketplace identity 用例保持。                                                                                     |
| `packages/ui/test/sourceServerManagementPresentation.test.ts`                  | 只对两个枚举直接查表 getter 复述同一 locale key；不涉及迁移状态或 wire schema 校验。                                                                                                          |
| `packages/ui/test/statusDot.test.ts`                                           | 只渲染 tone=subtle 并复述颜色 class 映射；没有状态输入变化或业务状态归属。                                                                                                                    |
| `packages/ui/test/toolCallPresentationVocabulary.test.ts`                      | 把 29 个静态翻译 key 的中英文文本完整复制一份；不解析工具、判断状态或执行渲染。                                                                                                               |
| `packages/ui/test/v4ConversationDraftEmptyStateLogo.test.ts`                   | 只检查深浅 Logo 的固定素材和 CSS class；不切换主题或验证主题订阅。                                                                                                                            |
| `packages/ui/test/workspaceSidebarTerminologyI18n.test.ts`                     | 逐字复制同一中英文 locale 字典值；不验证界面按 locale 取值。                                                                                                                                  |
| `packages/ui/test/zcodeProviders.test.ts`                                      | 源函数忽略 provider 永远返回 true，另一函数仅取反；十条期望只是常量重复，真实 fork task 状态与目标 guard 未触及。                                                                             |
| `packages/web/test/webRemoteControlFailures.test.ts`                           | 只照抄固定reason加message的DTO构造；实际连接恢复耗尽后使用connection-recovery-timeout的回归仍由 externalRelayFrameGapRecovery 真实恢复调度测试验证。                                          |
| `packages/zcode-cua/test/broker/host-surface-simplification.test.ts`           | 只扫描已退役type/alias名称与固定装配文本；实际ghost/PiP不可变launch policy已有真实host启动+broker+launcher spec测试，保留该测试及全部签名/权限/生命周期保护。                                 |

| 精简文件                                                                 | 删除范围与保留边界                                                                                                                                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/dev-docs/test/capabilityMapComplexity.test.ts`                     | 删除固定文档图度数快照；保留统计规则，改用固定小图验证跨群、同群、缺失节点及分组的独立期望。                                                                                               |
| `apps/zcode-cli/packages/adapters/tests/mcp.test.ts`                     | 同一describe和相同hooks下有三组完全相同标题及callback；各删后一个，保留第一份完整OAuth行为测试。                                                                                           |
| `apps/zcode-cli/packages/adapters/tests/model-transform.test.ts`         | 与保留的无签名推理块协议投影用例逐 token 相同，保留后一条完整回归。                                                                                                                        |
| `apps/zcode-cli/packages/i18n/tests/i18n.test.ts`                        | 删除固定中文文案复制；保留locale推导、无效值、目录形状兼容规则。                                                                                                                           |
| `apps/zcode-cli/packages/office-runtime/ui/profile.test.ts`              | 只复制各profile文案和例子；保留真正的资源寻址和文件种类隔离用例。                                                                                                                          |
| `apps/zcode-cli/packages/tui/tests/tui-theme.test.ts`                    | 删除对四个颜色字段的直接复制；保留主题优先级、终端背景推断和真实组件随主题改变的验证。                                                                                                     |
| `apps/zcode-cli/packages/tui/tests/tui.unit.test.ts`                     | 只检查固定标签、flex样式和颜色字面值；保留实际内容显隐、渲染、交互和恢复测试。                                                                                                             |
| `packages/client/test/remoteServiceAccess.test.ts`                       | 只测构造时getChannel名称与getter存在；同文件配置实际RPC调用/可选频道隔离/窗口目录选择仍保留。                                                                                              |
| `packages/rpc/test/buffer.test.ts`                                       | 仅重测new Uint8Array的长度和零初始化；保留零拷贝wrap、UTF8、拼接、offset与BE字节运算测试。                                                                                                 |
| `packages/rpc/test/foundation.test.ts`                                   | 普通dispose/单收件者/relay首次投递场景分别被幂等dispose、多listener+Event.map、切换source后旧源隔离的更强测试覆盖。保留清理和取消生命周期边界。                                            |
| `packages/rpc/test/protocol.test.ts`                                     | 单向队列投递被紧邻的双向投递测试包含；保留双向、分片/ACK/拥塞/超时及释放边界。                                                                                                             |
| `packages/rpc/test/serialization.test.ts`                                | 逐个复述reader游标和writer拼接happy path，已被同文件多帧连续serialize/deserialize和类型roundtrip共同执行覆盖。保留全部实际序列化协议测试。                                                 |
| `packages/services/test/accountRequestAuthService.test.ts`               | 只把自造resolver返回值原样再断言，源实现为直接return resolver.resolveCurrent(input)；保留失败不回退及实际鉴权解析安全测试。                                                                |
| `packages/services/test/agentProxyEnv.test.ts`                           | 仅移除 lazy CUA suite 内3个源码切片/分支名字用例；保留 settings-aware 官方 MCP trusted origin 原始3个装配接线守卫，以及全部真实env归一和Host/Agent信任规则一致性执行测试。                 |
| `packages/services/test/highspeedCardService.test.ts`                    | 仅检查源码是否含createServiceLogger字符串，不验证浏览器导入、日志初始化或运行行为。                                                                                                        |
| `packages/services/test/pluginManagementService.test.ts`                 | 三个代理方法都是直接委托；测试只复述参数并断言自造mock结果，不能验证信任、目标隔离或取消执行。保留生命周期遥测变换、取消分类、并发耗时等真实规则测试。                                     |
| `packages/services/test/subagentSelectionAuthority.test.ts`              | 重复shared/subagentMarkdownSelection中同一helper的编码/解码往返；保留本文件实际Markdown解析、中间字段忽略的集成验证。                                                                      |
| `packages/services/test/zcodeAgentPresentationSurface.test.ts`           | 显式true只是!=false的重复正常路径；相同remote authority的缺省开启及显式false关闭、非Desktop拒绝仍保留。                                                                                    |
| `packages/shared/test/dynamicWorkflowFeature.test.ts`                    | 直接比较mode!=disabled结果，已被同文件三个远端合法mode生成配置的enabled断言完整覆盖；保留灰度fail-closed/用户覆盖/旧Host兼容测试。                                                         |
| `packages/shared/test/launchMarks.test.ts`                               | 仅复写LAUNCH_MARKS_QUERY_KEY字符串；保留序列化往返、非法JSON、字段类型边界。                                                                                                               |
| `packages/shared/test/remoteResourcePackages.test.ts`                    | normalize实现完全忽略输入并返回active列表；两个历史值场景重复已有ignores historical selections和缺省列表用例。保留平台工具集合、schema合法与拒绝未知包。                                   |
| `packages/shared/test/shortcutCommands.test.ts`                          | getter测试逐字复制命令表中两条defaultBindings；保留表内ID唯一/绑定合法性、解析边界、composer scope与通道分类规则。                                                                         |
| `packages/ui/test/animatedSidePanePanelLayout.test.ts`                   | 与保留的 keeps active media mounted... callback 完全相同；输入只有 isMediaPreview=true，没有音频类型参数，未覆盖独有场景。                                                                 |
| `packages/ui/test/automationInstructionsComposer.test.ts`                | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/automationsPageTabs.test.ts`                           | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/changesGroupToolCallBlock.test.ts`                     | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/codingPlanQuotaResetAction.test.ts`                    | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/codingPlanQuotaResetOpportunity.test.ts`               | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/commandCenterTypography.test.ts`                       | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/contextAttachmentPill.test.ts`                         | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/controlHintTooltip.test.ts`                            | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/conversationShareImportNotice.test.ts`                 | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/desktopLogoStyle.test.ts`                              | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/editToolCallBlock.test.ts`                             | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/featureRequestDialog.test.ts`                          | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/feedbackStatusMeta.test.ts`                            | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/feedbackSubmitForm.test.ts`                            | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/mentionPanel.test.ts`                                  | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/modelProviderCodingPlanI18n.test.ts`                   | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/modelProviderModelRowEditor.test.ts`                   | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/modelProviderSectionLayoutLoading.test.ts`             | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/modelTrajectoryPaneParts.test.ts`                      | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/pluginStoreAvatar.test.ts`                             | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/previewPaneImageContent.test.ts`                       | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/providerLogo.test.ts`                                  | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/rollingToolbarLabel.test.ts`                           | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/settingsSearchInput.test.ts`                           | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/sidePaneTabTrigger.test.ts`                            | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/usageStatsHeatmap.test.ts`                             | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/useWorkspaceServices.test.ts`                          | 与前一条 没有 registeredBaseServices... 同样传 null，callback 完全相同；保留首条与真实服务生命周期测试。                                                                                   |
| `packages/ui/test/v4ConversationStatusPanel.test.ts`                     | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/v4ConversationTurnGroup.test.ts`                       | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/v4ModelTriggerDisplay.test.ts`                         | 与保留的自定义 provider 名称用例 callback 完全相同；三个用例都没有平台或 viewport 输入，标题变化未增加覆盖。                                                                               |
| `packages/ui/test/windowsCaptionMenuButton.test.ts`                      | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/workspaceHeader.test.ts`                               | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/workspacePurposeSection.test.ts`                       | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/ui/test/workspaceSidebarFooterWebRemoteControlTooltip.test.ts` | 仅移除复述固定 CSS、图标/label 映射或无计算 props 展示的用例；本文件真实交互、边界和状态转换用例保留。                                                                                     |
| `packages/zcode-cua/test/annotations.test.ts`                            | request_access/stop的单独断言重复前面的完整工具集合检查及真实TOOL_REGISTRY sweep；保留applyToolAnnotations实际批量写入行为、完整安全tier与未知工具拒绝路径。                               |
| `packages/zcode-cua/test/argv-shape.test.ts`                             | 所谓任意顺序case与canonical输入完全一致；round-trip只重建相同socket参数重复调用确定性解析器。保留canonical、等号、terminator、兼容标签、所有fail-closed路径。                              |
| `packages/zcode-cua/test/manifest.test.ts`                               | 删除精确14项名单已包含的长度、唯一性、join文本、退役项与tier长度重复断言；删除三个在测试内自造Set差集算法的case。保留精确工具名单、真实registry/schema/map、tiers一致性和association契约。 |
| `packages/zcode-cua/test/server-security.parity.test.ts`                 | 标题声称token-only，但回调实际调用buildServer({})，与首条no credentials case完全相同；保留首条无凭据fail-closed和全部不同socket输入/占位符拒绝/真实tool注册检查。                          |
| `packages/zcode-cua/test/tier-table.test.ts`                             | 4+1+9的合计case重复同文件前面逐组精确名单与数量；保留全部安全tier、冻结及未知名称保守分类。                                                                                                |
| `packages/zcode-cua/test/tool-manifest-json-drift.test.ts`               | 第二条14长度检查被manifest精确名单与第一条mirror顺序相等完整覆盖；保留跨src与eval真实产物一致性。                                                                                          |
| `packages/zcode-cua/test/tool-surface-14.test.ts`                        | 退役项由manifest精确名单和真实MAP成员全量检查覆盖；30-17+1算术case及单独key存在检查不提供新输入或边界。保留MAP精确大小和全部真实click/key折叠schema能力。                                  |

### 第三轮：全库存语义审读

基线 `0cd29a0ab4`。本轮完成全部 3585 个库存文件的逐文件语义审查，共 1071604 行测试。
审查包含完整 setup、局部 helper、夹具及实际被测调用对应的实现；大文件连续分段阅读。
四路协作后，删除候选由另一位审查者复核，再收集用例、实施和定向运行。

| 范围                                 | 文件 | 原始测试行 | 审查账本                                                                                                                                                                                                                                                                                   |
| ------------------------------------ | ---: | ---------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CLI                                  |  905 |     376692 | [cli](unit-test-review/cli.jsonl)、[cli-tail](unit-test-review/cli-tail.jsonl)                                                                                                                                                                                                             |
| UI                                   | 1157 |     296243 | [ui](unit-test-review/ui.jsonl)、[ui-middle](unit-test-review/ui-middle.jsonl)、[ui-tail](unit-test-review/ui-tail.jsonl)、[ui-extra](unit-test-review/ui-extra.jsonl)、[ui-root-extra](unit-test-review/ui-root-extra.jsonl)、[ui-runtime-extra](unit-test-review/ui-runtime-extra.jsonl) |
| 桌面、CUA、Web 与其他运行包          | 1141 |     308364 | [runtime](unit-test-review/runtime.jsonl)、[runtime-tail](unit-test-review/runtime-tail.jsonl)、[runtime-extra](unit-test-review/runtime-extra.jsonl)                                                                                                                                      |
| 服务、协议、Provider、RPC 与基础脚本 |  375 |      88035 | [foundation](unit-test-review/foundation.jsonl)                                                                                                                                                                                                                                            |
| Go、Python、Kotlin                   |    7 |       2270 | [extra-languages](unit-test-review/extra-languages.jsonl)                                                                                                                                                                                                                                  |

库存与账本核对：3585 条记录，路径无重复、无缺失；原始哈希与全文行数逐项一致，
所有实现依据路径均存在。测试命名文件另有 619 个 E2E、浏览器验收文件，按范围排除；
原生实现与设备夹具未发现额外单测入口。审完不表示全部删除，保留理由同样逐文件记录。

清理包括静态 CSS、图标与普通文案复制、未被消费的场景参数、仅验证替身的回声、
同输入重复及过宽的默认目录断言。保留独有权限、来源身份、时序、IO 接线、协议 schema、
调用端状态装配和跨语言目录一致性。相同数据属性不替代实际消费的动态样式接线。

部分参数化用例合并注册后，输入与观察点仍全部保留。CLI 第 067 批减少的 537 个注册
属于这类合并，不记为删除 537 个独立场景。逐项删减依据以账本为准，不按注册下降比例评价。

本轮删除 60 个测试文件，精简 859 个混合文件，净减少 25410 行测试；
产品源码、配置、测试入口与 E2E 均未修改。加上前两轮，累计删除 183 个测试文件。

Vitest 已实际收集的 921 个对照文件，活跃注册数从 18542 减至 16665，减少 1877 个。
该统计含参数化注册合并，不是删除 1877 个独立输入；不包含 Node 原生入口、平台跳过项、
Android 静态声明和未注册文件。原生入口单独验证，不将其静态声明冒充已执行用例。

验证：根与 CLI 类型检查、Lint、变更架构检查、根与 CLI 变更文件格式检查通过。
CLI 按正确的包目录定向验证 257 个现存修改文件：7105 条通过、24 条跳过、0 失败；
3 个删除文件排除。早期浏览器测试的 13 处失败来自错误执行目录，改从 core 包运行后
48 条通过；SEA 缺少构建依赖的 2 处失败在补建 model-option-map 后，42 条全部通过。
MCP 保留全部 11 条真实接线测试，仅在四处断言中精确排除另有验证的默认文档插件名单，
保留目标顺序、一次启动、未知额外 server 拒绝与完整信任检查，最终包级验证通过。

根 affected 使用任务起点 `f540bccfa694da2435227d252bf5c39ab512a34b`，
官方预览选择 621/2481 个规格；最终 620 个文件通过、1 个文件跳过，
9938 条通过、10 条跳过，耗时 229.19 秒。未运行全量单测或 E2E。
Android 只删除模板算术测试，因环境无 Java Runtime，Gradle 收集与执行未完成；
该一条声明仅计静态删除。Go/Python 保留文件未修改，不声称本轮执行了它们。

当前覆盖矩阵没有新增失效的删除文件引用；旧计划、历史运行报告与本规格历史清单保留历史路径。
删除无法证明布局、退役行为或特定异步场景的断言，不表示这些行为因此获得自动化覆盖。

### 合并 staging 后的覆盖衔接

合并 staging `65f956a8fc` 时，单测冲突按双方行为合并：保留上游 MCP 启动测试拆分，
将第三轮保留的四条接线用例与精确文档 server 过滤迁入新文件；保留持久记忆的新参数契约、
禁用/缺配置时对象身份、幂等和原输入不变断言；保留新草稿首帧检查与旧发送结果隔离回归。
侧栏 overflow 数值边界保留，旧 CSS/源码拼写断言继续删除；上游将其中一条原样搬到
`sidePaneTabStripAddMenu.test.ts`，该迁移副本及其失效导出排除项一并删除。
`pluginStoreManageEntry.test.ts` 的上游修改仍只调整源码定位与固定 class 检查，
沿用已完成的整文件删除，不因定位表达式修复重新引入低价值断言。
浏览器测试保留上游桌面缩放、CDP 空闲断开后重连及 viewport 同步回归，
继续删除构造参数透传与初始内存计数的旧重复断言。

第三轮库存、统计和账本哈希保留为 `7c90e96411` 的审查快照，不代表合并后新增文件的库存。

合并验证同时复现 staging 已有的引用稳定性失败：`ProjectTaskRows` 每次渲染都为
`TaskList.organizationActions` 创建新 JSX 引用，使子组件的 memo 比较失效。
经确认后使用依赖 `task` 的 `useMemo` 保持引用稳定；任务对象变化时菜单仍更新，
菜单自身继续订阅目录与国际化上下文。原有失败用例修复后通过，未放宽断言。

最终合并验证以 `7c90e96411` 为起点：根 affected 选择 702/2483 个规格，
702 个文件、7534 条通过，1 条跳过；CLI 四个定向文件共 36 条通过。
根与 CLI 类型检查、Lint、架构检查、数据库结构检查及冲突文件格式检查通过。
新工作树缺少 Electron 安装产物导致的四个文件加载失败，在补齐产物后复跑通过；
未运行全量单测、桌面 E2E 或开源导出验收。

后续合并 staging `840d040f57` 时，保留 `@zcode/shared/test-ids` 入口迁移、
插件并发安装、MCP 连接就绪、会话 lease 释放和桌面/手机 Esc 授权的新回归。
冲突中的旧 class、字典常量和重复装配断言继续删除；
`pluginStoreManageEntry.test.ts` 仅更新空操作夹具，仍沿用整文件删除。

本次根与 CLI 类型检查、Lint、架构及冲突文件格式检查通过；
UI 冲突定向验证 131 条、CLI 定向验证 79 条通过。
根 affected 选择 1360/2484 个规格，执行中按要求停止，未完成整轮验证；
交付按要求跳过 push hook，不将中断的执行记为通过。
