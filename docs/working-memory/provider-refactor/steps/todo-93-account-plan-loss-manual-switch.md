# Todo 93：套餐失效只提示一次，用户点击后切换

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。

> 状态：已实现、已 review，单测与 Pro 核心 E2E 已复验通过；全端视觉未实测项见末尾。2026-09-08。
> 本项替代 Todo88 R06 中“发现当前连接不可用便自动保存替代连接”的产品裁决；旧实现和旧测试通过记录保留为历史。

## 1. 问题与最终裁决

Air 已有运行证据：2026-09-08 14:06:35.055 保存个人套餐，14:06:35.990 又保存 Team；同日多次重复。当前根层观察器只判断 `current && availability === unavailable`，手动选未开通套餐也触发自动回退。

最终规则：同一账号、同一当前连接从 available / pending 变为明确 unavailable 时，提示一次，并提供指向具体替代套餐的按钮。没有点击就不切换，不写设置。用户手动选择未开通的个人套餐可以停留，不被后台抢回。

| 边界                             | 已确认处理                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------- |
| 提示形式                         | 复用现有 Toast，例：“当前体验套餐已不可用。”＋“切换至「具体团队名」”；不是先打开设置或菜单再选      |
| 重复刷新                         | 同一次失效只提示一次，关闭提示、打开设置、普通 Provider 配置刷新不重新提示                          |
| 恢复后再次失效                   | 属于新一次状态变化，可以再次提示                                                                    |
| unknown / 查询失败               | 不当成明确失效，不清除上一份确定状态，不凭旧账号事实判定新账号                                      |
| 手动切换 / 换账号 / 换 Team 身份 | 新身份建立新基线；不能把旧 Team 的 available 与新个人的 unavailable 相比较                          |
| 启动                             | 首次确定状态只建立基线；启动即 unavailable 不弹“发生变化”提示，也不自动替换已保存连接               |
| 首次没有保存选择                 | 保留既有初始化规则；待迁移旧连接不是首次无选择，继续保留原迁移保护                                  |
| 无可用替代                       | 同次失效只提示状态，不提供虚假的切换按钮，不自动选择购买入口                                        |
| 持久化                           | 只有用户点击并成功提交才写现有 providerFamilyConnectionSelections；不增加去重字段、迁移或新配置文件 |
| Start 隐藏                       | 设置页现有 Start 入口过滤不改；本项不新增 invisible，也不改 ProviderConfig.visibility               |

这里保留“设置页手动选择即保存连接”的已有动作，本项不实施上一轮讨论过的“浏览套餐与实际连接拆成两套选择”。通过取消自动回退解决弹回；没有权益依然不能执行。

## 2. 状态、观察与提交边界

```text
现有账号 / 连接设置 + Provider Settings View 变更
                    |
                    v
App 根层观察器（内存；不随设置页开关卸载）
    身份切换 -> 新观察代次，废弃旧建议与在途结果
    首份确定状态 -> 基线，不提示
    同身份 available/pending -> unavailable -> 一次失效事件
                    |
                    v
只读计算具体备选套餐 -> Toast（不写设置）
                    |
                  用户点击
                    |
                    v
校验账号 / 原连接 / 目标身份及当前可用性
                    |
           既有设置服务条件写入
                    |
             既有 Provider 刷新
```

- 观察身份至少区分账号主体、Family、完整连接选择；Team 包含 productId / organizationId / projectId。不能只用 account Provider ID，两个 Team 共用 Provider ID 不代表同一连接。
- 提示去重针对“本观察代次的一次失效”，不是整个 View 的 JSON fingerprint，也不单靠 Toast 的短期 dedupeKey。请求开始前记住代次，旧账号 / 旧选择的迟到结果不得生成提示或写入。
- 对重复 unavailable 不重复处理；unknown 保留上次确定状态。若第一次是 unknown，则等首份确定状态建立基线。available → unknown → unavailable 仍是一次可识别的失效。
- 观察器生命周期跟随 App 账号观察，不跟随页面。实现时检查 React effect 依赖，不能因普通设置更新/语言变化意外重建基线。登出/账号变化才隔离旧事实；不另建轮询或重试系统。
- 原连接已恢复、用户已切换账号/连接、或者按钮对应目标已失效时，旧按钮不得提交。重复点击不得产生并发切换。
- 按钮绑定具体目标及完整身份，展示 Team 的真实名称。候选优先级尽量复用原逻辑，但必须确认可用；团队列表中存在不等于已通过目标 Team 权益校验。不得把按钮的 Team A 换成 Team B，也不得仅凭“有模型”判断有权益。
- 将旧协调方法的“计算备选”和“写入选择”拆开。异步查询在写入队列外，提交时复用设置服务的条件写入，并检查账号/选择未变化；不建立新 Repo 或持久化锁。
- 写入失败保留实际原选择，显示操作失败，不宣称已切换；写入成功但后续刷新失败时承认设置已保存，不假装回滚。旧建议失效后关闭/更新提示，不后台重选目标继续提交。
- 不点击不会修改原选择；现有权益、Registry/Model 准入与 Effective Selection 解析仍生效，不允许借“保留选择”绕过执行检查。

## 3. Impact Brief

模式为 planning；改动层级是 presentation、validation、commit-effect 和 startup recovery，涉及账号连接/设置领域。持久化结构不变。

| 场景 / UI 入口                  | 共享实现与状态 owner                                                      | 来源、校验、提交落点                                                     | 模式及隔离                                   |
| ------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| 运行中当前套餐失效 / 根层 Toast | useRootOAuthEffects → accountConnectionRefreshObserver；内存基线/失效事件 | Account View 确定状态；点击前只读，点击后 settingService.update 条件写入 | Desktop/Web 使用各自注入服务；不新增远端同步 |
| 设置页手动选个人/Team/Start     | ModelProviderSection → persistProviderFamilyModeForNavItem                | 继续保存用户显式连接；观察器换代建基线                                   | 不因无权益回退；Start 可见性规则不扩展       |
| 启动恢复已有连接                | refreshRestoredOAuthProviderFamilyAfterStartup                            | 刷新事实、保留已有设置；不再自动保存替代项                               | 与首次无选择初始化及旧数据迁移区分           |
| 点击提示建议                    | 现有 Toast actionLabel / onAction；复用备选解析                           | 同账号/原选择/目标重新校验，现有设置服务权威写入                         | 不批量改 Session、任务、Bot 或 Markdown      |

| 级别           | 检查对象与语义关系                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| must-inspect   | accountConnectionRefreshObserver.ts 的状态检测；useRootOAuthEffects.ts 的订阅/Toast/生命周期                                                          |
| must-inspect   | oauthProviderFamilySelectionRefresh.ts 的启动与后续协调共享写入路径，防止只改观察器、启动仍自动切                                                     |
| must-inspect   | lib/modelProviderFamilyConnectionSelection.ts 的备选计算；Team 的完整身份与实际可用性校验                                                             |
| should-inspect | ModelProviderSection.tsx 手动连接写入、pending selection 与已保存设置的交接；Toast 的按钮和失败反馈                                                   |
| invariant-only | Account State/Overlay/Registry 分层、Off-Peak/Ticket、模型请求与历史选择不改；不新增发送前远端同步，不改变 desktop-continuous / web-remote-replayable |
| evidence-only  | accountConnectionRefreshObserver.test.ts、Root OAuth 恢复相关测试、Toast 测试、旧 SPMC-08 的失效切换场景                                              |

状态权威仍分三层：持久化 Family Connection Selection 是用户选择；AccountProviderState 是实时事实；Account Config Overlay 是配置投影。观察器只消费事实并提出建议，不成为权益来源。旧备选计算与写入耦合需要拆分，设置页显式选择和失效提示的提交触发刻意不同。

codegraph 当前无可调用工具，以精确 imports/callers 阅读至深度 2 核对上述路径，没有宣称全域扫描。Graph drift：现有 surface.provider-settings 未记录根层套餐协调 seed；本次补充来源/seed 与“待实现”的不变量，不新增一套 Provider 状态实体。所列测试尚未按本项新语义执行。

## 4. 裁决记录与测试计划

2026-09-08：用户要求取消自动跳转、仅变化时提示一次；明确选定“切换至具体目标”的按钮，不是打开菜单。本轮确认启动首份仅建基线、无持久化去重、Start 过滤不动。没有待产品裁决的阻塞项。

维度采用状态转移 × 身份代次 × 点击时机 × 写入结果，BigModel/Z.ai 做对称代表用例，不枚举所有品牌/模型。主题与语言只验证既有 Toast 的可读性和目标名称；不重设计 Toast 样式。

| Case   | 前置 / 操作                                                   | 必须断言                                                    | 证据 / 状态                                  |
| ------ | ------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| C93-01 | 当前可用套餐变 unavailable，有合法备选                        | 一次提示包含具体目标；点击前设置不变                        | accepted；观察器单测 + Electron/读盘，待执行 |
| C93-02 | 重复同状态刷新、开关设置页、关闭 Toast                        | 不再提示，不写设置；设置页打开不是基线重置                  | accepted；单测 + Electron，待执行            |
| C93-03 | unavailable → available → unavailable                         | 第二次真实失效再次提示                                      | accepted；状态序列单测，待执行               |
| C93-04 | available → unknown → unavailable；初始 unknown → unavailable | 前者只在确定失效时提示，后者首份建基线不提示                | accepted；单测，待执行                       |
| C93-05 | Team 手动切未开通个人；切另一个 Team；换账号                  | 不跨身份比较；个人页面停留，无自动回写；旧异步结果废弃      | accepted；单测 + Electron/读盘，待执行       |
| C93-06 | 启动即已保存 unavailable；首次无选择；旧连接待迁移            | 前者不弹不替换；后两者维持各自初始化/迁移边界               | accepted；启动单测 + 冷启动 E2E，待执行      |
| C93-07 | pending → unavailable；pending → available                    | 前者提示，后者不当失效；待生效不是无权益                    | accepted；单测，待执行                       |
| C93-08 | 点击具体 Team 按钮并重复点击                                  | 只写按钮所指完整身份一次；成功后 View/实际连接一致          | accepted；服务条件写入 + Electron，待执行    |
| C93-09 | 提示后手动切走/切回、换账号、原套餐恢复、目标失效             | 旧建议不能覆盖新意图；不自动换另一个建议目标并提交          | accepted；可控异步单测 + 代表 E2E，待执行    |
| C93-10 | 无备选，或备选查询失败                                        | 不提供伪可用目标，不保存购买入口，不循环提示/后台重试       | accepted；单测，待执行                       |
| C93-11 | 点击后保存失败；保存成功但刷新失败                            | 正确区分实际设置是否改变，错误可见、不虚假成功/回滚         | accepted；单测 + 操作失败 E2E，待执行        |
| C93-12 | 中英、深浅、窄屏提示和键盘操作                                | 目标明确、按钮可访问；注入同一设置服务，不改手机/桌面消息流 | accepted；Toast/布局代表用例，待执行         |

剪枝：普通配置 revision、持续 unavailable 不构成新事件；网络 unknown 不构成失效；非 current 套餐不触发本提示；Off-Peak 无 current，不加入自动建议；数据迁移、模型重映射、Start 入口改版与领取“立即体验”不在本项内。

E2E 交接：实施前按 e2e-case-lifecycle 复核既有账号 fixture/人工审阅流程；在隔离数据与可控账号响应下测试，不消费真实账号额度。扩展旧 SPMC-08，撤销其“刷新即自动切换”预期，不删除失效链路覆盖。以事件/调用完成和读盘断言控制时序，不用固定 sleep；Mac Electron 验证点击与真实持久化，窄视口不冒充完整手机远控验收。

## 5. 执行与审阅记录

- [x] 确认 Air 现象与当前代码路径，记录本次产品裁决。
- [x] 新建本 Todo；回链 Todo88 R06、当前设置 spec、覆盖矩阵和功能图。
- [x] 先写状态/启动/点击竞态测试，确认旧实现失败。
- [x] 分离备选查询与提交，修改观察器、启动边界和 Toast 动作；清理被替代的自动写入逻辑。
- [x] 执行受影响单测、typecheck、lint；隔离 Electron 验证 C93 关键交互与读盘。
- [x] Review：查全写入调用方、检查旧 Toast 闭包/账号身份/Team 身份竞态；复核无新增迁移、无 Start 可见性变化。
- [x] 填写测试证据、未覆盖项；提交与本记录同一 commit。

### 2026-09-08 实施与 Review

- AccountProviderState.connectionKey 是同轮账号主体、Family、完整连接的摘要，不含明文身份/凭据，不进入 Config、不持久化。普通 API/Off-Peak 不增加 current。单测验证摘要稳定、换账号变化、Config 不包含摘要。
- 独立根层 hook 订阅 View，语言/页面重绘不重建基线。设置/账号意图变化立即废弃旧闭包；unknown 保留确定基线。没有轮询、持久化去重或额外配置文件。
- 移除 startup/observer 共用自动回退。已有选择启动不重选；首次无选择复用原初始化和待迁移 unknown 保护。主动 OAuth 登录及其条件写入回归保留。
- 建议按个人、具体 Team、Start 的既有优先级检查；Team 按完整项目验证权益，保存固定目标。用户点击前不写，旧建议/已恢复原套餐/已失效目标不写，重复点击不并发写。
- 写入失败给同一建议的显式重试；保存成功后的刷新失败不伪装回滚。长 Team 名称沿用 Toast 并允许按钮文案换行。
- 清理旧 onConnectionReplaced / onlyIfProviderId 参数、自动切换文案与旧自动替换测试预期；启动用例收拢为两 Family × 三种连接，独立登录竞态覆盖保留。

验证：6 个定向文件 57 条通过，Toast 两文件 11 条通过；根 typecheck 通过，lint 0 errors / 40 个既有 warnings。

Pro 隔离目录：/Users/dev/zcode-todo93-e2e.88xgST。SPMC 第二轮 4/4 通过，run desktop-e2e-20260908-100921-925。SPMC-08 实测失效不写、点击保存失败、恢复目录权限后手动重试成功及读盘；日常账号目录未动。

第一轮 desktop-e2e-20260908-100502-105 为 3/4：93 的 SPMC-08 通过，旧 SPMC-02 发布余额后找不到刷新按钮。日志确认后台已取得新余额、按钮正常消失；改为先验证卡片刷新请求，再发布余额并用稳定的全局刷新验证收敛。只调整 fixture 顺序，不改产品、不吞失败；第二轮完整领取/导航/动态模型编辑/选择变化覆盖保留。

未覆盖：真实账号权益失效、实际手机远控、Windows UI；假账号/billing fixture 不消耗用户额度。C93-12 完整中英深浅/手机视觉仍需人工审阅，不以桌面通过冒充全端通过。

最终复验（包含 Toast 长名称换行改动）：Pro run desktop-e2e-20260908-101239-586，4/4 通过。执行命令：ZCODE_E2E_MANUAL_REVIEW=1 ZCODE_E2E_SKIP_AGENT_BUILD=1 pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec ./test/e2e/start-plan-manual-claim-experience.test.ts。两次完整通过均保留真实点击与文件断言；不使用旧自动切换结果作为新规则证据。

### 推送前补充审阅（2026-09-08）

推送钩子的扩大关联测试发现一项遗漏：`rootAccountRefreshLifecycle.test.ts` mock React 后仅手动执行第一个 effect；订阅拆入独立 hook 后，它实际只运行意图失效 effect，因此错误报告没有订阅。首次关联回归为 469 文件通过、1 文件失败（4721 条通过、1 条失败、7 条跳过）。

只调整该测试：改用真实 `renderHook` 挂载完整生命周期，补齐平台/广播依赖和账号意图；确认启动刷新错误已经捕获、订阅仍存在且只建立一次，卸载准确清理。不放宽断言、不修改生产行为、不按 effect 序号重绑测试。定向两文件 7/7 通过；原有 Pro E2E 证据仍对应未变化的产品代码。
