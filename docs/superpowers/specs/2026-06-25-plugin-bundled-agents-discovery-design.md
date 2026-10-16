# 插件 Agent 发现（plugin-bundled agents discovery）— 设计

日期：2026-06-25
分支：feature-harness-improve

## 2026-07-18 运行时名称与 UI 资源投影边界

后续实现已经让启用插件的 agent 进入运行时列表。一个插件 agent 文件始终对应一个规范资源，
规范名称为 `<plugin-name>:<agent-name>`；当裸名称在内置、用户、工作区和其它插件之间唯一时，
运行时还可提供 `<agent-name>` 兼容别名。

这两个名称是同一文件的调用入口，不是两个安装资源，因此列表契约必须区分：

- `AgentsListResult.agents` 是运行时调用投影，可同时包含规范名称和唯一裸名称别名。
- `AgentsListResult.pluginAgents` 是插件资源投影，每个 agent 文件只返回规范名称一条。
- Settings > Subagents 必须使用 `pluginAgents` 展示插件资源；不得把 `agents` 中的运行时别名再次
  当成插件资源行。
- 插件详情继续使用 `pluginAgents` 按真实 `path` 归属组件。

该边界保留裸名称调用兼容性，同时修复“安装一个插件 agent，设置页显示两条”的身份泄漏。
本节覆盖下文原始设计中“不进入运行时”和“`agents` 语义不变”的历史约束。

## 2026-09-09 Todo103：官方缓存与插件覆盖接续

- 补充没有安装记录的官方缓存发现，遵守安装记录优先、显式禁用/卸载抑制优先、有效 manifest 版本选择。
- 默认启用 ID 统一放共享市场契约，Node-only 目录扫描放共享 Node 入口；下文“各自复制第三份”是历史方案，不再据此新增跨域具体实现依赖。
- 插件 agent 允许按稳定 ID 保存用户模型/推理覆盖，规范名和裸名加载同一覆盖，不改写插件文件。
  存储、离线迁移、冷启动及有效选择语义以 `docs/subagents-built-in-model-overrides.md` G04-B 为准。

## 背景与问题

插件安装后，插件包（已安装目录形如 `<storageRoot>/cache/<marketplace>/<plugin>/<version>/`）里可能同时包含 `commands/`、`hooks/`、`skills/`、`agents/` 等同级组件目录。

commit `41bb6b7af`（`fix(plugins): include installed marketplace resources`）已经让 `skillsService` 和 `commandsService` **就地扫描**每个已安装插件包的 `skills/`、`commands/` 子目录，并在插件管理界面里按所属插件分组展示。

但 **`agents/` 目录没有被任何代码扫描**。结果：

- `subagentsService.list()` 返回的 `AgentsListResult.pluginAgents` 字段被**硬编码成 `[]`**（`subagentsService.ts:338`）。
- 插件管理界面的 "Agents" 分组永远是空的，即使插件包里带了 agent。

目标：让 `subagentsService.list()` 扫描已安装插件包的 `agents/` 目录，填充规范
`pluginAgents` 资源投影，并为运行时生成不会冲突的调用名称。

## 范围（已与用户对齐）

- **做**：发现（discovery）+ 插件管理界面展示 + 规范名称/唯一裸名称的运行时调用投影。
- **不做**：不物理拷贝文件到 `~/.zcode/agents`——采用就地扫描，卸载即消失，无重名/陈旧拷贝问题。

## 关键架构事实（探索结论）

- **UI 已就绪**，无需改动：
  - `PluginsSection.tsx:114` 已读取 `agentsResult.value.pluginAgents`。
  - `pluginManagedResourceGroups.ts:74-78` 已按「`agent.source === "plugin"` 且 `agent.path` 落在 `plugin.rootPath` 下」把 agent 归属到插件。
  - `InstalledPluginManagement.tsx:46,54` 已有 "agent" 分组的配色与 i18n key（`settings.plugins.detail.component.agent` = "Agents"，zh/en 均存在）。
- **契约已就绪**，无需改动：
  - `AgentSummary.source` 类型已是 `"user" | "plugin"`（`packages/shared/src/subagents-types.ts:3`）。
  - `AgentsListResult.pluginAgents` 字段已存在（同文件 `:28`）。
- **唯一缺口**：没有人扫描插件包的 `agents/` 目录并填充 `pluginAgents`。
- **项目风格是「各自复制」**：`skillsService` 与 `commandsService` 各自复制了一份完全相同的插件发现 helper（`PluginRootCandidate`、`readPluginConfigFromConfig`、`resolvePluginStorageRoot`、`scanOfficialPluginCacheRoots`、`readPluginManifest`/`findPluginManifestPath`、`parsePathList`、`resolveInside`、`DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`、`ZCODE_*_MARKETPLACE` 常量），**仅 `readInstalledPluginRoots`（`packages/services/src/plugins/installedPluginRoots.ts`）是共享模块**。Agent 照此办理：在 `subagentsService.ts` 内复制同一套发现逻辑，把组件目录从 `skills`/`commands` 换成 `agents`。
- `subagentsService.ts` 已有可复用的 agent 解析原语：`collectAgentMarkdownPaths(rootPath)`（支持 `<name>.md`、`<name>/agent.md`、`<name>/index.md` 三种布局）与 `readAgentFrontmatter(content)`（解析 name/description/color/model/tools/systemPrompt，兼容 CRLF 与中文冒号）。

## 方案

只改一个源文件 + 测试。

### 1. `packages/services/src/subagents/subagentsService.ts`

**(a) 复制插件发现 helper**（对齐 `skillsService.ts` / `commandsService.ts` 的私有实现）：

- `readCliConfigFile()`、`readPluginConfigFromConfig(config)` —— 读取 CLI 配置中的插件配置（`enabled`、`dirs`、`storageDir`、`enabledPlugins`）。
- `resolvePluginStorageRoot(storageDir)`、`resolveConfigPath(path)` —— 解析插件存储根。
- `scanOfficialPluginCacheRoots(pluginStorageRoot)` —— 扫描官方 marketplace cache 下的 `<plugin>/<version>` 目录。
- `readPluginManifest(rootPath)` / `findPluginManifestPath(rootPath)` —— 兼容 `.zcode-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json` 三种 manifest，按同一优先级回退；manifest 需读出 `name` 与 `agents` 字段。
- `parsePathList(value)`、`resolveInside(rootPath, rawPath)` —— 解析 manifest 的 `agents` 字段为路径列表，并防止目录逃逸（绝对路径或 `..` 越界返回 `null`）。
- `DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS`、`ZCODE_OFFICIAL_PLUGIN_MARKETPLACE`、`ZCODE_INLINE_PLUGIN_MARKETPLACE` 常量。
- 复用已有的共享模块 `readInstalledPluginRoots(pluginStorageRoot)`（读 `installed_plugins.json`）。

> 实现注意：这些 helper 在 skills/commands 里已存在两份，本次按项目既定风格复制第三份到 subagents，不顺带抽公共模块（避免无关重构）。`PluginManifestSummary` 在本文件内的形状为 `{ name: string; agents?: unknown }`。

**(b) 新增 `resolvePluginAgentRoots({ manifest, rootPath })`**（对齐 `resolvePluginSkillRoots`）：

- 把 `manifest.agents` 经 `parsePathList` + `resolveInside` 解析为根目录列表。
- 若未声明 `agents` 字段（`manifest.agents === undefined`）且默认目录 `<rootPath>/agents` 存在，则回退到该默认目录（与 skills 的 `<rootPath>/skills` 回退一致）。

**(c) 新增 `discoverPluginAgents()`**（对齐 `resolvePluginSkillRootDescriptors`）：

1. 读插件配置；`enabled === false` 直接返回 `[]`。
2. 组装候选插件根：inline（`config.dirs`）+ 官方 cache（`scanOfficialPluginCacheRoots`）+ 已安装（`readInstalledPluginRoots`）。
3. 对每个候选读 manifest，按 `<name>@<marketplace>` 去重；按 `config.enabledPlugins[pluginId] ?? (defaultEnabled || DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS.has(pluginId))` 判定启用，未启用跳过。
4. 对启用插件的每个 agent 根目录，复用 `collectAgentMarkdownPaths` + `readAgentFrontmatter` 解析出 `AgentSummary`：
   - `source: "plugin"`
   - `scope: "user"`
   - `path`: agent markdown 的真实绝对路径（UI 据此归属到插件 rootPath，**必须是落在插件根下的真实路径**）
   - `id`: `plugin:<插件名>:<agent名>`（与用户 agent 的 `user:<name>` 区分，避免 id 撞车）
   - `name` / `description` / `systemPrompt` / `color` / `model` / `tools`：取自 frontmatter
   - `enabled: true`
5. 单个 agent 读取失败时忽略该条（对齐用户 agent 的容错）。

**(d) 修改 `list()`**：

- 在现有 `discoverUserAgents(...)` 之后调用 `discoverPluginAgents()`。
- 规范名称始终进入 `agents` 与 `pluginAgents`；裸名称只在无冲突时进入 `agents`。
- `pluginAgents` 只返回一文件一条的规范资源，不能包含运行时裸名称别名。
- 用户、工作区和内置 agent 优先占用裸名称；冲突时保留插件规范名称并输出诊断。
- Settings > Subagents 合并非插件 `agents` 与规范 `pluginAgents`，避免别名重复显示。

### 2. `packages/services/test/subagentsService.test.ts`

参考 `packages/services/test/skillsService.test.ts` 的 fixture 写法（用临时 HOME、写 `installed_plugins.json`、写 `.zcode-plugin/plugin.json` 或 `.claude-plugin/plugin.json`）：

- **发现已安装插件的 agent**：造一个带 `agents/foo.md`（含 frontmatter）的已安装插件 + `installed_plugins.json`，断言 `list().pluginAgents` 含该 agent，且 `source === "plugin"`、`path` 指向该文件、`name`/`description` 来自 frontmatter。
- **资源/运行时投影分离**：断言 `list().agents` 同时包含规范名称和唯一裸名称，而
  `list().pluginAgents` 对同一文件只包含规范名称一条。
- **设置页不重复**：服务返回上述两种投影时，Settings > Subagents 只渲染规范插件资源一行。
- **未启用插件不产出**：插件在 `enabledPlugins` 中为 `false` 时，`pluginAgents` 不含其 agent。
- **manifest 显式声明 agents 路径**：manifest 写 `"agents": "custom-agents"`，断言扫描的是 `custom-agents/` 而非默认 `agents/`。
- **用户 agent 优先**：用户目录与插件包各有一个同名 agent，断言结果里该名字来自用户（`source === "user"`），插件同名被跳过。
- **默认目录回退**：manifest 不声明 `agents` 字段但存在 `agents/` 目录时能发现。

## 错误处理

- 配置缺失 / `installed_plugins.json` 不存在 / 不可读：复用已有 helper 的 `try/catch` 退路，返回空，不抛。
- 单个 agent markdown 读取或解析失败：忽略该条，不影响其它 agent。
- 目录逃逸（manifest 里的 `agents` 路径越界）：`resolveInside` 返回 `null`，该路径被丢弃。

## 不做的事（YAGNI）

- 不修改 agent 文件格式或 subagent 执行协议。
- 不改 i18n、不扩展 `AgentSummary` / `AgentsListResult` 契约。
- 不物理拷贝到 `~/.zcode/agents`。
- 不把插件发现 helper 抽成公共模块（保持与 skills/commands 同样的「各自复制」风格）。

## 验证

变更完成前运行 `npm run lint` 与 `npm test`（至少覆盖 `packages/services` 的 subagents 测试）。
