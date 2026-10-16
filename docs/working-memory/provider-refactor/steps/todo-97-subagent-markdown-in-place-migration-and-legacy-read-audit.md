# Todo 97：Subagent Markdown 原字段迁移与旧字段读取专项复审

> 验证归属更新（2026-09-09）：本文残余欠测/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。Wiki 一次迁移边界已实现并验收，本 Todo 开发项已全部收尾。

> 状态：已裁决开发范围完成；2026-09-09 补齐 Wiki 一次落盘迁移及二审。执行证据见 [总记录](../research/todo94-97-execution-and-review.md) 与 [逐存储审计表](../research/todo97-selection-storage-audit.md)。下文 §4/§5 的“当前事实/待执行”是开工记录，最新结果以审计表及 §7/§8 为准；验证欠账统一由 Todo102 承接。
> 总目标：用户可读的 Subagent Markdown 保留 `model`、`thoughtLevel`，仅对用户数据目录里的文件在原字段中迁移旧 Provider 身份，项目和插件文件不自动修改；同步彻查整个 Provider / Model Selection 迁移链路的中间格式兼容及旧字段运行时回读。

## 1. 两条必须执行、必须重新审查的原则

1. **不兼容未上线、已经被重新裁决替代的中间格式。** 只迁移实际发布过的旧配置，不为本轮错误迁移产物增加逆迁移、双读、双写或优先级分支。Subagent Markdown 中间态 `modelSelection` 不转回 `model` / `thoughtLevel`，也不保留其正式读取/保存路径。不擅自清理用户磁盘上的中间态文件。
2. **旧字段只用于迁移，迁移后的正式使用不得再读取旧字段。** 禁止新字段为空、损坏、模型不可选、账号未登录、Provider 暂缺或 SSH 失联时回读旧字段补值。保留用于回滚的旧数据不等于允许运行时使用。新进来的真正旧文件可以重新进入明确的迁移入口，但不能把同一份文件每次加载时的内存兼容称作一次迁移完成。

这里的“旧字段”按契约判断，不是按字段名字判断：**本次明确保留的 Markdown `model` / `thoughtLevel` 是迁移后的正式字段**，正常读取它们不违反第二条。被淘汰的是其中的旧 Provider 表达，以及其他存储中已被新字段取代的字段。内部/协议的结构化 `ModelSelection` 仍合法；不能因 Markdown 不再使用同名字段而全仓删除内部类型。

两条原则都必须形成逐入口审计表、测试及二次复审证据。不得只写注释、只改一个 decoder，或只凭搜索不到某个字段名宣布完成。

## 2. Subagent 已裁决方案

- 用户／项目 Markdown 的正式格式继续为 `model`、`thoughtLevel`；创建、编辑、保存、Host 读取和 Agent 加载必须一致，不得保存后又生成 `modelSelection`。
- **自动原地迁移仅限用户数据目录 `<data>/agents/`**。项目 `.zcode/agents/`、插件附带文件及其他来源全部不自动迁移、不写回；这不取消用户主动编辑保存项目配置的已有功能。
- 按 [Todo 96](todo-96-selection-offline-migration-and-resolution-consolidation.md) 做确定性旧身份转换：旧 BigModel / Z.ai Coding Plan 迁为同域 Individual；不查询当前连接、登录、权益、Registry、View 或模型能力。Individual 只是迁移落点，不表示用户历史使用个人套餐，不切换连接。
- 模型 ID、思考档位保留原意图；档位别名治理属于 Todo 95，不顺带改写。继承选择保持继承，不因身份迁移猜一个模型。
- 正确解码实际旧字符串后，只变更 Provider 身份；覆盖旧 `provider/model` 和 `custom:...` 编码，保证模型 ID 无损往返，不能对正文全局替换。
- 自动原地迁移只修改相关 frontmatter 值，保留正文、注释、未知字段和无关格式；不能直接用重建整个 Markdown 的现有 serializer 做迁移。
- 内部 profile、服务接口与 App–Agent 协议继续使用结构化 `ModelSelection`。内置 Explore / general-purpose 的 `agents-state.json` 覆盖仍用现行结构化字段，不因 Markdown 易读性要求改回旧 JSON 双 map。
- 显式 Subagent 执行时取得有效选择的接入由 Todo 96 负责；本项不靠保留旧 ID 运行时解析替代它，也不以设置页通过冒充后台通过。已接受的损坏选择继承策略不借本项重新扩大为另一轮错误处理设计。

```text
用户数据目录里的真正旧 Markdown
        |
        v
明确迁移入口：离线转换旧 Provider 值
        |
        v
原文件 model / thoughtLevel（正式格式）
        |
        v
正式读取 -> 内部 ModelSelection -> 有效选择解析 / 执行
                         不再回读旧身份或中间格式补值
```

## 3. 文件写入边界：已裁决，仅用户目录

实施收口：共享纯文本转换与正式字段 codec，Node-only 用户目录迁移由 Host/Agent 初始化复用；不让普通 reader 转换 Provider。迁移保留原文件模式及其他字节，复用文件锁，写前比较原文；符号链接、只读文件不改权限或跟随到范围外，失败不转换内存来冒充完成。范围外旧身份仍作为显式不可绑定选择接受现有校验。

用户已明确：只改用户目录里的文件，其他全部不动。无需再为项目、插件或只读来源设计自动迁移方案。

- 在既有用户配置初始化／迁移阶段完成用户目录迁移，随后正式加载；复用现有初始化边界，不另造调度器或为了其他来源扩展加载时机。
- 自动迁移不得遍历项目或插件目录写回，不创建影子副本，不修改权限，不自动禁用插件。共享读取契约仍统一，但不为范围外的旧文件保留永久身份兼容旁路；未迁移的旧身份不保证可用，沿用既定校验，不暗中重绑。
- 原文件解析失败、写入失败、并发用户编辑时不能宣称迁移完成，也不能覆盖新内容。采用现有异步 IO 和事务/并发保护能力，不引入定时等待解决同步问题。
- 再次加载已迁移文件不应再调用旧身份转换；新加入的真正旧文件仍可被迁移。不能只设置一个全局“迁移过”标志而遗漏后加入的文件。

## 4. 当前事实、影响边界与代码种子

本项为 feature-boundary-planner 的 planning，主要层级是 persistence / validation / commit-effect。没有 codegraph 工具；以下为定向读取及此前内存复现，不声称已完成全仓审计。

| 等级 / 场景 | 入口及共享实现 | 原意图与提交落点 | 当前事实 / 必须检查 |
| --- | --- | --- | --- |
| must-inspect：用户／项目设置表单 | SubagentsSection → subagentsService → subagentMarkdown | 表单草稿；显式 Save 写各自 Markdown | 当前 serializer 写 `modelSelection`；必须统一为正式原字段，保存不重引中间态 |
| must-inspect：Host 读取 | `packages/services/src/subagents/subagentMarkdown.ts`、`subagentModelSelection.ts` | 文件是权威；返回内部 selection | 当前按是否存在 modelSelection 分双读路径；需删除中间格式分支，明确迁移与正式读取分界 |
| must-inspect：Agent 冷启动 | bootstrap `subagents.ts`、`subagent-legacy-selection.ts`、`app/create-app.ts`；core `profile-model-selection.ts` | Markdown → 内部 profile | 当前每次导入旧身份只改内存、不写 Markdown；需追到重启后二次读取，不能只测单次结果 |
| must-inspect：内置覆盖 | subagentsService 的 state importer / prepareRuntimeState，bootstrap state reader | `agents-state.json` | 格式不回退；彻查旧双 map 只在迁移入口读，正式 reader 只读当前字段 |
| invariant-only：项目／插件等范围外文件 | 项目/插件 agent discovery 和 profile loader | 各自原文件 | 自动迁移不写入，不新增中间态或旧身份长期兼容；用户主动 Save 与自动迁移分开 |
| must-inspect：所有 Selection 使用入口 | Todo 96 的 Session、Automation、Bot、Wiki、Recent/Default/Draft | 各业务原有存储、保存时机 | 排查同类中间态兼容、新空值回读旧值、反复内存转换、环境失败破坏原意图；不是只检查 Subagent |
| invariant-only：实际执行 / 远端 | Subagent child 启动、目标 Host 的有效解析及最终 Registry 校验 | 本次运行冻结的具体选择 | 不绕过最终校验、不改正在运行请求；不借本地配置修远端，不新增发送前同步 |
| invariant-only：闲时 | Off-Peak migration / Ticket | 已有票据与固定运行选择 | 纳入旧读取事实审计；不得机械套用 Individual 迁移或改变 Ticket 绑定，冲突另列裁决 |

共享的是身份解码、内部 Selection 和候选解析，不共享保存副作用：Subagent Save 不等于 Composer 发送接纳，内置 JSON 不等于 Markdown，插件也不等于用户文件。主会话、定时任务的执行行为不在本项擅自重构。

必须保持桌面 continuous / 手机 replayable、shared-host、workspaceIdentity 隔离及目标文件系统权限；远端文件由所属执行环境处理，不能按本地同路径写回。本次不改变布局、主题、国际化或消息恢复链路。

图谱漂移：当前 subagents invariant 仍记载“不写 Markdown”的旧实现；本计划只增加引用，不谎报已经切换。实现验收后同步图谱和 `docs/subagents-built-in-model-overrides.md`，旧规范与代码不一致处逐项记录，而非直接按当前代码改规范。

## 5. 重新排查：必须交付的过程表

对每个持久格式分别记录下面这些列；“当前字段名”相同不代表属于同一格式。范围是本轮 Provider / Model Selection 重构，不扩成全仓所有数据迁移重做。

| 入口 / 文件或表 | 发布旧格式 | 正式当前格式 | 未上线中间态分支 | 迁移入口及触发 | 完成写入证据 | 正式 reader / runtime 是否回读旧值 | 保存是否重写旧/中间格式 | 处理 / 测试 / 二审 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 用户目录 Subagent Markdown | 待核实样本 | model / thoughtLevel，新 Provider 值 | modelSelection（确定移除兼容） | 既有用户配置初始化／迁移阶段 | 待实现 | 待逐调用链核对 | 当前存在 | 待执行 |
| 项目／插件 Subagent Markdown | 原文件保留 | 正式读取使用 model / thoughtLevel | modelSelection（不增加兼容） | 排除自动迁移 | 验证无自动写入 | 纳入读取审计，不新增旧身份旁路 | 项目显式 Save 与自动迁移分开 | 待验证 |
| 内置 Subagent state JSON | 待核实旧双 map | builtInModelSelectionOverrides | 按发布来源识别 | 现有 prepareRuntimeState | 待复验 | 待复验 | 待复验 | 待执行 |
| Session / Recent / Draft | 各实际旧存储 | 各正式存储 | 待逐项列明 | 对照 Todo 96 | 待记录 | 待记录 | 待记录 | 待执行 |
| Automation / Bot / Wiki | 各实际旧存储 | 各正式存储 | 待逐项列明 | 对照 Todo 96 | 待记录 | 待记录 | 待记录 | 待执行 |
| Provider config / Account connection | 各实际发布旧格式 | 各正式配置 | 待核对本轮被替代字段 | 各自现有迁移入口 | 待记录 | 待记录 | 待记录 | 新设计冲突单列，不顺带重做 |
| Off-Peak | 既有旧任务记录 | 现行任务格式 | 待核实 | 既有专用边界 | 待记录 | 待记录 | 待记录 | 审计，不改变票据契约 |

追踪至少覆盖：迁移、正式读取、设置页展示、实际执行、保存、重启。不能仅搜索 `legacy` 命名；重点查 `new ?? old`、新值无效后 fallback、双读 parser、RPC resolver、每次加载重新导入，以及测试是否把旧运行行为锁成正确。

发现缺口必须分类：明确违反已裁决原则且能直接修复／与其他已裁决边界冲突需讨论／仅留在迁移或回滚数据中无需删除。旧字段为迁移保留的代码允许存在，但需给出调用边界和正式路径零调用证明。跨 Todo 修复链接到具体条目，不重复造两套实现。

## 6. 验收与执行顺序

维度：真正旧格式／当前格式／未上线中间态；用户／项目／内置 JSON／插件只读；首次迁移／重启／显式保存；正常写入／失败／并发编辑；在线／离线。只覆盖改变语义的组合，不笛卡尔积铺开。

| 用例 | 准备与动作 | 断言及证据 | 状态 |
| --- | --- | --- | --- |
| SA97-01 | 用户目录里两种真实旧字符串编码，迁移后重启加载 | 仅 Provider 值改变，模型/档位保留；第二次加载不再调用旧身份转换 | accepted，待单测/文件集成 |
| SA97-02 | 未登录、空 Provider、SSH 断连条件下迁移同一旧选择 | 输出一致，无账号/网络/候选查询；原意图不被置空 | accepted，对接 SM96 |
| SA97-03 | 含正文同名字符串、注释、未知 YAML 字段、不同换行的文件 | 精确文件差异仅在目标字段值；迁移幂等，不整份重建 | accepted，待文件测试 |
| SA97-04 | 设置页创建/编辑用户及项目 agent，保存后冷启动 | 只写正式 model / thoughtLevel；Host/Agent 解码一致；实际 child 消费对应内部选择 | accepted，待服务/Agent 集成及 Pro E2E |
| SA97-05 | 中间态 Markdown 的 modelSelection | 无专用兼容、逆迁移或优先读取分支；保存不再产生该字段；不借测试要求恢复该格式 | accepted，待负向测试及引用审查 |
| SA97-06 | 其他存储已存在当前字段，旧字段与其冲突；当前值清空/不可用 | 正式路径不调用旧 reader，不复活旧意图；保留各自已裁决的清空/损坏处理 | accepted，逐入口测试 |
| SA97-07 | 用户目录迁移同时用户编辑，或写入失败，随后重新加载 | 不覆盖并发内容、不标假完成、不绕过迁移进入旧字段执行路径；沿用迁移失败处理，不为写权限扩大产品设计 | accepted，待文件测试 |
| SA97-08 | 内置 JSON 旧双 map 迁移并重启，及新版覆盖保存 | 正式 reader 只读新字段，覆盖原子性保持；不随 Markdown 改回旧格式 | accepted，待集成 |
| SA97-09 | 同时存在用户、项目、插件的旧文件，执行初始化迁移 | 仅用户目录文件变化，项目和插件文件字节不变；不创建影子文件、不改权限、不为范围外旧身份新增兼容执行路径 | accepted，待文件集成 |
| SA97-10 | 审计表每个入口：迁移完成，再读取/执行/保存/重启 | 旧字段只在迁移使用，无中间态兼容；附实现位置、测试命令、结果与二审结论 | accepted，完成门槛 |

1. 补齐审计表的真实发布依据和调用链，按 §3 已裁决的用户目录范围接入既有迁移阶段；不扩展到项目或插件自动改写。
2. 同步 Todo 96 中“Markdown 不自动重写”的旧条款，并标注本项为新裁决；具体 effectiveSelection 执行接入仍由 Todo 96 完成。
3. 先写纯转换/文件测试，再改统一读写及迁移边界；删除不必要中间格式分支，清理导出前查实际引用。
4. 按审计表处理明确缺口。不可恢复的旧记录保留既定未迁移边界，不猜值；不得以保留旧读取兜底来假装迁移成功。
5. 补齐设置保存与 child 冷启动证据，使用隔离 fixture，不操作同事真实数据。实现时遵守 Agent/Design/E2E 指令，跑 `pnpm typecheck`、`pnpm lint`、相关单测与 MacBook Pro E2E；记录未运行项。
6. 二次复审每个入口“迁移前 -> 写入完成 -> 重启正式读取”，保存测试、差异与裁决轨迹。两个原则及表格未验收完，不得将本 Todo 标完成。

本次 graph delta 仅增加 model-selection / subagents 的本计划引用。当前无新增 UI surface 或业务 owner；实现后再更新事实不变量。E2E handoff：使用真实旧字段样本的隔离文件 fixture；保存产物和实际 child 选择分别断言，不用仅表单截图代替落盘/执行证据，不依赖定时 sleep。

## 7. 实施、验收与二审（2026-09-08）

| 用例 | 当前结果 |
| --- | --- |
| SA97-01/02/03 | 纯转换与文件集成通过；两种旧编码离线固定迁移，BOM/CRLF/注释/正文保留；重启幂等，后来加入的旧文件仍可导入 |
| SA97-04 | Host/Agent 正式 codec 一致；Pro SE 三条创建/编辑落盘及 I20 冷启动 child 共4项通过 |
| SA97-05 | 中间态 modelSelection 无读取/逆迁移分支；正式 serializer 不再产生该字段，负向测试通过 |
| SA97-06/08 | JSON 当前 map 的空/坏/缺档位不回读旧双 map；Host/独立 Agent 初始化先导入落盘，旧 map 只留回滚；I20 从旧 JSON 验证 child/high |
| SA97-07 | 并发初始化、写失败重试、写前外部编辑、临时文件清理测试通过；不宣称能锁住不遵守应用文件锁的外部编辑器全部竞争窗口 |
| SA97-09 | 用户/项目/插件三份同内容 CRLF 文件，实际调用各 loader 连续两次，只有用户文件 Provider 身份改变，项目/插件文件及其显式旧身份不变；另有符号链接、只读文件不写的文件测试。没有为未迁移身份新增内存 alias |
| SA97-10 | 全域审计已落表；发现 Session 普通 codec 回读旧 thoughtLevel，已移到 SQLite 单向导入并通过23条测试。Wiki 剩余边界已由 §8 完成；Off-Peak 保留已裁决专用例外 |

- 扩大回归：根61文件/900条、Agent17文件/201条通过；随后新增 custom: Provider 编码冲突红灯并修复，共享 Subagent 3文件/25条通过。
- 根 typecheck/lint、Agent bootstrap typecheck 通过；Lint 41警告/0错误，存量警告及94遗留清理另记。
- 二审删除旧全 profile 内存转换 helper 和 Host 重复 parser；普通 reader 不查当前连接，不做历史兜底。内部协议 ModelSelection、运行中冻结选择、最终 Registry 校验、continuous/replayable 和目标 Workspace 边界不变。
- 同步 subagents 图谱种子与事实不变量；详细代码、发布依据、例外及运行证据见审计表。显式 Subagent 的 Worker 本地解析后续已由 Todo99 完成，不再列为待裁决协议。

## 8. Wiki 剩余边界执行契约（2026-09-09）

- 本节取代 Todo96 的 Wiki“读取旧字段只做内存转换、不写文件”例外。真正旧 `wiki.json` / `draft.json` 首次加载进入明确迁移入口，落盘成功之后正式读取只消费 `modelSelection`。
- 迁移只识别已发布的 `generationModel`、`generationOptions.thoughtLevel`。新字段存在（包括 null、坏值、旧 ID 的未上线中间态）即为权威，不转换新字段身份，不从旧字段补值；无可导入旧选择时以 null 记录已处理，不猜默认模型。
- 离线导入复用既有 Provider 身份迁移，不查询账号、连接、Registry 或 View。仅移除旧选择字段，保留页面正文、目录树、元信息及不相关 options；不重写 task 或 draft page 文件。
- 在现有异步文件锁内重新读取并决定是否迁移，再原子写入；普通写入、删除目标文件使用同一锁。迁移失败保留原文件、抛出错误，下次正常加载可重试；已迁文件再次读取不写盘。不增加后台迁移调度或同步协议。
- 正式读取仍按当前 schema 校验新选择。网络/Provider 不可用不能导致迁移选择置空，实际生成继续使用公共有效选择解析，固定运行和恢复不重绑。
- SA97-W01：真实旧 Wiki/Draft 首次读即落盘，重建 Storage 后幂等；SA97-W02：新字段空/坏/中间身份不回退，未知字段和正文保留；SA97-W03：写入失败可重试、并发迁移/保存/删除不覆盖或复活；SA97-W04：Pro 旧 Wiki 冷启动阅读、模型/档位回显、正文切页、迁后文件稳定与删除回空。

```text
旧文件预读 → 发现旧字段 → 文件锁内重新读取 → 离线导入 → 原子落盘
                              ↑                         ↓
                         与保存/删除同锁          正式 reader 只读新字段
```

### 验收与二审结果

- Wiki 相关 10 文件 / 146 条单测通过（含新增 11 条文件迁移测试）；全仓 typecheck、lint 通过（39 条存量警告、0 错误），diff 检查通过。已有 Authority 测试中的“真正旧结构读取不写盘”断言同步改为最新裁决，当前格式读取不写盘的其他断言保留。
- SA97-W01/02/03：独立文件测试覆盖 Wiki/Draft 离线迁移及重启幂等、未知型号/档位保留、新字段空/坏/中间态不回退、原子写失败重试、并发读只写一次、预读后保存/删除的锁内复查，以及迁移写入中删除需同锁等待。
- SA97-W04：Pro `desktop-e2e-20260909-122856-891` 1/1 通过：应用退出后注入真正旧 Wiki，冷启动模型/high 回显，首次读取文件已迁移且正文结构不变，切页后文件字节稳定，删除回空。未请求模型服务。
- 二审纠正：保留磁盘未知选项不能恢复 Todo94 已撤销的运行时 `maxOutputTokens`。正式 reader 仍移除该废弃选项；当前有效选择、生成冻结、后台恢复与输出 Limit 权威均未更改。
- 生产修改限定 `repoWikiStorage.ts`；没有引入 Account/Provider 依赖、定时迁移器、协议变化或另一份选择权威。原子锁只协调遵守该锁的应用进程，不宣称防住外部编辑器任意写入。桌面 continuous / 手机 replayable 均复用所属 Host Storage，不改变消息流与 workspaceIdentity。
