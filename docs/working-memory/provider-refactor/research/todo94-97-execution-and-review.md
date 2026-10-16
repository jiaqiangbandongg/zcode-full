# Todo 94–97 执行与复审记录

> 最新归属（2026-09-09）：95C 已完成（`2c1addd3d8`）；96 显式 Subagent 已由 Todo99 完成；97 Wiki 一次落盘迁移已完成（`9cd1ae31dd`）；后续 98 排版及键盘小修也已完成（`a5fb82ec4a`）。上述开发入口均已收尾，残余验证只在 [Todo102](../steps/todo-102-verification-debt-closeout.md) 跟进。以下按时间保留历史记录，“三项待裁决”“待实施”“目标未完成”等不再代表当前状态。

## 范围与执行约束

- 目标启动：2026-09-08；基线 `00c5fa2e66`，分支 `provider-refactor-e2e-recovery`，开工新鲜度检查通过。
- 顺序：94 → 95 → 96 → 97。每项先测试、实现、验证，再逐条复审需求和 Provider / Selection 抽象。
- 小阻塞记账、继续独立工作；涉及新产品语义或协议边界需明确裁决，不自行扩张。
- 最终推送当前分支，复审最近两天 Todo / commit，并在 Pro 推进可运行 E2E。
- 排除 Web 发布、已恢复的 novel、未授权旧草案。既有未提交源码、测试、文档修改保留，不作为本轮成果混入提交。

## 首轮进度与证据（历史快照，当前结论见页首）

| 项目 | 状态 | 处理与证据 | 待验证 / 裁决 |
| --- | --- | --- | --- |
| 94 Wiki 统一输出 Limit | 实现与复审完成 | Wiki 相关 15 文件 / 160 单测通过；Pro 两项正式 Electron E2E 通过；删除私有预算全链路 | 手机真实 attachment / Windows 未实机复验，不能以 Pro 通过替代 |
| 95 reasoning map | A/B 实现与复审完成 | 340 Provider/Option Map 单测通过；Pro 新增档位真实请求、白名单和智能配置回归通过 | C 关闭档位改名会影响仅覆盖 Map 的 Personal 配置，已单列请求裁决，未实施、不算全项完成 |
| 96 离线 Selection 迁移 | 核心实现与复审通过，协议项待裁决 | 根工作区 438 条、Agent 73 条单测；Pro 两项真实交互 E2E 通过 | 显式 Subagent 的 Host 解析协议待裁决，不将核心完成写成整项完成 |
| 97 Subagent 原字段迁移及全域旧字段审计 | 核心实现、扩大回归通过，全域项待裁决 | 用户目录原地迁移、共用正式 codec、内置 JSON 单向导入；Pro 4项通过；详见 todo97-selection-storage-audit.md | Wiki 读取不写盘与全域一次迁移原则冲突，待裁决；手机/真实 SSH 未验证 |
| 最终审计与推送 | 已验证部分已推送；目标未完成 | todo88-97-final-quality-review.md 按提交/契约记录发现、修复与未覆盖范围；a0f686fc38 已推送当前分支 | 三项裁决仍未回答，目标不标完成 |

## Todo 94 设计收口

```text
Wiki 选择 / 生成设置（无输出预算）
    -> 目标 Workspace 的 generateText
    -> Wiki 已解析的目标 Model maxOutputTokens Limit（原样传值）
    -> Option Map -> 实际 API 请求
```

- Catalog、Page、工具循环与压缩 final 共用此链路，不自行计算预算。追到 ModelFactory 确认它有意不绑定输出值，因此保留 ModelClient 从目标 View 读取 Limit 并显式传入的现有接口；不改 Factory，不新增默认值解析器。
- 截断仍失败，普通 maxRetries 和 deadline 保留；删除额外 rescue 次数。
- 旧 generationOptions.maxOutputTokens 读取时忽略，正常写入不携带，不批量重写历史。
- 重叠测试的已有差异是 supportsJsonSchemaOutput 改名；本轮不撤销，也不冒认该改动。
- 已发现并纠正 Wiki 测试过时的 `BUILTIN_MODEL_PROVIDER_IDS.zai`：运行值为 undefined，可能形成假通过；改用具名测试 Provider。
- 首轮 ModelClient 红灯固定了目录 16384 / 正文 8192 的旧预算；新断言要求两条路径原样使用测试模型 32000 Limit，12 条通过。

### Todo 94 验证与二次复审

- 最终相关单测：`pnpm exec vitest run packages/services/test/repoWiki packages/ui/test/repoWiki packages/shared/test/repoWiki.test.ts --reporter=dot --silent`，15 文件 / 160 条通过。覆盖两类请求、多种模型上限、工具循环/静态回退/压缩 final、旧 Wiki/Draft 读取不写盘与正常保存移除旧预算、截断普通重试、取消和超时。
- Pro 隔离目录 `/tmp/zcode-todo94-97.qBney3`，源为基线 HEAD + 当前源码差异；未修改 Pro 原工作区或用户数据。依赖下载遇到 SSH 钥匙串错误，未解锁或改凭据；复用现有隔离仓库完全同 SHA256 锁文件的依赖，重新构建当前桌面源码。
- Pro 正式 E2E：generation-settings、generation-produces-wiki 两项通过。证据目录：`packages/desktop/.e2e-artifacts/desktop-e2e-20260908161324585-p92955-4b3566c99ee6dd7f`（上述 Pro 隔离目录内）。第一次运行生成用例仍点击单一 disabled 档位菜单，现行 UI 是固定值，因测试过时失败；调整为验证固定值后重跑通过，未修改产品推理行为。
- 二次复审：目录/正文/失败页补齐/自动刷新不再存在 Wiki 预算覆盖；ModelConfig 从目标 View 取 Limit，ModelClient 原样传入，最终 Model 校验和 Option Map 不变。没有 Factory 默认值、Provider 特判、远端发送同步或执行中换模型。
- UI 删除共用组件中的两处入口和双语文案，无新增样式；不能据此宣称手机实机、Windows 或真实供应商请求已验证。E2E 使用 L2 mock，实际 API 字段仍由既有 Map 契约测试负责。
- 提交范围排除原有 supportsJsonSchemaOutput 重命名等未提交修改；具体 commit 由对应 Todo94 提交及本执行记录的 Git 历史追踪。

## Todo 95 A/B 实施与复审

- 红灯：先固定 19 种旧专用表达式及全部规则位置；原配置等价测试通过，三种 API 兜底缺失的请求测试失败。随后只修改配置，revision 10 → 11，避免同 revision 不同内容。
- `pnpm exec vitest run packages/provider-node/test packages/provider/test packages/model-option-map --reporter=dot --silent`：24 文件 / 340 条通过。专用合法输入逐条比较最终 JSON；两个基础 body 分别测试空字段及既存字段、预算、null，防止把省略写成删除。非法值由公共校验拒绝，Map 不负责猜最高档。
- 旧完整性测试断言表达式包含 `"effort": "max"`，不再适用透传；改为编译执行后断言对应请求，而不是降低为字符串存在。
- Pro：`desktop-e2e-20260908162732756-p93660-3b18fc076970b932` 的 C91-04、SC90-01 通过。新 case 两次卡在 WebDriver setValue 清空导致行内编辑器退出；确认输入曾进入编辑态，改用键盘全选替换后，`desktop-e2e-20260908163135228-p95033-03a4490e97708607` 通过并捕获真实 Model 请求。不是放宽 Map 或绕过保存的修复。
- 新 pending case `provider-reasoning-fallback.test.ts`：真实添加未知模型，只写 values=[high]；Personal map 仍缺省，网络体包含四组 high 字段、原型号、原 probe Prompt、输出 5000（既有辅助调用预算），无思考预算、配置未因测试请求改写。不依赖真实额度；待人工审阅，不擅自转正。
- 差异机械对照：去除 revision 与 reasoning map 后，新旧整个 Built-in JSON 完全相同。专用 Rule 值域、API/站点/模板/Provider 匹配、优先级、模型能力、maxOutputTokens Map 全部未动；Runtime 无改动。
- 真实语义变化仅兜底：包括已知型号在某 API 下没有专用 Map 时，从 `{}` 变成显式关闭字段；这是已确认 B 边界，不声称所有兼容 API 无损。用户 Map-only、固定配置继续由原 Overlay 权威覆盖。
- C 未实施：已询问暂缓关闭档位改名或继续设计来源兼容；未答前保留 off/nothink，原生 none 不动。不得用 A/B 完成记录掩盖 C。
- Todo96 显式 Subagent 接入另发请求：建议 Agent 启动子任务前委托所属 Host 的公共 getView 解析并冻结，不改配置、不回退父模型；需要严格协议扩展，待用户裁决。

## Todo 96 过程记录（尚未完成）

- 第一组共享身份/Bot 测试：5 文件 / 37 条通过；旧字符串即使候选为空仍保留明确身份、模型和档位。删除 BotsRepo 迁移上下文和 Host 的 readMigrationAccountAccess，不影响真实连接设置迁移/OAuth。
- Automation/Wiki：去除仅用于迁移的注入回调，改为存储 + 静态转换；相关 2 文件 / 76 条通过（后续全量还需复跑）。保留新字段优先、SQL NULL 与 JSON null 区分、CAS、旧文件不写回。
- Session：先补真实 SQLite 恢复测试，复现三处原意图丢失（已删除 Provider、已删除模型、失效档位）。修后 12 条通过；Runtime 仍只绑定 Registry 验证成功的选择，恢复结果返回保存意图。
- Session Store 已去除迁移解析回调，保留事务/CAS；旧异步账号等待测试改为无账号接口的离线导入、并发幂等及新选择优先测试。
- knip 全库检查报告存量未使用项，未据此批量删除；dep:refs 对协议符号给出 Host 引用，但漏掉独立 Agent 工作区，额外用 rg 追踪 Agent import、协议字符串和测试，避免误删。

### Todo 96 核心验证与二审

- 根工作区 28 文件 / 438 条通过：Bot 全组、Subagents、Automation Repo、Wiki selection、ZCodeAgentService、共享身份、Account resolver、Host 派发、Draft control。Agent 6 文件 / 73 条通过：真实 SQLite 迁移、App/Protocol 恢复、Subagent 初始化及冷恢复。首次 Agent 测试命中了旧 adapters dist，重建 contracts/adapters 后复跑，未用改断言掩盖旧构建。
- 根 `pnpm typecheck`、`pnpm lint` 和 Agent bootstrap typecheck 通过；Lint 41 警告 / 0 错误。最终清理已有未使用项另计，不声称全库零警告。
- 删除专用于旧迁移的 `session/resolveLegacyModelProvider` RPC、Host 装配回调和 Agent 注入；真实账号连接迁移/OAuth 查询不动。Protocol 恢复测试同时覆盖 continuous/replayable，并断言恢复不发该迁移 RPC。
- Bot 菜单原有跨 Workspace 全局缓存会在目标 View 失败后展示其他 Host 的模型；删除该缓存和本地借用路径，原持久选择不变，目标恢复后正常重读。回归测试显式保存真实 Bot context 后覆盖同路径不同远端身份，不能用未持久化的测试 context 假装切换成功。
- Pro `desktop-e2e-20260908170825961-p95934-accbbb3745ff04c4`：SR87-01、SR87-06 / SM96-02/05 两项通过。后者在隔离 Electron 停止后植入旧 SQLite 选择；当前 Team 不影响其固定迁为 Individual，Run now 的实际请求使用 Team/high，任务原意图和旧回滚列仍保留。未自动晋级 pending 用例。
- 二审：不新增存储版本；不修改历史消息、正在执行选择、闲时 Ticket；不增加发送前同步。Runtime 最终 Registry 校验保留，但不再因此从恢复结果删除原意图。删除 Desktop 派发前冗余 listAutomations 预迁移调用，实际 Repo ensureReady 保证离线迁移完成。
- 剩余：显式 Subagent 的执行侧公共解析协议待裁决；Markdown 当前内存导入将由 Todo97 用户目录原地迁移替换，不将这个过渡状态作为最终完成。真实 SSH 和手机实机尚未复验。

## Todo97 核心实现及二审

- 共享正式 Markdown codec 与 Node 文件迁移；Host、独立 Agent 先处理用户目录，项目/插件不进入写入范围。删除全 profile 内存身份转换、Markdown 中间态双读和 Host 重复 parser。
- 内置 JSON 先单向导入并落盘，再正式读取新 map；新值空/坏/缺档位不能从回滚旧 map 复活。
- 逐存储追踪见 [审计表](todo97-selection-storage-audit.md)。Session entry 的 thoughtLevel 确认是 staging 已发布写法，将它从普通 codec 移到 SQLite 迁移入口；历史消息展示 decoder 保留，不能混同当前选择恢复。
- 根61文件/900条、Agent17文件/201条扩大回归通过。二审增加 custom: Provider ID 编码歧义红灯，修后共享3文件/25条通过。根 typecheck/lint、Agent bootstrap typecheck 通过。
- Pro `desktop-e2e-20260908172422561-p96860-3f1d8f499a4468d5`：SE三条 + I20 共4条通过，保存产物和实际child请求分别验证；最终源码复跑 `desktop-e2e-20260908173630157-p97784-4db43b3562850f6d` 同样4条通过。
- 小阻塞继续记账：Wiki 旧文件读取不写盘与97一次落盘原则冲突，已请求裁决；未擅自改写。手机实机/真实SSH未测试。未发布中间态不逆迁移，Off-Peak Ticket例外不改。

## 最终组合回归与近期质量审阅

- [Todo88–97质量复审](todo88-97-final-quality-review.md) 已落盘，包含这轮自己引入、二审发现的两处新字段过度兼容；已用负向测试收紧。13文件/184条及Wiki UI 5文件/25条通过，根typecheck/lint通过（39警告/0错误）。保留已有未提交文件改动，只清理本轮两个未使用项。
- 最近设置/账号补充29文件/420条，连接迁移及选型补充6文件/62条通过；各组有重叠，不累加计数。
- Pro `desktop-e2e-20260908173912732-p98589-498cb410db57162d`：13通过、1真实remote跳过；最终源码重建后的 `desktop-e2e-20260908174309069-p99900-5e27de7ecbaf9767`：Wiki两项、Probe一项、API兜底一项、Subagent I20一项，5/5通过。
- 已提交94 `a56dc32c26`、95A/B `9b0f11e996`、96核心 `dd38abe9fb`、97核心 `0c32ba2b59`。后续二审补丁及推送结果见对应commit/最终回复；不把待裁决写成实施完成。

### 推送与提交版本补验

- `a0f686fc38` 二审补丁后，正常 `git push origin HEAD:provider-refactor-e2e-recovery` 成功。pre-push lint及103变更文件触发的直接/related单测通过，未绕过hook；实际远端从 `7cd5f57462` 前进至 `a0f686fc38`。
- 原工作区7个重叠源码/测试文件有用户已有未提交修改，未混入提交。在Pro隔离副本将这7个文件替换为HEAD版本，再跑Wiki、旧Provider导入、协议测试，11文件/198条通过，避免依赖未提交改动假绿。
- 本次没有推m2、合后续staging或发布Web；没有将手机/真实SSH跳过项或pending人工审阅当作完成。目标保留active，待95C、96协议、97Wiki三项裁决后继续。

### SA97-09 执行侧补验

- 在 Agent `packages/bootstrap/tests/subagents.test.ts` 补齐同一轮加载中的用户/项目/插件对照：三份相同旧 Provider 配置，连续执行两次真实 loader，用户文件仅修改 model 的 Provider 部分，项目/插件文件字节及显式旧身份不变。不是仅按静态调用图判断插件不会迁移；本项不冒充子任务实际请求验证。
- Agent 相关初始化/loader 两文件 9 条通过；根 `pnpm typecheck`、`pnpm lint`（39 警告/0 错误）与 Agent bootstrap typecheck 再次通过。此次只加强已裁决的范围保护测试，不改产品行为，也不越过三项待裁决边界。
