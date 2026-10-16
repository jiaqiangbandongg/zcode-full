# Marketing Touch：navigate 与 copy_text 协议方案

更新：2026-09-11。状态：客户端已接入，macOS 隔离 App 验证通过；服务端版本/平台投放与统计口径仍需联调，非已上线声明。

现有实现见 [Marketing Touch 客户端接入](marketing-touch-client.md)。文档更新不表示新动作已经可下发。

## 1. 范围

| 动作 | 状态 | 用途 |
| --- | --- | --- |
| close | 已实现，保持 | 关闭营销内容 |
| open_url | 已实现，保持 | 打开 HTTP/HTTPS 网页 |
| claim_zcode_plan | 已实现，保持 | 复用资格、安全校验与领取流程 |
| navigate | 本期新增，客户端已实现 | 设置分区、提供商设置、插件市场与详情导航 |
| copy_text | 本期新增，客户端已实现 | 复制原始纯文本，不执行 |

明确不做：`create_task`、`select_model`、填入提示词、安装/启用插件、自动授权、工作区选择和启动功能引导。不得恢复旧领取流程中自动切换套餐连接与模型的逻辑。

不改变：纯图片 Banner、空文案按钮、ghost 圆形透明关闭/loading、资源准备完成后展示、正式10分钟/测试30秒轮询、服务端决定重投放、Hero ZIP 校验与沙箱机制。

## 2. 通用下发结构

```json
{
  "text": { "format": "plaintext", "content": "打开插件市场", "style": null },
  "action": { "type": "navigate", "args": { "page": "plugin_marketplace" } }
}
```

| 位置 | 展示与操作 |
| --- | --- |
| banner.buttons[] | 最多一个 close、一个常规动作；常规动作绑定整图，文案可空，仅补无障碍标签 |
| popup.buttons[] | 独立弹窗的可见按钮 |
| banner.success_popup.buttons[] | 成功结果弹窗的可见按钮 |

不新增顶层 banner.action，不使用动作数组。文本保持现有 plaintext/html/markdown 和可选/null style 契约，不直接把 style 注入 DOM。

## 3. navigate 参数

定义 settings、plugin_marketplace、upgrade、rewards 四个顶层 page。稳定协议标识由客户端映射既有入口，不向服务端暴露路由路径或组件名。

| 参数 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| page | 枚举 | 是 | settings / plugin_marketplace / upgrade / rewards |
| section | 枚举 | 否 | 仅 settings 使用，取下表白名单 |
| provider_id | 字符串 | 否 | 仅 settings + models 使用，实际稳定提供商标识 |
| plugin_id | 字符串 | 否 | 仅 plugin_marketplace 使用，可信目录完整插件标识 |

ID 非空，最多128字符。可选字段省略，不以 null 表示省略。新动作 args 严格校验未知字段、枚举和参数组合；外围投放保持现有单条隔离策略。

### 邀请好友

`{"type":"navigate","args":{"page":"rewards"}}` 不接受其他参数，旧 page=referrals 不再接受。打开奖励中心 /{cn|en}/rewards，旧 /{cn|en}/referrals 不再支持。Banner、弹窗按钮和资源包交互共用原动作分发与 confirm 上报。客户端支持不等于服务端已开始投放。

RewardsProvider 接收导航后，已登录直接打开；未登录请求统一 app-login，记录本次 loginAttemptId。成功且 user 就绪后打开，取消、失败或尝试被替换则清除；不因后续无关登录再次打开。此待处理意图不放在登录后会重建的营销 controller 中。confirm 表示导航意图已接收，不表示登录或发奖成功；不新增或重复上报。

```text
navigate(rewards) → RewardsProvider → 已登录：打开
                                      → 未登录：记录登录尝试 ID
                                          → 同 ID 成功且 user 就绪：打开一次
                                          → 取消/失败/新 ID：清除
```

桌面使用既有隔离 WebView，Web/手机使用既有 HTTPS 外部打开，不转发 App token。语言、主题、环境和鉴权沿用 Rewards 接入契约，不改变任务和远控状态。

### 设置分区白名单

| 页面 | 下发 section | 当前内部标识 |
| --- | --- | --- |
| 常规 | general | general |
| 外观 | appearance | appearance |
| 模型设置 | models | modelProvider |
| 浏览器控制 | browser | browser |
| 电脑控制 | computer_use | computerUse |
| 记忆 | memory | memory |
| 子智能体 | subagents | subagents |
| 插件管理 | plugins | plugin |
| MCP 服务器 | mcp | mcp |
| 技能 | skills | skill |
| 命令 | commands | commands |
| 钩子 | hooks | hooks |
| 索引库 | indexing | indexing |
| 使用统计 | usage | usage |

section 省略时沿用设置默认/上次分区；已打开时激活已有设置页。底部“引导”不是普通设置分区，本期不纳入。不得原样透传内部历史 plugins、automations 等标识。

打开模型设置：

```json
{ "type": "navigate", "args": { "page": "settings", "section": "models" } }
```

定位指定提供商，只定位、不切换模型/套餐/连接、不自动授权：

```json
{
  "type": "navigate",
  "args": { "page": "settings", "section": "models", "provider_id": "<实际提供商标识>" }
}
```

打开技能：

```json
{ "type": "navigate", "args": { "page": "settings", "section": "skills" } }
```

### 插件管理与插件市场

| 目标 | 完整 args | 边界 |
| --- | --- | --- |
| 管理已安装插件 | `{"page":"settings","section":"plugins"}` | 只打开管理首页 |
| 浏览插件市场 | `{"page":"plugin_marketplace"}` | 只打开市场首页 |
| 市场插件详情 | `{"page":"plugin_marketplace","plugin_id":"名称@市场"}` | 只展示指定插件详情 |

```json
{ "type": "navigate", "args": { "page": "settings", "section": "plugins" } }
```

```json
{ "type": "navigate", "args": { "page": "plugin_marketplace" } }
```

```json
{
  "type": "navigate",
  "args": { "page": "plugin_marketplace", "plugin_id": "<插件名称>@<市场标识>" }
}
```

不增加独立 page=plugin_detail；详情统一由 plugin_marketplace + plugin_id 表达。当前入口按“名称@市场”识别插件，实际值必须来自可信目录，占位符不可上线。

本期不定位某个已安装插件，不支持 query 搜索参数，不自动安装、启用或卸载。指定插件不存在时明确失败，不静默打开首页。

不新增 plans、help、release_notes 枚举；外部页面继续使用 open_url。不接受任意内部路由、URL、组件名、本地路径或 RPC 方法。

### 升级购买入口补充

`{"type":"navigate","args":{"page":"upgrade"}}` 复用现有 CodingPlanUpgradeDialogProvider 和内嵌官网购买页，不接受套餐/provider/自动购买参数。提供商沿用当前侧栏升级目标解析。仅桌面支持内嵌 webview；Web/手机明确失败，不新建购买 runtime。

```text
营销点击 -> 当前升级入口 inventory 守卫 -> 原购买容器 -> webview dom-ready
              |                            |                 |
           未 ready: 失败             加载失败/关闭: 失败      confirm
              +----------------------------+                 |
                        恢复营销内容                      收口营销内容
```

等待时暂时隐藏营销 Dialog，保留 Controller 快照；30秒超时/账号变化/卸载关闭本次待打开容器，迟到事件不报成功。正常入口不改变。登录已迁入官网页，不再由 App 弹登录后恢复；购买页成功打开即表示导航成功，随后取消网页登录/关闭购买页不撤销 confirm，不等同购买成功，不下单或支付。原购买完成刷新保持不变。

验收：严格拒绝 upgrade 多余字段；inventory 不可用、失败/关闭/取消无 confirm；真实隔离 webview ready 后营销 Popup 消失且 confirm 一次；既有升级入口回归。

## 4. copy_text 参数与反馈

| 参数 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| text | 字符串 | 是 | 最多20,000字符；拒绝空白-only 内容；保留原文与换行 |

```json
{
  "text": { "format": "plaintext", "content": "复制提示词", "style": null },
  "action": {
    "type": "copy_text",
    "args": { "text": "请帮我审查当前工作区的代码改动" }
  }
}
```

- 复制原始纯文本；即使包含命令或 HTML，也不执行、不解析为可执行内容。
- 不填入输入框、不创建任务、不自动发送。
- 成功后保留 Banner/Popup，不展示 success_popup。
- Popup 按钮短暂显示本地化“已复制”，再恢复原文案，复用公共弹窗现有2秒反馈。
- Banner 使用本地化成功提示，不新增常驻文字。
- 写入失败提示并恢复操作，不显示虚假成功。
- 用户可以再次点击，每次实际执行写入；在途操作防连点。

不增加 close_after_action、report_type、skip_confirmation 等远端参数，行为由客户端按动作固定定义。

## 5. 客户端执行与状态

Marketing Touch Controller 仍为营销展示和当前操作的唯一 owner。导航/剪贴板通过窄能力适配入口复用既有功能，不模拟 DOM 点击，不直接修改模型、插件或任务状态。

```text
Banner / Popup 按钮
        |
        v
校验 type、args、当前平台能力
        |
        v
Controller 防连点
        +-- navigate --> 导航意图 --> 既有设置/市场入口
        |                                |
        |                                +--> 确认目标接管 --> 收口 + confirm
        |
        +-- copy_text --> 写入成功 --> 保留内容 + 成功提示 + confirm

失败 --> 恢复可操作状态 + 本地化提示，不报 confirm
```

### 导航适配

- settings 先登记分区/提供商意图，再打开或激活设置页，复用 setPendingSettingsSectionIntent 与 openSettingsTab。
- plugin_marketplace 复用市场打开和插件定位入口。
- 既有入口的事件/状态更新现由窗口内一次性请求关联和成功/失败确认补足；不能 dispatch 事件就宣称页面已展示。
- 成功判据是目标页面激活且请求的分区/提供商/插件定位完成；已经处于目标状态也可确认成功。
- 指定目标不存在时失败，不静默回退首页；列表未加载完成时等待既有加载结果，避免误判。
- 通过既有机制协调营销弹窗和目标页面的模态层，避免焦点争抢；失败保留/恢复重试入口。
- navigate 成功后不展示 success_popup，避免遮住新页面。这只适用于新增动作，不改现有领取/外链行为。
- navigate/copy_text 不触发领取专属的操作后立即查询，避免查询与异步 confirm 竞争导致旧弹窗遮挡目标；正常定时轮询和服务端重投放仍保留，不做历史去重。
- 插件市场位于工作区：发送市场意图后激活原工作区（带 workspaceIdentity），目标组件验证活动工作区身份和列表/详情状态再确认，不能把设置层背后的挂载视为成功。

### 剪贴板适配

优先复用现有能力；缺统一入口时补跨平台适配。由用户点击触发，处理权限、安全上下文及宿主限制；写入成功后才反馈与上报。

公共 CloudContentDialog 的内部 navigate/copy_text 分发与复制反馈已接入 Marketing Touch。导航使用内部 button ID 关联原始 args，避免丢失 section/provider_id/plugin_id；复制处理函数将失败传回公共弹窗，只有真实成功才显示“已复制”。

### 生命周期与多端

- 操作期间固定原始 Campaign、账号代次、窗口和请求上下文；轮询不能替换正在执行的快照。
- Banner 图片不变，关闭位使用透明 loading，沿用 pending 防连点与关闭拦截策略。
- 异步能力必须有限等待；具体超时依据既有能力确定，不用固定延迟假装成功。
- 身份变化、目标失效、卸载后，迟到结果不能重开旧营销内容，旧事件不能用新凭据上报。
- 丢弃迟到 UI 不等于撤销已产生的导航/复制副作用；超时结果不明时不自动重复执行。
- 不改变轮询、资源缓存、同 ID 重投放规则，不新增 Campaign 历史黑名单。

```text
营销 Controller --> 能力适配 --> 既有设置/市场/剪贴板
桌面任务 desktop-continuous ------> 原实时链路（不变）
手机任务 web-remote-replayable ---> 原 shared-host / 恢复链路（不变）
```

桌面/Web/手机复用组件与能力接口，不从共享 UI 直接调用 Electron API。不支持页面的平台明确失败，服务端提前按版本/平台限制投放。不另起 Agent runtime，不改变 remote attachment、任务流或 workspace 身份隔离，不下发任意工作区路径。

## 6. 上报规则

继续使用现有接口，不新增 action_id：

```http
POST /api/v1/marketing/touch/action
Content-Type: application/json
X-Device-Mid: <合法 UUID>
X-Client-Language: zh-CN
X-ZCode-App-Version: <实际 App 版本>
Authorization: Bearer <登录时附带>
```

```json
{ "campaign_id": "<原始投放 ID>", "action_type": "confirm" }
```

下表为客户端目标语义；复制后保留视图产生多事件的统计规则须服务端确认后才开放投放。

| 事件 | 上报 | 营销内容 |
| --- | --- | --- |
| navigate 成功 | confirm | 关闭 |
| navigate 失败 | 不报成功 | 保留/恢复并提示 |
| copy_text 成功 | 每次实际成功复制报一次 confirm | 保留 |
| copy_text 失败 | 不报成功 | 保留并提示 |
| 复制后关闭独立 Popup/Banner | cancel | 关闭 |
| 关闭领取成功结果弹窗 | 不重复报 cancel | 关闭 |
| 结果弹窗内执行新的导航/复制 | 成功后报 confirm | 按动作处理 |
| 查询、资源下载与展示 | 不报 show | 不变 |

confirm/cancel 表示操作事件，不是互斥的最终转化状态。同一投放可以多次 confirm，之后还有 cancel；关闭不撤销复制成功。不能为此重新加入跨轮询去重。

现有接口不能区分同一投放内具体哪个按钮，无法按钮级归因，本期不擅自扩展字段。按钮文案“确认”但 action=close 时仍报 cancel。

匿名用户以合法设备 UUID 上报设备维度；登录后记录用户和设备。上报失败不逆转业务成功、不阻塞 UI，不自动重试结果不确定的 POST，不接收客户端时间。

## 7. 失败、安全与兼容

| 场景 | 处理 |
| --- | --- |
| 未知动作/页面/分区/字段 | 按现有单条投放隔离拒绝并记录原因，不影响其他合法资源位 |
| 展示后目标或能力消失 | 点击时再次校验，提示失败，不执行其他动作 |
| 平台不支持页面 | 明确提示，不用另起 runtime 补偿 |
| 剪贴板权限/写入失败 | 不提示成功、不报 confirm，允许用户重试 |
| 账号变化/卸载/目标失效 | 失效旧关联，丢弃迟到 UI |
| 超时且结果不明 | 提示检查状态，不自动重复副作用 |
| 上报失败 | 脱敏记录，不逆转导航/复制 |

不接受任意脚本、RPC、凭据、静默安装、全局配置修改或付费操作。日志仅记录 Campaign、动作、结果、错误码，不输出凭据或完整复制文本；UI 使用既有 logger。

新客户端先发布，服务端再按客户端版本/平台开放运营投放，客户端保留最终校验。旧客户端不兼容的新投放不得直接放量。本期不新增能力协商接口。

## 8. 两端改动与实施顺序

| 范围 | 工作 |
| --- | --- |
| 服务端枚举/模型 | 注册两种动作，按 page/section 严格校验 args |
| 设置导航表单 | 页面/分区下拉框，models 可选提供商 |
| 市场导航表单 | 首页或可信目录指定插件 |
| 复制表单 | 纯文本正文，长度与非空校验 |
| 运营到 C 端映射 | 明确复制正文来源，不能混用按钮标签与正文 |
| 投放策略 | 版本/平台限制，确认多事件统计语义 |
| Shared | 动作判别联合、字段及组合校验 |
| 导航适配 | 复用入口，补请求关联、完成与失败反馈 |
| 剪贴板适配 | 跨平台写入和成功/失败反馈 |
| Controller/展示 | 导航收口、复制保留、pending 和上报复用 |

复制正文在运营侧直接配置还是引用现有 i18n 库，由服务端评审；C 端始终收到当前语言最终 args.text，不要求 App 解析 i18n key。

实施顺序：确认 spec/事件语义 → 扫描调用边界 → 先写 Schema/行为测试 → 能力适配与 Controller → 两端注册及版本限制 → 隔离 App E2E → 真实投放联调。不得 UI 直接调用 Repo，不另建营销专属模型/插件状态。

## 9. 验收矩阵

| 类别 | 必须验证 |
| --- | --- |
| Schema | 全部 page/section、缺失/空值、错误组合、未知字段、长度边界 |
| 设置 | 全部分区、已打开复用、默认页、提供商存在/不存在/加载中 |
| 插件 | 管理与市场区分、首页/详情、目标不存在、不自动安装启用 |
| 无副作用导航 | 不切模型、不改连接或配置、不创建任务 |
| 复制 | 原文/换行/HTML纯文本、成功、权限失败、重复复制 |
| 展示 | 导航收口、复制保留、均不触发 success_popup、失败恢复 |
| 上报 | confirm/cancel、匿名、复制后关闭、结果弹窗新动作、上报失败 |
| 状态 | 防连点、账号切换、卸载、目标变化、超时、迟到结果 |
| UI | 空文案 Banner、透明关闭/loading、明暗主题、中英文、键盘、窄屏 |
| 多端 | 桌面/手机支持与不支持路径，task/remote 链路不变 |
| 回归 | 领取、关闭、轮询、同 ID 重投放、Hero ZIP 校验与缓存不变 |

实现时更新 spec、先写测试再写代码，运行架构、类型、Lint、单测和 App E2E。隔离 fixture 通过不代表线上资格、真实安全校验及所有平台验收，未验证路径必须单列。

### 实现约束补充

导航使用窗口内一次性请求关联，目标组件在 React 提交后确认；等待上限30秒，取消/超时清理关联，不自动重试。提供商定位仅改变设置页选中节点，不调用连接方式保存逻辑；同一 family 下的套餐提供商定位到该 family 页面，保持用户当前连接方式。内置提供商真实 ID 带 builtin: 前缀（例如 builtin:bigmodel），不能使用展示名。复制直接复用浏览器 Clipboard API，等待上限10秒，不引入 Electron 专属调用。

## 10. 上线前待确认

复制正文的运营/i18n 来源；服务端多事件统计；提供商和插件标识实际值；各平台页面可用性；导航完成反馈与逐能力超时。

客户端完成标准：两种新动作及列出目标实现并通过隔离验证。上线标准另需两端版本/平台策略和上报语义对齐；本次不修改外部服务端。

## 11. 客户端验证记录（2026-09-11）

- 升级入口增量：6个相关单测文件96项通过；macOS Electron 隔离 App E2E 12项通过，run `desktop-e2e-20260911061657474-p89925-d239ab3a54e48ea1`。新增严格 upgrade 参数、打开结果一次性通知与取消防迟到测试，以及真实内嵌购买页 ready 后 confirm 一次、关闭购买页不追加营销上报的场景。复用原购买容器；营销弹窗渲染拆为 MarketingDialogs，保持单一 Controller。真实官网登录、下单及支付未执行，Windows/Linux/手机实机未验证。
- 10个相关单测文件86项通过：Schema、按钮适配、重复复制、复制后关闭、结果弹窗新动作、超时/取消、导航关联、原领取/轮询/缓存回归。
- macOS Electron 隔离 App E2E 11项通过，run `desktop-e2e-20260911034056333-p11822-7b0e93cb78872140`。包含全部14个设置分区、提供商定位且落盘连接配置不变、市场首页/可信目录详情、缺失提供商/插件失败、真实剪贴板原文与重复写入、模拟权限拒绝、confirm/cancel ledger；保留5项旧投放/领取/ZIP回归。
- 运行时发现并修正：市场挂在设置层背后不能确认成功；新增动作不沿用领取后立即查询，避免异步上报与旧投放重查竞争。测试 fixture 按单次投放关联，旧上报不能清空新测试数据；原同 campaign 重投放用例不变。
- `pnpm typecheck`、`pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm architecture:check --changed`、改动文件格式检查通过；`pnpm lint` 为0错误/46条既有警告。
- 按 architecture-governance / React / e2e-case-lifecycle 技能约束保留单一 Controller、窄导航关联、目标组件确认；E2E 保持 manual-review/pending，不自行提升正式套件。
- 未验证：真实服务端新动作投放和多事件统计、真实安全校验、Windows/Linux/手机实机、双主题窄屏人工视觉验收。本次未修改外部服务端，也不恢复 App Mock 入口；Hero ZIP 保留不变。
