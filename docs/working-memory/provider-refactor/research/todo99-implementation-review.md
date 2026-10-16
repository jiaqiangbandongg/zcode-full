# Todo99 实现复审与验证账本

日期：2026-09-09。基线 `86bbe157c88e8e599694afb53c39f6dac125ac08`；实施在 recovery worktree，未覆盖同时存在的其他 Provider 文档/迁移改动。范围以 [Todo99](../steps/todo-99-worker-account-selection-repair.md) 的收缩裁决为准。

## 1. 影响面与状态所有权

本轮没有新增页面、菜单或 ModelFactory。UI 仍消费同一目标 Host 的 View；改变的是 Host/Worker 交付、显式子任务解析及 Bot/附件派发。桌面、手机的展示表面相同，不意味着可以混用 delivery 或工作区身份。

```text
设置/身份/权益 -> Account 结果 -> Host 已应用 Registry
                        |
                  既有 Client 队列（read + RPC）
                        |
                 Worker Source：received
                        |
             配置来源匹配 -> Registry 整体 applied
                        |
           公共 Facade + 原选择 -> 临时有效选择
                        |
                提交/派发固定本次选择
                        |
                ModelFactory 精确校验
```

| 状态 | 唯一 owner | 本轮明确不做 |
| --- | --- | --- |
| 原持久选择 | Session、任务或 profile 原存储 | 不在查询/刷新时写空；不新建 Bot 绑定选型 |
| 账号 current/权益/动态模型 | Host Account Source 的同一份结果 | 不将 current 写入 Provider 配置；不扩大到普通 Provider/闲时 |
| Worker 可执行集合 | Worker 已应用 Registry | 不把 Source 已收到当成已应用 |
| 本次模型 | admission 固定 Selection / Active Model | Factory 不 remap，不因后台更新替换固定请求 |
| 手机连接与恢复 | 既有 shared-host attachment / replayable | 不另起手机 Host/Agent，不改变桌面 continuous |

## 2. 五项修复逐项复审

| 项目 | 实现与证据 | 未夸大部分 |
| --- | --- | --- |
| P100-01 完整 states | shared 严格 schema、Host 序列化、Worker parse/source 全程携带；普通托管账号 entitled=true 缺 current 拒收。真实 Built-in 测试个人→Team→个人的 Registry 集合与 Facade 结果 | 单机进程内往返不等于真实 SSH 部署升级验证 |
| P100-02 收到/应用 | 改为 receivedRevision；失败不记录收到成功。同值 replace=false 仍 refresh。协议 Server 调生产交付方法验证 Source B/Registry A，再配套配置 B 应用 | 沿用 ensure/队列，没有重建生命周期或新增 latest barrier |
| P100-03 显式 child | Node Facade 构造器由 Host/Worker 共用；通过 DI 传至 Core、Workflow、Script。override 优先；显式失败不能继承；隐式保留父 Active Model | 普通 child 和 Script child 的现行配置禁用再次创建 Subagent，不能为测试虚构可用的无限嵌套功能 |
| P100-04 Bot | 绑定后 read Session 完整原选择→同一 View→send 传有效选择；无效不派发、不改原意图。`/model` 和 reasoning 立即保存同一 Session，完整 setter 先校验后保存 | synthetic Bot harness 不是飞书/真实 Worker 请求的替代证据 |
| P100-05 附件 | task adapter、Agent 参数、严格协议及 Core intent 均携带 Selection/modelExecution；执行凭据只进非持久依赖。legacy 后台等待真实 completion 再释放本轮归属/controller | 不把 legacy send 构造成新的 V4 replay/ACK 通路 |

实际创建链新增证据：`workflow-effective-selection.test.ts` 运行真实 Workflow child，由其 Agent 工具启动显式 Subagent，断言最终模型执行使用新 Provider、父 Session 和 profile 未改。

`session-selection-cold-resume.test.ts` 创建真实已落地 Session，完整 setModel 后关闭 App/SQLite，重新打开数据库和 App 并 resume，最终模型执行观察到同一 Provider/模型/high；非法完整选择不留下半次修改。Model executor 是隔离替身，因此是运行时集成证据，不写成线上模型或跨端 E2E。

## 3. 消费入口逐项结论

| 入口 | 核查结果 / 决策 |
| --- | --- |
| Composer | `useModelSelectionView` 订阅目标服务；携带原意图的消费者在事件后重读，不直接接受无调用者意图的广播结果；generation/requestId 丢弃旧回包。读取失败保留 ready View。既有测试通过；本轮未改 React |
| 定时任务 | `automationModelSelection.ts` 在新提交边界 getView(selection)，有 issue/缺档位失败，返回 effectiveSelection；未指定选择才用 preferred。固定 run 不重新解析。既有测试通过 |
| Wiki | `RepoWikiModelClient.readConfig(resolveIntent)` 明确区分新生成和固定后补页。前者携带选择取得有效值，后者保持已固定配置；workspaceIdentity 传递至目标读取。相关既有测试通过 |
| 显式/隐式 Subagent | 显式走 Worker 本地公共端口；隐式、内部 override、执行范围不 remap。实际 Agent 工具测试及恢复 child 再输入测试均有请求断言 |
| Workflow | 真实 Workflow 子 Runtime 的显式 profile 已验证；父 Workflow 本身继承原 Session 执行约定，不为它自动另选模型 |
| Script | `agent(..., opts.model)` 是现行显式程序调用参数，精确 provider-qualified 选择；无参数继承父选择。Script child 禁止再启动 Subagent，但 DI 仍传递。未借本轮更改这项程序接口语义 |
| 标题 / Goal 标题 | sidecar 使用显式 title 配置或 Session 选择，精确创建后应用已有辅助低成本选项；并非任意 UI 草稿消费。无新增 UI 独立选模入口，本轮不改其合同，不声称它已自动跟随账号 |
| Compact | 运行中优先复用输入 Active Model；缺省独立路径按 Session 精确创建。不能把压缩内部每次请求当新用户意图；本轮保持，不在 Factory 偷换 |
| Memory | Extraction 捕获产生工作的 Model；Dream 缺省从 Session 精确创建。`captureProjectMemoryAgentContext` 固定模型和上下文；本轮不重新定义 Dream 调度合同 |
| Off-Peak | Ticket/selectionScope/requestAuth 与输入一起固定；附件补齐执行依赖，原 Ticket 不跨账号迁移；内部 override 不因 profile 失败而被阻断 |
| Bot busy/Guide/queue | 本轮解析只加在空闲新输入分支。既有 busy 分支保持 CommandInbox/已接纳输入语义，没有出队 remap 或第二份 accepted queue |
| 手机/SSH | 新读取使用 task target 的 workspaceIdentity；Session setter/附件协议复用原服务，不改 attachment、owner/lease 或 deliveryKind。实际部署/多端同 Session 仍需单独产品证据 |

这里的“保持”不表示所有历史辅助功能都已实现未来多账号产品；只表示不与 Todo99 已裁决的新意图/冻结执行边界混淆。Todo101 不在本轮范围。

## 4. 两项局部竞态

### R100-02：已复现并局部修复

可控 Source.read 延迟使旧实现日志交付顺序成为 account-4→account-3；原队列只串行 RPC，没有串行读取。将 read 移入同一 Client 原队列，测试先失败后通过，完整 Host providerRegistry 测试 14/14 通过。不新增合并队列/时钟/重试。

### R100-01：可观察作用域切换已复现并局部保护

隔离内存实验：readSettings 先得到 A 的个人选择，随后身份变 B、设置变 Team；身份/API 查询使用 B，却输出个人 current=true、Team current=false。不是“任何异步都有问题”的猜测。

Resolver 现在复制本轮设置，结束时重读身份与设置；可观察到变化就拒绝本轮结果。特别保证拒绝前不更新 previousScopes，否则未发布的 B 会污染 last-known-good 判断。两种交错测试（切连接、切身份）先失败后通过，随后成功轮仍能正确 resetPrevious。

限制：没有引入全局单调账号 generation，不能声称解决所有 A→B→A 或查询完成后又切换的跨服务原子性。沿用原 AccountService 事件/失败恢复，允许完整旧快照暂时可用；未来全局账号装配改造另行处理。

## 5. 验证账本（持续追加，不以部分通过冒充完成）

本轮已跑：

- Bootstrap 账号、协议选择、Session facade、Provider runtime、Workflow：6 文件 28 条通过；另新增 SQLite 冷恢复 1 条通过。
- Core/Subagent/Script/Workflow/协议整组：167 条通过、1 条失败。失败是基线远程 Cron denylist，详见下节；不是全绿。
- Host providerRegistry：14 条通过，包含延迟读取倒序回归。
- 账号 Resolver + AccountService：24 条通过。
- Composer hook、定时派发、Wiki client/target、AccountService：5 文件 38 条通过。
- 根 `pnpm typecheck` 通过；bootstrap `tsc --noEmit` 通过；`pnpm lint` 0 error、39 条既有 warning。上述检查需在最终增量之后再跑。

测试夹具纠正：process-provider-registry-runtime 的旧模板缺 nameMap/config 外壳、模型缺必填 reasoningLevel、Personal fixture 携带废弃 matchRules 导致4例失败。只对齐测试输入，不放宽生产 Schema，不新增未上线格式兼容；完整10例恢复通过。

产品验证：Air 新建隔离目录 `/Users/dev/zcode-todo99-e2e.AurUlf`，未碰运行中的日常 App；离线安装因私有 CUA Git 依赖仍触发钥匙串 -25308 失败。用户已授权改用 Pro，管理 SSH 已可用，隔离目录 `/Users/dev/zcode-todo99-e2e.1lO3PN`。W99-E01..06 在取得对应请求/进程/跨端证据前仍保留 pending；不得凭本页集成测试直接晋级。

### 另外发现的既有失败

`zcode-protocol.test.ts` 的“远程 SSH/WSL 默认禁用全部 Cron”仍失败：实际 denylist 只有 Bash，预期另有4个 Cron。基线已有同样差异；生产源码保留未使用的远程工具常量/identity import。未为了本项全绿删除断言，也未擅自改 Cron 产品语义，需单独核对原禁用合同。

## 6. 文档与图的校正

Codegraph 当前不可用；按实际符号/调用链审查，不声称全仓索引。功能图的旧“显式 Subagent 仍等待协议设计”已按本轮实际 DI 装配更新；补 Node Facade、Subagent resolver codeSeeds 与 Todo99 链接。生命周期统一、独立 CLI、迁移及 Todo101 明确不纳入。

同时纠正 Agent tool 链路文档的陈旧段落：Markdown 正式字段已由 Todo97 裁决回 `model` / `thoughtLevel`，不能继续写成未上线 `modelSelection` 的双读优先级；这是文档校正，本轮没有新增迁移代码。

## 7. Pro 实机与最终收尾（2026-09-09）

测试目录 `/Users/dev/zcode-todo99-e2e.1lO3PN`，Node 24.14.0、Electron/Chrome 146；使用当前 worktree 源码的隔离副本，不改 Pro 日常数据或 Git checkout，不操作钥匙串。代码基线如页首，加本次待提交 Todo99 变更。构建缺 `.git` 时显示 unknown，因此不能以构建内嵌版本代替这里记录的来源。

| 用例 / run | 结果与实际证据 |
| --- | --- |
| `conversation-session-model-provider-effective-selection`，`desktop-e2e-20260909104713317-p13081-192c13543a9c637f` | 2/2 通过：未发送原选择保留、Team/high 实际请求、旧定时选择实际派发 |
| `conversation-session-worker-effective-selection`，`desktop-e2e-20260909111544019-p19700-8c54b26069ee4be6` | 3/3 通过：W99-E01、E02/E03/E06、E04，详见下述证据分层 |
| `bots/manual-review/pending/bot-effective-selection`，`desktop-e2e-20260909112059410-p20639-1fd964b954aa4d72` | 5/5 通过：绑定后可用/不可用、主动设置最高档、首次派发/菜单保留原意图；此组仍是 synthetic task harness |

每个 run 的 `summary.json`、`summary.md`、`test-results.ndjson` 位于上述测试目录的 `packages/desktop/.e2e-artifacts/<run>/`；模型请求证据另在 `network-capture/coding-plan-data-plane.json` 与 `upstream-provider.json`。大体积 WDIO 日志不入 Git。

- E01 使用真实 Electron、Host、Agent 工具和 child Runtime，捕获 adapter model-io：profile 原个人 Provider→实际 Team 同模型/high，父会话仍用 DeepSeek，Markdown 字节未改。
- E02/E03/E06 是实机 Node Host→真实 stdio Worker，不伪称点了手机页面。Bot 入口复用生产 Task adapter；只有 IM 与账号上游/模型 HTTP 是隔离替身。下一轮请求 Team/high，`/model` 立即 max、`/think low` 立即保存，dispose Worker 后 resume 保留 low；附件使用 execution/high 且 FIRST/SECOND 有序，Session low 不被覆盖。
- E04 受控保持 Worker A、Host B；原测试先暴露真实缺陷而非仅 fixture 问题：ModelFactory 在内层 Turn catch 外失败，只记录日志，没有 TurnError/V4 错误。新增 Core 红灯测试证明事件为 0；局部修复创建 Model 的 catch，复用既有 outcome 后单测及 Pro 都通过。验收包括 `turn.failed`、V4 `phase:error`、未发新模型请求、Session 原选择不变；交付 B 后重新提交实际成功。没有新增发送同步屏障。
- 3 个新用例不直接晋级 formal。fixture check 通过但有 marker warning：Account 请求由既有独立 Coding Plan mock 数据面处理；拒绝 marker 本来不应发 HTTP；`E2E_PLAN_NON_DEFAULT_MODEL` 是常量名、PARENT_DONE 是响应文本。DeepSeek 的两次父请求在 case-local manifest 中记录为 synthetic/fast-text。后续 Docker/formal 晋级需按原人工流程收齐相应 fixture，不以当前 warning 当生产请求异常。

最终检查：根 `pnpm typecheck` 通过；`pnpm lint` 0 errors、39 既有 warnings；Core build、Bootstrap typecheck、desktop typecheck:e2e 通过。Host/shared 定向 7 文件 **257 条通过**，Agent/Core/Bootstrap 定向 10 文件 **81 条通过**，既有 desktop/remote/web service 回归 6 文件 **42 条通过**。这些计数是各轮范围，不把重复运行累加为独立用例数。之前全协议组的既有 Cron 失败仍保留在第5节，未冒充全仓全绿。

**最终二次裁决：**用户回复“还没有，你甭管了先”，明确暂放同版本 Web 页及 W99-E05 手机 shared-host＋SSH 联合实机。本轮实现与审查可收尾，不宣称该项通过。同步生命周期、A→B→A 全局事务、独立 CLI、Todo101 仍按原裁决不做。发布 Host/Worker 必须使用同一批协议制品；本轮未替用户部署 Web 包。

### 已提交源码的独立复验

实现提交：`b4ffe44db0`（`fix(provider): complete worker account selection repair`），未推送。提交后把 Pro 隔离副本里的其他未提交迁移源码/测试还原成该提交的文件，不改本地原工作区。重新构建 Desktop 和 Agent，Worker 有效选择 spec **3/3 再次通过**：`desktop-e2e-20260909112629814-p20925-4b9a692d8243878d`，artifact 路径规则同上。

另按 Git blob SHA-1 核对 `packages`、`apps/zcode-cli`、`config` 下 `.ts/.tsx/.json/.mjs/.cjs/.yaml`：**6,754 个文件与实现提交一致，0 差异**（首次唯一差异为未同步的新 Core 单测，随后补齐；不影响此前执行制品）。这避免用混入其他 dirty 生产源码的测试结果替本次提交背书。未把部署包版本 unknown、构建缓存或旧通过记录作为来源证明。
