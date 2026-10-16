# Host 业务 API 代理支持

## 背景

Electron 的 Renderer、WebView 和 `electron.net` 使用 Chromium Session 代理；Window Host 是独立 Node 进程，`NodeApiClient` 默认使用 Node `fetch`，因此不会继承 `session.setProxy`。在强制代理网络下，OAuth token exchange 及其它 Host 业务 API 会直连失败。

## 最小方案

只在 `packages/services` 的 Host API 出口增加请求级 transport，并通过现有 `NodeApiClient` 的 `fetchImpl` 注入点接入：

- 代理、No Proxy 和 CA 读取已有 `AppSettings`；
- Host 首次发起请求时懒加载并冻结策略；
- No Proxy 按请求最终 URL 判断；
- 没有显式代理时保持直连；显式代理配置失败时不回退直连；
- 只覆盖 `NodeApiClient`，不改变 Renderer、Electron Session、Agent、Bot、telemetry 或其它裸 `fetch`。

```text
AppSettings
    |
    v
Host Node transport -- final URL -> No Proxy? --+--> direct
    |                                           `--> proxy
    v
NodeApiClient -> OAuth / Coding Plan / client-scenes / provider APIs
```

## 边界与后续

本次不把 CLI adapter 直接引入 services，也不设置 Host 进程全局 dispatcher。Host 与 Agent 共享 Node egress adapter 可以作为后续独立改造，避免扩大本工单的模型请求、WebFetch 和 HTTP MCP 回归范围。

## 验证

需要覆盖无代理直连、代理转发、No Proxy 命中、代理错误不直连，以及 endpoint rewrite 后选路；现有 timeout、abort 和响应流语义必须保持不变。
