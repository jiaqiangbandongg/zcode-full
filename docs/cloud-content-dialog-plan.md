# 云端公共弹窗：完整实施与验收计划

日期：2026-09-04。状态：Desktop mock 与公共组件 P0–P5 已交付，生产接入不在本轮范围。当前契约与使用方式见 `docs/cloud-content-dialog.md`，测试证据见 `docs/testing/cloud-content-dialog-coverage.md`。下方阶段方案和开工基线保留为设计轨迹，不代表当前缺失项。

当前交付：P0/P1 契约与运行时校验、P2 Desktop ZIP 资源服务、P3 四类 Hero 与公共壳、P4 App HTTP mock 入口、P5 Weekend 适配均已实现。完整 App preview 4/4 与 Weekend 4/4 通过；已验证真实 WebM/Lottie、ZIP 下载/校验/缓存/释放、HTML、动态按钮、中英/主题、390px 布局和 reduced-motion。收尾补充受控弹窗的关闭焦点恢复，最终结果统一记录在 coverage 文档。

开发 mock 启动：`node packages/desktop/scripts/cloud-content-mock.mjs`，默认 `http://127.0.0.1:4319/dialog`；然后启动 Desktop dev，在右下角预览入口选择内容并加载。mock 与 App 已接通，详细参数见当前 spec。

P2 使用 host 独占缓存目录、随机 lease 资源 URL、关闭释放/退出取消。缓存只保证同 host 生命周期内复用，不承诺跨进程或重启持久缓存。Web/手机未接入 ZIP 资源托管，仅完成共享组件兼容、资源不可达降级和 Web build；未冒充真机验收。P6 生产 CDN/签名/投放与公共 banner 不在本轮范围。

新 E2E 保持 manual-review/pending，自动化通过不代表人工 promotion。旧轮次错误及其修复依据保留在 coverage 记录中。

## 1. 目标、现状与边界

验收以当前 coverage 文档中的实际运行证据为准；不把 Web build 或桌面窄屏测试等同于手机实测。

目标：在 App 的开发入口，经过真实 HTTP 获取弹窗 JSON、下载 ZIP、校验解压、加载隔离 Hero，完整展示和执行云端声明的受控内容。活动只是一个使用方，新功能介绍、通知可以复用同一组件。

### 开工基线（历史，已被上述实现替代）

| 项目                  | 当前状态                                                               | 依据                                                                           |
| --------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Weekend Hero 独立资源 | 已抽取 HTML，包含星空、票券、入场、倾斜、翻转、Replay                  | `packages/ui/src/assets/cloud-content/weekend-plan-hero.html`                  |
| iframe                | 已有 sandbox 与 init/ready/theme/visibility/destroy 基础消息           | `packages/ui/src/components/cloud-content-dialog/CloudDialogHero.tsx`          |
| mock 数据             | 本地 JSON import，adapter 覆盖动态文案与 Vite HTML URL；没有 HTTP 接口 | 同目录 `mockCloudContentDialog.ts`、`mocks/weekendPlanResultDialog.zh-CN.json` |
| ZIP                   | 未实现；当前 bundle.url 仍指向 HTML                                    | 同上                                                                           |
| 公共弹窗              | 尚未形成完整壳组件，仍在 Weekend 结果弹窗内使用 Hero                   | `ManualClaimPlanResultDialog.tsx`                                              |
| 字段消费              | title/description/按钮行为尚未统一由 payload 驱动                      | 同上                                                                           |
| image/video/lottie    | 仅声明类型，渲染器未实现                                               | `cloudContentDialogTypes.ts`、`CloudDialogHero.tsx`                            |
| 简单 HTML             | 规格与测试草稿已写，生产组件未实现                                     | `packages/ui/test/cloudDialogDescription.test.ts` 引用了尚不存在的组件         |

以上仅记录开工时状态；当时新增 HTML 测试后尚未重新通过整体验证。

### 已确认与排除项

- 已确认：先做弹窗；支持 image、video、交互动画和 lottie；现有动画及交互资源化；bundle.url 是 ZIP；支持简单 HTML；App 内完整 mock 验证。
- 本轮不做：公共 banner、运营后台、自动投放/分群/优先级/频控系统、真实活动业务重写、任意远端脚本调用客户端能力。
- 后续生产接入独立验收，不用本地 mock 成功代替上线结论。

## 2. 数据契约：每个字段有明确消费者

先更新 shared 类型和运行时 schema，再写对应契约测试。以下是建议冻结的 v1 契约，不是当前已实现接口。

| 字段               | 语义与消费者                            | 校验/失败处理                                            |
| ------------------ | --------------------------------------- | -------------------------------------------------------- |
| schemaVersion      | 解码器选择协议版本                      | 未支持的主版本拒绝展示并记录原因                         |
| id / revision      | 内容身份与内容版本；用于日志、关闭记录  | 非空 ID、正整数 revision；不作为 ZIP 缓存 key            |
| kind               | campaign / feature / notice 分类        | 不以 kind 注入 Weekend 特判                              |
| locale             | 返回内容的实际语言                      | 请求携带 locale；mock 提供中英 fixture，回退语言显式可见 |
| dialog.title       | 公共标题组件                            | 纯文本、长度上限                                         |
| dialog.description | format + text                           | plain_text / html；markdown 的正式支持策略见待确认项     |
| dialog.hero        | 联合类型渲染器                          | 未知类型不执行，降级为无 Hero；壳与关闭保持可用          |
| dialog.buttons[]   | 按顺序渲染 id、label、variant、actionId | ID 唯一、数量/文案上限、actionId 必须可解析              |
| actions            | 宿主 ActionDispatcher 白名单            | 未声明/不可用动作不可执行；禁止动态代码/任意服务名       |

### Hero 专有字段

| 类型               | 字段                                                      | 客户端责任                                                     |
| ------------------ | --------------------------------------------------------- | -------------------------------------------------------------- |
| image              | src、darkSrc?、alt、fit?                                  | HTTPS 来源校验、主题选图、加载失败占位                         |
| video              | src、darkSrc?、poster、autoplay?、loop?、muted:true、fit? | 静音播放、后台/关闭暂停、自动播放失败显示 poster、减少动态效果 |
| lottie             | src、darkSrc?、autoplay?、loop?、speed?、fallback?        | 受限 JSON 与外部资源策略、播放器销毁、错误降级；依赖先核查复用 |
| interactive_bundle | runtime、bundle、viewport、data、events、fallback?        | 下载解析资源、iframe 隔离、握手、超时与事件校验                |

建议 interactive bundle 增加 `format:"zip"`、`sha256`、`sizeBytes`；保留 `url` 和相对 `entry`。SHA-256 由构建真实生成，不能写占位哈希通过测试。viewport 使用客户端约束的比例，首个 fixture 仍为 4:3。data 只允许有限大小的 JSON，不传账号凭据、宿主路径或服务句柄。

```json
{
  "bundle": {
    "format": "zip",
    "url": "http://127.0.0.1:<mock-port>/bundles/weekend-hero.zip",
    "entry": "index.html",
    "sha256": "<打包后生成的 SHA-256>",
    "sizeBytes": "<打包后生成的整数>"
  }
}
```

以上是模板而非可直接提交的合法 fixture；生成器填充端口、哈希和整数大小。HTTP 例外仅在显式 dev/test 模式启用，生产只接受可信 HTTPS 来源，重定向也重新校验。

### Description 与动作

- 简单 HTML：保留 p/br/b/strong/i/em/u/s/ul/ol/li/code/a/span/time；客户端控制排版。禁止脚本、样式、事件属性、图片、表单、嵌入内容和危险 URL。不可信 DOM 不直接挂入页面；白名单重建并测试解析器边界。建议输入上限 20,000 字符、深度 32，超限纯文本回退。
- 链接只允许绝对 HTTP(S)，点击通过平台接口；动态业务值先转义。中文、英文、长文、列表、键盘导航均需覆盖。
- `close` 仅关闭当前实例；`dismiss_content` 表示不再提示，两者不得混同。建议 mock 的 dismissal 存 dev 专用命名空间，正式账号/版本频控归后续投放设计。
- `navigate` 仅允许注册目的地；`copy_text`、`open_external` 只能由宿主按钮的用户操作触发。
- `claim_plan` 如保留，必须通过注入的业务处理器重走登录/资格/确认/幂等，不由公共组件执行领取。mock 用无真实副作用的处理器。
- iframe 事件默认只允许已登记的展示事件，例如 Replay。不能把 iframe 消息直接映射成领取、导航、剪贴板等敏感动作；删除“未知事件按原 ID 透传”的行为。

## 3. 架构与状态归属

```text
App dev preview / Weekend adapter
        |
        v
ContentSource -> HTTP JSON -> runtime schema -> Public ContentDialog
                                                   | title / description / buttons
                                                   |                    |
                                                   v                    v
                                              HeroRenderer       ActionDispatcher
                                                   |              -> injected handler
                                                   v
                                            ContentAssetResolver
                                                   |
                     +-----------------------------+--------------------+
                     | Desktop                     | Web/mobile         |
                     v                             v                    |
              local host asset service      platform asset adapter      |
              ZIP -> verify -> safe unzip   same bundle contract        |
              -> cache -> scoped URL        -> browser-loadable URL     |
                     +-----------------------------+--------------------+
                                                   v
                                            sandboxed iframe
                                       load -> init -> ready
```

| 状态/事实          | 权威 owner                   | 缓存或镜像             | 副作用落点                |
| ------------------ | ---------------------------- | ---------------------- | ------------------------- |
| 内容 payload       | mock/未来内容服务            | ContentSource 内存缓存 | 不改变领取结果            |
| 展示/焦点/加载状态 | 单个 Dialog 实例             | 无跨窗口同步           | React 本地状态            |
| ZIP 与完整性       | 内容资源服务                 | 按 hash 缓存           | App cache，不落 workspace |
| Hero 内动画        | iframe                       | 无业务镜像             | iframe 自身 DOM/RAF       |
| 导航、分享、领取   | 已有宿主能力/业务 Controller | 不复制到 iframe        | 注入的处理器              |
| dismissal          | 暂仅 dev preview 命名空间    | 按 id+revision         | 正式账号范围另定          |

Main 只做必要的平台路径注入、资源通道注册/透传，不承担 ZIP 下载、解压业务。UI 通过 hook/服务与平台注入，不直接访问 Repo、文件系统或 window bridge。

### ZIP 缓存与失败时序

建议目录（待运行时确认平台根目录后记录实际绝对路径）：

```text
<platform app cache>/content-bundles/
  staging/<unique-attempt>/
  <sha256>/index.html
  <sha256>/assets/...

absent -> downloading -> verifying -> extracting -> ready
                     failure -> discard staging -> retryable error
ready -> acquire lease -> render -> release lease -> eligible for eviction
```

- 所有 IO 异步；同 hash 并发去重。关闭实例释放引用；不能误取消其他实例仍使用的下载。
- 下载大小/时间、解压后总大小、单文件大小、文件数均由客户端固定上限，服务端声明不能放宽。实际计数不能仅信 ZIP 元数据。
- 拒绝绝对路径、`..`、符号链接、重复/冲突条目和跨平台路径逃逸；检查 entry 存在且为允许 HTML 文件。处理 ZIP bomb、哈希不符、下载中断、磁盘满、并发写入。
- staging 校验成功后同文件系统原子提升；未完整的缓存不可见。资源 URL 仅暴露已验证包内路径，不暴露任意磁盘读取能力。
- 缓存按体积预算与最近使用清理；正在使用的资源不可清理。清缓存和重试提供 dev 控件与可观察证据。
- ready 超时建议 5 秒、单次下载超时建议 30 秒，具体阈值在测试与资源体积验证后冻结。失败显示 fallback 或空 Hero，不阻塞标题/按钮/关闭。

### 多端边界与未知项

事实：尚未实现跨端资源加载适配，不能把桌面路径当作手机 URL。

建议先做技术验证再冻结传输：Desktop 使用受限本地资源通道；普通 Web/手机使用可信服务的同 hash 解包静态 URL，或者受控 Web 资源适配器。哪一种取决于现有托管能力，不能默默增加公开资源服务器。若需要 shared-host 转发，只复用现有鉴权 attachment，不另起 Agent/runtime，需先读远控架构文档再定接口。

必须验证 iframe 子资源、CSP、隔离 origin、MIME、缓存与失效行为。普通 Web 或手机缺能力时给明确 fallback，不宣称四种 Hero 全端完成。桌面处于 SSH/WSL/Docker workspace 时资源仍归 App 本地，不上传远端 workspace。

## 4. 安全边界

- ZIP 哈希证明内容一致性，不证明发布者可信；生产另需可信 HTTPS 来源与发布认证策略，签名是否强制由发布架构确认。
- iframe 保持 `sandbox="allow-scripts"`，不启用 same-origin/forms/popups/top-navigation，不接触 Node/preload。
- 宿主资源通道执行 CSP/来源隔离，不能仅信远端 HTML 自带 CSP。限制 connect/frame/object/form 等外联，防止资源偷偷联网外传 data。
- 消息检查当前 contentWindow、instanceId、channel、类型、事件白名单及载荷上限；旧 iframe/其他窗口/重复 ready/乱序消息不得串状态。
- 不可信内容日志不输出完整 HTML、data、凭据或带敏感参数 URL；高频动画事件不进入生产 info 日志。

## 5. 影响扫描（Impact Brief）

模式：planning。层级：presentation、validation、commit-effect、persistence。主 seeds：CloudDialogHero、createWeekendPlanResultDialogMock、ManualClaimPlanResultDialog。

| 场景/UI 入口            | 共享实现                   | 默认来源与校验               | 提交/持久化                    | 模式隔离                          |
| ----------------------- | -------------------------- | ---------------------------- | ------------------------------ | --------------------------------- |
| Weekend 领取结果        | 公共 Dialog + 业务 adapter | 已有 claim 结果，公共 schema | 原 Controller 导航/分享/领取   | 不改变登录/安全校验/provider 刷新 |
| App dev preview（新增） | 同一 Dialog                | HTTP fixture，显式选择场景   | mock 动作、dev dismissal/cache | 不依赖真实领取，不进入生产入口    |
| 普通 Web/手机           | 同一 UI，不同资源 adapter  | 同一 schema + 能力检查       | 当前端导航/平台能力            | 不复制桌面文件路径、task 恢复状态 |

共享：字段解析、排版、Hero 协议、动作白名单。差异：资源加载方式、平台动作可用性、入口业务数据与 dismissal 范围；不强行统一业务 owner。

| 级别           | 关系与原因                                                                      | 证据                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| must-inspect   | ManualClaimPlanBanner -> ResultDialog -> Hero/mock；唯一已发现生产入口          | 上述组件源码，rg 直接调用方，深度 2                                                                                      |
| must-inspect   | mock fixture -> 类型 -> renderer，三者当前未完整对齐                            | cloud-content-dialog 目录                                                                                                |
| should-inspect | 平台服务、资源通道与缓存；新增 IO 边界                                          | `packages/shared/src/platform.ts`；`packages/desktop/src/main/localMediaPreviewProtocol.ts` 为邻接种子，不直接假定可复用 |
| conditional    | Web/mobile 可访问资源方案                                                       | 待定的传输适配，不扩展 task/Agent 协议                                                                                   |
| invariant-only | 登录/claim/provider 权威、continuous/replayable、workspace 隔离                 | 现有 manual-claim coverage 与仓库架构约束                                                                                |
| evidence-only  | Hero 单测、manualClaimPlanBannerInteraction、start-plan-manual-claim-experience | 现有测试；不能代替新 ZIP 流程测试                                                                                        |

Codegraph 工具当前不可用，使用精确 rg 追踪上述 seeds 与直接调用方；不把所有静态可达组件当功能影响。现有功能图已有 cloud-content-dialog/shared-cloud-dialog-hero 及 Weekend 关系。graph drift：名称可能让读者误认为完整能力已实现，应由本文状态澄清。graph delta：新增 dev surface、asset-service/cache 关系为 proposed，待适配方案确认后写回；本轮不把未实现 owner 写成事实。

## 6. 实施阶段与交付门槛

P5 迁移约定：Weekend 成功态只构造 payload、注入导航/复制能力与本地复制成功提示，不再自建按钮/描述展示壳；失败态保持原业务确认框。公共组件保持 480px 上限、4:3 Hero、同排可换行按钮，窄屏内容滚动。复制成功文案是宿主本地化 label，不允许资源消息触发剪贴板。生产 Weekend 仍使用随 App 打包的 HTML 作为显式 `resolvedUrl`，不依赖开发 HTTP 服务；远端 mock 的 bundle 则必须是真实 ZIP，并走宿主 prepare。这两种来源必须在类型与文档中区分，不宣称生产已接云端。

每阶段顺序：更新 spec/用例 -> 写测试 -> 实现 -> 验证。阶段结束提供产物路径、测试输出和剩余风险。

| 阶段                        | 工作                                                                              | 完成门槛                                                                |
| --------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| P0 契约与技术验证           | 冻结字段、错误策略、动作权限；验证 Desktop/Web 资源加载；处理 HTML 未完成测试状态 | schema/fixture/适配接口设计一致；多端方案有证据，未决项明确             |
| P1 资源与 mock HTTP         | 将当前 HTML 打 ZIP；生成真实 hash/size；提供 JSON/ZIP/错误场景路由及启动命令      | 能直接请求真实 JSON、下载 ZIP，解包后动画自包含；无 Vite URL 偷换       |
| P2 资源服务                 | 异步下载、验证、安全解压、缓存、URL 解析、取消/清理/错误码                        | 首次下载与缓存命中、污染缓存、恶意 ZIP、并发均通过集成测试              |
| P3 公共组件                 | Dialog 壳、四类 Hero、标题、简单 HTML、动态按钮、ActionDispatcher、加载/错误状态  | 改 JSON 可改变全部可见字段与允许行为；无 Weekend 特判；键盘与焦点正常   |
| P4 App mock 闭环            | dev-only 预览入口；场景选择、主题/语言、清缓存、重试、状态信息                    | 在 App 内从 HTTP 到 ZIP/cache/iframe ready 全链路可见，不需要登录或领取 |
| P5 迁移与回归               | Weekend adapter 迁移到公共组件；移除临时重复描述/按钮实现；补多端验证             | 原领取流程、失败结果、导航和分享保持；四类 Hero 与中英/双主题/窄屏通过  |
| P6 生产云端接入（后续独立） | 替换数据源、可信 CDN/发布认证、账号隔离、正式投放策略、灰度/回滚                  | 服务端契约联调、安全与发布门禁通过；未完成前只称 mock 完成              |

P2 与 P3 都依赖 P0/P1 契约，P4 合流后才是用户可验证的完整 mock。不以只建好 React 组件作为完成标准。

## 7. 用例规划、剪枝与 E2E 交接

App mock 验收入口已进入实现：`ui-shell/manual-review/pending/cloud-content-preview.test.ts` 覆盖 CCD-01/02/03/04/05/06 的代表路径。用例拥有 loopback 4319 fixture 服务（与开发入口默认地址一致，端口占用即失败，不连接他人的 fixture）；宿主使用 E2E 独立数据目录。此用例无模型请求、无真实领取；新用例保留 pending，自动化通过不等同于人工 promotion。

澄清记录：用户已确定弹窗优先、四类 Hero、ZIP 和简单 HTML；未定义生产投放规则，不从“公共弹窗”推导自动弹出/不再提示策略。

领域：内容展示、资源下载/持久化、平台能力、安全验证纳入；模型配置、conversation 状态、Agent runtime 不纳入实现，仅保留隔离回归。

维度：Hero 类型 × 内容有效性 × 网络/缓存状态 × 主题/语言/屏幕 × 动作能力。高风险交叉项：ZIP 路径与 Windows 路径规则；多实例与取消/清理；手机与桌面资源 URL；HTML 与链接/动态插值；iframe 事件与业务权限。

| Case ID | setup -> action                                  | 断言及证据层                                                          | 状态                                       |
| ------- | ------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------ |
| CCD-01  | 空缓存 -> App preview 打开互动 Hero              | HTTP JSON/ZIP 请求、hash 对应缓存文件、iframe ready、内容来自 fixture | accepted/planned E2E                       |
| CCD-02  | 已缓存 -> 重开/切 revision 相同 hash             | 不重复 ZIP 下载；新文案生效，包内容一致；网络+文件证据                | accepted/planned integration + E2E         |
| CCD-03  | 404/中断/超时/hash 错误/恶意 ZIP -> 打开         | 不执行坏资源，不留 ready 污染缓存；fallback 与关闭可用                | accepted/planned integration，代表错误 E2E |
| CCD-04  | 四类 Hero -> 打开、主题切换、后台、关闭          | 正确显示、暂停/销毁、无残留监听或动画；UI+runtime                     | accepted/planned E2E                       |
| CCD-05  | 中文/英文、窄屏、长 HTML -> 展示/键盘操作        | 排版、滚动、焦点恢复、标签白名单、安全 URL；UI+DOM                    | accepted/planned unit + E2E                |
| CCD-06  | fixture 修改按钮顺序/文案/action -> 点击         | 按数据渲染，仅命中注册处理器；未知动作不可执行                        | accepted/planned unit + E2E                |
| CCD-07  | 错误窗口/instanceId/事件 -> postMessage          | 无状态串写、导航、复制或领取副作用                                    | accepted/planned unit + runtime test       |
| CCD-08  | 多窗口同 hash、关闭一个、清缓存 -> 继续使用      | 下载不被误取消；使用中包不被删除；lease/文件证据                      | accepted/planned integration               |
| CCD-09  | Weekend 成功/待生效/失败 -> 操作                 | 原领取刷新/导航/分享断言不变；成功公共描述、失败不建 Hero             | accepted/update existing E2E               |
| CCD-10  | Desktop local/远程 workspace、Web/mobile -> 打开 | 不另建 runtime；资源可达或明确降级；不改任务流                        | accepted/planned；传输方案待定             |
| CCD-11  | markdown / dismiss_content 正式策略              | 产品语义未冻结，不宣称已覆盖                                          | undefined                                  |

剪枝：恶意 ZIP 各路径变体主要在服务集成层穷举，E2E 保留一例；主题/语言在共享 renderer 上成对覆盖，不重复穷举所有网络故障；远程 workspace 不按 SSH/WSL/Docker 全乘，因为资源归 App，但需代表性运行检查。自动投放/账号频控组合因明确不在 mock 范围而 pruned，不是假定支持。

E2E fixture：本地独立 mock server 随机端口，临时缓存根目录，生成可校验 ZIP，动作记录器替代真实领取；等待请求/ready 状态，不用固定 sleep。需记录网络、文件与 UI 三层证据。Docker/container preset 待实现时按已有 harness 选择，不能以当前 formal-proof（只覆盖 conversation）冒充弹窗覆盖。

回填：已新增 `docs/testing/cloud-content-dialog-coverage.md` 并更新现有 Weekend coverage。新 E2E 已实现并通过，仍保持 manual-review/pending，待人工 review，不自动 promotion；上表保留原 accepted/planned 设计记录。

质量门禁：focused unit/integration、App E2E、`pnpm typecheck`、`pnpm lint`、受影响格式检查、Web 构建；macOS/Windows/Linux 与手机无法实测的项明确列风险，不记作通过。

## 8. 上线、回滚与未决项

mock 数据源和 preview 只在 dev/test 显式启用；生产构建不显示入口。迁移期间保留可切换的数据源/业务 adapter，使回滚不回滚用户领取状态。未知协议拒绝、资源失败降级、版本缓存不可变；生产可停发某内容，客户端仍可关闭已打开实例。

建议默认值，实施前冻结：

1. 首轮保证 plain_text + 简单 HTML；markdown 要么补安全排版，要么明确移出 v1 支持集合，不能继续“类型接受但没有对应功能”。
2. mock 先手动触发，不做自动投放；close 不持久化，正式 dismiss_content 账号与 revision 语义待产品确认。
3. Web/mobile 资源托管方案需技术验证与部署能力确认；若暂不具备，只能宣布 Desktop mock 完成，不能宣布全端完成。
4. 生产发布签名、可信域名、资源预算与保留期限尚未确定；这些阻塞 P6，不阻塞离线 fixture 与 Desktop mock 开发。

最终 mock 验收：在 App 内只修改/切换 HTTP fixture 就能展示活动或新功能介绍；四类 Hero、标题、HTML 描述、动态按钮均按数据生效；互动 Hero 确实经过 ZIP 下载校验与缓存；首开/重开/失败/重试可证明；业务副作用受控；兼容范围与剩余限制写清楚。
