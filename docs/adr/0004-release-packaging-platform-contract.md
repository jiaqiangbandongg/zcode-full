# Release Candidate 由打包平台托管

- 状态：Proposed
- 日期：2026-08-18
- 关联规格：`docs/specs/release-platform/release-platform-api-v1.md`

## Context

当前 z-code 的构建和发布已经拆开，但候选 manifest、审批文件和产物仍依赖 GitLab runner 共享目录。这个边界无法被独立打包平台稳定消费，也无法提供统一的重试、审计、幂等和跨平台状态。

## Decision

引入版本化的 `release-candidate.v1` 契约，并将打包平台作为 Release Candidate 的唯一状态源：

```text
z-code worker                    Packaging Platform
build/sign/notarize              candidate state machine
upload immutable artifacts  ---> object storage + manifest
submit build result         ---> approval / publication
                                  final latest*.yml + rollout
```

z-code worker 不得直接写稳定 feed、调用正式 release API 或持有长期 OSS 凭据。最终唯一的 `latest.yml` 由平台基于不可变 `update.base.yml`、artifact digest 和已审批 notes revision 生成，多语言日志统一写入 `releaseNotesByLocale`。

跨系统契约固定使用：

- JSON Schema `release-candidate.v1`
- REST API `release-platform.v1`
- CloudEvents 风格状态事件
- `Idempotency-Key` 和 request ID
- OIDC/短期 token scope

## Alternatives

### 继续扩展 GitLab CI

实现成本最低，但状态仍绑定 runner、共享目录和 CI YAML；平台接管时需要重新解释内部脚本，重试和审计边界也不清晰。拒绝。

### 只上传压缩包，不上传标准 manifest

平台可以存文件，但无法可靠验证版本、平台、digest、基础 update metadata 和 provenance。拒绝。

### 平台只做审批，z-code 继续发布

人工体验改善有限，正式 feed/API 仍然由 worker 控制，无法实现权限隔离和统一发布状态。拒绝。

## Consequences

正面影响：

- 构建 worker 可替换为 GitLab、Buildkite 或自托管 runner。
- 候选制品可重复发布，日志修改不触发重新打包。
- 平台能统一管理审批、重试、审计和 gray/stable。
- runner 不再需要正式 OSS/release API 长期凭据。

代价与风险：

- 需要维护一个候选状态服务和对象存储生命周期。
- v1 契约需要兼容旧 z-code CI 一段迁移期。
- 平台必须承担 digest 校验、幂等处理和发布失败恢复。

## Rollback

迁移期间保留 z-code 的兼容发布路径开关。若平台不可用，可以回退到旧 CI release 链路；回退不得让 test/sandbox 链路越过正式环境守卫，也不得复用平台未确认的 notes revision。
