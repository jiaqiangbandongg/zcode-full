# Slash Command 和官方插件描述汉化

## 背景

`/` 面板会把 ZCode Agent 的可见 slash command 和已启用 skill 合并展示。内置 command 的描述来自协议命令表，官方插件附带的 command、skill 和 MCP 工具描述来自插件包自身的元数据与 MCP server 注册信息。

## 目标

- 中文 UI 中，内置 `/compact`、`/goal` 的描述必须显示中文。
- 官方插件附带的 command frontmatter `description` 必须是中文。
- 官方插件附带的 skill frontmatter `description` 必须是中文。
- 官方插件附带的 MCP tool `title`、`description` 和参数 `describe(...)` 必须是中文，避免工具列表继续出现英文说明。

## 边界

- 用户自定义 command、用户/工作区 skill、第三方插件的原始描述不自动翻译，继续展示作者提供的文案。
- 内置 command 仍保留协议层的兼容字段；UI 展示时按当前 locale 覆盖稳定内置命令的描述。
- 官方插件当前没有 per-locale manifest/frontmatter 协议，因此官方资源的展示描述直接写为中文。

## 验收

- 中文 `/` 面板中 `/compact` 和 `/goal` 不再显示英文描述。
- 官方插件的 `android-dev`、`ios-dev`、`control-browser`、`docx`、`pdf`、`skill-creator` 技能描述为中文。
- 官方插件 `android-dev`、`ios-dev` command 描述为中文。
- Android Emulator 和 iOS Simulator MCP 工具标题、说明、参数说明为中文。
