# Todo129：Provider 埋点适配与 Team 套餐识别修复

> 状态：**本地实现、定向验证与 review 完成；真实 Electron/手机验收待整批执行**。2026-09-11 Goal 授权后完成：Team 分类、BigModel 标签、事件构造边界恢复旧统计 ID。报表、真实身份与历史数据未改。原规划中的“待补”由下方执行记录更新，不代表已经完成真实上线验收。
>
> 用户已确认：Coding Plan 的本轮套餐识别统一包含 Individual 与 Team；顺便修复首页闲时入口对 Team 的误拦。除此之外，改动限定在埋点适配，不动 Provider 核心与持久化。

> 最新要求：能够从旧代码和当前已有事实确定的映射直接实施；尽力对齐各事件原来真实发出的值，不为了新身份更漂亮而保留可避免的报表断层。无法可靠还原的少数项保留真实 ID、记录差异及原因，不伪造组织／项目身份，不阻塞其他项，也不把残余差异说成完全兼容。
>
> 关联：[Todo128 启动契约与闲时资格刷新](./todo-128-provider-start-contract-and-offpeak-eligibility.md)。本 Todo 修“最新状态也漏认 Team”，Todo128 修“状态读旧、刷新与乱序覆盖”，两者不相互替代。

## 1. 背景、核查事实与证据边界

### 2026-09-11 执行与复审

- 对照旧 staging `790884b1ce`，落实 §3 的十个精确 ID 映射；Team 与个人共用旧 Coding Plan 桶有旧模型选项／连接解析代码依据；UUID、未知、已经旧 ID 均保留。只在 UI 事件构造层引用纯映射，不向 Registry、请求或持久化回流。
- T119-01～05：两家 Team-only/无权益、已有 Start/null 混合分类、成功事件真实 builder、升级一次上报与 WebView bootstrap 共用冻结上下文；单测覆盖。BigModel Team/Start 标签已补齐。
- T119-06～07：新增真实 `OffPeakNewTaskEntry` 浏览器用例（不是 helper 替身），两家 Team-only 可产生创建草稿并导航，no-plan/明确 inactive/灰度关闭/dismiss 仍拦截。服务使用受控 fixture，不申请真实 Ticket；下游资格保护沿用 Todo128 的测试。
- T119-08～11：发送/压缩/自动化/闲时 builder 和真实报告调用；V4 Supervisor 两套新旧身份同事实序列，逐字段成对比较换模后 step/completion（仅排除随机 step_id），重复终态不重复上报。前台子任务使用独立实际身份，token 归因不混入主模型；原始 fact 冻结不改。
- T119-12：已有 Supervisor 与 attachment 隔离、历史不补报、远程作用域测试纳入合批；真实 Electron/手机/SSH 仍待最终验收，不以浏览器 fixture 代替。
- 失败先复现：15 个针对性断言失败；修复后扩展至 11 文件 229 用例。旧闲时期望值 3 处按已裁决的旧桶更新，未弱化事件数量和 payload 断言。证据 `/tmp/provider129-{red,final-unit,boundary,browser}.log`，最终合批补跑见执行账本。
- 根 typecheck、lint（0 errors / 42 warnings）、architecture（0 violations）通过。首页浏览器用例通过；官网真实购买网络事件未请求、不污染生产报表。
- Review：没有新增业务状态、缓存、轮询或报告字段；hostname 先按真实 Provider 读取，映射不影响查询。实际业务 ID/模型/登录事件、Personal 配置、Core、协议与数据迁移无改动。未发现本地要求遗漏；真实端限制保留。

详细影响与案例：[Todo129 实施边界](./todo-129-impact-and-cases.md)。

同事反馈 Provider 重构可能破坏报表：新的 Provider ID 进入旧事件维度，Team 拆分后部分漏斗和成功事件分类遗漏。用户要求按同事列出的上下文调查，不扩大到索取报表 SQL 或另查全部监控系统。

2026-09-11 已核对 fetch 后的 `origin/staging = 7a01923f58`。相关合并点为 `279907140b`、`beb9751d9f`；旧分支 tip `a0b07bc685` 已是远端祖先。历史基线取 `279907140b` 的第一父提交，不把重构中的中间提交当作旧版对外契约。

本地 `HEAD = 6454504b90`；新鲜度检查提示落后远端 5 个提交，本地另有 7 个文档提交，不能直接 fast-forward。本轮仅记录规划，没有 merge/rebase；已比较相关埋点、分类与入口实现，本地和远端一致。实施时必须重新检查并对齐开发基线，不能把本记录当作跳过检查的许可。

### 1.1 已确认的问题

| 项目                 | 当前事实                                                                                                                                    | 影响                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 核心事件维度         | `send_btn` 用 `custom:<编码后的 providerId>:<model>`；completion/step 正常请求路径用 `<providerId>/<model>`；`model_provider` 都用实际新 ID | 固定旧 ID 过滤会漏新版数据，直接分组会拆成新旧组；不等于事件未发送                                              |
| Team 入口套餐状态    | `resolveCodingPlanEntryPlanStateFromProviderSettings()` 只找 Individual，再找 Start，漏两家 Team                                            | Team-only 返回 `no_plan`；若另有 Start 可能返回 `start_plan`。旧 Registry helper 已识别两家 Team connection key |
| BigModel Team family | `resolveCodingPlanProviderFamily()` 缺 Team 分支                                                                                            | `unknown` 和空 channel，正确应为 `bigmodel` / `MaaS`；Z.ai Team 正常                                            |
| 成功事件标签         | `resolveProviderTelemetryLabel()` 缺 BigModel Team / Start                                                                                  | `add_model_success` 直接带原始 ID；Start 旧版已有遗漏，Team 是新增暴露面                                        |
| 首页闲时模板         | `OffPeakNewTaskEntry` 用同一套餐状态 helper 作点击准入                                                                                      | `codingPlanActive` 未明确给定且 view 已加载时，Team-only 被错误阻止导航                                         |

### 1.2 实际验证与限制

- 调用了仓库真实 helper：两家 Team-only 均得到 `no_plan`；BigModel Team family/channel 为 `unknown` / 空字符串；BigModel Team/Start label 为原始 ID。
- BigModel Start + GLM-5.2，同一个 baseURL：旧 `send_btn.model_name` 为 `custom:builtin%3Abigmodel-start-plan:GLM-5.2`，新为 `custom:account%3Abigmodel-start-plan:GLM-5.2`；`provider_name` 都为 `zcode.z.ai`。
- 6 个现有测试文件合计 **82 个用例通过**：codingPlanFunnelTelemetry、messageTelemetry、automationTelemetry、offPeakTelemetry、codingPlanEmbeddedWebview、shared/zcodeNetworkDebugStatus。现有通过结果没有覆盖本次遗漏，不是修复验收。
- WebView bootstrap 确实携带错误漏斗上下文；官网协议约定四个 purchase 事件使用该上下文。本轮没有抓取官网真实购买上报，不能写成四个线上事件都已实测错误。
- `entry_plan_status` 与核心事件的 `plan_status / plan_product_id` 是两条来源；后者 `usePlanIdentitySnapshot` 已选择 Team Provider 查询，不顺手重构。
- hostname 依赖地址可得性；completion/step 缺少请求开始 fact 时可能沿用 seed，不承诺所有事件都来自实际请求。
- 没有向真实 `/event/report` 发送验证事件，没有修改真实账户或创建任务。

## 2. 已确认边界与非目标

1. 修复两家 Team 的套餐识别；对本轮“是否有 Coding Plan”的判断，Individual 和 Team 同属 Coding Plan。Start 仍独立，不能把所有 account Provider 或 Off-Peak 当成 Coding Plan。
2. 保持 `access.type === "zhipu-account" && entitled === true` 的事实门槛；用户关闭模型/Provider 不等于退订。不改 Account 对 entitled 的计算、凭据状态和套餐查询。
3. 修复首页闲时模板的误拦，但保留灰度、关闭入口、表单资格、当前连接、凭据、额度与提交校验。明确 `codingPlanActive=false` 仍按现有门控阻止；不为了 Team 绕开灰度。
4. family/channel 与成功事件 label 补齐 BigModel；两家行为对称，名称仍遵守各事件已有值，不统一改成一种标签。
5. ID 兼容只允许作用于既有埋点输出；不倒改 Registry、ModelSelection、CLI 实际请求事实、鉴权身份、配置文件、数据库、历史消息或迁移脚本。
6. 不新增埋点事件/重复发送新旧事件，不擅自增加报表字段，不改 token、耗时、成功率公式、事件触发与去重机制。不扩大到 ARMS 全面改造。
7. **旧 `zcodeTaskNetworkDebugStatusFromPayload` parser 不并入本 Todo**。它的顶层身份适配属于旧投影链路问题；当前 V4 核心埋点有独立转换。只保留发现，不以“顺手修”夹带修改。
8. Todo128 的 start/Registry 通知/资格刷新/并发协调独立执行；不改 Composer，也不借本轮抽取一套新的通用套餐服务或建立另一份权益缓存。
9. 本轮只落盘。不能把“写一个 Todo”当作开始改产品代码的授权。

## 3. 第一层：统计 ID 兼容方案

### 3.1 推荐放置边界

在 **App 侧各事件字段构造的边界**复用一个小型纯转换函数，输入真实 Provider 身份及该事件已有的必要事实，输出经旧版核对的统计 ID。实际请求／选择事实保持原样，不在转换函数内查询账号或读取可变全局状态。具体文件和导出在实施时按架构门禁与实际引用确定；不把全局 `/event/report` 传输层变成猜测任意字符串内容的替换器。

```text
真实 ModelSelection / CLI 请求事实
                 |
       事件字段构造边界
                 |
       已裁决的统计 ID 映射（纯函数）
                 |
       保留该事件既有 model_name 编码方式
                 |
             /event/report

映射结果不得回流到 Registry、模型选择、请求、持久化或鉴权
```

映射必须针对 Provider 身份部分：先取得结构化的 provider/model，再按事件编码；不能在整个 `model_name` 中正则替换 `account:`、`builtin:`，不能改动模型 ID 内的 `/`、`:` 或百分号。不凭 hostname、显示名称或用户选中的其他账户猜 Provider。

### 3.2 旧口径对照表与实施核实

**最终采用埋点侧恢复旧值，报表、SQL、数仓及历史上报数据均不改。** 以下为核对起点，不代替旧版真实事件输出证据。实施时以本次重构前的旧 staging 为对照，记录具体提交和逐事件输入／输出；按证据直接落实能还原的映射，尤其核对 Team，不把“最大努力”缩成只修个人套餐。

| 当前真实 ID                                              | 可核对的旧身份/候选输出                                          | 状态                                                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `zai-api` / `bigmodel-api` 相关历史身份                  | `builtin:zai` / `builtin:bigmodel`                               | 核实旧事件与实例来源后恢复；模板 ID 不等于当前实例 ID，不能把所有模板创建的 UUID 实例强行并入旧内置桶 |
| `account:zai-individual-coding-plan`                     | `builtin:zai-coding-plan`                                        | 候选恢复旧统计值                                                                                      |
| `account:bigmodel-individual-coding-plan`                | `builtin:bigmodel-coding-plan`                                   | 候选恢复旧统计值                                                                                      |
| `account:zai-start-plan` / `account:bigmodel-start-plan` | 对应 `builtin:*-start-plan`                                      | 候选恢复旧统计值                                                                                      |
| 两家 `account:*-team-coding-plan`                        | 旧链路包含套餐连接 key 与旧 Coding Plan 身份；按事件分别查旧输出 | 优先还原旧真实口径；旧事件确实共用 Coding Plan 桶则沿用，不能无依据冒充 Individual 或编造旧 key       |
| 两家 `account:*-offpeak-idle-plan`                       | 旧共同值 `offpeak-idle-plan`                                     | 旧事件确实共用此值则恢复原桶，不为新 family 区分改变旧报表口径                                        |
| 自定义 Provider / 未知 ID / 已是旧 ID                    | 原样保留                                                         | 保护约束；不可按名称或地址误归官方                                                                    |

恢复旧口径可能将新版本拆开的统计身份重新聚合，这是本次过渡目标，不要求维护新分桶。Team 若旧事件依赖连接身份，只能使用该事件已有且可信的对应事实；不能拿当前 UI 的其他连接补历史请求，不能为统计新增敏感身份查询、协议或持久化。确实无法还原时原样保留并列出残余项，只有必须改变产品语义或超出局部适配范围时才另提裁决。

不要求给报表侧新增交付，不建设通用兼容框架，不重复发送新旧事件。成对构造旧版／新版事件证明兼容程度；不能只看 helper 返回一个旧 ID 就宣布报表口径已经全部恢复。

### 3.3 每种事件保持自己的字段语义

| 事件                                                 | model_provider          | model_name                                             | provider_name / 其他                                             |
| ---------------------------------------------------- | ----------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| `send_btn`                                           | 使用经旧版核对的统计 ID | `custom:<编码后的统计 ID>:<model>`                     | 保持发送时 UI 地址 hostname；地址缺失不新造值                    |
| `message_completion` / `agent_step`                  | 使用经旧版核对的统计 ID | 正常请求 `<统计 ID>/<model>`；保留无请求事实的既有回退 | 仍来自对应实际请求；不能拿修复后的统计 ID 去查 Registry          |
| `context_compaction`                                 | 同上                    | 保持既有 Provider 前缀规则                             | 不新增 provider_name                                             |
| `automation_create_result` / `automation_run_now_ck` | 同上                    | 保持纯模型 ID                                          | 保持 standard-personal、无模板、API-key 才取 hostname 的现有规则 |
| `off_peak_task_create_result`                        | 按闲时行已裁决映射      | 保持纯模型 ID                                          | 保持结果对象提供的 provider_name                                 |
| `app_login_success`                                  | 不适用                  | 不适用                                                 | 不改 OAuth `login_provider`，继续 `z.ai` / `bigmodel`            |

ID 适配不得改变事件关联和计数：send 仍是提交选择快照，step/completion 仍按实际请求事实更新；多个请求或步骤中换模型不能被首个/当前 UI 选择覆盖。多个 Workspace、后台/前台和重连的既有采集规则不变。

## 4. 第二层：套餐识别、漏斗与首页准入

### 4.1 套餐识别

在 `resolveCodingPlanEntryPlanStateFromProviderSettings()` 中补齐两家 Team ID，保持简单显式判断或复用语义准确的现有 helper。**不要直接使用含 Start 的宽泛 isCodingPlan helper** 把 Start 误分成 Coding Plan。

```text
ProviderSettingsView 尚未就绪 → unknown（沿用原逻辑）
             |
             v
筛选 zhipu-account 且 entitled=true
             |
存在任一家 Individual 或 Team？ ──是──> coding_plan
             |
             否
             v
存在 Start？ ──是──> start_plan
             |
             否
             v
           no_plan
```

不新增套餐等级推断。原 helper 拿不到真实 level 时仍为空；已有入口直接从 Usage snapshot 取得的 level 保留，不能因修 Team 统一清空。`entry_plan_list` 的权威查询、冻结时机和内容不改。

### 4.2 family/channel 与成功标签

- `resolveCodingPlanProviderFamily()`：BigModel Team 返回 `bigmodel`，对应 channel `MaaS`；Z.ai Team 保持 `zai` / `Z_AI`。
- `resolveProviderTelemetryLabel()`：BigModel Individual / Team / Start 都返回 `bigmodel`；Z.ai 对应值仍为 `z.ai`。未知 ID 保持原值。
- 不为了统一函数而混淆 `provider_family=zai`、成功标签 `z.ai` 与 hostname `api.z.ai`。
- 沿实际调用检查设置套餐卡、团队入口、Composer/侧栏升级、闲时资格提示；它们的 entry state 来源与 purchase audience 不完全一样，只改错误归因，不重设为统一入口。
- `coding_plan_upgrade_ck` 与 WebView bootstrap 应来自同一个 funnelContext，确保 family/channel/status 一致；不重生成 funnel ID，不改购买产品、周期、金额等网站字段。
- 四个官网 purchase 事件仅验证 App 注入契约和可获得的运行证据，不默认扩大到官网仓库改动。

### 4.3 首页闲时入口

`OffPeakNewTaskEntry` 继续消费同一个修正后的事实，不在组件另加 `providerId.includes("team")` 兜底。

```text
两家 Team entitled=true + 灰度允许
          |
修正后的套餐识别 coding_plan
          |
点击首页闲时模板 → 正常进入创建页
          |
表单/Host 原有当前连接、凭据、资格、额度检查
          |
仅全部满足才允许创建与执行
```

“统一包含 Team”不等于给任意团队账户发放权益，也不等于持有另一个 family 的 Team 就能替换当前连接。只修当前已确认的漏识别，保留后续精确鉴权。

## 5. 影响面、数据源与代码入口

| 优先级         | 场景/入口                             | 共享实现与权威来源                                                                                                                       | 本轮改动边界                                                    |
| -------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| must-inspect   | Composer 发送、completion、step、压缩 | `v4/telemetry/conversationPromptTelemetry.ts`、`conversationTelemetrySupervisor.ts`、`lib/messageTelemetry.ts`；选择快照与 CLI live fact | 只改字段构造的统计身份，不改 normalized fact 协议或事件生命周期 |
| must-inspect   | 设置、侧栏、Composer、闲时的升级入口  | `lib/codingPlanFunnelTelemetry.ts`；各入口已有 settings/usage 快照                                                                       | Team 分类、family/channel                                       |
| must-inspect   | 官网购买面板                          | `settings/model-provider-section/codingPlanEmbeddedWebview.ts`；已冻结 funnelContext                                                     | 验证注入值，不新增 WebView 状态 owner                           |
| must-inspect   | 首页闲时模板                          | `v4/OffPeakNewTaskEntry.tsx`；gray config + settings view                                                                                | 修复 Team 误拦，提交规则不改                                    |
| must-inspect   | Provider 订阅成功反馈                 | `lib/appTelemetry.ts`、`settings/model-provider-section/oauthActions.ts`                                                                 | 成功标签归一                                                    |
| should-inspect | 自动化/闲时创建与立即运行             | `lib/automationTelemetry.ts`、`lib/offPeakTelemetry.ts`、`settings/AutomationsSection.tsx`；提交快照                                     | 按裁决适配 provider 字段，保持纯模型名                          |
| invariant-only | 登录、核心事件套餐快照                | `root/useRootOAuthEffects.ts`、`hooks/usePlanIdentitySnapshot.ts`                                                                        | 回归不变；不修改登录流程或另查套餐                              |
| invariant-only | 实际请求、Service 上报、跨端同步      | CLI fact producer、`services/src/telemetry/telemetryCore.ts`                                                                             | 请求用真实 ID，上报不增加 IO/全局字符串替换；不动 shared-host   |
| excluded       | 旧网络状态投影                        | shared parser、旧 Service/UI projection                                                                                                  | 独立问题，本轮不修                                              |

以上 UI 路径相对 `packages/ui/src/`。架构实现位置以实施时门禁结果为准，不为兼容小表增加跨域依赖。

当前没有可用 codegraph 工具，已用 rg、Git 历史和实际函数执行核查一至两跳调用链；不声称完成 codegraph 扫描。影响面层级为埋点输出 commit-effect 与首页 validation，不涉及 persistence/recovery。图谱补充候选为“漏斗状态 helper 同时供首页闲时准入使用”；本轮只落盘 Todo，不改正式系统事实或扩展架构治理。

## 6. 实施顺序与验收用例

### 6.1 分步执行

1. 重新检查基线与调用引用；本 Todo 先作为 Working Memory 中的 NL 设计依据。实现稳定后再同步正式埋点文档，不提前把候选统计口径写成已生效事实。
2. **先补测试，再修明确的分类遗漏**：两家 Team 套餐识别、BigModel family/channel、成功标签；首页通过共享函数自然修复。附中文原因注释。
3. 跑隔离入口 E2E，验证 Team 正常导航且保留无权益/灰度/提交门禁。不把 Todo128 尚未修复的旧快照问题混入本轮成功结论。
4. 按第 3.2 节对照旧版逐事件核实映射，先补成对输出测试再实施埋点侧适配；可确定项直接推进，少数无法还原项留差异记录，不等待报表侧修改。
5. 核对完整上报 payload 与 WebView bootstrap，不仅测纯 helper；最后执行架构、类型、Lint、受影响单测和必要 E2E。
6. 回填修改文件、真实结果、未验证项和提交信息。三处分类修复完成不等于统计兼容子项完成，不把该 Todo 提前关闭。

### 6.2 维度与裁剪

主维度仅取：family（Z.ai/BigModel）、套餐（Individual/Team/Start/无权益）、入口（首页/设置/其他漏斗/事件构造）、身份（旧/新/自定义/未知）、事实来源（发送 seed/真实请求）、端（桌面本地/远程工作区/手机）。

- accepted：两家 Team 识别、归因、现有权限边界，以及在埋点侧最大努力恢复旧口径的成对事件验证。
- evidence-pending：第 3.2 节逐事件精确旧值；从旧版输出确定测试预期，不能按新实现倒填。恢复方向已确认，普通事实核实不再作为待用户裁决。
- pruned：所有 OS × 主题 × 套餐 × 事件的全组合。纯字段映射用参数化单测；代表性交互覆盖桌面与手机既有入口，不为无布局改动重复排列主题。
- excluded：旧 parser、Todo128 时序修复、后台网站实现、历史回填、新 schema、产品请求路径改造。

### 6.3 接受的场景与验证层

| Case ID | Setup → Action                                                                         | 必须断言                                                                       | 证据层/状态                             |
| ------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------- |
| T119-01 | 两家分别仅有 Team，entitled=true → 读取入口套餐状态                                    | `coding_plan`，不需要伪造 Individual 权益                                      | 参数化单测，待补                        |
| T119-02 | Individual/Team + Start 混合 → 分类；只有 Start/无权益/null view → 分类                | Coding Plan 优先；其余分别 start_plan/no_plan/unknown；关闭模型不否定 entitled | 单测，待补                              |
| T119-03 | 两家 Individual/Team/Start 与未知 ID → 创建漏斗上下文                                  | family/channel 正确，Start 仍独立；未知保持未知，不按名字猜                    | 单测，待补                              |
| T119-04 | BigModel Team/Start 成功 → 真实 add_model_success builder                              | label=bigmodel；Z.ai=z.ai；登录事件值/次数不变                                 | 事件构造/调用测试，待补                 |
| T119-05 | Team 入口创建同一 funnelContext → App upgrade 与 WebView bootstrap                     | 相同 funnel ID、status/family/channel；audience、level/list 原值保留           | builder + WebView 注入测试，待补        |
| T119-06 | 两家 Team-only，页面 view 已就绪且灰度允许、codingPlanActive 未给定 → 点击首页闲时模板 | 进入创建页，不弹“没有 Coding Plan”；捕获当前 settings/路由事实                 | APP E2E，待补，不能只调用 helper        |
| T119-07 | 无权益或 codingPlanActive=false → 同入口点击；后续提交资格失败                         | 保持禁止/提示；有 Team 不绕过后续当前连接、凭据、额度检查                      | 单测 + 代表性 APP E2E，待补             |
| T119-08 | 经旧版核对的官方映射、已有旧 ID、自定义/未知 ID、含特殊字符模型 → 逐类构造事件         | provider 与 model_name 的身份一致，编码正确，未知原样；实际 model ID 不变      | 单测，旧版对照预期实施时补齐            |
| T119-09 | 发送 seed → 模型请求开始 → step/完成；再测多请求与无请求早失败                         | send 保持选择快照；运行事件用对应请求；缺 fact 保留既有回退，不增加/丢失事件   | V4 telemetry 集成测试，旧版对照预期待补 |
| T119-10 | 自动化/闲时创建成功和失败、立即运行、压缩 → 捕获 payload                               | 纯模型名/前缀规则各自保持；失败同样适配；hostname 的现有填充条件不变           | 事件 builder/调用测试，旧版对照预期待补 |
| T119-11 | 使用测试 reporter 完成一轮代表性对话与一次漏斗打开                                     | 最终 eventExtraDetail 正确且只上报一次；不向生产端点发送探针                   | 截获 transport 的集成/E2E，待补         |
| T119-12 | 桌面远程 workspace、手机已有入口、历史恢复/重连                                        | 不跨 workspace 污染身份，不新增手机实际遥测请求，不从恢复历史补发              | 现有隔离测试 + 定向跨端复核，待执行     |

正式回归用例首先覆盖当前会失败的场景，不能仅沿用“82 项通过”。表中“待补/待执行”不表示现有测试已经提供证明。

### 6.4 E2E 交接与运行证据

- 先读 `DESIGN.md`（若改 UI 组件）、`e2e-case-lifecycle` 及当前 conversation case/coverage 工作流，再增补对应场景；不直接将 pending 用例当正式已验收。
- 复用 `off-peak-create-manage.test.ts`、`off-peak-limit-pre-gate.test.ts` 和现有 telemetry parity / Team Plan 场景的基础设施；实施前核对其实际覆盖，不以文件名判通过。
- Provider fixture 用明确的 family、Team-only、entitled、gray config；不读取真实凭据。页面视图应在点击前由正常服务/Store 路径就绪，不把人工设置 helper 返回值当 UI 验证。
- 同步等待用可观察的就绪/路由/事件条件，不新增固定 sleep。复现误拦时捕获脱敏的 settings 条件、页面行为与 reporter 调用；UI 日志走现有 logger。
- 验证 transport 时注入测试 sink/拦截器，避免污染生产报表。官网只能验证 bootstrap 时，明确保留实际 purchase 网络事件未验证的限制。
- 新用例回填相关目录的 case catalog、coverage matrix；本 Todo 的 T119 ID 作为需求追溯来源。具体 Docker preset 按现有 E2E workflow 选择，不凭空创建测试预设。
- 桌面保持 continuous；手机保持 replayable/shared-host，继续沿用既有不上报规则。不为报表启动第二套 Agent/Host，不改 owner、队列或 workspaceIdentity。

## 7. 完成标准、风险与回退

- 已最大努力恢复可由旧版及当前已有事实确定的映射并逐事件验证；只修分类不算完成埋点适配。无法还原的少数项必须明确列出旧值、现值、缺失事实和保留理由，不假称所有报表已完全兼容。
- Team-only 既得到正确报表分类，又能通过首页原本应允许的入口；无权益及明确灰度禁止仍不能通过。
- BigModel Team family/channel 与两家成功标签符合现有事件契约；下游 bootstrap 值一致。
- 已验证实际 Provider ID、模型请求身份、选择和持久化未被统计映射污染。
- 不引入重复上报、历史补报、额外权限或新文件/字段/表；旧 parser 不夹带修改。
- 实施按仓库要求跑 `pnpm architecture:check --changed`、`pnpm typecheck`、`pnpm lint`、受影响单测与必要 E2E；无法验证的真实端或官网范围如实留账。

主要风险是**统计口径误合并或适配不全**，不是存储迁移。使用同一个 Provider ID 的事件必须按各自语义验证，不能把 hostname 与 family/Provider ID 混为一谈。修复仅影响新产生的事件，不承诺修正已经进入数仓的新 ID 数据；历史数据是否归一属单独消费侧工作。

建议分类修复与 ID 适配形成可独立审查的提交。必要时可单独撤回埋点映射，保留 Team 正确识别；无需恢复旧配置或跑数据库迁移。统计回退本身也会影响之后的维度值，发布记录必须说明版本边界。

## 8. 本轮交付

- 已完成：调查上下文、用户裁决、具体实现边界、候选映射、调用影响面与 T119 验证计划落盘。
- 最新完成：用户确认报表侧不动、埋点侧最大努力恢复旧 ID，方向裁决已收口。
- 未完成：逐事件旧口径核实、正式测试和任何产品实现/运行验收；未改报表、旧 parser、Todo128 或 Composer。
- 实施结束后追加真实测试结果和提交记录，不覆盖本节历史调查结果，也不把候选映射追记为用户已经确认。
