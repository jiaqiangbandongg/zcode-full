# Remote prompt attachment materialization

> **当前状态**：下文首段 `zcodeTaskService.sendPrompt` 描述保留为 V4 前的故障背景；
> 当前实现以“V4 eager staging”一节和 `IPromptAttachmentTransferService` 为准。

## 背景

WSL/SSH/Docker remote workspace 中，桌面 renderer 和 host 仍运行在本机，ZCode Agent runtime 运行在远端。`ZCodePromptAttachment.localPath` 过去只表达“一个本地路径”，没有说明这个路径属于 desktop host 还是 remote runtime。

这会让以下链路在 WSL remote 下断裂：

- 长文本粘贴超过阈值后，desktop main 先写入 Windows 侧 `.zcode/tmp/paste-attachments/...`，再把 Windows `localPath` 作为 file 附件发送。
- 桌面文件选择、拖拽文件和大图为了避免 base64 放大，也会优先发送 `localPath`。
- 带本地缓存路径的图片附件如果进入远端 runtime，后续工具按该路径读取时会访问错误机器的文件系统。

远端 agent 收到这些附件后，会在 remote runtime 的文件系统里 `stat/read` 该 `localPath`。WSL 中读取 `C:\Users\...` 或其他 host 路径会失败，因此表现为粘贴内容/附件不可读。

## 约束

- 不让 agent/core runtime 理解 Windows 路径；core 只应读取自己所在机器可访问的路径。
- 不把大文件和长文本退回 inline/base64，避免再次放大 RPC payload 和 prompt 上下文。
- 桌面本地 workspace 继续原样使用 `localPath`。
- remote workspace 在跨 host -> remote 边界前完成附件物化，保持 web remote shared-host 链路不另起 runtime。

## 方案

desktop host 包装远端 `zcodeTaskService.sendPrompt` 时，对 prompt 附件做 materialize：

1. 扫描 `attachments` 中带 `localPath` 的附件。
2. 将 host 可读的附件上传到 remote runtime 可读的用户私有临时目录：`~/.zcode/tmp/prompt-attachments/<trace>/<random>/...`。
3. 用上传后的 remote path 替换附件 `localPath`，再调用远端 `sendPrompt`。
4. 保留 `sourceKind: "clipboard-text"`，长文本粘贴仍作为 deferred file reference，不提前塞入 prompt body。
5. 如果 prompt 正文里包含被替换的附件路径，也同步替换成 remote path，避免缓存图片等场景提示模型读取 host 路径。

这只是边界修复。长期更完整的协议语义可以新增 attachment locality 字段，将 host-local、runtime-local、inline 三类来源显式编码。

## V4 eager staging

V4 composer 不再等到点击发送才 materialize。选择 host-local 附件后，renderer 通过
`IPromptAttachmentTransferService` 立即请求承载当前 workspace scope 的 Local/Remote Host 暂存；服务按 operation id
发布连接级进度，并支持 cancel/cleanup。

```text
renderer composer
  -> workspace service resolver
     ├─ local workspace
     │  -> window Local Host IPromptAttachmentTransferService
     │  -> stat + localPath zero-copy
     │  -> AttachmentRef(local path, staged=false)
     ├─ SSH/WSL/Docker remote workspace
     │  -> target Remote Host IPromptAttachmentTransferService
     │  -> IRemoteBackend.upload(progress, signal)
     │  -> ~/.zcode/tmp/prompt-attachments/<operation>/...
     │  -> AttachmentRef(remote path, staged=true)
     └─ Server remote workspace
        -> server-authoritative IPromptAttachmentTransferService
        -> AttachmentRef(server runtime path)
```

service resolver 以当前 workspace session accessor 为边界：本地 workspace 使用窗口 Local Host 的
`createLocalPromptAttachmentTransferService()`；SSH/WSL/Docker workspace 必须使用 Remote Host 注入的
`createRemotePromptAttachmentTransferService()`；Server remote 则完整使用 server-authoritative service
collection。workspace service scope 只决定选用哪一个 service 实例，不创建新的 Host 进程。

- 身份隔离使用 `workspaceKey = workspaceIdentity?.trim() || workspacePath`；远程连接路由继续传递 `remoteSessionId`。
- composer 判断附件是否必须远端物化时，对任意非空 `workspaceIdentity` 都按远端目标
  fail closed，不要求 identity 已能被当前解析器识别；`remoteSessionId` 也直接证明目标是远端。
  identity 已建立但 session id 尚未注入时，host-local 附件必须停在 `waitingSession`，待
  session 就绪后再 stage；禁止非规范/新格式 identity 在注入窗口退化为本地 `localPath` 零复制。
- SSH/WSL/Docker workspace 的 session service accessor 必须显式使用远端
  `promptAttachmentTransferService`。不能从本地 `baseServices` 继承该服务，否则 eager stage
  会在桌面本机完成并把 `/Users/...`、`C:\Users\...` 等 host path 原样交给远端 CLI。
- 远端 host-local 附件调用 `stage` 后必须得到 `staged: true`。`staged: false` 表示传输服务
  没有跨越 host -> remote 文件系统边界，composer 必须 fail closed 并保持发送门禁，不能把返回
  的 host path 包装成 ready `AttachmentRef`。
- 运行中暂存记录归承载该 workspace scope 的 Local/Remote Host 所有，relay/main 不维护镜像。
- 发送成功后将 staged file 标记为 adopted，供 runtime 在当前 session/queue 中读取；发送前删除或取消则立即清理。
- 未显式清理的 eager stage 由 24 小时 janitor 回收，避免 renderer 崩溃/断线遗留文件。
- SSH SFTP 失败回落 exec pipe 时保留同一 operation id，进度不回退；WSL/Docker 也使用同一 progress/cancel 合同。
- runtime 换代后未提交 ref 视为失效，renderer 按附件重试预算重新 stage；已进入 CLI queue/transcript 的 `AttachmentRef` 仍由 CLI 权威状态管理。

回归测试必须为本地、远端 accessor 注入不同的 transfer service 实例，并断言：

- 本地 workspace 选择窗口 Local Host 实例，`stage` 返回 `staged: false` 并保留本机 `localPath`，
  不调用 `IRemoteBackend.upload`。
- 普通 remote workspace 选择远端实例，以触发 `IRemoteBackend.upload`。
- server remote workspace 保持 server-authoritative accessor，所有服务均由远端提供。
- 远端 identity（包括当前解析器尚不识别的非规范/新格式 identity）已知但 `remoteSessionId`
  暂缺时，host-local 文件保持 waiting；id 注入后只调用远端 `stage`，不经过本地
  `attachmentPut`/零复制路径。
- 远端 `stage` 返回 `staged: false` 时附件进入 permanent failed，`prepareForSend` 返回 null。

## 状态与多端边界

```text
desktop remote composer（renderer-local draft）
  | workspaceIdentity=remote:*，remoteSessionId 暂缺
  v
waitingSession --remoteSessionId ready--> queued/uploading
  |                                      |
  |                                      v
  |                              remote transfer stage
  |                                      |
  |                         staged:true  |  staged:false
  |                              ready <-+-> permanent failed
  |                                           |
  +-------------------------------------------+-> 禁止 sendText admission

mobile /remote
  -> 继续 attachment 到桌面已有 shared host
  -> 不创建新 runtime，不在 relay/main 保存附件状态
  -> replayable 只恢复已 admission 的 conversation intent，不恢复 renderer-local 上传进度
```
