# Marketing Touch 客户端接入

## Banner hover 桥接（2026-09-15）

Banner iframe 保留 pointer-events:none、inert、不可聚焦及忽略包内 action。App Banner 是 hover 唯一 owner：鼠标移入/移出整块 Banner，经已有 `zcode-cloud-hero-v1` 发送 `{type:"hover",instanceId,hovered:boolean}`；不发送坐标、点击或业务事件，不改服务端投放字段。

```text
鼠标移入/移出 → App Banner hovered → ready 后发 hover → 资源包动画
pending / 失焦 / 页面隐藏 / touch → hovered=false → 复原
整块点击 / 关闭 → 原 Controller → 原 confirm/cancel 上报
```

iframe ready 前不发 hover；ready 后同步当前值。减少动态效果时发送 false；移除资源沿用 destroy，替换 URL 创建新状态，旧实例不能影响新实例。资源端校验 parent/channel/instanceId/boolean，hover 只更新动效，不重渲染权益。旧 ZIP 忽略新消息，需新版 ZIP 才可在 App 内响应 hover。Hero 保持原生交互，image/video 不受影响；Web fallback 不发送 iframe 消息，触屏不触发 hover，task/远控链路不变。

验收扩展 MTC-BUNDLE：真实鼠标移入/移出收到 hover，点击/关闭仍各上报一次，iframe 仍不接收指针；单测补 pending、blur、hidden、touch、ready 和 reduced-motion；资源浏览器检查真实变换与复原。

状态：客户端实现完成，本地隔离接口的 macOS App E2E 已通过；真实服务端/官方版本安全校验及其他平台联调待验收。服务端依据 marketing_touch_design.md；本文固定客户端语义，替代旧手动领取 Banner 的 preview 轮询约束。公共展示契约见 cloud-content-dialog.md。

## 契约与职责

### 领取结果不再使用 toast（2026-09-14）

`claim_zcode_plan` 成功或失败均不弹 toast。成功沿用服务端 `success_popup`（未配置则不额外提示）；失败、安全校验取消及结果不确定沿用现有失败弹窗。删除 Provider 的额外成功 toast，不新增状态/计时器，不修改服务端协议、权益刷新、轮询与 confirm/cancel 上报。复制成功、导航等非领取动作的 toast 保留，桌面与 Web 共用行为。

```text
领取结果 → Controller → 成功：success_popup（如有）
                     └→ 失败/不确定：失败弹窗
                     两条路径均不额外触发 toast
```

回归：Provider 成功及后置刷新失败均无 toast；MTC-03/04/06/08、MTC-FAIL 在真实领取到结果弹窗期间观察 toast DOM，确认无成功/失败 toast，保留原弹窗与上报断言。

验证：先以真实 Electron 复现成功路径出现 `Action succeeded` toast（`desktop-e2e-20260914-092917-468`），失败路径无 toast；移除后 `desktop-e2e-20260914-093051-737` 两项通过（11 秒、runner exit 0）。相关单测 35/35、typecheck、typecheck:e2e、lint（46 既有 warnings / 0 errors）、architecture（0 violations）通过。未验证真实生产接口、Windows/Linux 和手机实机。

### 服务端协议对齐（2026-09-12）

依据用户提供的 `marketing_touch_design.md` §7.3.1，营销 Banner background 与 Popup hero 仅接受 `image / video / bundle`。撤回未约定的 `lottie`、`lottie.dark` 和播放参数接入，不把客户端自定义字段当成服务端能力。已有通用 Lottie 播放器保留，但不接入营销投放。未支持的视觉类型按既有单条投放拒绝规则处理，不影响同批其他合法投放；轮询、资源缓存、关闭及上报保持不变。此前 Lottie mock 测试仅证明自定义客户端链路，不代表服务端支持。

对齐回归：相关单测 74/74；本机 macOS Electron 正式用例 MTC-BUNDLE / MTC-RICH 2/2（7.5 秒），覆盖现有资源包、主题/数据/上报、富文本和视频 Banner。typecheck、lint（45 既有 warnings / 0 errors）、architecture 通过。未复验其他操作系统、手机实机及真实服务端；不改变历史覆盖率结论。

### 领取失败提示（2026-09-11）

`POST /api/v1/zcode-plan/billing/claim` 失败响应的 `msg` 不展示；仅使用
`data.message`（服务端已翻译）作为纯文本，保留换行，不解释 HTML/Markdown。
message 缺失、非字符串或纯空白时，App 使用本地化通用失败文案，不再按 1005 等错误码
推导日期和文案。领取接口兼容数字及数字字符串 code，缺失 code 仍失败，成功仍要求
code=0 且 data.plan 存在；其他接口解包不变。

Controller 是唯一错误状态源，携带错误所属 action；仅 claim_zcode_plan 的失败提示由
toast 改为 Dialog。弹窗无可见标题、无 Hero/关闭 X；内容为既有 Alert + InfoIcon +
AlertDescription，下方「知道了」右对齐。保留屏幕阅读器隐藏标题，长文案可换行、滚动。
Alert 仅复用语义和图文布局，移除背景、边框及内边距，不形成第二层可见容器；外层 Dialog 不变。
无内层容器样式回归：组件单测通过，App MTC-01/07/08、MTC-FAIL 2/2 通过
（`desktop-e2e-20260911-153048-039`），亮暗主题实际 CSS 均为透明背景、0 边框、0 内边距。
支持亮暗主题及窄屏。遮罩/Esc/知道了仅清除错误，不重试 claim、不额外 confirm/cancel。
既有营销弹窗领取失败时暂时隐藏原弹窗，关闭提示后恢复；其他动作错误继续 toast。

```text
claim 响应 → 服务读取 data.message → Controller error + action
                                   → pending=false → 失败 Dialog
知道了/Esc/遮罩 → clearError → 原有投放/轮询逻辑（无自动领取）
```

MTC-FAIL：服务单测覆盖字符串/数字 code、msg 忽略、message 原样/缺失/空白/非法值；
组件覆盖 Info Alert、无可见标题、纯文本、关闭无重试；Controller 覆盖 pending 收口及
错误清理不产生上报；App E2E 真实 Banner → 安全校验 → claim 失败 → 弹窗 → 知道了，
验证服务文案、亮暗/窄屏、claim 计数和无 confirm/cancel，并保留样式截图。
桌面/Web 共用组件，Host 服务映射相同；不改变 session continuous/replayable 边界。

验证：142 条相关单测通过；macOS App MTC-01/07/08、MTC-FAIL 2/2 通过，
运行记录 `desktop-e2e-20260911-150225-383`。隔离服务返回真实格式失败响应，验证
服务文案/空白兜底、亮暗 358px 窄布局、关闭不重试及不新增上报；截图等待入场动画结束。
Lint 0 错误，架构 0 违规。全仓/E2E 类型检查仍受既有 modelProviderService、
Root RefreshCw、Provider id、marketing-touch-entitlement 旧账户/设置字段报错阻塞。
未验证真实生产领取/安全校验、Windows/Linux、手机实机；截图使用测试环境英文按钮标签。

### VisualBody 与格式化文案（2026-09-11）

Banner background 与 popup hero 共用 VisualBody：image / video / bundle。视频（MP4）沿用
prepareMarketingHero 的下载、摘要校验、可播放预加载与 fallback，不另建缓存或状态源。
Banner 固定 96px，视频静音循环、无 controls，不截获整图按钮点击；隐藏页面及减少动态效果
时暂停，播放失败展示 fallback。Hero 原视频 controls 不变，ZIP 仍遵守 ready 后展示。

```text
GET → VisualBody 校验 → prepareMarketingHero → Controller 当前投放 → Banner/Hero
文本 format/content → 适配（保留格式）→ 共享安全渲染 → 标题/描述/按钮
```

plaintext 原样显示；markdown 支持段落、标题、强调、列表、引用、代码、链接及表格；
Markdown 内嵌 HTML 按文字显示，需要 HTML 使用 html format。HTML 和 Markdown 输出
均经同一安全标签/属性重建，保留既有 class/style 规则，不执行脚本、不加载内嵌图片。
标题和按钮使用行内模式（块级标签转换为 span），链接只显示文字，不产生嵌套交互；
描述的 http(s) 链接仍走平台回调。旧公共 Dialog 字符串 title/label 兼容保留，
Marketing 适配器提供仅 UI 使用的 formattedTitle/formattedLabel，不增加服务端字段。
文字强调继承按钮前景色，不能破坏 primary 按钮对比度。按钮动作、seq、上报不变。
桌面/Web 共用组件，不改变 Host、远控或 session 消息语义。

验收：协议接受视频、资源失败 fallback；组件验证 Markdown/HTML 安全排版、标题/按钮
保留格式及点击；MTC-RICH E2E 验证真实 App 富文本展示、关闭上报与视频 Banner。

验证：117 条相关单测通过；macOS App MTC-01/07/08、MTC-RICH 2/2 通过，
运行记录 `desktop-e2e-20260911-123103-540`。检查真实 MP4 解码/循环/静音/无 controls、
96px 高度、富文本亮暗/358px 窄屏、cancel/confirm 上报。首次测试 WebM 被素材校验拒绝，
改为协议内 MP4；静态单帧测试视频无法循环，多帧录制后通过，未放宽产品校验。
Lint 0 错误，架构 0 违规。全仓及 E2E 类型检查仍被既有 modelProviderService、
Root RefreshCw、Provider id、marketing-touch-entitlement 旧账户/设置字段阻塞。
未验证 Windows/Linux、手机实机和真实生产服务；未修改同步、轮询或上报状态所有权。

### 弹窗按钮主题

弹窗内容按钮始终只显示文字，不根据 action 自动添加分享、复制成功勾或其他图标。
复制成功文字反馈、重复点击、禁用状态及 confirm/cancel 上报保持不变；右上角关闭 X 不受影响。
组件与 MTA-01 E2E 覆盖复制前后无 SVG。

独立 popup 与 success_popup 的 buttons[].theme 支持 variant/class/style。
variant 为 default/outline/secondary/ghost/destructive/warning/link；省略、空字符串
等价 default。theme 省略或 null 同样使用 default，不再根据 close 动作推导 secondary。
class/style 为可选字符串（各最多 512 字符），class 通过现有 cn 合并，无类名白名单；
仅 App 已编译的 Tailwind 类可生效，不运行远端 Tailwind 编译器。
style 复用 cloudDescriptionStyle 的属性和值校验，允许颜色、文字及有限间距等既有属性，
禁止资源 URL、固定定位、!important 等；最终内联样式覆盖 class，class 覆盖基础布局与 variant。
Banner 忽略 theme（包括未知 variant），关闭/loading 样式维持现状。
弹窗右上角 X、遮罩和 Esc 不属于 buttons[]，行为及样式不变。
文本节点仅保留 format/content；旧 text.style 作为未知字段丢弃，不拒绝历史投放。
HTML 文本内容中的 class/style 继续沿用原解析，不受影响。

```text
下发 → popup/success_popup theme 校验 → 适配 → 共享 Button
     → banner theme 忽略
点击 → 原动作 Controller → 原 confirm/cancel 上报
```

MTC-THEME：协议覆盖七种 variant、默认、长度、旧字段丢弃与 Banner 忽略；
组件覆盖 class/style 优先级、危险样式过滤及点击；MTC-HTML E2E 同时验证按钮主题、
亮暗/窄屏和 cancel 上报。桌面与 Web 共用组件，不修改服务进程或远控同步边界。

2026-09-11 验证：83 条相关单测通过，隔离 MTC-01/07/08 与 MTC-HTML 的 macOS App
E2E 2/2 通过；lint 0 错误、架构检查通过。完整 delivery 回归 9 通过/5 失败，首个失败
为既有模型 Provider 导航超时，遗留弹窗干扰后续用例；直接 WDIO grep 隔离主题用例通过。
全仓与 E2E 类型检查仍受 rebase 后 Provider 旧 API/字段及 Root RefreshCw 导入问题阻塞，
本次不扩展修复。未验证 Windows/Linux 或手机实机；窄屏为桌面内布局验证。

2026-09-12 后续修复（[E2E 实施记录](testing/marketing-touch-e2e-implementation.md)）：
已迁接 `providerSettingsService.refresh("marketing-plan-claim")` 并保留 best-effort 权益刷新，
修复 `providerId` 导航匹配及 Root 错误态图标导入，类型检查恢复通过。
交互 bundle 弹窗初始聚焦父层关闭按钮，避免 iframe 吞掉首次 Esc；用户仍可主动进入 Hero。
Host 退出时识别仅提供 `disposeAllAndWait` 的云资源服务，等待 lease 与本 Host 缓存目录释放；
同步退出路径只启动 best-effort 清理，不把它当成已等待完成。
当前新增回归仍为 pending，完整覆盖率与平台缺口以实施记录为准，不宣称已经达到 95%。

### 任务完成后刷新（2026-09-18）

已挂载工作区观察到会话从非完成态进入 `completedSuccess` 时，重新拉取一次
`GET /api/v1/marketing/touch`，同时更新 Banner 与 Popup 候选。不依赖系统通知开关。
首次历史快照、工作区切换/重连后的基线、重复完成态、失败、手动中断不触发。
同批多个任务完成只触发一次；在途请求继续由窗口唯一 poller 合并为一次后续查询。
隐藏页面不发送请求，恢复可见时沿用已有刷新。Popup 展示仍受现有遮挡与去重规则约束。

```text
CLI task owner → sessions-index 只读投影 → 工作区 hook 观察成功完成边沿
  → 窗口 Marketing Touch poller → query → Banner/Popup 候选与既有展示门禁
桌面 continuous / 手机 replayable：沿用原 transport，不新增消息恢复或任务状态 owner
```

工作区 hook 复用 endpoint + workspaceIdentity（本地回退 workspacePath）的注册表订阅，
只保存前次观察值；RPC 未就绪不订阅，非 live 期间清除观察基线，卸载后释放引用。
验收 MTC-TASK-COMPLETE：成功完成刷新、历史不刷新、失败/中断不刷新、重复去重、
再次运行后完成、批量完成合并、断连恢复基线、远程身份和清理，以及隐藏/在途调度。

### 左下角与 Highspeed 分享卡共享槽位优先级（2026-09-20）

左下角侧栏底部的「领 token」营销 Banner 与 Highspeed 分享卡（全局通知 `highspeed-share`）折叠到**同一展示槽位**，两者同时命中时**领 token Banner 优先覆盖在上**；Banner 消失或被关闭后，同一槽位才显示 Highspeed 分享卡。仲裁由只读投影组件 `SidebarBottomActivity` 完成：读取两侧各自 store 的可见性择一渲染，不复制状态、不新增计时器。Banner「可见」复用唯一谓词 `isMarketingBannerRenderable`（`banner && resource_position === "banner" && (image || bannerHero)`，领取 `pending` 期间仍算可见）。完整时序与归属见 [Highspeed 卡规格 §9.5](highspeed/highspeed-card-spec.md)。

```text
banner 可见 → 渲染领 token Banner（覆盖 Highspeed）
banner 消失/关闭/pending 结束无投放 → 同一槽位渲染 Highspeed 分享卡（若仍在 24h 窗口内）
```

### 启动请求序号 seq

`GET /api/v1/marketing/touch?seq=0`：首次实际请求使用 0，此后依次递增。
序号由 Marketing Touch 服务模块在进程内持有，多个服务实例共享；组件重挂载、工作区、
账号与语言切换不重置。不持久化，服务进程重新启动从 0 开始。桌面各窗口 Host、独立 Web
服务进程分别计数，手机透过既有服务入口请求时沿用该服务进程序号，不新增跨端同步。
凭据/设备/语言校验通过、即将调用 HTTP 时分配序号；网络失败、响应解析失败也消耗序号，
并发请求不重复。未发出的请求、暂停轮询及 POST action 不消耗序号。仅供服务端日志定位，
不改变投放判断、轮询周期、去重或上报语义。本约定覆盖服务端文档此前从 1 开始的描述。

```text
进程启动(0) → 请求校验 → GET seq=0 → GET seq=1 → ...
                         失败也递增；服务实例重建不归零
```

验收：服务测试覆盖首次、连续/并发、失败、校验拒绝、登录与语言变化、服务实例重建、
新进程模块初始化及 action 不计数。本次不修改 UI 交互，沿用既有展示 E2E。

### Banner 边框与圆角（2026-09-11 更新）

验证：11条单测、14条 macOS App E2E通过（`desktop-e2e-20260911092935856-p13324-22f4d65aa5e1e68e`），运行计算样式确认按钮96px、iframe94px、边框1px、圆角12px，截图确认裁切。typecheck、E2E类型、架构通过；Lint 0错误/46条既有警告。仅展示层改动，未另跑 Windows/Linux/手机实机。

最新视觉要求覆盖下文历史的无边框及按比例高度约定：图片、ZIP 与 fallback 的整图按钮统一使用 `h-24 border border-border rounded-xl overflow-hidden`（固定96px含边框、1px主题边框、12px圆角裁切），宽度自适应；不增加背景或阴影。图片以 object-cover 填满，ZIP viewport 填满94px高内容区，不再按236:100计算高度；包应响应可变宽度与固定高度。关闭/loading 仍是兄弟覆盖层，保留 ghost/rounded-full、原位置及键盘 focus ring。桌面与手机 Web、亮暗主题使用相同组件，不改变 ready/缓存/动作/上报状态。MTC-03 和 MTC-BUNDLE 检查固定高度、计算边框、圆角、overflow 与角落命中，既有点击/关闭/loading/上报回归保留。

### Banner ZIP 资源包

`banner.background` 支持 `image | bundle`（不接受 video/lottie）。bundle 与 Popup hero 共用 `{type:"bundle",bundle:{bundle:{src,sha256},entry:"index.html",fallback?:{src,sha256}},args?:{...}}`。旧 image 投放保持兼容；Banner 按钮规则及 success_popup 不变。ZIP 使用现有宿主授权、SHA-256 校验、安全解压和 lease/cache，无新的下载入口。

background 示例（URL/hash 为占位，发布时替换为实际资源及 SHA-256）：

```json
{
  "type": "bundle",
  "bundle": {
    "bundle": {
      "src": "https://cdn.example.com/weekend-banner.zip",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    "entry": "index.html",
    "fallback": {
      "src": "https://cdn.example.com/weekend-banner.png",
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  },
  "args": { "planName": "Weekend Build", "amountValue": "300,000,000", "amountUnit": "Tokens" }
}
```

```text
GET -> shared Schema -> 资源授权 -> prepareMarketingHero(background)
                                      -> ZIP lease -> 隔离 iframe -> init(args/theme/locale)
                                                                   -> ready -> Banner 展示
                                                                   -> error/5s -> fallback / 隐藏
App 整图按钮/关闭 -> 原 Controller -> 安全校验/领取 -> confirm/cancel
```

Banner bundle 展示比例为 236:100，宽度随侧栏自适应；包内画面应响应此 viewport。外层无卡片背景/边框/圆角/阴影，iframe 透明且不可聚焦、不接收指针；App 整图按钮接收点击和键盘，关闭与 loading 覆盖其上。包只负责画面与自主动画，包内 action 消息不执行业务，也不提供包内独立点击/拖拽交互。继续使用 `zcode-cloud-hero-v1` 的 init/theme/visibility/destroy/ready/error 消息；args 经现有套餐展示映射传入 data，原始 args 字段保留，不携带凭据。resize 不改变固定比例。

Controller 仍是投放/动作唯一 owner；组件仅持有 iframe 就绪状态。下载、解压完成后离屏裁切挂载 iframe，ready 前不展示或启用控件；错误使用已校验解码的 fallback，否则隐藏且不上报。替换/撤下/关闭/身份切换按既有 generation 丢弃迟到资源并释放 lease，success_popup 的资源与 Banner 资源分别持有、共同释放。相同下发不重挂载，资源按现有缓存复用；不新增 campaign 去重。Web 不请求桌面 loopback，只显示 fallback；无 fallback 隐藏。共享组件覆盖主题/语言/窄屏，task continuous/replayable、远控 attachment 不变。

验收：MTC-BUNDLE 单测覆盖 Schema、授权、数据映射/lease、ready/伪造消息/错误/超时、重挂载、pending 控件及忽略包内动作；App E2E 使用真实 ZIP，验证 ready 后显示、比例、数据、主题、点击/关闭上报、同 SHA 缓存复用。保留原 image E2E，未验证的平台需在完成记录列出。

2026-09-11 验证：91条相关单测、14条 macOS App E2E通过（run `desktop-e2e-20260911091948588-p91654-49a47f54650b1782`）；typecheck、E2E typecheck、architecture、diff检查通过，Lint 0错误/46条已有警告。E2E 初跑因前序导航停在设置页未返回工作区失败；第二次在票券入场动画期间提取可见文本失败，改为精确 DOM 数据与动画收口分别验证后通过。运行截图确认侧栏 iframe 真实渲染；复用原4:3 Hero仅作链路 fixture，其画面在236:100有裁切，不作为正式 Banner 设计资源。未发布新的 Banner ZIP、未修改服务端投放、未领取真实套餐；Windows/Linux/手机实机未验证，Web fallback由单测覆盖。

新动作见 [navigate 与 copy_text 协议方案](marketing-touch-actions.md)：客户端已接入设置各分区、插件管理/市场与详情导航，以及纯文本复制；不包含新建任务或切换模型。导航等目标组件确认后关闭内容并报 confirm；复制成功保留内容，每次真实复制报 confirm，随后关闭 Banner/独立 Popup 仍报 cancel。两者均不触发 success_popup。

HTML 描述支持不经过类名白名单过滤的 class，以及经过属性和值校验的 inline style，完整规则见 [HTML 样式](cloud-content-html-styling.md)。仅已打包 Tailwind CSS 生效，外层 description.style 不变；服务端内容必须可信，不承诺任意 class 的布局隔离。

升级购买使用 `{"type":"navigate","args":{"page":"upgrade"}}`，仅桌面复用现有内嵌官网购买页及侧栏提供商选择，不接受套餐或自动支付参数。等待页面 ready 时隐藏营销弹窗，失败/取消/超时恢复内容且不报 confirm；页面 ready 后报一次 confirm，表示打开成功而非购买成功。登录与支付继续由原购买页处理。

2026-09-11 新动作验收：86项相关单测、11项 macOS 隔离 App E2E、类型/E2E类型/架构/格式检查通过；Lint 0错误/46条既有警告。详细 run 和未覆盖平台见动作方案的验证记录。服务端投放与统计联调不属于已完成声明。

关闭控件使用 `ghost + rounded-full`，默认透明、悬停使用既有 hover 样式；loading 同样无背景，避免状态切换出现底色。两者不添加 `bg-card`。此次仅展示层修正，跨主题/桌面/手机复用同一组件，不改变动作和上报状态。MTC-03/04 同时验证关闭与 loading 的透明计算样式。

2026-09-11 验证：修改前背景断言失败；修改后16条单测、5条 macOS delivery E2E通过，运行时关闭/loading 背景均为 rgba(0, 0, 0, 0)。typecheck、E2E typecheck、architecture通过；Lint 0错误/46条已有警告。未另跑 Windows/Linux/手机及双主题视觉验收。

### Banner 协议命名迁移

依据新版服务端文档，资源位统一为 `resource_position: "banner"`，内容字段为 `banner`；旧 `card` 协议不再接受。组件文件、公开类型、Controller 状态/动作、测试文件与 testid 同步使用 Banner/banner。未知旧资源位独立拒绝，不影响合法 Popup。

本次只迁移名称，保留纯图片、空按钮文案、关闭/loading、资源校验、成功弹窗、轮询与上报语义；不扩展 Banner 背景类型。Controller 仍为单一状态 owner，桌面与手机复用相同路径，不改 task continuous/replayable 边界。HTTP fixture 更新为 Banner；现有三版交付 JSON 均为独立 Popup，无旧字段，不需修改。Hero HTML/ZIP 字节与哈希不变。通用 Card 样式 token 和权益卡片命名不属于此次迁移。

```text
GET banner -> Schema -> Service 资源授权 -> Controller -> MarketingBanner
                                                    -> success_popup / report
旧 card -> 独立拒绝；同响应的 Popup 保留
```

验收：新版 Banner + Popup 同时解析；旧 card 拒绝；空文案点击/关闭、30秒重投放和 confirm/cancel 的 App E2E 保持通过。

本次验证：迁移前新版协议5条断言失败；迁移后8个文件45条单测、macOS delivery E2E 5条通过，typecheck、E2E typecheck、architecture通过，Lint 0错误/46条已有警告。三版 Hero ZIP 哈希不变。额外权益 E2E 未通过：合并运行时共享 fixture 已撤下 Popup；按文档单独重跑后 Popup 步骤通过，但设置页缺少 Start 连接方式选项（`selectBigModelPlan`），该用例可执行代码与迁移前相同，原因待单独排查。未验证线上投放、真实安全校验、Windows/Linux/手机实机；不将额外权益用例标记通过。

文本的 `style` 为可选元数据：省略、`null` 或对象均合法；省略/null 使用客户端默认样式，对象仍不直接注入 DOM。此规则统一应用于 Banner 按钮、Popup 标题/描述/按钮及 success_popup；不放宽 action.args.plan_id 等业务参数校验。

`style:null` 回归：修改前1条测试失败，修改后14条相关单测通过；使用 null 样式 fixture 的 macOS App E2E 3条通过（run `desktop-e2e-20260910104035687-p56768-d8445a96ab6405e9`）。类型/E2E类型/架构检查通过，Lint 0错误、46条已有警告；未新增其他平台实机验证。

GET /api/v1/marketing/touch 返回 data.server_time、language、deliveries；每条按 resource_position 使用 banner 或 popup 字段，不使用 content 包装。POST /api/v1/marketing/touch/action 只发送 campaign_id、action_type(confirm/cancel)。两接口携带 X-Device-Mid、X-Client-Language、X-ZCode-App-Version 和可选 Authorization。

Banner 为左下角图片或 ZIP 展示位。buttons 最多一个 close、一个非 close；close 复用右上角 X，常规动作绑定整图，无 banner.action。未知 layout/action、多个常规动作、image/bundle 以外的 Banner 独立拒绝，不影响另一资源位。Popup Hero 可空；支持 image/video/bundle，服务端暂无 lottie。文本使用 plaintext/html/markdown 的既有渲染能力（Banner 按钮空 format 按 plaintext；markdown 暂按原文），忽略远端 style。按钮文字提取安全纯文本用于标签。

Banner 是接口资源位名称，不表示客户端卡片外观。图片外层不添加边框、背景、圆角裁切或阴影，透明区域直接透出页面；图片保持原始比例。右上角关闭/loading 控件保持现有样式及位置，整图按钮保留键盘 focus-visible 提示。桌面与手机 Web、所有主题使用同一规则；本次纯展示层调整不改变轮询、资源准备、动作或上报状态。MTC-03 增加无卡片装饰的组件断言及 App 计算样式验证。

Banner 按钮文案允许为空（含空白及提取后为空的 HTML）；有 close 动作即显示 X，有非 close 动作即启用整图点击，不能用文案真假值判断动作存在。ConnectedBanner 负责从动作推导 hasAction/hasClose，并对空标签使用本地化 common.open/common.close，仅用于 aria-label/图片替代文本，不新增可见文案。没有对应动作时仍禁用整图/隐藏 X；pending 期间继续禁用整图并以 loading 替换 X。MTC-04/08 增加空文案点击、关闭与上报验证，其他投放/远控状态语义不变。

Banner 按钮的 `text.format` 额外允许空字符串 `""`，共享 Schema 统一归一为 `plaintext`，无论 content 是否为空；不因此拒绝投放。该规则仅适用于 `banner.buttons`，独立 Popup 与 success_popup 的标题、描述和按钮仍要求 plaintext/html/markdown；未知格式、缺失/null 格式仍拒绝。沿用原解析→资源准备→展示/动作上报路径，不改变状态 owner 或桌面/手机链路。MTC-01 单测验证作用域及非法值，MTC-03/04/08 的 HTTP fixture 使用空 format 与空 content 验证整图动作、关闭、loading 和上报。

空格式回归（2026-09-11）：修改前2条测试失败；修改后54条协议单测、13条 macOS delivery E2E通过。真实 GET 返回两个空 format 时，修正后的解析结果为 deliveries=1/rejectedCount=0；不代表已验证线上领取。typecheck、E2E typecheck、architecture通过，Lint 0错误/46条已有警告。未另跑 Windows/Linux/手机实机，Hero ZIP未改动。

空文案回归（2026-09-10）：修改前组件断言失败，修改后16条相关单测、5条 macOS App E2E通过。HTTP fixture 的 Banner 动作/关闭文案均为空，验证 X 可见、纯图片无新增文字、点击/loading/成功及关闭上报；类型、E2E类型、架构通过，Lint 0错误/46条已有警告。未另跑 Windows/Linux/手机实机，Hero ZIP不变。

纯图片样式验证（2026-09-10）：修改前组件测试复现边框断言失败，修改后14条相关单测、5条 macOS App delivery E2E通过。浏览器计算样式确认四边0px、背景透明、圆角0px、阴影none；类型、E2E类型、架构通过，Lint 0错误/46条已有警告。未单独执行双主题/手机/Windows/Linux视觉验收；用例仍保持 pending。

服务 DTO 与 CloudContentPayload 分离；适配器创建内部按钮 ID/实例 revision，内容变化标识不充当投放批次。hero.args 通过明确映射提供展示数据，不携带凭据或触发宿主业务。所有 URL/哈希在使用前校验。

```text
Touch Service -> App Shell Controller -> Banner / Popup queue -> CloudContentDialog
                       |                    |
                       |                    -> Asset Service -> verify -> decode/extract -> ready
                       -> registered action -> 安全校验 -> claim -> confirm report
                                                           -> success_popup
```

Service 承担 HTTP/凭据/文件 IO；稳定 Shell Controller 是窗口展示状态及轮询唯一 owner。切换 workspace 不另起投放实例；远程 workspace 使用本地 App 能力。main/relay/Agent 不拥有营销业务状态。共享组件与手机布局复用；desktop-continuous/web-remote-replayable 的 task 消息链路保持隔离。资源 lease 不是 task owner lease。

## 资源与动作时序

Banner 图片下载、SHA-256 校验与解码后展示；失败隐藏。Popup 先准备资源再打开；主资源失败准备 fallback，无 fallback 降级正文和关闭。视频完整下载验证；ZIP 安全解压后取得受控入口，挂载后 ready 握手超时降级。ZIP size 声明可选，实际字节/展开量始终有上限，禁止伪造 size。沿用既有 ZIP 8MiB、展开32MiB等限制。可信源由宿主配置；不接受任意地址或重定向绕过。Web 不使用 Desktop loopback，bundle 未具备安全托管时仅 fallback。

收到 Banner 后后台准备 success_popup，不能预执行业务动作。资源按 hash 复用；取消/身份切换/卸载释放引用；迟到结果不重新打开内容。

```text
ready -> login -> verifying -> submitting -> success-preparing -> result
                    |              |
                    -> cancelled   -> failed / uncertain
                           |               |
                           -> ready        -> reconcile or explicit feedback
```

验证/提交/等待结果资源时图片不变，无遮罩，右上角 X 换 loading；同步锁防重复点击，提供本地化 aria-live 文案。安全校验交互入口仍可用。取消或明确可重试失败恢复 X。请求固定 Campaign/action/success_popup 快照；后台轮询不能替换正在操作的 Banner。领取成功立即确定事实，权益/provider 刷新并行且 best effort，不逆转成功。超时不自动重发写请求；无查询/幂等能力则给明确结果待确认反馈。所有等待有时限。无 success_popup 时使用本地成功反馈。

## 轮询与展示

环境频率恢复：正式构建且 `ZCODE_ENV=production` 时正常轮询间隔10分钟；test或开发构建30秒。移除随机 jitter，保留失败退避和事件立即刷新。旧 ManualClaimPlanBanner/ResultDialog 及其专属辅助逻辑和测试删除；输入框正在使用的模型选择引导、共用失败文案、Hero HTML/ZIP 与测试 fixture 保留。

```text
query完成 -> production build + production env ? 600s : 30s -> 下一次query
隐藏 -> 停止计时；前台恢复/成功等事件 -> 合并为一次立即query
```

本轮验证：32条相关单测、3条 macOS App E2E通过；自动 query 日志为18:54:29.865和18:54:59.873，间隔约30秒。正式600秒及测试/开发30秒的四种环境组合由 fake timer 精确验证。typecheck、typecheck:e2e、architecture通过，Lint 0错误/46条已有警告。未另跑Windows/Linux/手机实机；旧代码可由Git历史恢复，Hero ZIP哈希未变。

唯一 poller 替换 Banner Billing Preview 定时请求。启动/可见恢复/身份变化/语言变化/联网恢复/业务成功触发刷新；同一在途请求合并，完成后 setTimeout 调度。正式构建且 production 环境10分钟，测试/开发30秒，无随机 jitter，失败指数退避封顶10分钟；隐藏暂停，恢复立即请求。成功空数组清理候选，失败短暂保留最后有效 Banner（最多10分钟），不把网络失败当空快照。身份代次失效旧响应，账号切换清理当前操作视图。

独立 Popup 资源就绪且页面可见、无 modal/安全校验弹层后自动打开。结果弹窗优先于待展示独立 Popup；等待中的 Popup 被撤下则取消；已打开内容固定到关闭，不随轮询变更。同一 Popup 正在显示时不重复排队，关闭后后续 GET 再下发即可再次打开。关闭 Popup 不影响 Banner。

服务端是投放资格的唯一 owner；客户端不保存按 campaign_id 的 processed/shown/reported 集合，不使用广播 claim 或已处理事件抑制其他窗口。各窗口根据自己的最新 GET 展示；相同 ID、相同内容也允许在后续下发时再次展示，无需新 ID 或批次字段。campaign_id 仅关联当前投放与操作上报，不作为客户端历史黑名单。

```text
GET -> 资源就绪 -> 展示 -> 点击成功/关闭 -> 隐藏当前实例并上报
                                            | 丢弃操作完成前的在途响应
下一轮 GET -> 服务端仍下发同 ID -> 资源就绪 -> 再次展示
           -> 服务端未下发      -> 不展示
```

仅保留 Controller 当前 pending 防连点、弹窗互斥及 generation 迟到响应保护。操作完成时失效旧查询/资源准备并释放旧 deferred Banner，不让操作前快照恢复刚隐藏的内容；新的请求不受历史操作限制。成功后在当前操作收口再触发刷新；不自动重发领取请求。关闭/成功后的再次展示、再次操作都需要再次上报，不能按 Campaign 吞掉事件。

## 上报

用户关闭 Banner/独立 Popup -> 所属原始 campaign_id 的 cancel；业务明确成功或宿主接受外链 -> confirm。成功结果再关闭不重复 cancel；安全校验取消、明确业务失败、轮询撤下、下载不报 confirm。暂无线上的 show 事件。本地一次操作仅一次事件，先收口 UI 再异步上报；服务端无幂等，不重试结果不确定的 POST。上报失败记录日志，不能阻塞关闭；旧账号事件不能带新凭据发送。

### 服务端投放权威回归（2026-09-10）

- 修改前4条回归单测失败，修改后 Controller/Poller/Adapter/Resources 共24条通过；覆盖同 ID Banner 成功/关闭后再次展示及上报、Popup 再次展示、当前弹窗不叠加、操作前查询/资源/deferred 快照丢弃。
- macOS App delivery E2E 5条通过（`desktop-e2e-20260910111749436-p19940-a7dcfa2d853c65d5`）；fixture 在服务端决定撤下/重新下发且保持同 ID，验证两轮自动30秒等待，不通过改 ID 绕过客户端过滤。query 完成记录19:19:20.278和19:19:50.286，间隔约30秒；独立 Popup 再投放由 online 事件加速验证。
- 共用 fixture 的领取后权益/模型连接 E2E 1条通过，确认本轮服务端 fixture 调整未破坏相邻流程。
- `typecheck`、`typecheck:e2e`、architecture通过，Lint 0错误/46条已有警告。Controller/Provider 生产代码净删87行；Hero ZIP未改动。测试保持 manual-review/pending，不代表线上领取/真实安全校验、多窗口或 Windows/Linux/手机实机验收。

## 实施与验收

P0 spec/fixture -> P1 DTO/service/adapter -> P2 assets -> P3 controller/poll -> P4 Banner/actions -> P5 popup/report -> P6 E2E/migration。

| Case   | 场景与断言                                                        | 验证层          |
| ------ | ----------------------------------------------------------------- | --------------- |
| MTC-01 | 两资源位独立解析；坏 Banner 不影响 Popup；未知 action/layout 拒绝 | unit            |
| MTC-02 | GET/POST 必要头和原始 ID；账号切换拒绝迟到上报；POST 不重试       | service         |
| MTC-03 | Banner 校验解码前隐藏；hash 错误拒绝；相同 hash 缓存复用          | integration/E2E |
| MTC-04 | 快速连点仅一次 claim；X->loading；安全校验取消恢复                | unit/E2E        |
| MTC-05 | pending 时轮询换内容不替换动作快照；迟到响应隔离                  | unit/E2E        |
| MTC-06 | 成功事实不被刷新失败逆转；预加载/失败降级/无结果弹窗              | unit/E2E        |
| MTC-07 | 独立 Popup 不叠加；关闭后同 ID 再下发可打开；候选撤下取消         | unit/E2E        |
| MTC-08 | close cancel、success confirm、结果 close 不重报；失败不阻塞      | unit/E2E        |
| MTC-09 | hidden暂停/恢复、串行、失败退避、空数组、语言/身份代次            | unit            |
| MTC-10 | 不用跨窗口历史拦截投放；窄屏/主题/键盘；Web bundle 降级           | integration/E2E |
| MTC-11 | 同 ID Banner 关闭/成功后重新下发可展示和上报；旧响应不能复活实例  | unit/E2E        |

fixture 使用本地受控端点、真实 ZIP/哈希与 request ledger，不领取线上套餐。要求 architecture:check、typecheck、lint、相关单测与 App E2E；未实际运行的平台/路径明确留缺口。测试和完成状态另行回填，不引用旧 mock 测试冒充正式接入通过。

影响扫描：must-inspect WorkspaceSidebar/ManualClaimPlanBanner/CloudContentDialog/CloudContentService/服务注册；should-inspect 登录与安全校验、权益刷新；invariant-only task runtime/remote replay。codegraph 工具不可用，使用精确调用方搜索验证两层路径。功能图已补 marketing-touch capability、shell controller、query/report service 及 task 消息流不变边界。

## 当前实现边界

### 移除临时 App Mock

移除「内容 Mock」入口、预览组件和对应文案，以及 CloudContentService 的 status/load/clear 调试 RPC、固定 mockOrigin 与开发来源授权旁路。所有环境的 App 都只通过 Marketing Touch 获得投放与资源授权。保留 Hero ZIP、HTML 源资源、打包与自动化测试 fixture；测试服务器不挂入 App 正常启动链路。

```text
App -> Marketing Touch GET -> URL/hash 授权 -> ZIP prepare/release -> Dialog
测试 runner -> 独立 fixture server（不作为 App 回退入口）
```

验收：App 不存在 preview 入口及调试 RPC；未授权 ZIP 拒绝；已授权 ZIP 下载/缓存/iframe ready 与 confirm/cancel 保持通过。旧预览面板专属用例退役，Marketing Touch E2E 增加入口不存在断言。任务/远控同步、ZIP 包内容不变。

领取失败文案函数独立为纯模块，Marketing Touch 不再通过旧 Banner 间接引入本地 Mock payload。旧 Banner 组件及专属测试已删除，仅保留独立 Hero 测试 fixture。

移除验证：47条相关单测、2条独立 HTTP fixture 测试及3条 macOS App E2E 通过（run `desktop-e2e-20260910100604307-p7477-2c05101905c03088`）；类型/E2E类型及架构检查通过，Lint 0错误、46条已有警告。保留 ZIP 的 SHA-256 为 `aae7d25f1618d27859152d4676f6b49902ef6bbfee761eee4313499f893eeb29`。未另跑 Windows/Linux/手机端实机验证。

- 下载允许的媒体：PNG/JPEG/WebP（8 MiB），MP4（16 MiB）；不接受 SVG/任意 HTML 作为图片。资源白名单仅由宿主验证过的 GET 响应授予 URL + SHA-256，生产关闭开发 mock 入口仍可加载已授权 ZIP。图片/视频通过校验后的 data URL 消费，ZIP 使用独立安全资源服务。网络请求最多30秒，解码最多10秒；失效后丢弃结果并释放 lease，不保证取消已经送达服务端的业务请求。
- 缓存目录：宿主应用配置目录下 `cache/content-bundles/<host-instance-uuid>/`，安全解压与引用计数复用现有 ContentBundleCache；不写 workspace，也不把 ZIP entry 直接作为任意磁盘路径。
- 不使用跨窗口营销 claim 或已处理广播；安全校验和业务请求只承诺当前 Controller 的同步防连点。服务端资格校验是跨窗口领取事实的权威，无法在缺少后端幂等键时承诺全局 exactly-once。
- Web 复用组件与宿主服务，bundle 使用 fallback，不访问 Desktop loopback。独立 Web/server 若没有宿主 deviceMid，查询在 HTTP 前拒绝，不伪造新设备身份；不改变远控 host attachment 或 task realtime 链路。
- 同 Campaign 的后续下发完全服从服务端，不需要补批次标识。主题、国际化、跨平台资源策略及 desktop-continuous/web-remote-replayable 消息语义不变。

## 2026-09-10 验证记录

- 相关单测：12 个文件50条通过；随后增加生产授权 ZIP 用例，cloudContentService 3条全部通过（相关用例合计51条）。覆盖 DTO隔离、鉴权与上报、资源哈希/缓存/ZIP、Web降级、轮询、安全校验取消、资源迟到、待操作快照与弹窗互斥。
- `pnpm typecheck`、`pnpm --filter @zcode/desktop typecheck:e2e` 通过。
- `pnpm lint`：0 error，46项既有 warning；`pnpm architecture:check --changed`：0 violation。
- macOS Electron delivery E2E：3条通过，最终 run `desktop-e2e-20260910085452990-p8774-6db97d91e9675478`。真实 HTTP/ZIP/iframe ready，挂起 claim 观察 loading，ledger 断言 confirm/cancel及没有 preview 请求。
- macOS entitlement E2E：1条通过，run `desktop-e2e-20260910085137939-p2018-6b1a685ecf45e04b`。保留权益刷新、Start/Individual 及 Subagent 选择联动。
- 两个新 E2E 均位于 `packages/desktop/test/e2e/ui-shell/manual-review/pending/marketing-touch-*.test.ts`。按 e2e-case-lifecycle 保持 pending，自动通过不代表人工视觉验收或正式 suite promotion。
- 未执行：线上真实 Campaign/领取、真实安全校验服务、多窗口实机、Windows/Linux、手机 Web及双主题窄屏视觉验收；不得以本地 fixture 冒充这些验证。

2026-09-12 用户确认转正：三个 spec（delivery、entitlement、anonymous）位于 `packages/desktop/test/e2e/ui-shell/`。复跑：`pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/ui-shell/marketing-touch-*.test.ts'`，不需要 MANUAL_REVIEW 开关。fixture 自动提供 Banner、独立 Popup、ZIP Hero、挂起/释放领取与上报 ledger；不访问真实套餐。使用本机 Electron，不使用 Docker。最新证据与覆盖边界见 `docs/testing/marketing-touch-e2e-implementation.md`；上方 pending 路径是历史记录。

# 推送回归修复约束（2026-09-11）

全量门禁在 Node 24/macOS threads 池出现原生 SIGSEGV 时，可使用 `ZCODE_TEST_POOL=forks` 切换普通用例为两进程隔离模式；不改变测试集合、断言和原有串行隔离组，默认仍为 threads。此次崩溃进程 PID 88256，系统报告 node-2026-09-11-200243.ips，尚不能据此定位具体 V8/原生模块缺陷。

营销接入不得删除或回退既有非营销翻译；保留当前营销新增文案。测试服务器仅在显式启用 marketingTouch 时挂载营销 fixture，旧套餐测试不承担营销 release 握手。Root 隔离测试在 Provider 边界替换营销业务子树，避免依赖不完整和首轮模块导入超时；营销业务继续由专属单测和 App E2E 覆盖，不修改生产选择逻辑。

```text
旧套餐测试 -> 默认服务器 -> claim 直接响应
营销 E2E -> 显式 marketingTouch -> claim 等待 -> release -> 响应
```
