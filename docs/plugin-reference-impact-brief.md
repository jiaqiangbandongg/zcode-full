# Plugin 对话引用 Impact Brief

> 扫描日期：2026-08-05
> 模式：implementation-handoff
> 产品真源：[plugin-reference-mention.md](./plugin-reference-mention.md)

## Feature Summary

| Field | Value |
| --- | --- |
| Developer intent | 按需求逐项核对 Plugin 引用，从 Composer 与 Plugin 商店试用入口追到 provider、持久化、恢复与 remote/mobile 边界并补齐缺口 |
| Capability | `capability.plugin-reference` |
| Change layer | option-source / validation / commit-effect / persistence / recovery |
| Operating mode | implementation-handoff |
| Primary seeds | `MentionPlugin`、`PluginStoreDetailView`、`PluginsSection`、`usePluginReferenceCatalog`、`plugins/referenceCatalog`、`injectPluginReferenceReminderFromTurn`、`sendConversationCommandV4` |
| Out of scope | Plugin App/Connector 能力；为 remote/mobile 新建独立 Agent runtime |

## UI Surface Matrix

| User scenario | UI entry | Shared implementation | Display/draft owner | Default/inherit source | Validation/gating | Commit action | Authority/persistence | Mode boundary | Must remain isolated from |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 新建草稿引用 Plugin | Composer `@` 第一分组 | `MentionPlugin` + `usePluginsMentionProvider` | Lexical composer | workspace 当前 catalog | enabled；冲突项可见禁选；RPC 未就绪时空态 | 插入 `[@Label](plugin://stable-id)` | canonical user text；authority=`workspace` | desktop/mobile 共用 canonical 载体 | 不启用/安装/连接 Plugin，不写 selection state |
| 商店详情页顶部试用已安装 Plugin | 「Try now」主按钮 | `PluginStoreDetailView` + `PluginsSection` + Root `onCreateTask` | Root draft + V4 composer | 当前详情条目的 stable ID、locale display name | 已安装；disabled 仍可预填，但 Agent 按既有 `disabled_in_session` 规则 fail closed；无 workspace 时 fail closed | 标准新建任务，只预填 `canonical`，不发送 | root draft 持久化 + 单次 composer insert | desktop continuous 重置 workbench；mobile/remote 仍落目标 shared-host workspace | 不另建 Agent runtime，不维护第二份 Plugin selection state |
| 商店详情页示例提示词试用已安装 Plugin | 示例提示词胶囊 | 与顶部「Try now」相同 | Root draft + V4 composer | stable ID、locale display name、listing example prompt | 同顶部入口 | 标准新建任务，预填 `canonical + 空格 + prompt`，不发送 | 同顶部入口 | 同顶部入口 | 不分叉 canonical 或 runtime 语义 |
| 商店详情页点击未安装 Plugin 提示词 | 同一胶囊 | 既有 `handleInstall` | Plugin management store | 当前详情条目 | 未安装 | 仅安装/恢复，停留详情页 | 既有 plugin install persistence | local/remote 使用既有 Plugin 管理服务 | 不新建草稿、不发送、不把引用当安装指令 |
| 已有 Session 引用 Plugin | Composer `@` 第一分组 | 同上 | Lexical composer + 当前 taskId | Session 创建时冻结 catalog | missing session 协议报错，禁止回退 workspace | 插入同一 canonical 链接 | authority=`session` | local/remote 都经目标 workspace service | 不热加载 workspace 后续新增 Plugin |
| 切换 workspace/session/remote attachment | Picker reopen / task 切换 / remote 重连 | `usePluginReferenceCatalog` | request-scoped hook state | `workspaceIdentity?.trim() || workspacePath` + sessionId + remoteSessionId | 新 scope 首帧清空；seq/cancel 丢弃迟到结果 | 只读 catalog 请求 | 目标 host service | remote waiting/disconnect fail closed | 不显示上一 authority 的条目，不读本地 Plugin store |
| 发送与模型消费 | Send / retry / edit / queue drain 后 turn start | conversation command + runtime reminder injector | canonical `displayInput` | 目标 Session catalog + 当轮 live inventory | strict parser；tool visibility；permission 不变 | 追加 model-only system reminder | session store append-only notice | desktop continuous / mobile replayable 共用 Agent turn start | 不解析命令展开 prompt，不修改 canonical user text |
| 历史回显与恢复 | Transcript / cold resume / fork | mention markdown parser + 惰性 Session icon boundary + hydrator/fork message copy | transcript projection | 已持久化 user + model-only notice；仅可见 Plugin 用户行读取冻结 Session catalog | `plugin://` 单独渲染分支；合法 stable ID 才关联可信 HTTPS icon；其余回退 Cable；model-only 不进 UI | 无额外写入；相同 Session catalog 请求仅在 in-flight 阶段按 workspaceKey + remoteSessionId + sessionId + runtime restart 代次去重，settle 后释放 | 原始消息顺序与文本 | cold/hot/provider 前缀一致；runtime restart 后等待新 projection `live` 再重查；无 Plugin 行不挂载 catalog hook | 不按当前 workspace catalog 重算历史 reminder，不把 icon map 注入高频 rowContext |

## Shared And Divergent Behavior

| Concern | Shared across surfaces | Deliberately different | Why it matters for this change |
| --- | --- | --- | --- |
| UI/component | `@`、顶部「Try now」与示例提示词都提交同一 `plugin://stable-id` canonical 链接 | `@` 走 Picker/chip；顶部入口只预填 mention；示例入口额外预填 listing prompt；`#` 仍只开对话，`$`/货币符号仍只开 Skills | 新入口不能关闭旧候选能力，也不能分叉 Agent 语义 |
| Option source | 都由目标 workspace 的 `plugins/referenceCatalog` 提供 | 草稿取 workspace authority，已有任务取 session authority | 防止已有 Session 热加载或跨 workspace 泄漏 |
| Default/inheritance | 无隐式 Plugin selection | 冲突项保持可见但禁选 | fail closed 同时保留可诊断性 |
| Validation | stable ID、identifier、live capability 统一严格校验 | MCP 额外要求 connected 且至少一个 provider-visible tool；Subagent 要求 frozen 声明、live profile 与 Plugin-root provenance | capability hint 不得绕过 tool visibility 或泄漏 profile 内容 |
| Commit effect | 只提交 canonical Markdown text | 顶部「Try now」不附加文本，示例入口额外预填 listing prompt；runtime 仍只在 Agent 侧追加 system reminder | UI 不承担授权或运行时能力选择，试用不自动发送 |
| Persistence/recovery | user text 与 reminder 都 append-only | user 可见、reminder model-only | 保证热会话/cold resume/fork 前缀一致 |

## Feature Relationships

| Rank | From | Semantic edge | To | Condition | Why inspect it | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| must-inspect | plugin reference | renders-in | Composer Plugin surface | Plugin → file → session → whiteboard | 入口排序、禁选与 canonical 插入 | `MentionPlugin.tsx`、UI focused tests |
| must-inspect | plugin reference | renders-in | Plugin Store try surface | installed 且有 example prompt；disabled 的 runtime eligibility 不变 | canonical 构造、标准新建草稿、无自动发送 | `PluginStoreDetailView.tsx`、`PluginsSection.tsx`、Root new-task tests |
| must-inspect | plugin reference | served-by | catalog service | request identity 改变先清空并拒绝 stale | authority 隔离 | `usePluginReferenceCatalog.ts`、protocol test |
| must-inspect | plugin reference | served-by | reminder injector | 只解析 `displayInput`，按最终 tool visibility 取交集 | 防模板扩权与虚假 MCP 提示 | core runtime tests |
| must-inspect | reminder injector | persists-to | model-only history | user 后追加，永不回写 | provider 前缀缓存 | hydrator/provider projection tests |
| should-inspect | plugin reference | depends-on | workspace identity | identity 用 workspaceKey，路径仍用于 IO | remote 同路径隔离 | hook/service tests |
| invariant-only | plugin reference | constrained-by | web remote replayable | host trusted connection 决定 clientMode | 不让 renderer 伪造 delivery boundary | connection-scope tests |
| evidence-only | plugin reference | covered-by | PLG01–PLG17 | catalog + matrix 同步 | 逐项验收 | conversation docs + tests |

## State Owners And Commit Sinks

| State/fact | Draft/display owner | Authoritative owner | Commit command/service | Persistence/cache | Evidence |
| --- | --- | --- | --- | --- | --- |
| Picker catalog | React hook | workspace Agent / Session runtime catalog | `getPluginReferenceCatalog` | request scope only，不跨 identity 复用 | hook/protocol tests |
| canonical Plugin link | Lexical composer | conversation user message | `sendConversationCommandV4` / turn input | session store user message | UI + Desktop E2E |
| 商店试用 draft | Plugin detail Try now / example prompt | Root workspace action + V4 root draft | `onCreateTask({ initialPrompt })` | workspace identity 隔离的 root draft；composer 单次回填 | focused + Desktop E2E |
| live Plugin capabilities | 无 UI owner | Agent runtime Skill/MCP/Subagent registry | turn-start injector | 不单独持久化；生成时固化进 reminder | core runtime tests |
| historical reminder | UI 隐藏 | session event store | `persistSyntheticUserNoticeForSession` | append-only model-only notice | hydrator tests |
| mobile delivery mode | renderer 不可信 | host connection scope | trusted carrier | 仅调用链元数据，不进 canonical text | service scope tests |

## Must-Preserve Invariants

| Invariant | Surfaces/modes | Proof needed | Evidence |
| --- | --- | --- | --- |
| Plugin 只是 capability hint | 全部 | 不触发 install/connect/OAuth，不改 permission | reminder/core tests + fixed template |
| canonical text 唯一载体 | Composer、queue、retry/edit、mobile | 无 selection state，文本原样往返 | UI/command scope/runtime tests |
| 历史 append-only 与缓存断点稳定 | hot/cold/fork/compact | user → reminder → assistant 顺序一致 | provider projection + hydrator tests |
| workspace/session/remote authority 不串线 | local/SSH/WSL/Docker/mobile | 首帧清空、迟到丢弃、identity/remoteSession 透传 | hook/service tests |
| desktop continuous 与 mobile replayable 不互相污染 | desktop/mobile | host 真值决定 clientMode，共享 host 不新建 runtime | connection-scope tests |
| 旧候选能力保留 | `@`、`#`、`$`、`/`、action menu | `@`/`/` 主入口变化不删除旧面板 | composer routing focused + formal E2E |
| 商店试用只预填、不发送 | Plugin detail、desktop/mobile/remote；installed enabled/disabled | 顶部入口只含 canonical，示例入口含 canonical+prompt，provider 无新请求；disabled 不改变草稿行为 | focused + formal Desktop E2E + PLG12/PLG15 |

## Codegraph Evidence

| Seed | Query | Direct callers / key path | Depth | Interpretation |
| --- | --- | --- | --- | --- |
| `MentionPlugin` | callers/rg | Session composer → mention providers → panel/chip | 2 | UI 分组和键盘禁选共享落点 |
| `PluginStoreDetailView` / `handleUsePrompt` | callers/rg | Settings → Plugin detail Try now / example prompt → Root onCreateTask → root draft | 3 | 两个商店入口共用第二个 canonical commit surface，不是第二套 runtime |
| `usePluginReferenceCatalog` | callers/rg | plugins provider → workspace services → plugin management | 3 | request scope 是 catalog authority 的 UI 边界 |
| `injectPluginReferenceReminderFromTurn` | callers/rg | `executeTurn` → displayInput → runtime inventory → persistence | 2 | canonical 解析、live 交集和持久化同属 turn start |
| `sendConversationCommandV4` | callers/rg | renderer/adapter → connection facade → base service → CLI V4 command | 3 | mobile trusted mode 与 canonical payload 的交付边界 |
| `plugin_reference` | affected tests/rg | source descriptor、provider projection、hydrator、formal Desktop spec | 3 | 生命周期已有跨层确定性证据 |

## Graph Drift Candidates

| Candidate | Live-code evidence | Missing/stale graph relation | Proposed follow-up |
| --- | --- | --- | --- |
| Plugin Store try surface | 详情页已有 example prompt，但 feature graph 只登记 Composer surface | 缺少第二个 canonical commit surface 及标准新建草稿关系 | 新增 `surface.plugin-store-example-prompt-try` 与关联 edge |

## Graph Delta

| Status | Node/edge | Semantic reason | Evidence | Action |
| --- | --- | --- | --- | --- |
| confirmed | plugin reference → catalog service | catalog state 必须按 request identity fail closed | hook regression tests | 已更新 edge condition |
| confirmed | plugin reference → reminder service | 解析源是 canonical displayInput，MCP 依据最终 provider visibility | runtime regression tests | 已更新 edge condition |
| confirmed | plugin reference → web remote replayable | command mode 来自 host trusted carrier | connection-scope regression tests | 已更新 edge condition |
| confirmed | plugin reference → Plugin Store try | 详情页复用 canonical builder 和 Root 标准新建任务，不自动发送 | focused + Desktop E2E | 新增 surface node/edge |

## Unresolved Questions

| Question | Candidate answers | Scope difference | Owner |
| --- | --- | --- | --- |
| none | 当前 PLG01–PLG17 产品语义均已确认 | 无 | — |

## Planning Handoff

| Item | Destination | Status |
| --- | --- | --- |
| Spec update | `docs/plugin-reference-mention.md` | complete |
| Case catalog | `docs/conversation-session-case-catalog.md` PLG | complete |
| Coverage matrix | `docs/testing/conversation-session-e2e-coverage-matrix.md` PLG | complete |
| Plugin Store try | 示例提示词胶囊复用 canonical 引用与 Root 标准新建任务 | complete |
| E2E handoff | formal `conversation-session-plugin-reference.test.ts`、`conversation-session-plugin-reference-subagent.test.ts` + pending `conversation-session-plugin-store-try-states.test.ts` | ready |
