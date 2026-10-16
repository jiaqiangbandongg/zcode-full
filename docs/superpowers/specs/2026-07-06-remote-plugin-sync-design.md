# SSH 远端 Plugin 同步设计

## 修订记录

- 2026-07-06：V1 支持用户级 inline plugin，通过 archive 复制目录到 SSH 远端。
- 2026-07-07：补充已安装 marketplace plugin 同步。该能力通过远端重装同名 marketplace plugin 实现，不复制 cache，不做隐式 fallback。
- 2026-07-07：明确 builtin plugin 不做手动同步。远端应通过 ZCode Agent resource 原生携带官方插件资产；远端资源包构建与部署校验必须覆盖 `packages/*-plugin`。
- 2026-07-08：补充本地 `file` / `directory` / `settings` marketplace source 的 SSH 同步方案。该能力镜像 marketplace source 到远端后仍由远端执行 marketplace install，不复制本机 cache。
- 2026-07-08：补充同步过程可视化 UX：同步期间保留插件 card，逐项展示进度、hover 日志和单项 stop；stop 会先让 UI 停止等待当前插件并继续后续插件，若当前步骤是带 operationId 的 marketplace add/install，则进一步向远端发协议级取消请求。
- 2026-07-08：补充协议级单项取消：远程同步弹窗为 marketplace add/install 生成一次性 operationId，stop 时只取消该 operationId 对应的远端 plugin 管理操作；未传 operationId 的本地插件设置页安装、市场添加和其它 ZCode Protocol 请求保持原行为。
- 2026-07-08：补充 `plugins.options` 的安全子集同步：只同步本机已显式配置、非敏感、非 file/directory 且远端 schema 兼容的 primitive options；写入远端前与远端已有 options merge，不做全量覆盖。
- 2026-07-10：补充 builtin plugin 远端资源归档的跨平台权限约束：本地下载上传和开发态上传生成 tar 时，目录条目统一使用 POSIX `0755`，不得透传 Windows `stat.mode` 中缺少执行位的伪 POSIX 权限；检测到旧 builtin 资产不可达时，部署需先恢复产品目录的 owner `rwX`，再执行替换。
- 2026-07-09：补充 `browser` 官方插件资产边界：它是默认启用的内容型官方插件，但除 `skills` 外还携带 `docs/` runtime 文档资源，远端/桌面打包白名单必须一并覆盖。
- 2026-07-23：统一远程同步入口中的技术名词大小写：中文使用 `同步 Skill` / `同步 MCP` / `同步 Plugin`，英文使用 `Sync Skill` / `Sync MCP` / `Sync Plugin`。

## 背景

当前 SSH 远端已经支持用户级 Skill 和用户级 MCP 同步。Skill 同步复制本机用户 skill 目录到远端 `~/.zcode/skills`，MCP 同步把本机用户 MCP 配置导入远端 `~/.zcode/cli/config.json`。两者都遵循显式、单向、不覆盖的同步模型。

Plugin 比 Skill/MCP 更复杂：它不是单一资源，而是插件目录、`plugins.dirs`、enabled/options、marketplace cache、installed records、builtin suppression、plugin data、skills/commands/hooks/MCP 运行时投影的组合。因此 SSH 同步必须分类型处理，避免把本机运行状态误当作可移植配置。

## 当前支持范围

### 用户级 inline plugin

- 来源：本机用户级 `~/.zcode/cli/config.json` 中 `plugins.dirs` 指向的 inline plugin。
- manifest：支持 `.zcode-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.codex-plugin/plugin.json`。
- plugin id：统一按 `<manifest.name>@inline` 生成。
- 同步方式：本机 `pluginSyncService` 导出 archive，SSH 远端 `pluginSyncService` 导入到 `~/.zcode/plugins/<plugin-dir>`。
- 配置写入：导入成功后把远端绝对路径追加到远端 `~/.zcode/cli/config.json` 的 `plugins.dirs`。
- enabled 状态：如果本机 `plugins.enabledPlugins[pluginId]` 是 boolean，则同步到远端用户配置。
- options 状态：如果本机存在 `plugins.options[pluginId]`，只同步 manifest `userConfig` 中声明的非 sensitive、非 `file` / `directory` primitive 配置；远端导入后重新读取远端 plugin schema，只有远端同 key、同类型兼容时才通过 `plugins/configure` 写入，并与远端已有 options merge。
- 冲突策略：远端已有同 plugin id 或目标目录已存在时跳过，不覆盖。
- components 展示：根据 manifest 或目录识别 `skills`、`commands`、`hooks`、`mcp`。

### 已安装 marketplace plugin

- 来源：本机 Agent 返回的 `getPluginsOverview().installedPlugins`，即已经安装并有 installed record 的 marketplace plugin。
- plugin id：使用已安装记录中的 `<plugin-name>@<marketplace>`。
- scope：支持 `user` 和 `workspace` scope，远端安装时沿用本机 scope。
- 同步方式：不复制本机 cache；在远端调用 `installPlugin({ marketplace, pluginName, scope })`，由远端 marketplace resolver 重新安装同名 plugin。
- marketplace source：如果远端缺少同名 marketplace，且本机 marketplace source 可序列化为 `github`、`git` 或 `url`，先在远端调用 `addPluginMarketplace`，再安装 plugin。
- 本地 marketplace source：如果远端缺少同名 marketplace，且本机 marketplace source 是 `file`、`directory` 或可完整导出的 `settings`，先把选中 plugin 及同 marketplace 依赖闭包需要的 source mirror 到远端 `~/.zcode/plugins/marketplace-sources/<marketplace-id>-<hash>`，再用该远端目录调用 `addPluginMarketplace`，最后执行安装。
- enabled 状态：远端安装成功后调用 `setPluginEnabled`，对齐本机 enabled 状态。
- options 状态：远端安装成功后重新读取远端 plugin schema，按与 inline 相同的安全子集规则同步 `plugins.options[pluginId]`；不传 sensitive、路径类或远端 schema 不兼容的 key。
- 冲突策略：远端已存在同 plugin id 时认为已安装，不重复安装、不覆盖、不升级。

### builtin / official plugin

- 来源：ZCode 随包内置的 official plugin，当前包括 `android-emulator`、`browser`、`document-skills`、`ios-simulator`、`restore-legacy-sessions`、`skill-creator`、`zcode-guide`。
- plugin id：统一为 `<name>@zcode-plugins-official`。
- 同步策略：不通过插件同步弹窗手动复制。builtin plugin 是产品原生能力，SSH 远端必须随远端 ZCode Agent resource 部署。
- 远端资源布局：`glm/<platform>/packages/<plugin-package>` 打进远端资源包，部署到 `~/.zcode/server/agents/glm/packages/<plugin-package>`。
- seed 过程：远端 agent 启动时复用现有 official plugin filesystem seed，把这些资源物化到远端 `~/.zcode/plugins/cache/zcode-plugins-official/<name>/<version>`。
- 资源白名单：官方插件的 `.zcode-plugin`、`skills`、`commands`、`hooks`、`.mcp.json` 和 `docs` 都属于可 seed 资源。`browser` 没有 MCP runtime，但 `runtimeFeatures.browserDocumentationRoot` 指向 `docs/`，缺失时 `agent.browsers.documentation()` 会退化。
- 部署校验：远端已有 `zcode.cjs` 和 wrapper 但缺 `packages/*-plugin/.zcode-plugin/plugin.json` 时，不能跳过 ZCode Agent 部署，必须刷新 `glm` 组件并补齐 packages。
- 归档权限：本地下载上传和开发态上传会在桌面侧重新生成 tar；目录条目必须使用跨平台稳定的 `0755`，不能直接使用本地 `stat.mode`。Windows 只实现有限的读写权限语义，直接透传会把目录写成不含执行位的 mode，远端解包后无法遍历或删除。
- 损坏迁移：旧版本已经生成的 `0644` packages 会让新版本在解包前的 `rm -rf` 继续失败。部署检测到 builtin manifest 不可达且 packages 根存在时，必须先对该产品自有目录执行 owner `rwX` 修复，再刷新资源；不得递归修改用户 plugin 目录。
- 手动同步边界：不新增“手动同步 builtin plugin”入口，避免把 builtin 误导入为 inline plugin 或让每台远端都依赖用户手动修复。

### 同步后的运行时投影刷新

- plugin 同步完成后刷新远端 plugin management store，确保设置页立即看到最新安装状态。
- 刷新远端 workspace 的 shared skill store，并 invalidate deferred draft session，确保 `$` 技能列表和后续会话准备能看到新 plugin skills。
- 直接调用远端 `commandsService.list` 并写回当前远端 workspace 的 `zcodeSessionStore.slashCommands`，确保输入框 `/` 菜单不依赖切换会话或打开命令设置页才能看到新 plugin commands。
- 重新加载远端 MCP store 的用户目录来源，确保 plugin 贡献的 MCP 相关状态在 UI 中刷新。

## 数据流

```text
inline:
本机 base pluginSyncService
  -> listLocalUserPluginCandidates()
  -> exportPluginsArchive(pluginIds)
  -> SSH remote pluginSyncService.importPluginsArchive(archive)
  -> 远端 ~/.zcode/plugins/<plugin-dir>
  -> 远端 ~/.zcode/cli/config.json plugins.dirs / enabledPlugins

marketplace installed:
本机 base zcodeAgentService
  -> getPluginsOverview() / listPlugins()
  -> 已安装 marketplace candidates
远端 zcodeAgentService
  -> getPluginsOverview()
  -> addPluginMarketplace(source)    # 仅 github/git/url 且远端缺 marketplace 时
  -> pluginSyncService export/import source archive
  -> addPluginMarketplace(remote mirrored source dir) # file/directory/settings 且远端缺 marketplace 时
  -> installPlugin(marketplace, pluginName, scope)
  -> setPluginEnabled(pluginId, enabled)
  -> listPlugins()
  -> configurePlugin(pluginId, merged portable options)

builtin official:
远端 resource build
  -> glm/<platform>/zcode.cjs
  -> glm/<platform>/packages/*-plugin
SSH deploy
  -> ~/.zcode/server/agents/glm/zcode.cjs
  -> ~/.zcode/server/agents/glm/packages/*-plugin
远端 agent 启动
  -> filesystem seed
  -> ~/.zcode/plugins/cache/zcode-plugins-official/<name>/<version>
```

UI 始终用 base services 做本机枚举和导出，用当前 workspace services 做远端状态检查和导入。远端 workspace 的 service collection 必须把 `pluginSyncService` 和 `zcodeAgentService` 透传为远端服务，避免导入或安装写回本机。

## 安全与冲突策略

- archive 路径必须是安全相对路径，禁止绝对路径、`..`、反斜杠、Windows drive、空路径。
- archive 只接受目录和普通文件，拒绝 symlink、device、socket 等特殊文件。
- 导入前和导入后都校验插件目录内存在合法 manifest。
- inline 候选目录名从 plugin 根目录 basename 规范化得到；冲突时跳过，不改远端已有目录。
- inline 远端判重同时检查目标目录、远端 `plugins.dirs` 里已注册的 inline plugin id。
- marketplace 远端判重按 installed plugin id；同 id 已存在时不重装。
- archive 设大小上限，避免把远端 host 内存或磁盘撑爆。
- marketplace 同步依赖远端网络、远端 marketplace source 和远端 resolver。失败时暴露错误，不从本机 cache 隐式 fallback。
- `plugins.options` 只同步本机已保存的 portable primitive 值，不把 manifest default 当作用户配置同步；写入时用远端现有 configuredOptions 做 merge，避免 `plugins/configure` 的替换语义删掉远端已有 key。
- `sensitive`、`file`、`directory` options 默认不自动同步。它们需要 credential store 或路径映射能力，当前只在 UI 中提示需要远端手动配置。
- 本地 marketplace source mirror 只包含选中 plugin 和同 marketplace 依赖闭包需要的 source 目录；拒绝 symlink、绝对 archive path、`..`、Windows drive 和特殊文件。
- `settings` source 只有在 manifest entry 是网络 source，或 entry 明确指向可读取的本地 directory source 时才能 mirror；无法从 synthetic manifest 还原 source root 的相对路径不做 cache fallback。
- 远端已有同名 marketplace 时不替换 source；后续由独立 reconcile 流程处理 source hash / manifest hash 差异。

## 当前不支持或不保证的边界

| 边界 | 当前状态 | 例子 | 是否应该支持 | 后续实现方向 |
| --- | --- | --- | --- | --- |
| marketplace cache fallback / 直接复制 `installed_plugins.json` | 未实现，且当前设计刻意不做 | 本机 `canva@claude-plugins-official` cache 里有已下载代码，但远端网络不可用。当前会安装失败，不会把本机 cache 打包过去 | 默认不应该支持。cache 可能包含本机生成物、绝对路径、旧 resolver 产物或平台相关文件，复制后不一定等价于远端安装 | 如确实需要离线模式，做显式“离线镜像同步”：用户选择后才复制 cache，校验 manifest/source/sha/版本，写远端 installed record，并标明不等价于 marketplace reinstall |
| `plugins.options` 全量同步 | 已支持安全子集；不支持 sensitive、`file`、`directory`、远端 schema 缺失/不兼容的 key，也不把 default 当作用户配置同步 | 本机 `region="cn"` 会同步；`token` 标记 sensitive 或 `workspaceDir="/Users/dev/project"` 不会自动同步 | 需要继续支持路径映射和 credential store，但不能默认全量复制 | 后续增加 options diff 详情、路径映射确认和 credential store 写入；当前只做非敏感 primitive merge |
| plugin `data/` | 未实现 | 插件在本机 `data/` 里保存索引、session cache、token、临时文件；远端运行时应该重新生成 | 大多数场景不应该支持 | 仅给有明确迁移语义的插件提供 opt-in 数据迁移；由插件声明可迁移文件和版本，主程序只负责执行受控导入 |
| builtin / restorable builtin / suppressed builtin 状态 | 资产随远端 resource 原生部署；用户状态同步未实现 | 本机禁用了 `android-emulator@zcode-plugins-official`，但远端是 Linux，没有同样的 iOS/Android 运行环境；同步禁用状态可能隐藏远端可用工具 | 资产必须支持；启停/suppressed 状态可选支持，不应混入普通 plugin 同步 | 当前先修远端资源包构建与部署校验。后续如要同步状态，单独做“内置插件启停状态同步”；只在远端存在同 id、同来源且兼容时写 enabled/suppressed 状态 |
| 未安装 marketplace 候选 plugin | 未实现 | Discover 页能看到 `formatter@team-market`，但本机没有安装。当前同步弹窗不会把它列为候选 | 通常不需要。同步语义是“把本机已使用的 plugin 带到远端”，不是批量安装市场候选 | 若要支持，应做 marketplace source 同步或远端 Discover 安装入口，而不是放进“本地 plugin 同步” |
| marketplace 版本完全一致 | 实现不完整，只保证同 marketplace + 同 plugin name 安装成功并返回同 plugin id | 本机是 `demo@team-market` 1.0.0；远端 marketplace 已更新到 1.1.0。当前远端可能装到 1.1.0 | 需要支持，尤其是复现实验环境时 | 协议增加 version/source lock/sha 参数；本机候选携带 installed record 的 source/sha；远端按 lock 安装，安装后校验 version/source/sha，不一致则失败 |
| `file` / `directory` / `settings` marketplace source 自动带到远端 | 已支持 source mirror；不保证替换远端已有同名 marketplace，也不保证所有 synthetic `settings` source 都能还原本地 source root | 本机 marketplace 指向 `/Users/dev/plugins/marketplace.json`；远端没有这个路径。同步时把所选 plugin 的 source mirror 到远端，再让远端 install | 需要支持，但不能猜远端路径 | 已采用显式 source mirror：只打包所选 plugin 和同 marketplace 依赖闭包；远端已有同名 marketplace 时不替换，`settings` 中无法定位 source root 的本地相对 source 仍失败，不从 cache fallback |
| 跨 marketplace dependency 的 source mirror | 未实现 | `hello-world@hello-market` 依赖 `shared@base-market`；当前只会 mirror `hello-market` 内的依赖闭包，遇到跨市场依赖会失败 | 需要支持，但要单独设计多个 marketplace 的同步顺序和冲突策略 | 扩展 source mirror 计划，递归枚举依赖 marketplace，逐个检查远端是否已有、是否需要 mirror，并在 UI 展示将同步的 marketplace 列表 |
| stop 的全链路强制中止 | 不保证；当前只对带 operationId 的 marketplace add/install 做协议级取消，inline archive export/import 和 `setPluginEnabled` 不是强制 abort | 用户在 git clone 很慢时点 stop，若远端 agent 已进入 cancellable add/install，会发送 `plugins/cancelOperation`；如果当前步骤是本地导出或远端写 enabled，则只能尽快停止等待/跳过后续等待 | 需要保持当前粒度，避免影响本地插件设置页和普通 plugin 管理 RPC | 后续如要增强，给 plugin sync service 的 archive export/import 也加 operationId/AbortSignal；但必须保证仅远程同步入口传入 operationId |
| hover 同步日志等价于远端 shell/stdout 日志 | 不保证；当前日志展示同步步骤、RPC 方法、operationId、错误诊断和 stop/cancel 结果，不保证透出 resolver 内部 git/fetch/copy 的完整 stdout/stderr | 用户看到 `RPC plugins/install code-review@claude-plugins-official (...)`，但看不到 agent 内部实际执行的完整 `git clone` stdout | 应该支持更完整的诊断，但不能把高频底层日志默认刷进 UI | 后续可给 plugin protocol 增加 operation progress event；只在用户打开日志时订阅或限流展示，避免生产日志和 UI 状态过载 |
| 远端已有同 id plugin 的更新/覆盖 | 未实现，当前按已存在跳过 | 本机 `canva@claude-plugins-official` 是 1.0.0，远端已有 0.9.0。当前不会自动升级 | 应该支持为后续独立模式 | 增加 compare/reconcile 模式：展示版本、source、enabled 差异；用户选择跳过、重装、升级或覆盖 |

## 后续结论摘要

当前已经实现的是“把本机已经能用的 plugin 显式带到 SSH 远端”：inline plugin 通过目录 archive 复制，已安装 marketplace plugin 通过远端重装同名插件实现。这两条路径都只处理远端缺失项，默认不覆盖远端已有插件。

需要继续补齐但不能简单全量复制的是 `plugins.options` 的路径/secret 子集、marketplace 版本锁定、跨 marketplace dependency、远端已有插件/marketplace 的差异处理，以及更完整的远端操作日志。它们不是完全没价值，而是当前实现还不够完整：直接同步会遇到 secret 泄露、本机路径不可用、远端安装版本漂移、跨市场 source 顺序不明确、日志过载或覆盖远端已有状态的问题，所以后续应该做成可预览、可选择、可校验的 reconcile / progress 流程。

默认不建议支持的是隐式 cache fallback、直接复制 `installed_plugins.json` 和普通 plugin `data/`。这些内容看起来能让远端“离线可用”，但不保证等价于远端重装：cache 可能带有本机生成物、平台差异、旧 resolver 产物或绝对路径，`data/` 还可能包含 token、索引和临时状态。若未来确实需要离线能力，应作为单独的“离线镜像同步”模式显式暴露，并在 UI 中说明它不等价于 marketplace reinstall。

不应混入当前 plugin 同步主流程的是未安装 marketplace 候选和 builtin/suppressed builtin 状态。未安装候选更像远端 Discover 安装或 marketplace source 同步；builtin 状态则和远端操作系统、内置插件可用性相关，应单独做兼容性判断后再同步启停状态。

对于 builtin plugin，最新结论是：资产缺失属于远端资源包构建/部署问题，不属于用户手动同步问题。远端理论上应原生支持 builtin plugin；如果远端插件页显示 0 个内置插件，根因应优先检查 `~/.zcode/server/agents/glm/packages/*-plugin` 是否随 `zcode.cjs` 一起部署。手动同步 builtin 会把产品原生能力变成用户补救步骤，还容易把官方插件误导入成 inline 插件，因此当前不做。

## UI 行为

- 只在 SSH remote workspace 暴露 plugin 同步入口；WSL/Docker/本地不新增入口。
- 插件设置页和 Skill/MCP 设置页保持同一类 SSH 目标提示条、右上角同步入口和弹窗样式。
- workspace 菜单、任务菜单与设置页中的远程同步入口统一使用 `Skill`、`MCP`、`Plugin` 的首字母大写技术名词，不因入口位置或语言不同退回小写。
- 弹窗展示本机可同步的 inline plugin 和已安装 marketplace plugin、来源路径、版本、components、远端是否已存在。
- 弹窗对已配置 options 显示概要：会尝试自动同步的本地 portable primitive 配置数量，以及因 sensitive、路径类型或本地 schema 缺失需要远端手动配置的数量；远端 schema 缺失或不兼容在同步日志中提示并跳过。
- 弹窗默认展示远端已存在项，方便确认远端状态；默认只勾选远端缺失项，远端已存在项不可选、不重装。
- 展示 hooks/MCP 风险提醒：同步后 plugin 内的 hooks/MCP 会在 SSH 主机环境执行。
- 点击“同步已选项”后不再切换成单独的全局 loading 卡片；弹窗保留本次选中的 plugin card，并在对应 card 右侧展示 queued / syncing / synced / failed / stopped 状态。
- 当前正在同步的 card 内展示 loading 状态；loading 图标打开可滚动日志浮层，展示该 plugin 的同步步骤日志，包括导出、导入、添加 marketplace、安装、写 enabled 状态、operationId、失败或停止原因；该日志不是远端 resolver 内部 shell/stdout 的完整转发。
- 同步过程中每个未完成 plugin 都有单项 stop 按钮。点击 stop 后该 plugin 标记为 stopped，结果页记录“已停止”，同步队列继续处理后续 plugin。
- 对 marketplace add/install，stop 会额外调用远端 `cancelPluginOperation(operationId)`。Agent server 收到后 abort 对应 operation 的 `AbortSignal`，adapter 需要把 signal 传给 git clone / fetch / 本地复制等可取消步骤。取消失败或远端版本不支持取消时，UI 仍按 stopped 继续后续 plugin，并在日志中记录降级原因。
- stop 不取消未传 operationId 的普通插件管理操作，也不强制 abort inline archive export/import 或 `setPluginEnabled`；不影响本地 workspace 插件设置页原有 install / add marketplace / update 流程。
- 同步成功后如存在可同步 options，调用远端 `plugins/configure` 写入 merge 后的 options；该步骤只对远程同步入口生效，不改变本地插件设置页的保存语义。
- 同步完成后刷新远端 plugin store、shared skill store、commands store、当前 workspace 的 slashCommands，以及 MCP store 相关状态。

## 状态边界

- 本机 inline 服务只读本机用户配置和 plugin 目录，不修改本机 config/cache/data。
- 远端 inline 导入只写远端用户 plugin 根和远端用户 config。
- marketplace 同步只通过远端 Agent plugin 协议安装，不直接写远端 marketplace cache 或 `installed_plugins.json`。对本地 `file` / `directory` / `settings` marketplace source，只写远端 source mirror 目录，再通过远端 `addPluginMarketplace` 和 `installPlugin` 完成安装。
- builtin plugin 资产由远端 resource 构建与部署负责，不由 plugin sync service 写入远端用户 plugin 目录。
- identity/isolation 继续遵守 `workspaceIdentity?.trim() || workspacePath`；执行路径仍使用 `workspacePath`。
- desktop continuous 与 mobile replayable 不因该功能改变。手机 `/remote` 仍通过 shared-host attachment 使用已有远端 host service，不创建独立 runtime。

## 接受用例

| ID | 场景 | 断言 |
| --- | --- | --- |
| RPS-INLINE-01 | 本机 `plugins.dirs` 有合法 inline plugin，远端缺失 | 导入到远端 `~/.zcode/plugins/<dir>`，远端 config 追加路径 |
| RPS-INLINE-02 | 远端已有同 inline plugin id | 返回 skipped，不覆盖目录，不重复写 config |
| RPS-INLINE-03 | 远端目标目录存在 | 返回 skipped，不覆盖目录 |
| RPS-INLINE-04 | 本机 inline plugin 含 symlink | 导出失败，避免把任意宿主路径打包进远端 |
| RPS-INLINE-05 | 本机 inline plugin 有 boolean enabled override | 远端 config 同步同一 enabled 状态 |
| RPS-MKT-01 | 本机已安装 marketplace plugin，远端缺失且 marketplace 已存在 | 远端调用 `installPlugin` 安装同名 plugin，并调用 `setPluginEnabled` |
| RPS-MKT-02 | 本机已安装 marketplace plugin，远端缺 marketplace，source 是 `github`/`git`/`url` | 远端先 `addPluginMarketplace`，再安装 plugin |
| RPS-MKT-03 | 远端已有同 marketplace plugin id | 候选显示为已存在，不默认选中，不重装 |
| RPS-MKT-04 | 远端 marketplace 安装失败 | 候选结果显示 failed 和远端 install diagnostics，不复制本机 cache fallback |
| RPS-MKT-05 | 本机 marketplace plugin enabled=false | 远端安装成功后写入同一 disabled 状态 |
| RPS-MKT-06 | 本机已安装 marketplace plugin，远端缺 marketplace，source 是 `directory` 且插件 source 是本地目录 | 本机导出选中 plugin 和同 marketplace 依赖 source，远端导入 source mirror，用远端目录 add marketplace 后安装 |
| RPS-MKT-07 | 本机 marketplace source 是 `file` | 同步 marketplace JSON 及其相对 plugin source 目录，远端 install 不依赖本机路径 |
| RPS-MKT-08 | 本机 marketplace source 是 `settings` 且 entry 是网络 source | 导出规范化 marketplace JSON，远端通过该 JSON add marketplace 后安装 |
| RPS-MKT-09 | 本机 marketplace source 是 `settings` 但 entry 是无法定位的本地相对 source | 同步该 plugin 失败并显示 source root 无法还原，不复制 cache fallback |
| RPS-OPT-01 | 本机 plugin 保存了非敏感 primitive options | 远端 plugin 导入/安装成功后，读取远端 schema，merge 远端已有 options，再调用 `plugins/configure` 写入这些 key |
| RPS-OPT-02 | 本机 plugin 保存了 sensitive、file 或 directory options | 默认不自动同步这些 key，结果日志提示需要远端手动配置 |
| RPS-OPT-03 | 远端 plugin schema 缺少同名 option 或类型不兼容 | 不写该 key，避免把本机旧 schema 的配置塞进远端 config |
| RPS-OPT-04 | 远端已有其它 options | 同步本机 portable key 时保留远端已有 key，不因 `plugins/configure` 的替换语义删除远端配置 |
| RPS-UX-01 | 同步多个 plugin，其中一个远端安装很慢 | 弹窗保留 plugin 列表，只有当前 plugin card 显示 loading，hover loading 可看到该项同步日志 |
| RPS-UX-02 | 同步过程中点击某个 plugin 的 stop | 该 plugin 结果变为 stopped，队列继续后续 plugin；若当前步骤是 marketplace add/install，则发送对应 operationId 的远端取消请求 |
| RPS-UX-03 | 同步完成页展示失败项 | 右侧结果状态使用紧凑状态徽标，不使用高窄按钮状容器 |
| RPS-UX-04 | 同步日志较长 | 日志浮层可滚动，不使用非交互 tooltip 承载长日志 |
| RPS-BUILTIN-01 | 生产远端资源包构建 | `glm/<platform>` 同时包含 `zcode.cjs` 和 `packages/*-plugin/.zcode-plugin/plugin.json` |
| RPS-BUILTIN-02 | 远端已有同版本 `zcode.cjs` 但缺 builtin packages | 部署不能跳过 ZCode Agent；必须补齐 `~/.zcode/server/agents/glm/packages/*-plugin` |
| RPS-BUILTIN-03 | 开发态 SSH 部署本地 `zcode.cjs` | 同步上传本地官方插件 packages，远端 `plugins list` 能发现 `source:"official"` 插件 |
| RPS-BUILTIN-04 | Windows / macOS / Linux 桌面侧为 SSH 本地上传重打 builtin packages tar | tar 中所有目录条目均为 `0755`；远端解包后 `rm -rf ~/.zcode/server/agents/glm/packages` 可正常更新资源 |
| RPS-BUILTIN-05 | 远端遗留不可遍历的 `~/.zcode/server/agents/glm/packages`，builtin manifest 检查失败 | 部署先执行 owner `rwX` 修复，再进入正常 packages 刷新，用户无需手工 chmod |

## 测试计划

- `packages/services/test/pluginSyncService.test.ts` 覆盖 inline 候选枚举、导出导入、冲突跳过、安全路径和 enabled 状态。
- `packages/services/test/pluginSyncService.test.ts` 覆盖 marketplace source archive 的 `directory`、`file`、`settings` 导出导入、本地依赖闭包、无法还原 source root 的失败路径。
- `packages/ui/test/remotePluginSyncDialog.test.ts` 覆盖 inline/marketplace 行构造、默认选择、远端已存在过滤、marketplace source 序列化和结果渲染。
- `packages/ui/test/remotePluginSyncDialog.test.ts` 覆盖非网络 marketplace source 缺失时先 source mirror、再 `addPluginMarketplace(remotePath)`、再安装。
- `packages/ui/test/remotePluginSyncDialog.test.ts` 覆盖逐项同步进度、单项 stop 后继续后续 plugin、stopped 结果和同步日志事件。
- `packages/ui/test/remotePluginSyncDialog.test.ts` 覆盖 options 安全子集同步、schema 不兼容跳过、与远端已有 options merge。
- `packages/ui/test/remotePluginSyncRefresh.test.ts` 覆盖同步后即使命令设置页未加载，也会刷新当前远端 workspace 的 `slashCommands`。
- `packages/ui/test/remoteSyncActions.test.ts` 覆盖 SSH-only plugin 同步入口和 dialog 注入。
- `packages/desktop/test/*remote*Services.test.ts` 覆盖 remote service collection 使用远端 `pluginSyncService` 和远端 Agent plugin 协议。
- `packages/server/test/remoteDeploy.test.ts` 覆盖 remote bundle marker 包含 `plugin-sync`。
- `packages/server/test/remoteDeploy.test.ts` 覆盖 ZCode Agent 部署安装 builtin `packages` 目录，以及远端缺 builtin packages 时不会跳过部署。
- `packages/desktop/test/runtime-asset-scripts.test.ts` 覆盖 remote asset 构建脚本把 official plugin packages stage 到 `glm/<platform>/packages`。
- 手工验证：SSH 到 macOS/Linux 远端，分别同步 inline plugin、Claude 官方 marketplace plugin、自定义 github/git/url marketplace plugin，检查远端 `installed_plugins.json`、`config.json.plugins.enabledPlugins` 和 plugin cache。
