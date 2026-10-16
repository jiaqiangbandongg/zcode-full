# Mermaid 渲染

## 范围

- 聊天消息、Markdown 预览、工具输出里标记为 `mermaid` / `mmd` 的 fenced code block 会渲染为 Mermaid 图表；未标语言但首行明显是 Mermaid 图表语法的纯文本 code block 也会自动渲染。
- 右侧代码查看器识别 `.mmd` / `.mermaid` 文件时也会直接展示图表。

## 实现

- 语言识别统一走 `packages/ui/src/lib/mermaidLanguage.ts`，避免不同入口手写判断。
- 图表渲染组件为 `packages/ui/src/components/ai-elements/mermaid-block.tsx`，使用 `@streamdown/mermaid` 的 Mermaid 实例，并读取当前主题 token 生成 Mermaid `themeVariables`。
- Mermaid 渲染通过模块级队列串行执行，避免多个图表同时初始化 Mermaid 全局配置时互相覆盖主题。

## 放大预览

- Mermaid 图表渲染入口放在代码块 header 操作区，位于复制按钮左侧，桌面端和移动端都常驻显示；图表尚未渲染完成时按钮禁用。点击入口或双击图表区域打开预览弹窗。
- 预览弹窗由通用图表预览组件承载，桌面端使用接近全屏的 Dialog，移动端占满可用视口。弹窗只展示已渲染的 SVG，不重新解释 Markdown，也不改变流式消息边界。
- 预览打开后默认按弹窗可视区域和 SVG 可见图形边界执行 zoom-to-fit；小图也会在缩放上限内放大，Mermaid 外层背景画布不参与 fit。工具栏提供放大、缩小、缩放比例菜单（zoom to 50% / 100% / 200%、zoom to fit、reset zoom）和关闭；快捷键支持 `Esc` 关闭、`+` / `-` 缩放。
- 预览视口支持鼠标拖拽平移、滚轮平移、按指针位置缩放。macOS 触摸板捏合在浏览器里表现为 `ctrlKey` wheel 事件，弹窗内将其解释为以当前指针为中心的缩放；普通双指滚动保持为平移。
- 移动 Web 端通过 Pointer Events 支持单指拖拽平移和双指捏合缩放。所有手势只在弹窗内容区接管，避免影响聊天列表、远控 replayable 消息恢复和桌面 continuous 主链路。
- 图表主题继续复用当前 Mermaid themeVariables，预览容器使用 `--color-popover` / `--color-border` / `--color-foreground` 等设计 token，兼容亮色、暗色和 Zai 主题。

## 流式边界

聊天消息仍在 streaming 时，`mermaid` code block 先保留源码展示；消息完成后再切换为图表渲染。这样可以避免未闭合或半截 Mermaid 源码在流式更新中反复触发渲染错误。
