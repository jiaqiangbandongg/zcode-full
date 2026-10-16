# 插件创建入口与 Plugin Creator

## 产品合同

2026-09-16：插件市场、插件管理 User 视图共用“添加”菜单，只有“创建插件”和“添加插件市场”两项；不提供录制技能。Workspace 配置视图不出现市场写入入口，空态“浏览插件”保持原行为。

创建插件只打开新任务草稿，预填官方 `plugin-creator@zcode-plugins-official` 所提供的 `plugin-creator` Skill canonical 引用和一个尾空格。不自动发送，不切换模型，不安装或启用插件。使用标准 Root 新任务编排及其草稿持久化。

```text
点击创建 -> 解析 Root 新任务目标 -> 该 workspace 的 skillsService.list
                                      |
                        校验目标/attachment 未变化
                                      |
                  精确匹配官方 skill + enabled + 有效路径
                                      |
                  Root 校验 expectedWorkspaceKey -> startDraft
                                      |
                  initialPrompt + initialPromptMention -> Composer
```

请求进行中禁用重复创建；工作区身份、远端 attachment、服务实例变化或入口卸载时，旧结果不提交。缺少/禁用 skill、断连、加载失败均明确提示且保持当前任务。身份为 `workspaceIdentity?.trim() || workspacePath`，路径始终来自目标 host；手机只使用可见工作区，桌面沿用 focused pane。不修改 continuous/replayable、runtime 或 accepted queue。

添加插件市场复用现有商店对话框及 store mutation。管理页通过可选导航 `intent: "add-marketplace"` 打开市场和对话框；成功切换个人分段，失败保留输入与错误。

## 插件搜索

市场页和管理页共享匹配规则：当前语言名称/简介、原始名称、完整 ID、市场名仍支持文本搜索；原始名称及 listing 中的所有展示名支持不带声调的全拼和首字母子串，忽略大小写和拼音中的空格。英文界面也能用 `feishu`、`fei shu`、`fs` 找到中文名“飞书”。保留同名跨市场的完整 ID 关联，不增加别名表、错字容忍或排序变化；不改变聊天输入框的技能搜索。

## Skill 内容与分发

独立内置内容插件 `plugin-creator`，版本 0.1.1，默认启用，中文名称“插件创建器”。随 Desktop、CLI/SEA、server/远端 Agent 资产一起分发，所有 scripts/references 均须存在。

Skill 按 scaffold -> optional components -> validate -> install/update 流程组织；正文路由到脚本与参考资料。脚手架使用 Node 标准库、异步 IO，默认 `<cwd>/plugins/<slug>`，名称规范化为小写连字符，目录名与 manifest 一致。已有文件默认拒绝覆盖，显式 force 才能更新选定文件；市场无关字段与条目顺序保留。组件只声明实际生成的路径。

生成 ZCode `.zcode-plugin/plugin.json`；marketplace listing 承载显示名与 i18n。2026-09-17 收敛：默认交付源码、测试市场清单和手动添加/安装/更新/试用指引，由用户在界面完成市场与安装操作。普通桌面用户不需要安装 CLI 或 Node；已有开发运行时可选用辅助脚本，无运行时则使用文件工具准备源码与 JSON。检查结构、资源路径和占位符；只有已有可用开发 CLI 时才额外调用 `zcode plugins validate`，未执行时不声称协议校验通过。

## 本地 dev 市场闭环

当前阶段的交付为：源码实现 → 可执行的检查与能力 smoke → dev 清单 → 用户手动添加市场、安装/更新并在新任务试用。只发送 skill 引用仍需先明确用途；明确只要源码时不额外生成市场。Skill 不自动登记、安装、更新或启用插件，不要求用户执行 CLI 命令，也不引入新的内部工具或运行时入口。

- 源码继续默认在当前工作区 `plugins/<slug>/`。dev 清单默认在同级 `plugins/marketplace.json`；显式目录/市场选择优先。
- 有 Node 时可选用现有 helper，市场名为 `dev-<父工作区名>-<规范化市场根目录 SHA256 前 8 位>`。无 Node 时按参考规范用文件工具生成清单，选择明确的 `dev-` 开头名称并保存在清单内，后续更新沿用该名称。已有清单优先复用；若之后改用 helper，显式传入该市场文件。遇到同名不同源则报告冲突，不隐式接管或移除市场。
- 清单只更新对应 listing，不重新生成插件源码；同步 manifest 名称、版本和简介，提供准确展示名与中文元数据，保留无关条目、字段和顺序。现有 helper 的原子写入、锁和路径保护保持不变。
- 手动添加路径：`插件市场 → 添加 → 添加插件市场`，粘贴市场根目录的绝对路径（默认工作区的 `plugins/`，不是单个插件子目录），点击添加；成功后在 `个人` 分段找到实际市场名和插件，再点安装。
- 市场操作由现有界面与插件服务执行，注册表和安装记录仍为 Host 用户级 inventory。手机/远程场景使用目标 Host 上的路径，不选择手机或当前本机上无关的目录。不编辑 known/installed/cache 内部文件。
- 修改已有插件先增加语义版本并同步 listing，再引导用户从市场页齿轮进入 `市场源`，点击对应市场的 `刷新该市场`，随后打开插件详情点 `更新`，在新任务试用。保留已有显式禁用选择；安装副本不是源码，不声称热加载。
- 完成回复列出源码、市场根目录与清单的绝对路径、实际市场名/完整 pluginId/源码版本、手动操作步骤及预期结果。未操作前明确写“市场待手动添加、插件待安装、试用待验”，已有安装但本轮未核实则写状态未核实。
- 新任务试用提示只使用可发现的插件/技能选择方式；未安装时不编造安装路径或已安装 skill 引用。添加失败保留源码，索取界面错误继续定位；取消或没有用户反馈不视为完成。

```text
源码目录（用户维护）
  → manifest / 能力校验
  → dev marketplace.json（文件工具或可用的 helper）
  → 交付准确路径和操作指引
  → 用户在界面添加/刷新市场 → 安装/更新插件
  → 个人市场/管理页核对 → 用户在新任务试用
```

验收当前指令：无全局 CLI/Node 时能交付源码、清单和界面步骤；首次添加与已有插件更新路径清楚；取消/失败/尚未试用保留真实状态。已有隔离 CLI 集成测试只证明辅助脚本和安装机制，不证明普通用户已经完成手动流程。本次不新增 UI/后端协议。

## 验收与影响

| Case | 状态/动作 | 断言 |
| --- | --- | --- |
| PLM-LC-018 | 中英文管理列表及搜索 | 完整 ID 关联 listing，名称/简介/反馈一致，原名与中文可搜，无翻译保留原文 |
| PLM-LC-019 | 两处添加菜单/创建 | 两个菜单项；真实 skill chip 和尾空格；未发送；remount 恢复同一草稿 |
| PLM-LC-020 | 添加来源成功/失败/取消 | 一次导航消费；成功个人分段；失败输入保留；取消无写入 |
| creator-boundary | 重复点击、切换 identity/attachment、禁用/缺失 | 仅当前目标提交一次，错误无预填/启用副作用 |
| creator-assets | Node/SEA/Desktop/remote | manifest、skill、scripts、references 齐全且可发现 |
| creator-scaffold | 最小、skill、MCP、hook、市场、更新 | ZCode 校验通过；非法输入、越界、重复/覆盖、TODO 被拒绝 |
| creator-dev-market | 创建/更新 dev listing、同名工作区与写入竞争 | 稳定 ID、无关数据与源码保留；来源冲突、重复、越界、锁占用拒绝；独占临时文件失败不删除已有文件 |
| creator-dev-workflow | 实际 CLI 创建、登记、安装、版本更新 | available/installed ID 与版本一致；安装目录与源码分离；内容更新生效且保留显式禁用 |
| creator-manual-handoff | 无 CLI/Node、首次添加、已有插件更新、取消/失败 | 给出真实目录与界面步骤；无自动登记安装；不编造安装引用；未完成状态明确 |

UI/草稿 owner：管理和商店组件负责展示/入口，Root 负责新任务，Composer draft store 负责预填事实；Skill/Plugin 内容以目标 host discovery 为准。共享菜单、prefill builder 和两处搜索是 must-inspect，runtime 是 invariant-only。Codegraph 已用于旧工作区定位；实现工作区未建索引，按已定位文件读当前源码。架构门禁的 ui/zcode-cli 当前非 managed，门禁通过不能替代语义检查。

对应 E2E 保留在 plugins/manual-review/pending，需人工审核后另行转正；桌面宽屏中文浅色、窄屏英文深色覆盖展示，远控身份用定向单测覆盖，未运行真实手机/SSH 时必须列为待验。

## 本机验证（2026-09-16）

以下为先前 helper/CLI 与 UI 实现的验证记录，当前手动交付规则见上文；这些记录不表示用户已执行添加、安装或试用。

- UI 定向单测 66 条、bootstrap 54 条、分发资产 92 条、Node scaffold/SEA 6 条通过；最小、Skills、MCP、hooks、组合五种脚手架均通过实际构建的 ZCode CLI 校验。
- Electron E2E `plugin-localization-creator.test.ts` 通过：两处菜单、真实引用与尾空格/焦点、未发送、返回后草稿恢复、中文和拼音搜索、添加来源成功/失败保留输入/取消；覆盖 1440px 中文浅色和 480px 英文深色。480px 是 Electron 最小窗口宽度，进入共享 UI 手机断点；未代替真实手机远控验证。
- 当前基线 WDIO 注入的自定义 agent command 不支持 storage startup。此轮使用临时 WDIO 配置清空 `ZCODE_AGENT_SERVER_COMMAND`、`ZCODE_AGENT_SERVER_ARGS_JSON`（包括 worker runnerEnv），复用原 hooks 和已构建 bundle，恢复内置 Agent 启动；未修改生产 runtime 或仓库 E2E 配置。
- 根 typecheck、CLI typecheck、根 lint（初次验证 47 个既有 warning、0 error）、架构检查通过。初次 CLI 全量 lint 未通过：所报告的 103 个文件与初始 staging 基线 `94cc393296` 内容完全一致；本次改动的 CLI 脚本和定义单独 lint 为 0 warning、0 error。
- feature graph 保留 4 条既有悬空边，无新增悬空边，新 code seeds 均存在；本 worktree 无 Codegraph 索引。未生成正式安装包、未连接真实 SSH/手机；已验证各分发资产清单及打包 fixture，远端身份/attachment 切换由定向单测覆盖。
- 扩展门禁已补齐远端部署 fixture 的 creator 清单、旧创建按钮断言和 E2E 隔离路径；对应回归通过。合并 staging `c32957bdad` 后，92 条 UI/导航定向测试、根 typecheck、lint（51 warning、0 error）和架构检查通过；Electron E2E 运行记录为 `desktop-e2e-20260916-110001-302`。本机通过 uv 启动 MR helper 时需确保其子进程 PATH 优先使用 Node 24.14.0，避免 Homebrew Node 26 覆盖仓库运行时。
- dev 闭环增量：8 条 Node helper 单测、24 条 bootstrap 分发/安装状态测试、2 条 SEA 资产测试通过；实际构建的 CLI 在隔离 storage 中完成登记、安装 0.1.0、禁用、刷新与更新 0.1.1，核对源码/安装副本分离和安装内容变化。根与 CLI typecheck、根 lint、架构检查通过；CLI 全量 lint 仍有既有失败，改动文件单独 lint 为 1 个既有 warning、0 error。
- Skill 边界静态复核：裸引用先明确用途；只要源码/只登记遵循用户选择；正常开发完成本地登记安装；更新不重脚手架、不改缓存、不恢复显式禁用；冲突停止并保留源码。未运行模型驱动的新任务验收，CLI 集成测试不等于模型使用新能力成功。
- MR 更新时合并 staging `2772217134`，SEA 清单同时保留 Guide 0.2.0 与 Creator 0.1.1，并补齐内容插件 fixture。合并后 51 条 Node/SEA 打包、24 条 bootstrap、65 条 UI 定向测试通过；重新构建的 CLI 开发闭环、根与 CLI typecheck、根 lint（52 warning、0 error）、架构检查通过。

## 手动交付指令验证（2026-09-17）

- 本轮只修改 5 份 Markdown；未新增工具、运行时、界面或协议。核对添加对话框的目录输入、个人分段、市场源刷新和插件详情更新入口。
- Skill 元数据、4 处本地文档链接、5 个 JSON 示例检查通过；用户安装参考文档不含 CLI 命令。首次创建、缺少 CLI/Node、已有插件更新、取消/失败、安装引用与待验状态已逐项静态复核。
- 2 条既有 creator 分发测试、根 typecheck 和根 lint（52 warning、0 error）通过；未新增或重跑 APP E2E，未声称模型已按新版指令完成用户手动流程。

## 插件创建器图标

官方 `plugin-creator@zcode-plugins-official` 在商店卡片、已安装条、详情与管理列表使用本地 `packages/ui/src/assets/plugin-icons/plugin-creator.png`：蓝色渐变圆角积木与白色加号，透明底，延续现有文档插件图标风格。既有缓存中的旧图片由该官方身份的本地图标覆盖，其他市场同名插件保留自己的 listing 图标。
