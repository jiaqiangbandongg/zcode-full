# New Task Empty State Logo

## 背景

New Task 的空状态标题是用户进入项目后开始创建任务的首屏提示，需要在不影响文本可读性和布局稳定性的前提下增加 ZCode 品牌标识。

## 方案

- 在 `ChatViewEmptyState` 文本背后加入装饰性 ZCode SVG logo。
- Logo 保持原始 `400x320px` 比例，移动端通过 `min(72vw, 25rem)` 自适应收缩，避免横向溢出。
- Logo 描边使用 `currentColor`，继承外层容器的 `foreground-subtlest` 语义色，并叠加 `opacity-70`，比正文 `foreground` 降低层级，自动适配亮色和暗色主题。
- Logo 外层容器固定 `400:320` 比例，通过 Tailwind arbitrary properties 设置标准 CSS mask 和 `-webkit-mask-image`，从顶部渐隐到高度 `70%` 处完全透明，兼容 Electron/Chromium 渲染路径，避免把 mask 直接写在 SVG 元素上。
- Logo 相对标题中心上移 `-mt-10`，让装饰图形主要停留在标题背后和上方，减少底部淡出区域对输入区的视觉干扰。
- Logo 使用 `aria-hidden` 和 `pointer-events-none`，不参与可访问性朗读，也不拦截输入。
- 文本使用更高层级覆盖在 logo 上方，采用 `text-3xl` 衬线字体增强空状态的品牌感，保持现有国际化文案和布局不变。
