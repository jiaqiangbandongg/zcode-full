# Side Pane Tabs E2E Case Catalog

## 范围

本文记录 Side Pane Tab strip 的响应式宽度、溢出、操作按钮和标题 Tooltip 的桌面端 UI E2E 语义。该能力属于 UI shell presentation，不依赖 Agent、provider fixture、session realtime 或持久化恢复。

## 状态维度与剪枝

| 维度          | 等价类                                                       | 决策                                                                                  |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 可用宽度      | 可容纳 156px / 需要在 156px 与 60px 间收缩 / 60px 仍无法容纳 | 三类均覆盖                                                                            |
| Tab 类型      | Browser / Terminal / Diff / Code Viewer / session-scoped tab | 使用可重复创建的 Terminal 代表共享 `SidePaneTabTrigger`；类型专属内容不在本组重复覆盖 |
| Tab 状态      | active / inactive                                            | 关闭按钮 case 同时覆盖                                                                |
| Tooltip hover | 未满 1500ms / 满 1500ms / 跨 Tab                             | 三类均覆盖                                                                            |
| 客户端        | Desktop / mobile Web touch                                   | Desktop 覆盖；触屏不依赖 hover，剪枝 Tooltip；移动布局由组件级响应式测试覆盖          |
| 鼠标中键      | active / inactive tab                                        | Desktop 覆盖；中键关闭不激活目标 tab，并阻止浏览器默认中键滚动                        |
| 其他交互      | 拖拽、右键、标签总览                                         | 不属于本次改动，使用既有组件测试，不在本组重复覆盖                                    |

## 接受的 Case

### SPT-E2E-000 独立面板平台圆角与拖动指示线

- Setup：桌面新任务草稿，展开 Side Pane 和底部 Terminal，分别使用亮暗主题。
- Action：等待平台状态和布局就绪，hover 并拖动 Sidebar、Side Pane、Terminal 手柄。
- Assertions：Windows 5px，Sequoia 及更早 macOS 6px，Tahoe 26+ 12px，Linux 12px；三处热区保持 4px，指示线为沿边 2px foreground-subtlest/50、无 mask，默认隐藏且 hover/拖动可见，尺寸真实变化。
- 数据链路补充：useAppChromeStateAutoUpdate.test.ts 运行真实 hook，以平台异步查询返回 macOS 15/26，验证半径与订阅清理；用于在非 macOS CI 中捕获 macOS 查询被守卫跳过的问题。不能替代 macOS 原生视觉验收。

### SPT-E2E-001 默认宽度与跟随加号

- Setup：桌面窗口打开 Side Pane，仅创建一个 Terminal tab，空间足以容纳默认宽度。
- Action：观察 tab strip。
- Assertions：Tab 宽度为 156px（允许亚像素误差）；横向 viewport 无溢出；新增按钮位于滚动内容内并紧跟最后一个 Tab。

### SPT-E2E-002 等宽收缩但不滚动

- Setup：创建三个 Terminal tabs，把窗口调整到需要收缩但仍能让每个 Tab 大于 60px 的宽度。
- Action：等待 ResizeObserver 完成布局。
- Assertions：所有 Tab 宽度相等；宽度处于 `[60px, 156px)`；横向 viewport 无溢出；新增按钮仍位于滚动内容内。

### SPT-E2E-003 达到最小宽度后滚动

- Setup：继续创建 Terminal tabs，使 60px 最小宽度之和超过可用空间。
- Action：等待溢出状态更新。
- Assertions：所有 Tab 不小于 60px；viewport 的 `scrollWidth > clientWidth`；新增按钮移到 viewport 外、固定在右侧操作区。

### SPT-E2E-004 选中或 hover 时显示关闭按钮且不激活

- Setup：至少两个 Tab，第二个为 active，第一个为 inactive。
- Action：移开鼠标并清除焦点，检查关闭按钮可见性；hover inactive Tab 后点击其关闭按钮。
- Assertions：active Tab 的关闭按钮可见；inactive Tab 未 hover 时隐藏、hover 后可见；inactive Tab 被关闭；原 active Tab 保持 active。

### SPT-E2E-005 Tooltip 独立等待 1500ms

- Setup：至少两个 Tab。
- Action：hover 第一个 Tab 不满 1500ms，移到第二个 Tab，再等待到第二个 Tab 自己满 1500ms。
- Assertions：第一个等待窗口内不显示 Tooltip；跨 Tab 后不会继承已等待时长；第二个 Tab 满 1500ms 后显示包含完整标题的 Tooltip。

### SPT-E2E-006 鼠标中键关闭且不激活

- Setup：至少两个 Tab，第二个为 active，第一个为 inactive。
- Action：在 inactive Tab 的标签主体上派发鼠标中键（`button=1`）事件。
- Assertions：inactive Tab 被关闭；原 active Tab 保持 active；事件默认行为被阻止，且不会触发标签激活。

### SPT-E2E-007 插件面板的双入口

- Setup：真实 `AnimatedSidePanePanel`、插件发现 hook、菜单与打开动作；bridge 注入两条已启用 surface，覆盖桌面宽度/en-US/亮色及手机宽度/zh-CN/暗色。
- Action：先从空白页发出插件打开请求，再提供已有 tab 状态并打开「+」菜单；鼠标重复选择同一插件，键盘选择另一个插件。另覆盖草稿、空目录、无打开动作和无 bridge 的宿主。
- Assertions：两入口候选与本地化标题一致；菜单选择关闭；打开请求保留工作区/会话隔离字段；重复打开只激活同一 tab；草稿/空目录/无宿主均无插件项。菜单位于视口内，页面无横向溢出。
- 边界：浏览器 UI E2E 注入服务目录，在既有 tab owner 边界检查打开结果，不启动插件沙箱、Agent 或手机远控链路；这些宿主能力沿用既有验证。

## 不变量

- `+` 不参与 Tab 等宽计算。
- 滚动只能发生在所有 Tab 已达到 60px 下限之后。
- 关闭按钮点击不得触发 Tab 激活或拖拽。
- 鼠标中键关闭不得先激活目标 Tab，也不得触发浏览器默认中键滚动。
- Tooltip 的定时状态不得改变 Tab 的 flex shrink 行为。
- 本组测试不得启动模型请求或依赖 provider replay fixture。

## 通用 / 编程界面模式 M1

范围与 MODE-01～07 用例见 [模式验证矩阵](general-coding-mode-verification.md)。新增桌面用例位于 `packages/desktop/test/e2e/ui-shell/general-coding-mode.test.ts`，覆盖设置偏好、入口隐藏和已有面板保留；已人工验收并转为 ui-shell 正式用例，尚未加入 Docker preset。对话展示由组件单测补充，验证状态以该矩阵为准。
