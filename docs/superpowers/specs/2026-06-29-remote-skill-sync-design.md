# SSH 远程 Skills 同步设计

## 背景

ZCode 的 skills 当前按运行时文件系统读取。本地 workspace 读取本机用户级与项目级 skills，SSH / Docker / WSL 远程 workspace 读取远端文件系统里的 skills。远程 workspace 可以使用 skills，但前提是远端机器上已经存在对应的 `SKILL.md` 目录。

现有 `SettingsSyncService` 解决的是同一运行时内“从外部 Agent 导入到 ZCode”的问题，不能把本机目录跨 SSH 写入远端。现有 remote 连接层内部有 `IRemoteBackend.upload()`，但 `RemoteConnection` 只对上层暴露 `services`，不应为了 skills 同步把通用上传能力直接暴露给 renderer。

## 目标

- 允许用户在已连接 SSH 远程 workspace 中，把本机用户级 skills 同步到该 SSH 主机的远端用户级 `~/.zcode/skills`。
- 本机可同步候选必须与本地用户级 skills 发现语义一致：包含 `~/.zcode/skills`，也包含兼容目录 `~/.agents/skills`；当 `.agents` 中的同名 skill 已被 `.zcode` 按目录名、skill name 或 `SKILL.md` 真实路径覆盖时只展示 `.zcode` 版本。候选发现需要递归支持分组目录，并跟随目录软链；同步到远端时写入普通目录内容，不在远端创建软链。
- 支持逐项选择和全选。
- 远端已存在同名 skill 时默认跳过，不覆盖。
- 同步完成后展示 synced / skipped / failed 结果，并刷新远端 skills 列表。
- UI 入口能明确表达当前动作目标是“此 SSH 主机”，避免用户误以为是全局设置。
- 保持 remote workspace 的 `workspaceIdentity` / `remoteSessionId` 路由边界，不把远端请求误落到本机服务。

## 非目标

- 首版不支持覆盖远端同名 skill。
- 首版不把技能同步入口放到 task 右键菜单；skills 同步是 host / workspace 级动作，不是 task 级动作。
- 首版不支持未连接 SSH 历史项的一键同步；历史项同步需要临时建立 SSH session，后续单独设计。
- 首版不同步 plugin-managed / system skills，也不把本机插件安装状态同步到远端。
- 首版不默认写入远端项目目录 `.zcode/skills`。
- 不新增通用远端文件写入 API。

## UI 设计

新增一个复用弹窗 `RemoteSkillSyncDialog`，所有入口打开同一弹窗。

入口按优先级分三类：

1. 远程 workspace header / overflow menu 的主入口：`同步 Skill`。左侧 workspace 行的 `...` 菜单也提供同名入口，方便用户从项目列表直接对当前 SSH workspace 操作。两个入口只有当前 workspace 是已连接 SSH remote 时显示。
2. `Settings > Skills` 的管理入口：`同步 Skill`。只有最近或当前 workspace 是已连接 SSH remote 时显示。该 section 顶部需要显示当前上下文，例如 `SSH user@host · /home/dev/project`，明确当前列表与同步目标属于远端上下文。
3. SSH 连接弹窗的辅助入口：仅在 SSH 已连接且进入选择远程目录 / 已连接阶段后显示 `同步 Skill`。不放在登录参数表单旁边。

`SettingsPage` 当前是“全局设置壳 + 部分 workspace-scoped section”的混合形态：`PluginsSection`、`CommandsSection`、`SubagentsSection` 已接收 `activeWorkspacePath` / `activeWorkspaceIdentity`，`SkillsSection` 也需要改为显式接收 `workspacePath`、`workspaceIdentity`、`remoteSessionId`、`remoteTarget`，避免在设置页内部隐式读取 tab store 造成上下文不清晰。

弹窗内容：

- 顶部显示目标 SSH 主机与远端用户级目标目录。
- 标题右侧显示一个紧凑的叹号风险提示图标，使用现有 tooltip 组件承载说明文案。提示需要说明：同步会迁移本地 Skills 到远程主机，但不能保证所有依赖数据和系统环境都可用；若因为远程系统环境、权限或依赖缺失导致 Skill 不可用，用户需要在远程服务器上手动安装或补齐依赖。该提示属于全局同步风险说明，不占用列表空间，也不影响目标行与筛选器在窄屏下换行。tooltip 不自动展示，仅在鼠标 hover 该图标时展示。
- 列表显示本机用户级 skills，每行包含名称、描述、来源路径、同步状态。描述默认收起为一行，展开 / 收起控件放在 skill 名称同一行并使用图标按钮；点击卡片主体区域切换勾选，点击 checkbox、名称 label 或展开按钮不触发行级重复切换。用户级候选来源与本地设置页里的“个人” skills 保持一致，不应只扫描 `~/.zcode/skills` 而漏掉 `~/.agents/skills`、分组目录或目录软链。
- 目标行右侧提供 `显示远端已存在` checkbox 作为过滤器，与目标主机信息同一行展示，窄屏自动换行；默认勾选以保持现有可见性。取消勾选后只隐藏 `remoteStatus.exists === true` 的 rows，不重新请求服务、不改变远端状态判定。若过滤后没有可见项，显示“当前仅有远端已存在的 Skills”空态，并提示可重新勾选查看。筛选前后弹窗保持同一高度，变化只发生在内部列表滚动区，避免因可见 rows 数量变化造成弹窗尺寸跳动。
- 提供单个 `全选` checkbox；未选 / 半选 / 全选分别对应没有选中、部分缺失项已选、所有远端缺失项已选。取消勾选该 checkbox 会清空当前选择。
- 默认勾选远端缺失的 skills，远端已存在的同名 skills 默认不勾选并标记为“已存在，将跳过”。过滤器隐藏已存在项时，底部计数和全选仍只以可同步的远端缺失项为准，隐藏项不能被同步。
- 提交按钮显示选中数量。
- 完成页展示 synced / skipped / failed 明细。

## 服务边界

新增受限的 skills 同步服务，而不是暴露通用文件写入：

- 本机侧能力：枚举可同步的本机用户级 skills，并为选中 skills 生成受限归档。枚举逻辑需要覆盖 `~/.zcode/skills` 与 `~/.agents/skills`，并复用本地用户级去重语义，包含分组目录与目录软链。
- 远端侧能力：接收归档，导入到远端 `~/.zcode/skills`，同名目录存在时跳过。

建议新增 `ISkillSyncService`，注册到本地 host 与远端 zcode-server services。renderer 通过现有 service 路由访问：

- 本机候选读取：使用 `useBaseWorkspaceServices()` 取得本机 base services。
- 远端状态与导入：使用当前 SSH workspace 的 remote services，依赖 `remoteSessionId` / `workspaceIdentity` 解析，不回退到本机服务。
- 桌面 renderer 合并 remote workspace services 时，`skillSyncService` 必须与 `skillsService` 一样覆盖为 remote service；否则设置页 / header 入口会把导入结果写回本机 `~/.zcode/skills`，但 UI 仍显示远端同步成功。
- 桌面 host 的 `init-remote` 直接暴露远端连接 services 时，也必须注册远端 `skillSyncService`；否则 renderer 请求 `skill-sync` channel 会在 host 侧等待注册并以 `Channel name 'skill-sync' timed out after 1000ms` 失败。
- 远端 `zcode-server.cjs` 版本号可能与本机一致但 bundle 内容仍是旧开发包；SSH 连接部署检查需要探测已部署 server bundle 是否包含 `skill-sync` channel，缺失时刷新主 server。

服务方法建议：

- `listSyncCandidates({ workspacePath?, workspaceIdentity? })`
  - 在本机调用时列出本机用户级 skills。
  - 在远端调用时可用于查询远端 `~/.zcode/skills` 的同名存在状态。
- `exportSkills({ skillIds })`
  - 返回带 manifest 的 tar.gz 二进制归档。
  - 只允许导出已发现的用户级 skill 目录。
- `importSkillsArchive({ archive, overwrite: false })`
  - 解包到远端用户级 `~/.zcode/skills`。
  - `overwrite` 首版固定为 `false`。
  - 返回每个 skill 的 synced / skipped / failed 结果。

归档导入必须做路径安全校验：

- 拒绝绝对路径、`..` 路径穿越、反斜杠路径、软链、特殊设备文件。
- 只允许写入目标根目录下的 skill 子目录。
- 每个 skill 必须包含 `SKILL.md`。
- 本机目录软链只在导出入口解引用为普通目录内容；归档内部仍不允许包含软链或特殊文件。

## 数据流

1. 用户从 SSH workspace header、Settings Skills 或 SSH 连接弹窗打开同步弹窗。
2. 弹窗通过 base services 获取本机候选 skills。
3. 弹窗通过 remote services 获取远端已有 skill 名称。
4. UI 默认勾选远端缺失项，用户可手动调整或全选缺失项。
5. 提交时本机 service 生成归档，远端 service 导入归档。
6. 远端 service 按 skill name / 目录名判断冲突，同名存在则跳过。
7. UI 展示结果，刷新远端 `ISkillsService.list()`，并触发远端 draft session 的 skill context invalidation。

## 远程与本地兼容

- 本地 workspace 不显示远端同步入口。
- SSH remote workspace 显示入口。
- Docker / WSL remote workspace 首版不显示入口，避免把“SSH 主机同步”语义扩展到不同传输目标。
- Web 手机远控不新增独立 remote runtime。若手机端进入同一个 remote workspace host，remote services 仍应沿用 shared-host attachment；同步入口首版可只在桌面端显示。
- 所有 workspace 级状态查找使用 `workspaceIdentity?.trim() || workspacePath`，路径读写仍使用实际 `workspacePath`。

## 错误处理

- 远端断连：弹窗显示连接已断开，并禁止提交。
- 无本机用户级 skills：显示空状态，不展示提交按钮。
- 部分失败：保留成功结果，失败项展示错误原因，允许用户重新打开弹窗后重试。
- 归档过大：服务端返回明确错误。首版实现应设置单次同步大小上限，避免通过 RPC 传输过大目录。
- 权限不足：远端 service 返回无法创建或写入 `~/.zcode/skills` 的错误，并提示用户检查远端用户权限。

## 测试与验证

- 单元测试：
  - 本机候选列表包含 `~/.zcode/skills` 与 `~/.agents/skills` 的用户级 skills，并排除 plugin / system skills。
  - `.agents/skills` 中已被 `.zcode/skills` 按目录名、skill name 或 `SKILL.md` 真实路径覆盖的候选不重复出现。
  - 分组目录下的用户级 skill 可同步到远端相同相对目录。
  - 本机目录软链形式的用户级 skill 可同步为远端普通目录。
  - 导出归档只包含选中 user skills。
  - 导入时同名 skill 跳过，不覆盖原目录。
  - 导入拒绝路径穿越、绝对路径、软链和缺失 `SKILL.md` 的归档。
- UI 测试：
  - 本地 workspace 不显示同步入口。
  - SSH remote workspace header 显示同步入口。
  - `Settings > Skills` 在 SSH remote context 下显示上下文和同步按钮。
  - 弹窗支持逐项选择、全选缺失项、完成结果展示。
- 集成验证：
  - 在 SSH remote workspace 中同步一个本机 skill 后，远端 `ISkillsService.list()` 能看到该 skill。
  - 已存在同名远端 skill 被跳过。
  - 同步后新建或恢复 draft session 时可看到刷新后的 skills context。
- 仓库必跑：
  - `pnpm typecheck`
  - `pnpm lint`

## 风险

- RPC 二进制传输适合小到中等 skill 目录。若用户 skill 包含大资产，首版大小上限会阻止同步，后续可改为 host 临时文件 + backend upload。
- Settings 页混合全局与 workspace scoped section，必须在 UI 上明确当前 remote context，否则用户容易误解同步目标。
- skill name 与目录名冲突策略需要保持稳定。首版以远端目标目录是否存在作为跳过依据，结果中展示实际目录名。
