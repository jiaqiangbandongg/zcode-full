# CodeViewer @pierre/diffs 渲染

`packages/ui/src/components/ui/code-viewer.tsx` 现在按 `@pierre/diffs` 的代码文件模型重新实现：

- 用 `FileContents` 表达预览文件：`name`、`contents`、`lang`、`cacheKey`
- 用 `@pierre/diffs/react` 的 `File` 组件渲染
- 只保留代码预览相关参数：语言、高亮开关、行号、换行、主题和字号

旧版手写 Shiki/grid 实现已经移除，当前 CodeViewer 直接由
`@pierre/diffs/react` 的 `File` 组件承载代码行、行号和 annotation 渲染。

Markdown code block 通过 CodeViewer 做只读代码展示，不支持 comment。
