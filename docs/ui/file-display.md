# 文件显示工具

新增了 `packages/ui/src/lib/fileDisplay.tsx`，用于把文件路径格式化成统一的展示片段。

默认行为：

- 显示文件图标
- 只显示主文件名

可选能力：

- 传入 `basePath` 后输出相对路径的次要目录文本
- 通过 `showIcon` / `showFilePath` 控制是否显示图标和路径
- 通过 `FileDisplayInline` 在 React 组件里直接复用
- 通过 `createFileDisplayDom` 在 Lexical / 原生 DOM 场景里复用

示例：

```ts
resolveFileDisplayDescriptor("/Users/dev/Projects/element-web/apps/web/src/Avatar.ts", {
  basePath: "/Users/dev/Projects/element-web",
});
```

输出语义：

- file-icon: `typescript`
- file-name: `Avatar.ts`
- file-path: `apps/web/src/`

当前 `PromptMentionNode` 已切到该工具，默认展示为“图标 + 文件名”。

## Office 文件图标

- `.doc`、`.docx` 统一映射到 `word.svg`，`.xlsx` 映射到 `table.svg`，`.pptx` 映射到 `powerpoint.svg`。
- Office 扩展名与素材文件名不是一一对应关系，必须通过 `EXTENSION_ICON_ALIASES` 维护映射，不能直接使用扩展名拼接资源路径。
- Desktop 与 Web 必须各自在 `public/material-icons` 中携带相同的图标文件，保证本地 `file://`、普通 Web 和手机 `/remote` 均可通过现有 `BASE_URL` 规则加载。
- 图标只表达文件类型，不改变 Office 文件的预览、编辑或远程工作区能力边界。
