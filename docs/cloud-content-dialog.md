# 公共内容弹窗与 Hero 资源

更新日期：2026-09-10。范围：客户端公共组件与 Hero 资源；正式投放接入与 Banner 语义见 [marketing-touch-client.md](marketing-touch-client.md)，不包含运营后台。

## 当前实现

Banner presentation 支持宿主视觉消息 `{channel:"zcode-cloud-hero-v1",type:"hover",instanceId,hovered:boolean}`，仅 ready 后发送，减少动态效果时为 false。不是业务 action；iframe 继续不可聚焦、不接收原生指针、忽略包内 action。弹窗 Hero 不接收该桥接，仍使用原生交互。详见 Marketing Touch 的 Banner hover 桥接规范。

关闭按钮采用与 Hero/App 主题无关的媒体覆盖层配色：黑色 50% 不透明度背景、白色 X，无边框；hover 背景加深到黑色 65%。保持圆形、原尺寸和焦点/关闭/上报路径，不新增服务端字段，不修改 Banner 或全局 Dialog。

- `CloudContentDialog` 是公共展示壳，消费 title、description、hero、buttons、actions。由 Marketing Touch 的独立 Popup 与成功结果弹窗共用。
- App 不再提供临时 Mock 入口或下发 RPC；测试服务器独立提供合法 payload 与 ZIP fixture。
- Desktop local host 下载、校验、安全解压与缓存，通过随机 lease 的 loopback URL 提供资源，iframe 保持 `sandbox="allow-scripts"`。
- image/video/lottie/interactive_bundle 均已实现。Lottie 使用固定 5.13.0 light canvas，按需加载。
- App 左下角已改接 Marketing Touch，成功弹窗取投放的 `success_popup`，Hero ZIP 来自服务端授予的 URL/hash。旧 Weekend Banner/结果弹窗 adapter 已删除，Hero 构造 fixture 仅留在 test/helpers，不进入 App。
- `mocks/weekendPlanResultDialog.zh-CN.json` 是**内容模板**，不含 bundle 元数据；mock server 注入真实 ZIP 字段后才成为合法 HTTP response。

## 使用与验证

App 使用 Marketing Touch GET 下发，不再有「内容 Mock」按钮，也不读取 `CLOUD_CONTENT_MOCK_ORIGIN`。CloudContentService 只负责已授权资源的 readPublishedMedia / prepare / release，不再暴露 status / load / clear 调试 RPC。

Hero ZIP 及 HTML 源资源现由独立制作工作区维护，App 仓库的旧资源目录已归档移除；位置与验证命令见 [资源制作迁移](weekend-banner-resource-bundle.md#2026-09-12-制作工作区迁移)。自动化测试服务器 `packages/desktop/scripts/cloud-content-mock.mjs` 及其 fixture 保留，仅由测试调用或单独运行，不接入 App 启动链路。

接口 fixture 测试：`node --test packages/desktop/scripts/cloud-content-mock.test.mjs`。App 验证使用 `marketing-touch-delivery.test.ts`，同时断言旧入口不存在和授权 ZIP/上报流程正常。旧预览面板专属 UI 单测及 E2E 已退役，历史代码可从 Git 恢复。

## v1 字段契约

权威定义是 `packages/shared/src/cloudContent.ts` 的 Zod schema；UI 类型从其推导，不维护第二套 wire 类型。

| 字段                      | 消费者与约束                                                               |
| ------------------------- | -------------------------------------------------------------------------- |
| schemaVersion             | 必须为 1                                                                   |
| id / revision             | 非空内容 ID（最多 128 字符）/正整数版本；隔离 Dialog 实例异步状态          |
| kind / locale             | campaign、feature、notice / zh-CN、en-US；不以 kind 注入活动业务           |
| dialog.title              | 纯文本，1–500 字符                                                         |
| dialog.description        | format、text；文本最多 20,000 字符                                         |
| dialog.hero               | 四类联合类型，见下表                                                       |
| dialog.buttons            | 最多 4 个，ID 唯一；label 最多 200 字符；variant 为 primary/secondary/link |
| button.actionId / actions | 引用必须存在；actions 最多 16 项；仅注册的宿主 handler 可执行              |

| Hero 类型          | 字段                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------- |
| image              | src、darkSrc?、alt、fit?                                                                     |
| video              | src、darkSrc?、poster、autoplay?、loop?、muted:true、fit?                                    |
| lottie             | src、darkSrc?、autoplay?、loop?、speed?（0.1–4）、fallback?                                  |
| interactive_bundle | runtime:zcode-hero-sandbox-v1、bundle、viewport:{aspectRatio:"4:3"}、data、events、fallback? |

bundle 必须包含 `format:"zip"`、`url`、`entry`、`sha256`（64 位小写十六进制）；`sizeBytes` 可选，提供时必须为正整数且匹配实际大小。服务端 Marketing Touch 无大小字段，下载及展开的实际字节上限仍强制执行。HTTP mock 使用实算元数据，不能以占位哈希通过校验。

`resolvedUrl` **不是云端字段**，shared schema 会剥离它；仅宿主 prepare 成功或 App 自带可信资源 adapter 设置。没有 resolvedUrl 的互动 Hero 只显示 fallback/占位，绝不直接加载 bundle.url。

data 为不含凭据的 JSON 对象，序列化最多 64,000 字符；events 为最多 16 项的展示事件映射。URL 只允许无用户名/密码的绝对 HTTP(S)；开发源允许 loopback HTTP，生产资源必须匹配宿主已验证投放授予的 URL/hash。

### Description

- `plain_text`：按纯文本显示。
- `html`：简单 HTML；支持 p/br/b/strong/i/em/u/s/ul/ol/li/code/a/span/time，以及 h1–h6/blockquote/pre/hr/del/table/thead/tbody/tr/th/td。
- `markdown`：支持段落、标题、强调、列表、引用、代码、链接、表格，经共享安全渲染器排版；内嵌 HTML 按文字显示。
- Marketing 适配后的 `formattedTitle` / `formattedLabel`（仅 UI 字段）保留 format/text，支持与 description 相同的三种格式。标题/按钮将块级节点转为 span，链接不生成交互；旧 title/label 字符串调用仍兼容。
- class 保留并与默认 Tailwind 类合并，仅已编译类生效；style 按 cloudDescriptionStyle 属性/值规则过滤。拒绝 id、事件属性、图片、script、iframe、表单、SVG。不支持元素及其子树丢弃。
- inert template 解析后重建 React 白名单节点；不把远端 DOM 直接插入可见页面。深度最多 32，超限纯文本回退。
- 链接仅保留 HTTP(S) href/title，经宿主 open_external handler 打开；缺能力时退化为文字。
- 默认排版使用客户端主题；允许的 class/style 可覆盖。Weekend 动态权益与时间先转义再组合 HTML。

### Actions

close 关闭当前实例；dismiss_content 交给注入 handler 成功后关闭，正式账号/revision 频控未实现。navigate 只接受 model_settings/plugin_store/settings；copy_text、open_external、claim_plan 均需宿主注入能力，公共组件不直接访问平台或业务服务。

按钮按 payload 顺序显示；缺 handler 禁用；同实例 single-flight；失败反馈、可重试，关闭始终可用。复制成功显示宿主本地化 label，不修改 payload。关闭/重开后旧 Promise 不得影响新实例。受控弹窗关闭恢复仍在页面中的打开来源焦点。

## 架构与时序

```text
App -> Marketing Touch GET -> DTO/schema -> 授权 URL/hash
  -> prepare(bundle) -> 下载 -> SHA-256 -> 安全解压 -> host cache
  -> lease scoped URL -> 公共 Dialog -> sandbox iframe -> init -> ready
                              | 标题 / HTML / 按钮          | 展示交互
                              v                           v
                         注入宿主 handler             iframe 内部 DOM

关闭 -> 失效本实例请求 -> destroy/remove iframe -> release lease
旧请求迟到 -> 释放其 lease，不重新打开弹窗
宿主退出 -> 取消下载 -> 关闭资源 HTTP -> 释放 lease -> 删除自有缓存目录
```

Main 不承担资源下载/解压业务。服务通过 ServiceCollection/RPC 注入，UI 通过 hooks 访问。资源与 workspace/task 无关，不落项目目录、不传远程 workspace、不另建 Agent。

### 缓存与资源 URL

Desktop 的实际目录：

```text
<ZCode data base>/.zcode/v2/cache/content-bundles/<host-instance-uuid>/
  staging/<unique-attempt>/
  <sha256>/index.html
  <sha256>/.bundle.json
```

正常用户 data base 为用户目录；E2E 使用 runner 的隔离目录。每个 host 独占根，同 host 重开复用；不同 host 不共享内存 lease。**缓存不承诺跨 App 重启复用**。正常退出删除自有目录，崩溃残留不被其他活跃 host 随意清理。

- ZIP 最多 8 MiB、展开最多 32 MiB、单文件最多 8 MiB、128 个条目、缓存预算 128 MiB。
- 下载最多 30 秒，至多 3 次重定向，逐跳来源校验；实际字节数必须与声明一致。
- 拒绝绝对路径、路径穿越、反斜杠、Windows 保留名称、符号链接、重复路径/大小写冲突、包内自带缓存 manifest。
- 独立 staging，完整校验后原子提升；命中缓存重新检查 manifest 和文件摘要。
- acquire/read/release/clear 服务内串行协调；清理跳过活跃 lease；释放后按预算/LRU 清理。
- HTTP 只监听 127.0.0.1 随机端口，路径以不可预测 lease 开头，只读 manifest 内文件。release 后原 URL 返回 404。
- CSP 禁止 connect/frame/object/form，脚本只能在无 same-origin 的 sandbox 内运行；响应带正确 MIME、nosniff/no-referrer/no-store。
- yauzl 作为 Desktop 外部运行依赖保留，避免 ESM 内联其 CommonJS require("fs") 导致启动失败；打包校验包含该模块。

### Hero 生命周期与隔离

4:3 固定 Hero 区，480px 弹窗上限、窄屏自适应和纵向滚动。视频 muted/playsInline，隐藏/reduced-motion/关闭暂停；Lottie 关闭销毁，JSON 最多 2 MiB、50,000 节点、40 层，禁止外部图片、字体、表达式。

交互资源保留星空、票券、入场、空闲压感、指针倾斜、点击翻转、Replay。load 后发送 init（instanceId/theme/locale/reducedMotion/data）；5 秒无 ready 则 fallback。消息只接受当前 contentWindow + instanceId + channel；未知展示事件丢弃。iframe 展示事件不连接业务动作 dispatcher。

权益图标使用用户提供的 Lucide Gift SVG（三条 path 与一个 rect），不再使用字符 ◇。SVG 内联到资源模板，按权益行克隆；12×12px，stroke=currentColor，复用 ticket-accent 主题色，aria-hidden=true；文案继续使用 textContent，不把远端字符串作为 SVG/HTML 执行。

历史 Gift 版产物：归档中的 `marketing-touch-weekend-v3/weekend-plan-hero-v3.zip`，7041字节，SHA-256 `6cfaae6807b181c3c38eb1be1f3f8a348a2eb67e940495f864b35e3ccf8067c0`。同目录的下发示例及旧 v1/v2 一并保留在资源制作工作区归档，仍需上传后替换服务端 URL/hash 或 asset_id；不是当前构建输出。

Gift 验证：新增 SVG 路径断言修改前失败，修改后10条相关单测、5条 macOS App E2E通过。可见性断言等待入场完成，避免把翻转中暂时隐藏的正面误判成图标缺失；保留双主题翻转、重播和上报回归。类型/E2E类型/架构通过，Lint 0错误/46条已有警告，其他平台实机未验收。

Weekend Hero 动效修复：包内 JS 是动画状态唯一 owner。入场结束或被点击打断时清理 is-entering，原生 Y 轴背板仅在入场期间隐藏，不得永久 visibility:hidden；正面、原生背面和入场背板复用同色背景与票券缺口遮罩。重播先取消上一轮动画和压感，再开始新入场；快速重复重播不叠加动画。隐藏/减少动态效果时不调度空闲 RAF，恢复可见再继续；destroy 取消动画，资源消息仅接受 parent。

```text
init/replay -> 取消旧动画 -> entering -> animationend -> idle
entering/idle -> 点击 -> 清理入场状态 -> rotateY（同色背板） -> idle
visibility=false/reducedMotion -> 停止RAF；destroy -> 停止全部动画
```

本轮不重设计星空或改营销接口。继续兼容既有 init/data/theme 协议，App 的套餐展示数据映射暂保留；不声称与原 React Hero 像素级一致。输出新目录 ZIP 和匹配元数据，保留旧包；服务端上传新包后必须同步新 URL/hash。验证包含入场后左右180度中间帧、双主题背板、重播，以及 App 成功弹窗/上报链路。

验证（2026-09-10）：旧资源4条生命周期单测失败，App 测试复现入场状态未结束；修复后9条相关单测、2条 HTTP fixture 测试、5条 macOS App E2E通过。浅/深主题、左/右180度中间帧均为可见同色背板，正反面 mask 一致。类型、E2E类型、架构通过，Lint 0错误/46条已有警告。未做 Windows/Linux/手机实机和人工像素级验收，E2E保留 pending。

历史产物：归档中的 `marketing-touch-weekend-v2/weekend-plan-hero-v2.zip`，6707字节，SHA-256 `db3acb08ba1aae3f74e8735774217a5c8c295ecb34b9268b53f9a48b25ca2712`。同目录可读 index.html、元数据及下发示例、旧 `marketing-touch-weekend` 包均保留在资源制作工作区归档；ZIP 内源码与当时源码一致，不再表示最新源码。示例 CDN URL、plan_id、asset_id 仍需上传后填写，不表示已部署。

投放 JSON 获取/校验失败沿用 Marketing Touch 的失败策略；资源准备失败仍展示已校验标题/描述/按钮。运行中错误降级 Hero，不阻塞关闭。

## 多端与上线边界

公共 UI 与 App 自带 HTML 可由 Desktop/Web/手机复用；手机窄屏使用相同组件。App 的临时开发预览入口已移除。Web/mobile **不得使用 Desktop loopback URL**；未解析的远端 bundle 使用 fallback/占位，不执行 ZIP。

Web/手机真实 ZIP 资源托管未接入，Desktop 投放客户端已接 Marketing Touch，但真实后端仍待联调，不能把 Desktop E2E 通过描述成全端云端上线。未改变 desktop continuous / web remote replayable、owner/lease、workspaceIdentity 或 Agent 协议；这里的资源 lease 不是 task owner lease。

生产阶段另验收：可信 HTTPS/CDN 发布认证、签名、账号隔离、投放频控、灰度/回滚与 Web 资源托管。SHA-256 仅证明字节一致，不证明发布者可信。

完整阶段计划与验收记录见 [cloud-content-dialog-plan.md](./cloud-content-dialog-plan.md)。
