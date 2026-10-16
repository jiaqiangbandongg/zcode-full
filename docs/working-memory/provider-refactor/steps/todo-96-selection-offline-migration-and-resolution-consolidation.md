# Todo 96：Model Selection 离线迁移与有效选择解析收口

> 状态：实现已收口；2026-09-09。离线迁移、恢复原意图保护及目标派发已完成；最后的显式 Subagent 接入由 Todo99 通过 Worker 本地公共解析与 DI 完成，并有 Pro 执行证据，不再等待旧 Host RPC 方案裁决。原过程见 [执行记录](../research/todo94-97-execution-and-review.md)，后续见 [Todo99 账本](../research/todo99-implementation-review.md)。残余跨端验证统一转交 Todo102，不宣称全端通过。
> 核心裁决：除闲时任务外，旧 Selection 的迁移不依赖当前连接、登录、权益或 Provider 模型配置。迁移保存原意图；当前可用性及账号对应统一通过 `getView({ selection })` 取得 View 和 effectiveSelection。Provider 临时异常不能破坏原选择，尤其是 SSH 远端场景。

> 后续裁决：[Todo 97](todo-97-subagent-markdown-in-place-migration-and-legacy-read-audit.md) 将用户数据目录里的 Subagent Markdown 改为在正式保留的 `model` / `thoughtLevel` 原字段中迁移，替代本文“Markdown 不自动重写”对用户目录的旧限制；项目、插件及其他来源全部不自动迁移或写回。未上线中间格式不做兼容，旧字段仅限迁移使用，并专项复审整个 Selection 迁移链路。本文“当前字段优先”只适用于最终正式格式，不能据此保留 Markdown `modelSelection` 中间态。有效选择执行接入仍由本 Todo 负责。

## 1. 新裁决与范围

- 旧 BigModel / Z.ai Coding Plan 固定迁为**同域 Individual Provider**，不再依据迁移时当前个人/Team 连接决定身份。Individual 只是旧意图的确定性迁移落点，不表示历史请求使用过个人套餐，不开通或切换账号连接。
- 后续由已有有效选择解析对应到当前 Account Provider 的同模型、同档位；不另造 Provider 替代机制，不让 Registry 校验偷偷替换 Provider。
- 当前不可选的模型、档位不妨碍旧意图迁入；临时有效结果仍可以为空或缺档位。
- 闲时任务的迁移、Provider/Ticket 绑定本轮排除，不机械迁成个人套餐。
- 不新增 Account / Off-Peak 两种逻辑 Selection 选项；该讨论已搁置。不新增 Selection 持久格式或存储版本来完成本项。
- 不自动修复已经被旧实现写空的新版记录，不重新从旧文件覆盖当前字段。若需要恢复存量损坏数据，另行确认精确范围。

本 Todo 修改 [Todo 72](todo-72-legacy-builtin-provider-and-model-selection-migration.md) §3.2/§4 中“依赖当前已登录连接迁移旧 Coding Plan”的裁决；沿用 [Todo 87](todo-87-selection-view-unified-resolution.md) 的公共解析、原意图保护及目标 Host 权威，并补齐入口；衔接 [Todo 88](todo-88-provider-audit-regression-repair.md) 的历史恢复与 Subagent 边界。旧文档描述的是此前裁决/实现，不能将本计划标成已实现。

## 2. 已调查的当前问题

| 入口/边界 | 当前事实 | 本项处理 |
| --- | --- | --- |
| 共享旧身份转换 | `legacy-model-provider-identity.ts` 的旧 Coding Plan 分支依赖 `currentAccountAccess` | 改为确定性映射，移除仅服务迁移的账号上下文 |
| Host 装配 | `node.ts` 的 `readMigrationAccountAccess` 经过账号设置准备、登录身份；旧 Team 缺组织时还可能间接等待 OAuth 查询 | Selection 迁移不再走此链；独立连接迁移和真实鉴权仍保留 |
| Session | 格式/身份迁移后，`create-app.ts` 恢复路径直接校验原 Selection，失败返回空 | 原意图必须到达公共解析，不能在入口前被丢掉；运行绑定仍严格校验 |
| 定时任务 | 旧列导入不查模型名单，但旧 Built-in 回调仍依赖账号；SQL NULL 保留重试边界 | 纯导入、保留当前字段优先和 CAS；当前有效结果用于原有首次派发边界 |
| Bot | 旧字符串必须命中当前候选名单；相同内容的结构化选择却不要求。首次导入写出 v3 后不再读旧文件 | 删除候选名单门禁，避免将暂不可用的明确意图永久写丢 |
| Wiki/Subagent 存储 | 旧账号 ID 通过 Host 回调转换；未能确定时可保留旧意图 | 换用纯转换；实际执行接入另按第 5 节核实 |

只读调查的证据：已用纯函数/内存 SQLite 和注入 resolver 复现旧 Coding Plan 随当前连接变化、Bot 候选为空时丢旧字符串选择、Automation 身份确认后不检查旧模型/档位即可导入。没有对真实用户数据做写入；这些是现状复现，不是本 Todo 的实现验收。

## 3. 迁移层：只转换确定的旧事实

| 输入身份 | 固定输出 |
| --- | --- |
| `builtin:bigmodel-coding-plan` | `account:bigmodel-individual-coding-plan` |
| `builtin:zai-coding-plan` | `account:zai-individual-coding-plan` |
| `builtin:bigmodel` / `builtin:zai` | 沿用 `bigmodel-api` / `zai-api` |
| 两域旧 Start Plan ID | 沿用对应的 `account:<family>-start-plan` |
| 正式当前 ID、明确的自定义 Provider ID | 原样保留，不要求当前 Provider 存在 |
| 无法解码、无法确认身份、退役且无对应的 ID | 保留既有未绑定/未完成边界，不猜 Provider，不回退默认 |

1. 模型 ID 原样保留；只从真正旧格式中搬运可确定的推理档位。不能因当前配置不支持而删除或补默认档位。
2. 迁移不得读取当前账号连接、登录身份、权益、Registry、Selection View 或模型候选；读取旧记录及静态身份映射是允许的。
3. 取消迁移入口对完整 `ZCodeAccountAccess` 的依赖；静态转换不等待登录、网络、远端连通或 Provider 初始化。
4. 保留格式校验。非法 JSON、错误字段类型不是“暂不可用模型”，不能借本项宽松解析全部吞掉。
5. 已有当前字段优先，显式清空不复活；坏的新值不靠旁边旧字段修复。明确旧 `builtin:*` 身份即使存于结构化字段，仍按既定升级边界识别。
6. 迁移幂等，保留旧文件/字段的既定回滚边界及原有 CAS/事务保护；不批量改写历史消息，不维护新旧持续双写。
7. 当前 API/Team 连接设置迁移、OAuth 查询、凭据请求自身不取消。只删除它们与 Selection 格式/身份转换之间的依赖。

## 4. 公共解析及三类状态

```text
旧记录
  |
  v
离线格式 / 确定性身份迁移
  |
  v
持久原 Selection / 用户最新草稿 ---------------- 保留原意图
  |
  + 目标 Host 当前已应用的配置与账号事实
  v
getView({ selection })
  +--> 候选 View
  `--> effectiveSelection / selectionIssue ------- 临时可用性
               |
               v
        接纳 / 首次派发，固定具体选择
               |
               v
        ModelFactory / Registry 最终校验 -------- 执行权威
```

- Account 对应、模型不可用置空、档位不可用只清档位，复用现有公共解析语义。普通 Provider 不因此获得跨 Provider 同名匹配；缺模型不取首项，失效档位不补最高档。
- 清理恢复/展示入口中重复的可用性判断和提前置空，不能只删校验却继续丢失原输入。原意图须完整传到 `getView`。
- 最终 Model 构建校验、运行时绑定保护保留；禁止为了“统一”把无效原选择直接塞进 Runtime。
- 读取、刷新和失败不写空原意图。保存文本、标题等无关字段时，不把临时空 effectiveSelection 一并覆盖原选择。
- Composer 中主动清空/改选只改变当前草稿意图，立即按新草稿重新解析；不能仅因菜单点击或 View 更新就写回 Session 的正式选择/Recent。
- 下次发送成功被接纳时，才按该次实际提交的有效选择更新正式选择/Recent；不等待模型生成结束。未发送或提交失败不覆盖上一次正式选择。尚未完整的清空草稿不得自动补默认模型并提交。
- 草稿自身的跨重启持久化是另一层：本项不顺带删除已有 Draft 保存机制；即使保存草稿，也只能保存用户草稿意图，不得拿临时空 effectiveSelection 替代，更不能因此更新正式会话选择。
- 设置页、定时任务/Bot/Subagent 配置编辑仍以各自明确的保存/提交动作落盘，不强行改成“等待发送消息”。成功提交的写回检查原意图与 scope 未被后续编辑替换；不新增全局自动写回机制。
- 定时任务长期配置只在原显式编辑保存边界改变；本次 run 在原首次派发边界冻结。已固定的 run、Active Model、历史请求不重解释。
- “迁移未完成/原意图不可用”不等于“从未指定模型”；后者原有默认/继承规则保留，前者不能静默进入默认执行。

## 5. 逐入口实施清单（共享解析，不共享保存副作用）

| 级别 / 入口 | 共享点、改动种子 | 展示/意图及提交落点 | 保留边界 |
| --- | --- | --- | --- |
| 必改：Session/Composer | Agent `model-selection-migration.ts`、`create-app.ts`、Host 返回链、`SessionPane` 与共用 View hook | 清空/改选只改草稿；正式选择/Recent 在发送被接纳后更新，Draft 自身持久化单独处理 | 原选择不因 Runtime 暂不能绑定而丢失；并发编辑胜过迟到结果 |
| 必改：Automation | `automationSelectionMigration.ts`、`automationRepo.ts`、`automationModelSelection.ts`、编辑页共享选择控件 | 旧列导入当前列；长期配置/每次 run 分离 | 首次派发消费有效结果，不重解析已冻结 run |
| 必改：Bot | `storageMigration.ts`、`bots/repo.ts`、`botsService.ts`、选择交互 | Config/State 各自 v3 存储；有效结果只用于所属交互/执行 | 候选为空不抹去已解码意图，远端失联不采用本地状态 |
| 必改：Wiki | `repoWikiStorage.ts`、Wiki 生成选择解析与共享控件 | 读取保留意图，新生成使用有效结果 | 不修改正文/输出预算（Todo 94）；旧文件一次落盘迁移由 Todo97 §8 接续，之后读取不写回 |
| 必改并单列接入：Subagent | `subagentsService.ts`、Agent profile 初始化、显式模型启动路径 | 内置覆盖/Markdown 原意图与本次子任务实际模型分开 | 不能只改设置页；未指定模型继承父任务，Markdown 不自动重写 |
| 检查：Recent/Default/其他草稿 | 现有 Reader、调用公共解析后的保存路径 | 原有偏好/草稿 owner | 只处理实际存在的旧格式，不凭共享类型造新迁移器，不改变全新默认行为 |
| 排除：闲时 | 既有 Off-Peak 专用 resolver、Repo、Ticket | 保持原流程 | 不跨域重绑、换票或套用普通 Coding Plan 迁移 |

**Subagent 的额外边界：** 当前显式模型在 Agent 内独立校验，并非已经调用 Host `getView`。统一迁为 Individual 后，当前 Team 场景必须能取得正确的有效结果，不能把它当成“删除冗余检查”完成。先查清可复用的 Host/Agent 接入点；如需要新增或扩展 App–Agent 协议，提交具体契约供用户裁决，再实现。不得增加 Agent 内另一套账号解析，也不得宣布 UI 支持等于后台支持。此项未解决时不能将全入口统一标成完成。

## 6. SSH / Web 的重点保护

```text
SSH 断开 / Provider 尚未同步 / 账号状态异常
        |
        +--> 旧数据仍可做纯迁移，原意图保留
        `--> 目标 View 未就绪或有效结果不完整，不执行

目标 Host 恢复 / 配置事件到达
        |
        v
以保留的原 Selection 再次调用公共读取
        |
        v
恢复当前有效结果，而不是依赖已被写空的值
```

- UI/后台消费目标 Host 的权威结果，不用本地 Provider 为失联远端补选；离线迁移也不主动建立 SSH 连接。
- View 未就绪/读取错误与已就绪但不可选分开，沿用公共 hook 通知及恢复机制，不新增轮询、无限等待或发送前同步屏障。
- 保持 `workspaceIdentity?.trim() || workspacePath` 的隔离和 remoteSessionId 边界。相同路径的本地/不同远端不能串选择。
- 桌面 continuous、手机 web-remote replayable、shared-host attachment 不改；本项不重做消息恢复或跨 Host 调度。

## 7. 验收用例与执行顺序

| 用例 | 条件 / 动作 | 必须证明 | 证据 |
| --- | --- | --- | --- |
| SM96-01 | 同一旧选择，分别在未登录、个人、Team、Start、另一账号域及空 Provider 配置下迁移 | 新 Selection 字节级等价；账号/Registry/网络依赖未被调用 | 参数化纯转换、各 importer 单测 |
| SM96-02 | 旧 Coding Plan 固定迁为 Individual，当前 Team 有同模型/档位 | 经 `getView` 得到 Team 的有效选择；无需 Individual 可用 | 公共解析、Session 恢复集成与 UI E2E |
| SM96-03 | Provider/模型暂缺或档位不支持，读取并保存其他内容，再恢复配置 | 原意图保留；有效结果按层级留空并可重新恢复；没有默认执行 | 存储前后对比、UI/服务测试 |
| SM96-04 | Bot 首次导入时候选为空；分别使用旧字符串/结构化选择 | 明确的 Provider/模型/档位都保留到 v3，重启不丢；旧文件不变 | Bot 文件导入/重启测试 |
| SM96-05 | 定时任务、Wiki、Bot 读取与派发；已有冻结 run | 读取不产生选择写回；各提交边界正确；冻结记录不改变 | 各业务集成、代表性交互 E2E |
| SM96-06 | SSH 断连、配置尚未同步、账号失败后恢复；本地有不同模型 | 迁移不等 SSH、不借本地；原记录不变，恢复后可重新解析 | 隔离远端 fixture、协议/存储及实际有效选择 |
| SM96-07 | 新字段存在、显式清空、损坏字段；迁移期间用户改选 | 不回读旧字段或猜默认；CAS/事务不覆盖新编辑 | 存储并发/优先级测试 |
| SM96-08 | 显式 Subagent 的旧 Coding Plan，当前为 Team；另测未指定模型 | 实际 Agent 执行采用统一有效结果；继承行为保持 | 接入方案裁决后补 Agent 集成，不以设置页测试代替 |
| SM96-09 | 已有闲时任务、Ticket、历史请求 | 此轮未改身份/票据/运行记录 | 差异审阅与现有回归 |
| SM96-10 | Composer 改选/清空但未发送，提交失败，再成功发送；期间再次编辑草稿 | 点击和失败不更新正式选择/Recent；成功接纳才保存本次实际选择，迟到结果不覆盖新草稿；Draft 保存不与正式选择混用 | 草稿/Session/Recent 分层断言与交互 E2E |

1. 更新相关事实规范和 Todo 72/87/88 的被替代条款，保留历史裁决轨迹；记录 Subagent 接入方案。UI/API/存储不新增上轮搁置的逻辑选项。
2. 先写纯迁移不依赖当前环境的测试，再修改共享转换及各调用方，删除 Bot 名单校验。
3. 沿各入口的“原输入 -> View -> 有效结果 -> 保存/执行”核对，补测试后收口重复逻辑。不能把所有 Registry 校验一删了之。
4. 接入 Subagent（如需协议变更先裁决）；核对后移除确实无消费者的迁移回调、参数和 RPC。清理前查引用，禁止为了删 RPC 保留半套后台行为。
5. 实现阶段使用对应 AGENTS、UI DESIGN、E2E 技能；更新 Session 覆盖目录/矩阵，执行 `pnpm typecheck`、`pnpm lint`、相关单测及 MacBook Pro E2E。用隔离旧数据/模拟账号，不对真实用户数据进行破坏性验证。
6. 二次复审数据写回、远端身份隔离和实际请求使用的选择。记录通过、未运行、环境失败与待裁决项，提交后再标完成。

## 8. 执行与裁决记录

| 项目 | 当前状态 | 收口要求 |
| --- | --- | --- |
| 统一离线迁移与 Individual 固定落点 | 已实现、定向回归通过 | 替代旧当前账号绑定规则，所有 importer 结果与环境无关 |
| 公共 View 解析及原意图保护 | 已实现，显式 Subagent 由 Todo99 补齐 | 删除重复规则，保留最终执行校验及正常保存边界 |
| Bot 首次导入依赖候选 | 已修复并验证 | 新版文件不再固化临时不可用为空 |
| 显式 Subagent 执行接入 | Todo99 已完成并验证 | Worker 本地公共 Facade/DI；显式解析，隐式继承及内部 override 保持冻结，不采用旧的逐请求 Host RPC 提案 |
| 闲时任务 / 逻辑 Account、Off-Peak 选项 | 排除 | 不顺带实现 |
| 已写空新版记录的恢复 | 排除，必要时另行裁决 | 不自动重导入旧文件 |
| 单测/集成/Pro E2E/二次审阅 | 核心通过，显式 Subagent 后续证据见 Todo99 | 真实 SSH/手机残余验证转交 Todo102，不再作为本 Todo 独立待办 |

影响面梳理沿用 feature-boundary-planner 的 model-selection 种子和现有调用链。当前无 codegraph 工具，调查采用定向代码阅读和内存复现，未声称全量调用图验证。功能图只增加本计划引用，不将计划改写为已实现不变量；正式实施后同步 [Selection State](../design/interaction/selection-state.md) 与相关覆盖文档。Todo 95 的档位改名兼容仍是独立任务，不借本项顺带改模型档位。
