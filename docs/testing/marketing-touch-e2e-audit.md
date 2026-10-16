# Marketing Touch 分支 E2E 完整性审计

日期：2026-09-12。状态：审计，不是功能完成或 95% 覆盖率验收。

## Feature Summary

| 字段         | 内容                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------ |
| 意图         | 检查当前分支相对 staging 的全部变更，列出 E2E 缺失、失效断言与补充顺序                     |
| 工作分支     | `test/marketing-touch-e2e-coverage`，从当前本地修改创建，未 push                           |
| 被审计提交   | `d0028042fee3f2026a08f37365165a5255aa33ab`，包含本地资源清理提交                           |
| 远端比较基线 | 本轮 fetch 的 `origin/staging`：`7a01923f5824760937e09a8df85a85372bcdeb63`                 |
| 差异起点     | merge-base `87d6a7b2fc32d088452334c4309f33b0f8b039b1`；三点差异 116 文件，+11406/-4250     |
| 能力         | 营销投放、媒体与 ZIP、富文本、导航/复制/领取、上报及相邻权益刷新                           |
| 层级         | presentation / validation / commit-effect / recovery / cache                               |
| 模式         | impact-only；只新增审计记录，不改业务代码、测试断言或自动转正用例                          |
| 主入口       | `MarketingTouchProvider` → Controller/Poller → Banner/Dialogs；Marketing/CloudContent 服务 |
| 不在本轮范围 | 服务端实现、真实领取或支付、外部资源 workspace 的制作功能、创建任务/自动切模型             |

结论：需要补充与调整。历史文档中的 **118/122（96.72%）是旧基线 focused Vitest 覆盖率**，不是当前分支 E2E 覆盖率，不能用于本次验收。现有用例有实际通过的主路径，也存在旧 API、失效断言、跨用例污染以及尚未执行的异常路径。

## UI Surface Matrix

| 场景          | UI 入口            | 共享实现                            | 展示 owner                     | 数据来源               | 门禁                     | 提交动作                           | 权威/持久化                       | 模式边界                           | 必须隔离                 |
| ------------- | ------------------ | ----------------------------------- | ------------------------------ | ---------------------- | ------------------------ | ---------------------------------- | --------------------------------- | ---------------------------------- | ------------------------ |
| Banner        | WorkspaceSidebar   | MarketingBanner/VisualBody          | Controller                     | GET banner             | 资源准备、ready、pending | claim/open_url/navigate/copy/close | 服务端投放与 action；宿主资源缓存 | Desktop/Web 共用；Web ZIP fallback | 设置页、任务模型选择     |
| 独立弹窗      | Shell 自动展示     | MarketingDialogs/CloudContentDialog | Controller waitingPopup/dialog | GET popup              | 页面可见、无其他 modal   | 按钮与三种关闭入口                 | 服务端投放；当前窗口状态          | 不随 workspace 重建 owner          | 安全校验弹层、升级页、已有弹窗 |
| 结果弹窗      | Banner 动作成功    | 同一 Dialog                         | Controller waitingResult       | 同次投放 success_popup | 结果优先、资源准备       | 新动作 confirm；关闭不重复 cancel  | claim 是成功权威                  | 不让刷新失败逆转成功               | 其他独立 Popup           |
| 领取失败      | Banner/Popup claim | MarketingFailureDialog/Alert        | Controller error               | data.message           | 非成功或结果不确定       | 知道了/Esc/遮罩 clearError         | 不自动重试、不额外上报            | 共用组件，窄屏不是手机实机         | 原 Popup 应恢复          |
| 设置/插件市场 | navigate           | 原设置页/市场页                     | 导航关联 + 原页面 owner        | args 与既有目录        | 目标实际接管后确认       | 仅导航，不保存连接/安装插件        | 原设置/插件服务                   | workspaceIdentity；不另建 runtime  | task/模型/连接事实       |
| 升级购买      | navigate upgrade   | 原升级 Provider/webview             | 导航关联 + 购买容器            | 当前 upgradeTarget     | dom-ready；失败/取消恢复 | 打开成功 confirm，不是支付成功     | 原购买流程                        | Desktop 支持；Web 明确失败         | 自动下单/支付            |

```text
HTTP GET(seq) -> schema -> 资源授权/下载/校验 -> Controller 当前候选
                                           +-> Banner -> 动作快照/防连点
                                           +-> waitingPopup -> modal 门禁 -> Dialog
动作 -> 安全校验/宿主能力 -> 明确结果 -> confirm 或错误提示
关闭 -> 当前实例收口 -> cancel（结果弹窗关闭除外）
账号/语言/卸载 -> 旧代次失效 -> 迟到响应不得恢复 UI 或借新凭据上报
下一轮同 ID 下发 -> 仍由服务端决定是否展示，不设本地历史黑名单
```

## Shared And Divergent Behavior

| 关注点 | 共享                             | 有意差异                                         | 审计要求                               |
| ------ | -------------------------------- | ------------------------------------------------ | -------------------------------------- |
| UI     | VisualBody、文本安全渲染、Button | Banner 96px，忽略按钮 theme；Dialog 支持 theme   | 不用 Hero 成功代替视频 Banner/样式验收 |
| 数据源 | Marketing GET DTO                | success_popup 固定为操作快照                     | 领取余额刷新不能覆盖结果数据           |
| 默认值 | locale/theme 由 App 提供         | Banner 空 format 合法，Popup 不合法              | 混合合法/非法投放独立解析              |
| 校验   | 宿主授权、摘要、安全解压         | Web bundle 不访问 Desktop loopback               | 故障资源与跨端 fallback 要真实触发     |
| 副作用 | 单操作 pending、confirm/cancel   | copy 保留；navigate 关闭；结果 close 不报 cancel | 每个动作按真实成功判据断言             |
| 恢复   | generation/释放 lease            | 网络失败保留短期内容，空响应撤下                 | 不能仅靠 Happy Path 顺路执行算覆盖     |

## Feature Relationships

| 等级           | 来源 → 目标                                                          | 语义/条件                       | 原因与证据                                                     |
| -------------- | -------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------- |
| must-inspect   | Root/Sidebar → MarketingTouchProvider                                | 窗口单 owner                    | Root、WorkspaceSidebar 本分支 diff                             |
| must-inspect   | Provider → Controller/Poller → Service                               | identity、query、report         | 当前实现有代次和事件刷新；需验证序号、串行、迟到响应           |
| must-inspect   | Service → AssetRegistry → BundleCache → iframe                       | 授权、下载、lease、握手         | 成功 ZIP 已有 E2E，异常主要是单测                              |
| must-inspect   | navigate → SettingsPage/ModelProviderSection/PluginStorePage/Upgrade | 目标确认而非 dispatch 即成功    | 模型定位现有 E2E 实际失败                                      |
| should-inspect | claim → 权益/account 刷新                                            | best effort，但刷新必须真的执行 | Provider 仍访问不存在的 modelProviderService                   |
| invariant-only | shared-host/remote/task runtime                                      | 沿用服务入口、不增加 Agent      | remoteServiceAccess 与 services/node 注册 diff；无跨端运行证据 |
| evidence-only  | Unit/旧 coverage docs/资源 fixture                                   | 解释路径，不替代 E2E            | 旧 96.72% 与当前口径不同                                       |

## State Owners And Commit Sinks

| 状态     | 展示 owner               | 权威 owner           | 提交点                             | 持久化/缓存                  | 证据                                     |
| -------- | ------------------------ | -------------------- | ---------------------------------- | ---------------------------- | ---------------------------------------- |
| 投放资格 | Controller 当前候选      | 服务端               | GET /marketing/touch               | 不落历史去重集合             | marketingTouchController.ts              |
| seq      | 无 UI owner              | 服务进程模块计数     | 实际 GET 前分配                    | 不持久化                     | marketingTouchService.ts                 |
| 当前动作 | Controller.pending/phase | claim 或宿主能力结果 | Provider.execute                   | 固定 candidate/scope         | MarketingTouchProvider.tsx               |
| 上报     | 当前操作 scope           | 服务端 action        | Service.report                     | 不自动重试                   | Controller + marketingTouchService.ts    |
| 资源     | iframe 就绪状态          | 发布授权与 hash      | readPublishedMedia/prepare/release | host-instance cache + lease  | cloudContentService/contentBundleCache   |
| 导航     | marketingNavigation 关联 | 原目标页面完成信号   | finishMarketingNavigation          | 原设置页状态，不新增模型配置 | marketingNavigation/Settings/PluginStore |

## 当前用例逐项审计

两份营销 spec 均在 `packages/desktop/test/e2e/ui-shell/manual-review/pending/`。delivery 有 16 个 `it`，entitlement 有 1 个。多个 case ID 写在一个标题中不等于多个独立测试。

| 范围          | 已有 setup/action/assertion                                                             | 缺失或调整                                                                                                                                                | 优先级 |
| ------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 初始 Popup    | MTC-01：默认独立 Popup → 内容关闭按钮 → cancel 恰好一次                                 | 右上角 X、Esc、遮罩分别验证；目前只是检查 X 样式，没有点击 X 验证上报                                                                                     | P0     |
| Banner 领取   | MTC-03：真实 HTTP/PNG/ZIP、安全校验 success、挂起 claim → loading → success/confirm      | 快速双击、安全校验 cancel/error、未登录、提交超时、明确失败/不确定；不能以 disabled 样式断言代替双击提交计数                                               | P0     |
| claim 后刷新  | success Popup 可见                                                                      | 必须断言真实 account/权益刷新被调用且更新投影；另注入刷新失败，确认不逆转 claim                                                                           | P0     |
| 同 ID 重投放  | 成功后和关闭后等待正常 30s；再关闭计数；独立 Popup 重投放                               | 持续同 ID 正在展示不叠加；旧 GET/慢资源完成不能复活被关闭内容                                                                                             | P0     |
| 轮询          | 30s 正常等待、online 加速                                                               | hidden 恢复、慢请求并发合并、失败退避、空数组撤下、十分钟过期、身份/语言重建；生产 600s 不能拿测试 30s 代替                                               | P0/P1  |
| seq/请求头    | 服务单测有首次/并发/失败/匿名                                                           | fixture 仅记录 pathname，丢失 query/headers；增加脱敏 method/seq/头部存在性账本，验证 0 起始、失败也增长、POST 不占序号                                   | P0     |
| 上报可靠性    | 成功、内容关闭、复制多次 confirm/cancel                                                 | 匿名、上报 500/断连 UI 不阻塞且无重试、账号切换不借新 token、结果 X/Esc/遮罩不重复 cancel                                                                 | P0     |
| 复制          | MTA-01 原文/换行/HTML字面量、重复复制、无 SVG、保留；MTA-06 权限失败                    | 失败测试被前序污染；复制 pending 双击、10s 不确定结果、旧账号迟到、不误填输入框/创建任务                                                                  | P1     |
| 设置导航      | MTA-02 外观；MTA-03 全 14 分区                                                          | 默认/上次分区、已有目标复用、不创建新设置 tab；无副作用应读当前实际连接结构                                                                               | P0/P1  |
| 提供商定位    | MTA-05 指定 provider 与缺失 provider                                                    | 使用旧 builtin:bigmodel，与当前导航契约不匹配；连接快照读取已删字段可能 undefined 对 undefined 假通过；增加当前 family/account/custom、加载中与不存在路径 | P0     |
| 插件市场      | 首页、目录首项详情、不存在时报错不上报                                                  | 目录需 case-local 固定内容；成功两次也逐次核对 campaign confirm；配置/安装/任务无变化；同路径不同 workspaceIdentity 不能误确认                            | P1     |
| 升级页        | MTA-07 webview 可见、confirm 一次、关闭不追加                                           | ready 前不能 confirm；加载失败/提前关闭/超时恢复原 Popup；Web 不支持；保留原普通升级入口回归                                                              | P0/P1  |
| ZIP Banner    | MTC-BUNDLE ready、数据/主题、96px/94px、pointer-events、copy/close、下载数不增加        | 依赖前面先下载 ZIP、先进入设置；应各自准备。补冷缓存/同 SHA 热缓存/不同 SHA/lease 释放；下载未增不能单独证明未重复解包                                    | P0     |
| ZIP/Hero 安全 | 正常 ZIP/翻转/重播                                                                      | hash 错误、未授权/重定向、缺 entry、恶意路径/大小超限、ready/error/超时/伪造消息；网络/fallback/lease 要走真实宿主链路                                    | P0/P1  |
| 失败弹窗      | MTC-FAIL 服务翻译与空白兜底、无可见标题/X、Info、主题/358px、知道了不上报               | Popup 内领取失败后恢复原 Popup；Esc/遮罩不重试；code 缺失、数字/字符串、纯文本恶意 HTML；长文滚动/焦点返回                                                | P0/P1  |
| 富文本        | MTC-RICH HTML title/Markdown description/button；MTC-HTML class/style 与 outline 优先级 | Markdown 链接/表格/代码、安全 HTML/URL/style、标题/按钮行内且无嵌套交互；未知已保留 class 不代表任意 Tailwind 生效                                        | P1     |
| 媒体          | MP4 Banner ready/播放/loop/muted/96px                                                   | Hero video controls、hidden/reduced-motion 暂停、解码失败 fallback、dark image；Lottie 属公共组件分支但 Marketing DTO 不下发，单列不可达边界              | P1     |
| 视觉/可访问性 | CSS 圆角/hit-test、saveScreenshot；亮暗主题局部改 class 和 358px 容器                   | 原生窗口合成层圆角截图与人工复核；真实 viewport、Tab/Enter/Escape/focus、实际 locale 切换；局部宽度不算手机/Web 验收                                      | P1     |
| 权益与连接    | entitlement 一长用例直接 HTTP seed claim，再验证余额/Start/Individual/Subagent          | 5 个旧 API 类型错误；独立 seed/reset；不是 Banner 后置刷新证据；使用当前 structured selection，拆分故障可定位的场景                                       | P0     |
| 退役逻辑      | 旧 preview 入口不存在、无 /billing/preview 请求                                         | 原正式 spec 删除，新 pending 默认排除；不能在 CI 中默默失去正式回归。人工确认后按 promotion 流程转正                                                      | P0     |
| 注册与退出    | services/node、RemoteServiceAccess、缓存 dispose 修改                                   | App 退出/Host dispose 清理资源；remote/Web 支持与 fallback；跨窗口无历史拦截；不能用一个窗口运行证明跨端                                                  | P1     |
| 构建/fixture  | bundle/tsup/wdio/mock generator、lockfile 也有变更                                      | 作为构建/契约测试单列，不计入业务 E2E 代码率；生成 ZIP/HTML fixture 不等于外部正式资源包验收                                                              | P1     |

## Must-Preserve Invariants

| 不变量                                      | 范围            | 必须取得的证明                 | 当前情况                         |
| ------------------------------------------- | --------------- | ------------------------------ | -------------------------------- |
| 服务端决定展示，同 ID 可重投                | Banner/Popup    | 同 ID 再下发再操作再上报       | 主路径实测通过                   |
| 明确成功才 confirm，写请求不自动重试        | 全动作          | ledger + 故障/超时 + UI        | 正常路径有；异常跨进程缺口       |
| 导航不切连接/模型、不安装插件/新建任务      | Settings/Market | 当前真实持久字段及命令账本     | 旧字段断言无效风险，不能宣称证明 |
| 资源先校验，迟到结果不恢复旧 UI             | Media/ZIP       | 可控慢资源/坏资源 + Host/DOM   | 单测为主，E2E 不完整             |
| Desktop continuous 与手机 replayable 不扩散 | remote/task     | shared-host/身份路由代表性回归 | 未跑多端，不虚构通过             |
| case 隔离，失败不污染下一 case              | 全 E2E          | 单独与组合运行一致             | 本轮已观察连续污染               |

## Codegraph Evidence

没有可用的 codegraph 工具，本轮未执行索引影响扫描。采用 `git diff`、精确符号/调用方检索与逐段源码阅读；不是完整调用图证明。

| seed                       | 替代查询         | 已确认路径                                         | 深度 | 限制                           |
| -------------------------- | ---------------- | -------------------------------------------------- | ---- | ------------------------------ |
| MarketingTouchProvider     | diff + rg + 源码 | Root/Sidebar → Provider → Controller/服务          | 2    | 未枚举所有运行环境             |
| prepareMarketingHero       | rg + 源码        | Provider → resources → CloudContentService → cache | 3    | 未以 E2E 故障遍历所有安全分支  |
| requestMarketingNavigation | diff + 源码      | Provider → 设置/市场/升级 → finish                 | 2    | 当前 provider 迁移阻塞部分目标 |
| disposeServiceResources    | diff             | Host 服务释放 → CloudContent.dispose               | 2    | 需退出行为验证                 |

## Graph Drift Candidates

| 项目                            | 当前证据                            | 过时关系                          | 后续                                      |
| ------------------------------- | ----------------------------------- | --------------------------------- | ----------------------------------------- |
| start-plan-manual-claim surface | 旧 Banner/ResultDialog 已删除       | graph 仍引用旧文件与 guide 路径   | 用 Marketing surface 替换，不恢复自动选模 |
| cloud-content-preview           | App preview 入口已移除              | graph 仍引用预览组件/旧 mock 文件 | 删除退役入口关系                          |
| 测试证据节点                    | 新 spec 在 pending                  | 旧正式 E2E/旧 Banner 单测引用     | 更新为当前证据并注明 pending              |
| 营销能力关系                    | 当前 Settings/Market/Upgrade 确认链 | 未完整描述新目标与失败恢复        | 补关系，不把 UI 选中等同持久连接          |

## Graph Delta

本轮仅 proposed：新增/修正 Marketing Banner、独立 Popup、结果/失败 Dialog、资源 lease、导航目标确认与上报边；移除已退役 preview/自动 guide 边。依据是当前 diff/源码及用户已确定的 navigate/copy_text 边界。本轮不改 feature graph。

## 95% 度量与实施顺序

1. 分母冻结为 merge-base → 被审计 HEAD 的新增/修改**可执行业务源码行**，含 UI、shared schema、services、client 注册。删除文件另做回归，不计入新行分母。测试、文档、翻译数据、纯类型/声明、构建脚本、外部资源包分开报告。
2. 只收集真实 App E2E 的 Renderer/Host/Main/CLI 数据；不混入 Vitest。各域函数/分支单列，不能把不同 instrumentation 的 statement ID 直接合并。
3. 缺失插桩/source map/进程数据标 unknown，不能当作已覆盖或悄悄移出分母。公共 Lottie 等 Marketing 入口不可达代码要明确列出，不为凑 95% 通过测试内部注入执行业务函数。
4. 先修旧 API 与 case-local fixture/reset，再补 P0 并真实运行；只有每例 setup/action/assertion 成立，才同时登记行为覆盖与执行覆盖。覆盖行被失败测试经过，也不等于功能验收通过。
5. 根据未覆盖行/函数/分支反向补 P1。建议门槛分别为差异行 ≥95%、差异函数 ≥95%、差异分支 ≥95%；分母和不可达边界先确认，未达到的项分别列出，不能只报其中最高的一项。
6. 连续独立/组合复跑，审查截图后再按技能转正，随后接正式 CI。不得为通过而删安全分支、恢复旧产品语义或放宽业务断言。

实施必须先更新 case catalog/coverage matrix，再写失败测试、改实现；本轮没有实施。已知类型错误属于当前候选分支的问题，不作为“与本功能无关的既有错误”略过。

## Unresolved Questions

| 问题               | 可选处理                                        | 范围差异                               | 决策方    |
| ------------------ | ----------------------------------------------- | -------------------------------------- | --------- |
| 审计后是否直接实施 | 先审清单 / 批准 P0/P1 补齐与必要产品修复        | 后者会修改测试和产品，而本轮目前只审计 | 用户      |
| 95% 的最终门槛     | 行/函数/分支均达标，或明确指定其中指标          | 应在实施前固定，不事后缩小分母         | 用户/团队 |
| 跨端实机           | CI Windows/Linux + Web/手机链路，或列明确待验收 | 不能用 macOS 窄布局代替                | 团队      |

## Planning Handoff

impact-only，本轮不修改产品 spec/测试或自动 promotion。后续计划：先协议/隔离/API 阻塞，再 P0 行为与报告，再 P1 与平台验证，最后人工验收/转正。

## 本轮运行证据

### 静态门禁与可定位的问题

| 检查                                         | 本轮结果                                              |
| -------------------------------------------- | ----------------------------------------------------- |
| workspace freshness                          | 通过；新 test 分支没有 upstream                       |
| `pnpm typecheck`                             | 失败，9 处错误，详见下表                              |
| `pnpm --filter @zcode/desktop typecheck:e2e` | 失败，权益 E2E 的 5 处旧 API 错误                     |
| `pnpm lint`                                  | 0 errors / 45 warnings，未修改代码去消除已有 warnings |
| `pnpm architecture:check --changed`          | 0 violations                                          |

| 位置                                                       | 原因与补充验证                                                                                                                         | 源码归属证据                                                          |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| MarketingTouchProvider.tsx:275、278                        | IServiceAccessor 没有 modelProviderService；成功路径的后置刷新调用仍是旧 API。当前领取用例只断言成功弹窗，没有验证刷新执行             | `git blame`：`fe04f4ba330`；本分支新增文件                  |
| Root.tsx:3、357                                            | 移除了 RefreshCw import，但加载失败重试 UI 仍引用它。正常启动不会触发该 error 分支，应补故障注入回归                                   | `a19b8c64f11` 移除 import；基线 diff 可见                   |
| ModelProviderSection.tsx:1121                              | 新导航匹配读取 item.provider.id；当前 ProviderSettingsFormProvider 是 providerId。不能只更换测试 selector 掩盖自定义 provider 路径缺陷 | `646cba8528f`；本分支新增 effect                            |
| marketing-touch-entitlement.test.ts:94、100、131、163、164 | bigmodelCodingPlan/bigmodel 枚举与 modelProviderFamilyModes/SelectedKeys 已不存在                                                      | 本分支新增迁移 spec；当前类型检查复现，不推测迁移责任                 |
| marketing-touch-delivery.test.ts:35–42、393                | 连接无副作用检查读取已删的两字段。当前应使用 providerFamilyConnectionSelections，并先断言有效初始选择存在                              | plain JSON 读取绕过 TS 检查；源码事实，不能宣称本轮实际进入该断言通过 |

本轮不对这些问题实施修复；它们需要在补测试时处理，而不是作为无关错误放行。

### 实际 E2E

所有运行均为隔离 fixture，不领取线上套餐、不执行支付。第一次构建设置 `ZCODE_E2E_COVERAGE=1`，后续复用同一覆盖率构建。

| Run ID（`packages/desktop/.e2e-artifacts/` 下） | 范围                                         | 结果            | 解释                                                                                                        |
| ----------------------------------------------- | -------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------- |
| `desktop-e2e-20260911-170338-218`               | delivery + entitlement 完整 17 个用例        | 9 通过 / 8 失败 | MTA-05 首次失败；后 6 个 delivery 被旧弹窗污染；entitlement 报“模型供应商设置没有 BigModel 导航项: missing” |
| `desktop-e2e-20260911-171040-787`               | 保留必要前置，跳过模型定位，9 个用例         | 4 通过 / 5 失败 | MTA-06 单独通过，证明首轮此失败是污染；MTA-07 本轮仍等待事件数超时（35s），后面 4 个又受残留遮挡            |
| `desktop-e2e-20260911-171255-869`               | 保留必要前置，跳过模型定位与升级页，7 个用例 | 7/7 通过        | ZIP Banner、失败 Dialog、Markdown/HTML、MP4 Banner 可以通过；不是整套通过                                   |

三轮去重后：17 个既有测试中 14 个至少通过一次，3 个仍未通过（模型定位、升级确认、权益连接）。**14/17 是用例执行结果，不是代码覆盖率。** 不把隔离通过替代全套稳定性验收，三轮没有改测试或产品代码。第三轮日志为 `/tmp/zcode-marketing-e2e-audit-assets.log`。

升级页用例失败的精确范围：容器显示断言已经通过，但没有在 35s 内满足预期 action 事件数。尚未证明是 webview ready、fixture 时序还是产品确认逻辑根因；不能直接归为支付/网络服务端问题。应为 ready/失败/超时分别建可控 fixture 并保留请求关联日志。

原始证据为各 run 的 `summary.md`、`test-results.ndjson`、`coverage/` 和 runtime logs。CLI 文本日志在 `/tmp/zcode-marketing-e2e-audit.log`、`/tmp/zcode-marketing-e2e-audit-isolated.log`；类型、Lint、架构日志分别为 `/tmp/zcode-marketing-audit-{typecheck,e2e-types,lint,architecture}.log`。这些本地产物没有加入 Git，不包含在报告公开数据中。

复跑命令：

```sh
ZCODE_E2E_COVERAGE=1 ZCODE_E2E_MANUAL_REVIEW=1 \
pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts \
  --spec './test/e2e/ui-shell/manual-review/pending/marketing-touch-delivery.test.ts' \
  --spec './test/e2e/ui-shell/manual-review/pending/marketing-touch-entitlement.test.ts'
```

### 覆盖率完整性

首轮 Renderer report complete；Main/Host/CLI 报告均 complete、missing process=0。但这只证明收集到了预期进程，不等于所有源码映射都足够精确。

| 首轮差异范围    | 行                 | 函数             | 分支             | 使用限制                                                     |
| --------------- | ------------------ | ---------------- | ---------------- | ------------------------------------------------------------ |
| 已映射 Renderer | 583/896 = 65.07%   | 148/223 = 66.37% | 479/883 = 54.25% | 包括失败用例经过的代码；不等于这些行为验收通过               |
| Host 原始映射   | 969/1068 = 90.73%  | 37/39 = 94.87%   | 94/175 = 53.71%  | V8 按行映射包括空白/类型等，不能直接当统一可执行行分母       |
| Main 原始映射   | 1041/1068 = 97.47% | 0/0              | 0/0              | 部分服务文件整段有 hit 却无函数/分支，禁止用于补足 Host 缺口 |

例如 contentBundleCache.ts 在 Main 报告中 318 个源代码行均有 hit，但函数、分支记录均为 0；Host 才有 16 个函数和 79 个分支记录。简单对不同域按行 OR，会得到虚高的全链路百分比，本报告不采用该合并结果。需要先校验源映射与运行域所有权，再统一可执行行基线。

另外，新增 manualClaimFailureMessage.ts 已无生产调用方，也没有进入 Renderer 插桩产物；单独使用相同 TypeScript/JSX Istanbul parser 得到 16 个可执行行、1 函数、16 分支，均没有 E2E 执行证据。不能因为文件未打包就静默移出分母。accessor.ts、services/index.ts、cloudContentDialogTypes.ts 的缺映射已用 parser 核实为 0 可执行 statement（类型/转导出），不与该遗留业务函数混为一谈。

Lottie runtime 36 个已映射行首轮 0 hit，Marketing 协议没有 Lottie 投放入口；应先决定公共组件回归入口或确认退休范围，不通过测试直接调用内部函数凑数。CSS 与 ZIP 中 HTML/JS 不在当前 TS/JS 插桩指标里，由渲染与独立资源验收另列。

当前不能给出可信的“全分支 E2E ≥95%”结论。达标前置不仅是增加测试，还包括修复测试隔离、旧 API、不可达遗留代码范围以及跨域覆盖率口径。

### 三轮同构建 Renderer 合并结果

后两轮设置 `ZCODE_E2E_SKIP_BUILD=1 ZCODE_E2E_SKIP_AGENT_BUILD=1`，保持与首轮相同源码及 instrumentation。只对这三轮 Renderer 的 `coverage/coverage-final.json` 使用 Istanbul merge；不混合 Host/Main，也不合入任何单测结果。

计算方法：`git diff --unified=0 <merge-base> d0028042fe -- <file>` 提取新侧变更行，与 `getLineCoverage()` 相交；函数按声明起始行、分支按 branchMap.line（或 loc.start.line）是否在差异中选取，并保留每个分支出口计数。因此函数/分支数字是差异节点口径，不是“所在函数任意一行变更就把整个函数算进来”。字段被删除或 JSX/导入没有单独 statement 时仍须行为回归，不能因指标 0/0 免验。

| 指标     | 已执行/已映射差异分母 | 覆盖率     | 仅当前已映射分母达到 95% 至少还需命中 |
| -------- | --------------------- | ---------- | ------------------------------------- |
| 行       | 653/896               | **72.88%** | 199 行                                |
| 函数     | 164/223               | **73.54%** | 48 个函数                             |
| 分支出口 | 546/883               | **61.83%** | 293 个出口                            |

这些是执行覆盖上界证据，含失败流程实际经过的代码；不代表对应断言通过，也不覆盖未打包的 16 行旧失败文案函数。将该文件零命中补入分母后，行/函数/分支分别为 653/912、164/224、546/899，只会更低。表中的缺口数量也不是新增用例数量，不承诺固定数量测试即可达标。

计算脚本与详细临时数据：`/tmp/zcode-marketing-diff-coverage.cjs`、`/tmp/zcode-marketing-diff-coverage-union.json`。原始持久证据见三个 run 的 coverage JSON；脚本只读取 Git/coverage，没有调用产品函数。临时 JSON 的跨域按行合计未通过上文口径审查，**不得作为验收百分比**，本报告仅采用 `domains.renderer` 的单域结果。

逐文件映射结果（路径前缀 `packages/ui/src/`；0/0 表示没有相应差异节点，不表示功能免验）：

| 文件                                                         | 行      | 函数  | 分支出口 |
| ------------------------------------------------------------ | ------- | ----- | -------- |
| `Root.tsx`                                                   | 0/0     | 0/0   | 0/0      |
| `SettingsPage.tsx`                                           | 8/9     | 3/3   | 8/10     |
| `WorkspaceSidebar.tsx`                                       | 1/1     | 1/1   | 0/0      |
| `components/cloud-content-dialog/CloudContentDialog.tsx`     | 42/48   | 12/15 | 52/71    |
| `components/cloud-content-dialog/CloudDialogDescription.tsx` | 25/39   | 6/9   | 34/58    |
| `components/cloud-content-dialog/CloudDialogHero.tsx`        | 59/72   | 23/26 | 37/63    |
| `components/cloud-content-dialog/CloudDialogMediaHero.tsx`   | 12/70   | 4/21  | 12/59    |
| `components/cloud-content-dialog/cloudDescriptionStyle.ts`   | 34/38   | 4/5   | 40/62    |
| `components/cloud-content-dialog/cloudLottieRuntime.ts`      | 0/36    | 0/3   | 0/43     |
| `components/cloud-content-dialog/useCloudHeroEnvironment.ts` | 14/14   | 5/6   | 3/7      |
| `components/marketing-touch/MarketingBanner.tsx`             | 6/6     | 3/3   | 20/24    |
| `components/marketing-touch/MarketingDialogs.tsx`            | 22/25   | 8/10  | 27/28    |
| `components/marketing-touch/MarketingFailureDialog.tsx`      | 1/2     | 1/2   | 0/2      |
| `components/marketing-touch/MarketingTouchProvider.tsx`      | 136/158 | 33/38 | 92/122   |
| `components/marketing-touch/marketingPopupAdapter.ts`        | 12/13   | 3/4   | 21/24    |
| `components/marketing-touch/marketingResources.ts`           | 52/78   | 13/19 | 22/59    |
| `components/marketing-touch/marketingTouchController.ts`     | 125/158 | 19/22 | 108/150  |
| `components/marketing-touch/marketingTouchPoller.ts`         | 21/32   | 6/9   | 11/20    |
| `lib/marketingNavigation.ts`                                 | 30/31   | 7/10  | 8/12     |
| `settings/CodingPlanEmbeddedWebviewDialog.tsx`               | 3/5     | 0/0   | 0/0      |
| `settings/CodingPlanUpgradeDialog.tsx`                       | 0/0     | 1/1   | 0/0      |
| `settings/CodingPlanUpgradeDialogProvider.tsx`               | 19/23   | 4/8   | 7/16     |
| `settings/ModelProviderSection.tsx`                          | 13/18   | 4/4   | 15/20    |
| `settings/PluginStorePage.tsx`                               | 18/20   | 4/4   | 29/33    |
