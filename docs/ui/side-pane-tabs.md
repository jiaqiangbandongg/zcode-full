# Side Pane Tabs

## 目标

右侧 side pane 从单槽位切换升级为多 tab 模型，允许 Browser、Diff 和 Code Viewer 同时保留，并在 pane 内切换。

## 关键设计

- side pane 状态改为 `tabs + activeTabId`，而不是单个 `type`
- Diff 使用 singleton tab，重复点击只激活或关闭当前 tab
- Browser 支持多实例 tab；主入口的 Browser fallback 会优先切换到已有 Browser，而 tab strip 加号里的 Browser 会新建独立 tab
- Code Viewer 按稳定 `sourceKey` 复用 tab，避免同一文件重复堆叠
- 切换 workspace 时只保留 Browser tab，回收跟工作区强绑定的 Diff / Code Viewer

## UI 行为

- 空白页与 tab strip 的「+」菜单均展示当前工作区已启用的插件面板（`ui.surfaces`），共用 `usePluginUiSurfaces` 与现有插件打开动作；菜单使用标准 `DropdownMenuItem`，支持鼠标、触屏、键盘选择，选择后关闭菜单。
- 插件入口只在正式会话、宿主打开动作与 bridge 可用时出现；草稿、无可用面板或不支持的宿主不显示插件项。标题沿用清单本地化规则。打开时完整传递 workspacePath、workspaceIdentity、remoteSessionId 和 parentSessionId，同一 surface 重复打开沿用既有 tab 去重规则。
- 修复原因：插件入口此前只接入空白页，有 tab 后切换到另一套「+」菜单，后者漏接插件列表。两处入口共享组件，仅切换按钮/菜单呈现；不增加插件注册表、会话状态或 runtime。桌面 continuous、手机 replayable 和现有插件宿主支持边界保持不变。

```text
Host 已启用插件 → usePluginUiSurfaces → 空白页按钮 / + 菜单项
                                            ↓ 选择
                         useOpenPluginUi → 既有 side pane tab owner
```

- 右侧面板顶部使用项目现有 `Tabs` 组件渲染 tab strip
- 切换 tab 时保留已打开 pane 的实例，避免 Browser webview 被销毁
- Browser tab 会跟随 webview 的 `page-title-updated` / `page-favicon-updated` 事件显示网页 title 和 favicon；事件未返回时回退到默认 Browser 标题和 Globe 图标
- Header 上原来的 Browser / Diff 独立按钮已移除，统一收口到最右侧 side pane 按钮
- side pane 按钮始终可点击；它只负责展开/收起右侧容器，不自动创建 Browser / Review / Terminal 等任何 tab
- New Task 草稿态与已有 Task 复用同一个 `WorkspaceHeader` 骨架，通过 `variant="draft"` 隐藏 task 专属上下文和菜单，并保留 Help / Terminal / Side Pane 与平台 caption 操作区。进入新草稿时 side pane 继续默认收起，用户点击按钮后按草稿 owner 恢复已有 tab；没有可见 tab 时展示 `Open tab` 空态，不得隐式创建 tab。手机 Web 远控继续复用现有 side pane overlay，不新增独立 runtime 或恢复链路。完整约束见 `docs/ui/workspace-header-variants.md`。
- 当 side pane 展开但当前任务没有可见 tab 时显示 `Open tab` 空态页面；判定使用按 active task 过滤后的可见 tab 集，而不是 workspace registry 的全部 tab。即使 registry 仍保留其他 task 的 session-scoped 隐藏 tab，也必须显示空态，不显示空 tab strip 或 `+` 菜单。用户必须显式点击空态按钮才会创建 tab。入口按钮窄面板使用一列 `icon + name`，side pane 被拉宽到 480px 以上时按容器宽度横向排布，且单个按钮内部改为上方 icon、下方 name；按钮圆角为 `rounded-xl`，名称字号为 13px，图标尺寸为 16px，背景使用 `surface`，不显示边框。
- 关闭最后一个 tab 或执行关闭全部 tab 后，side pane 立即进入收起态；用户再次打开 Browser / Diff / Code Viewer / Terminal 等 tab 时再自动展开
- 当 Browser / Diff / Code Viewer 被重新激活时，会自动清掉收起态，避免右侧已有内容却继续隐藏
- 对话级 tab 按归属 scope 隐藏而不销毁；切到无 tab 的对话时收起，但普通 Browser 与 browser-use
  `<webview>` 都仍在后台挂载保活。切回有 tab 的对话时重新选择该对话的 preferred/current/latest tab，
  并主动展开，不能继承中间对话的收起态
- Code Viewer 对代码文件继续使用语法高亮预览；对 `.md/.markdown` 文件和 markdown 文本 source 改为正文渲染，支持在 side pane 里直接检查标题、列表、工作区文件链接和外链跳转
- Code Viewer 顶部显示紧凑路径面包屑：优先按当前 workspace 展示 `workspace -> 目录 -> 文件`，末尾文件节点带文件类型图标；超长路径通过横向滚动查看
- Code Viewer 右上角改为 `更多 + 打开` 两个按钮；关闭仍统一走 tab 自身的关闭入口，`更多` 菜单只承载文件类型相关视图切换，当前已支持 markdown 预览/源码、SVG 预览/代码，以及普通代码文件的自动换行开关
- tab strip 支持横向拖拽排序，排序只改变 `tabs` 数组顺序，不改变当前 `activeTabId`
- 每一个 tab 默认宽度为 156px（`w-39`）；当 tab strip 的可用宽度不足以维持默认宽度时，所有 tab 等宽收缩，最小宽度为 60px（`min-w-15`）。只有在所有 tab 都缩到 60px 后仍无法容纳时，tab strip 才允许横向滚动。标题使用 tab 内图标、徽标之外的剩余空间，关闭按钮绝对定位不占位；icon 与文字组成 item-content，超长内容使用 mask 淡出而非省略号；关闭按钮显示时渐隐区域左移，内容不位移或重新排版
- tab 总览不参与 tab 宽度等分。新增按钮在未溢出时紧跟最后一个 tab；所有 tab 已缩到 60px 后仍无法容纳、tab strip 开始横向滚动时，新增按钮移到滚动区域外并固定在右侧
- 每个 tab 的关闭按钮绝对定位、不占标题空间，仅在选中、hover 或 focus-within 时显示；隐藏时不响应鼠标点击，键盘聚焦可使其显示。触屏先选中再关闭；关闭操作继续阻止 tab 激活或拖拽
- 标签页支持鼠标中键关闭：中键按在 tab 的任意非交互区域时直接关闭该 tab，不先激活它；浏览器默认的中键自动滚动行为也必须被阻止。该交互复用所有 Side Pane tab 类型（包括侧边聊天、Browser、Terminal 等）；移动 Web 触屏没有中键，不依赖此交互
- 每个 tab 复用项目封装的 Tooltip 展示未截断完整标题。指针进入后等待 1500ms 才显示；离开或移到另一个 tab 时立即取消当前提示，新 tab 必须重新等待完整 1500ms，不沿用 Tooltip group 的快速切换窗口。拖拽 tab 时强制关闭提示，触屏端不依赖该 hover 交互
- 拖拽使用小距离阈值，普通点击仍然只负责切换 tab；关闭图标区域不触发拖拽
- tab strip 支持右键菜单，当前提供关闭当前 tab 和关闭其他 tab；关闭其他 tab 会保留并激活被右键操作的 tab
- tab strip 的加号旁提供标签总览入口，可按标题、路径/URL 和类型多词搜索已打开标签、查看打开时间、切换到目标标签，并支持关闭其他标签或关闭全部标签
- 标签总览底部展示最近关闭的标签页；点击最近关闭项会重新打开并激活对应 tab
- 标签总览搜索会同时过滤已打开标签和最近关闭标签；搜索结果按标题命中优先，再按路径/URL 和类型命中排序
- side pane 的 tabs、折叠态、Git source 选择和 Browser 当前 URL 按 `workspaceIdentity?.trim() || workspacePath` 缓存在内存中，跨 workspace 切换后恢复；刷新或重启应用后不保留
- 多 Browser tab 的 URL 按 `browser tab id -> URL` 记录，避免多个 webview 共用同一份恢复地址
- 桌面端 `Cmd/Ctrl+W` 走“关闭当前上下文”语义：右侧 side pane 展开且存在 active tab 时优先关闭该 tab；否则回退到关闭当前窗口。该快捷键由 main 进程转发给 renderer 判断，避免 Electron 原生 `close` role 绕过 side pane 状态直接关闭窗口。
