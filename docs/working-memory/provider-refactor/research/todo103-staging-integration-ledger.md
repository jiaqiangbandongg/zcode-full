# Todo103：staging 固定范围整合账本

> 执行中。基线 recovery `f0174b57f5c9157760879d17a5ebeeacf90bb85d`、staging `790884b1ce4b990583ab40625b5f283e2169eb36`；以来源 JSON 的完整 SHA 为机械校验依据。
> 分组、建议方向与事实证据分开记录；“计划保留”不是“已经保留”。源提交内不同意图允许拆开裁决。

## 1. 来源与状态

[完整 Goal](../steps/todo-103-staging-safe-integration.md)；[逐提交 / 文件清单](todo103-staging-source-inventory.json)。

来源清单：193 个非 merge 提交、60 个 merge 提交，941 个净变化路径，950 个历史触及或冲突路径。235 个双改路径＝107 个显式冲突＋128 个自动合并双改路径。没有净变化的路径仍保留历史来源，不能仅凭 HEAD 没差异认定无关。

本次工作区为独立 worktree。默认 projects 目录是另一工作区，不用于本目标。没有修改真实用户配置或远端应用数据。

## 2. 功能组与必须检查的边界

| ID  | 功能 / 来源方向                                        | 与当前重构交集、处理依据                                                                                        | 状态       |
| --- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ---------- |
| G01 | Windows 安装器、各平台发布和 preflight                 | 保留安装修复；版本保留 3.12.0，不回退 3.11.x；检查 CUA 打包、服务端能力与下载制品配套。已有85/m2恢复须证明等价  | 16条来源已裁决/实施；Windows执行验收待补，见17/18节 |
| G02 | Help config、内部技能、仓库架构门禁                    | 非冲突功能保留；新增门禁不得隐藏重构违反项；不把未要求的 MR 创建当成自动外部写入授权                            | 已裁决/批量保留；门禁证据见 §37 |
| G03 | CUA 生命周期、移除灰度、插件图标                       | 按当前服务边界重接；producer 升级只能使用原子工具，不手改 SHA；本地 / remote 和插件资源闭包                     | 已重接/构建及单测；见 §25/38 |
| G04 | Subagent 可用性、插件模型覆盖                          | 插件设置功能保留意图；协议 / 内部使用 ModelSelection，显式选择复用99，隐式继承不改；不写插件 Markdown           | 两条来源已实施/复审；待最终整合回归 |
| G05 | Bot 已删除任务恢复、飞书发送错误                       | Bot 绑定 Session 单一事实、公共命令 / 有效选择解析不回退；保留新恢复与错误提示                                  | 已实施、组内复审；见 §20 |
| G06 | Wiki 全局默认、remote路由与lane同步                    | 94输出limit、97一次迁移、99Worker事实不回退；不恢复旧 Provider store / generationModel 正式读取或第二套发送同步 | 已重接；Pro Wiki 通过，见 §23/38 |
| G07 | 会话内 OffPeakCreate/List、轮尾卡与编辑                | 已绑定 Ticket 不跨账号重映射；绑定 Session 与本次闲时执行选择分离；核对新协议 / 事件 / 权限 / 存储全链          | 已重接；OP10及绑定派发OP-CHAT-02通过，见 §41/42 |
| G08 | 官方版本安全校验的请求隔离、取消、超时与重试           | 保留安全挑战行为；不复活旧工作区catalog、自动恢复旁路；保留精确连接测试prompt和99应用确认                       | 已重接；Pro 四场景通过，见 §26/31/39 |
| G09 | OAuth 过期、stale401、候选端点隔离                     | 过期响应不得注销新登录；配置 / Account / OAuth 层边界不互相覆盖；错误不冒充无权益                               | 五条来源已裁决/实施/复审；Pro 2/2，见19节 |
| G10 | 套餐响应式、领取时间、购买入口和遥测；删除死购买流程   | 保留93状态变化提示＋手动CTA、完整 owned plans 不等于 current；删除死流程不能误删现用入口；新遥测适配Account事实 | 已重接；Pro 领取/购买/响应式通过，见 §35/38 |
| G11 | 对话分享 / Web share                                   | 保留独立功能；检查 Session / ModelSelection 新契约、隐私边界、资源与依赖、版本；不另起手机Host                  | 已重接/组内复审；公开发布未实跑，见 §31/41 |
| G12 | 权限拒绝反馈、路由字段、side chat / fork提醒           | continuous/replayable、CommandInbox、冻结执行及workspaceIdentity隔离；禁止老模型字段从协议回流正式运行          | 已保留/协议复核；Pro 权限 5/5，见 §41 |
| G13 | Subagent / usage / stop / 错误遥测                     | 保留分类、首次结算、底层错误归因；model id / provider id 用当前结构；脱敏与不重复报送                           | 10条来源已实施/复审；待最终整合回归 |
| G14 | 内存采样、Session事件保留、后台子任务释放              | 有界保留不可破坏 replayable恢复、持久历史、Subagent继承与已冻结模型；高频日志受控                               | 已保留/生命周期复核，见 §40 |
| G15 | 浏览器恢复 / 截图 / 视口 / DPI                         | 原行为保留或证明已恢复；检查 CUA 与插件入口依赖；不能为截图改变执行归属                                         | 已保留；Mac 两项通过/一项既有失败，见 §37/39 |
| G16 | mention选择、文件链接、插件搜索、添加菜单              | 保留交互；保留新Composer草稿与提交语义，所有入口双语 / 主题 / 手机兼容                                          | 已保留/Submission交集复核；见 §31/37/39 |
| G17 | remoteSessionId保存、scope日志、MCP watchdog测试       | path不是identity，settings tab不能丢远端session；测试等待变化须核对真实生命周期                                 | 已实施/单测复审，真实SSH验收待环境；见22节 |
| G18 | workspace / sidebar / terminal / settings 新布局与回归 | 分离展示与业务状态；保留当前模型设置smart配置、Map排版 / 键盘隔离；手机与各OS布局分别验收                       | 已重接；Pro 布局/编辑器通过，Windows待补，见 §39 |

## 3. 影响图摘要

模式：planning；总体跨 presentation / option-source / draft-default / validation / commit-effect / persistence / recovery，但按功能组缩小验证，不生成全产品笛卡尔积。

| 用户入口                | 展示 / 草稿                       | 共享机制                           | 提交与权威落点                                | 必须隔离                                                    |
| ----------------------- | --------------------------------- | ---------------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| Composer / 已有Session  | 本地未提交草稿、Session权威投影   | Selection View、V4命令             | 成功提交后Session保存；既有执行冻结           | 不因菜单刷新清空持久意图；desktop continuous 不掺手机replay |
| Account / Provider 设置 | 当前页面、账号状态、个人配置草稿  | 设置Facade、Config/Account/Overlay | Config事务；账号操作走Account服务             | 页面展示不代替真实连接；不混visibility、entitled、current   |
| Subagent / 插件覆盖     | 设置页草稿                        | 公共选择解析、Subagent服务         | 用户MD原字段或内部JSON覆盖；Agent加载迁移入口 | 插件/项目MD不自动迁写；隐式继承和内部override优先级         |
| Wiki                    | Wiki设置草稿 / 本次请求           | 公共选择、目标Host请求             | 一次迁移后的Wiki文件；固定本次模型            | 不改Session偏好，不增私有output预算                         |
| Automation / OffPeak    | 任务配置及编辑草稿                | 任务服务、Ticket、本次运行选择     | 普通任务配置；闲时Ticket/绑定Session各自状态  | Ticket绑定不变；闲时执行不得改Session模型                   |
| Bot                     | 绑定Session投影                   | Session命令及选择机制              | 同一个Session；/model立即保存是已裁决例外     | 不维护第二份当前模型                                        |
| Web分享 / 手机远控      | 独立分享展示、shared-host远控投影 | 各自协议与附件身份                 | 分享服务；Session仍归已有Host/Agent           | 不把分享业务下沉到relay，不另起远控Agent                    |

```text
配置 / Account事实 -> 完整解析快照 -> Host / Worker已有交付机制
                                       |
保存意图 / 当前草稿 --------------------+-> 公共有效选择
                                             |
                              新执行提交边界固定本次选择
                                             |
                                  Factory精确校验、执行
```

允许 Worker 暂时使用完整旧快照；不允许拼接新旧事实、假称已应用、错误清空用户意图或偷偷换模型。

### 关系分级与来源

- must-inspect：G04/G05/G06/G07/G08/G09/G10/G12 共享 ModelSelection / Account / 协议 / 持久化上下游；每组列具体调用路径后实施。
- should-inspect：G13/G14 中遥测、usage、事件保留与新的固定执行边界；G18 UI共享组件与恢复后的设置行为。
- conditional：G01/G03/G11/G15 的 OS、依赖与制品闭包；按真正改动的平台 / 产品入口验证。
- invariant-only：未触及的 Provider Built-in规则不凭“核心包无变化”认定所有消费者安全。
- evidence-only：单测、编译、静态可达分别记证据，不能代表产品等价。

### Codegraph 与图谱漂移

当前可用工具未提供 codegraph。使用固定 Git 差异及精准源码引用追踪，不能声称已完成 codegraph depth-2 分析。相关seed：Subagent服务 / bootstrap、ModelSelection公共入口、Wiki/OffPeak/Bot服务、SessionPane、Account快照与runtime headers。

图谱部分旧条款（Renderer/Host accepted queue、runtime defaultModelRef、Subagent待协议裁决）落后于当前 CommandInbox、ModelSelection 和 Todo99；只作为检索线索，不用于覆盖最新裁决。后续各组确认新的稳定产品关系后更新对应 graph 节点；不因本次整体审查批量重写图谱。

## 4. 已确认的初始风险（实施状态逐项更新）

| ID      | 来源                         | 当前证据 / 冲突                                                                                                                  | 处理方向                                                      | 实施 / 验证          |
| ------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------- |
| I103-01 | dbb3ec0ce8 / G04             | 只读 merge-tree 中 subagents-types.ts 自动通过，却新增引用未定义 AgentProfileModel 的插件 override 接口；还带 model/thoughtLevel | 插件覆盖功能按当前结构化接口重接；不能恢复旧类型让编译通过    | 已实施/验证，见13、14、16节 |
| I103-02 | 32f6cb43eb / G10             | staging 删除旧 native purchase 组件，本地有修改，产生 modify/delete                                                              | 按现用入口追踪；保留有效行为不等于恢复已废弃整文件            | 待核验               |
| I103-03 | 8423f78274 / G06             | 上游新增旧 registry lane 推送，而当前已有99完整事实交付                                                                          | 查远端Wiki lane的等价覆盖 / 缺口，只补缺失行为                | 待核验               |
| I103-04 | 84c4fcfc1d、89817f5be2 / G01 | 上游发布版本3.11.x，当前明确升到3.12.0                                                                                           | 保留3.12.0；逐文件保留其余平台发布修复                        | 版本已验证；历史发布记录保留，见18节 |
| I103-05 | 79413e33cb / G13             | 上游spec要求“无嵌套cause保持原行为”，实现却把单一Error本身作为cause；需局部测试确认                                              | 保留底层归因意图，同时按上游spec纠正无嵌套场景，不盲搬新增bug | 已修复并验证（G13-A）               |

## 5. 单项记录模板与检查规则

每项追加：来源 SHA / intent / current / conflict / decision + spec依据 / 实施结果与commit / 测试命令及结果 / 反向复审 / 仍未决。
JSON 中状态只有在相应来源片段全部有明确去向时才能改为完成。文件被其他组同时改动时，各组证据不得互相代替。merge commit 须检查自身人工resolution差异，不能全部标作“无内容”。

每组 accepted cases 在代码前写入当前领域spec / catalog / matrix。测试先区分“上游正确行为”与“回退到旧架构的错误实现”。关键错误不转交102绕过本Goal；历史失败与新回归分开。

## 6. 进度记录

- 2026-09-09：确认干净整合分支；固定SHA再执行只读merge-tree，未进入merge状态。
- 2026-09-09：重算来源清单，校正早期较小交集统计，建立18组调查路由；全部来源尚待行为级裁决，不冒充193个新功能。
- 2026-09-09：本次仅规划和记录；后续先按独立功能组补测试与实施，最后执行真实merge和整体复审。

## 7. G13-A：流式错误底层原因（已实现、复审）

来源：`79413e33cb`；六个来源文件均已处理。G13 其他九个提交仍待核验，不以本子组代替整组。

### 意图、现状与裁决

- upstream：终止流错误不吞底层网络原因；OTel 新增脱敏 `error.cause.type/code/message`，同源错误只在首个 span 记录。
- current：重构后已有通用脱敏与 WeakSet 认领，但 TerminalStreamChunkError 没有 cause，脱敏器只跟随标准 cause；底层包装原因未导出。
- decision：保留全部行为意图，局部接入当前实现；保留 `model-execution.js` 和扁平 `statusContext.providerId/modelId`，不复活旧 Registry / 嵌套 Model 引用。
- I103-05 已运行上游源函数确认：`new Error("plain")` 返回与自身重复的 cause，与上游 spec 第3条冲突。实现以“至少两个独立错误对象”判断，不照搬此缺陷；八层上限、循环防护和 cause → adapterError → error 优先级不变。
- 单条包装链不需要 breadth-first 队列，沿现有有界循环读取即可；没有引入新的重试、状态或 Provider 选择逻辑。

### 测试与执行证据

1. 先落 `docs/trace/model-attempt-error-diagnostics.md` 的 G13-A01–04，再补测试；修改生产代码前 38 条中 7 条如期失败，分别证明包装 cause、嵌套脱敏 / 包装识别及 exporter 属性缺口。
2. 用固定 staging 源码在内存中执行脱敏函数，普通错误输出包含重复 cause；没有改写或运行任何真实用户配置。
3. 实施后 CLI 工作区运行 telemetry 整包＋runner-retry＋failure-classifier：137/137 通过。
4. 扩大流式回归发现固定 recovery 基线已有测试遗漏：`openai-compatible-stream-usage-wire.test.ts:63` 仍实例化已删除 `AiSdkModelRegistry`，其余两个测试已使用 `TestProviderConfigFixture`。已核实基线原文，仅把遗漏入口改用同一夹具，保留 partial text / normalized other / raw max_tokens 三条断言。
5. 最终同次运行 14 文件、151/151：telemetry 整包，runner-retry、failure-classifier、runner-debug-failed-stream、openai-compatible-stream-usage-wire、offpeak-retry。真实 InMemorySpanExporter 验证根因脱敏、仅首个 span 记录、普通错误不新增 cause；不是只检查字符串源码。
6. 根 `pnpm typecheck` 通过；CLI adapters / telemetry `tsc --noEmit` 通过；根 `pnpm lint` 39 条既有 warning、0 error。根 ignore 不包含 CLI，另用根真实 oxlint 二进制在 CLI cwd 检查7个修改的TS文件，0 warning / 0 error；不能把早先“0 files”当作CLI lint通过。
7. 当前 Linux Node 为24.19.0，CLI锁定24.14.0产生 engine warning；本子组是无平台副作用的诊断逻辑，最终配套Pro构建 / 总体验收仍按原计划执行，不声称已在Pro验证。

### 双向复审

- staging → 结果：六个来源文件的包装cause、深层字段、首认领、脱敏、测试、spec都有去向；其原测试使用旧模型状态形状，改为直接验证真实 AdapterError 包装身份，未恢复旧接口。
- 重构 → 结果：没有改 Registry、Account、Selection、请求 payload、重试上限、关闭档位或持久字段。runner-stream 的 TerminalStreamChunkError 特殊分支仍抛出原 adapterError，用户错误文案与重试判定入口不变；相关流式 / 闲时回归通过。
- 本子组无新 App 交互，不新增 UI E2E；其他 G13 的 Banner / completion 行为仍须分别测试。
- 图谱只给现有 data-observability 节点补2个精确seed和spec链接；新seed均可解析。全图336节点ID唯一；发现4条既有悬空边，已与固定recovery基线逐条对照相同（不是本次新增），不能宣称全图完整性全绿。后续G02治理组单独记录，不扩为此子组修复。

实施提交：本节随 `fix(telemetry): integrate staging stream error cause diagnostics` 一起提交；完整 Goal 仍在执行，尚未进行最终 merge 或合回 recovery。

## 8. staging 自身 merge-resolution 审计

2026-09-09 对来源清单60个merge逐个执行 `git show --format= --remerge-diff <sha>`（Git 2.43.0），不是只看merge标题或相对第一父提交的累计变化。58个没有独立remerge差异；其功能仍随来源组审查，不表示这些功能已通过。

| merge        | 独立处理内容                                                                                                             | 裁决与归属                                                                                 | 后续           |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | -------------- |
| `5ded50a096` | CHANGELOG合并3.11.2并删重复pacman记录；package/lock选3.11.2；runtime-asset测试同时保留缺失Helper提示及Helper路径正则断言 | G01：当前3.12.0优先；保留历史changelog意图和有意义的打包断言，不能恢复旧版本或丢掉任一断言 | 随G01整体验证  |
| `a1026cad35` | UnifiedBrowserView测试保留两条注释：启用菜单不写aria-disabled=false；点击后菜单关闭，需重开检查DevTools                  | G15：注释与测试意图保留；不是新增产品状态或Provider实现                                    | 随浏览器组验证 |

来源JSON已记录每个merge的审计结果、额外路径及组归属。没有发现上述独立差异之外的新功能片段，但最终真实合并仍须检查结果，不把remerge审计代替功能验收。

## 9. G13-B：停止来源生产诊断（已实现、复审）

- 来源：`8e3e10df4d`、`ee30f2ad33`。排查误停时区分按钮与 Esc；第二条修正第一条使用普通 info 导致生产静默的问题，两条合并保留。
- 当前代码已有 `canStop`、focused/readOnly、弹窗 Esc 让路与 `expectedForegroundExecutionId` 防误停。只补来源诊断，不恢复 SessionPane 中其他旧 Provider 恢复流程，不改变命令协议、Session 持久状态或远端同步时机。
- 先写 `docs/monitoring/session-stop-source-diagnostics.md`，再补两条失败测试：原代码发出 / 跳过路径均无 lifecycle 日志。实现后进一步覆盖 Esc 分支，并加强真实生产 Logger 分支“不转发普通 info”的断言。
- 运行 SessionPane 模型切换 / 停止测试整文件及 Logger：55/55 通过。原有远端直接发送、不调用 updateProviderRegistry 等断言仍通过。根 typecheck 通过；根 lint 39 条既有 warning、0 error。
- 双向复审：上游全部来源日志、两种来源参数、发送失败 warning 都已接入；命令内容与生命周期防护原样保留，没有引入新队列或重解析。生命周期日志只证明发出尝试，不冒充已停止。
- 无新交互行为；原有停止 / 队列 E2E 保持不变，最终整合仍需批量回归，不把本地组件测试记为 Pro / 手机实测通过。

## 10. G13-C：底层错误结构化详情（按当前隐私契约重接）

- 来源：`e690365f2e`、`a5f4687368`。前者提取最深非 wrapper 错误，后者补齐事件、V4 投影 / Schema 与 UI 转换中的漏传。
- 保留：Core 选取同一个底层 frame 的 message/detail；12 层及循环防护；TurnErrorPayload → ProductProjection → lastError schema → SessionPane / normalizeZCodeUiError 的完整传递；message 诊断上报。缺字段保持省略，不改错误分类、文案、重试、安全校验、反馈或有效模型选择。
- 明确裁决差异：现行 `docs/monitoring/conversation-telemetry-v4.md` 明确禁止上传完整 detail、URL、认证头、响应正文。上游新增 `error_detail_text` 原样上传任意底层 detail 与之冲突，因此不恢复该上报字段；内部字段保留。新增 message 遥测保持500字符上限，并对识别到的认证 / 凭据、URL和HTML返回固定脱敏提示。该检查不声称能识别任意隐私正文，错误生产者仍须遵守原契约。
- Spec：`docs/chat-error-detail-telemetry.md`。先引入上游测试与包装路径测试，生产改动前 UI 10 条失败、CLI 3 条失败，定位到原缺失位置。隐私复审进一步补“不得上传 detail”断言，原转发实现4条失败，再移除不应恢复的上报。
- 验证：Core turn-errors + Bootstrap ProductProjection 188/188；共享协议、Schema、UI Banner / normalization / stop / Logger 共225/225。新增 Schema 测试第一轮 fixture 漏必填 type，修正 fixture 后通过，不归因产品错误。
- 类型验证：根 typecheck 通过；CLI contracts/core/bootstrap 均通过。Bootstrap 首轮使用 contracts 旧 dist 类型出现缺字段，执行 contracts build 后重验通过，未靠类型断言规避。根 lint 39条既有warning、0error；CLI5个相关文件2条既有无用转义warning、0error。
- 双向复审：来源13个代码/测试文件及spec均有去向（含明确排除的原始detail上报）；本次只是已有错误投影的可选字段传递，没有新增状态源、重试或执行模型回退。Schema确实保留新增字段并拒绝错误类型，不只是TS接口变更。
- 本地没有执行真实 ARMS 发送，也没有改用户数据。最终整合的桌面错误 Banner 回归仍需完成；不能用组件与Schema通过代替跨进程实机验收。

## 11. G13-D：后台 Subagent 统计与独立 wake 身份（已实现、复审）

来源：`e45f22f213`、`f25fe79f5a`、`253f01d496`、
`c726bc27e3`、`805b943fc9`。这五条迭代视为一个最终行为，不把早期实现与后续修复叠加成两套统计。

### 裁决与接线

- 保留 child 工具逐条零用量 step；首个 terminal/stopped 追加一次 Agent 汇总，只计算此前已确认 usage，
  不回填已结束父轮，不新增 child completion，不等待迟到 usage，不引入 timer/outbox。
- stopped 后仍保留已开始工具及权限等待，直到工具排空或 child terminal；迟到新工具不重开统计。
- main completion 的组成按本轮实际消费结果判断，active-loop 和独立 wake 均覆盖；Bash 不算 Subagent。
  独立 batch 仅整批同源才细分 message_source，混合/缺失来源不按首条猜测。
- 独立 wake 与普通命令复用 UUID v7；持久化 synthetic messageId 保留用途，不拿它冒充输入 ID。
- 当前扁平 `ModelNetworkStatus.providerId/modelId`、ModelFactory、ModelSelection、99 有效解析、
  命令持久账本与已冻结执行全部保留。按五个来源的具体 hunk 接入，未覆盖 Core/SessionPane 整文件。
- foreground 与 background 共享 step builder，分别使用父轮及 detached child 统计状态；
  `dep:refs` 仅列出三个测试引用，补充精准 rg 找到 supervisor import/调用，共同完成改名核对。
  不将静态工具漏报当成“没有调用方”。
- schema 只增加无正文的可选来源字段。手机 replayable 不补历史埋点，仍由现有可信 desktop
  continuous attachment 消费 live facts；未新增 remote/Host/Account 同步。

### 已执行验证与新发现

1. spec 先更新模型/用量归属、automation 来源及 Tool Change Chain；上游 spec 的嵌套旧模型身份
   改为当前扁平字段，补清 active-loop 消费边界，历史 artifact 不冒充本分支通过。
2. 先加测试：UI/shared 143 条中34条失败；CLI279条中12条失败。新增初始化取消测试改用当前
   `createTestAgentRuntime` fixture，不恢复上游直接构造的旧 Runtime 依赖。
3. 实施后 UI/shared 最初144/144，再扩大 attachment/错误诊断回归251/251；
   CLI278/279。唯一失败为原有 `Core admission ACK 不等待 TurnStarted projection；旧 revision
   retry/file rewind 只 stale`：期望 stale，实际 executionFailed；生产改动前也同样失败。
   此项路由 G12 继续定位，不能把整体 CLI 测试记为全绿。
4. 根 typecheck、CLI contracts/core/bootstrap typecheck 通过（先构建 contracts）；根 lint
   39条既有warning、0error；最终 E2E 修改后重新执行根 typecheck/lint，结果相同。
   CLI 另以 `oxlint --no-ignore` 检查17个修改文件：42条既有warning、0error，未把根忽略CLI当作通过。
5. 发现来源自相矛盾 I103-06：e45 的 BG26 断言后台失败“没有 Agent step”，后续805已规定
   无 usage 也结算。修正 E2E 为恰好一个 failed Agent、0个已确认 usage request、0 token，
   保留 provider 错误及“不产生 child completion”；不是把失败用例删除。
6. Pro 使用既有隔离源码副本 `/Users/dev/zcode-todo99-e2e.1lO3PN`，不是日常 checkout；
   同步本整合分支源码并重建 Electron/Agent。该副本无.git，build-meta 的 unknown 不能充当版本证据。
   使用 strict case-local replay，Node24.14.0 / Electron41.0.3 / Chrome146.0.7680.80。
7. 首跑 `desktop-e2e-20260909-141601-940` 为3/4通过。BG13等待通知失败，运行时日志明确记录
   child Bash 在新草稿中处于 build 模式、命中 `mode.build.highRisk` 等待批准。
   I103-07：suite只在before设置一次Full Access，新草稿重置模式；不是通知丢失。
   测试改为每次创建草稿后明确选择Full Access，不修改产品权限规则，也不跳过权限测试。
8. 修正前置后 `desktop-e2e-20260909-142100-814` 五项全部通过：后台Bash通知、前台child工具、
   同轮混合组成BG45、后台child隔离BG13、后续主消息身份隔离BG18。
   `desktop-e2e-20260909-142145-836` BG26限流/零usage结算1/1通过。共六个不同关键用例通过。
9. `desktop-e2e-20260909-142254-924` 再跑BG13/BG18，2/2通过，并保存最终HTTP证据到
   Pro隔离副本 `.e2e-artifacts/todo103-g13D-final-http/{BG13,BG18}-token-identity.capture.raw.json`。
   两例均为 child Bash 0 token、Agent 汇总2次请求/284 token，归属于原launch消息；独立wake使用不同UUID v7。
   captureStages 确认为 eventReport=http-final、armsRenderer=renderer-pre-ipc、armsFinal=main-send-custom。
   最终发送由测试捕获，不向真实ARMS服务发送；不提交原始机器/账号标识的capture文件。

### 双向复审

- 五条来源的最终统计、身份、来源分类和测试/spec均已保留；没有重叠叠加早期实现。
- 对照固定staging最终normalizer / supervisor / messageTelemetry / telemetry schema，关键差异仅为
  normalizer使用当前扁平Model身份；未恢复嵌套Model、旧Registry或Account旁路。
- 不改变已固定的父/子执行模型、99显式解析、隐式继承、权限规则或CommandInbox持久账本；
  后台Agent首次结算、防重复、迟到usage与取消边界由单测覆盖，真实跨进程链由上述E2E覆盖。
- G12原有stale-revision失败仍须查清；不把它归咎本组，也不提前宣称最终协议回归全绿。

本子组随 `fix(telemetry): preserve subagent usage and wake attribution` 提交。G13其他五条来源已由A/B/C处理；全Goal其他功能组、
真实 merge、双向总复审和最终关键验证仍未完成。

## 12. G04-A：Subagent 候选可用性（已实现、复审）

- 来源 `5161e0914f`，7个来源文件全部有去向；插件覆盖 `dbb3ec0ce8` 仍单独处理。
- 保留失效模型编辑器显示“选择模型”、不补候选、不清草稿、不写原文件的行为。
  源UI使用已删除的Provider快照/Family键，改为当前Selection View；只调整触发器，不改读写边界。
- 上游进入Subagents显式refresh的意图已由公共hook首读+订阅等价覆盖。新增卸载/重挂载及
  Start→Individual→Team事件测试，证明重新进入读当前快照，挂载时通知更新，不重复引入强刷。
- 上游Storage按endpoint去重造成Start/Individual串名单；当前按Provider ID构造Account Overlay。
  不恢复已删除modelProviderServiceStorage及旧测试；新增真实AccountResolver→ProviderResolver回归：
  同endpoint、同名模型及各自独有模型保持隔离，非current Individual不进入Registry，API不受影响。
- 测试先行：UI/shared hook/provider共59条中仅新增文案断言失败；两个等价机制的测试直接通过。
  修复后增加Account resolver整包为71/71。非ready时原意图不判失效的断言保留。
- Pro隔离副本重新构建Desktop（本组未改Agent，复用上一组已重建Agent），strict replay
  `desktop-e2e-20260909-143258-266` SE-03 1/1通过。真实删除成员后验证Select model文案、
  菜单无旧成员、reasoning隐藏、保存禁用、Markdown字节完全不变。
- 根typecheck（含E2E）通过，lint39条既有warning/0error；diff检查通过。
- 双向复审：来源UI/service/spec/tests全部有去向；没有恢复metadata/catalog双源、Family selected key、
  Registry下发、旧Provider类型或写盘迁移。主模型主动选择最高档、99显式执行解析仍保留。
- 提交：`fix(subagents): preserve unavailable selection without misleading labels`；G04-B及最终整合仍未完成。

## 13. G04-B1：插件覆盖存储与启动接线（底层完成；来源提交仍未完成）

- 来源`dbb3ec0ce8`的覆盖存储/Agent加载部分；同提交的官方缓存发现、行内UI、商店刷新仍待B2/B3，
  不提前将来源或整个文件标记reviewed。完整当前合同写入Subagent spec的G04-B节。
- 保留插件稳定身份、覆盖整组model/档位、规范名与裸名别名一致、默认值只来自插件Markdown、升级目录不影响键。
- 与现行抽象冲突的旧`AgentProfileModel`和双map写入不恢复：新写入使用`pluginAgentModelSelectionOverrides`，
  Service/RPC传`{agentId, modelSelection?}`，正式Host/Agent reader复用严格结构化解析。
- 来源staging的插件双map由现有共享存储导入边界转换（不是运行时读取兼容，不兼容未发布Markdown中间字段）；
  复用既有离线Provider身份规则、文件锁/原子写，不新增迁移系统、账号查询或Registry依赖。
  正式map存在即权威：空/损坏不回读，model-only不回填旧档位，正式旧ID不继续猜测迁移。
- Agent复用`loadZCodeAgentProfiles`已完成的state结果，在create-app装配处注入插件loader；没有新增同步IO。
  Plugin profile仍交现有99显式有效解析，未修改ModelFactory、隐式继承或闲时固定执行。
- 先补失败测试：共享+Host39条中5条失败，Agent9条中1条失败；实现后扩大为共享/Host/store6文件59/59，
  Agent profile/bootstrap/runtime-config3文件57/57。Host测试真实临时文件并发保存Builtin/Plugin/disabled状态、
  清除/换模型、规范名/别名和原Markdown字节保护；Agent测试实际读盘导入后验证两个profile入口与跨插件隔离。
- 根typecheck通过，CLI contracts/core/bootstrap类型通过（先build contracts）；根lint39既有warning/0error；
  CLI三修改文件2既有unused type warning/0error（BuiltInSubagentName、AgentRuntimeDeps原已存在）。
- 此提交只接底层能力，尚未开放新的UI操作；B3必须补真实Settings/冷启动请求验证，不能以本节单测代替。
- 提交：`feat(subagents): adapt plugin model overrides to selection state`。最终merge和恢复分支交付仍未进行。

## 14. G04-B2/B3 UI：官方缓存发现与插件行内覆盖（完成；冷请求与商店刷新仍待）

- 继续处理`dbb3ec0ce8`，不将该来源提前标完成。三类Settings资源的默认启用名单统一移到
  共享市场契约；Node-only扫描放共享Node入口，避免新增跨域导入Plugins服务具体实现。
  保留现行computer-use默认启用（上游四项名单漏此项），新增与CLI definition逐项比对。
- 缓存只补无安装记录的官方身份；显式false及suppressed优先，安装记录优先且不被缓存复活。
  数字版本0.1.10优先0.1.9；不读备份/临时目录；manifest.name不匹配的更高版本回退。
  最初默认发现与名单一致性测试均失败；补丁后通过。新增已安装+enabled+suppressed样本先失败，
  证明抑制检查不能只放缓存分支，修后通过。
- 插件与内置共用现有行内控件，完整Selection按稳定agentId保存；主动选模取最高档，手动effort
  修改原子保存；其余插件字段只读。保留原控件保存失败回滚、保存成功刷新失败不回滚边界。
  两种语言提示一并迁接，不恢复旧model/thoughtLevel写入或Provider元数据双源。
- I103-08：Pro `desktop-e2e-20260909-145438-372` 首跑SE-04失败，定位到当前
  `settingsUserOnly`模式直接剪掉pluginAgents。改为返回独立只读资源投影，agents仍仅用户/内置。
  新测试先失败，修后验证不读项目profile、不加入运行时别名、项目Markdown字节不变。
- I103-09：第二次`desktop-e2e-20260909-145849-535`仍失败。实际日志显示文件列表在
  14:59:05.435结束，CLI插件seed到14:59:05.718才完成，此后没有列表刷新。
  用户页没有targetWorkspace时又跳过既有inventory初始化。复用该入口，以可用本地workspace
  作调用上下文、明确user scope；完成后刷新资源。原用户/内置首读不等待，不新增轮询、超时或
  Account同步。Promise完成后仅活跃页面消费；卸载与迟到回调两例先失败再通过。
- Pro重新构建Desktop，Agent复用本轮已重建版本；`desktop-e2e-20260909-150213-807`
  SE-02/04 2/2通过：全新seed后首次页面出现judge、整组模型/最高档/显式high写盘、无旧map写入、
  插件行不可编辑、judge文件字节不变。没有通过放宽超时或预置已完成缓存绕过冷启动缺陷。
- 最终Host/Skills/Commands/UI四文件111/111；CLI两个文件58/59，其中新增默认名单对照及
  全部plugin Subagent加载测试通过。唯一失败为既有Electron packaged CUA seed断言：测试常量
  路径0.5.13而当前wrapper0.5.14，修改前该断言/常量已如此。路由G03复核原子producer契约，
  不在本组手改CUA版本或将CLI全包写成通过。
- 根typecheck通过（含E2E），lint39条既有warning/0error；清理formatter对Skills/Commands
  的无关整文件排版，仅保留默认名单的导入/删除差异；diff检查通过。
- 双向复审：缓存发现、用户页入口、双语、响应式共用控件与持久化来源均已迁接；不写插件/项目
  Markdown，不改99解析/Factory/隐式继承、用户scope存储或desktop/phone消息流。
  插件冷启动provider请求闭环、商店自动刷新及来源末轮复审仍待，不能以此宣布G04完成。
- 提交：`feat(subagents): expose official plugin model overrides in settings`。

## 15. 执行策略补充：安全合并、按风险批量验收（2026-09-09）

- 用户最新五项裁决已写入 Todo103 完整 Goal：只修合并回归、旧接口漏接及阻碍本次保留行为的问题；无关既有问题只记录。
- 来源清单和逐功能裁决不缩减；低风险无架构交集项按批次实施、复审、提交，共享构建、typecheck、lint 和回归。高风险交集保留有区分力的重点验证，不再要求每个小项单独重复全套流程。
- 测试失败先归因：合并回归／既有产品问题／过时测试／环境前置。尚无证据的失败保持待查；既有问题仅在阻碍本次保留行为或与待合来源有交集时纳入修复，不因相邻分组名称自动扩修。
- 已有两项失败据此处理：CUA packaged seed 的 0.5.13 测试路径与当前 0.5.14 wrapper 不符，记为既有测试版本不一致，G03 仅在来源交集核验时复查；stale-revision ACK 断言在 G13 修改前已失败，记为基线既有失败、具体归因待查，G12 核验是否影响保留行为后再决定，不预设本轮修复。
- G04 后续商店刷新及插件请求闭环按风险共同组织验证；已通过的 111 条 Host/UI 单测、SE-02/04、类型检查与 lint 可复用为对应提交的证据。发生相关代码变化后补增量或最终批次验证，不无条件重复 Pro 构建与同一用例。
- 双向总复审、来源全部有去向、最终关键验收、真实 merge 及安全合回 recovery 的标准不变；不自动推送，不借 Todo102 转移本次关键验收。
- Goal 工具当前只提供创建、读状态及完成／阻塞标记，不能编辑现有 objective 或恢复暂停；现有 objective 已明确引用 Todo103 全文为完整执行契约，本次通过更新该契约落实补充，不伪造完成以重建 Goal。

## 16. G04 收口：官方商店刷新、插件覆盖冷启动及来源复审

- `dbb3ec0ce802826aa6a807a4a33e1e441234ada3` 剩余商店行为按来源保留：进入页面只自动刷新 ZCode 官方目录，距成功刷新或最近尝试不足十分钟时跳过；模块内先占位，避免重挂载和失败后的重复请求。手动刷新仍刷新全部市场，不受自动窗口限制；不自动刷新 Claude 市场，不新增轮询。
- 保留当前 Host 用户 inventory、configScope 和 workspaceIdentity 接线；没有恢复旧 Provider/Family 数据源或插件 Markdown 写入。CONTEXT、商店 spec、生命周期目录和覆盖矩阵同步更新。
- 来源 29 个路径逐项对应：存储／RPC／加载由 B1 接入结构化 Selection；默认官方缓存发现、Commands／Skills 和设置页／双语由 B2/B3 完成；商店 helper／页面及 WDIO fixture 在本批保留；文档和功能图同步本批及前两批结果。24 个仅属于 G04 的路径已核验，5 个跨组路径只记录 G04 片段完成，仍保留其他组 pending，不提前结清整文件。
- 新增 PLM-LC-020 pending 冷启动请求用例，复用 SE-04 已证明的保存格式。完整重启 Desktop／Host／CLI 后，真实捕获插件 judge 的子请求为 alternate model/high，父 continuation 仍为原 model/max；按最新 user block 类型区分 child 和 tool_result，避免只匹配包含子提示词的父请求产生假阳性。执行结束、队列为空、持久覆盖未改写均有断言。
- 测试先行：官方刷新 helper 缺失时测试模块无法加载；实现后与既有商店 store/listing/error-target 联合 4 文件 52/52 通过。根 typecheck（含 E2E）通过；根 lint 39 个既有 warning、0 error；新增冷启动用例之后再次 typecheck 通过，增量 lint 1 个既有 warning、0 error；diff 检查通过。
- Pro 隔离副本 `/Users/dev/zcode-todo99-e2e.1lO3PN`：`desktop-e2e-20260909-152018-653` 的 PLM-LC-018/019 共 2/2 通过，分别验证刷新窗口内跳过及旧目录通过真实公共 CDN 更新后重入不重刷。`desktop-e2e-20260909-152419-828` 的 PLM-LC-020 1/1 通过，使用隔离 replay 和实际请求捕获，不使用真实模型账号。
- 前置失败分类：首次 renderer build 未带 `VITE_ZCODE_E2E_STORE_BRIDGE=1`，onPrepare 即拒绝，属于测试构建环境，不作产品 bug；按既有要求重建后通过。新增 fixture 最初放错目录，经 fixture 校验发现并改为 plugin-management，复验通过。没有为此扩修产品或重复构建未变的 Agent。
- 来源 018/019 仍为 pending，新增 020 同样 pending；本机通过不等于人工晋级正式 CI，019 的真实 CDN 边界保持不变。手机验收未在本组冒充通过。
- 功能图只接入来源的插件覆盖名称／控件／持久化引用；336 节点唯一性通过。发现的 4 条 dangling edge 与固定 recovery 完全相同，按本轮边界只记录，不扩修治理图。
- 双向复审：两条 G04 来源均有去向，无未解释丢弃；旧双 map 只经既有一次导入边界，不成为正式运行态回读源。99 的显式有效解析、内部冻结 override 优先、隐式父模型继承及 Factory 精确校验均不变；不写项目／插件 Markdown，不改变消息流 continuous/replayable 边界。
- G04 已完成组内实现、验证与复审；G13 已完成。其余功能组、固定 staging 真实 merge、双向总复审和最终合回 recovery 尚未完成，Goal 保持执行中。本节证据与第 12～14 节共同构成本组验收，不逐小项重复全套构建。

## 17. G01 首批：开发资源准备及已有等价构建契约

| 来源 | 裁决与去向 |
| --- | --- |
| `b68966b818` 开发启动不下载旧 GLM | 保留。先更新两份 runtime/bundle spec 和失败断言，再移除 preflight 中旧原生 Agent 检查及仅服务该检查的局部函数。脚本结果与固定 staging 一致；保留 native-search verifier、macOS window helper、Windows browser helper opt-in。 |
| `a91244048b` pacman 默认压缩 | 已有等价实现：当前 `a19cfe3f63` 已移除显式 compression，测试文件与固定 staging 一致。本批验证后不再重复叠加配置。 |
| `d9234670a3` 恢复 darwin x64 映射断言 | 当前测试已保留该精确断言，验证通过；不因相邻 Linux 过滤来源尚未实施而删除或重复添加。 |

- 交集审查：`dev-desktop-env.mjs` 仍先 pre-dev，再 build-desktop-agent-cli，随后启动 runtime；process manager 优先解析 workspace `dist/zcode.cjs`。因此移除旧 native 下载不会移除 Agent 构建，也不改变远端部署、Provider readiness、账号同步或会话选择。保留 3.12.0，不引入 staging 的版本回退。
- 测试先失败于仍有 `label: "glm"`，其余 56 条通过；改动后 runtime assets、Linux packaging、manifest helpers 联合 3 文件 57/57 通过。根 typecheck 通过；根 lint 39 既有 warning、0 error；diff 检查通过。此次未执行可能下载／覆盖本地资产的完整 pre-dev，也不把单测算作各平台安装包实测。
- 双向复审：两份文档只迁入该来源 runtime 准备段落，保留当前 Provider/Environment 和 shared-host 架构内容；runtime-asset 测试仅调整旧 GLM 断言，未整文件取 staging、丢掉当前 Built-in Config 打包保护。pacman 与平台映射复用当前等价代码。
- 只结清上述三条来源和仅由这些来源触及的路径。electron-builder、runtime-asset tests、manifest tests 仍含其他 G01 来源，保持 pending 并追加本批片段证据；Windows installer、签名／公证、Linux 更新过滤等继续处理。无关既有问题未扩修。

## 18. G01 第二批：安装器／签名／Linux 更新与发布身份

### 来源裁决与实现

- Windows 八条来源 `049b2a539b`、`36368ef523`、`acb87a9a18`、`4b9f3844cf`、`a698fede1c`、`22d92c5dac`、`43839fd9a1`、`dd0b06f91c` 按固定 staging 最终行为整体保留：ownership manifest 限定 managed 更新清理；HKCU／SHELL_CONTEXT 清理诊断；静默错误框默认退出；安装详情阶段及逐文件清理日志；按旧卸载器 manifest 能力决定是否进行 `.zcode` 保护扫描；生产／Preview AUMID 与打包 appId 一致。
- 不扩入旧版本备份／回滚、重做 NSIS 原生重试或 junction 扫描。普通卸载仍沿来源全量清理，隔离 fixture 不接触真实安装／用户数据。原 spec 的“原子落盘”没有实现证据，改为准确的随包落盘描述，不宣称额外事务保证。
- `50a9c63c12` + `bbcc946c38`：保留 Helper signIgnore，避免 electron-builder 重签已签名／公证的嵌套 Helper；doctor 的必需 Helper gate 增加本地 staple 校验，并在文件存在、codesign/spctl 通过后才检查 xcrun，避免前置工具错误掩盖真实 Helper 错误。可选 Helper 的既有边界不变，不运行签名、公证或发布操作。
- `7beb6487b2`：保留 Linux manifest 中 pacman/rpm/deb 过滤及过滤后为空的明确失败；macOS/Windows 不过滤。新增直接调用正式 resolveFiles 的验证，证明过滤接入实际解析入口、保留 AppImage 地址/校验值，而不只是 helper 单测通过。
- `84c4fcfc1d` + `89817f5be2`：保留 3.11.1/3.11.2 历史发布条目和 merge `5ded50a096` 的重复 pacman 条目删除；不恢复大量无关旧 changelog 排版。对新发布段逐行标准化核对，staging 新记录缺失 0 行。当前 package.json 保持 3.12.0；根 npm lock 原来仍是 3.11.1，仅把两个根版本字段对齐 3.12.0，不改依赖锁内容。

### I103-10：正式 UAC 状态漏接

- 来源 installer 的 `ZCODE_INSTALLER_IS_ELEVATED_INNER` 默认恒假，只有 smoke fixture 显式改为 true；真实 electron-builder 模板并不注入这项定义。因此来源的提权内层日志路径保护没有在正式构建生效，单看模拟测试会误判已保护。
- 这是阻碍本次保留安全行为的接线缺口，纳入小修：默认包含同一 UAC.nsh 并引用 `UAC_IsInnerInstance`；fixture 仍可显式替换，不重做权限／提权流程。新增正式默认值断言先失败，改后通过；真实 NSIS 编译也覆盖未覆写此默认的 preserve-files fixture。

### 验证及明确限制

- 测试先行：新增来源测试在接入前出现 10 个断言失败、2 个新 helper 缺失导致的收集失败；实现后联合 9 文件为 138 通过、2 个 Windows-only 用例跳过。随后补正式 manifest 解析与版本对齐断言；版本断言先报 3.11.1 != 3.12.0，再修正。最终两个受影响文件 17/17 通过（整体联合证据合计 141 个通过、2 个 Windows-only 跳过，未把增量重复运行次数相加）。
- NSIS 模板新增一项真实依赖验证：读取当前 app-builder-lib 的 installSection.nsh，只改临时副本，验证阶段顺序、幂等和恢复原字节，不修改 node_modules 中的模板。此项已包含上述 138 条联合结果。
- 从 electron-builder 校验下载器取得锁定 NSIS 3.0.4.1 / resources 3.4.1；Linux 原生 makensis 实际编译 installer-nsh-smoke 与 preserve-files 的 installer/uninstaller 四种组合均成功，uninstaller 使用 /WX 对应选项。隔离编译产物：`/tmp/todo103-nsis-compile-fqZl75`。没有运行真实卸载或删除用户数据。
- 根 typecheck（含 main/host/E2E）通过；根 lint 39 个既有 warning、0 error；新增末轮测试增量 lint 0 warning/0 error；Node/shell 语法及 diff 检查通过。没有在未变的 Pro 上重复跑不覆盖 Windows 安装行为的桌面用例。
- **Windows 真实执行仍未完成**：当前 Linux 的两个 Windows-only 测试是跳过，不是通过；安装／卸载文件保留、锁文件失败、日志和快捷方式需在隔离 Windows 环境运行现有两套 smoke。四种编译不能替代它。保留为 G01 本次关键验收待补，不转交 Todo102，也不因此阻塞其他功能组。
- macOS doctor 测试实际执行 shell，但 codesign/spctl/xcrun 为隔离可控工具；证明校验顺序、参数与失败传播，不冒充已公证生产包验证。最终构建检查继续按对应平台与可用制品核验。

### 双向复审

- installer、辅助脚本与领域 spec 的来源行为均有去向，新增 UAC 默认接线有单独证据；不新增 Provider/Selection 状态或持久化迁移。
- electron-builder 相对固定 staging 只保留当前 Built-in Provider Config 资源，不恢复旧 chinaLlm catalog；其余 G01 构建差异均已迁入。runtime-asset 测试同时保留当前 Built-in Config 打包断言、缺 Helper 提示和 Helper signIgnore 正则，覆盖 merge `5ded50a096` 的有意义 resolution。
- main/index 只加入 Windows AUMID 调用，不覆盖同文件的 Host/remote/account 变更；打包态读取构建期 ZCODE_ENV，开发态独立身份，macOS/Linux 不进入该分支。
- G01 全部来源已有裁决及实现去向，但 Windows 相关项保留 `implemented-awaiting-windows-smoke`，其余来源已完成组内复审。共享 main/index、package.json 仍保持其他组 pending。本批可提交到隔离整合分支，不据此合回 recovery 或标记整个 Goal 完成。

## 19. G09：OAuth 401 与失败页交互（已实施、组内复审）

### 来源、裁决与交集

| 来源 | 意图 | 处理结果 |
| --- | --- | --- |
| d17cb6a800 | 登录失败态允许取消回到渠道列表；新流程清残留错误；失败不与渠道列表同屏 | 保留，WelcomeScreen 使用原 hook/store/重试渠道归属；不新增 UI 状态源 |
| a172e9c398 | 当前业务 access token 的 userinfo/customerInfo 401 复用原退出提示 | 保留严格 origin/path/当前 token 范围；支付、模型 API Key、业务正文错误不扩入 |
| 71a195b6be | 分类到提交之间重新登录/刷新时，迟到 401 不误退出；刷新写回进入已有队列 | 按当前架构重接：条件复核、原会话清理和 generation 保护保留，同时保留重构后的 accountIdentity 清理参数 |
| f26d4e75fb | 一个非法 URL 配置不阻断另一合法身份接口的 401 分类 | 保留两候选独立安全构造；共用已有 userinfo URL 配置定义，不放宽域名/路径边界 |
| 846b31c21b | credentials.json 全域代码审计文档 | 原文保留为历史审计，加固定基线/旧链接/当前架构替代说明；其中 CLI、MCP、加密及跨进程事务问题不自动变成本轮修复任务 |

**交集 I103-11：** staging OAuthService 退出回调仅带 provider；当前回调还带
accountIdentity，派生凭据按账号键删除。整文件恢复会丢掉已裁决的清理边界。因此
新增条件退出在同一个会话队列内、清凭据之前读取原 profile.id，再交给当前
notifyProviderLogout(provider, accountIdentity)。手动 logout/unlink/logoutAll/启动过期
恢复仍保留账号身份语义。node.ts 只改这一组 401 装配，不恢复旧 preset/Provider 服务。

```text
NodeApiClient HTTP 401 -> 严格凭据/端点初步分类 -> URL + 请求头
                                                  |
                                 OAuthService 既有会话写入队列
                                                  |
                   新登录/刷新已提交 -> 不再匹配 -> 不清理、不广播
                   仍匹配旧请求     -> 取原账号身份 -> 清理凭据
                                                  |
                              当前按身份派生清理 -> 原过期广播
```

状态 owner 是当前 OAuthService；没有引入跨 Host 事务、第二套同步、RPC 方法或发送前
门禁。允许既有跨进程暂态边界，不借本修复扩修共享凭据文件所有并发问题。
React/E2E 技能用于确认失败页沿用当前 hook/state、既有共享登录面板，以及
case-local fixture/pending 身份；没有重新设计布局或扩大正式测试集。

### Spec → 测试 → 实现证据

- 先更新 jwt-401-auto-logout、jwt-invalid-restart-prompt、oauth-login-failure-copy
  和 auth/config 验收清单，再加入来源测试与账号身份补充断言。
- 初始两个服务 suite 因缺新 helper 不能收集；接入分类器后 51 项分类通过，
  条件退出 suite 11 项失败、1 项既有手动退出通过，缺 logoutIfCurrentCredentialRequest。
  实现后四文件 167/167 通过；再加 endpoint/UI 两文件 14/14、现有登录五文件
  25/25、下游 oauthProviderLogout 1/1，合计 **207 个不同测试通过**。
- UI 先运行上游 5 条用例，失败态取消相关 3 条失败、2 条通过；应用修复后 5/5。
  该 5 条已包含上面 14 项结果，不重复累计。
- 根 pnpm typecheck 通过（含 Host/E2E）；根 pnpm lint 39 条既有 warning、0 error。
  专项格式检查发现一处调用参数换行，已仅格式化 OAuthService；不为格式重复跑全套 E2E。
- Pro 隔离副本重新构建 tsup Main/Host/Preload/Scheduler 和带 store bridge 的 Renderer，
  复用未变的 Agent；同一串行运行执行 AUTH-05 + AUTH-06，**2/2 通过**，
  `desktop-e2e-20260909-155636-836`。两 case 共用构建，不逐小项重复构建。
- Pro artifact：
  `/Users/dev/zcode-todo99-e2e.1lO3PN/packages/desktop/.e2e-artifacts/desktop-e2e-20260909-155636-836/summary.md`。
  没有真实平台请求、真实用户凭据或 App 重启；AUTH-06 在 IPC 边界断言 RelaunchApp，
  不是完整退出重启验收。AUTH-05 保留来源正式路径；AUTH-06 保留 pending，不自动晋级。
- 服务微观竞态由可控 promise/真实服务实现证明；Pro 实跑证明 Host 请求、凭据清理、
  广播和原 UI 交互接线，不把普通 401 桌面 case 冒充微观竞态或手机/Windows验收。

### 双向复审

- staging → 结果：登录取消、access token 白名单、队列内复核、刷新不复活、坏候选隔离、
  正常清理失败仍提示均已覆盖；工厂本地具体返回类型供装配使用，不扩 IOAuthService。
  G09 独占生产文件与固定 staging 一致，OAuthService 的剩余差异为当前账号身份保护。
- recovery → 结果：没有恢复旧 family/preset 正式来源；只清当前 OAuth 与按身份派生凭据，
  Bot 独立凭据不清；UI 不自行读写凭据。Web 共用 UI 与既有广播，不新增 Agent，
  desktop continuous/mobile replayable 及 workspaceIdentity 边界均未修改。
- audit 原文包括其它既有候选问题；只保留历史，不据此扩修。历史 AUTH-06 执行记录
  单独注明来源，不计作本轮通过。共享 node.ts、wdio.conf.ts、auth/config 文档的其它组
  来源仍 pending，不能用 G09 完成替代 G03/G07/G10/G02 等验收。
- G09 无新增产品待裁决项；整合全局与关键跨功能验收仍待其余组及真实 merge 完成。

## 20. G05：Bot 已删除任务恢复与飞书投递诊断（已实施、组内复审）

| 来源 | 意图 | 裁决及当前落点 |
| --- | --- | --- |
| 65ad97769b | 桌面已删除的活动任务收到 Bot 消息后创建新任务，清旧交互并通知一次 | 保留 tombstone 判定及通知；重接当前草稿初始化、Selection View 和 V4 创建/派发，不恢复旧 model/thoughtLevel 路径 |
| 3c53fe008f | 飞书 HTTP/业务失败保留 code、log_id、接收身份类型；独立投递错误、成功清除及弹窗状态刷新 | 保留；发送保持 open_id，卡片更新保持 message_id，不增加重试或 chat_id 降级；共用当前运行状态与 UI logger |
| 35ba050592 | 原作者飞书真实长任务与协议验收记录 | 保留全文，显式标为历史证据；不将原租户、CUA、跨端或协议测试算成本轮实测 |

**交集 I103-12：** 上游 Bot 测试配置和创建路径基于旧接口。本轮 fixture 保持 v3，
已绑定且未删除任务仍以 Session 持久选择为唯一事实；仅确定 tombstone 后回到现有草稿流程。
新任务的有效选择由公共 View 得出，固定后经 V4 create/config/send 使用同一完整选择。
没有复制第二份 Bot 模型状态、隐式选择套餐、远端断连回落本地或新同步门禁。

```text
授权后的 Bot 普通消息 -> 目标 workspaceIdentity 的删除记录
                          |
             非 tombstone -> 原 Session 选择/命令链路（Todo99）
             是 tombstone -> 清旧绑定及待回答交互 -> 原草稿初始化
                                                     |
                                公共 Selection View -> 固定本次选择
                                                     |
                                      V4 创建/绑定 -> 通知一次 -> 原消息派发
```

通知失败只记录警告，不释放该入站消息去重并重做任务；归档、列表过滤和查询失败都不是
删除证据。删除记录查询复用实际目标 TaskService，不跨 workspace 身份查询。
投递错误与 WebSocket 连接状态互不冒充，主动中止不覆盖投递诊断。
弹窗只在可见时串行刷新，关闭取消后续轮询及迟到回写；没有新会话/模型状态 owner。

### 测试与组内验收

- 先更新 bots spec、case catalog、coverage matrix，再加入上游测试：三个文件初始
  10 失败/44 通过，分别暴露 tombstone 未处理、HTTP 200 业务错误信息丢失、投递 UI 缺失。
- 实现后四文件 139/139；增加重构交集断言后，deleted/status/permissionsWorkspace/config
  四文件 29/29。扣除重复旧 7 条 deleted 用例，共 **161 个不同单测通过**。
  新断言覆盖公共 preferred Selection 完整传入 V4 和发送、无可用选择不创建/派发，
  以及保持 Session 单一事实；没有以旧静态 Provider fixture 绕过解析。
- 根 pnpm typecheck（含 Host/E2E）通过；根 pnpm lint 39 条既有 warning、0 error。
  仅对三处改动文件作格式整理，不为格式重复构建或 E2E。
- Pro 隔离副本共用一次 Main/Host/Renderer 构建，Agent 未变复用既有构建：
  `desktop-e2e-20260909-160553-706`，5 个 spec、**9/9 通过**，无重跑/跳过。
  DT-01、DF-01、有效选择及 remote-disconnected 是合成 service-harness 证据；
  CF-01 是真实 Electron UI，断言弹窗保持打开时刷新连接错误、保留绑定和解绑入口。
  投递错误面板另有组件渲染断言；不把 harness 说成真实飞书租户或真实 SSH。
- Artifact：`/Users/dev/zcode-todo99-e2e.1lO3PN/packages/desktop/.e2e-artifacts/desktop-e2e-20260909-160553-706/summary.md`。
  新候选保留 pending，未擅自晋级正式回归。没有外发 Bot 消息、改变真实用户账号或资料。

### 双向复审与范围

- staging → 结果：删除恢复、一次通知、重复消息保护、旧交互清理、错误细节、投递状态
  成功清除、群聊拒绝、状态刷新及历史验收记录全部有去向。
- recovery → 结果：保留 v3 Config、结构化选择、V4、Todo99 Session 权威，
  /model 即时提交与普通消息有效解析未回退；没有修改 continuous/replayable 协议边界，
  shared-host 和远程 workspaceIdentity 路由不变。
- 本组无新增待裁决项。共享 botsService 后续 G14、共享 i18n 的其它来源仍 pending；
  组内通过不是全局合并完成。本次未扩修飞书平台限制、既有 WebSocket 重连架构。

## 21. G02-A：帮助配置 client/configs（已实施、批次复审）

| 来源 | 意图与去向 |
| --- | --- |
| 294e520687 | 帮助社群/反馈统一读取当前 endpoint client/configs；Desktop/Web 注入平台读取，共用公开内存缓存与逐字段默认值；保留 |
| b87559143a | 从单一 mock 测试扩展为 case-local HTTP、语言/缓存/失败恢复及窄屏 Web；保留完整矩阵、fixture 和 graph seed |
| 29b0a87dde | 用户授权 HC-01～05 转正；保留根目录正式 spec 和 8 case，不恢复两个已被移动的 pending 文件 |
| d3bdf049dd | 清理无调用旧 CDN URL 常量/构造函数及过时测试；保留内置 default.json、有效字段 helper、旧客户端线上资源 |

本批无需新产品裁决。四个核心实现文件已确认与固定 staging 逐字一致；对应现有
文件相对 merge-base 没有 recovery 改动才采用来源内容。共享 index/main/platform 只
接入本批 import、reader 和参数，不夹带 G03 CUA 灰度删除、G11 share 或 G14 memory。
公开帮助读取不附用户 OAuth，不复用账号灰度响应缓存；不涉及 Provider/Selection
持久化、会话 owner、shared-host、desktop continuous 或 mobile replayable 语义。

```text
Desktop 原生菜单/平台动作 -----+
                             +-> 公开 help reader（URL 隔离、并发合并、1h 成功缓存）
Web 平台动作 -----------------+                     |
                                当前 endpoint/version/platform -> client/configs
                                                    |
                                     code=0 + 逐字段有效值
                                                    |
                         同语言内置默认值 -> 外链/内置反馈弹窗/平台不可用
```

### 证据与失败归因

- 先写入来源 spec/矩阵/fixture 和测试；初始 shared suite 缺 helper，Web 1 失败/4 通过。
  实现后 shared/web/desktopCommands/NodeApiEndpoint 共 5 文件 **44/44 通过**。
- 用 dep-refs 全仓追踪旧 URL 构造函数的 9 处引用，全部属于本批 Desktop/Web/旧单测；
  改后 rg 查两个旧符号无调用残留。公共字段解析保持，不删除其它仍有用途的 helper。
- 根 typecheck（含 E2E）通过。根 lint 初次 40 warning/0 error，新增一项来自删除旧
  Web 请求后多余的 ZCODE_VERSION import，已移除；该文件专项 lint 0 warning/0 error，
  其余 39 条为既有 warning，不扩大清理。
- Pro 共用一轮 tsup/Renderer 构建；首次 `desktop-e2e-20260909-161555-029` **6/8**，
  失败分别是找不到英文 Help、反馈实际显示中文“提交反馈”。运行时 DOM 错误文本与
  Main SetApplicationLocale/Renderer IntlProvider 的分离证明是测试语言准备失配，
  不是帮助入口或配置返回回归。只补隔离 locale/localePreference + 重载，不改产品。
- 修正测试后复用相同产品构建，`desktop-e2e-20260909-161710-536` **8/8 通过**：
  真实菜单外链、语言匹配、1 次 HTTP 并发/缓存、false 内置弹窗、true 外链、失败恢复、
  无配置不可用、390×844 Chromium 运行实际 Web resolver 并重载。没有模型请求。
- Artifact：`/Users/dev/zcode-todo99-e2e.1lO3PN/packages/desktop/.e2e-artifacts/desktop-e2e-20260909-161710-536/summary.md`。
  这是 Mac/Chromium 实测，不冒充手机 shared-host 或 Windows/Linux。Linux overlay 分支
  是 G18 来源的已有断言，保留但待 G18 验收；不因此扩改 Dialog 布局。

### 双向复审与批次边界

- staging → 结果：成功缓存/失败不缓存、no-store/credentials omit、10 秒请求超时、
  endpoint/version/platform 隔离、同语言回退、false 有效覆盖、Web 省略 platform、
  Desktop 原生反馈开关、问号菜单原内置反馈行为均保留，历史来源文档不计为新证据。
- recovery → 结果：仅平台帮助配置更换远端来源，当前连接选择/模型配置/运行权威不变；
  Main 仍仅执行平台动作，无新会话状态、Host 或远控 RPC。清理旧 URL 不删除线上 CDN。
- G02 其余 MR skill、治理门禁、Obsidian/技能上下文来源尚未实施；不能把本批完成写成
  G02 全组完成。共享文件按来源记账，未审查的其它组仍 pending。

## 22. G17：Settings 覆盖远程工作区的身份与订阅（实现完成，SSH 门槛待验）

| 来源 | 裁决和当前去向 |
| --- | --- |
| c8a001ee48 | 保留 covered workspace 的 remoteSessionId 修复；Root 按 workspaceKey 从窗口已有 tabs 找回身份，不新增 Host 或订阅通道 |
| b3111a9f4c | 保留 endpoint 与实际注册代理不一致的一次性 lifecycle warning；只观察，不替调用方改键、不重连、不改变 generation 规则 |
| 6fb1fd00ac | 保留 watchdog 测试退出等待 8 秒；Windows 进程树回收不受原 1 秒断言窗口限制，生产超时不改 |

### 根因、交集与实施

I103-13：当前已恢复 workspaceIdentity，但 Settings 激活时仍缺 remoteSessionId。
完成通知和侧栏因此对同一远程 Agent 建立不同 endpoint key 的 store；CLI 同
connection/topic 的后订阅替换前订阅，关闭设置后侧栏虽然仍显示 subscribed，却不再收帧。

```text
远程 tab (workspaceKey, remoteSessionId)
                  |
         打开 Settings 覆盖 tab
                  |
Root 从窗口 tab 集合找回完整身份
                  |
通知、侧栏 -> 同一 endpoint/workspaceKey store -> 同一有效订阅
```

Root 仅接入目标解析参数和复用 tab 集合，不恢复其它来源的整文件版本。
remoteWorkspaceSessionStore 仅增加当前在册代理的身份查询；保留我们已有的代理换代、
释放处理及 Provider 重构，未带回旧 Provider Registry 同步。注册表保留已有的
current-generation 比较和非阻塞 transport 替换，日志去重不参与业务路由。
已有 desktop-continuous / web-remote-replayable 的独立订阅测试保持通过；不新增恢复流。

### 验证与未决门槛

- spec / pending E2E / fixture 先于实现；上游 T3 历史调查保留并明确不是本轮实跑证据。
  source SSH plan 的历史“fixture 校验通过”不重复搬成新结论，本轮另跑校验。
- 初始 11 条新/更新用例 7 失败、4 通过：身份缺失、重复 store 和缺失诊断入口均复现。
  实现后 Root/订阅/诊断/已有 registry 四文件 **23/23**，远程 runtime/persistence
  两文件 **19/19**，合计 **42/42**；其中 stale proxy、换代和两种 deliveryKind 均覆盖。
- watchdog 定向实跑 **1 通过、42 条因筛选未运行**，不是全文件通过。
- 根 pnpm typecheck 通过；根 pnpm lint 39 条既有 warning、0 error；diff check 通过。
  上次两个终端结果在上下文交接丢失，只重取那两文件及增量 typecheck，未重复整批 E2E。
- SSH-P0-TASK-03 case-local fixture 检查通过；候选保持 pending，未晋级正式回归。
  Pro 未配置 ZCODE_E2E_SSH_* 密码登录环境，当前容器也没有 Docker 命令。
  不复用同事旧凭据或清理真实账号来凑验收。**真实 SSH 运行中开关设置后侧栏收敛仍为
  本次合并关键门槛**，暂不宣告本组验收完成，不转交 Todo102；继续其它独立组。

### 双向复审

staging 的身份修复、诊断、测试窗口三个意图都保留。没有引入自动同步屏障、第二个
Host 或旧 Provider 配置；关闭/断连 tab 不凭路径猜 remote session。现有更强的
代理换代保护未被 source 文件覆盖。共享 Root 和 coverage matrix 的其它来源仍 pending。

## 23. 执行策略调整与当前 G06 批次收口（2026-09-09）

用户再次明确：不以“全部 staging 来源逐项移植并验收完”为真实 merge 前置。
Todo103 已替换该执行顺序；此前提交和证据全部保留，当前 G17/G06 收口后立即推进
固定 staging 正常 merge。低风险独立改动由 merge 批量保留，交集逐功能裁决；
完整候选的双向复审与跨组验收仍是合回 recovery 的门槛，不自动 push。
来源清单新增三维口径：decisionStatus / implementationStatus / verificationStatus；
旧 status/evidence 保留，不把提交数量当完成率，也不把实现等同验证。

### G06 当前已完成片段，不冒充整组完成

- aa2cf0448e：其“不可私自回落到 Start”意图保留，当前 Wiki 已用目标公共 View，
  不恢复旧 family / entitlement 私有投影。源 E2E 的旧 generationModel 断言、
  静态 Provider seed 尚待在完整 merge 候选里按当前契约处理，未声称来源全部完成。
- 8423f78274：数字 protocolErrorCode 诊断已补，原始错误文本不落盘；测试先红后绿。
  旧 registry 镜像不恢复，补强现有 Wiki lane 测试证明完整 Account Config（含 current、
  basedOnZCodeBuiltinRevision）在新 Worker 请求前交付，同 client 不重复交付，
  释放重建后的新 client 重新交付；反向凭据 handler 与终态回收保持不变。
- 69d2ad76aa / 0ec3b13d56：按目标项目路由所有 Wiki RPC、waiting 时跳过读取、
  注册后重读已接入；复用现有公共 workspace resolver，不另造断连代理。
  现有已选项目的公共 ModelSelectionView 不变，只补原来展开其它项目的服务误路由。
- 11230d9a1e：新增注释保持根因/修法精简；旧 registry 同步注释由当前 Account
  Config 事实说明替代，不为来源注释恢复已经撤销的架构。

当前合并前共享单测 **11 文件 83/83**，根 typecheck 通过，根 lint 39 条既有 warning /
0 error；包含 G17 的 42 条及 G06 当前 41 条。Pro 复用一次 Main/Host/Renderer 构建，
既有 Wiki 三个 UI case **3/3 通过**，无重跑：设置与无独立输出预算、生成真实落盘、
历史 Wiki 阅读与删除。运行 `desktop-e2e-20260909-163844-844`，证据位于 Pro 隔离副本
`packages/desktop/.e2e-artifacts/desktop-e2e-20260909-163844-844/summary.md`。
该生成测试使用 Host modelGenerator fixture，不冒充真实模型或远程路径。
没有将这些局部证据标记为完整 staging 验收，
跨远端项目路由与 G17 真实 SSH 仍须在候选阶段完成关键验证。

## 24. 真实 merge 候选已启动（未验收）

当前批次已安全提交为 `c4f8619d96`，随后在独立整合分支执行正常
`git merge --no-commit --no-ff 790884b1ce4b990583ab40625b5f283e2169eb36`。
`MERGE_HEAD` 已固定为该 staging；没有推倒已有提交、逐条重制剩余来源或使用 ours 策略。
初始 153 个冲突路径，另有大量普通自动合并；完整差异已进入工作区，不是 merge-tree 预览。

### 已解决冲突的裁决，不等于完整候选验证

| 交集 | 已裁决 / 实现 | 验证状态 |
| --- | --- | --- |
| 根版本与 lock | 3.12.0 保留，其余正常合并 | 候选构建待验 |
| G17 Root、remote store | 同义注释和签名排版冲突消除，保留已有 workspace 身份及代际保护；Root 自动合入的 G11 内容另审 | 第 22/23 节是 checkpoint 证据，非全候选证据 |
| G06 Wiki routing / 相关测试 | 保留公共 workspace resolver、真实断连代理、测试清理；不恢复旧 family 投影、独立输出预算或测试专用服务注入 | 这三个测试文件解决冲突后与 checkpoint 完全一致；Pane / E2E / 自动交集仍待审 |
| G09 OAuth 三文件 | 保留清凭据前取得 accountIdentity、串行失效通知及两个平台测试，不退回只传 provider 的清理 | 与 checkpoint 字节一致；复用第 19 节局部证据，全候选联验待做 |
| G01 安装器及测试/文档 | 真实 UAC 内层判据保留，不退回恒假；保留模板幂等/恢复和 Linux updater 测试；manifest 文档不重新承诺未实现的原子事务；吸收 Arch 包注释 | 第 17/18 节是既有证据，Windows 实际执行仍待验 |

普通自动合并成功不代表已审查：双方交集、新文件对旧接口的依赖、协议/配置/构建仍在同一账本逐功能处理。
来源清单保留来源追踪，候选清单单列实际冲突路径；不以解了多少文件或做了多少提交计作功能完成率。
此时大量文件仍有冲突，不运行注定无法提供新证据的全量类型/回归；待候选可运行后共享执行。

新合入的 architecture governance 门禁已读并试跑 `pnpm architecture:check --changed`：0 violations；
但 `architecture:context ui` 返回模块未登记（managed=false），因此不能把门禁通过当成 UI 架构已自动证明。
未修改门禁 baseline。Goal 继续引用 Todo103 的完整最新约束；产品侧显示 paused，未伪报目标完成。
候选尚未提交 merge、合回 recovery 或推送。

### 候选逐功能冲突处理续记

- G06 Pane：17 个冲突块逐项核对。保留目标 Host 的公共 Selection View、冻结的生成选择、
  输出 Limit；不恢复旧 family 投影、菜单首项兜底或临时会话水合。已有路由、readiness、
  refill 目标选择均保留；自动合并引入的 `activeRepoWikiService` 变量名改回当前已声明的
  `repoWikiService`，避免只清标记却留下不可用订阅。请求途中断连的 loaded 判据按来源
  提取为局部变量，语义不变。两份 Wiki spec 保留现行边界；E2E 套餐来源仍待迁接。
- G02/G09 帮助和认证记录：保留当前隔离 Renderer locale 的测试前置及历史证据标识；
  补回来源 JWT-401 场景正文，避免与既有 AUTH-05 登录取消编号冲突，正文标为
  AUTH-JWT-401 并注明原编号。没有把来源旧运行 ID 当成本轮验收。
- G10 E2E 凭据交集：保留 Personal-only / accountless fork 无账号 seed；仅为来源
  `provider-family-responsive.test.ts` 加入本地 balance mock 所需 JWT 例外，不扩大普通
  E2E 的假登录范围。先合并该断言再接 seed；定向 `e2eStartupCredentials.test.ts`
  **13/13 通过**。来源 responsive case 的旧 selectedKey 及 wdio mock 仍须整体迁接，
  此通过仅证明 seed 边界，不证明响应式 UI 已通过。
- G13 错误遥测：保留有界安全 `error_detail_message`，不恢复原始 `error_detail_text`
  上传；保留 RPC 包装归一化测试、active-loop 实际消费后的 composition 归属。
  四个 UI 实现/测试文件解冲突后与 checkpoint 一致；官方版本安全校验的取消/重试链仍归 G08 单独审。
- G05 Bot：保留 v3 状态 fixture、公共 View 初始化和完整 V4 首发验证，不退回 v2 或
  Bot 私有选择；UI deliveryError 为同义排版冲突。G14 新增 Bot 内存计数注册与 shutdown
  注销正常保留，回调仅读取现有四张表 size，不修改 Bot/Session 状态或新增计时器；
  其共享诊断实现及全链验收仍由 G14 处理，不宣称本组全验收。
- 只为历史凭据审计、WSL 调查保留当前事实声明，未据历史文档扩修 CLI/MCP 或旧问题。

本阶段余 **107** 个冲突路径，候选仍不可运行。计数仅是工作区状态，功能进度仍以
裁决 / 实现 / 验证三维记录为准；实时路径清单见 `todo103-real-merge-candidate.json`。

## 25. 真实候选：CUA / 共享协议 / Subagent 交集收口（2026-09-09 17:13 UTC）

本节覆盖候选清单新增的 20 个已解冲突路径；另含自动合并的重复定义/测试修正。剩余 87 个冲突路径，**不代表完整候选已可运行或验收通过**。

### 已裁决、已实现

- G03：保留 source Helper 与 Agent 生命周期隔离、按需恢复、复用已发布 pipe/token、取消空闲 watchdog 与 Agent recycle 装配。`node.ts` 仅逐块处理 CUA、OAuth 等价 holder、Provider DI 与新 share/Off-Peak 接线，不整文件覆盖；新 share/Off-Peak 全链仍待对应组审查。
- Windows Host 合并时保留 ready 后的 `this.handle` 赋值。新 tuple 缓存与旧 stop epoch 的组合有确定回归：显式 stop 后迟到 ready 会重新写入旧 tuple，下一代等待新 pipe 时超时。先补测试复现，再在 onMessage 发布前检查 stopped/epoch/current generation，复用原防护、不新增 timer/Agent 状态。CUA spec 已补时序与所有权。
- G03 producer：正常合并保留 catalog/lock/upstream 一致的 `908b247399423195d0bcb0039e1755a333c4c1ff`，`check-cua-baseline.mjs` 通过；**现有 node_modules 仍含 recycleUntilStable，不能据 wrapper 版本号相同就宣布依赖已对齐**。其旧兼容方法测试暂不裁撤，安装精确 pin 后核对；不手改 producer SHA。
- G04：共享包自动合并重复声明 `createPluginAgentStateId`，还通过 interface merging 加回旧 `model/thoughtLevel`。移除重复函数及旧参数定义，保留一个稳定 ID 与结构化覆盖接口。
- G04 Service 18 块逐项核对：结构化 state/正式 reader/完整组合保存、共享 Node 迁移和官方缓存扫描、安装记录与卸载抑制优先、settingsUserOnly 的插件投影均保持已验收实现。路径/排版等价处不重复 helper；保留 source 同一个稳定 ID 局部变量。清理自动合并重复 `state` 参数和空旧 map。
- G04 Agent 5 块逐项核对：沿用已完成迁移的启动快照，先替换完整 Selection 再展开规范名/裸名别名，不在 plugin loader 二次读盘或查询账号。`create-app.ts` 继续传 `modelSelectionOverrides`；恢复旧 `storageRoot` loader、旧双 map reader 会破坏当前裁决，因此不恢复。
- G04 两个 source 新增测试仍检查旧存储/API。保留默认/覆盖/别名一致/清除/model-only 不串档位的断言，改用结构化接口；Agent 测试旧文件先经过现有迁移再加载，不把旧字段当正式 reader。既有正式目录 Pro 证据不因重接被重新记成新晋级。
- G04 modify/delete 两路径保持删除：`modelProviderServiceStorage.ts` 与 `modelProviderEnablement.test.ts`。固定 source 唯一新增意图是同 endpoint 下 Start/Individual 成员隔离；当前 `packages/provider/test/resolver.test.ts` 已覆盖真实 AccountResolver → ProviderResolver 及 API 隔离，见第12节。两个相关导出 unscoped dep:refs 均 0 references/0 re-exports，另做文本引用检查；不恢复整套旧服务。
- G08 共享成功响应采用严格 union：`headersApplied=true` 必须含当前 `requestAuth` 对象（apiKey/headers），不恢复 source 裸 `runtimeProviderHeaders`/providerRevision。取消通知独立保留 request/session/workspace 标识，不混入鉴权响应。spec 顶部已写整合约束；取消/3007 重试全链尚未验收。
- G07/G11 共享新增 Off-Peak tool policy 和 `sharedContextRefs`/`importedHistory` 保留；同块旧 workspace provider upsert/remove/default-model 等 mutation 不恢复。Service/Shared barrels 合并有效新导出，不丢当前 Provider Facade/Auth/Provisioning。完整业务消费和隐私/工作区身份验证仍待。
- G10 claim response 使用 source 独立的 claim entitlement 类型（id/name/effectiveAt），不把 preview 才有的 grant/meter 等字段强制加到领取响应。保留当前 server_time 毫秒、effective_at 秒和 0 语义；对应服务测试已通过。

### 验证与失败归因

- 合批 `windowsCuaDevHelperHost` + `zcodeProtocol` + `nodeCuaInstallerExports` + `codingPlanSubscriptionService`：**4 文件 / 168 条通过**（17:06）。新增 late-ready case 修改前 1 fail / 34 pass，失败为下一代启动超时；修复后通过。
- `subagentsService` + `subagentSelectionAuthority` + `subagentStateMigration`：**3 文件 / 49 条通过**（17:10）。首次 source 旧测试失败已明确归因为过时接口断言，按现行合同迁接，不扩修产品。
- CLI 另用 `vitest --root apps/zcode-cli packages/bootstrap/tests/subagents.test.ts`：**1 文件 / 10 条通过**（17:11）。根 Vitest 不包含 CLI tests；不把根命令多传一个 CLI 路径当作已跑。
- 前置失败分别是共享 index 冲突与共享包重复 export 导致解析失败，不算 CUA 运行失败。前一进程输出因句柄结束无法重取的结果未当通过，以上均为新输出证据。
- architecture check：0 violation；services/shared/zcode-cli 仍是 unmanaged，不能把这个结果当人工边界复审的替代。新鲜度检查通过；Node 当前 24.19.0，最终 pinned 24.14.0 环境验证仍需列入候选验收。

本批未提交 merge（仍有 unresolved index），未修改 recovery，未推送。后续优先清理剩余显式/自动交集，再共享 typecheck/lint/构建及跨组回归，不逐来源重复移植验收。

## 26. 真实候选：安全校验重试与绑定请求鉴权（2026-09-09）

本批又解决 10 个 CLI 冲突路径，余 77 个；候选清单保留精确路径。主要是 G08，含少量同批协议类型和遥测等价冲突。**底层通过不代表 Host/UI 验证完成。**

- 已裁决/实现：保留 source 官方版本安全校验的一次额外重试、取消、网络重试预算和流输出边界，身份判断重接为已绑定 Model.accountAccess.mode=start-plan，不猜旧 builtin ID，不重新读取当前连接。Invocation/Runtime 使用完整 requestAuth，不恢复裸 runtimeProviderHeaders。
- resolveModelForAttempt 合并 source 可取消等待与当前每请求私有鉴权：传已绑定 providerId/modelId、attempt/reason，收到 requestAuth 后重新构造同一绑定请求，不改 Registry 或持久选择。保留 ModelRequestAuthMissing 类型错误，不能被新增通用包装吞掉。
- 先跑 source 并发/HTTP 断言发现确定回归：旧小写与新大写安全校验 header 被 Headers 合成 stale, A。applyModelRequestAuth 在私有副本中按不区分大小写替换同名项，既不改静态配置，也不污染另一并发请求；已加原因注释。
- source 测试旧 ModelRegistry/ref/adapter.generateText 接口迁至现行绑定执行 fixture；OpenCode Go 新增断言同样保留。取消测试原先在尝试前 abort 却期待一次请求，与 source 新增 early-abort 冲突，改为第一次 SDK 调用内 abort，继续验证取消不重试，而非放松断言。
- 遥测保留现有有界 cause/adapterError/error 优先链，不恢复无界遍历。core background fixture 保持当前 createTestAgentRuntime；本批未宣称其完整运行链已测。
- 重要待查：Adapter 收到的是可信完整 requestAuth，不能复用 source 中只保留安全校验 Header 的过滤器（会破坏其他账号鉴权）。UI 侧校验结果禁止注入 Authorization；此边界已写入官方版本安全校验 spec，**仍须在 Host/UI 合成入口验证恶意 header 被隔离**，不将端口迁移后的 Adapter 测试当该边界证据。

验证：17:21 五个 Adapter 测试文件（官方版本安全校验重试与 HTTP 用例、runner / runner-retry / model）**193 条通过**，包含实际本地 HTTP Server + AI SDK 的两条往返、26 条重试用例及非 Start 绑定不能触发额外重试。早先失败区分为上述合并回归、旧接口 fixture、取消时序测试；修复后共享重跑通过。尚未完成桌面弹窗/Host 取消/整体跨组验收。

依赖：frozen-lockfile + ignore-scripts 安装成功（6m17s，pnpm10.33.2）；安装时等待 git 下载，未改 pin 或锁文件。CUA 精确制品应用及最终构建另验，不能将安装成功等同原生运行通过。

## 27. 真实候选：设置投影与协议工厂去重复（2026-09-09 17:37 UTC）

本批解决 11 个冲突路径，剩余 66 个；自动合并文件同步审查，但未形成 merge commit。所有路径见 candidate 清单。

### 已裁决 / 已实现

- G04 SubagentsSection：沿现行 Local Host Selection View，非 ready 不损坏意图，保存结构化完整覆盖、主动选模最高档；保留 source 共用控件 helper/注释。移除自动合并的重复 persistedModel/modelAvailable 与旧 modelProvidersLoading。source 新加插件测试与 checkpoint 已移植测试完全同义，不重复留两份；保留现行 waitFor/结构化断言。source 重进页面刷新意图由 `useModelSelectionView.test.ts` 首项的 Start→Individual 重挂载→Team 事件覆盖，不恢复私有 Provider 强刷或 Family 状态。
- 模型组大块冲突按当前只读投影保留：不恢复 source 已删除的 Family 连接选择算法。当前 Resolver 明确排除非 current/不可用账号，现有测试覆盖；UI 不另推断 fallback。视觉标记遵守 Todo88 R12 的 support_image 事实，不将 audio/video/pdf 一律升级为 Vision；source 精确前缀/多段模型 ID 行为增加现行 View 测试保留。
- UI Store 类型保留 source timelineBottomRequest/requestId；不恢复已无读写消费者的 draftPreferredModel/ThoughtLevel/Mode 三个旧字符串种子。真正的草稿 ModelSelection 与模式仍沿 checkpoint 实现；整体 SessionPane 和滚动交互待后续组验。
- G03：精确安装后的 cuaWorkspaceRegistry.js/d.ts 已不含 recycleUntilStable，仅保留 setEnabled/snapshot/pruneDisabled。删除两条旧 recycle 兼容测试，来源生命周期隔离不倒退。该文件执行被 zcodeAgentService 未解标记阻塞，**无运行通过声明**。
- G11 输入持久化/队列 metadata 合并保留 modelSelection + mode + sharedContextRefs，三者不能互相覆盖。现有 canonical goal case 增加组合保存断言；完整分享派发仍未验。
- G12 fork 仅 import 交集合并，其余 source fork/model-only metadata 正常保留，不改变当前选择复制。G14 server-types 保留异步 createZCodeApp 与新 event store 注入点；retention spec 已阅读，完整 server/回放验收尚待。
- G08 来源新独立 provider-runtime-headers 模块未接 current workspace-model-runtime，旧内联端口仍用 Date.now。先补真实工厂回归测试，在固定时钟下复现重复 requestId；重接 source UUID/取消/时限模块，保留 ModelSelection/accountAccess/requestAuth 和所有 Account 入口。删除旧内联副本，普通 API 仍由绑定层免于账号 RPC。
- G08 modify/delete 的 workspace-model-catalog 保持删除：fixed source 唯一变化为提取上述 Port，已接入现行工厂，不恢复旧 overlay/default Model mutation。全仓代码 import 文本无引用，只有历史文档路径；dep:refs 因该 CLI 文件不在其 project 中失败，**不宣称工具返回零引用**。GIt 可恢复删除文件。下一步完整类型检查继续核查调用面。

### 验证 / 未完成边界

- UI Subagents + 公共 View + Model Groups：3 文件 **50 条通过**（17:31）；首次被共享 Store 冲突标记阻挡，解完该交集才重跑。新精确 ID case + Provider Resolver：2 文件 **17 条通过**（17:35）。这些不是重新执行 Pro 桌面验收。
- Core fork + input intent：2 文件 **27 条通过**（17:35）；随后增强组合 metadata 断言单文件 **2 条通过**（17:36）。
- 安全校验 Port：真实工厂唯一 ID、专用取消、成功/普通错误 **3 条通过 / 1 跳过**（17:35）。跳过的是依赖完整 server 的真实 pending/180s timeout/迟到响应 case，待 server 解冲突后运行，不能记成全通过。第26节的 Host/UI 禁止任意 Authorization 注入仍待处理。
- 固定 lock 安装没有产生额外 package/lock 工作区修改。新鲜度检查通过；格式化限定本批文件。未运行全候选 typecheck/lint/build，因为仍有显式冲突；最终共享验收不变。

下一高风险入口：zcodeAgentService 同块交织 G07 Off-Peak policy、G08 请求鉴权、G14 内存诊断；已经定位但未盲选。需保留 current Account 同步/请求期鉴权，重接 source policy/取消/诊断 dispose，排除旧 ProviderRegistry 分支。其第11块仍直接展开 UI response.runtimeProviderHeaders，必须检查白名单组装边界，见26节。

### G07 下一批已定位的接口漏接（历史定位；Host/存储已由第28节重接，UI/派发仍待联验）

正常合并进来的 Agent Tool Bridge 仍取 `OffPeakClientConfig.allowedModels/allowedModelConfigs`，并以 `{model,thoughtLevel}` 调 createTask；当前 config 只有 `modelSelectionView`，createTask 必须接收完整 ModelSelection。因此直接保留会让曝光门恒 false/创建失败，并绕回按型号猜最高档。需按当前 Off-Peak View 和已登录账号支持事实选定隐藏 Provider，复用有序 optionSpecs（最高档为现行顺序末位），保留 D49 的工具默认末位模型、显式模型规范化、D50 绑定和错误分类；不恢复旧名单/静态档位强度表，也不实施多账号方案。表单路径及票据绑定仍不动，不能为工具接线修改已绑定 Ticket 的选择。已阅读技术设计4.7与当前 config/service/node装配，尚未修改此 Host 大文件。旧技术设计内的 ClientConfig/默认档口径需随本批 spec 更新，不能反向推翻当前 Registry 合同。

## 28. 真实候选：Host 闲时工具、安全校验与绑定落库（2026-09-09）

本批解决 7 个冲突路径，66 → 59；已有 checkpoint/固定 MERGE_HEAD 不变，未提交 merge、未合回或推送。这里的实现/验证结论不覆盖尚未合完的 UI、CLI server 与桌面派发。

### 来源、裁决与实现

- G07 `45a0078032`：保留 D49 OffPeakCreate/List、门禁、工具默认、错误脱敏、D50 会话绑定。Host 从当前 OffPeakClientConfig.modelSelectionView 读取成员，经已有 getCodingPlanSupport 确认 Family，再选精确隐藏 Provider；复用 completeNewModelSelection 取得 values 末位最高档。不能从其他域候选补模型，不能恢复旧 allowedModels/allowedModelConfigs/静态档位强度表。createTask 提交结构化 modelSelection，同时保留 boundSessionId/workspace；旧测试按新合同重写，普通失败与脱敏规则保留。
- G07 Host create/resume compat + V4 flag + TaskAdapter denylist 保留来源新策略；只在 idle turn 禁 OffPeakCreate，Cron 的 mutation 常量不混入它。不是再设计账号同步或给普通发送加配置等待。
- G07 Repo INSERT 同时保留 model_selection 与 source session_id。Service 在现行选择校验后保留绑定预检及数据库唯一索引错误分类；取号链路和已绑定 Ticket 不改。Repo 同时保留旧选择隔离测试与 source 绑定/标题/唯一索引测试，增加绑定与完整选择同时落库断言。源版本对存量重复行无法建索引时仅保留预检的降级照常保留，本轮不清理真实数据或扩修它。
- G08 `218102a0f8`/`74fa583639`：保留请求私有校验材料与取消，接当前 accountRequestAuthService。先用 Host 实际回调测试复现四个失败：UI 任意 header 混入鉴权、UI 失败仍解析账号、交互/非交互账号 IO 期间取消后仍发迟到应答。修复只在组装与 pending 身份边界：只接官方版本安全校验所需的请求头，保留 Host apiKey/Authorization；IO 期间可取消，结束核对原 pending 身份；同一 pending 只允许一个应答者；空鉴权不报假成功。不修改 Registry/持久选择，也不新增超时系统。
- G06 `8423f78274`/`11230d9a1e`：此前已按 Account 快照镜像重接，Host 冲突不恢复整段旧 ProviderRegistry 同步/隐式 fallback/runtimeModel。G14 `a008e4e12c` 内存计数注册和 dispose 一并保留，未改变流传输边界。
- 自动合并另发现 skillsService、commandsService 重复导入 DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS：source 引入 services 私有四项名单，而 checkpoint 已有 shared 单一五项名单（含已裁决默认启用的 CUA）。移除重复导入，继续使用现行 shared 权威；不改变 discovery 行为。新 source officialPluginCache 重复模块是否仍需保留归最终引用/双向审计，不以解除语法错误代替整组完成。
- 更新 Off-Peak tech-design/glossary：保留 source 会话内工具/绑定/轮尾卡语义，排除 turnRuntimeModel/远端模型名单旧描述；新增 Host 当前接口重接条款。官方版本安全校验 spec 增加 IO 期间取消与鉴权组装边界。

### 验证与归因

- 17:54 Host 工具桥/配置门禁/内部错误/安全校验鉴权/取消 workspace 隔离 **5 文件26条通过**；安全校验新增用例先4条实际失败，再修复转绿，追加重复 UI 应答断言通过。工具用例证明 Z.ai/BigModel 各自选 Provider、完整选择与绑定一起提交、异域模型拒绝、未选账号不取号；并非只有 helper 测试。
- 17:57 Repo + Service + Legacy Task Adapter **3文件130条通过**，包含真实隔离 SQLite、绑定唯一约束/预检、Session 选择不被闲时覆盖及 idle turn denylist。未触碰真实数据。
- 17:55 skillsService + commandsService **2文件46条通过**，证明移除自动合并重复导入后的发现行为；不代表所有插件/UI E2E。
- 本批 Host/Adapter/新 fixture/测试定向 oxlint 0 warnings/0 errors；格式化限定本批。完整 typecheck/lint/build 在余下冲突解决后统一执行，不以定向 lint 替代。
- CUA Product Agent Env 首次被 Host/TaskAdapter 冲突阻塞，后续被上述重复导入阻塞；均为候选未完成/自动合并语法问题，不是 CUA 功能失败。未继续逐个追 import 阻塞重跑；待完整服务导入闭包解完共享回归。§27 的 CUA 单文件仍**没有通过证据**。

仍待：CLI server/turn flags 与 Host 桌面绑定派发联验；G08 UI/controller/真实 Port timeout；完整跨组回归与最终双向审计。spec、测试与来源清单持续保留，不把本批通过折算成合并已完成。

## 29. 真实候选：CLI 派发与分享导入的交集合并（2026-09-09 18:14 UTC）

本批解决 6 个索引冲突（5 个 CLI、1 个 desktop remote 装配），59 → 53。固定 MERGE_HEAD、checkpoint 不变；完整候选还未验收，不提交半成品 merge、不合回、不推送。

### 已裁决 / 已实现

- G07 `45a0078032`：server 保留 workspaceUpdateOffPeakToolPolicy；createRecord 的异步现行工厂装配 OffPeakPort，保留显式开关或 Host runtime preference 的曝光门。prompt-turn 保留 source idle 标记、防递归 denylist、结束/排队/拒绝/异常恢复标记；同时保留当前完整 modelExecution、sharedContextRefs。session-flow 不恢复旧 turnRuntimeModel/apply/clear 和模型回滚，不重复计算由 startPromptTurn 已统一处理的工具列表；foreground promotion lease 仍在 finally 释放。
- G08 Port 工厂与取消保留；zcode-protocol 测试把 source 请求私有校验材料的断言迁入完整 requestAuth，保留同一时钟下并发 requestId 唯一、原因透传，不恢复旧 workspace Provider 变更方法/运行期 overlay 测试。
- G11 `84be5103f9`：分享上下文原子导入正常保留，但自动合并的新分支引用了已不存在的 providerID/modelID，实际导入抛 ReferenceError。先补有/无模型两条真实 createSessionRecordForV4 调用测试，再改为与普通导入一致的可选结构化 modelSelection；无选择不伪造来源、不要求 Registry 可执行。正文、model-only、provenance 和 resume 保留。规范补充在 conversation-share-v1。
- G14 `3d87e89955` / `228c641268`：保留 event store 工厂注入、创建/生成/关闭/失败清理与 prune，createWorkspaceZCodeApp 仍可等待；不恢复旧 DeferredModelAdapter。`5eb47d9039` 的 child publisher 登记 parent 归属保留，更新原测试两参数断言为三参数（source 自身新增生命周期参数后的陈旧断言，不改产品行为）。
- remoteWorkspaceServiceCollection 同时保留 source 真实分享 HTTP Client/远端 artifact source 和现行 AccountCredentialStore logout、Provider provisioning、runtime-preferences 桥；不重新引入 localModelProviderService。

### 验证与失败归因

- 18:07 CLI 4 文件最初 23 通过、3 失败：retention 失败是 `@zcode/contracts` 指向旧 dist，不是源实现错误。执行 `pnpm --filter @zcode/contracts build` 成功后，retention 三条通过。其他 CLI 跨包仍可能读取旧 dist；本轮局部通过不代替最终重建完整闭包。
- 18:09 分享导入新增两条先稳定复现 ReferenceError；修后通过。18:13 本批 OffPeak turn/Port、分享导入、retention、安全校验（包括180s timeout与迟到响应）、V4 附件组合 **6 文件57条通过**。安全校验不再有§27的跳过。
- 18:11 含 zcode-protocol 的共享运行 **130通过/7失败**。其中 child parent 参数断言已更新，并在18:12定向通过；5条 MCP 失败同因 adapters/dist 仍调用已删除 isCuaGrayEnabled，留到完整构建后复验；1条远程 Cron 默认 denylist 是 Todo102 既有失败，base/source 同有该行为、checkpoint 早已缺失，不在本轮额外修复。不能把这7条都写成已通过。
- 18:12 新增工厂门禁3例、分享2例、并发鉴权/child路由2例 **7通过**，其余115为显式过滤不执行，不计覆盖。18:12 desktop remote 装配 + OffPeak dispatch plan/settlement **3文件15通过**，未运行完整 Host 派发/E2E。
- root oxlint 默认排除 CLI，本次根命令实际仅检查 remote 文件（1文件0错）。随后 CLI cwd 定向检查暴露 server 既有 max-lines 和 server-operations 的5个既有 unused 项（HEAD 对照存在）；新增 session-flow 重复计算与空 catch 已清除。最终 repo typecheck/lint 和 CLI 构建仍待，未假报全绿。

下一批已定位：desktop host 新增 bound-first-run 仍读取已删除 request.thoughtLevel，并以 setConfigOption 写档位；必须按已有 idle 单次执行不覆盖 Session Selection 的裁决重接，和 resume 分支一并查清。此处尚未实施；不能因 CLI 工具测试通过就认为 D50 桌面链完成。

## 30. 文档交集按已裁决合同收口（2026-09-09）

4个文档冲突批量处理，53 → 49。文档排版/同义文字不逐项重跑产品测试，来源行为和当前架构冲突单独核对。

- CONTEXT：保留 source 自动刷新用户无感、手动刷新全市场且不受自动节流的定义，与当前相同；不引入另一种刷新机制。
- conversation-protocol-declaration：把两侧表格按不变量 key/value 比对，非排版差异仅为附件说明、安全校验重试预算、queue/guide 模型规则。保留当前附件-only、queuedSubmissionPreservesSelection、acceptedGuideSwitchesAtModelStepBoundary；不恢复 source queuedPromptUsesLatestSessionConfig。安全校验切至已裁决 ModelInvocation 一次重试。处理后与 HEAD 按 key/value 比较只有该安全校验项替换，其余当前不变量全保留。
- WSL/Start Plan bridge 文档保留 source workspace headless controller、请求私有安全校验、晚订阅补投、取消与模型内重试，但接入当前 ModelSelection/accountAccess/requestAuth，不恢复 builtin ID 猜测或旧 Runtime Model/Registry fallback。pending claim/IO/取消文案与§28实现一致。修正“整个 bridge 已废弃”的过时头注，明确只废弃旧配置改写方案。
- staging 2026-09-08 的测试数字保留为来源证据，不冒充整合候选全绿。当前UI/controller仍有冲突、桌面完整验收仍待。

Off-Peak 后续验收定位：已阅读 E2E lifecycle/workflow 及现有 pending 用例。`conversation-session-offpeak-create-existing-session` 仍断言旧 model/thought_level SQL列，且只到 queued，没有覆盖绑定派发；`offpeak-subagent-model-inheritance` 覆盖表单新建派发及下一普通轮，不能替代 bound-first-run。后续需按当前完整 Selection 更新前者，并为绑定会话执行前后选择不变补有区分力的断言；未在此文档批次声称已实现/验证。

## 31. 真实候选：安全校验 UI 与 Session 分享交集（2026-09-09 18:32 UTC）

本批11个索引冲突收口，49 → 38；只更新真实 merge 候选，不提交半成品、不合回或推送。Goal引用的最新策略不变：独立行为正常合并，交集按风险检查，共享最终验收仍待。

### 已裁决 / 已实现

- G08 `218102a0f8`/`74fa583639`：保留 source 请求内一次重试、校验/配置等待取消与 workspace headless controller。接当前 ProviderSettings View 的结构化 access；请求已有 accountAccess 时以该绑定事实为准，不用更新后的设置状态改写在途请求语义。UI仍只返回安全校验所需的请求头，Host通过当前requestAuth组装鉴权。scope保留workspaceIdentity/session/request隔离；先订阅取消再补投请求。
- source删除的旧安全校验自动恢复 hook及测试按已裁决请求内重试一并移除；旧 refresh/discard/next-edit 校验材料暂存 helper和对应6个旧契约测试移除。新 source 中无人使用的全局 setProviderRuntimeHeaders helper不恢复。删除前 dep:refs与文本调用检查，删除后四个旧入口在UI零引用；Git可恢复，不涉及用户配置。
- G11分享上下文三条发送入口保留 context_refs，同时保留当前完整Submission：已有Session、预热首发、无预热先创建再发送。合并服务入口用conversationShareService + modelSelectionService，不恢复modelProviderService或发送前Registry同步。当前prewarm admission/失败不重发/模型草稿边界全部保留。
- SessionPane stop两侧行为等价，保留现行button/Esc/goal verifier/idle日志测试，接source稳定button回调。冲突工具把source stop断言错拼进current pending-ACK预热测试，已按两项功能分开核对：恢复预热测试，stop由已有更完整的3例覆盖，不重复制作测试。
- Toast同时保留当前dedupeKey和source按id进度更新（含挂载前）；两处冲突逐块组合，保留当前safe-area/top-right布局。i18n两语言新增最近活动文案正常保留，套餐手动切换文案保留；Bot错误详情仅排版同义冲突。

### 已验证 / 仍待

- 18:24 bound accountAccess两条新UI测试先失败（意外读取较新的Settings View），修后18:27官方版本安全校验相关 UI 测试 **5文件31条通过**。命令曾列出一个不存在的遥测测试名，实际执行的是5文件，未将其计入证据。
- 18:30 SessionPane **55条通过**，含新增分享与完整Submission同行的3入口断言。首次被未解locale冲突阻塞；locale两项简单交集一起解决后运行，不把解析错误归成产品Bug。
- 18:31 Toast/i18n **5文件15条通过**，包括真实DOM挂载前进度合并+去重共同生效；本批定向lint0警告0错误（工具实际检查11文件），限定格式化完成。完整repo检查、当前candidate桌面E2E尚未执行。
- 已阅读 source 中官方版本安全校验重试的 pending E2E：四项场景可复用；仍待mock基础设施冲突解完和完整构建后在Pro运行，不把UI单测当成桌面端到端通过。

后续：G07 desktop绑定派发/OffPeak入口；G10套餐UI与E2E fixture交集；完整候选双向审计和共享构建/回归。此前CLI adapters/dist与既有Cron测试分类继续有效。

## 32. 真实候选：闲时绑定派发与入口合并（2026-09-09 18:44 UTC）

本批5个索引冲突收口，38 → 33：Host/index、Main/index、Web/main、Automations、OffPeakNewTaskEntry。完整候选仍待验收；没有合回或推送。

### 裁决与实现

- G07 D50绑定首跑：保留source删除/忙碌预检、resume盖章归属、原prompt、mode设置和重试分类，接当前modelSelection/modelExecution。删除新分支读取已废弃request.thoughtLevel；既有resume分支也不再单独写thought_level。两者都只在sendPrompt传冻结完整Selection与execution-scoped Ticket Auth。D49同时禁CronCreate/OffPeakCreate，只读List保留。
- D33来源与当前重构均要求闲时轮不污染Session选择。实际Host测试确认checkpoint仍在init createTask写隐藏idle Provider、resume另写idle档位，阻碍本次保留的“闲时结束后普通聊天”行为。此为本次交集必要修复，不扩成其他Session历史修复：init继续普通Session初始化，实际闲时sendPrompt仍用已取票时冻结的Selection，不重新读取当前连接来替换它。Ticket、迁移和账号同步机制均不变。
- Host单测异步读取并编译实际dispatchOffPeakRun函数，只替换外部服务，隔离Host进程启动；不是拷贝一套实现，也不是源码字符串断言。补绑定首跑/续跑完整载荷、忙/删除写前拒绝、不可用选择拒绝、发送失败清理、新会话普通初始化7条。
- OffPeak/Automations保留source购买库存loading/error/retry入口，套餐事实仍用当前ProviderSettingsView，升级目标为具体Individual Provider；不恢复useModelProviders、旧family selected key或旧Registry遥测。首页任一Coding Plan导航与表单selected support的既有区别保留。
- 两条OffPeakCreate pending E2E改读model_selection并按共享schema校验，不再用旧model/thought_level断言新版写入；冷恢复用例补session_id绑定与未派发conversation_id为空。正式派发后的Session不变E2E仍待补/跑，不能以这两条创建测试替代。
- Main AUMID仅同义注释冲突；自动合并重复声明readHelpConfig已去重，保留公开帮助配置与鉴权灰度fetcher分离。Web main保留source分享路由、OAuth安全return-to/语言/主题入口和当前community/help读取，未动手机shared-host链路。

### 验证

- 18:37 Host新测试先稳定复现resume额外写档位、init保存idle选择两处失败（2失败5通过）；修改后18:40 Host dispatch/plan/settlement + UI OffPeak/EntryGate/Automations **6文件48条通过**，包含新增loading/error两例。
- 18:42 Web分享路由/preview/OAuth + Windows product identity **4文件29条通过**。只证明这些模块，不能代替main/Web完整包或手机联验。
- 本批8文件定向lint0警告0错误，Main/Web另2文件同样通过；限定格式化。E2E文件已按新合同更新但尚未实跑，完整构建/typecheck/lint和跨组回归继续待办。

余下高风险：G10购买面板与Provider响应式状态、E2E mock/launch配置；Host providerRegistry旧测试需按source意图与当前Account镜像逐例比较，不得把整段旧测试无依据丢掉。

## 33. G10：购买入口/响应式设置与领取测试交集（UI 批次已重接，整体验收未完成）

本批属于真实 merge 冲突收口，不重做独立来源提交；先补 `coding-plan-upgrade-entry-decoupling.md` 整合契约，再恢复/调整测试、实施与分组复审。

- `32f6cb43eb` / `b5e8874696`：保留原生购买面板退役。删除旧 CodingPlanPurchasePanel、同名 pricingCards.tsx、专属 purchaseTelemetry 与三份原生支付测试；静态 dep:refs 显示面板零引用，并以文本检索补查。仅保留正在使用的新 pricingCards.ts、enterpriseTiers helpers；企业档位语言用例迁到独立测试，组排序已有当前测试保留。删除均可从 Git 恢复，不涉及用户数据。
- 原生 PlanSelect、支付金额/周期/轮询遥测和私有卡片详情用例随原实现退役，不恢复已删除 hook；入口遥测、WebView bridge、购买完成刷新等活代码仍验证。Start 升级 helper 的 staging 新文件引用已删除的 Coding Plan ID，测试实际返回 undefined；改为同域具体 Individual Provider，不通过 alias 恢复旧接口。
- `5865499161` / `85533a0c8c` / `8f08e49127`：响应式 Header、Start 数量快捷入口与 tooltip/aria 保留，计数继续由当前 Account 权益输入，不用 selected/current 代替拥有数量。保持模板创建、动态模型编辑/排序、Settings View 与手动连接切换；没有恢复旧 ModelProviderConfig/旧 family 状态。现名 useModelProviders 本身已封装 ProviderSettingsService，不因函数名相同误删。
- `cc32e0ca98` / `3feb9299ef`：Start 入口遥测分类、同步中 Subscribe 禁用/反馈保留。移除原生面板专属 visibility/token/funnel props；保留 Team 状态卡 audience，不能因面板删除意外变为 personal。既有团队横幅传入的 Team key 保留；没有扩修状态卡以前未传 key 的另一个边界。
- `dd73d8259f` 与领取轮询：来源轮询的空活动、隐藏恢复、并发去重、失败保留、领取后继续轮询、迟到 preview 不覆盖、claim/balance 时间隔离测试接到当前 ProviderSettings 刷新，不恢复旧 refreshCodingPlanApiKey。一个现有迟到权益测试依赖 startsAt 判断待生效，按已批准 claim entitlement.effectiveAt 契约更新 fixture；保留跨领取请求隔离断言。
- source 旧 primary-action helper 的测试未恢复：当前正式入口固定“模型设置”，已有 DOM 测试覆盖待生效/已生效均不自动切连接；不为仅测试调用的旧开关引入可执行“开始体验”路径。本批未改变该产品裁决。

验证与归因：18:50 商品源测试 1 RED（undefined vs Individual），修后通过。首次共享渲染失败为旧测试未挂 staging 新 tooltip 的 Provider，补真实上下文；领取一次失败为上述过时 startsAt fixture，不修改产品来迎合。18:54 **8 文件 278 条通过**：pricing、enterprise tiers/products、funnel、modelProviderCodingPlan、upgrade intent、embedded WebView、manualClaim interaction；增量 lint **12 文件 0 warning/0 error**，格式化完成。没有重复重跑两边所有既有产品测试。

当前 index 未解决路径 **33 → 18**。本组已裁决/已实施；验证为组内单测部分通过，完整构建、E2E 启动/fixture、Pro 交互、入口完整库存遥测交集与候选双向验收仍需继续，不以本批通过宣布 G10 或 Goal 完成。

## 34. 文档/E2E 冲突批量收口与当前接口对齐

已按本轮真实 merge 策略批量处理，保留独立来源，未重新制作来源提交。

- 六份冲突文档：保留当前插件仅官方源自动刷新/节流、冷态 override 和远程 Provisioning Environment 验证边界；合入 source CDN fixture、SSH 重连、分享/菜单/官方版本安全校验新 case catalog。source 历史验证与此前 Pro BG45 checkpoint 明确不代表完整候选验收。领取文档保留轮询、claim/balance 时间、故障验收，排除已裁决的自动体验/自动切换；seed 改为结构化 connection selection。UI polish 文档保留 Todo90/92 与 source 菜单样式两边证据。
- WDIO：合并 source inventory hold/fail、官方版本安全校验 fixture/专用超时、Wiki 套餐业务 mock；保留当前 Personal/Model Selection 独立文件和结构化账号选择，不恢复 source 旧四百行 Registry seed 或 family selected keys。source 共用 metadata save helper 与当前 Personal 创建流程并存，删除重复 helper 实现。普通场景不继承安全校验场景的长超时。
- E2E 交集：Background 保留 Full Access 草稿初始化及已裁决子 Agent 失败用量；Subagent 保留结构化内置 override/冷启动与原字段 Markdown 契约，拒绝旧双字段 runtime fallback；领取保留当前手动 CTA，补 source Hero 实际 4:3 几何断言。
- WebView E2E 保留 source inventory loading/error/ready、App 上报与 WebView 上下文相同、reload 不重复上报。旧 `readModelProvider(Account).apiKey` 只读取 Personal，不能证明账号 Key 已刷新：改为确认新 Key copy 请求且不泄漏到 Personal；没有读取或输出加密凭据。真实模型鉴权由已有服务测试/后续跨组验证覆盖，不夸大此例证明力。
- 首次 E2E tsc 发现响应式设置/Wiki 自动合并测试仍读取旧字段。响应式导航 key 接当前 `team:family:product:org:project`，持久化断言使用 structured connection；Wiki 具体 Individual ID、Registry group、modelSelection 落盘及 configuredDefault seed 对齐，保留同域 Start 有权益但不顶替当前普通套餐的用例意图。不实现 Todo101 多连接。
- 缺少三个 OffPeak test ID 的报错，经核查源码均已导出，属于 TS project-reference 产物未更新；不重复添加声明，由完整 typecheck 重建验证。

验证：19:06 mock-env / config seed / startup credentials / replay contract / lifecycle **5 文件 30 条通过**。E2E 文件与配置已合并，但桌面实跑尚未开始。本阶段文档 18→12，E2E 与下节服务测试收口后 index **12→0**；无文本冲突标记。不存在“零冲突所以可交付”的推断。

## 35. 自动合并旧接口漏接、安全校验测试去向与首轮整体检查

- providerRegistry.test 两个大冲突段主要是双方共同祖先已有、当前已删除的 RuntimeModel/整份 Registry 推送测试，并非 staging 新增两千余行功能。对照固定 source 的 base→staging diff，真正增量是安全校验私有应答、禁止 runtime/registry 改写。保留当前 Account 镜像/Selection readiness/只读 workspace 测试；把该 source 不变式参数化覆盖 local、SSH、WSL、Docker 及不同模型，不恢复已废弃缓存 fallback、自动模型兜底、旧 thoughtLevel 推送。该测试参数化只证明路径隔离和应答契约，不冒充实机连接。
- 完整 tsc 抓到 App UI 与 Agent 共用成功响应类型：当前协议成功为 requestAuth，但 UI 仅给 runtimeProviderHeaders。spec 先明确两个信任边界，Services 定义独立 UI 输入类型；Host 原有安全校验请求头白名单及账号服务合成保持，Agent 协议仍严格拒绝旧裸 headers 格式。协议测试同步调整，Renderer 不获得构造账号凭据的权限。
- G10 新入口统计 hook 自动合并后仍调用旧无参 useModelProviders，并以 apiKey/旧 Coding Plan ID 识别套餐；会丢列表或阻断入口。先调整新架构 fixture，19:15 实际 5 RED；按当前根 Settings 只读 View + Inspection Access + 权益 hook 重接，不要求 current/enabled/executable，不新增查询缓存；Team 保留 authenticated pricing。新增 Settings 初次失败/手动 retry 不误放行测试。旧 async query 取消及 generation 守卫保留。
- 19:14 Services 私有应答/窄订阅/取消与协议 **4 文件 24 条通过**；19:16 G10 inventory/helper/入口/funnel **4 文件 15 条通过**。UI 本批 fixtures 不再伪造旧 apiKey 字段。
- 首轮完整 `pnpm typecheck` 失败归因为以上合并漏接，不扩成既有产品修复；缺失 OffPeak ID 已随重建消失。后一次剩成功应答可选 errorMessage 类型遗漏，补回原合法类型，继续完整检查。首轮 `pnpm lint` **0 errors/44 warnings**；其中本轮 WDIO 冗余 spread 已清理，其余待来源分类，不自动全仓修警告。

本批只完成显式冲突与已发现自动交集的接口收口。真实 merge 仍待关键验证后提交；完整候选的源→结果/重构→结果双向复审、CLI 重建和跨组测试、Pro 验收继续，Goal 未完成，不合回 recovery、不推送。

## 36. 完整候选共享验证与失败分类（进行中）

- 19:18 完整 `pnpm typecheck` 通过；19:27 changed architecture gate **0 violations**。
- 根目录完整单测：**1631 文件通过、2 文件失败、2 跳过；14267 条通过、2 失败、26 跳过**，日志 `/tmp/todo103-candidate-unit-20260909-1919.log`。两处是测试旧接口：share composition 初始化漏 options；Wiki lane 重新引入旧整份 Registry 推送测试。按当前完整 Account 交付语义调整，保留 SSH/WSL 覆盖，定向 **2 文件 8 条通过**。不为仅测试改动重复运行全部 14k 用例，亦不把首次结果改记全绿。
- CLI nested `build` 缺 turbo bin 属执行环境，改用 workspace recursive build，contracts/shared-types/adapters/core/i18n/telemetry/bootstrap **7 包构建通过**。重建后宽范围 suite **395 文件通过、21 失败、2 跳过；5265 条通过、87 失败、45 跳过、2 todo**，日志 `/tmp/todo103-candidate-cli-unit-20260909-1926.log`。失败须逐类归因，不能将全部 87 条扩为本轮修复，也不能未核实便称既有问题。
- 已确认分享标题测试仍断言 source 已退役的 `sharedContextImportTitle`，实际 source/候选均返回 `sharedContextImport.title`；闲时原测试不允许任何 denylist，与 D49 新增本轮 OffPeakCreate 限制冲突。调整断言，保留后续普通轮不受污染的检查。Host 额外禁止 CronCreate 与 V4 单独加 OffPeakCreate 是两个入口的职责，不将 automation 写工具集混入闲时规则。
- 自动合并的官方版本安全校验 E2E fixture 仍写旧 config/cli-config 与 family 模式，会测不到当前 Account Provider。改为 isolated Built-in API override、结构化 connection 与独立 Model Selection seed；动态成员仍来自 balance。JWT 测试准入补安全校验/Wiki 两个受控 profile。先 **3 RED** 后 fixture/startup **2 文件 16 条通过**，pending fixture-check 通过；未晋级正式 E2E，未宣称安全校验交互已实跑。
- Pro 隔离副本 `/Users/dev/zcode-todo99-e2e.1lO3PN` 已同步完整候选，原测试日志/产物保留，不触碰日常项目或真实用户数据。新 pin 的 CUA HTTPS clone 因钥匙串凭据不可访问失败；正在复用本机同一锁定 SHA 的 pnpm 内容寻址源码缓存，不修改 pin、全局凭据或钥匙串策略。桌面验收仍未完成，旧 checkpoint 结果不替代本候选。

后续结果：CUA SHA `908b247399423195d0bcb0039e1755a333c4c1ff` 的 860 个源码缓存条目（约 9.8 MB）完整存在，复用后 Pro frozen/ignore-scripts 安装 1.8s 通过。没有搬运 Linux native 产物或用户凭据。完整候选桌面及 Agent 构建通过。上述 CLI 两处断言调整 **2 文件 67 条通过**。

Pro 首轮 `desktop-e2e-20260909193459481-p44025-5975c43ad85e6cc3`：4 specs 中领取通过、其余三组失败。购买库存测试只匹配英文，实际为正确中文“正在查询套餐…”；响应式 setup 要求 1000px 高度但屏幕工作区限制为 876px；Wiki focus 未挂载 action 行。分别改为双语状态断言、保持 1800/480 宽度断点但使用 800px 高度、实际 hover（路径属性正确转义）。未调整产品逻辑、超时或放宽核心行为断言。重跑三组，Agent 源码未变沿用刚通过的 bundle，桌面仍为 WebView 编译期 mock origin 重建。

## 37. G02/G15/G16/G18 独立来源批量保留与交集复核

采用固定 source 与候选文件内容比较、来源提交意图和双方 diff 三者结合；不重新制作独立来源提交。

| 组 | 来源路径去向 | 架构/产品交集复核 | 验证状态 |
| --- | --- | --- | --- |
| G02 | 66 个历史路径中 53 个与固定 source 相同、2 个 source 已迁走测试路径不复活，其余是现有文档、Main/Web装配、图谱、AGENTS/package 与技能软链 | 保留 Help 私有/公开 fetcher 分离，3.12.0 与 Provider 类型检查；MR 技能不意味着本任务获准推送或建 MR；Obsidian/技能文档按 source 留存，不据此主动操作外部库 | Help 前批证据保留；门禁测试 8/8、最终 gate 待重跑；不声称已全面治理所有模块 |
| G15 | 28 路径中 26 个与 source 完全相同；Main 与 WDIO 为共享交集 | Main 已保留 owner BrowserWindow 注入、透明 screenshot presentation、已有 workspace/session owner 隔离；恢复/cached URL/CDP idle/viewport/zoom/DPI/临时 UnknownVizError 均随 source 留存；WDIO 不恢复旧 Registry seed | 根完整单测涵盖相关浏览器用例且无该组失败；Pro 截图与恢复实跑仍待补 |
| G16 | 79 路径中 68 个相同、3 个退役文件确认为候选也删除、8 个共享交集 | Composer 保留 source + 菜单/插件入口、统一附件文案、mention 编辑器；保留当前内存 Draft、冻结 Submission 与按 ID 清理附件，不能恢复旧 localStorage 草稿或在迟到 ACK 清掉新输入。分享 context 单独由快照产生，不塞 URL 到 prompt。local HTML preview、localhost URL、文件链接单次解码与 smart quotes 接当前平台协议 | 相关根单测无失败；全端交互不以静态相同替代，最终跨组桌面回归待补 |
| G18 | 95 路径中 78 个相同、5 个退役文件均已删除、12 个共享交集 | Settings 保留 source 68/268 导航宽、4px desktop inset、统一窗控/问号入口与各平台圆角，同时保持当前 ProviderSettingsView/remote attachment；Automation/领取仅合入布局不恢复旧模型契约；Model Editor 智能配置/Map 排版/键盘拖拽隔离仍由当前实现及新增测试覆盖 | 根完整 UI 单测无该组失败；Pro 布局/当前编辑器联合验收仍待补 |

G02 发现新策略未登记重构后的 provider/provider-node：补 spec 与实际仓库 policy 测试，先 RED `missing module: provider`，登记两个现有源码根后 **8/8**。沿用 source 的 `managed:false`，不自动刷新 baseline、不为合并实施全仓 manifest/contract 迁移。`managedOnly:true` 且存量均未 managed，零违规证明有限；这一限制明确记录，人工架构复核不撤销。

本批状态区分：上述来源已裁决保留/按当前抽象重接；源码已进入真实候选；组级单测/构建证据已有，最终平台交互与跨组验收仍未完成。不得按“source 原样保留路径数”替代验证进度。

## 38. Pro Account/Wiki 交集通过与 CLI 失败分类纠正

- Pro 第二次响应式 CTP-12 通过（1800/480 宽度断点、tooltip、真实连接保存）。库存继续失败为空：fixture 有订阅却在付款前返回空组织/项目，且 WebView profile 的 JWT 被过滤；当前 Account 无法得到初始连接，因此并非仅文案差异。补两条测试先 **2 RED**，修当前 mock 控制面前置后 **2 文件 24 条通过**。只在受控 WebView 场景保留 JWT；普通 Personal-only case 隔离保持。
- Wiki 默认种子没有 reasoningLevel，按现行完整性校验不会成为 configured default，随后推荐其他模型。补 GLM-5.2/max 的完整 seed，不改产品默认回退/Selection 校验、不补静态假账号。
- Pro 第三次购买/Wiki **2 specs 全通过**，日志 `/tmp/todo103-candidate-pro-account-rerun2.log`：购买完整库存、同 funnel、购买后关闭并刷新/no Personal key 泄漏，Wiki 默认账户套餐/候选隔离/生成/新字段落盘均有实际断言。结合首轮 Start 领取、第二次 responsive 的通过，四组完成当前候选验证；不是“一次四组全绿”。安全校验 pending 已另启运行，使用显式 common+case replay，不晋级正式目录。
- CLI 宽跑部分失败来自执行 cwd：core Browser 文档 tests 按包 cwd 定位资源，原宽跑在 apps/zcode-cli 根会读错目录。按包 cwd 重跑 **browser-client/browser-manifest 两文件全部 50 条通过**；同组 runtime-unbound-resume 仍 1 fail/1 pass，错误包装断言需单独归因，不能叫浏览器合并回归。
- G03 CUA 灰度撤销使默认 MCP 连接新增 `plugin:computer-use:computer-use`，旧四例未更新。保留完整列表断言并增加官方 server；用户自定义 `zcode-cua` 不获得 broker 凭据的安全断言不变，禁用路径也不放宽。按包 cwd 定向 **18/18 通过**。
- 仍保留的 CLI 失败记录：旧 runner-options/config/PDF 测试引用退役接口（测试与相关 runner 源文件相对 checkpoint 无改动）；7 条 auth/telemetry 旧 schemaVersion=2 fixture（相关测试与账号适配源相对 checkpoint 无改动）；marketplace 本地源嵌套自复制、插件 packaged sharp fixture、两处 unbound 预期及已记 Todo102 的 remote Cron/V4 ACK 问题继续分类，不自动扩为全部修复。此前宽跑的 **87 failed 不能作为本轮净新增数**，也不能被覆盖成全绿。
- 最新完整 `pnpm typecheck` 通过；`pnpm lint` **0 errors/43 warnings**。G02 策略新增模块未启用大范围治理；最终双向复审/跨平台关键验收未完成，仍不提交合回 recovery、不推送。

## 39. 完整候选平台验证：安全校验、浏览器、设置编辑器

- Pro 官方版本安全校验 E2E `desktop-e2e-20260909194622186-p46656-08ed4ad96f7ee423` **1 spec 通过**（四种请求重试/取消/超时场景），runner exitCode=0。保留 pending，不自动晋级。日志在 Pro；没有真实 API 请求或业务白名单修改。
- `@zcode/web-share build`、`@zcode/web build` 均通过；仅有 chunk size / plugin timings 提示。此证据不等于部署了手机包或验证过公开分享。
- Pro hidden guest screenshot smoke 通过：从 2×2 bootstrap 恢复到 640×300，未抢焦点、结束后仍隐藏。surface smoke 首次精确 RGBA 断言失败（期望 255,0,0，实际 234,51,35）；相同脚本以 `--force-color-profile=srgb` 运行通过：1280×720、四角不同、没有周期平铺。不更改产品色彩配置。
- background activity smoke 在 `win.hide()` 后仍读到 host `visibility=visible / frames=96 / timers=80`，未进入后续唤醒/恢复验收。脚本与固定 source 字节一致且仅直接调用 Electron、不加载整合后的业务代码，属于原脚本在当前 Pro/Electron 的失败；保持记录，不改时限或扩大为浏览器生命周期重构。Windows 专项仍不能由本次 Mac 结果替代。
- Pro UI polish 首次 reporter 8 pass / 1 fail / 1 skip，其中 Windows-only `UP-00` 在 Mac 直接 return，不算 Windows 已测；7 项实际执行通过（菜单/导航、新增供应商、无同步入口、空列表、排序、删除）。MP-UI-06 的第一处失败为测试采样竞态：记录过渡 alpha=0.047，随后最终焦点 alpha=0.05 无法相等。仅调整测试为等待控件自身动画结束，保留相同颜色/边框断言。
- MP-UI-06 重跑继而发现旧断言仍要求删除用户 Map 原文空格，与 Todo98 已实施合同矛盾；输入与实际保存一致，改断言为输入原文并删除多余 canonical 常量。最后 Pro `desktop-e2e-20260909-195812-279` **该 case 通过**：中英/深浅/390px、Hover/焦点、智能配置、个人 Map 保存与视觉标记均实际执行。没有修改产品代码或样式。
- OffPeakCreate 冷恢复首跑被录像 `ffmpeg ENOENT` 遮挡。隔离目录 `/Users/dev/zcode-todo103-tools.MLS5xf` 安装 Darwin arm64 编码器，显式 `ZCODE_E2E_FFMPEG_PATH`，无全局安装/凭据修改。随后实际失败为请求中无 OffPeakCreate：日志所有 Account/Off-Peak entitled=false。fixture 只有取票网关、没有账号控制面及具体连接前置。补 4 例先 RED，复用现有 Coding Plan mock 后 **2 文件13条通过**；正在实跑，不称工具链已验收。

## 40. G14 有界保留与进程诊断交集复核

- 新增 retention policy/store、process sampler、v4 gateway、resident pool、各端诊断工具本体随正常 merge 保留；与固定 source 不同的 17 个路径集中在共享装配/barrel、协议/Session 类型和已有测试，而不是重新实现内存机制。
- server-operations 保留 eventStore 注入/创建失败清理；entrypoint 在同一 60s 采样回调依次 rebalance、prune stores、prune detached publishers、采样门控日志，关闭时 stop。当前进程 Registry/Selection owner 和异步初始化仍在，不恢复旧 RuntimeModel/DeferredAdapter。
- Gateway child source 实现保留明确 parent 归属、终态 grace、仍有订阅或独立 record 时不释放；释放调用已有 cleanup，`clearCommandInbox:false`、`notifyIndexRemoved:false`，不把内存清理当成任务删除。原 live ingest/topic 与冷恢复边界不改。
- Host/Main/Bot/Task adapter 的只读计数注册与 dispose 成对保留；UI App useEffect 仅创建每窗口采样 owner，cleanup stop，不新增业务缓存。retention 只移除既定四类瞬态事件，单调 seq/live sink、持久历史和普通/手机既有恢复机制继续各自负责。
- 证据复用完整 root/CLI suite：本组 sampler/retention/gateway/pool/诊断测试未在失败清单中；§29 retention 三例重建后通过，完整 CLI build 后宽跑覆盖同一源码。共享测试原 child 调用参数已按 source parent 参数调整，不反向移除 parent 信息。未把静态审计中的所有旧内存问题扩为本轮修复。

## 41. G11/G12 反向交集复核与 G07 派发证据

- G11 分享 231 个来源路径中 167 个与固定 source 一致；64 个不同路径为协议/Session/Store/装配与当前 UI 等交集，已结合 §29/31 审查，不以路径相同替代调用链检查。三条分享发送路径都保留 context_refs 与冻结 Submission；history/store 保留分享 attachment，同时模型元数据使用当前 providerId/modelId。导入不恢复旧 modelProviderService、选模字段或发送前同步。分享 service 的发布/清洗/完整性及原子导入本体随 source 保留，根完整测试及两个 Web build 证据复用。
- 公开分享 E2E 会调用真实发布 API，本轮没有因此发布用户内容或另获外部写权限；当前完成的是隔离服务测试、三条发送入口及构建验证，不冒充公开部署验收。是否需额外受控 HTTP 端到端证据仍在最终门槛审查中。
- G12 权限选项、broker、permission flow、PermissionDialog/V4InteractionDialogs 及 pending adapter 与固定 source 一致；共享投影保留新的镜像路由/定时工具归属字段，同时保持当前结构化 modelSelection 和 continuous/replayable 边界。side chat/fork 提醒仍作为 history attachment/system reminder，不回退 ModelRef 或旧选择字段。Pro `desktop-e2e-20260909201222791-p52186-4667f2beb6768e88` **5/5 通过**：Allow、Allow 忽略反馈、第四行 Enter/按钮拒绝反馈、空白拒绝；实际 provider-visible tool_result 与不执行文件写入断言成立。
- G07 OP10 首跑已走通 scheduler/四种前台子任务、同 Ticket/模型、禁止后台；下一普通轮因默认选择 seed 缺 reasoning 而走账号推荐，DeepSeek 捕获为空。补 case-local 完整 configuredDefault，不改变产品推荐或持久化。Pro `desktop-e2e-20260909201131066-p51724-fc89c2f309bf19b8` **OP10 通过**：下一普通轮走 DeepSeek、不进入闲时网关；扁平隐藏闲时列表只有 mock GLM-5.2。
- 冷恢复 OP-CHAT-02 此前创建/卡片/编辑已通过，但该证据不包含绑定派发；本轮扩展同一用例观察实际 scheduler 完成、同 Session 归属、执行前后持久 model_selection 不变，并复用现有 capture 网关记录。正在实跑，尚不记通过。

以上是完整真实 merge 候选上的分组证据；Windows 安装器执行、真实 SSH 设置切换以及整体最终门槛仍未完成，不合回 recovery、不推送。既有失败仍按 §36/38/39 分类，不为追求全绿扩修。

## 42. 真实 merge 候选收口检查（不是合回验收）

- Pro `desktop-e2e-20260909201818194-p53379-3d3ab94fcf83e6b7` **OP-CHAT-02 通过**：普通首轮落盘 → Electron/Host 冷重启 → 旧 Session 创建闲时任务 → 卡片/编辑 → scheduler 实际派发完成；conversationId/sessionId 均保持原绑定，持久 `runtime/model_selection` 与创建前相同，网关请求使用任务的闲时模型和 Ticket。此前 capture 场景会转发上游而失败；改用已有脚本的固定文本响应，未改产品执行逻辑，没有把失败记录覆写成通过。
- G07 所需两种分支现在分别有证据：OP10 表单新建及子任务/后续普通轮，OP-CHAT-02 已有 Session 绑定派发。E2E 延伸先写 coverage，再实跑；不把两条重复跑成全量闲时产品验收。
- 最新全仓 `pnpm typecheck` 通过，`pnpm lint` **43 warnings/0 errors**；本次仅测试与记录变化，不重复已跑过的 14k 根测试。当前候选相对固定 recovery 的生产新增行扫描未发现 modelProviderService、turnRuntimeModel、applyTurnRuntimeModel、selectedModel、generationModel、RuntimeModel、setProviderRuntimeHeaders、旧 updateModelProviderConfig/registrySync 引用。这是机械补充，不能替代各组架构审查。
- CLI native-boundary 的三条 import 告警分别为 session-flow → model-execution、goal-compact/prompt-turn → session-residency；checkpoint 已包含相同 import，本候选未新增。相关旧测试不在本轮借机扩修目录架构。§38 其它已记录失败继续保留，不宣称 CLI 宽跑全绿。
- 来源 JSON 为全部 193 条非 merge 来源补独立 decisionStatus/implementationStatus/verificationStatus 和组级证据；全部 verification 仍为 partial，最终文件交集审计及平台门槛未完成。旧 status/evidence 留作历史，不再用待重制提交数量表示进度。
- 按用户批准的早 merge 策略，当前候选可以保存为双亲 merge 提交，后续在该分支继续审阅与必要修复。**提交候选不等于允许合回 recovery**：G01 Windows 执行、G17 真 SSH 设置开关、最终双向/跨组复审仍为本轮门槛；不转交102规避，不推送发布。

## 43. 双亲 merge 已提交与文件去向终审

完整候选提交 `e1c611be98cd421efc725e80eb43b923994ee3a2`，父提交为 `c4f8619d96` 和固定 staging `790884b1ce`。提交后工作区干净；recovery 仍为 `f0174b57f5`，未推送、未发布。继续在整合分支做最终验收，不重制独立来源。

- 950 个来源/冲突路径机械比较：647 个与固定 staging 同一 blob/同为删除；298 个是组合修改；5 个沿用 recovery（其中3个继续删除旧实现）。没有“仅 staging 修改、候选却无依据回到 recovery”的路径。哈希相同不代表隐式依赖安全，交集语义仍按各组账本审查。
- 5个沿用当前结果的路径已逐个复核：旧 workspace-model-catalog 继续删除，安全校验行为迁到当前请求鉴权端口（§26/31）；旧 modelProviderServiceStorage/modelProviderEnablement 测试继续删除，同端点 Start/Individual 成员隔离由当前 provider resolver 测试覆盖；modelSelectionGroups 保留只消费 Selection View 的实现，repoWikiPaneState 保留新版测试，不恢复 familySelectedKeys/entitlement 自建分组。Wiki 普通套餐与共存 Start 的隔离由 §38 Pro 用例覆盖。
- staging 自身 60 个 merge 的历史审计仍有效：58 个无独立 remerge 差异，2个独立解决已分别进入 G01/G15（§8）。并非忽略全部 merge commits。
- 本批 E2E typecheck 通过；OffPeak fixture 检查通过（编辑后标题不是网络 matcher，保留该 warning）；fixture 控制面/回放合同 **2文件13条通过**。提交前全 index diff check 已通过，仅去掉来源技能文档末尾多余空行，未改变其指令或执行 MR。

仍未作出最终完成声明：组合文件交集终审、关键平台门槛和整体跨组收尾继续；旧独立测试失败没有被隐去，也没有扩成全仓修复。

## 44. 文件级去向收口与剩余失败分类

本节审计对象固定为真实 merge `e1c611be98`，不是随后变动的远端 staging；recovery 未移动。全部 950 个来源路径补独立裁决/实现/验证字段，193 个非 merge 提交均有来源文件引用，无孤立来源。647 个直接保留、298 个组合、5 个保留当前结果的统计与 §43 一致。五项排除或等价覆盖的具体理由见 §43，其余交集按前述功能组裁决。**文件指纹只证明去向，不能证明隐式依赖安全；verification 统一保持 partial，不把批量合并改写成全项验收通过。**

本轮补查自动合并的共享边界：RemoteServiceAccessor 的 conversationShare 代理与 descriptor/接口配对；remote workspace 分享读取仍使用远端数据、仅鉴权复用本地 OAuth。FileStat.mtime 对应并发读取校验，新增 share/import 外部文件频道与各端注册配套；删除 CUA 灰度未留下旧装配。canonical user intent 增加 context_refs 时保留已冻结的 modelSelection/mode。OffPeak port 从 runtime/executor/tool dependencies 显式传入，不为普通子任务自动开启；执行用的 offPeakTurn 与普通持久选择分离。以上没有发现需要另补的生产代码修改。

CLI 宽跑失败继续按来源分类，不以失败总数当作合并回归数：

- MCP OAuth 跨进程用例在 adapters 包 cwd 重跑通过；同批 Bash 后台后代进程终止用例仍失败（1 pass/1 fail，126 skipped）。相关生产实现相对合并前 checkpoint 没有变化，不借本轮扩修进程终止。日志 `/tmp/todo103-cli-io-failure-classification.log`。
- MCP PATH 两项预期与当前 Node 工具路径注入不同；marketplace 本地导入测试把 destination 放进 source 子目录导致自复制失败；插件 packaged fixture 依赖旧 sharp 打包位置。相关失败路径的实现未由本次合并改变，保留 §15/38 记录。
- runner-options/config/PDF 的退役接口、auth/telemetry 的旧 schemaVersion fixture、unbound 配置默认值与错误包装预期、native-boundary 的三处旧 import 均已有 checkpoint 证据。已知 V4 ACK / remote Cron 仍归既有欠测，不新增全仓重构。
- core Browser 包 cwd 引起的两文件 50 条已通过；CUA 默认 MCP 列表的四条过时断言已按保留行为修正并 18/18 通过。不能把“旧测试”作为跳过新增接口契约的通用理由。

完整候选再补插件显式 Subagent 与 Composer 草稿首发的跨组回放。没有选择旧 queue-model-switch 用例来改变冻结语义：该旧例要求消息入队后再改选影响队列，不能据此回退当前冻结 Submission 合同。首轮 CLI 将两个 spec 错当一个逗号路径、第二轮 fixture 使用错误仓库相对路径，均为本次运行参数错误、没有执行行为断言；纠正后继续实跑，结果单列。

G01 Windows 安装器实际执行、G17 隔离真实 SSH 设置开关仍需环境，已向用户询问隔离测试机/连接配置，不请求明文密码、不动真实用户数据。其余独立工作继续；关键门槛不转交102、不提前合回。

## 45. 完整候选双向代码复审与交叉回归收口

Pro `desktop-e2e-20260909-203731-261` **2 specs / 2 cases 通过**，runner exitCode=0，日志 `/tmp/todo103-pro-cross-selection-rerun2.log`。插件冷启动覆盖用例捕获 child 的 alternate/high 与父 continuation 的原 model/max，确认覆盖配置没有被改写；Composer I10/I47/I52 捕获首发模型/档位，验证接纳后草稿改选不覆盖 Session、完整冷启动仍恢复草稿。不是旧“入队后改选影响队列”语义验收，不自动晋级 pending。

完整候选的两轮代码复审归纳如下（关键平台实跑仍未结束）：

| 方向 | 覆盖与结论 | 主要证据 |
| --- | --- | --- |
| staging → 结果 | 193 非 merge 来源、60 merge 来源、950 路径均有去向；独立改动正常保留，显式/自动交集按功能重接；没有未解释的单边来源丢弃 | §8、各组来源表、§43–44 / inventory 三维记录 |
| 重构 → 结果：Provider / Account / Selection | 具体 Provider 身份、Settings 写入所有权、Account 完整快照、执行选择与持久意图区分仍保留；未恢复旧 family/Registry 旁路或发送前同步 | §25–35、§38、§42–44；Account/Wiki/插件/草稿实跑 |
| 重构 → 结果：Session / 分享 / 闲时 | 分享上下文附加到冻结提交；闲时 Ticket 与本次执行隔离，不改绑定 Session 的普通选择；隐式/显式 Subagent 各守当前边界 | §31–32、§40–42、§45 两条跨组回归 |
| 重构 → 结果：远程 / 协议 / 生命周期 | 远端 identity/session scope 未退回 path-only；continuous/replayable 及 owner 路由边界保留；瞬态内存回收不当成任务删除，新增字段与装配配对 | §22、§29–31、§40、§44；G17 真实 SSH 仍待验证 |
| 构建与验证 | 当前完整候选 typecheck/lint、CLI/Web 构建及相关批次测试有证据；宽跑失败已归类、不宣称全绿；Mac 不替代 Windows | §36–44，保留原日志及失败记录 |

本轮最后只修改审计记录，没有再次改动产品源码，不重复整套共享构建/14k 单测。文件审计字段检查 950/950 齐全，三个去向计数与固定候选一致。**代码复审收口不等于 Goal 完成**：G01 Windows 真实安装/卸载 smoke、G17 隔离 SSH 运行中设置开关是剩余本轮关键平台门槛。没有将其转交102，没有合回 recovery，没有推送。

## 46. 剩余平台门槛的环境复核与恢复入口

在 `f1589ef797` 后只读复核：工作区干净、freshness 通过；Linux 未找到 wine、qemu-system-x86_64、docker、virsh。Pro SSH 管理连接可达，系统为 Darwin；当前非交互 PATH 未找到 docker/prlctl/VBoxManage/qemu，且没有注入任何 ZCODE_E2E_SSH_* 环境变量。本结论仅描述可用执行环境，不声称机器磁盘上绝对没有虚拟机软件。

G01 两个既有脚本均检查 win32，使用临时目录创建 fixture 并清理。待提供隔离 Windows 执行环境后，在完整候选安装依赖，运行：

```text
pnpm --filter @zcode/desktop test:installer-nsh-smoke
node packages/desktop/scripts/test-installer-preserve-files.mjs
```

需要保留实际 installer/uninstaller 日志与脚本退出结果；Linux 上脚本跳过不能解除门槛。不能为了自动续跑自行开通云 Windows、创建系统用户或改变真实安装。

G17 现有 helper `readSSHRuntimeConfig` / `toSSHConnectOptions` 明确使用 password，不会读取管理 SSH alias 的私钥。Pro 管理连接可达不等于该用例前置具备。需要在测试进程安全注入 ZCODE_E2E_SSH_HOST / USERNAME / PASSWORD / PORT，显式指定两个不同的隔离 WORKSPACE_PATHS，不采用默认 `/root,/home`。目标账号须允许反向转发，且其 server/Agent 数据可供本次测试写入；仅工作目录为空不足以隔离同一真实账号的默认数据目录。随后在 Pro 运行原 pending `conversation-session-ssh-remote-settings-overlay-sidebar-status.test.ts`，显式加载 common 与同名 case-local replay，不能只跑 mock 解除真实 SSH 门槛。

已询问环境配置位置，不在文档记录密码、不复用历史同事凭据；不为绕过环境缺失改产品鉴权或扩大 E2E 工具重构。没有仍在执行的验收进程可等待。剩余本机独立审查已完成，恢复这两项需用户提供隔离环境或新的明确授权；未满足前保留候选，不合回、不推送。

## 47. 2026-09-10 独立复审：两边预期与 Provider 核心

### 前提与执行范围

用户排队消息假设已合并；实际 HEAD `d82b547348` 是真实 merge `e1c611be98` 后的文档提交，整合分支干净，recovery 仍未移动。执行再次复审与测试，不假定平台门槛通过。Goal 工具仍保留原 blocked 目标，尝试按用户要求创建复审目标被 unfinished-goal 拒绝；没有假标旧目标完成或删除它，工作与记录继续在原 Todo103 中。

本轮遵循架构治理技能读取 Provider 现行设计及目标模块上下文，并对全部来源重新核算；按 E2E 技能使用 Pro 既有隔离副本和显式回放。没有产品代码、测试代码或 fixture 改动，没有自动晋级 pending、推送或改真实用户数据。

### 独立核对结果

1. **来源保留。** 固定候选的 950 路径重算仍为 source-preserved 647 / combined 298 / current-retained 5，与 inventory 不一致数 0。五项继续引用 §43 的逐项理由；不是把当前分支当作唯一规范。固定 recovery → 候选在 `packages/provider/src`、`packages/provider-node/src`、`config/provider/zcode-builtin.json` 无变更，核心配置实现未被 source 覆盖。
2. **配置/设置。** 重新读取 Registry Service 与 Selection Facade：Settings 和 Selection 从已应用快照获取模型/账号事实；配置与 Account 的 Built-in revision 不匹配继续保留旧完整快照，不发布拼装状态。动态成员写入/首次 Personal root 创建、稀疏覆盖、revision 冲突、模型完整性与顺序有对应 core/config/facade 测试；Host 目标路由与读取参数隔离由 services 验证。
3. **Worker/执行。** 账号交付测试通过真实 server.handleMessage 验证 received 与 applied 分离，不仅测试序列化；缺 current 的普通有权益账号拒绝交付，Off-Peak 不被强加普通账号条件。Model Registry/App 绑定、显式 Subagent、旧身份加载、请求 endpoint/header、安全校验取消与普通消息执行分别验证。新的安全校验端口仍仅由完整 Account Access 请求进入，普通 API 不触发它；随机 requestId 与取消只处理请求交互，不改 Registry 或用户选择。
4. **新功能与既有选择。** Bot 删除检测只认目标 workspace 的 tombstone；重建清旧交互后仍通过公共 View 解析和 V4 首发，不因列表过滤/归档重建。分享 context_refs 仅追加在冻结提交旁，不替代 ModelSelection。Off-Peak port/派发传入单次 modelExecution，绑定任务不写普通 Session Selection；queued/rejected/completed 分支恢复 turn 归因，不增加第二份 accepted queue。上述代码交集及对应运行测试未发现新的合并回归。

```text
Built-in + Account + Personal -> 同一完整 Registry 快照
                                      |
          原选择/草稿 -> 有效解析 -> 冻结提交 -> 目标 Model
                                      |
                  分享上下文 / 闲时执行约束仅随本次提交
                  不倒写原意图，不改变已创建的 Model
```

补充机械扫描固定 recovery → 候选生产新增行：modelProviderService、turnRuntimeModel、applyTurnRuntimeModel、setProviderRuntimeHeaders、ModelConnectionPort、AiSdkModelRegistry、familySelectedKeys 命中 0。此检查只是辅助，不以字符串命中数证明全部抽象正确。

### 本轮测试证据

| 范围 | 本轮结果 | 日志 |
| --- | --- | --- |
| provider / provider-node 全部单测 | 24 文件 / 328 通过 | `/tmp/todo103-second-review-provider.log` |
| Host 配置/账号/选择/子任务/Wiki/闲时重点 | 14 文件 / 108 通过 | `/tmp/todo103-second-review-services.log` |
| Worker 账号交付、Registry、路由、子任务、闲时及选择变更 | 14 文件 / 100 通过，在 bootstrap 包 cwd 执行 | `/tmp/todo103-second-review-worker.log` |
| Bot 删除/消息/配置、分享导入/组合、Host 闲时派发/结算 | 10 文件 / 187 通过 | `/tmp/todo103-second-review-cross-entry.log` |
| 根 typecheck（包含 E2E tsconfig） | 通过，增量编译 | `/tmp/todo103-second-review-typecheck.log` |
| 根 lint | 43 既有 warning / 0 error | `/tmp/todo103-second-review-lint.log` |
| architecture:check --changed | 0 violations；范围有限，不作为全仓架构证明 | `/tmp/todo103-second-review-architecture.log` |

共 **62 文件 / 723 条单测通过**；不与上一轮相同测试叠加计算覆盖量。architecture-policy 当前模块均 managed=false、global.managedOnly=true，context 包也没有发现公共契约，因此架构门禁的绿色结果证明力有限，核心结论依靠上面的人工差异审查及行为测试。没有为绿灯扩大治理或刷新 baseline。

### Pro 新增实际请求证据与过时用例

运行前对 Pro 隔离副本 WDIO、effective-model-selection、server-operations 校验 SHA256，与本地候选一致，沿用此前已完整同步/构建的副本；没有把另一分支包当候选。I13 `conversation-session-same-model-provider-identity.test.ts`：

- 默认运行 `desktop-e2e-20260910-011336-440` **失败**：Provider currentValue 和目标 model 请求断言已通过，但旧测试期待 high，实际 max。测试先 prepare 旧模型为 high，再主动选 alternate；Todo88 R11/公共 completeNewModelSelection 明确取目标最高档。该测试本次合并零 diff，最后修改是此前 `e24db74d05`，属于过时预期，不是新的合并回归。日志 `/tmp/todo103-second-review-pro-provider.log`。
- 使用已有 `E2E_PROVIDER_THOUGHT_LEVEL=max` 参数补完整运行，`desktop-e2e-20260910-011540-519` **1/1 通过**：跨 Provider currentValue、实际目标模型/max、回复内容和回到 idle 均有断言。日志 `/tmp/todo103-second-review-pro-provider-max.log`。没有修改断言/fixture，也不以这个参数化通过覆盖默认运行失败；它不单独证明 high → max 的主动改选行为，前一轮实际捕获与已有 core 测试提供该证据。
- 文件名虽含 same-model，该例实际是 primary/alternate 分别暴露 flash/pro 的跨 Provider 选择，不能夸大为同名模型在不同 endpoint 的完整对照；文档 I13 已使用准确描述。

### 结论与保留项

本轮复审范围内没有发现新的合并回归、Provider 核心抽象回退或需要新增产品裁决的问题；不等价于证明两边所有既有功能绝对无 bug。I13 默认档位断言作为既有测试问题留账，本次不借复审扩修。此前 root/CLI 宽跑失败仍按 §36–44 保留分类，没有被本轮通过记录覆盖。

**G01 Windows 实际安装器、G17 隔离真实 SSH 设置开关仍未验证**，不转交102规避、不合回 recovery；Todo101/独立 CLI/同步系统重做仍不实施。用户允许保留的少数未决事项继续原样记录。本次复审结果不替代原 Goal 的最终完成条件。
