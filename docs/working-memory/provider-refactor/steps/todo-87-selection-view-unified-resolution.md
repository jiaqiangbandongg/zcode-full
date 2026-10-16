# Todo 87：Selection View 驱动的统一模型选择解析

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。 显式 Subagent 的旧暂缓条款已由 Todo99 实现取代；Off-Peak Ticket 例外和不增加发送前同步的边界不变。

> 状态：已实现并分组验证/提交，2026-09-07；新 E2E 保留 pending 等待人工转正。原意图与当前有效结果分离，具体证据见 Todo85 恢复审计表；显式 Subagent 和闲时跨账号/Ticket 迁移已明确排除。
> 来源：Todo 85 的 D02。不是恢复旧 Family 自动切模 helper，而是在当前选择架构中实现同等体验。
>
> 2026-09-08 后续：[Todo96](todo-96-selection-offline-migration-and-resolution-consolidation.md) 将普通旧 Selection 迁移改为离线确定性转换，并核对所有原意图到 View 的入口；显式 Subagent 的 Host 执行解析另行请求协议裁决，未完成前仍不得宣称后台已统一。闲时 Ticket 的排除保持不变。用户 Markdown 格式与迁移范围由 Todo97 接续裁决。

## 1. 目标与裁决

账号连接、Personal Config、Built-in Config 更新，都经过现有刷新链形成新的选择事实。调用方传入自己保存的原 ModelSelection（编辑中则为用户最新意图），从统一入口取得带 effectiveSelection 的 View。自动重算不覆盖原意图；Composer、定时任务、Bot、闲时任务等不能各写一套账号替换或失效处理。

```text
Account / Personal / Built-in 更新
               |
               v
目标 Host 发布一致的选择事实
（模型候选、档位、账号连接，同一 revision）
               |
原 ModelSelection -> 统一读取/解析入口 -> 带 effectiveSelection 的 View
                                             |
                         +-------------------+------------------+
                         v                                      v
                  临时展示/准备执行                   明确保存/提交成功边界
                         |                                      |
                         v                                      v
              固定本次执行 -> ModelFactory                  才允许写回原选择
```

- 普通 Provider：只检查原 Provider/Model；模型失效置空，档位失效只清档位，不找别的供应商。
- 普通账号套餐 Provider：按目标 Host 当前账号连接对应到目标 Provider，优先保留完全相同的 modelId 和 reasoningLevel；没有同档位则档位置空，没有同模型则模型选择置空。
- 档位按值匹配，不按中文显示名、数组位置或“感觉相近”转换；模型按正式 ID 匹配，不用大小写归一、显示名或模型名唯一匹配跨供应商猜测。
- 缺失值不补成最高/最低档；原意图为空时 effectiveSelection 为空，不用 preferredSelection 填充。真正全新草稿的初始化规则不改。原意图非空但临时结果为空时，原意图仍保留；配置恢复后应可重新解析出有效结果。
- 不要求观察到一次账号切换事件；冷启动、旧任务再次使用也按当前 View 解析。原账号 Provider 尚在候选中时，也不能因此跳过应有的当前账号对应规则。
- Off-Peak 本轮不做跨账号自动替换；已有选择只检查原 Provider/Model/档位，不对应到当前账号的另一个 Off-Peak。普通账号选择也不能落到 Off-Peak。闲时仅收口只读解析与原意图保护，Ticket 生命周期沿用固定 staging 的既有机制。模板实例、自定义 Provider 不引入 current。
- 发送前不新增远端配置同步或等待。使用目标 Host 当时可读的 View，最终执行仍由目标 Registry 校验。

## 2. 实现位置与接口边界

### 2.1 对外只用一个入口

接口名暂定 `getSelectionView({ selection })`；在现有 `IModelSelectionService` 上演进，不另建跨业务状态服务。目标 Host 由现有服务绑定确定。返回 revision、候选模型/档位、preferredSelection，以及本次输入对应的 effectiveSelection 和最小不完整原因。

- UI 通过公共 `useModelSelectionView({ target, selection })` 完成首次读取、订阅、输入变化重算、读取恢复与旧回包隔离。页面不先读 View 再自己调用解析函数。
- 定时任务/Bot 后台需要时直接调用同一服务入口，取得当前有效结果后派发；不要求长期订阅、不手动拼账号上下文。
- preferredSelection 仍只用于既有的新选择初始化；不能在 effectiveSelection 为空时自动顶上。
- 公共候选快照可共享；带 effectiveSelection 的返回值属于某次输入，不能缓存成 Host 全局唯一选择。缓存/回包关联必须包含目标服务与输入代次，不能只看 View revision；同 revision 下用户可以改变选择。
- 普通菜单继续不展示 hidden Provider。Off-Peak 产品入口复用已有受限隐藏投影供选择，不通过给普通 View 加全量隐藏模型来凑匹配；其有效选择由服务内部相同权威事实解析。

### 2.2 内部只有一份纯解析算法

`packages/provider` 负责纯算法：一致快照 + 原 Selection -> 当前有效 Selection。读取服务/RPC 包住它；纯算法不做 IO、不写库、不修改输入、不通知用户。公共 hook 如利用已到达快照本地重算，也只能复用这一算法，不能再实现另一套规则。

身份分类集中在一个内部入口。服务装配层复用 `isBuiltinModelProviderId` 与 `OFF_PEAK_PROVIDER_IDS` 向 Provider Facade 注入 `ordinary / account-plan / account-offpeak` 分类，不复制 ID 表，也不让 Provider 纯模块导入 shared 整包。普通 Provider 和 Off-Peak 均保留原身份，但后者允许解析受限 hidden 候选，普通 hidden Provider 不能因此混入通用选择。不按前缀/URL/名称猜测，未知 ID 找不到即不完整。

```text
原 providerId -> 集中分类
  ordinary        -> 原 Provider
  account-plan    -> 当前账号连接的普通套餐 Provider
  account-offpeak -> 原 Off-Peak Provider（本轮不跨账号替换）
                         |
                         v
             精确匹配 modelId -> 检查原 reasoningLevel
```

识别用途不能依赖当前可选列表：正式旧账号 Provider 可能已不在候选内。这里只识别现行正式 ID，不做 legacy 别名或运行时迁移。普通账号套餐的当前目标由同快照账号事实确定，支持 Z.AI/BigModel 当前域变化，不能按列表第一项或模型名猜目标；Off-Peak 保留原身份，与普通套餐边界不交叉。

### 2.3 快照与最终执行边界

`ModelSelectionView` 当前只有 revision、providers、preferredSelection。需让解析层取得 Host 权威账号上下文；普通调用方不得另读 Settings/凭据拼接。新增数据为运行时事实，不含凭据、不写用户文件。

候选和账号事实来自同一次已应用的 Account/Registry 快照；不能给旧列表配新连接。账号事实变了但候选未变，也要能驱动必要的重新解析。未知状态由既有源生命周期处理，不能造出“已确认无模型”的伪快照。

ModelFactory 继续只校验明确 Selection；解析成功不承诺未来执行一定成功，也不允许执行层偷偷再换模型/档位。Decoder 的旧结构迁移不进入正常解析路径。

## 3. 状态、保存与执行时机

### 3.1 原意图和有效结果不能混存

- 原选择仍只有现有持久字段；编辑中使用用户最新意图。effectiveSelection 临时持有，每次自动重算都从原意图开始，不以上一次自动置空/换账号后的结果作为输入。
- 普通配置或账号变化只改变有效结果，不能通过 Composer 的现有 Draft 自动保存把原选择清空或替换；文本/附件编辑导致保存时也必须继续保存原选择意图。
- 用户主动选模型/档位、主动清空，按原编辑/保存语义形成新意图；清空后不从 Recent/Session 重新补回。选模时不能把“目标 Provider + 旧模型/档位”混成不存在的组合。
- 原意图非空 -> 当前结果为空 -> 配置恢复 -> 当前结果重新有效，是预期行为，不叫从旧字段恢复。没有新增持久化影子或额外兼容字段。
- 全新草稿的初始化和已有选择解析分开。正常模式选择、文本编辑、Snapshot 到达不能偷偷触发默认模型回退。

### 3.2 首次读取失败如何恢复

沿用读取层 loading/unavailable/error/ready，不给纯解析结果增加笼统的“暂时无法解析”。正常结果只有完整或不完整的有效选择（模型或档位可为空，带最小原因）；读取错误不能伪装成模型失效。

```text
公共 hook：先订阅，再首次读取
  配置/账号变化 -> 新事实到达 -> 重算
  用户意图变化 -> 用当前事实重算
  目标重连     -> 重新绑定/订阅/读取
  初次读取临时失败且没有新事件
               -> 公共读取层有限重试 -> 仍失败显示错误，可手动 reload
```

已有 hook 首读失败后仍保留订阅，但没有后续事件就不会自动恢复；服务初始化失败会清除 startPromise，可再次读取。因此不能仅声称“等 onDidChange 就够了”。公共读取层允许一份有上限、可取消的自动读取重试；实施时选用现有 retry 工具并记录统一次数/间隔，不让页面各建定时器，不重试普通不完整结果、配置写入、领取或派发。

重试只针对可恢复读取失败；没有目标、已销毁、鉴权/明确配置错误不做盲目重试。新 View 成功、目标/输入换代、卸载后取消旧回包与计时器；首次失败后即使恢复快照 revision 未变，也应退出错误状态。重连成功可以开始新的读取周期，不能把一次耗尽永远缓存成失败。

后台一次性读取失败交回现有调度/任务准备错误流程，不另起长期订阅或任务重试。源查询 unknown 与断连不能误授权；同账号 last-known-good 沿用既有来源规则，切身份后不沿用旧权益。明确 pending/无权益/Ready 空候选则可以产生不完整结果，原意图仍保留。

### 3.3 明确写回与固定时机

- 自动解析绝不直接写回。编辑页用户保存、一次提交被权威接纳等既有成功边界才允许采用有效值；准备失败/发送失败/取消编辑不据此覆盖原意图。
- 实施前逐入口列出确切成功事件，不能把 RPC 发起/乐观显示当成功，也不能笼统写“发送成功”。优先沿用已存在的接纳/保存边界，不额外等待整轮生成完成。若原契约没有明确边界，记录后讨论。
- 写回必须关联该次输入与目标；提交成功期间用户又修改意图，不能把该次较旧有效值覆盖新意图。Recent、Draft、Session 分别沿用各自权威边界，不因 View 更新一起写。
- 定时任务的长期配置与本次 run 是两份不同记录。后台首次解析结果用于固定本次 run；不因此顺便改长期配置。正常编辑保存才能改任务配置。
- run、Submission、Active Model 已固定后不重新解析；同 run 重试不换账号，下一次独立运行才重新解析。历史显示真实执行选择，不根据当前账号重解释。
- 闲时创建当前即取 Ticket（`offPeakTaskService.createTask`），所以 queued 不等于尚未固定身份。本轮不做闲时选择跨账号自动替换，不新增账号切换后的取消、换票、任务重建或凭据快照持久化。保留现有执行前模型/账号检查及票据请求；既有过期/3102 换票续跑照常，不承诺跨账号续跑或原票据可跨账号复用。只读有效选择不能覆盖已绑定执行事实。
- Composer 不弹留空错误；仍可能执行的任务保留不完整提示/阻断，已结束闲时任务不新增错误。控件可显示当前有效结果，本次运行记录保存实际采用值；不新增全局逐条通知。

## 4. 影响面与接入清单

这是 option-source、validation、draft-default 和 commit-effect 的改动；不改存储 schema，不新增迁移或后台批量重写。

| 入口/级别 | 当前事实与代码起点 | 接入和保存边界 |
| --- | --- | --- |
| 公共层，must-inspect | `packages/provider/src/facades.ts`；`packages/services/src/model-provider/providerFacadeServices.ts`；`packages/ui/src/hooks/useModelSelectionView.ts` | 输入原选择，返回带临时 effectiveSelection 的 View；公共订阅/有限读取重试，保持只读与输入隔离，Host/RPC 类型一致 |
| Composer，must-inspect | `packages/ui/src/v4/composer/useDraftConfigControl.ts`；`packages/ui/src/lib/composerRecent.ts` | 当前 revision 检查直接清 draft.modelSelection 并自动持久化，必须改成临时派生；文本编辑不顺手写入有效结果，成功写回防旧提交覆盖新意图 |
| 定时任务编辑，must-inspect | `packages/ui/src/settings/AutomationEditView.tsx` | 已通过 useModelSelectionView 读取目标 Host；表单解析、提示、保存使用同一个结果，取消不写 |
| 定时任务后台，must-inspect | `packages/desktop/src/scheduler/index.ts`；`packages/desktop/src/host/index.ts`；`packages/services/src/session/automationRepo.ts` | 当前先把 automation.modelSelection 固定到 run 再派发。必须在首次固定前完成目标 Host 解析，或调整这条现有链的固定位置；不能只在页面修，也不能把账号规则塞给 scheduler/Main |
| Bot，must-inspect | `packages/services/src/bots/botsService.ts` | 草稿候选已读目标 ModelSelectionService；显示与首次提交前统一解析，保留 Bot 自己的上下文/保存边界 |
| Wiki，should-inspect | `packages/ui/src/repo-wiki/RepoWikiPane.tsx`；`packages/services/src/repo-wiki` | 显式生成选择复用规则；后台启动点查漏。生成配置与当前聊天选择不互改 |
| Subagent，conditional | `packages/ui/src/settings/SubagentsSection.tsx`；目标执行层 | 显式 override 的选择入口核对接入；没有 override 时继续继承 Parent Active Model，不改为当前账号默认模型。若执行侧拿不到同一选择事实，先报告边界，不下沉临时别名 |
| Off-Peak，must-inspect | `packages/services/src/model-provider/offPeakModelSelectionView.ts`；`packages/services/src/session/offPeakTaskService.ts` | 不跨账号自动换模型或迁移 Ticket；原 Provider 暂不可用只形成临时不完整结果，执行保护保留。现有 list/get/sync 的 repairLegacyModelSelections 对已有新 Selection 不匹配会写库 invalidate，需切断这种自动破坏原意图的路径；真正旧结构迁移独立保留，历史/Ticket 不重解释 |

Desktop 和 Web 复用解析算法，但不改变 continuous/replayable 投递。远端 View 不就绪时不退回 Local Host；隔离沿用 workspaceIdentity、remoteSessionId 和现有 service owner。不能把账号切换变成第二套远端同步。

## 5. 与其他 Todo 的关系

### 2026-09-07 执行中裁决：显式 Subagent 后续单独接入

用户明确同意：本轮保留显式 Subagent 原模型校验，不只在设置页自动对应。Agent `runtime/methods/subagent.ts` 从 profile.modelSelection 或父 Runtime 选择固定子任务模型；当前不具备 Host Account State，完整对应需要另行设计协议接入。继承 Parent Active Model 的路径不变，不读取账号默认，不新增运行时别名。这是明确排除项，不计为已实现统一对应。

- Todo 85：D01 已裁决不恢复发送前同步；D02 的体验由本 Todo 承接，不原样恢复旧 SessionPane 切模命令。85 的其他恢复可以独立 review/提交，不能把 87 未实施写成 D02 已交付。
- Todo 83/85：提供正确 Account State、Overlay 和当前账号身份，是本 Todo 的输入基础。
- Todo 86：负责源刷新如何可靠推动 View；本 Todo 负责 View 到达后如何解析选择。两者衔接，不要求先执行尚未裁决的 86，也不在 87 中另建刷新框架。
- Todo 70/71/72/81/84：失效时控件留空、缺档位不补、已提交执行事实不变等继续保留。本 Todo 明确取代“自动清空并覆盖原保存 Selection”：改为临时有效结果为空，原意图不丢。跨账号对应仅包含普通套餐，Off-Peak 本轮排除；不修改旧结构迁移和回滚文件策略。

## 6. 实施顺序与完成条件

1. 先补正式 `design/interaction/selection-state.md` 和相关用例目录/矩阵，注明“当前行为”与本 Todo 新语义的差异；冻结只读输入/结果接口、账号上下文、各入口成功写回事件及 run 固定位置。保留 shared Off-Peak 不跨 Family 静默迁移的约束，不因统一解析更改 Ticket 机制。
2. 先写原意图保护、公共解析、View 一致性及首读恢复测试，再实现算法、读取接口和公共 hook。证明普通配置/账号更新复用同一入口，不新增默认回退、不让输入相关结果进入全局共享快照。
3. 接 Composer 与定时任务编辑；删除重复解析，分离意图与派生结果。再接后台定时任务、Bot、Off-Peak，核对 Wiki/显式 Subagent，重点检查已有自动写盘路径和冻结身份边界。
4. 每步完成都 review 调用链和测试；最后反向检查是否还有只在 UI 生效、后台直接消费未解析选择的遗漏。
5. 运行 typecheck、lint、相关单测；交互 E2E 在 MacBook Air 隔离目录运行，覆盖 Composer、不打开编辑页的定时任务后台及 Off-Peak 选择/票据边界。提供实际请求身份/档位、文件不变或无请求证据，不能只断言菜单变化。
6. 独立提交，实施报告写明接入点、未覆盖入口、测试结果和任何待裁决项。禁止仅声明“公共 helper 已完成”。

## 7. 验收用例与剪枝（合同；实际覆盖级别见 coverage matrix）

| ID | 前置和动作 | 必须证明 | 证据 |
| --- | --- | --- | --- |
| SR87-01 | 个人/Team 切换，新 Provider 有相同模型/档位 | 只改 Provider，模型/档位保留；普通 DeepSeek 不动 | 公共单测 + Composer E2E 请求 |
| SR87-02 | 目标只缺档位或缺模型 | 仅有效结果分层置空；原意图及文件不变，不选默认、不按档位索引映射 | 单测 + 控件/提交阻断 + 文件 |
| SR87-03 | Personal/Built-in 更新档位、模型 enabled 或模型成员 | 与账号更新使用同一解析入口；有效选择不变，无效部分置空 | 配置/View 集成 + UI |
| SR87-04 | View 迟到、未知、Host 切换，期间用户又改选择 | 不误清空、不串 Host、不覆盖最新用户选择；Ready 权威空候选才判失效 | 状态/服务测试 |
| SR87-05 | 重启后读取旧账号选择，未观察切换事件 | 仅凭当前 View 完成账号对应；旧 legacy 结构仍归 Decoder | 公共/恢复集成测试 |
| SR87-06 | 定时任务已保存旧账号模型，切换后不打开编辑页直接触发 | 首次 run 固定正确选择；实际请求一致；同 run 重试不重新换模型 | Air E2E + run 记录/请求 |
| SR87-07 | Bot 旧草稿、Wiki 显式设置再次使用 | 复用解析；各自记录不污染 Composer/Recent | 业务集成；交互按已接受用例补 E2E |
| SR87-08 | 继承型 Subagent、已运行/已完成记录 | 不跟随当前账号替换，不重写历史/执行对象 | 定向不变量测试 |
| SR87-09 | 配置同步未完成时立刻发远端请求 | 不新增发送前同步屏障；目标 Host 自己校验 | 既有同步测试 + 调用边界检查 |
| SR87-10 | 原选择临时无效，编辑文字，再恢复配置 | 文字保存不清原选择；有效结果恢复，用户明确清空则不恢复 | Draft/文件测试 + Composer E2E |
| SR87-11 | 首读临时失败，随后恢复且 revision 不变；没有变化事件 | 公共层有限读取重试可恢复；耗尽可 reload；换目标/销毁取消，解析不完整不重试 | Hook/服务测试，受控故障 |
| SR87-12 | 两个消费者传不同选择；同 revision 下改输入或提交后再编辑 | effectiveSelection 不串用，旧回包/旧提交成功不覆盖新意图；失败不写回 | 公共读取与提交测试 |
| SR87-13 | Z.AI/BigModel 域切换，已保存 Off-Peak 选择与当前账号不匹配 | 不自动换 Provider；只读结果不完整、原意图不改，执行前检查继续阻断；不因账号切换自动换票 | 公共/服务测试 + Air mock 交互与无派发证据 |
| SR87-14 | 已有闲时 Ticket/queued/续跑；list/get/sync；切回原账号 | 读取/轮询不清新 Selection 或从旧修复字段重绑另一账号；切回可重算模型有效结果（不保证 Ticket 有效）；历史不变，既有过期/3102 处理保留 | 服务/存储/Ticket 集成测试 |

组合剪枝：不为颜色、每个供应商品牌或每档 reasoning 做全排列；个人/Team 取连接变化代表，Start 取 pending/空模型代表，Off-Peak 取 Z.AI/BigModel 切域不改原意图及执行阻断代表，普通 Provider 取配置变化代表。远端取身份隔离与读取恢复代表；继承型 Subagent 只做不变量。没有同模型挑首模型、按中文/强度位置猜档位、自动批量写盘、闲时跨账号自动替换或票据迁移均明确排除。

E2E 交接：在 case catalog/coverage matrix 登记 SR87 映射后，按 e2e-case-lifecycle 准备 case-local 账号/Provider fixture；不领取真实额度，不发送真实 Bot 消息，不改 Air 日常配置。按 View revision/运行记录条件等待，不靠固定 sleep 猜同步结束；不要求每个公共函数组合都跑桌面 E2E。

## 8. 可行性、风险和调查记录

总体为中等偏大的跨入口改动，不是加一个 helper 就结束；未发现需要推翻架构或迁移存储 schema 的硬障碍。公共算法小，已有服务/订阅可复用。难点集中在：Composer 原意图与有效结果拆开、防其他编辑自动写盘；后台定时任务当前先固定 run 的时序；闲时创建即取号且 list/get 会写入失效状态；以及无后续事件时的首读恢复。

实施依据 live code 做直接调用链核对，约两跳；codegraph 工具不可用，未伪称图查询结果。Feature Graph 已更新实现与精确代码种子。新增 SR87 证据与旧回归分开，不把旧通过结果当新功能覆盖。

当前没有阻止落盘的产品问题。实施时若账号目标无法唯一确定、需要不同正式 modelId 才能对应、后台固定点无法在现有 Host 边界内接入，或希望已绑定 Ticket 的任务跨域继续执行，先记录事实讨论。不为扩大匹配率新增模糊别名、数据扫描、自动重取票或请求层兜底。

立项时尚未改代码；现已完成实现。公共层 `cd6c4ff87c`，Composer `ac00daec9c`，Wiki `a3517b732f`，Automation/Off-Peak `e401dbcbb4`，Bot `f0047c4430`。实施期间保留并行 Todo86 和其他命名/迁移改动，没有推送。

### 2026-09-07 追加裁决：闲时跨账号续跑暂不扩展

对照当时合入的固定 staging `16d999f6a48b180b691a4d909479c063580d2ad0`，不是后续 staging：

- staging 已经在创建任务时取 Ticket，后续请求重新解析当前账号凭据；并未持久保存每个 Ticket 的原账号凭据。`offPeakServerClient.ts` 与该基线无差异。
- staging 的任务只保存旧 model/thought，派发时构造本轮模型；没有当前新增的“读取任务时比较新 Selection 的 Provider 并清库”行为。不能把这一破坏性读取归为 staging 原行为，也不能为恢复旧行为重新引入旧 runtimeModel。
- staging 已有过期重取号、模型请求 3102 后换票续跑；票据查询的 not_found 分支没有完整的跨账号恢复流程。现有客户端证据不能证明切 Z.AI/BigModel 后票据必然失效，也不能证明可复用；本轮没有调用真实票据接口验证。
- 当前 `offPeakTaskService.repairLegacyModelSelections()` 在 list/get/sync 中处理已有新 Selection，不匹配时调用 `offPeakTaskRepo.invalidateModelSelection()`，写入 `model_selection=NULL, schedulable=0`。已有新字段不得再走这种清空后依赖旧修复字段重绑的路径；真正旧数据迁移仍独立保留。

```text
已有闲时原选择 + 当前账号/配置
               |
               v
只检查原 Provider 的当前有效性，不跨账号换 Provider
       |                         |
     可用                       不可用
       |                         |
  保留执行前检查            临时不完整、阻止执行
       +------------+------------+
                    |
             原持久选择不因读取改写
```

本次确定：跨账号续跑先不扩展，已有选择别破坏。Ticket 既有机制不改，不新增长期票据身份存储，不取消/重建用户任务。普通账号套餐的最大努力同模型/同档位解析不受此收缩影响。

### 当前裁决状态（不等于开发完成）

| 项目 | 结论 | 后续 |
| --- | --- | --- |
| Todo 85 D01：发送前远端配置同步 | 明确不恢复 | 不再列为待裁决 |
| Todo 85 D02：账号切换后的模型选择 | 按本 Todo 统一解析，不恢复旧事件驱动批量改写 | 待实施与验证 |
| 闲时任务跨账号与 Ticket | 本轮不做跨账号自动替换/票据迁移；修正读取破坏原意图 | 按上述收缩范围实施 |
| Todo 86：刷新职责 | 独立草案，仍待讨论 | 不阻塞 Todo 85 收尾，不自动扩大本 Todo |

截至本轮，固定 staging 恢复记录中已列出的产品裁决没有新增悬而未决项；最终 review、未提交恢复组的提交及 Todo 87 实施仍未完成，不能据此宣称事故已全部收口。实施中若遇到本文件第 8 节列出的真实边界冲突，再带具体事实讨论。
