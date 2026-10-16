# Debug Network Capture

`debug` 提供开发期本地网络抓包能力，用于把 Jcode/ZCode CLI 的 provider、MCP、plugin 和其他外部 HTTP(S) 请求与 `traceId` 串联起来。该能力只属于 debug app，不进入生产 CLI 默认执行路径。

## 目标

- debug server 启动时默认启动一个绑定本机回环地址的 HTTP(S) MITM 代理。
- 使用成熟库 `http-mitm-proxy` 负责 HTTP proxy、HTTPS CONNECT、按域名生成证书和 WebSocket 代理基础能力。
- 在仓库内提供本地证书容器目录，保存本机生成的 CA 证书和私钥，但生成物默认不提交。
- UI 实时展示最近网络请求，包含 method、URL、状态码、耗时、请求/响应字节数、错误和可归因的 trace。
- UI 在独立网络请求页展示请求列表，并把可归因请求转换为甘特图的 `network` lane span。
- API 和 UI 给出可直接用于启动 Jcode/ZCode 的显式环境变量：`ZCODE_HTTP_PROXY`、`ZCODE_AGENT_CA_CERT`，并在 UI 中提供一键复制的 shell 片段。

## 非目标

- 不做系统级全局代理安装，不修改操作系统信任链。
- 不长期保存完整请求体、响应体或敏感 header。
- 不保证捕获不遵循 proxy 环境变量、证书固定、原生 socket、HTTP/3/QUIC 或绕过 Node/adapter 的网络流量。
- 不在业务模块中直接读取 debug proxy 状态；运行时如需透传 trace，需要通过 HTTP adapter 契约注入 header。

## 证书容器

默认容器目录：

```text
packages/debug/certs/network-ca/
```

`http-mitm-proxy` 在该目录下维护：

- `certs/ca.pem`：需要导入本机信任链或通过 `ZCODE_AGENT_CA_CERT` 显式暴露给 ZCode runtime 的本地 CA 证书。
- `keys/ca.private.key`：本地 CA 私钥，仅用于当前开发机生成站点证书，必须被 `.gitignore` 排除。
- `keys/ca.public.key`：本地 CA 公钥，同样不需要提交。

如果要换证书，删除 `packages/debug/certs/network-ca/` 后重启 debug server 即可重新生成。该目录是 debug app 的本地状态容器，不参与发布产物。

## 启动与配置

debug server 默认启用网络代理，默认监听：

```text
127.0.0.1:4184
```

支持的 debug app 环境变量如下，均只影响 debug server：

- `ZCODE_DEBUG_NETWORK_CAPTURE=0|false|off`：关闭默认网络代理。
- `ZCODE_DEBUG_NETWORK_HOST`：代理监听 host，默认 `127.0.0.1`。除非明确需要远端机器接入，不应绑定公网地址。
- `ZCODE_DEBUG_NETWORK_PORT`：代理监听端口，默认 `4184`。
- `ZCODE_DEBUG_NETWORK_CA_DIR`：证书容器目录，默认 `packages/debug/certs/network-ca/`。
- `ZCODE_DEBUG_NETWORK_MAX_ENTRIES`：内存中保留的最近请求数，默认 `300`。

启动 Jcode/ZCode 时使用 API 返回的显式环境变量，例如：

```sh
ZCODE_HTTP_PROXY=http://127.0.0.1:4184 \
ZCODE_AGENT_CA_CERT=/absolute/path/to/packages/debug/certs/network-ca/certs/ca.pem \
pnpm --filter @zcode/cli dev
```

ZCode runtime 会过滤用户 shell 里的标准代理/证书变量；debug app 只提供 `ZCODE_HTTP_PROXY` 和 `ZCODE_AGENT_CA_CERT` 作为模型/provider 抓包的显式入口。普通 `http_proxy` 等用户变量会被封存后只恢复给 Bash/tool/MCP stdio 子进程，因此开发期如果要抓模型流量应使用这里的 `ZCODE_*` 变量，如果只想让用户命令/curl/git 走本机代理则可以继续使用标准代理变量。

UI 必须在网络请求页把这些变量渲染成可复制的启动环境片段，并至少支持：

- POSIX shell：`export NAME='value'`
- PowerShell：`$env:NAME = 'value'`
- Windows cmd：`set "NAME=value"`

复制操作只写入浏览器剪贴板，不自动修改用户 shell、系统环境变量或 debug server 进程环境。

## Trace 归因

代理从请求 header 和 query 中提取归因信息：

- `x-zcode-trace-id`、`x-trace-id`、`traceparent`
- query 中的 `traceId`、`trace_id`

HTTP adapter 应把当前 `ExecutionContext` 的 `traceId` 写入 `x-zcode-trace-id` header。`sessionId`、`turnId`、`spanId`、`parentSpanId`、`modelRequestId` 等细粒度诊断信息只保存在 runtime 事件和日志中，不作为出站网络 header 发送。代理只读取这些归因信息，不生成新的 runtime trace，也不把未归因请求伪装成已归因。

## API 契约

### `GET /api/network/status`

返回代理状态、端口、证书路径、可复制环境变量、最近请求容量和最近错误。

### `GET /api/network/requests`

Query：

- `traceId?: string`
- `limit?: number`

返回最近请求，按时间倒序。`traceId` 存在时只返回匹配请求。

### `GET /api/network/events`

Server-Sent Events。连接建立时先发送 `status` 和 `snapshot`，之后实时发送：

- `status`：代理启动、停止或失败。
- `request`：新增或更新的网络请求。
- `reset`：请求缓冲区被清空。

## 甘特图集成

前端可以把 `NetworkRequestRecord` 转换为 `TraceSpan`：

- `id = "network:" + request.id`
- `lane = "network"`
- `source = "network"`
- `startAt = request.startedAt`
- `endAt = request.completedAt`
- `status = pending -> running, complete -> ok, error -> error`
- `traceId` 沿用代理归因字段；`sessionId`、`turnId`、`spanId` 如需展示，应从 runtime event/log 侧合并获得

未归因请求可以只出现在独立网络请求页；当用户在甘特图中查看某个 trace 时，只合并 `traceId` 匹配的网络请求，避免把其他进程的流量误串进当前 trace。

## 数据安全

默认只保存 header 的脱敏副本和字节数，不保存 body。以下 header 值必须显示为 `[redacted]`：

- `authorization`
- `proxy-authorization`
- `cookie`
- `set-cookie`
- `x-api-key`
- `api-key`
- `openai-api-key`

## 测试覆盖

- API 在未启用代理时返回稳定的 disabled 状态。
- 代理 store 能按容量保留最近请求，并按 `traceId` 过滤。
- header/query trace 归因能识别 `x-zcode-*` 与 query 参数。
- HTTP proxy smoke test 使用临时本地 upstream 和临时证书目录，不依赖真实外网或用户证书。
