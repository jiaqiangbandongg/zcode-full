# 内置浏览器地址栏操作与更多菜单规格

> 状态：已实现（2026-07-31）
> 范围：`packages/ui` 统一内置浏览器 chrome；不修改 Browser Use 协议、guest 生命周期或远控消息流。

## 1. 目标

内置浏览器在地址栏右侧提供“在默认浏览器中打开”能力，同时收敛窄侧栏中的操作密度。

地址输入框固定使用 `h-7 rounded-lg`（28 CSS px 高、8 CSS px 圆角）；外层工具栏继续使用 `h-12`（48 CSS px），由工具栏垂直居中地址框和操作按钮。

新建浏览器 tab 后立即显示空置态，底层 `<webview>` 只挂载、不显示。地址栏内容在回车前属于未提交草稿：输入、粘贴或清空草稿均不得关闭空置态或提前显示 `<webview>`；只有确认提交合法 URL、恢复既有 URL 或接收外部导航请求后，才进入已导航状态并显示 `<webview>`。

`<webview>` 节点自身固定使用 `#FFF` 背景，不区分加载状态或 ZCode 明暗主题。空置态继续提前挂载 guest，但节点从创建时就同时使用内联 `visibility:hidden` 与 `display:none`，阻止 Electron guest surface 在 CSS 类生效前合成白色首帧；确认导航后解除隐藏。不得增加额外覆盖层或向 guest 网页注入 CSS，网页声明的背景正常绘制在该白色底之上。

地址栏操作的完整优先级固定为：

```text
自由尺寸 -> 选择元素 -> 在默认浏览器中打开 -> 调试
```

实际 chrome 只常驻前两个操作，第三个位置固定为“更多”菜单：

```text
+---------- address ----------+ [自由尺寸] [选择元素] [更多]
                                                       |
                                                       +-- 在默认浏览器中打开
                                                       +-- 调试
```

## 2. 交互合同

- “自由尺寸”和“选择元素”继续保持现有图标、激活态、禁用态和顺序。
- “更多”是地址栏右侧第三个常驻图标按钮，支持鼠标和键盘打开。
- 菜单按完整操作优先级展示被折叠的两个动作：
  1. 在默认浏览器中打开。
  2. 打开调试工具。
- “在默认浏览器中打开”使用当前已加载页面 URL，不使用地址栏里尚未提交的草稿。
- 仅当前页面为 `http:`、`https:` 或 `file:`，且 guest 已就绪时允许外部打开；`about:`、`data:`、空页和未就绪状态保持禁用。
- “打开调试工具”沿用现有 guest ready 门禁与 `webview.openDevTools()` 行为。
- 点击任一菜单项后菜单关闭；错误或 detached guest 继续使用既有安全调用和 UI logger 诊断边界。

## 3. 平台与状态边界

外部打开复用 `IPlatformService.openExternal`：

```text
  BrowserToolbar menu
  -> UnifiedBrowserView 读取当前 guest URL 并校验 http/https/file
    -> IPlatformService.openExternal(url)
      -> Desktop: Electron shell
      -> Web fallback: window.open
```

- 不新增 UI 直接访问 `window.zcode`。
- 不新增 Desktop main / host process 业务状态，也不新增同步 IO。
- Desktop `desktop-continuous` 与手机 `web-remote-replayable` 的 stream、snapshot、queue、owner/lease 语义均不变化。
- Web 当前不暴露 embedded-browser capability；共享组件仍保持平台注入兼容。

## 4. 验证

- 组件测试约束常驻操作只有“自由尺寸、选择元素、更多”，并验证 DOM 顺序。
- 菜单测试约束“在默认浏览器中打开”位于“调试”之前。
- `http/https` 当前页面点击外部打开时，精确调用一次 `platform.openExternal(currentUrl)`。
- 未提交地址栏草稿不能覆盖当前页面 URL。
- `about/data` 与 guest 未就绪时外部打开禁用且不调用平台；所有 `file:` 页面允许调用平台。
- 调试菜单项继续调用当前 guest 的 `openDevTools()`。
- 必跑定向 Vitest、`pnpm typecheck` 与 `pnpm lint`。
