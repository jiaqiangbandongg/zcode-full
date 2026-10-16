# ZCode 打包平台 API 与契约 v1

- 状态：Proposed
- 版本：`release-platform.v1`
- 日期：2026-08-18
- 适用范围：z-code 构建 worker、打包平台 control plane、审批 UI、发布服务

## 1. 目标与非目标

目标是把 z-code 变成可替换的构建 worker，并让打包平台成为 release candidate 的唯一状态源。

本契约不规定平台使用 PostgreSQL、队列、对象存储或具体 Web 框架；只规定跨系统可观察和可重试的边界。

非目标：不把 Electron 自动更新协议改成新的客户端协议；不要求第一版平台接管 release-it 的版本计算；不允许 worker 直接写稳定 feed。

## 2. 资源模型

### 2.1 ReleaseCandidate

完整 JSON Schema 位于 [`release-candidate.v1.schema.json`](./release-candidate.v1.schema.json)。关键字段：

| 字段 | 语义 |
| --- | --- |
| `candidateId` | 平台生成的不可变候选身份，格式 `cand_...` |
| `source` | repository、完整 commit、SemVer version、可选 ref |
| `state` | 平台状态机当前状态 |
| `platforms` | 每个 OS/arch 的 artifact 和基础更新元数据 |
| `provenance` | builder、镜像、工具版本和 signer |
| `createdAt` / `expiresAt` | 候选保留周期 |

候选制品的事实来源是对象存储中的 `objectKey` 和 digest，不是 runner 路径、GitLab artifact URL 或工作区共享目录。

### 2.2 NotesDraft 与 Approval

日志独立于候选制品版本化：

```json
{
  "candidateId": "cand_01J...",
  "revision": "sha256:...",
  "locales": {
    "zh-CN": { "markdown": "# Release ..." },
    "en-US": { "markdown": "# Release ..." }
  },
  "status": "approved",
  "approvedBy": { "userId": "u_123", "displayName": "Reviewer" },
  "approvedAt": "2026-08-18T14:00:00Z"
}
```

`approvedBy` 和 `approvedAt` 必须由平台根据当前认证身份写入，不能信任 worker 在请求体中自报。

日志被修改时必须生成新的 `revision`；旧 revision 不得原地覆盖。

`revision` 的计算固定为：先将每个 locale 的 Markdown 统一为 UTF-8、LF 换行并去除首尾空白，再按 locale key 的字典序组成对象，使用 RFC 8785 JSON Canonicalization Scheme 序列化，最后计算 SHA-256 hex，格式为 `sha256:<64-hex>`。这样不同语言运行时不会因为 JSON key 顺序产生不同 revision。

### 2.3 Publication

发布是候选制品和审批 revision 的一次绑定：

```json
{
  "publicationId": "pub_01J...",
  "candidateId": "cand_01J...",
  "notesRevision": "sha256:...",
  "channel": "gray",
  "state": "publishing"
}
```

平台生成包含 `releaseNotesByLocale` 的最终 `latest.yml`，写入正式对象路径后才推进为 `published`；不得生成独立 locale 更新清单。

## 3. 状态机

```text
created -> building -> ready -> approval_pending -> approved -> publishing -> published
             |             |             |              |
             v             v             v              v
        build_failed    cancelled      rejected   publish_failed_retryable
```

状态迁移约束：

| 当前状态 | 允许迁移 | 触发者 |
| --- | --- | --- |
| `created` | `building`, `cancelled` | platform scheduler |
| `building` | `ready`, `build_failed`, `cancelled` | build worker callback |
| `ready` | `approval_pending`, `cancelled` | platform |
| `approval_pending` | `approved`, `rejected` | approval API |
| `approved` | `publishing`, `cancelled` | platform |
| `publishing` | `published`, `publish_failed_retryable` | publisher |
| `publish_failed_retryable` | `publishing`, `cancelled` | retry API |

重复请求必须返回当前资源，不得重复创建候选、发布任务或对象。

## 4. API

Base URL：`/v1`。所有响应必须包含 `requestId`；写操作必须支持 `Idempotency-Key`。

### 4.1 创建候选版本

```http
POST /v1/release-candidates
Idempotency-Key: <client-generated-key>
Authorization: Bearer <service-token>
Content-Type: application/json
```

请求：

```json
{
  "source": {
    "repository": "z-code",
    "commit": "40-to-64-char-git-sha",
    "version": "3.8.0",
    "ref": "refs/tags/v3.8.0"
  },
  "targets": [
    { "os": "macos", "arch": "arm64" },
    { "os": "macos", "arch": "x64" },
    { "os": "windows", "arch": "x64" },
    { "os": "windows", "arch": "arm64" },
    { "os": "linux", "arch": "x64" },
    { "os": "linux", "arch": "arm64" }
  ]
}
```

成功返回 `201` 和 `ReleaseCandidate`。同一 `Idempotency-Key` 重试返回同一 `candidateId`。

### 4.2 创建构建任务

```http
POST /v1/release-candidates/{candidateId}/builds
Idempotency-Key: <candidateId>:<os>:<arch>:<attempt>
```

请求：

```json
{
  "platform": { "os": "windows", "arch": "x64" },
  "workerPool": "windows-signing",
  "constraints": { "signingRequired": true, "notarizationRequired": false }
}
```

响应 `202`：

```json
{
  "buildId": "build_01J...",
  "candidateId": "cand_01J...",
  "state": "queued",
  "upload": {
    "manifestUploadUrl": "https://...",
    "artifactUploadPrefix": "candidates/cand_01J.../windows/x64/",
    "expiresAt": "2026-08-18T15:00:00Z"
  }
}
```

制品通过预签名 URL/短期凭据上传，不经过 control plane 的应用服务器。

### 4.3 完成构建

```http
POST /v1/release-candidates/{candidateId}/builds/{buildId}/complete
Idempotency-Key: <buildId>:complete
```

请求体为该平台的 manifest 子集和 provenance。平台必须在接受前检查：

1. 所有 `objectKey` 位于该 candidate 的前缀下；
2. 对象存在、大小一致、SHA-256/SHA-512 一致；
3. platform/arch 与 build request 一致；
4. base update metadata 的 version、path、files digest 与 artifact 一致。

成功返回 `200`，build 为 `succeeded`；校验失败返回 `422`，候选进入 `build_failed` 或保留为可重试状态。

### 4.4 提交日志草稿

```http
POST /v1/release-candidates/{candidateId}/notes
Idempotency-Key: <candidateId>:notes:<revision>
```

请求：

```json
{
  "revision": "sha256:<canonical-localized-notes-json>",
  "locales": {
    "zh-CN": { "markdown": "# Release ..." },
    "en-US": { "markdown": "# Release ..." }
  }
}
```

平台验证 revision 后创建 `notesDraftId`，并将候选置为 `approval_pending`。同一 revision 幂等。

### 4.5 审批日志

```http
POST /v1/release-candidates/{candidateId}/approvals
Idempotency-Key: <candidateId>:approve:<revision>
If-Match: <candidate-etag>
```

请求：

```json
{
  "notesRevision": "sha256:...",
  "decision": "approve"
}
```

`decision` 允许 `approve` 或 `reject`。审批人由认证 token 确定；审批接口不接受调用方自定义 `approvedBy`。

### 4.6 发布

```http
POST /v1/release-candidates/{candidateId}/publications
Idempotency-Key: <candidateId>:publish:<notesRevision>:<channel>
```

请求：

```json
{
  "notesRevision": "sha256:...",
  "channel": "gray"
}
```

平台必须在进入 `publishing` 前确认：候选为 `approved`、revision 匹配、所有目标平台为 `ready`，并且没有正在进行的同 channel publication。

返回 `202` 和 `publicationId`。正式 YAML 的生成、上传、release API 调用均属于该 publication；失败时返回 `publish_failed_retryable`，不得回退为重新构建。

### 4.7 查询和重试

```http
GET  /v1/release-candidates/{candidateId}
GET  /v1/release-candidates/{candidateId}/events
POST /v1/release-candidates/{candidateId}/retry
```

`retry` 只允许针对 `build_failed` 或 `publish_failed_retryable`，并且必须产生新的 attempt，不修改已有 artifact digest。

## 5. 错误契约

所有 4xx/5xx 返回：

```json
{
  "error": {
    "code": "ARTIFACT_DIGEST_MISMATCH",
    "message": "artifact sha256 does not match object",
    "details": { "artifactId": "art_01J..." },
    "retryable": false,
    "requestId": "req_01J..."
  }
}
```

最低错误码：

- `INVALID_SCHEMA`
- `CANDIDATE_NOT_FOUND`
- `INVALID_STATE_TRANSITION`
- `IDEMPOTENCY_CONFLICT`
- `ARTIFACT_NOT_FOUND`
- `ARTIFACT_DIGEST_MISMATCH`
- `UPDATE_METADATA_MISMATCH`
- `NOTES_REVISION_MISMATCH`
- `APPROVAL_REQUIRED`
- `PUBLICATION_IN_PROGRESS`
- `PUBLISH_FAILED_RETRYABLE`

## 6. 事件契约

平台对外发送 CloudEvents 1.0 风格事件，事件只表达状态变化，不携带大文件：

```json
{
  "specversion": "1.0",
  "type": "zcode.release.candidate.state_changed.v1",
  "id": "evt_01J...",
  "source": "packaging-platform",
  "subject": "cand_01J...",
  "time": "2026-08-18T14:00:00Z",
  "data": {
    "candidateId": "cand_01J...",
    "from": "building",
    "to": "ready",
    "buildId": "build_01J..."
  }
}
```

最低事件类型：

- `zcode.release.candidate.created.v1`
- `zcode.release.build.state_changed.v1`
- `zcode.release.notes.approval_changed.v1`
- `zcode.release.publication.state_changed.v1`

事件消费者必须按 `id` 去重，并以查询 API 为最终事实来源。

## 7. 鉴权与安全

- worker 使用 OIDC workload identity 或短期 service token；不把 OSS 长期密钥写入 GitLab variables。
- API scope 至少区分 `candidate:create`、`build:complete`、`notes:submit`、`publish:create`、`release:promote`。
- 预签名上传 URL 必须有过期时间、candidate 前缀和单对象限制。
- 平台服务端重新计算/读取对象 digest，不能信任 worker 只提交的摘要。
- 发布前保留完整审计记录：发起人、审批人、candidateId、notes revision、publicationId、对象 digest。

## 8. 迁移边界

1. 先让现有 GitLab worker 生成 v1 manifest，并把共享目录上传为候选对象。
2. 引入 platform adapter：`create candidate -> build complete -> notes submit -> publish`。
3. 平台接管审批和最终 YAML 生成；z-code 的 `release:approve` 只保留兼容路径。
4. 平台接管 OSS/CDN/release API 凭据和 gray/stable 状态。
5. 删除 z-code 内部的正式发布脚本，仅保留本地 manifest/YAML 校验工具。

## 9. 契约验收用例

- 同一 `Idempotency-Key` 重试不会创建第二个 candidate/build/publication。
- manifest 中任意 artifact digest 错误时，build 不进入 `ready`。
- notes revision 与 candidate 不匹配时，审批和发布都返回 `NOTES_REVISION_MISMATCH`。
- 未审批 candidate 调用 publish 返回 `APPROVAL_REQUIRED`，不写正式对象。
- publish 失败后 retry 不重新构建，且 artifact digest 不变。
- 事件重复投递不会造成重复状态迁移。
- worker token 不能调用 `release:promote`。
