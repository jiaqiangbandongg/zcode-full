# Release Platform Contract

这是 z-code 与独立打包平台之间的 v1 契约入口。

| 文件 | 用途 |
| --- | --- |
| [`release-candidate.v1.schema.json`](./release-candidate.v1.schema.json) | 候选版本和平台制品的机器校验 Schema |
| [`release-platform.v1.openapi.yaml`](./release-platform.v1.openapi.yaml) | Control plane REST API 的 OpenAPI 3.1 描述 |
| [`release-platform-api-v1.md`](./release-platform-api-v1.md) | 状态机、校验规则、错误、事件、安全和迁移约束 |
| [`docs/adr/0004-release-packaging-platform-contract.md`](../../adr/0004-release-packaging-platform-contract.md) | 为什么由平台托管候选状态和正式发布 |

## v1 实现前必须完成

1. 将 `release-candidate.v1.schema.json` 纳入平台服务端和 worker contract tests。
2. 统一 notes revision 为 `sha256:<hex>` + RFC 8785 JCS 计算方式。
3. 将当前 runner 共享目录适配为对象存储 candidate prefix；共享目录不能进入平台 API。
4. 平台服务端必须重新读取对象并校验大小、SHA-256、SHA-512 和基础更新 YAML。
5. 发布接口必须实现幂等、审计和 `publish_failed_retryable` 重试。

当前 z-code 中的 `release:approve` 和 runner 共享目录属于迁移期兼容路径，不是平台 v1 的最终状态源；仓库内不再额外生成 `candidate-manifest.json`。
