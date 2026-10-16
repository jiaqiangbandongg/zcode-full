# Computer Use 插件展示名规范

## 背景

CUA 插件的历史 manifest 名称是 `zcode-cua`，而 Browser Use 的内部 slug 是
`browser-use`。当前官方目录已经把 CUA 的展示名设为 `Computer Use`，但已安装插件、
能力分组和部分确认文案仍直接把旧 manifest 名称格式化成 `Zcode Cua`，造成两个官方
插件的用户可见命名风格不一致。

## 目标

- 所有用户可见的 CUA 插件名称统一使用 `Computer Use`；中文使用 `电脑控制`。
- 需要 slug 的用户可见上下文使用 `computer-use`（例如 MCP server 名称），不再把
  `zcode-cua` 当作产品名称展示。
- model-facing Skill 的 canonical name 使用 `computer-use`，qualified name 为
  `computer-use:computer-use`；producer 与 consumer 的 Skill 目录、同步脚本和 provenance
  必须保持同名。
- 保持 `@zcode/zcode-cua` 包名、producer 仓库、producer pin、源码路径和 macOS Helper
  bundle identity 不变；本次不提供旧插件 ID 或旧 Skill 名称的兼容别名。

## 方案

1. 继续以 official marketplace listing 的 `displayName`/`displayNameI18n` 作为展示名
   权威来源，不在 manifest 中复制一套会与目录分叉的展示字段。
2. 设置页的已安装插件列表、面包屑、卸载确认、Skills/Commands/Subagents/Hooks/MCP
   能力分组都通过同一套 listing display-name 解析逻辑展示；没有 listing 的第三方
   插件继续按原 slug 格式化降级。
3. CUA 仓库只调整面向用户的插件标题、README/launcher 日志等文案，并将 model-facing
   Skill 从 `zcode-computer-use` 重命名为 `computer-use`；manifest 的 `name: computer-use`、
   `mcpServers.computer-use`、包名和运行时协议字段保持不变。

## 不变量

- 安装、启停、卸载、更新、权限 broker 注入和 MCP runtime namespace 仍按
  `computer-use@zcode-plugins-official` 与 `plugin:computer-use:computer-use` 关联。
- SkillPort 发现的官方 Skill 必须是 `computer-use:computer-use`；不得继续发布
  `zcode-cua:zcode-computer-use`，也不得同时暴露两个官方 Skill。
- 展示名变更不得改变桌面端 continuous 或 Web remote replayable 的运行链路，也不得
  改变技能、命令、subagent 的 provenance/权限判断。
- 缺失或无法解析 marketplace listing 时，UI 必须安全回退到原有 canonical slug，
  不伪造或硬编码其他插件的名称。

## 验证

- 单元测试覆盖 CUA listing 的中英文展示名解析，以及已安装插件列表使用 listing 名称。
- z-code 运行 `pnpm typecheck`、`pnpm lint` 和受影响 UI/插件单测。
- CUA 运行 `pnpm typecheck`、`pnpm lint` 和受影响脚本/文案契约测试。
