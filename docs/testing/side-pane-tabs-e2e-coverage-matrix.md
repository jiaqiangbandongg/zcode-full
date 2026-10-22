# Side Pane Tabs E2E Coverage Matrix

| Case ID     | Default 156px | Equal shrink | 60px floor    | Horizontal scroll | `+` placement | Active close | Inactive close | Tooltip reset | Middle-click close | Spec                                                      |
| ----------- | ------------- | ------------ | ------------- | ----------------- | ------------- | ------------ | -------------- | ------------- | ------------------ | --------------------------------------------------------- |
| SPT-E2E-001 | covered       | n/a          | n/a           | asserts absent    | follows tabs  | n/a          | n/a            | n/a           | n/a                | `ui-shell/side-pane-tabs-responsive-interactions.test.ts` |
| SPT-E2E-002 | boundary      | covered      | asserts above | asserts absent    | follows tabs  | n/a          | n/a            | n/a           | n/a                | `ui-shell/side-pane-tabs-responsive-interactions.test.ts` |
| SPT-E2E-003 | n/a           | covered      | covered       | covered           | fixed outside | n/a          | n/a            | n/a           | n/a                | `ui-shell/side-pane-tabs-responsive-interactions.test.ts` |
| SPT-E2E-004 | n/a           | n/a          | n/a           | n/a               | n/a           | covered      | covered        | n/a           | n/a                | `ui-shell/side-pane-tabs-responsive-interactions.test.ts` |
| SPT-E2E-005 | n/a           | n/a          | n/a           | n/a               | n/a           | n/a          | n/a            | covered       | n/a                | `ui-shell/side-pane-tabs-responsive-interactions.test.ts` |
| SPT-E2E-006 | n/a           | n/a          | n/a           | n/a               | n/a           | n/a          | covered        | n/a           | covered            | `ui-shell/side-pane-tabs-responsive-interactions.test.ts` |

## Coverage Notes

- 2026-10-15 SPT-E2E-007 加载图标回归：浏览器 12/12 通过。8 组安装/启用用例验证目标入口有可见旋转图标和 `aria-busy`，其他插件无进度，成功/失败后清除；新增同一插件双 surface 共用进度、只发一次安装请求，以及减少动画偏好下静态图标的验证。覆盖桌面亮色英文、窄屏暗色中文与空态/新标签页；服务由 fixture 提供，仍为 pending。

- 2026-10-12 rebase 回归：保留侧栏 scope 修复，网页权限沿用当前基线；E2E 改用当前 `activeTaskId` 对话选择接口、通用会话准备和无账号启动，页面 fixture 只提供两个本地站点。macOS Electron SPT-E2E-008 1/1 通过（`desktop-e2e-20261012032035626-p33390-08ac35a2e03ad569`）；受影响单测、根/E2E typecheck、lint、architecture check 通过。补齐插件侧栏的 parentSessionId 归属断言，仍保持 manual-review/pending；未新增 Windows/Linux 或手机实机验证。

- 2026-10-19 SPT-E2E-007 并发安装回归：推荐区删除独立全局锁，与市场共用管理 store 的按插件忙碌判定。浏览器 16/16 通过，覆盖两个不同插件同时待处理、后一次失败不清理前一次、安装中打开其他已启用插件，以及原有重复点击、同插件双 surface、启用、失败恢复和减少动画偏好；1200px/英文/Zai Light 与 390px/中文/Zai Dark，默认新标签页和主动新增标签页均覆盖。Hook 定向 8/8 通过，含服务切换后旧操作完成隔离；最终 affected 90 个文件、1379 条通过。根 typecheck、architecture 和变更文件格式检查通过；lint 无错误，188 条警告与原基线一致。夹具按当前面板 owner 初始化默认 new-tab，避免旧空面板状态不再挂载入口。服务仍由 fixture 注入，未启动真实 Agent/沙箱或手机远控，保留 pending。

- SPT-E2E-007：`packages/ui/test/browser/manual-review/pending/side-pane-plugin-menu.test.mjs`，空态 launcher + active new-tab launcher 使用真实 reducer 创建标签，覆盖鼠标、Tab/Enter、作用域与重复打开、安装/启用、草稿/无宿主门禁及冷加载；1200px/en-US/亮色与 390px/zh-CN/暗色。2026-10-14 自动浏览器 E2E 11/11 通过，其中 8 组以可控响应验证安装/启用进度仅归属目标插件、其他插件保留原文案、全局禁用、失败后换插件重试及成功后不自动打开。仍为 pending，未提升 CI admission，未声明插件沙箱或真实手机远控覆盖。
- Logo 样式迁移：SPT-E2E-000 在 Windows/Linux 验证旧 28px 点击区域及位置、18px 底座、11px 静态 SVG、真实 hover 和点击收起/恢复 Sidebar。Windows 实测通过：`desktop-e2e-20261009065750634-p17396-21ed3ac7f4753068`，1/1；Linux 真机待补，平台条件由组件测试覆盖。

- SPT-E2E-008：`manual-review/pending/side-pane-scope.test.ts`，覆盖对话隔离的关闭与恢复；2026-09-30 macOS Electron 1/1 通过（`desktop-e2e-20260930-063101-322`），保留 manual-review/pending。跨工作区及异步 authority 由 `useAppPanelsScope.test.ts` 覆盖，归属类型由 `workspaceSidePane.test.ts` 覆盖。未宣称 Windows/Linux 或手机实机验证。
- 本轮小重构回归：552/552 相关单测；原侧栏交互 7 通过、1 非 macOS 窗口控件用例跳过（`desktop-e2e-20260930-062902-680`）；完整权限 22/22（`desktop-e2e-20260930-063214-472`）。根 typecheck、E2E typecheck、lint（63 个已有 warning）、architecture check 和变更代码格式检查通过。
- 修复前证据：Hook 7/8 失败；旧构建 `desktop-e2e-20260930-061702-522` 在 B 关闭其他后找不到 A 设置 tab。快捷 Browser 入口遗漏工作区另有先红后绿的单测。运行报告与逐次日志：`packages/desktop/.e2e-artifacts/side-pane-scope-20260930/README.md`。

- SPT-E2E-004 验证选中 tab 显示关闭按钮、未选中且未 hover 时隐藏，hover 后通过真实鼠标点击关闭且不激活该 tab；键盘 focus-within 也显示关闭按钮，触屏通过先选中再关闭。
- SPT-E2E-004 同时检查 item-content 使用 mask、文字不使用 ellipsis，hover 时 mask 改变而内容宽度和文字位置不变。
- SPT-E2E-001 同时检查 Electron 中 Side Header 的窗口拖拽 CSS 区域，以及标签、按钮的 no-drag 排除；既有菜单、关闭交互继续回归。此断言不替代操作系统原生窗口位移验证。
- 2026-09-04 Side Header 修复回归：`desktop-e2e-20260904085528667-p35124-05b2c42316ba4c37`，7/7 通过；typecheck、E2E typecheck、lint 通过（41 个已有警告）。测试展开条件改为真实面板宽度与透明度；Tooltip 使用语义节点检查，避免持久挂载 DOM、标题前缀和屏幕阅读器副本导致误判。Windows/Linux 原生窗口位移尚未独立验证。
- 物理宽度、scroll metrics、DOM containment 和可见性由 Electron WebDriver 读取真实渲染结果。
- Tooltip 使用受控等待窗口验证，不使用 provider stream timing。
- Mobile Web touch 不承诺 hover Tooltip；其 layout shell 保留现有组件测试，未作为本组 Desktop E2E 的覆盖声明。

## 独立面板布局（2026-09-04）

- 2026-09-10 CR-01：SPT-E2E-000 平台期望为 Windows 5px、Sequoia/更早 macOS 6px、Tahoe 26+ 与 Linux 12px；三处指示线为 foreground-subtlest/50、沿边原长度、无 mask。useAppChromeStateAutoUpdate.test.ts 补齐平台查询→hook→半径的数据链路，验证 macOS 15/26 的异步结果和订阅清理；macOS 真机视觉待补。

- 2026-09-07 补齐 resize handle 与平台圆角覆盖：SPT-E2E-000 接受 Windows 5px、macOS/Linux/Web 12px；验证 Sidebar、Side Pane、Terminal 三个 handle 的 4px 热区、2px `bg-foreground` 指示线、默认隐藏及 hover/拖动态显示，并以真实指针分别改变 Sidebar 宽度、左右面板宽度和会话/终端高度。设置页 Sidebar 的 268px 桌面宽度由 `settings/settings-ui-polish.test.ts` 覆盖，紧凑 68px 继续由组件测试覆盖。
- 2026-09-07 补齐验收：Workspace suite 7/7 通过，运行 ID `desktop-e2e-20260907065558567-p30371-3b85b0c85fbbae83`；Settings suite 5/5 通过，运行 ID `desktop-e2e-20260907065702167-p33040-7fa462d329a4436b`。47 项相关单测通过。
- 开关按钮迁移：SPT-E2E-000 检查空态展开后 WorkspaceHeader 不再显示开关、Side Header 可收起；SPT-E2E-001 覆盖有标签时在 Side Header 收起、从 WorkspaceHeader 再展开并保留标签。
- 迁移验证：`desktop-e2e-20260904085939961-p43497-9ecade9b51e2c858`，macOS Electron 7/7；相关单测 33/33、typecheck、E2E typecheck、lint 通过（41 个已有警告）。已检查深色空态截图；Windows/Linux 与手机端未单独执行视觉 E2E。
  依据 `docs/design/workspace-independent-panels.md`，SPT-E2E-000 增加面板上下对齐、4px 间距、Header 归属、xl 圆角与关闭恢复宽度断言。现有 tab 展开/关闭、缩放、拖动用例继续覆盖持久挂载行为；手机分支和 Windows/Linux 控制区由针对性单测覆盖。

最终验收：`desktop-e2e-20260904084050358-p6937-68e000533efda13e`，7/7 通过。SPT-E2E-000 同时覆盖真实拖动、底部终端、双主题截图；截图文件为该 artifact 目录下 `independent-panels-zai-light.png` / `independent-panels-zai-dark.png`。其他平台独立视觉验证待补，详见布局 spec。

## 通用 / 编程界面模式 M1

范围与 MODE-01～07 用例见 [模式验证矩阵](general-coding-mode-verification.md)。新增桌面用例位于 `packages/desktop/test/e2e/ui-shell/general-coding-mode.test.ts`，覆盖设置偏好、入口隐藏和已有面板保留；已人工验收并转为 ui-shell 正式用例，尚未加入 Docker preset。对话展示由组件单测补充，验证状态以该矩阵为准。

2026-10-09 平台尺寸：SPT-E2E-000 Windows 6px 外沿／收起左留白、8px 圆角、指示线和实际拖动通过，run `desktop-e2e-20261009070445229-p20968-57b667c6addfb7fa`。Linux 4px／12px 保留，真机待补。

2026-10-09 拖动指示线：SPT-E2E-000 Windows 双主题验证 Sidebar、Side Pane、底部终端为 sky-500／sky-400，长度、显隐与实际拖动通过；run desktop-e2e-20261009071748019-p456-09549c1404406786。Linux/macOS 真机待补，Web 保留原色的布局边界单测通过。

2026-10-12 CR-01：SPT-E2E-000 展开时检查 Side Pane chrome 圆角 token，收起后检查会话 chrome token；两种状态均检查计算圆角。展开会话使用动态变量，避免对独立面板路径误报缺少 token。

验证：Windows 与 macOS Sequoia 圆角分支的渲染回归测试通过（所在文件 28/28）；macOS Tahoe 的 SPT-E2E-000 通过，run `desktop-e2e-20261012025943835-p89324-74abc1ab5327b1fe`（1/1）。Windows / Sequoia 真机、Linux 与手机实机未在本轮执行；仅修改测试断言，无产品代码或交互行为变更。

## 默认新标签页

- SPT-E2E-009：`ui-shell/side-pane-tabs-responsive-interactions.test.ts`，覆盖首次展开、工具替换、收起恢复、加号及最后一个标签关闭。
- `useAppPanelsBrowserViewLifecycle.test.ts` 覆盖真实 hook 的默认入口、工具替换和异步关闭。
- macOS Electron 本轮 9 通过、1 平台条件跳过（Windows 菜单），含 SPT-E2E-009 与 SPT-E2E-000 深浅主题截图；run `desktop-e2e-20261016082511861-p45212-c004286dcc3d9c01`。手机实机、Windows/Linux 真机和卡顿归因未验证。

2026-10-16 评审修复：SPT-E2E-009 定向通过（1/1），run `desktop-e2e-20261016-091135-357`。覆盖末标签关闭收起、再次展开补建、真实关闭菜单命令，以及后续关闭上下文事件不被 App 拦截；测试未实际关闭宿主窗口。受影响单测 79 文件、1320 条通过。此前整文件运行其余 8 条通过、1 条平台跳过；009 的菜单回调和动画等待问题在上述定向重跑中修正。手机实机、Windows/Linux 真机未新增验证。

## 完整视图（SPFV，2026-10-16）

| Case ID      | 入口/退出     | surface      | 浮窗形态               | 拖动吸附 | owner 记忆 | 阻塞交互 | Spec                                                                    |
| ------------ | ------------- | ------------ | ---------------------- | -------- | ---------- | -------- | ----------------------------------------------------------------------- |
| SPFV-E2E-001 | 按钮 + 快捷键 | n/a          | n/a                    | n/a      | n/a        | n/a      | `ui-shell/side-pane-full-view.test.ts`                                  |
| SPFV-E2E-002 | n/a           | 对话 / 面板  | 收起（单行）           | n/a      | n/a        | n/a      | `ui-shell/side-pane-full-view.test.ts`                                  |
| SPFV-E2E-003 | n/a           | 对话 / 面板  | 收起 + 操作栏 / 最小化 | n/a      | n/a        | n/a      | `ui-shell/side-pane-full-view.test.ts`                                  |
| SPFV-E2E-004 | n/a           | 菜单切到对话 | 收起                   | 左上     | n/a        | n/a      | `ui-shell/side-pane-full-view.test.ts`                                  |
| SPFV-E2E-005 | n/a           | 面板         | 展开 / 收起            | n/a      | n/a        | n/a      | `ui-shell/side-pane-full-view.test.ts`                                  |
| SPFV-E2E-006 | ◫ 退出        | n/a          | n/a                    | n/a      | n/a        | n/a      | `ui-shell/side-pane-full-view.test.ts`                                  |
| SPFV-E2E-009 | n/a           | 面板         | 收起                   | n/a      | n/a        | n/a      | `ui-shell/side-pane-full-view.test.ts`                                  |
| SPFV-E2E-007 | 按钮          | 面板         | 收起（发送）           | n/a      | covered    | n/a      | `conversation-session/conversation-session-side-pane-full-view.test.ts` |
| SPFV-E2E-008 | n/a           | 面板         | 最小化 → 自动恢复      | n/a      | n/a        | covered  | `conversation-session/conversation-session-side-pane-full-view.test.ts` |

- 2026-10-16 macOS Electron：ui-shell 6/6（`desktop-e2e-20261016132641383-p65282-482172e91cde062d`）；provider 2/2（`desktop-e2e-20261016132902337-p68218-55a5106a8275c319`，replay `common.json` + case fixture）；SPT 回归 8/8。ui-shell 用例存了深浅主题截图（展开、收起 + 操作栏、最小化）。仍为 manual-review/pending，未加入 Docker preset；Windows/Linux 未执行。
- 运行时定位记录：选菜单项曾因 portal 事件沿 React 树冒泡切换展开态（004 回归断言）；用 CSS 压缩对话列 flex 会让 react-resizable-panels 的 group 尺寸为 0、展开 resize 得到 NaN（007 切回会话覆盖）；controller 引用不稳定会让 memo 的 WorkspaceShellLayout 在切换会话时出现 React #185（单测 + 007 覆盖）。
- 2026-10-16 第二轮（保留侧栏、抽屉、单行输入框、loading、恢复动画、滚动条、插件层）macOS Electron：ui-shell 7/7（`desktop-e2e-20261016152650322-p89798-2c5c15bc8942f302`，含深浅主题截图）；provider 2/2（`desktop-e2e-20261016152827854-p91091-9383fec55304cbe0`）；SPT 回归 8/8。仍为 manual-review/pending；Windows/Linux 未执行。
- 第二轮运行时定位记录：恢复动画逐帧采样显示浮窗宽 48px 时单行输入框折行到 258px，随宽度变大回落到 46px（003 断言每帧高度不超过最终值）；插件 UI 空白由外框 `z-10` 盖住 body 级停靠层造成，009 在旧构建上命中 `browser`、改为 `z-0` 后命中插件页面；004 的偶发失败是测试在宿主几何过渡中读坐标，改为等待宿主 `getAnimations()` 结束。
- 2026-10-17 转正（用户确认 review）：ui-shell 移到 `ui-shell/side-pane-full-view.test.ts`；provider 用例经 `e2e:promote --reviewed --apply` 移到 `conversation-session/conversation-session-side-pane-full-view.test.ts`，`audit:conversation-session-coverage` 通过，正式路径 `e2e:fixture:check` 通过。新增断言：运行中占位「工作中 N 秒」与流式消息同值（008）、回答气泡弹出 / 切回仍在 / 点击展开 / × 关闭（007、008）。macOS Electron 正式路径：provider 显式回放 2/2（`desktop-e2e-20261016172121606-p45655-10a0c044cbc26349`）、默认回放 2/2、ui-shell 7/7、SPT 8/8。Docker 隔离运行与 preset 准入未执行（本机 Docker daemon 未启动）；Windows/Linux 未执行。
- 转正时的运行时定位：正式回放下回答很快，整轮在一次渲染批次里结束，`data-running` 从未为 true；气泡改为「基线之后出现的已结束回合才弹出」，不再要求观察到运行中。
- provider 用例需要 case-local 的标题与 compact 响应：manual-review 小上下文窗口每轮都会自动 compact，compact 失败会退避重试并把后续输入留在队列。
