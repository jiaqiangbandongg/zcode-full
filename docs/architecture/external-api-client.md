# 外部 API 请求收拢

## 范围

本次只收拢外部业务 API，请求统一经过 `ApiClient`：

- OAuth provider 的 token / userinfo / 业务 API key 链路
- model provider 的远端配置与 release 查询

明确不包含：

- 本地 `/api/*`
- WebSocket
- SSH
- RPC / IPC
- 浏览器本地资源读取

## 统一抽象

共享层新增 `packages/shared/src/api.ts`，定义三类基础契约：

- `ApiClient`：项目内唯一标准 HTTP 接口，保持 `fetch-compatible`
- `ApiRequestInit`：基于 `RequestInit`，补充 `timeoutMs`
- `ApiError`：统一承载 `url`、`method`、`status` 与错误消息

这样 repo / adapter 只依赖共享契约，不感知 Node 专属实现细节。

## 默认实现

Node/Desktop host 默认实现放在 `packages/services/src/providers/api/`：

- `nodeApiClient.ts`：内部调用 Node 24 全局 `fetch`
- `apiJson.ts`：统一处理 JSON 读取、非 2xx 错误与解析失败
- `apiEndpoints.ts`：集中管理外部 API endpoint 常量

当前 Node 24 的全局 `fetch` 底层就是 `undici`，因此：

- 我们享受 `undici` 的运行时能力
- 业务层不直接 import `undici`
- 后续若必须使用 `undici` 高级能力，只需调整 provider 实现层

## 注入方式

按分层约束，`ApiClient` 作为横切能力只通过 `Providers` 注入：

- `packages/services/src/node.ts` 创建默认 `NodeApiClient`
- desktop host 复用同一个 `NodeApiClient`
- OAuth service / model provider service 通过依赖注入消费 `ApiClient`
- 测试场景可替换成 mock client

业务 repo / adapter 不再直接写裸 `fetch`，也不再暴露 `fetchImpl?: typeof fetch` 给业务层。

## 已迁移链路

- `packages/services/src/oauth/providers/*`
- `packages/services/src/model-provider/repo/*`
- `packages/services/src/model-provider/modelProviderService.ts`
- `packages/services/src/model-provider/modelProviderConnectivityHelpers.ts`

这些链路现在都通过 `ApiClient` 访问外部业务 API。

## 当前边界

v1 仅统一以下能力：

- timeout
- headers 合并
- 请求级 `x-request-id`
- JSON / text 读取辅助
- 非 2xx 错误归一

当前刻意不做：

- 重试
- 拦截器
- 连接池高级配置上抛到业务层
- 非 HTTP 协议统一

## 后续约束

新增外部业务 API 时，遵循两条规则：

1. 业务代码只依赖 `ApiClient`
2. endpoint 常量集中放在 provider/config 层，不在 repo / service 中散落硬编码 URL
3. 请求级诊断 ID 统一使用 `x-request-id`，由 `ApiClient` 出口生成；调用方显式传入时保留原值

这样可以保持 desktop / web / remote 模式的实现边界稳定，也能避免把 Node 运行时语义泄漏到业务层。
