# Markdown Inline Code Token

Markdown 行内代码使用独立背景 token `--color-markdown-inline-code`。

## 设计约束

- `--color-markdown-inline-code` 映射到 `--color-tag`，表达轻量胶囊标签，不提升到 card 层级。
- 行内代码文字继续继承 Markdown 正文的 `--color-foreground`，保证阅读连续性。
- 代码块不使用该 token，继续由 CodeBlock / CodeViewer 的代码主题控制。
- `font-mono` 使用跨平台 CJK-safe 字体栈：拉丁字符优先系统等宽字体，简体中文在 Windows 优先回退到 `Microsoft YaHei UI` / `Microsoft YaHei`，macOS 回退到 `PingFang SC`，Linux 回退到 `Noto Sans CJK SC`，禁止中文直接落到通用 `monospace` 所选择的宋体。
- CodeViewer / DiffViewer 必须通过 `--diffs-font-family: var(--font-mono)` 复用同一字体栈，不能沿用 `@pierre/diffs` 自带的不含 CJK 无衬线字体的 fallback。

## 实现位置

- token 定义在 `packages/ui/src/styles.css`。
- Markdown inline code 渲染在 `packages/ui/src/components/ai-elements/message.tsx`。
- Markdown code block、文件预览和完整 diff 的字体映射位于 `packages/ui/src/components/ui/code-viewer.tsx` 与 `packages/ui/src/components/ui/diff-viewer.tsx`。
