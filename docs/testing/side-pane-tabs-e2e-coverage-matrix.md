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

- SPT-E2E-007：`packages/ui/test/browser/manual-review/pending/side-pane-plugin-menu.test.mjs`，真实 side pane 双入口、鼠标/键盘选择与菜单关闭、作用域传递/重复打开、草稿/空目录/无宿主门禁；1200px/en-US/亮色与 390px/zh-CN/暗色。2026-10-09 两组通过，修复前在「+」菜单缺少插件项的断言处失败；相关单测 114/114、typecheck、E2E typecheck、架构检查通过，lint 为 0 错误、69 条既有警告。浏览器 UI 回归，未声明完整插件沙箱、Windows/Linux Electron 或真实手机远控覆盖；用例保留 pending，未提升 CI admission。

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
