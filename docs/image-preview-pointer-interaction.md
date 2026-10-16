# 图片预览指针交互约束

## 问题

桌面端全屏图片预览使用模态 Dialog。Dialog 打开时会把页面根交互层设为
`pointer-events: none`，Electron 顶部区域同时可能参与窗口拖拽命中；图片视口还会
在拖拽时捕获 pointer。若预览没有显式恢复指针命中、退出拖拽区域，或拖拽结束后
遗留 pointer capture，右上角下载、关闭等操作会出现鼠标 hover 和点击无反馈。

## 交互边界

```text
Electron 原生鼠标事件
        │
        ▼
图片预览 Dialog（pointer-events-auto + app-region:no-drag）
        │
        ├── 顶部操作按钮（不得被图片视口捕获）
        ├── 上一张 / 下一张
        ├── 图片拖拽与缩放（pointerup/cancel/lostcapture 时释放）
        └── 底部缩放按钮
```

- 预览 Dialog 必须显式使用 `pointer-events-auto` 和 `[app-region:no-drag]`。
- 所有可点击按钮必须保持既有 hover 视觉，不因交互修复改变样式。
- 图片拖拽只由预览视口处理，不得覆盖浮层按钮的命中区域。
- 图片视口在 `pointerup`、`pointercancel` 和 `lostpointercapture` 时必须清理拖拽状态；
  重置预览时必须主动释放仍存在的 pointer capture。
- 位于 Electron 标题栏范围内的右上角操作区必须统一声明 `[app-region:no-drag]`，
  并同时包住下载和关闭按钮，避免两个相邻操作形成不连续的原生命中区域。
- macOS desktop 使用 `titleBarStyle: hidden`，其原生标题栏命中不能只靠 CSS
  `no-drag` 抵消；右上角操作区必须整体放到标题栏下方。Web、手机、Windows 和
  Linux 使用各自布局，不继承 macOS 安全间距。
- 桌面端和 Web 端共用这一交互边界；Electron 专用属性在 Web 端应无副作用。
