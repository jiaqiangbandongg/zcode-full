# Plugin Management Lifecycle Case Catalog

本文定义 Desktop 本地插件管理的用户级生命周期合同。只有包含独立 setup、action、assertion
和 evidence 的 case 才算覆盖；仅从某条长路径中经过某状态不算覆盖。

## Scope and state ownership

- Included：Desktop local workspace、user-scope plugin storage、Public/Personal、Builtin、CDN、
  Personal Source、inline 展示、重启恢复、代表性运行时注入、关键可恢复失败。
- Excluded：Standalone Web、手机 `/remote`、remote workspace plugin sync、workspace-scope 安装、
  公网依赖的正式 CI、完整 locale/theme/viewport 笛卡尔积。
- 安装、配置、enabled、来源和抑制状态由 `<E2E_HOME>/.zcode/cli/plugins` 与 CLI config 持久化；
  UI store 是投影，不是权威来源。
- Desktop local workspace A/B 共用同一 E2E HOME，验证当前 user-scope 语义。

```text
UI entry
  | Settings > Plugins
  v
pluginManagementStore
  | typed plugin service
  v
ZCode Agent plugin handlers
  |                     |
  v                     v
user plugin storage     future session runtime discovery
(source/install/config) (Skill + MCP evidence)
```

## Status vocabulary

| Status          | Meaning                                            |
| --------------- | -------------------------------------------------- |
| `manual-review` | 自动操作已实现，等待人工确认截图与产品行为         |
| `formal`        | 人工确认后已提升为默认稳定 E2E                     |
| `bug-candidate` | 当前产品缺口，不写成绿色预期，也不在测试任务中修复 |
| `pruned`        | 明确不做，保留剪枝理由                             |

## Accepted cases

| Case                                      | Setup                                          | Action                                                                                                         | Assertions                                                                                                 | Evidence                                          | Initial status                   |
| ----------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------- |
| `PLM-LC-001 discovery-navigation`         | 隔离 HOME，Public 与 Personal 均有确定性目录   | 从 Settings 进入 Plugins；切换分段；跨分段搜索/清空；验证分组默认全部展开并手动收起/展开；经 Card、Installed Strip、Manage 进入详情并返回 | 默认 Public；公开分类与个人市场默认全部展开、手动折叠有效；搜索统一结果；清空恢复；返回保留 segment/query/scroll；三个入口可达                           | DOM + URL-free UI state + screenshot              | `manual-review`                  |
| `PLM-LC-002 presentation`                 | zh-CN/Zai Light/宽屏与 en-US/Zai Dark/窄屏两组 | 打开列表、详情、Manage 和来源弹窗                                                                              | 核心动作可见可操作；无横向溢出；长文案不覆盖控件                                                           | DOM layout + a11y role + screenshot               | `manual-review`                  |
| `PLM-LC-003 personal-main-lifecycle`      | 本地目录 Personal Source，复合插件 v1          | UI 添加来源、找插件、打开详情、两次点击 Example Prompt、配置、跨入口启停、检查更新、升级 v2、卸载取消/确认     | 五类组件可见；第一次只安装；第二次只建草稿且不发送；配置/enabled 正确；检查更新后已安装行出现「可更新」角标与行内更新入口；v2 生效；取消不改变状态；确认后清理 | UI + overview/list + storage + provider capture   | `manual-review`                  |
| `PLM-LC-004 persistence-local-visibility` | v1 已安装、配置并禁用                          | 重启 app；切换本地 workspace A→B                                                                               | source/install/config/disabled 重启后保持；B 可见同一 user-scope 状态                                      | UI + persisted JSON + workspace switch            | `manual-review`                  |
| `PLM-LC-005 source-orphan-reassociate`    | Personal 插件已安装                            | 删除来源；使用/配置/启停；重新添加同一来源                                                                     | 安装保留并标为来源缺失；菜单、详情、角标与行内更新入口均不可见；功能仍可用；重新添加后 listing/update 关联恢复 | UI + installed/config files + runtime marker      | `manual-review`                  |
| `PLM-LC-006 builtin-suppress-restore`     | 隔离 HOME 中 Builtin 已启用且含配置/数据       | 卸载；留在详情页；重启；从 Public 恢复                                                                         | 清理配置/用户 data；Catalog 与不可变内置 cache 保留；重启后 Runtime 仍不加载；详情组件清单可读；显示 Restorable Builtin；恢复为干净默认状态 | UI + suppression/config/data/cache/manifest files | `manual-review`                  |
| `PLM-LC-007 public-cdn-local`             | 本地 HTTP ZIP 作为确定性官方 CDN fixture       | Public 浏览、详情、安装                                                                                        | 使用唯一官方 marketplace id；ZIP 校验安装；缓存来源和版本正确                                              | UI + HTTP fixture log + cache + overview          | `manual-review`                  |
| `PLM-LC-007b official-cdn-smoke`          | 允许公网的人工环境                             | 刷新真实官方 CDN 并安装指定 smoke plugin                                                                       | 真实 manifest/zip 路径可用                                                                                 | UI + network artifact                             | `manual-review`, never formal CI |
| `PLM-LC-008 recoverable-failures`         | fixture 可切换 invalid/404/malformed/v1/v2     | 添加非法来源/官方 id 冲突；refresh/describe/install/update 失败并重试；取消卸载确认                            | 错误可见；重试入口可达；失败不破坏旧版本、update badge、配置或安装；取消零副作用                           | UI error + fixture request log + storage snapshot | `manual-review`                  |
| `PLM-LC-009 inline-smoke`                 | 隔离 HOME 中 inline plugin                     | 从 Personal、详情、Manage 查看并在新 session 使用                                                              | inline 可见、组件可用；不执行通用卸载入口                                                                  | UI + runtime marker                               | `manual-review`                  |
| `PLM-LC-010 secret-env-agent-projection`  | Personal 插件含 `${E2E_PLUGIN_RUNTIME_SECRET}` MCP env 与一个 agent | 安装后在新 session 调用 MCP；打开 Settings > Subagents                                                         | MCP 只返回 secret 已解析标记且不回显 secret；同一 agent 文件只有规范名称一行，裸名称仍可作为运行时别名     | provider capture + Subagents DOM + screenshots + Electron `capturePage()` video | `manual-review`                  |
| `PLM-LC-011 no-git-github-archive`        | 真实 Anthropic Claude Marketplace；Agent Git binary 指向不存在路径；adapter 另有 loopback fixture | 先探测非 GitHub Git fallback；经 Renderer → Host → Agent Protocol 刷新 `claude-plugins-official` 并安装真实 `aikido` 插件 | fallback 返回 `plugin_git_unavailable`；真实 Marketplace/plugin HTTP Archive 安装成功；cache 无 `.git` 且可 discover | diagnostics + captured HTTP records + installed/cache snapshot | `manual-review`, never formal CI |
| `PLM-LC-012 isolated-refresh-atomic-cache` | 两个 Marketplace 已有 v1 snapshot；fixture A=v2、B=失败；cache copy/rename 可注入失败 | 批量刷新；重启；恢复 B；更新插件时注入激活失败并重试 | A 更新；B 保留 v1 且失败状态跨重启；B 成功后清除失败；激活失败始终保留旧 cache/install record，重试后原子切到 v2 | diagnostics + persisted JSON + directory snapshots | `manual-review` |
| `PLM-LC-013 suggested-prompt-official-install` | New Task 推荐项引用缺失 Plugin；官方目录 fixture 可在成功/失败/超时间切换 | 点击推荐项；刷新 `zcode-plugins-official`；在 Popover 确认 User-scope 安装；安装中切换另一推荐项 | 首次本地检查缺失后唯一 Popover 先进入 loading，可信解析与 Composer 稳定后同一实例切安装确认；prompt 一次性预填且不发送；刷新达到 10000ms 时中止并 fail closed，失败/超时拒绝旧快照；成功只安装官方候选；切换时取消旧 operation、迟到结果丢弃；同一 Popover 完成后 chip 前置且正文保留 | protocol/focused tests + UI manual review + user storage snapshot | `manual-review` |
| `PLM-LC-014 builtin-uninstall-detail-parity` | 隔离 HOME；内置插件已 seed、启用并有配置/data | 打开详情；卸载；在详情页重试；重启；点击 Install | `installed=false`；suppression 存在；Runtime 不提供 Skill/Command/MCP；Catalog/cache/完整组件详情仍可读；describe 不改变 config/data/cache；Install 恢复且不产生普通 installed record | UI + protocol + config/data/cache/manifest + fresh discovery | `manual-review` |
| `PLM-LC-015 bundled-install-ownership` | suppressed builtin 与合并 official entry；另有 CDN 同名 source fixture | 分别走 UI Install 与 direct protocol install | bundled `filesystem/sea` 路径等价 restore；CDN source 仍走 Marketplace install；无 stale suppression、重复 ownership 或错误 installed record | protocol + installed record + runtime | `manual-review` |
| `PLM-LC-016 seed-cache-runtime-separation` | suppressed builtin 分别处于 cache 存在/缺失；filesystem 与 SEA seed fixture | resolve/list/describe/skills/commands；触发 cache 自愈 | suppression 始终过滤 Runtime；缺失 cache 可由 seed 恢复；describe 前后都成功；Catalog 不被过滤；无 seed↔uninstall 互删震荡 | bootstrap + adapter + services tests | `manual-review` |
| `PLM-LC-017 installed-menu-layout` | 内置插件在 Workspace `.zcode/config.json` 显式启用（enabledSource=workspace） | Settings > Plugins 切到 Workspace scope；打开已安装列表行内「…」菜单 | 「恢复 User 默认」/「Restore User default」与更新、卸载项都单行显示、等高；菜单按内容撑开而非绑定图标触发器宽度 | menuitem 文本 Range 行框计数 + 截图 | `manual-review` |
| `PLM-LC-018 official-auto-refresh-throttled` | 隔离 HOME；官方目录已有条目且一分钟前刷新 | 进入、退出、重新进入商店 | 不再刷新；Claude 目录时间及失败状态不变；原候选仍可见 | DOM + overview + throttle 单测 | `manual-review` |
| `PLM-LC-019 official-auto-refresh-on-enter` | 隔离 HOME；官方目录已有条目但时间过期；允许真实 CDN | 不点刷新进入商店，再退出重进 | 官方时间更新且无失败诊断；重进不再次刷新 | DOM + overview + runtime logs | `manual-review`, never formal CI |
| `PLM-LC-020 plugin-subagent-override-cold` | 隔离 HOME；官方 judge 的结构化覆盖指定 alternate/high，主选择 primary/max | 完整重启后发送，通过 Agent 调用 document-skills:judge | child 请求为 alternate/high，父 continuation 为 primary/max；Agent 正常完成；已保存覆盖不变 | case-local replay + 实际请求 + UI + state | `manual-review` |

Todo103 迁接说明：PLM-LC-018/019 来自固定 staging 的 `dbb3ec0ce8`，保留 pending 身份。首次/过期/失败后的节流及手动刷新时间优先级由共享判据单测覆盖；真实 CDN 环境失败必须与合并回归分开记录，不把公网用例晋级为离线 CI。

PLM-LC-020 补齐该来源插件覆盖的冷启动执行闭环；SE-04 已证明 UI 保存与插件文件不变，本例直接构造同格式的隔离持久化输入，不重复完整设置交互。child 与父请求的模型、档位均不同，错误继承不能通过。仅本地新执行，不扩为热更新或远控矩阵。

来源 PLM-LC-019 的环境限制继续保留：人工公网检查使用显式 replay fixture 与 manual-review hold，避免 capture MITM 证书使 Agent 市场 fetch 失败。该前置故障只阻塞公网用例，不视为产品回归或阻塞其他离线用例。

## Runtime closure for PLM-LC-003/005/009/010

- 详情 UI 必须列出 MCP、Skill、Command、Agent/Subagent、Hook 五组，但只用 Skill 与 MCP 做
  运行时闭环，以代表 discovery 注入和工具注册两条不同路径。
- 运行时断言必须创建新 session；升级前的既有 session 不要求热替换。
- Example Prompt 第一次点击（未安装）只允许安装，不得新增 session；第二次点击创建新草稿并
  预填，发送前 provider capture 必须为零。
- 环境变量闭环只断言 MCP 返回不含 secret 的“已解析”标记；截图、provider capture、日志和错误
  文本均不得记录 secret 原值。
- 插件 agent 的运行时规范名称与唯一裸名称可以同时存在，但设置页和插件详情按资源身份只展示
  规范名称一条。

## Pruned combinations

| Dimension                 | Decision                                                      | Reason                                                                    |
| ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Client                    | 只测 Desktop local                                            | Web/remote 的 attachment、workspace identity、replayable 边界属于独立套件 |
| Source × lifecycle        | Personal Source 跑完整主链路；Builtin/CDN/inline 只跑差异路径 | 避免重复相同安装/启停/卸载合同                                            |
| Entry × operation         | Card/Detail/Manage 各选代表操作                               | 不做入口与全部操作的笛卡尔积                                              |
| Locale × theme × viewport | 两组 pairwise 组合                                            | 行为合同与展示合同分离，控制 CI 成本                                      |
| Component runtime         | Skill + MCP 闭环，另外三类只验证详情枚举                      | 已覆盖两种不同运行时集成边界                                              |
| Network                   | 正式 CI 只用 loopback fixture                                 | 公网不稳定且不可复现                                                      |
| Install scope             | 只测当前 user scope                                           | UI 没有 workspace-scope selector                                          |

## Bug candidates

| ID           | Gap                                 | Test treatment                         |
| ------------ | ----------------------------------- | -------------------------------------- |
| `PLM-BC-001` | Settings 插件商店安装中没有取消 UI  | 不宣称覆盖；推荐 Prompt 的独立取消入口由 PLM-LC-013 覆盖 |
| `PLM-BC-002` | 来源管理没有独立 Validate/Diagnose  | 覆盖添加时校验、update 和 remove       |
| `PLM-BC-003` | inline 通用菜单暴露无后端语义的卸载 | smoke 不点击卸载，保持正式套件全绿     |

## Promotion gate

所有新 spec 首先位于 `packages/desktop/test/e2e/plugins/manual-review/pending/`。人工审核截图、
交互和证据后，先执行 promotion dry-run，再 apply；未审核的 pending spec 不进入默认 WDIO、
Docker preset 或 macOS/Windows 正式 CI。

## PLM-STRIP-CLIP（2026-09-15）

接受：12 个已安装且可更新插件，在 390/1200px、中英文、明暗主题下检查角标完整可见；悬停与键盘聚焦首/末项，横向滚到末尾后点击角标，只触发对应更新，不打开详情。无页面横向溢出、无图标条纵向滚动。使用真实共享组件及测试动作回调，不覆盖安装后端。

## 2026-09-16 已确认用例

PLM-LC-018（管理列表本地化）、PLM-LC-019（双入口创建插件草稿）、PLM-LC-020（添加市场导航）已由产品方案确认；状态、动作、断言及边界见 [plugin-creator](plugin-creator.md)。不覆盖录制技能和市场模糊搜索。

## PLM-MISSING-CONFIG（2026-09-17）

已确认场景：旧 document-skills 配置存在且 packageStatus=missing，三个目录/安装/恢复集合无该 ID；
同时五个新插件仍有目录。进入商店并搜索旧名称：旧卡片和安装按钮均不存在，新插件保持可见。
对照：目录仍提供 repairable 的包但本地缺包，它保留安装入口。原始 plugins 诊断集合不被更改。
证据：buildStoreItems 回归 + 浏览器 fixture（桌面/窄屏、中英、深浅）+ 当前 dev 原始用户配置实测。
不执行自动迁移或删除配置；不改变已安装孤立插件、内置恢复或 Workspace/User 配置归属。

## PLM-DOCUMENT-ORDER（2026-09-17）

默认官方文档插件按 PDF、PPT、Excel、Word 排序。浏览器用例覆盖商店分类和已安装图标条，
桌面/手机 × 中英文 × 深浅主题；预置管理分组、停用、缺项、个人同名隔离及服务端排序优先由单测覆盖。
入口：`packages/ui/test/browser/manual-review/pending/plugin-store-mode-order.test.mjs`。
此用例属于浏览器展示验证，不作为 Electron 安装生命周期或正式 CI 准入证据。
