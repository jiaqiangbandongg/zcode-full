# 会话分享与继续工作 V1

## 状态

- 当前事实 spec，日期：2026-08-31。
- API 基线：会话分享接口 revision 27，加 2026-08-12 联调约定。
- 本文同时约束发布端、Desktop 导入端和同仓库 `packages/web` 的独立 share 落地页契约。

## 产品边界

V1 支持 Desktop 本地、SSH、WSL、Docker workspace 发起分享。手机 `/remote` 和普通 Web
不得发起分享；`packages/web` 的 `/cn/share/:share_code` 只消费 preview API 并通过 deep link 唤起 Desktop。Desktop Server
Remote 首期不支持。

运行中的会话可以分享此前已经完成的 product turn；运行中的 turn 可展示但不可选择。分享选择以
`productTurnId` 为身份，`rowId` 只用于 timeline 定位。标题默认当前任务标题并允许仅为本次分享编辑，
新分享草稿进入确认 Dock 时权限默认 `public_importable`（拥有链接的人可导入并继续）；用户显式切换
权限后，返回选择阶段或重新打开同一草稿都保留该选择。

```text
Desktop UI
  -> workspace-scoped ConversationShareService
       |- 本地 JWT / Share API
       |- local/remote Conversation Rows + fileChanges
       `- local/remote artifact staging
  -> prepare -> upload -> confirm -> share URL

Web preview
  -> https://zcode.z.ai/cn/share/<share_code>
  -> zcode://share/import?code=<share_code>
  -> Desktop continuation
  -> 当前本地 workspace 新 task/session + shared_context + 全部产物
```

Share 落地页是独立静态构建：`pnpm run build:web-share` 使用 Vite `base=/cn/share/`，由
`Dockerfile.web-share` 和 `nginx.web-share.conf` 发布到 `/cn/share` 与 `/share` 两个语言入口。
两者共用同一份 SPA 和静态资源，路径前缀决定中文或英文 UI locale；它与 `/remote/v4` 使用独立镜像、
Deployment、CI Job 和回滚版本；公开 Preview 匿名访问，private Preview 使用同源 Web OAuth。

镜像和 nginx 路由的手工验收用 `scripts/test-web-share-build.sh`（需要本机 Docker，不需要 CUA Git
凭据）。它校验构建产物落在 `/cn/share/assets`，
并确认 `/cn/share`、`/share` 两个入口和 callback 都能访问，同时不服务 `/remote/v4`；这些
base 路径和路由隔离在单测里覆盖不到，改动 Dockerfile 或 nginx 配置后应该跑一次。

OAuth callback 按语言入口提供 `/cn/share/callback` 与 `/share/callback`，登录凭据仍写入同源
`BrowserOAuthCredentialRepo`，因此登录后两个 Share 入口、`/remote` 和其他 Web 路径共享同一 Web
session。Web JWT 不进入 Deep Link，也不传给 Desktop。两个入口不互相重定向，避免英文页面被切换为
中文 locale；静态资源和 callback 均由 share 镜像独立托管。

权限映射固定为：`private` 需要 owner Web OAuth 后才能 Preview/import；`public_readonly` 和
`public_importable` 的 Preview 完全匿名开放。匿名请求 private 时，`401/3213` 或隐匿策略下的
`404/3211` 都只能显示通用登录提示；登录后仍为 `404` 时不得泄漏分享存在性或 owner 信息。
Desktop continuation 携带可选登录态，客户端不得因本地缺少 JWT 而跳过请求；最终 import 权限由
服务端根据 share code、访问模式和可选用户身份判定。

### 找不到分享内容页

已登录且 Preview 返回 `not_found` 时，沿用居中状态卡片，显示「找不到分享内容」及
「链接可能无效、分享已被移除，或当前登录账号无法访问。」；独立一段提示
「Z.ai 与 BigModel 的账号数据不互通。请检查是否选错了登录平台或使用了其他账号。」
账号提示是排查建议，不推断分享是否存在、所属平台或 owner。中英文提供同义文案。

操作区从左到右为描边「重试」和主按钮「回到首页」。首页复用既有官网地址
`https://zcode.z.ai`，同标签页导航，不清理登录态。按钮优先并排，窄屏或长文案允许换行；
使用现有主题与 UI 字号 token，兼容桌面、手机 Web 和深浅主题。

```text
Preview not_found → 现有 Loader
  ├─ 无 token → 登录选择页
  └─ 有 token → 找不到分享内容 + 账号排查提示
                   ├─ 重试 → 当前 token 再请求 Preview
                   └─ 回到首页 → 官网导航
```

状态仍由 `ConversationShareLandingLoader` 唯一持有，状态组件只负责展示。
不修改错误映射、OAuth、其他错误页、Desktop continuous 或手机 remote replayable 链路。

验收用例 SHARE-NF01（pending）：启动 `pnpm dev:web-share:mock` 后运行
`node packages/web/test/e2e/manual-review/pending/share-not-found.mjs`。
通过匿名访问 fixture → 登录 → 检查账号提示 → 重试 → 同标签页首页导航，验证上述边界；
另覆盖中英文、320px 手机/桌面视口、深浅主题、无横向溢出及过期页不出现新增内容。
首页请求由浏览器测试拦截，不依赖外网。组件单测补充其他错误状态的隔离断言。

本地 Share 验证入口：`pnpm dev:web-share:test` 启动与生产相同的 `@zcode/web-share` Vite 入口，
固定连接测试环境；启动后手动打开
`http://localhost:5173/cn/share/<share_code>` 或 `http://localhost:5173/share/<share_code>`，分享码只从 URL
路径读取，不需要环境变量；前者显示中文，后者显示英文。`pnpm dev:web-share:mock` 使用开发态
`/cn/share/mock-private`、`/cn/share/mock-readonly`、`/cn/share/mock-importable`、`/cn/share/mock-expired`
和 `/cn/share/mock-not-found` fixture。两者都只启动 Vite，
不启动 Desktop、relay 或独立 Agent。跨版本兼容另有两个 fixture：
`/cn/share/mock-partial-unsupported`（认不出的行被跳过，顶部出软提示）和
`/cn/share/mock-outdated-client`（载荷版本高于本 build，显示「需要更新 ZCode」而不是「格式无效」）。

Desktop Host 的分享运行时始终使用真实 Share API，API 地址由 `ZCODE_ENV` 解析；不再提供运行时
Mock 开关。`ConversationShareMockApiClient` 仅用于服务单测和协议 fixture，不能生成可跨进程访问的分享链接。

公开页正文展示复用 `packages/ui` 的只读 presentation 层：通过
`buildConversationTurnRenderUnits` 保持 Desktop 的轮次和工作段顺序，使用同一套
`ConversationUserInputBody`、`ConversationUserInputContent`、`MessageResponse`、`Reasoning`、
`ToolLayout` 和 `ToolSummaryRow`。Share 只注入 locale、theme 和 code preview defaults，不注入
Host、workspace 或 file service；Desktop action、文件打开、编辑、重试和反馈仍只存在于 Desktop。
Explore/Execute/CUA 等连续工具也先经过 Desktop 的 `buildAssistantWorkRenderItems` 分组，公开页只
展示安全摘要和只读详情，避免把每条工具结果渲染成独立的大卡片。

Share 自己承接页面级纵向滚动，不改变全局 `body/#root { overflow: hidden }` 的 Desktop/remote 约定。
滚动根同时标记 `data-markdown-table-layout-root`，让长 Markdown table 在页面纵向滚动、表格内部横向
滚动之间保持独立。`MessageResponse` 的公开模式由一次性的 `TooltipProvider`、只读外链 handler 和
citation 清理组成：本地 citation 不泄漏路径，无法匹配公开 artifact 时不渲染协议 directive。

公开分享页顶部固定栏始终保持单行 64px 高度。`ZCode` 品牌、分享标题和继续 CTA 使用同一条连续
几何轨道；完整 CTA 无法为标题保留最小可见宽度时，切换为保留可访问名称的图标 CTA，再让标题
通过 CSS ellipsis 收缩。完整标题仍保留在可访问名称/`title` 中。`public_readonly` 始终不显示
CTA；该响应式策略只影响 Web landing page 的展示，不改变 Deep Link、权限或 Desktop/remote 行为。

当分享可继续导入时，正文时间线末尾还显示一个与顶部 CTA 样式和行为一致的“去 ZCode 继续”按钮，
按钮在正文内容栏内水平居中并复用同一个 `zcode://share/import` deep link。点击顶部或底部任一入口
都进入相同的自动打开提示流程；`public_readonly` 仍不显示任何继续入口。底部按钮属于正文流，
不能遮挡最后一条分享内容，也不改变分享内容的只读语义。

公开页元信息中的“结果物数量”只统计公开 `rows` 内的 `kind: "artifact"` 行，也就是时间线实际展示的
Assistant 结果物卡片。`preview.artifacts` 是结果物和 `userInput.attachments` 共用的完整下载 manifest，
不能直接作为结果物计数；用户输入附件继续参与 URL/name 映射和下载，但不计入“结果物”数量。

## 协议优先级

当历史方案、接口示例和本文冲突时采用以下规则：

1. confirm 只提交 `selected_product_turn_ids`、`projection.rows`、两哈希 integrity 和披露确认。
2. title、schema version、access mode、client request ID 和 payload hash 只在 preparation 提交。
3. Preview / Continuation 的 integrity 只有 `projection_sha256` 与 `artifact_set_sha256`。
4. artifact 上传成功响应必须包含非空 `safety_status`；客户端不按其取值分支。
5. HTTP 409 / code `3215` 是安全检查非终态；同一 preparation 与字节语义相同的 confirm DTO
   串行轮询，优先合法 Retry-After，否则 5 秒，总等待不超过 2 分钟。
6. TTL、限额和产物白名单完全以 capabilities 为准；PDF 只有服务端显式声明后才开放。

## 跨版本兼容纪律

分享内容在 **4 个可以各自独立升级/回滚** 的部件之间流动：发布端 Desktop、Share API 后端、
独立部署的落地页镜像（见上文「独立镜像、Deployment、CI Job 和回滚版本」）、导入端 Desktop。
它们不可能同版本，所以公开投影事实上是一份**跨版本数据交换格式**。以下纪律不是建议：

1. **响应宽容、请求严格。** 入站 schema（capabilities / preview / continuation / 错误信封 /
   artifact descriptor 回显）一律非 strict，未知字段放过；出站 schema（preparation /
   confirm / continuation request）保持 `.strict()`，多带字段是本端 bug，必须当场炸掉。
   给入站 schema 加回 `.strict()` 等于让后端下一次加字段打死全部存量客户端。
2. **完整性只对服务端原样发来的值校验**，不对 zod 解析产物（`verifyConversationShareIntegrity`）。
   zod 默认剥掉未知字段，拿解析产物重算哈希会把纯 additive 的 row 演进误报成
   「分享文件校验失败」。摘要与 schema 认知必须永久解耦。
3. **rows 只能 additive。** 新字段必须 `optional`；**永不删字段、永不收窄 enum、永不改字段
   语义**——删字段和收窄枚举同样会让对端丢内容，方向只是反过来。
4. **新增 row kind 或 enum 取值 = 老客户端会跳过该行**（`decodeConversationShareRows` 逐行降级，
   UI 出「部分内容需要更新 ZCode 查看」软提示）。加之前先问：这行被跳过后，分享是否仍然自洽？
   需要「不可跳过」的语义变化，才谈得上第 5 条。
5. **`schema_version` 只在 rows 出现不可跳过的破坏性变化时才 bump**，且 bump 前先确认存量
   客户端与已部署落地页镜像的版本占比——bump 一次就等于让它们同时看不了新分享。版本高于
   本端认知时走 `unsupported_schema_version`（「请升级 ZCode」），不得混进 `invalid_contract`
   （「分享格式无效」）。
6. **`projectRow`（`conversationSharePublicProjection.ts`）的穷尽 switch 是故意的编译期闸门，
   不要给它加 `default`。** 新增 row kind 必须让构建失败，强制开发者按第 4 条做决定，而不是
   悄悄开始往公开投影里发老客户端读不了的东西。

回归覆盖在 `packages/shared/test/conversationShareContract.test.ts` 的
「cross-version forward compatibility」一节，以及 `conversationShareImportService.test.ts`
里「导入更新版本发布的分享」的端到端用例。改动入站契约后必须跑这两处。

## 权威与安全边界

发布 HTTP、JWT 和 staging 临时文件始终属于 Desktop Host。SSH/WSL/Docker 只提供远端 Agent
Rows、fileChanges 和文件字节，不接收 Desktop 登录凭据。服务必须使用 Host attachment 注入的可信
`clientMode`：只有 `desktop-continuous` 可以 publish/import；`web-remote-replayable` 必须拒绝。

Share 读取 Rows/fileChanges 必须复用当前 MessagePort attachment 已完成握手的
`createZCodeAgentConnectionScope(...).service`。禁止直接调用 raw Agent 的 V4 query，禁止为 Share 另建
connectionId、hello/clientHello、Host、Agent runtime 或 subscription。connection scope 的生命周期仍由
attachment owner 管理；Share 只持有当前调用期间的轻量 facade。

远端隔离 key 固定为：

```text
workspaceKey = workspaceIdentity?.trim() || workspacePath
```

路径执行和展示仍使用 `workspacePath`。远端路由、缓存、发布 attempt 和文件 source 必须同时携带
`workspaceIdentity` 与 `remoteSessionId`，不得只按路径判等。

发布状态不进入 conversation snapshot、task sqlite、owner/lease、CommandInbox、relay 或 mobile
replayable mirror。日志不得记录 JWT、Signed URL、Conversation Rows 正文、文件内容或绝对路径。

### 公开分享页对第三方内容的防御边界

公开分享页（`/share`、`/cn/share`）渲染的是**发布者可控的正文**，访客是匿名的，因此在这个入口
上正文必须被当作不可信内容处理。两道防线都必须在位，缺一不可：

1. **渲染侧剥离**：`normalizeConversationShareMarkdown`（`packages/ui/src/v4/conversationShareMarkdown.ts`）
   把正文与工具输出里的远程图片语法降级为普通链接（`![alt](https://x)` → `[alt](https://x)`）。
   只处理 `http:` / `https:` / 协议相对 `//`；`data:` 不走网络、相对路径落在自身 origin，保持原样；
   代码围栏内的写法由 `findMarkdownCodeRanges` 保护不改写。
   原因：只读时间线不传 `workspacePath` / `sessionId` / `readAttachment`，`MarkdownImage` 会 fallback
   成 `<img src={远程} loading="lazy">`，于是任意访客一打开页面就自动向发布者指定的第三方发起
   请求，泄露 IP / UA / Referer —— 等价于发布者可控的 tracking pixel。放在渲染侧的好处是对**已经
   发布出去的旧分享立即生效**。

2. **传输侧 CSP**：`nginx.web-share.security-headers.conf` 的 `img-src 'self' data: blob:` 兜住第一道
   防线漏掉的任何形态。该文件同时提供 `X-Frame-Options` / `X-Content-Type-Options` /
   `Referrer-Policy`，并且**必须被每个 `location` 显式 include**：nginx 的 `add_header` 不继承，
   子级一旦出现任何 `add_header`（例如 `Cache-Control`）就会丢弃 server 级整组声明。

CSP 的两个硬约束（改动前先读，否则会静默打断线上页面）：

- `script-src` 必须带 `'wasm-unsafe-eval'`：shiki 代码高亮默认走 oniguruma wasm
  （`packages/ui/src/lib/shikiHighlighter.ts` 的 `createHighlighter`），只给 `'self'` 会让分享页
  所有代码高亮失效。它只放开 wasm 编译，`eval` / `new Function` 仍然被挡住（已实测）。
- `connect-src` 保持 `https:`：API origin 是 vite 构建期按 `ZCODE_ENV` 注入的
  （`packages/web-share/vite.config.ts`），写死具体 origin 会让 test/production 各自需要一份 conf。

artifact 只经 `window.open` 打开、不做 `<img src>`，因此不受 `img-src` 收紧影响。

## 发布投影

公开投影从正式 `ConversationRow[]` 构建，不从 DOM、legacy MessageWithParts 或 Web DTO 反推。

- 允许：`turnHeader`、`userInput`、`assistantText`、`reasoning`、`toolCall`、`timelineMarker`、`artifact`。
- `subagent` 详情过滤，但对应 Agent toolCall 与同轮其它公开 Rows 保留。
- 每类 Row 使用 allow-list 新建对象，删除 actions、source/root command ID、client ID、approval ID、
  active progress 和本地 artifact 引用。
- 确定性重建 public product-turn、turn、row、entity、tool-call、artifact ID；保持 Row 稳定顺序和引用闭包。
- descriptor 不发送 `original_path`。artifact ref 固定为 `zcode-artifact://share/<artifact_id>`。

选择至少包含一个 terminal product turn。每个被选 ID 必须只有一个 `turnHeader`，且状态不是
`running`。任一分页 revision/log epoch 不一致时必须在 preparation 前失败。

## 产物发现与上传

分享候选包括当前轮次的 `userInput.attachments`、当前轮次最终显示的 Assistant 预览卡片，
以及已完成工具输出的内嵌图片。正式 `artifact` row 不再作为独立发现源；只有它同时形成了预览卡片，
才通过预览卡片候选进入分享。

预览卡片候选必须由 shared candidate builder 统一生成，UI 和 Share Service 使用同一套顺序、
去重和可见数量限制。普通正文中的 `~/...` 路径、Bash input/output、workspace 扫描、孤立
`fileChanges` 和没有形成预览卡片的文件都不是候选。`fileChanges` 只用于 Markdown/HTML
卡片的 active/reverted 关联，不独立发现文件。

候选文件先经过所属执行端 stat，再取最终可见卡片集合；不存在的 Assistant 卡片文件被视为
“卡片不显示”，不进入分享且不生成 warning。用户输入附件仍保留附件不存在 warning。
PDF、Office、Markdown/HTML、视频和音频都可以成为预览候选，但 video/audio 当前只允许进入
“存在但类型不支持”的 warning，不进入可上传 artifact manifest。相同 canonical path 只上传一次。

```text
正式 attachment / assistant 文件引用
                 |
                 v
    PreviewableArtifactCandidate（文件预览候选集合）
                 |
       +---------+---------+
       |                   |
       v                   v
  UI preview card     Share Artifact Row
```

文件在所属执行端完成 realpath containment、普通文件、类型、size 与 mtime 校验。远端文件通过
`readFileRange` 分块进入 Desktop 临时 staging，边写边计算 SHA-256；前后 size/mtime 变化、空 chunk、
断连或越界均 fail closed。prepare 之后只上传 staging 的不可变字节。上传按稳定 manifest 顺序串行，
任一失败不 confirm，finally 清理 staging。

`userInput.attachments` 通过当前 Agent connection scope 按 `rowId + entityId + attachmentIndex`
授权读取，不允许 Renderer 直接把附件路径作为读取目标。长文本粘贴保持现有
`~/.zcode/tmp/paste-attachments/<date>/<uuid>.txt` 路径处理，不在发送时重新内联正文；分享时
复用同一读取链路。文件已被清理、读取失败或字节发生变化时，只跳过该附件并在发布成功态展示
`input_attachment_unavailable` warning，不把失效路径写入公开 projection。可用附件统一改写为
`zcode-artifact://share/<artifact_id>`，不额外插入 `artifact` Row，直接通过 manifest 闭合。

分享 artifact 类型增加 `text`，对应 `txt` / `text/plain`；服务端按 UTF-8 文本走与 Markdown/HTML
一致的同步安全审核。`text` 类型与客户端、服务端和独立分享落地页同步升级后开启。

## UI 状态机

```text
closed
  -> loading capabilities/catalog
  -> selecting terminal turns
  -> preflighting selected turns and attachment metadata
  -> confirming title + access mode + disclosure in share dock
  -> collecting -> uploading i/N -> confirming
                           `-> 3215 safety pending -> confirming
  -> published | failed
```

选择阶段的 `SharePreflight` 是独立的只读检查，不上传文件、不读取完整附件内容，也不改变选择草稿。
它绑定当前 `sessionId`、`workspaceIdentity/workspacePath`、`remoteSessionId`、selection、rows
`revision/logEpoch`、capabilities fingerprint 和候选 fingerprint；选择、候选集合、文件变更
状态或会话水位变化后旧结果必须标记为 stale。

预检结果分为四类：

- **阻断**：选择已失效、缺少 product turn、轮次/正文/工具/子 Agent/compact/goal verification 仍在运行、
  本地或内联 URL、未闭合 artifact 引用、陈旧水位、已知容量超限或没有任何可分享内容。阻断项停留在选择阶段，
  不允许进入确认阶段。
- **可跳过**：存在但不支持的预览卡片文件、明确不存在或已变化的用户输入附件。允许继续，发布时跳过对应文件并在成功态展示 warning。
- **卡片消失**：Assistant 预览候选在 stat 时不存在，视为 UI 不显示的卡片，不进入分享、不生成 warning。
- **延后确认**：权限不足、远端断开或 stat 超时等无法证明文件不存在的情况。选择阶段只提示“发布时会再次确认”，
  发布阶段以实际读取结果为准。

  分类依据必须是协议侧的稳定 fault 码（`ZCODE_ATTACHMENT_FAULT_CODES`），不能匹配错误文本。
  `conversationAttachmentStat` 是 metadata-only 探测，其 `totalBytes` 上界（`attachmentStatMaxBytes`）
  与搬运字节的读取通道上界（`attachmentPreviewMaxBytes`）是两个独立边界：stat 必须能表达超出传输能力的
  真实文件大小，否则“已知容量超限”这一确定阻断会退化成“延后确认”，发布时静默丢掉附件。
  类型判定排在体积判定之前——不支持的类型根本不会上传，其体积与分享无关，不应升级成阻断。

- **静默移除**：`forkNotice`、`forkCreated`、`checkpointRestored` 以及其它已完成但
  无法在线性公开时间线表达的内部 marker，直接从公开 projection 删除，不生成 warning、不计入跳过数量，也不要求
  用户取消轮次。若静默移除后整次选择没有其它可分享内容，才按“没有可分享内容”阻断。

选择 Dock 在预检期间显示 `checking` 状态；阻断项显示具体轮次和“取消选择该轮”操作（按 issue 携带的
`productTurnId` 整轮移除，`turnOrdinal` 只用于展示文案——两者编号口径不同，用序号反查目录会取消错轮次）；存在可跳过文件时，操作行显示
跳过数量。确认和发布阶段仍必须复用同一套校验并重新检查 revision/log epoch、文件 stat、大小和 SHA-256，防止预检后
的文件或会话发生竞态变化。

预检结果由当前分享流程的 renderer-local owner 按 `productTurnId` 缓存，而不是按整个 selection 反复检查。首次进入分享选择阶段时，
仅批量检查当前尚未命中的轮次；之后新增选择只检查新增且未命中的轮次。取消已检查轮次、重新选择已检查轮次以及
点击“下一步”都只读取缓存，不重新发起 preflight RPC。缓存绑定 `workspaceKey`、`remoteSessionId`、`sessionId`、
`productTurnId`、rows revision/log epoch、turn/candidate fingerprint、fileChanges 状态和 capabilities fingerprint；
当前轮次内容、候选集合、文件变更状态或能力发生变化时，只失效受影响轮次。
缓存不进入数据库或 conversation snapshot，取消/完成分享或切换 session/workspace 时清理。

选择 Dock 不再插入独立的“正在检查分享内容”中间条。预检状态通过操作行状态入口表达，
“下一步”按钮始终只显示短文案，不显示等待图标或保留图标占位；检测完成前保持禁用，完成后沿用阻断问题和选择数量的禁用条件。
详细阻断/跳过列表通过状态入口的 Popover 展示，避免检查状态变化导致 Dock 高度和按钮
宽度跳动。

选择 Dock 的批量标签按内容宽度保持单行，复选框、标签与计数不拆分；操作区空间不足时，取消/下一步按钮作为整组换到下一行并右对齐。中英文、放大 UI 字号及窄面板均遵循同一 CSS 布局，不改变选择状态或分享链路。

选择与发布确认是两个可逆的 UI 阶段，并始终复用同一个 bottom dock。选择阶段只负责勾选已完成的
product turn；点击「下一步」后，确认阶段在 dock 内同时展示本次分享的标题、访问权限和敏感信息确认，
不再打开独立弹窗。新分享草稿首次进入确认阶段时访问权限默认是 `public_importable`；点击「上一步」返回
选择阶段时，必须保留选择、标题、权限和其它 renderer-local
草稿。选择阶段中的 timeline 仅用于查看和定位，不改变业务阶段。点击「确认并生成链接」后 dock
原位切换为整理、上传和安全检查进度；发布开始后阶段不可切换。

分享 dock 的 renderer-local 运行态必须按当前 `sessionId` 独立保存，至少包括标题覆盖、敏感信息确认、
发布中状态、进度、成功链接、失败详情、warning 和本次幂等 attempt。SessionPane 可以复用同一个 pane
实例来切换会话，但切换只改变当前 dock 的读取 key，不得把上一个 session 的结果投影到当前 session，
也不得因为结束当前 session 的分享而清理其它 session 的分享状态。选择草稿和 dock 运行态都属于
renderer-local UI 状态，不进入 conversation snapshot、SQLite、CommandInbox 或手机
`web-remote-replayable` 恢复消息；预检缓存仍按现有规则在切换 session/workspace 时清理。

```text
Session A:  closed -> selecting -> confirming -> publishing -> published
Session B:  closed -> selecting -> confirming -> publishing -> published

switch A -> B: read/write dockStates[B] only
switch B -> A: read/write dockStates[A] only
```

发布进度 dock 的底部摘要使用一行自然语言同时表达分享范围和访问权限，例如
“分享 2 个对话轮次，链接持有者可导入并继续”；私有和只读权限分别替换为“仅自己可见”和
“链接持有者可查看”。发布进行中不额外展示“不能修改分享内容”的锁定提示，因为标题、权限、返回、取消和确认
控件已经被隐藏或禁用；进度标题、阶段和禁用按钮共同表达当前状态。窄屏允许该摘要自然换行，不改变语义。

顶部分享入口复用工具栏的 `Button variant="ghost" size="icon-md"`，默认热区与背景为 28×28 CSS px，和帮助、终端、侧栏按钮一致；图标使用 Lucide `ShareIcon size-4`，不单独设置 mask 缩放。Windows 继续复用现有 caption control 尺寸覆盖。悬停与选中背景沿用语义 token；保留可访问名称、键盘操作及当前入口可见性，手机 `/remote` 不新增分享入口。此调整只涉及外观，不改变分享草稿所有权和点击语义。

点击顶部分享入口进入选择阶段时，候选 product turn 默认全部选中，选择面板默认收起并展示
timeline。分享已打开时，再次点击顶部入口取消当前 session 的分享，复用 `finishSelection` 清理
选择草稿和可见 dock 状态；选择、确认、失败和成功阶段行为一致，不影响其它 session。
发布进行中沿用 dock 的取消保护，顶部入口禁用，避免清理后异步发布结果重新写回。
调整选择范围通过 timeline 左侧重新打开入口完成。此变更仅涉及 renderer 状态，不改变
Desktop continuous、手机 replayable 和手机 `/remote` 不发起分享的边界。

```text
普通对话 --顶部分享--> 选择/确认/结果 --顶部分享--> finishSelection(sessionId) --> 普通对话
发布中   --顶部分享禁用--> 等待发布结束
```

未勾选敏感信息确认时，“生成分享链接”保持可点击；点击不发起发布，而是将确认区域滚动到可见位置、聚焦复选框，并以 warning 背景闪亮一次（600ms），结束后恢复原样，不新增提示文字或持续高亮。重复点击重新播放，不叠加动画；减少动态效果偏好下仅定位并聚焦复选框。勾选后不自动发布，必须再次点击按钮。标题为空、未选择内容、发布中仍禁用，失败重试沿用原行为。披露确认仍由现有状态持有，Dock 不新增提示状态；桌面和 Web 共用此行为，不改变发布协议。

敏感信息确认区在可用宽度允许时保持单行：左侧为复选框和确认文案，右侧为简短的自动检测说明与
「查看检查范围」入口，右侧内容使用同一 `text-ui-xs` 字号并整体右对齐。完整的凭证、Token、密码、
私钥、内部地址和个人信息清单继续放在检查范围 Popover 中；窄屏时右侧内容允许自然换行，不改变确认
语义或校验条件。
确认卡片与标题输入框、权限选择器共用同一 `mx-3` 内容轨道，并与权限区域保持独立的 `mt-3` 间距，
避免敏感信息确认区贴住权限卡片或出现左右边界不一致。

### 分享确认 Dock 窄宽度布局（SHARE28）

确认 Dock 按自身容器内容盒宽度响应，不能用窗口 `md` 断点推断剩余空间。小于 640px 时权限单列，
标签和说明完整换行；640px 起权限及发布阶段三列。小于 480px 时主操作独占第一行，返回/取消
位于第二行；480px 起恢复横排。DOM 顺序调整为「生成分享链接」在前、返回/取消在后（窄屏主操作
第一行即由该顺序直接成立），480px 起宽容器用 `order-last` 把主操作视觉后置到最右。窄屏下 Tab
焦点顺序与视觉顺序一致；宽容器下 Tab 首停点为主操作、与视觉顺序（返回/取消在前）方向相反——
这是「窄屏主操作第一行 + 宽屏主操作最右」两套视觉无法共用一份 DOM 顺序的已知取舍，主操作首停
也符合键盘用户最常用路径。标题输入允许缩小到容器宽度；确认说明在窄屏隐藏装饰盾牌、减少重复缩进，保留复选框、警示边线、
完整确认文案、自动检测说明和检查范围入口。Dock 总高度不超过 70dvh，正文独立纵向滚动，
操作区不随正文滚出；不缩小字号、不新增权限文案、不改变发布验证。

```text
container width -> CSS layout only -> single column / wrapped actions
sessionId      -> existing dock state -> title / permission / acknowledgement
```

SHARE28 验证：320/400/640/800px 面板（含宽窗口内窄面板）、中英文、明暗主题、短视口；
控件与权限文案不横向溢出、操作区可见，缩窄再放宽保留标题、权限和确认勾选。
复用现有 pending 分享 E2E 增补窄面板几何与状态断言，不提升为 formal。侧栏、公开分享页、
手机 `/remote` 发布边界和 desktop continuous / mobile replayable 链路均不改变。

发布成功后进入独立的 `published` 结果态：保留分享标题作为只读信息，展示持久的“分享已创建”状态和
说明；隐藏访问权限、选择计数、确认提示、“上一步”和“取消”。业务操作只保留「去浏览器查看」与
「复制链接」两个按钮，两个操作完成后仍保留结果态，用户可通过关闭图标或 `Esc` 退出。成功 Toast
仅作为即时反馈，不能替代结果态中的持久成功提示。若存在被跳过的文件，在成功状态下以次级 warning
展示，不得把部分成功误报为失败。

选择、确认和发布成功三个分享 bottom dock 与普通 Composer 共用同一基础输入 surface：宽度继承
timeline 内容列，使用 `rounded-2xl`、`border-input-border` 和 `bg-input`。分享 dock 不再额外使用
popover ring 或大阴影，避免在普通输入框之间切换时产生不必要的层级和光晕差异。分享专有的内容高度、
操作按钮、选择阶段 scrim、消息层渐隐 mask 以及 bottom dock 进入/退出动画继续保留；这些效果不改变
分享状态、发布协议或 desktop continuous / mobile replayable 边界。

### 选择面板高度与底部输入区避让

选择阶段左侧的 `ConversationShareSelectionPanel` 使用内容自适应高度：候选较少时面板只包住
header、列表内容和面板内边距，不因为固定高度产生空白；候选内容超过可视上限时，仅面板内的
列表 `ScrollArea` 纵向滚动。面板的最终高度取自然内容高度和当前会话容器在底部 composer/share
dock 之上的可用高度两者的最小值，不设置固定像素高度上限。可用高度由运行时真实测量，底部 dock
增高、输入框变为多行、窗口 resize 或分屏布局变化时重新计算；面板底部与 dock 顶部至少保留
16px 间距，不得遮挡或挤压输入区。
选择面板不显示右上角关闭按钮；用户通过点击遮罩返回 timeline，或使用 timeline 左侧的重新打开入口恢复面板。
点击面板条目的文字区域只定位正文到对应 turn，不改变选择面板的可见状态；只有点击面板以外的区域
才收起面板并返回 timeline。点击复选框仍只改变当前 turn 的选择状态，不触发正文定位。

```text
会话内容区
┌──────────────────────────────┐
│ 顶部安全边距                  │
│ ┌─ 选择面板 ───────────────┐ │
│ │ header                   │ │
│ │ 列表：自然高度            │ │
│ │ 超过可用高度时仅列表滚动  │ │
│ └──────────────────────────┘ │
│ 至少 16px 间距                │
│ 底部 composer / share dock    │ ← 实时测量顶部
└──────────────────────────────┘
```

该布局规则只调整分享选择面板的 renderer 几何，不改变分享选择状态、timeline 滚动锁定、发布
协议或手机 `/remote` 的分享能力边界。

## 发布错误详情契约

发布失败不得只显示首个错误或一条无上下文的 Toast。Host 在 prepare 前必须执行一次
SharePreflight，并在失败时返回最多 5 条脱敏后的 `issues`；超过部分只返回计数。每条 issue
可包含轮次序号、文件名（仅 basename）、artifact type、扩展名、MIME、实际值与能力上限，
禁止包含绝对路径、URL、文件内容、哈希、Token 或内部持久化 ID。

结构问题至少细分为运行中的 turn、streaming row、活动工具调用、活动子任务、运行中的 compact/goal
verification、用户输入附件、本地/内联 URL、未闭合 artifact 引用和陈旧 revision。已完成的 fork/checkpoint
内部 marker 不属于用户可操作错误，必须静默移除；内嵌工具图片按下述产物转换规则处理。阻断项按同一轮合并展示，并提供取消该轮的操作。
产物白名单问题必须显示文件名、
实际的 type/extension/MIME 和当前 capabilities 允许的格式；Markdown 的 `html + text/markdown`
组合与 HTML 的 `html + text/html` 组合必须区分。

行数、产物数量、单文件大小、总产物大小和 JSON payload 大小必须同时报告实际值与上限，
不能统一退化为“超过分享限制”。网络、上传和安全检查错误必须标记失败阶段；若服务端没有
返回可定位信息，只显示稳定错误类型、阶段和安全的重试建议，不展示原始服务端文本。

HTTP 错误分类以故障源为先：网关/负载均衡返回的 5xx 非 JSON 错误页（502/504 HTML）是
基础设施故障，必须归类为 network 类，不得因 body 无法解析而归类为 `invalid_contract`
（后者语义是服务端违反 API 契约，会误导排障与用户提示）。artifact 上传是用户主动等待的
大传输，单请求超时按 artifact 字节数动态放宽（保底带宽估算），不能沿用普通 JSON 请求的
默认超时；confirm 之外的超时放宽规则同源。

分享 dock 保留打开状态，发布失败继续停留在发布态 dock 中，并在进度信息下方内联显示可滚动的
错误详情；发布失败不再显示顶部错误 Toast。错误态保留「上一步」「取消」和「重试生成链接」，
用户修改选择、标题或权限后清除旧详情。所有详情文案必须同时支持中英文、浅色/深色主题和窄屏布局。

错误详情中的服务端 `x-request-id` 默认不在错误 dock 内联展示；错误引导文案末尾提供一个
click-only 的错误详情按钮，点击后通过向上的 Popover 展示并复制合法的服务端 request-id。
没有 HTTP 响应 request-id 时仍保留该入口，在 Popover 中显示稳定缺失提示且不提供复制操作；
不得使用客户端生成的请求头 ID 冒充服务端 ID。多条 issue 共用一个详情入口，不在每条 issue 后重复
request-id。错误按钮与错误文案保持同一内容列，使用 24px 点击区域和语义 destructive 色，需支持
键盘触发、Esc/点击外部关闭、窄屏碰撞调整以及浅色/深色主题。选择阶段的面板可关闭到 timeline，并通过左侧
reopen tab 恢复；该操作只改变 `view`，不清空选择、标题、权限或错误草稿，且 reopen tab 仅在
`stage=selection` 时显示。

错误详情卡只有一条可行动文案时采用紧凑单行布局：文案、错误详情按钮和“关闭”操作垂直居中，
上下内边距保持一致，使用较小的 `p-2`，并将卡片与操作栏的间距收窄为 `mb-2`；包含多条 issue 时才恢复列表所需的
额外间距，避免单行错误
提示在底部留下不必要的空白。

用户必须显式确认系统不会自动识别敏感信息。发布期间面板不可关闭。真实 `share_url` 只在 confirm
成功后显示；不得使用 demo URL 或模拟 loading。相同标题、权限、选择和内容重试复用 clientRequestId，
输入变化后生成新 ID。

发布失败必须按稳定错误 kind 显示可操作提示，不得统一退化为“请重试”。Desktop Host 记录
`operationId`、阶段、kind、HTTP status/code 和安全计数；Server Remote 等主动拒绝记录明确 reason。日志
不得包含 JWT、Signed URL、Rows 正文、文件名或绝对路径。公开投影和产物 staging 失败还记录稳定
`reasonCode`（如 `input_attachment`、`running_turn`、`artifact_changed`、`unsafe_url`）及安全的
`rowKind/rowId/artifactType/phase` 诊断字段；UI 按 reasonCode 提示下一步操作，不展示底层原始错误文本。

## 导入与继续工作

Web CTA 使用 `zcode://share/import?code=<share_code>`，deep link 只能携带 share code。main process
只解析、缓存和投递 intent；Renderer 不按本地登录态前置拦截，统一调用 Host import service，
由 continuation API 返回最终访问判定。share deep link 的目标窗口解析与其他 deep link 一致，
必须走调用方注入的 `resolveApplicationWindow`（排除 CUA indicator 等辅助窗口）；窗口未就绪时
缓存的 pending import 必须绑定目标窗口的 webContents id，只投递给目标窗口，目标窗口关闭时
清理，不得投递给先 ready 的任意 renderer——导入会写入目标窗口激活 workspace 的
`.zcode-share`，投递错窗口等于在错误 workspace 创建会话。

导入在当前本地 workspace 下创建新的 conversation task/session；远程 workspace 回退到默认本地
conversation workspace。产物固定写入 `<workspace>/.zcode-share/<share-id>/shared-artifacts/`，
同一 `workspaceKey = workspaceIdentity?.trim() || workspacePath` 与分享码幂等复用，不同 workspace 各自创建 session。
创建 import-owned pending marker 后：

1. 调 continuation 并校验 schema 与两哈希；
2. 全部 artifact 下载到同文件系统 staging，复验 size/MIME/SHA-256。下载必须带单请求
   超时（挂住的连接按 network 失败，不得无限停在 downloading 阶段），并在读取 body 前
   预检 `Content-Length`：超过 manifest 声明的 `size_bytes` 时立即中断，不把已知的
   超大响应读进内存——完整性校验放在无界下载之后只保证正确性，不保护客户端资源；
3. 原子 rename 为 `shared-artifacts/`；
4. `SharedContextFormatterV1` 按 Rows 原序生成确定性 Markdown，并把 artifact ref 改成相对路径；
5. SQLite 单事务创建 session、唯一 model-only `shared_context` message 和
   `v4/shared_context_import` provenance，初始状态为 `pending`；
6. 删除 marker、激活 workspace/session，并显示 Share URL handover。

整合约束（Todo103）：导入不执行模型，不依赖当前 Provider 可用性。分享上下文消息沿用当前
结构化 `modelSelection` 存储合同；有明确选择时保留，未绑定时不伪造模型来源，不重新写入旧
`model.providerID/modelID` 字段。原子导入与后续正常执行的模型校验是两个边界。

### 首次导入的选择初始化（Todo139）

导入服务返回 `reused=false` 后、激活 Session 前，Renderer 按结果中的实际 workspacePath／workspaceIdentity
准备该 Session 的独立 Composer 草稿。已初始化的 Root 草稿只复制 mode/modelSelection（包括明确空选择），
不复制正文、附件或提及，不清除 Root。目标草稿已存在时不覆盖；`reused=true` 不初始化。
无已初始化 Root 时，在同一草稿保存 `initializeFromNewTask` 待初始化标记，普通新任务与该标记共用
初始化函数：Recent 完整选择及模式优先，否则公共默认选择／build。Registry 尚未就绪先打开内容，
标记阻止空 Session snapshot 抢先初始化；公共读取就绪后一次完成。用户提前修改模型／模式即结束
默认初始化意图，迟到结果不得覆盖；正文编辑不清除待初始化标记。已有历史不按空模型推断首次导入。

```text
import result (reused=false) → seed independent draft → activate returned workspace/session
                                  ├─ initialized Root → copy selection only
                                  └─ pending marker → shared new-task initialization when View ready
reused=true → existing session/draft unchanged
user submission → existing context_refs + full modelSelection/mode → accepted updates Recent
```

不新增 Host／CLI 字段或同步机制；Renderer 草稿仍与 desktop continuous／mobile replayable 权威消息链路
分离。标记只属于现有草稿存储，不写会话数据库，不回填历史导入记录。

V4 projection 会通过 additive 的 `sharedContextImport` snapshot 元数据携带 `contextId`、标题、
canonical Share URL 和 `pending/reserved/attached/discarded` 状态。删除会话不删除普通
workspace 文件；导入完成后分享过期不影响本地副本。

导入时把公开 rows 与结果物元数据一并落到 `<workspace>/.zcode-share/<share-id>/shared-conversation.json`；
会话顶部据此渲染**只读块 + 分割线**（复用分享页的 `ConversationShareReadonlyTimeline`），
分割线的可点击与静态形态统一使用 Lucide `SquareArrowRightEnter` 图标，避免与 Fork 的分支图标混淆；保持现有尺寸、主题色和多端布局。
分割线之下是用户自己的实时对话。只读块不回源，因此分享过期或未上线也能离线打开；它不是
`timelineMarker` row，不进 transcript 导出，也不参与重新分享。

Desktop 导入块中的 artifact 卡片只在本地副本存在合法 `workspaceRelativePath` 时提供打开动作：
主按钮复用正常预览卡片的 `OpenSplitButton` 打开 PreviewPane，下拉菜单复用同一套编辑器选择与
复制绝对/相对路径能力。该路径必须仍位于 `.zcode-share/<share-id>/shared-artifacts/` 内；
渲染侧校验为形状白名单（`.zcode-share/<dir>/shared-artifacts/<file>` 恰四段、无 `..`/`.`/绝对
路径），不与 shareId 交叉比对——元数据由导入服务自写自洽，复制 sanitize 规则到 UI 反而有漂移风险，
取舍详见 `ConversationShareReadonlyTimeline.tsx` 的 `resolveImportedArtifactPath` 注释；
缺失、绝对路径或包含 `..` 的元数据一律退回纯只读展示。公开 Share 落地页仍只使用服务端
`artifactUrls` 下载文件，资源卡片按钮统一显示「下载文件」/「Download file」（桌面和手机浏览器一致），不注入 Host、workspace、file service 或本地打开菜单。

`ConversationShareReadonlyTimeline` 是公开落地页与 Desktop 共用的安全边界文件，因此
`OpenSplitButton` 及其 open-with 子树（platform hooks、tab store、文件树模型、编辑器偏好）
**不由该文件静态引入**，而是由 Desktop 消费方（`ConversationShareImportNotice`）通过
`artifactOpenAction` 组件注入；时间线文件对 `@/OpenSplitButton.js` 只保留 `import type`
（构建期擦除）。这保证匿名公开页 bundle 物理上不含该子树，未来往共用时间线里追加依赖时
必须先考虑公开页包体与无 Desktop 宿主（`window.zcode`、PlatformProvider）的运行环境。
该约束由 `packages/ui/test/conversationShareBundleBoundary.test.ts` 机械守卫：守卫把边界
文件里的 import specifier 统一归一化（相对路径按边界文件目录 resolve 后折算回 `@/` 别名
形态）再比对 denylist，覆盖四种引入形态——带 from 子句的 `import`/`export ... from`（仅
放行 `type` 子句）、副作用 `import "..."`、动态 `import("...")`（后两者不存在类型擦除
变体，命中即失败）。守卫提取器自带 fixture 自测，防止正则或归一化逻辑在未来被改出盲区。

模型侧仍只通过隐藏的 `shared_context` 消息拿到内容：可见即会随第一条消息 attach，
因此不再提供 Composer Share URL Chip、居中 handover 空状态与导入后自动打开侧栏分享页；
分享页改由用户点分割线主动打开。`discardSharedContext` 命令与 `discarded` 状态保留但暂无 UI 入口。
会话标题在导入时定型为带前缀的形式（`来自分享：…` / `From Share: …`，`titleSource: "custom"`）。

启动清理器只扫描 `.zcode-share/<share-id>/` 下具有匹配 import ID 的 marker。无 provenance 的
导入目录删除；已有事务记录但尚未激活的 session 补建索引并激活。失败清理只能删除本次
importRoot/staging，禁止递归删除用户 workspace。

## 验收不变量

### 导入状态提示

一次 Share Deep Link 导入操作只允许占用一个全局 Toast。下载进度、安装、创建会话等阶段在同一
Toast 内原位更新，不能按阶段追加多个 Toast。导入成功时，进度 Toast 原位替换为包含会话标题的
最终结果；不得再额外显示独立的“分享导入完成”提示。导入失败时，进度 Toast 原位替换为错误和
重试入口，不能留下已经过期的进度提示。快速完成的导入可以跳过中间进度展示，但必须保留最终
结果提示。

Toast 的按 id 进度更新与既有 dedupeKey 去重共同生效；挂载前暂存的更新也先合入最终 item 再去重，不得因分享接入而让设置页重复堆叠提示。

进度提示使用顶部居中的现有 Toast 容器、现有 `--color-toast` 和 `text-ui-*` 字体层级；进行中和
工作区回退使用中性信息语义，不使用黄色 warning。该展示约束只影响 Desktop renderer 的通知编排，
不改变 `ConversationShareImportProgress` 阶段、Share API、导入事务、`workspaceIdentity` 隔离或
Desktop `desktop-continuous` / 手机 `web-remote-replayable` 边界。

- private 仅 owner preview/import；public_readonly 可匿名 preview 但不能 import；
  public_importable 可匿名 preview。Desktop 对 continuation 使用可选 JWT，并以服务端响应作为 import
  权限依据；服务端返回 `authentication_required` 时按不可重试的登录限制展示。
- 手机发布入口不存在，且 mobile attachment 直接调用 RPC 仍被拒绝。
- local/SSH/WSL/Docker 使用同一公开投影与 API DTO；远端只替换 Rows/File authority。
- `pending/reserved/discarded` shared_context 不注入 provider；`attached` 在 hydration/compact
  后恰好注入一次，不生成可见历史气泡。
- 首条 Share URL 输入保留 queue/guide 语义：queue/guide accepted 后进入 `reserved`，实际消费时
  与 user message 原子 attach；删除 queued input 后恢复 `pending`。
- 合并接线约束：分享 `context_refs` 与当前完整 Submission 同时提交；已有 Session、预热首发、无预热先建 Session 再发送三条路径均不得丢失 modelSelection/mode。分享上下文不负责另选 Provider，不恢复发送前 Registry 等待。
- 同一 session/context 只打开一个 Browser Tab；Web renderer 和内置 Browser 使用不同 OAuth session。
- 发布或导入失败不留下半个 share、本地可见半个 workspace、残缺 artifact 目录或半个 session。
- “能预览，就能分享”仅对 file-backed 且 capabilities 允许的预览候选成立；localhost URL-only 预览不自动
  转为分享产物。
- 不实现 workspace 全量文件监听；模型未明确引用且工具未显式登记的 Python/Bash 中间文件不展示、不分享。

### 发布失败归因与诊断

- 本地内容问题、HTTP 接口契约异常、网络请求或响应体读取失败必须分别呈现；`invalid_contract` 不得映射为取消运行轮次或图片的建议。
- `checking` 表示发布确认，不能仅根据所在阶段断言安全审核拒绝。失败后保留选择和现有幂等重试身份。
- 响应体读取失败归类 `network`；在读取前保存 HTTP 状态和服务端请求 ID。客户端请求 ID 与服务端请求 ID 分开保留，并通过既有 RPC details 传到错误详情；operationId 用于关联整次发布。
- 诊断只记录请求方法、接口路径、HTTP 状态、请求 ID、响应媒体类型、响应字节数与是否重定向，不记录响应正文、鉴权信息或带查询参数的 URL。

### 内嵌工具图片与选择阶段一致性

- 已完成工具的 `node_repl_images` 按原顺序转换为既有 image artifact，插入对应工具之后；公开 payload 不携带 base64，上传复用现有 manifest、SHA-256、prepare/upload/confirm 和导入下载链路。
- 预检与发布共用同一个转换入口；预检仅处理已经随 rows 读入的内嵌数据，不额外读取附件文件。图片类型由服务端 capabilities 决定，不支持或图片数据损坏时保留工具文字并明确提示跳过该图片，不再静默丢失。
- 公开行数按轮缓存并随当前选择重算，取消轮次后不保留旧的整组超限错误；fingerprint 包含工具 display，图片变化必须使旧预检失效。
- 可支持图片的已知单文件、总大小、数量限制在预检阶段检查；发布仍重新生成快照并复核。正在运行的工具仍阻断，不把中间图片冒充定稿产物。
- 接口异常及网络失败不要求取消轮次；发布失败保留选择与幂等身份。音视频与任意文件格式仅在现有协议和服务端能力支持时携带，不伪造 MIME 或扩展名绕过限制。

验收：含内嵌图片的已完成轮次能通过预检、上传原始图片并产生可下载/导入的 artifact；不支持或损坏图片产生精确 warning；图片容量超限在选择阶段发现；HTTP 405 HTML 和响应体中断显示为接口/网络错误，详情保留关联 ID。
