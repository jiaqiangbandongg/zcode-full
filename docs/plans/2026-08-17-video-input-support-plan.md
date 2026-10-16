# Video 输入支持 Spec（base64-only）

> 请求预算更新：下文的独立 video 预算桶是历史方案。当前所有媒体共用 `40MiB`
> 编码后请求预算，单个视频仍按原始文件 `30MiB` 校验；以
> [附件请求预算 spec](../../apps/zcode-cli/docs/design/v2/message-attachments.md#413-请求体防线) 为准。

- 日期：2026-08-17
- 状态：一期实现收口中（已有链路保留；本轮补齐 provider effective capability、严格 schema、catalog 合并、Read 边界读取、tool result 媒体持久化与观测缺口。Web/mobile 大视频上传架构不在本轮调整）
- 分支：`feat/video-input-support`
- 范围：video 输入（不含 audio）；输入框附件 + Read 工具两个场景
- 实现备注：
  - 双 patch 落在 **root** `patches/`（root package.json `pnpm.patchedDependencies`）——实测 CLI 运行时从 root node_modules 解析 `@ai-sdk/*`（`node-linker=hoisted`）；apps/zcode-cli 自己的 node_modules/.pnpm 是遗留产物
  - V4 上传继续沿用既有 20MiB、64 chunks、64MiB staging 边界；本期不为 Web/mobile 大视频扩张协议资源上限
  - 已发送 image/video 复用同一媒体预览 Dialog；V4 上传仍为 20MiB，preview read 按媒体类型分别限制为 image 20MiB、video 30MiB，每帧继续不超过 512KiB
  - patch-commit 后需显式 `pnpm install` 才会应用到 hoisted 目录

## 1. 背景与调研结论

### 1.1 现有媒体输入只有 image 管线

现有媒体输入只有 **image base64 管线**：本地读文件 → resize/字节预算 → `{type:"image", source:{type:"base64", media_type, data}}`，没有 video/audio content block 的构造路径。本 spec 把该模式扩展到 video。

### 1.2 wire 格式事实核查

| 格式                    | wire 形状                                                                           | 出处与事实                                                                                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| openai-chat-completions | `{"type":"video_url","video_url":{"url":"data:video/mp4;base64,..."}}`              | GLM-5V-Turbo / Kimi K3 官方文档格式；本实现只发送 base64 data URL                                                                                                                                                                  |
| anthropic-messages      | `{"type":"video","source":{"type":"base64","media_type":"video/mp4","data":"..."}}` | **Anthropic 官方 Messages API 当前没有 video block**（输入侧媒体仅 image/document）。本形状与 image block 同构（`type`/`media_type`/`data`），是 Anthropic 风格兼容层生态的共识形状；各第三方 anthropic 兼容端点是否接受以实测为准 |

端点接受度不能只由模型目录里的 `supportsVideo` 决定：模型能力表示“模型语义上可接收 video”，provider wire 能力表示“当前 adapter 能把 video 编码成目标 API 的合法请求”。运行时 effective capability 取二者交集；任一层明确不支持时，沿用现有 strip 占位机制，请求不失败。

### 1.3 AI SDK 阻塞

- `@ai-sdk/anthropic@3.0.81`：file part 仅认 `image/*`、`application/pdf`、`text/plain`，其余 mediaType 直接 `throw UnsupportedFunctionalityError`。
- `@ai-sdk/openai-compatible@2.0.60`：无 video 分支（同样 throw）。
- 解法：pnpm patch 两个包各加一个 `video/*` 分支（仓库已有 `patches/vitest@4.1.7.patch` 先例）。

### 1.4 zcode 协议现状（接入前）

- 全链路 image 判定都是精确 `mime.startsWith("image/")` 或图片扩展名，video 不命中任何 image 分支：UI serialize 落 `kind:"file"`、CLI ref 映射落 `type:"file"`、core 落 `binary_file` 路径引用、Read 落 `looksLikeBinary` 模糊报错。**video 无法搭 image 通道便车，必须新开通道。**
- `ModelProviderModality` 枚举与存储 zod 已含 `"video"`；models-dev 快照中 `glm-5v-turbo` 的 `modalities.input` 已声明 `video`。缺的只是投影集合（`PROTOCOL_MEDIA_INPUT_MODALITIES`）与下游能力字段。

## 2. 架构

### 2.1 数据流

```
场景A 输入框附件                          场景B Read 工具
[拖拽/粘贴 .mp4]                          Read(file.mp4)
  │ 桌面: localPath 零拷贝                   │ inferVideoMimeFromPath
  │ Web: dataBase64（沿用 V4 20MiB 上限）    │ readBinaryFile(≤全局30MiB, 无压缩)
  ▼                                          ▼
ZCodePromptVideoAttachment{kind:"video"}   ReadVideoOutput{type:"video"}
  ▼ mapProtocolPromptAttachment /            │ formatReadVideoOutput
    attachment-refs(isVideoRef)              ▼
TurnAttachment{type:"video"} ──────► ModelVideoContentBlock{type:"video",
  ▼ resolveLocalFileAttachment/inline          mediaType, dataUrl,
  30MiB校验→读base64→artifact持久化            source}
  ▼                                            ▼
user message content ◄──────────── tool-result-media-projection
  │                                        (video 的 tool result 媒体统一拆
  ▼                                         后置 user part，所有 provider kind
transform.ts: video block → AI SDK file part{mediaType:"video/mp4", data: base64}
  │                                          一致；image 维持 image-data 路径)
  ├─ openai-compatible(patch) → {type:"video_url",
  │    video_url:{url:"data:video/mp4;base64,..."}}
  └─ anthropic(patch)        → {type:"video", source:{type:"base64",
                                media_type:"video/mp4", data}}
```

### 2.2 内部类型（provider-neutral，与 image 同构）

```ts
interface ModelVideoContentBlock {
  type: "video"; // 不叫 "video_url"——那是 openai wire 方言
  mediaType: string; // "video/mp4" 等
  dataUrl: string; // data:video/mp4;base64,...（唯一内容形态）
  source?: AttachmentRef;
}
```

### 2.3 模型能力与 provider wire 能力

```text
模型目录 supportsVideo
          │
          ├── false ──────────────────────────────► strip 占位
          │
          └── true / unknown
                    │
                    ▼
          provider adapter wire capability
                    │
                    ├── unsupported ──────────────► effective false → strip 占位
                    └── supported / 未明确限制 ──► 进入既有 video transform
```

- `openai-compatible` 使用 Chat Completions wire，依赖仓库 patch 输出 `video_url`，属于一期支持路径。
- `anthropic` 兼容 provider 依赖仓库 patch 输出兼容端点约定的 `video` block，仍需按具体端点实测。
- `providerKind: "openai"` 当前走 AI SDK OpenAI Responses；该 adapter 会在发请求前拒绝 `video/*` file part，因此一期明确标记为 wire unsupported，不进入 video transform。
- `gateway` / `custom` 没有足够事实证明统一不支持，本轮不增加推测性拦截。

### 2.4 Provider-neutral 持久化与模型切换

session DB 只保存可跨 provider 重建的媒体事实：`FilePart` 的 MIME、文件名、大小/摘要等
metadata，以及指向完整媒体 snapshot 的 `zcode-artifact://` URI。base64 wire 不是消息事实，
只能在当前请求投影时生成。

```text
live tool/user media
        │ snapshot
        ▼
session DB: FilePart ───────► artifact store: immutable source media
        │                                      │
        │ hydrate / model switch               └─ read ─► data URL / base64
        ▼
current-provider request projection
```

- 用户附件继续使用 user message 的 `file` part；工具产生的媒体使用
  `ToolStateCompleted.attachments`，两者指向同一种 artifact 事实源。
- in-conversation model switch 与冷恢复都先 hydrate provider-neutral block，再按当前 provider
  投影；不得复用上一 provider 的 wire payload 作为历史事实。
- tool result 的 provider-visible 内容如果由 text 与 data-backed image/video/file block 组成，
  媒体按顺序写入 `attachments`，并在 completed metadata 保存只含 text/attachment index 的小型
  `modelContentLayout`；恢复时据此还原原顺序。它只覆盖当前真实存在的纯媒体、MCP text/media 和
  hook text/media 形态，不引入通用消息序列化层。
- artifact 写入失败时不得把成功媒体静默降级成 metadata-only 历史，否则后续切换/恢复必然
  无法重建；当前 turn 应显式失败，并由既有 interrupted-tool 恢复语义闭合 tool call。
- 真实 user video 与 image 共用 request-local path 投影：local-file 复用当前 runtime 可访问的
  absolute path，inline artifact 在请求前 lazy 物化到 `cli/video-cache/<sessionId>`。能力为
  `true`/`undefined` 时发送 video block + path，明确 `false` 时发送 omitted 文本 + path；path
  不写入 session DB，冷恢复时仍以 durable artifact 为事实重新 ensure。

### 2.5 发送前与已发送媒体预览

发送前和已发送附件复用 `ChatMediaAttachmentPreviewDialog`，只把 image/video 视为可预览媒体。
预览是 renderer 的 best-effort 展示，不改变上传、发送、持久化或 provider 输入语义：

```text
Composer File/object URL ────────────────┐
                                         ├─> shared media dialog
sent user row + attachment index         │      ├─ image: existing preview
        │                                │      └─ video: controls + playsInline
        ▼                                │                 │
CLI authorizes row/entity/ref            │                 ├─ loadedmetadata -> player
        │                                │                 └─ error -> codec/format notice
        ├─ message anchor not persisted ─┼─ authorized original stable ref
        ▼                                │
persisted user FilePart                  │
        ├─ durable artifact exists
        │      ├─ Desktop local -> .zcode video-cache path ─┐
        │      └─ remote/web or path unavailable -> chunked artifact read
        └─ no artifact
               ├─ Desktop local_ref -> authorized local path ─┤
               └─ remote/web -> chunked stable-ref read
                                                            ▼
                                        Host asks Main to authorize realpath
                                                            │
                                                            ▼
                                      exact authorized path -> media protocol
```

- 所有已支持的 `video/*` MIME 都允许进入原生 `<video>`，不得维护容器/MIME 白名单提前误杀；
  浏览器无法解码 MOV 或具体 codec 时显示明确的设备预览不支持文案，但附件仍可正常发送。
- 已发送附件 query 必须用 user row 稳定身份和附件序号授权，再优先读取该轮持久
  `FilePart.metadata.artifactUri`（或 artifact URL）。这保证热态、冷恢复以及同一路径多次发送时
  都预览当时落库的不可变媒体；热态 original ref 与 hydrate 后 previewRef 只要属于同一
  row/index 均可通过授权。新消息尚未形成持久 message 锚点，或旧历史没有 durable artifact 时，
  才读取已授权的原 ref。单次 read 失败只在当前 Dialog 展示错误，关闭后仍可再次打开并重试。
- V4 upload 与 image preview read 仍以 20MiB 为总量上限。Desktop local sent-video 先请求
  authorized local source：artifact 对应 `.zcode` 派生路径优先，其次才是没有 artifact 的
  `metadata_only/local_ref`；本地播放器不做 full read，所以不受 `VIDEO_INPUT_MAX_BYTES = 30MiB`
  限制，也不为超限 local-ref 再复制一份文件。artifact 存在但派生路径不可用时只能从 artifact
  走原有 512KiB 分片，不能退回原始路径。
- Web、手机 `web-remote-replayable` 和 SSH/WSL/Docker workspace 不接收服务端 path，保持
  attached host 的既有分片查询、30MiB preview 上限与取消语义。Desktop main 只提供带 Range
  的本地媒体协议映射，不保存 session/task/replay 状态，也不另起 runtime。Agent 按 row/index
  授权并选出本地路径后，Host 必须先请求 Main 将其 `realpath` 加入进程生命周期内的精确路径集合，
  renderer 随后只能播放该 canonical path；媒体协议不得因为 URL 携带任意绝对路径或声明
  `video/*` 就放行。路径授权失败直接展示既有预览错误，不再回退分片。

## 3. Provider 请求投影（base64-only）

- `ModelVideoContentBlock` 只承载 `dataUrl`；contract 和严格 JSON Schema 均不提供 URL/file-id 字段。
- openai-compatible patch 始终把 video bytes 编码为 `video_url.url` 中的 base64 data URL。
- anthropic patch 始终把 video bytes 编码为 `source:{type:"base64"}`。
- provider Files API、URL 引用、上传缓存和失效策略均不属于当前设计；未来若需求重新成立，必须另行更新 spec 和跨 provider 恢复测试后再实现。

## 4. 关键决策

| 决策                   | 结论                                                                                     | 依据                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 内容形态               | 一期仅 base64（dataUrl）                                                                 | 用户决策；与现有 image 管线同构；无上传基础设施依赖             |
| video 上限             | ZCode 全局固定 30MiB，不进入模型 catalog/session 能力                                    | 与 image 一致：模型只声明是否支持该模态，产品策略统一约束输入大小 |
| Web/mobile 传输        | 沿用 V4 既有 20MiB 附件上限                                                              | 大视频传输方案暂不处理，不扩张 chunk/staging 资源边界             |
| wire 覆盖              | openai `video_url` + anthropic `video` block 双格式，转换层对 apiFormat 通用，不特化端点 | 用户决策                                                          |
| 模态互斥               | 一期不处理（GLM 明确"不支持同时理解文件、视频和图像"），混合附件网关报错透传             | 用户决策                                                          |
| audio                  | 不在本期                                                                                 | 用户决策                                                          |
| tool result 里的 video | 所有 provider kind 统一拆后置 user part（复用 tool-result-media-projection）             | AI SDK tool result part 无 video 变体，patch 面最小               |
| 预算                   | video 单独预算桶（默认 30MiB），image 4MB 桶不动                                         | 4MB 桶装不下视频，直接并入会误伤图片                              |

## 5. 实施清单（Phase 1-4 摘要）

### Phase 1 类型与能力链路

- contracts：`ModelVideoContentBlock` + union + 文本投影；`media-policy` 加 `supportsVideo` 与全局 video 输入上限常量；`ModelProperties`/`ModelCapability` 加 `supportsVideo`；`ReadVideoOutput` + schema + `READ_VIDEO_MAX_INPUT_BYTES`
- shared：`PROTOCOL_MEDIA_INPUT_MODALITIES` 加 video + `supportsVideo` 投影 + zod schema 字段；`ZCodePromptVideoAttachment`；V4 继续沿用既有 20MiB 上传边界
- core：`TurnAttachment.type` 加 `"video"`

### Phase 2 core 链路

- `attachments.ts` video 分支（30MiB 校验、无压缩、artifact 持久化、超限路径引用降级）；`inferAttachmentMimeFromPath` 加 video 扩展名；`conversation.ts` 追加；`media-capability` strip；`media-budget` video 分桶；hydrator 回放；`read-video.ts` + Read prompt 更新；runtime methods 透传；bootstrap `mapProtocolPromptAttachment`/`attachment-refs` video 分支；`prompt-command.ts` `VIDEO_EXTENSIONS`

### Phase 3 adapter + 双 patch

- patch `@ai-sdk/openai-compatible`：file part 加 `video/*` → `video_url`
- patch `@ai-sdk/anthropic`：file part 加 `video/*` → `video` block（与 image 分支同构）
- `transform.ts` video case（user/assistant 降级）；`tool-result-media-projection` video 后置 part；`model.ts` 校验；`runner-options`/`registry` 透传；`models-dev.ts` modality 推导
- adapter effective capability：模型声明与 provider wire 能力取交集；OpenAI Responses 明确降为不支持

### 实现收口（本轮）

- strict JSON Schema 接受 `ModelVideoContentBlock`，并继续拒绝未知字段。
- catalog/provider override 合并保留并允许覆盖 `supportsVideo`。
- `FileSystemPort.readBinaryFile(maxBytes)` 在实际读取阶段仍保持有界，避免 stat/read 之间文件增长绕过限制；本地 video attachment 复用该入口。
- `readBinaryFile(maxBytes)` 只有读到 `0` 字节才判定 EOF；单次短读会继续从当前位置读取，避免把合法媒体截断后误判成功。
- Read 对零字节 video 返回稳定错误，不再生成随后会被 adapter 丢弃的空媒体。
- inline video 只接受 MIME 为 `video/*` 的严格 base64 data URL；缺少 base64 标记、正文非法或 MIME 不匹配时统一转成 `attachment_video_invalid`，不得落入通用文本附件分支。
- Read/tool 产生的纯媒体结果把完整 data-backed block snapshot 到 artifact，并在 completed tool part 的 `attachments` 中保存引用；冷恢复按当前模型/provider 重新投影。
- media capability 与 model I/O 摘要补齐 video 计数，不改变消息投影结果。
- Web/mobile 的 shared-host、`replayable`/`continuous` 交付边界和既有 20MiB V4 上传资源上限保持原样；
  Web inline video 在 base64 编码前按该上限返回结构化超限错误；不引入新的上传通道、chunk/staging 扩容或独立 runtime。

### Phase 4 UI

- `chatAttachments.ts`：mime 推断 + serialize video 分支（桌面本地路径 30MiB；Web inline 受 V4 20MiB 上限约束）
- composer 与已发送 image/video 共用媒体预览 Dialog；video 使用原生 controls/playsInline，
  加载或解码失败只改变预览提示；已发送附件优先读取持久 artifact；i18n；双主题

## 6. 测试与验证

- 单测先行：`model-transform.test.ts`（video case/strip/unsupported）、`model-transform-tool-media.test.ts`（video 后置 part，双 providerKind）、新 `video-wire.test.ts`（mock fetch 断言两种 base64 wire 形状）、`prompt-attachments.test.ts`（resolve/降级）、`media-budget.test.ts`（分桶）、read 工具、`chatAttachments.test.ts`（serialize/restore）、filesystem 短读、completed tool media 冷恢复
- `media-capability.test.ts`、artifact-store 与 bootstrap persistence 测试固定 image 行为不变，并覆盖
  user video 在 `true`、`undefined`、`false` 下均保留 request-local path，以及 inline video 冷重建。
- `pnpm typecheck` + `pnpm lint` 必过
- 手动端到端：桌面拖 mp4 → GLM-5V-Turbo（openai 端点 + 一个 anthropic 兼容端点）；Read mp4；历史回放；Web 端小视频
- e2e：先在 conversation case catalog/matrix 固定 composer video 与 Read video 的
  switch/cold-resume 代表组合；具体 pending spec 在剪枝确认后编写并使用 case-local fixture。

## 7. 风险表

| 风险                                    | 说明                                                                | 缓解                                                                            |
| --------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| anthropic 兼容端点 video 接受度         | Anthropic 官方 API 无 video block；共识形状是否被各端点接受未文档化 | 转换层通用；实测后 supportsVideo 收敛，不支持则 strip 占位                      |
| 30MiB base64 请求体（dataUrl 约 40MiB） | 可能撞网关单字段入站上限（ZCT-2085774 同类教训）                    | 实测；若需调整先更新全局产品策略与 spec；流式/引用上传需另行设计                |
| Web 端大视频传输                        | 既有 V4 上传事务上限为 20MiB，不能承载全局 30MiB video 输入上限     | 本期不扩张协议资源边界；如需支持，另行更新 spec 并设计传输方案                  |
| 双 patch 维护成本                       | AI SDK 包升级需 re-patch                                            | 本 spec §3 + patches/ 目录记录 patch 内容                                       |
| 模态互斥不处理                          | 混合附件网关报错透传                                                | 报错文案透传（用户确认）                                                        |
| OpenAI Responses 不接受 video file part | AI SDK 在网络请求前抛 unsupported，目录能力无法代表 wire 能力       | effective capability 明确降级；不影响 `openai-compatible` Chat Completions 路径 |
