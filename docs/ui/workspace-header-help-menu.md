# Workspace Header Help Menu

Workspace header action 区在终端按钮左侧提供轻量帮助菜单，作为用户在主工作区内获取支持、反馈和文档的固定入口。

## 布局

- 已有任务的完整 Workspace Header 中，帮助按钮位于 Terminal toggle 左侧，和编辑器切换、Terminal、Side pane 属于同一 header action group。
- 新建任务草稿态没有完整 Workspace Header，但右上角仍提供同一个帮助按钮。
- 按钮使用图标按钮样式，保持 `icon-md` 尺寸和 `ghost` 视觉，避免挤占 workspace 标题。
- 远程手机窄屏复用 `simplifyForNarrowRemote`，隐藏帮助按钮和 Terminal 按钮，避免远控标题栏拥挤。
- Windows / Linux 桌面端的新建任务草稿态右上角有自绘窗口控制按钮，帮助按钮必须通过右侧安全间距避开最小化、最大化和关闭区域。

## 菜单项

菜单分为两组，不显示分组标题，仅桌面端在两组之间放一条分隔线。

第一组从上到下：
1. 产品文档：打开 `https://zcode.z.ai/docs`。
2. 用户社群：走 `IPlatformService.openCommunity()`。
3. 问题上报：打开内置反馈表单，保持 `type=bug`、`module=其它`、`includeLogs=true` 和截图行为。
4. 给产品提需求：打开独立需求弹窗，保持 `type=feature`、`includeLogs=false`。

第二组仅桌面端展示，从上到下：导出日志、资源管理器、检查更新、关于 ZCode。检查更新仅 production 显示，保留已有动态文案及禁用状态；Preview 隐藏。关于始终为最后一项。

“导出日志”复用 `titleBar.menu.help.exportLogs` 文案和 `createHelpMenuActionHandlers().exportLogs`，经 `IPlatformService.exportLogs()` 调用系统菜单使用的同一个主进程导出函数。沿用正在导出的 toast、失败提示及完成后在系统文件浏览器中定位日志包的行为，不新增导出实现。Web（含手机远控）没有本地导出能力，只保留第一组，不渲染导出日志或多余分隔线。

```text
问号菜单 → 共享导出动作 / toast → IPlatformService.exportLogs() → IPC ─┐
系统菜单 → DesktopCommandIds.ExportLogs ────────────────────────────┤
                                                                  ↓
                                                    main exportLogs → 日志包 / 系统定位
```

更新状态链路：main updater（唯一 owner）→ 平台快照 / 状态事件 → 菜单展示；点击 → 现有桌面命令 → main updater。实时事件优先于较早发出的快照，卸载后不应用响应。

验收：桌面任务页、草稿态和设置页的共享问号菜单均可打开关于窗口，中英文显示“关于 ZCode” / “About ZCode”；Web 不出现无效入口。

导出验收：组件单测覆盖桌面入口、共享动作和 Web 隐藏；`help-menu-about.test.ts` 的英文草稿态与中文设置页场景实际点击导出日志，验证主进程生成 ZIP 并请求系统定位、完成后关闭导出提示，继续验证菜单顺序及关于入口。系统定位调用在隔离 E2E 中拦截，实际归档仍执行。

2026-10-09 验证：macOS arm64 Preview E2E 4/4 通过，英文 Zai Light、中文 Zai Dark 截图已核对；帮助配置使用本地夹具，等待动态项加载结束后断言顺序。相关单测 34/34、typecheck、E2E typecheck、lint、架构及格式检查通过；lint 有 68 条非本次改动警告。未运行 Windows/Linux 实机、手机浏览器及 production 身份 E2E。运行记录：`packages/desktop/.e2e-artifacts/desktop-e2e-20261009043852849-p29715-f22a05c87493b116/summary.json`。

所有可见文案必须走 i18n；菜单项使用 lucide 图标，不硬编码中文到组件内。

## 给产品提需求弹窗

- 不复用通用问题上报表单，避免截图、日志、问题描述等 bug 语义干扰用户。
- 弹窗包含引导文案、必填的“需求描述”和“期望的解决方案”、可选联系方式。
- “重置内容”位于底部左侧；“取消”和“提交需求”位于底部右侧。
- 两个必填字段都有内容后才允许提交。
- 提交时把两个字段组织成结构化 Markdown description，并通过 feedback service 创建 `feature` 类型工单。
