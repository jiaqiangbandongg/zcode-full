# 公共内容弹窗验收记录

日期：2026-09-04。用例语义来源：`docs/cloud-content-dialog-plan.md` 第 7 节 accepted cases。

## 覆盖映射

关闭按钮最新外观约定（2026-09-11）：任意 Hero 背景无法由 App 主题推断，公共内容弹窗改为圆形媒体覆盖层按钮：黑色 50% 不透明度背景、白色图标、无边框，hover 黑色 65%。样式限定于公共内容弹窗，尺寸、位置、焦点、关闭逻辑及上报不变。单测约束样式作用域，App E2E 检查亮暗主题图标/无边框、实际背景和 hover/移出恢复；以下透明 ghost 和浅色描边记录仅代表历史版本。

关闭按钮回归：8项组件单测、13项 macOS App E2E 通过（`desktop-e2e-20260911081628031-p81577-df8067a6323428fc`），实际背景默认透明、hover 非透明、移出恢复透明。类型/E2E类型/架构检查通过，lint 0错误/46条既有警告；Windows/Linux/手机实机未补。

2026-09-11 最终定位（覆盖下方两轮临时判断）：实际窗口截图 `Page.captureScreenshot({fromSurface:false})` 可稳定复现方角，默认渲染表面截图会漏掉。隐藏 iframe 后暗块消失；父层 clip-path/mask、iframe 圆角均无效；关闭 DialogOverlay 的 backdrop-filter 后暗块消失。互动 iframe 弹窗仅保留半透明遮罩，不使用背景模糊，其他媒体/普通弹窗保持原模糊。移除无效 clip-path，保留 Hero 顶部圆角。回归验证必须包含实际窗口截图；DOM 命中与默认截图不足以验收该问题。

最终验证：用户 App 原生窗口 A/B 截图在关闭 backdrop-filter 后不再出现暗块；2文件13项单测通过（互动 iframe 关闭模糊，普通图片保留模糊），隔离 App E2E 12项通过，run `desktop-e2e-20260911071241976-p81265-05dd209b62561d94`。typecheck/E2E typecheck/架构检查通过，lint 0错误/46条既有警告。没有修改 iframe 权限、消息协议或 ZIP；未补 Windows/Linux/手机实机验证。

2026-09-11 外观修订：公共内容弹窗不显示外边框，保留原圆角与阴影；Hero 槽自行按弹窗顶部圆角裁切全部媒体（含 iframe），不依赖子资源实现圆角。保留弹窗纵向滚动与关闭交互，不修改全局 Dialog、ZIP 或消息协议。单测约束外壳/裁切样式，Marketing Touch App E2E 验证真实 iframe ready 后的边框、圆角及角落命中区域。

同日反馈补充：用户截图中顶部圆角仍有方形残留，上一轮 DOM 命中断言不足以证明合成画面无溢出。当前用户 App 已加载圆角样式，CDP 截图未稳定复现残留，不能据此宣称确定了 Chromium 根因。Hero 槽增加使用同一圆角 token 的显式 clip-path，裁切整个媒体合成子树；保留外壳阴影和滚动。验证须检查计算后的 clip-path 与实际截图，不只检查 overflow 和 hit-test。

补充验证：当前 App 热更新后计算值为 `inset(0px round 16px 16px 0px 0px)`，亮色顶部放大截图无方形残留；12项单测、12项隔离 App E2E 通过（`desktop-e2e-20260911070253834-p64345-205b3da8a5ba0a07`），typecheck/E2E typecheck/架构检查通过，lint 0错误/46条既有警告。仍需用户现场确认，CDP 截图不等同于证明用户原始合成残留必定消失；Windows/Linux/手机实测未补。

| Case      | 证据                                                               | 范围                                                                                                               |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| CCD-01/02 | App pending preview + contentBundleCache/cloudContentService tests | HTTP JSON、真实 ZIP、hash/size、解包 URL、ready、缓存命中与清缓存重下                                              |
| CCD-03    | cache/service/preview unit + App 错误哈希路径                      | 拒绝坏资源、无 iframe、保留标题/说明/关闭，恢复合法场景可重试                                                      |
| CCD-04    | media unit + App preview                                           | 真图片、WebM 解码、Lottie canvas、iframe Replay；双主题；视频 reduced-motion/关闭暂停，Lottie 单测销毁             |
| CCD-05    | description unit + App preview                                     | 标签白名单、危险 URL、嵌套上限、中英、390px 视口无横溢出；不等同于真机 Web 验证                                    |
| CCD-06    | dialog unit + App preview                                          | 字段/按钮顺序、缺能力禁用、单飞、失败重试、复制本地反馈、mock 动作记录                                             |
| CCD-07    | Hero unit + App iframe origin 检查                                 | contentWindow/instanceId/channel、未知事件拒绝；无 same-origin，无法读取父 DOM                                     |
| CCD-08    | cache/service integration                                          | 同服务并发 acquire、多个 lease、清缓存保护活跃包、host 取消下载；不同 host 使用独立根，不宣称多进程共享缓存        |
| CCD-09    | 既有 start-plan-manual-claim-experience E2E + banner unit          | 成功/待生效/失败、持续轮询、复制分享、模型设置/连接导航；失败态不建 Hero                                           |
| CCD-10    | shared 类型、组件降级、Web build、390px 视口                       | Desktop 资源归本地 host，不落 workspace；Web/手机没有 Desktop loopback 入口；真实手机和远程 workspace 运行验证未做 |
| CCD-11    | spec 明确限制                                                      | markdown 仅兼容原文；正式 dismissal/频控属于后续投放，不作已覆盖                                                   |

## 运行证据

- 去除描边：10 项组件单测、定向 macOS App MTC-01/07/08 通过（`desktop-e2e-20260911-110642-086`），亮暗主题边框均为 0px，半透明背景与 hover 回归通过。架构和 Lint 通过，类型检查仍有既有模型迁移错误；未新增跨平台实机验证。

- 2026-09-11 媒体关闭按钮：10 项组件单测与定向 macOS App MTC-01/07/08 通过（`desktop-e2e-20260911-110305-161`），实测亮暗 class 下白色图标/浅色描边、默认黑色 50%/hover 65%/移出恢复，以及取消上报。使用 architecture-governance 限定公共 UI 样式作用域，按 e2e-case-lifecycle 保留 pending 回归。Lint 0 错误/49 条既有警告；全量与 E2E 类型检查仍被既有模型接口迁移错误阻断。误运行完整营销套件仍有其他用例失败，不作为本改动全部通过的证据；Windows/Linux/手机实机未验证。

- 2026-09-11 无边框/顶部裁切：先新增单测失败，再修复；2文件12项单测通过。macOS 隔离 Marketing Touch App E2E 12项通过，run `desktop-e2e-20260911065419725-p49538-44fd937cd2b33621`，包含真实 iframe 顶角不命中、圆角与外壳一致、边框为0及原交互回归。截图检查顶部裁切正常。typecheck、E2E typecheck、架构检查通过；lint 0错误/46条既有警告。此次未补 Windows/Linux/手机实机或双主题完整视觉验收，不改变原兼容边界。

- 完整 App preview：4/4 通过，`packages/desktop/.e2e-artifacts/desktop-e2e-20260904040413280-p12214-57effa9488fe0d38/summary.md`，含窄屏/reduced-motion、关闭内容回到加载按钮、关闭面板回到入口的焦点断言。
- Weekend 最终回归：4/4 通过，`packages/desktop/.e2e-artifacts/desktop-e2e-20260904040659110-p17722-92d58f3c5b964911/summary.md`。
- Web build、根 typecheck、E2E typecheck 通过；lint 0 error，40 个原有 warning。
- 最终 focused tests：10 文件 80/80 通过（含两个焦点回归）；Node HTTP mock 2/2 通过。

## 运行中发现的问题

1. 新 ZIP 依赖内联进 ESM main/host，Electron 在入口报 `Dynamic require of "fs" is not supported`。已把 yauzl 外置、列为 Desktop 运行依赖并加入产物依赖检查；实际 App 成功启动并完成 ZIP 用例，补 tsup 回归测试。
2. 两次 Weekend 回归在等待轮询期间出现额外「模型设置→返回工作区」点击，日志证明结果通过 close 关闭，而非 owner 被卸载。无该额外操作的一轮 4/4 通过；保留测试输入事件诊断，未据此修改轮询状态机。
3. `safeParse` 对 `https://` 的 refine 曾直接抛异常，已先检查 URL.canParse；补非法 URL 测试。
4. 窄屏测试曾在宽度过渡中采到 421px（目标视口 390px）；增加布局收敛等待后保持原有边界断言，无生产 CSS 放宽。
5. 受控弹窗没有 Radix Trigger，关闭后默认焦点落到 body。单测复现后补打开来源记录/恢复，预览面板使用 DialogTrigger；异步加载暂时禁用按钮会使 activeElement 丢失，预览显式传入宿主侧 returnFocusRef（不是云端字段）。真实 App 的加载按钮/入口焦点断言通过。
6. Weekend 收尾复跑有一次在领取弹窗关闭、设置导航/权益刷新完成后，Subagents 模型子菜单展开超时；只补失败现场诊断，未修改模型业务或放宽断言。相同生产代码复跑 4/4 通过。该次交互抖动未证明根因，保留为 E2E 稳定性风险，不声称已修复。

## 限制与人工验收

- 新 preview 用例保持 `ui-shell/manual-review/pending`，未自行 promotion。
- 当前在 macOS Electron 验证；Windows/Linux/真机手机未实测。跨平台路径约束由服务单测覆盖，不冒充平台运行结果。
- Web/手机云端 ZIP 托管、生产 CDN 信任/签名/投放均未接入。Desktop 缓存只保证同 host 生命周期内复用。
- mock 场景动作不调用真实业务；真实领取边界由既有 Weekend E2E 验证，不请求线上活动。
