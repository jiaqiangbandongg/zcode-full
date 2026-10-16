# 内置插件：zcode-guide（使用与自诊断指南）

> Spec v2 · 2026-07-01 · 基于 staging 分支源码实测

## 目标

提供一个**随包内置、默认启用**的官方插件 `zcode-guide`，其技能集让 **agent 和用户**能够：

1. 正确配置 ZCode 的五类扩展资源：MCP、commands、skills、hooks、plugins。
2. 当配置出问题时，**逐类**定位（localization）并**自修复**（self-repair）。

最终目标：**仅凭该插件的技能，agent 就能自己诊断并修复配置问题**——不依赖外部文档，全部动作落到可执行的 `zcode` 子命令与明确的配置文件编辑上。

## 为什么做成内置默认启用插件

- 与 `skill-creator` / `document-skills` 同属**纯内容型**插件（只有 `skills/`，无 MCP、无系统依赖），可安全 `defaultEnabled: true`，开箱即用。
- 复用现有官方插件 seed 链路：首启把 bundle 里的插件物化到 `<storageRoot>/cache/zcode-plugins-official/<name>/<version>/`，并写入官方 marketplace.json。
- 用户可在插件管理页停用（内置插件只能停用、不能卸载）。

## 注册改动点（仅两处手工清单）

| 文件 | 改动 | 作用 |
|---|---|---|
| `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts` | 新增 `OFFICIAL_PLUGIN_DEFINITIONS` 条目，`defaultEnabled: true` | 运行时 seed + 自动进入 `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`，两个 reader（CLI `resolveZCodePlugins`、应用启动 `resolveStartupPlugins`）都会默认启用 |
| `apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs` | 新增 `officialSeaPlugins` 条目，`requiresRuntime: false` | 打进 SEA 单可执行文件；`requiresRuntime:false` 跳过 `dist/mcp/server.js` 校验 |

其余 reader（`bundled-plugins.ts` seed、`writeOfficialMarketplace`、`getZCodePluginsOverview` 可恢复内置列表、skills/commands 的 plugin root 注入）都从 `OFFICIAL_PLUGIN_DEFINITIONS` 自动派生，无需改动。

> ⚠️ 内置插件有多个读取入口。默认启用依赖 `officialPluginsEnabledByDefault` 集合被**每个** discovery 入口透传。历史上 `resolveStartupPlugins` 曾漏传（commit c0120fa），导致 `zcode plugins list` 显示已启用但会话里 `/skill <name>` 报 not found。验收必须同时跑 CLI 列表**和**真实会话。

## 插件目录结构

```
apps/zcode-cli/packages/zcode-guide-plugin/
├── .zcode-plugin/plugin.json      # 清单：name=zcode-guide, skills="skills"
├── package.json                   # @zcode/zcode-guide-plugin（SEA 脚本按 packageName 读取）
├── README.md
└── skills/
    ├── zcode-configuration-guide/SKILL.md   # 总纲：五类资源位置/优先级 + 路由到诊断技能
    ├── diagnosing-mcp/SKILL.md
    ├── diagnosing-skills/SKILL.md
    ├── diagnosing-commands/SKILL.md
    ├── diagnosing-hooks/SKILL.md
    └── diagnosing-plugins/SKILL.md
```

## 技能设计

> 技能正文面向**用户与外部 agent**，用**正式、专业的英文**书写，**不含任何源码内部引用**（无 `file:line`、函数名、commit 号、内部注册流程）。保留的是用户真正需要的：CLI 命令、配置文件路径、优先级与合并规则、诊断码。本 spec 与代码注释保持中文。

### zcode-configuration-guide（总纲）
配置五类资源的**位置、作用域、优先级、合并规则**一张总表，外加“我该配哪里”的选型建议；末尾把每类问题路由到对应 `diagnosing-*` 技能。

### diagnosing-*（五个诊断技能）
统一结构，每个都直接可执行：
1. **配置位置与优先级**——每类资源在 user/project 两级读取的确切文件路径与覆盖顺序。
2. **检查命令**——`zcode <plugins|skills|commands> list --json` / `inspect --json` 等结构化诊断入口（自修复的骨架）。
3. **常见坑点表**——症状 → 根因 → 代码检测点 → 修复动作。
4. **定位流程**——有序命令 + 文件检查，收敛到一个明确修复动作。
5. **自修复动作**——每个坑点对应的确切编辑或命令。

## 关键事实（对齐源码，修正了旧文档）

- **用户主配置是 `~/.zcode/cli/config.json`**（不是 `~/.zcode/config.json`）。项目配置 `<repo>/.zcode/config.json` 或 `<repo>/zcode.json`。
- **MCP `.agents/mcp.json` 差异（CLI vs 客户端）**：`apps/zcode-cli` CLI 运行时不读 `.agents/mcp.json`；但**桌面客户端会读**（`packages/desktop/src/main/mcpUserDirectory/index.ts` 的 `AGENTS_MCP_DESCRIPTOR`），作为同 scope 的 fallback（该 scope 的 `.zcode` 无 MCP server 时才读，key 用顶层 `mcpServers`），并喂给运行会话。技能面向客户端，故按客户端行为书写。项目级 MCP 默认 **untrusted**，不自动连接，需 `/mcp connect`。MCP 覆盖顺序 `cli > env > user > project > system`（user 盖 project）。
- **MCP 无 headless 子命令**：`/mcp`、`/mcp connect` 是 TUI 交互命令；无 `--json`。最接近的结构化视图是 `zcode plugins list --json`（仅列插件 MCP 名，无连接状态）。
- **skills/commands 发现顺序**：explicit → user `.zcode` → user `.agents` → project `.zcode`（cwd 上溯到 git 根）→ project `.agents` → 已启用插件。skills 按**路径**为身份、load 时**首个同名先赢**；commands 按**规范化命令名**去重、**先到先赢**并把 loser 记为 `custom_command_duplicate_name`。
- **嵌套命令名用 `:` 连接**：`review/code.md` → `/review:code`（不是 `/review/code`）。命令名正则 `^[a-z0-9][a-z0-9_:-]{0,63}$`。
- **诊断默认隐藏**：`zcode commands|skills|plugins list` 人类模式需加 `--verbose` 才打印 diagnostics；`--json` 恒包含。
- **hooks 信任门已移除**（commit bfde6ff44）：`canRunPluginHooks` 现恒 `true`，三方插件 hook **也会执行**。旧“仅官方执行/三方仅诊断”说法已过时；`marketplace.ts` 仍残留一条误导性 `plugin_unsupported_component` 警告。配置文件 hooks 需显式 `hooks.enabled=true`；有任一插件 hook 时运行器被强制启用。
- **hooks 事件名**（精确 7 个）：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`、`Stop`。`matcher` 是**大小写敏感正则**，对工具事件匹配工具名（含别名 `Task→Agent`、`Write|Edit→ApplyPatch`）。`command` 的 `timeout` 单位为**秒**，`process` 的 `timeoutMs` 为**毫秒**；`async` 字段目前是运行时 no-op。
- **git 代理只认 `ZCODE_HTTP_PROXY`**（不认裸 `http_proxy`）——marketplace clone 失败时先查这个。
- 停用/禁用状态持久化在 `~/.zcode/cli/config.json` 的 `plugins.enabledPlugins[id]`；内置“卸载”写 `plugins.suppressedBuiltins`；按路径禁用 skill/command 用 `skill["/abs/SKILL.md"].enable=false`。

## 验收

- `pnpm typecheck` + `pnpm lint` 通过。
- `zcode plugins list --json` 能看到 `zcode-guide` 且 `enabled:true`。
- 真实会话（非仅 CLI）里 `/skill diagnosing-mcp` 等技能可加载。
