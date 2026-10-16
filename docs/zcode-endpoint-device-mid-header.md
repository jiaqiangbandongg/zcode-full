# ZCode Endpoint DeviceMid Header

## 背景

App 层访问 ZCode endpoint（默认 `https://zcode.z.ai`，或当前 `ZCODE_BASE_URL` / `ZCODE_PRODUCTION_BASE_URL` 派生 endpoint）时，需要统一携带设备标识 header，便于后端把 OAuth、client configs、billing、snapshot 等请求和既有 telemetry/ARMS 设备维度对齐。

## 设计

- 设备标识复用既有 telemetry state 中的 `deviceMid`，即 `{appConfigDir}/telemetry-state.json` 的 `deviceMid` 字段。
- `buildZCodeSourceHeadersFromContext()` 是跨 App/Agent 的纯来源 header 组装规则；
  app 服务层 `buildZCodeSourceHeaders()` 继续负责读取已有 `deviceMid` 后调用该共享规则。
- 只读取已存在且可作为 HTTP header 输出的 `deviceMid`；读取失败或字段缺失时不在该函数里生成新设备 ID，避免改变设备 ID 生命周期。
- 通用规则里 `X-Device-Mid` 是“有值才带”，但 `/api/v1/zcode-plan/billing/balance` 服务端把它当必填（缺失返回 `400 code 3001 parameter error`）。因此任何会发起 Start Plan 权益查询的运行环境都必须在首次请求前确保 `deviceMid` 已落盘，不能依赖“可选头缺失也能成功”。
- 设备 ID 的生成由各运行环境的生命周期所有者负责：Desktop main 在窗口创建前同步确保；远端 `zcode-server`（SSH/WSL/Docker 的 stdio entry）在握手完成、services 创建前调用 `ensureTelemetryDeviceMid()` 异步确保；独立 CLI 在首次模型请求时自行确保。三者读写同一个 `telemetry-state.json` 的 `deviceMid` 字段，并用同名 `telemetry-state.lock` 互斥。
- `NodeApiClient` 仍只负责在命中当前 ZCode endpoint 时注入 `buildZCodeSourceHeaders()` 返回的 headers，并保留调用方显式传入的同名 header。
- ZCode CLI 的 provider endpoint routing 配置 GET 通过独立 bootstrap source-header provider
  异步读取同一 telemetry state，再调用共享组装规则；该读取不会进入模型 transport 或普通 tool HTTP 出口。

## 覆盖范围

该收口覆盖 app services 里走 `NodeApiClient` 的 ZCode endpoint 请求，包括 OAuth token、client configs、release latest、Start Plan billing、feedback 等，以及 ZCode CLI 独立发起的 provider endpoint routing 配置 GET。其他直接绕过 `NodeApiClient` 的请求仍需在各自出口单独处理。

## 远端 server 的设备身份

远程工作区（SSH/WSL/Docker）里只有 `zcode-server` 与 Agent 进程，没有 Desktop main。3.12.0 起 Start Plan 等账号权益由远端自己查询，而 `billing/balance` 服务端把 `X-Device-Mid` 视为必填；远端主机上若没有任何进程写过 `telemetry-state.json`，请求就会缺头并被拒绝为 `parameter error`，Start Plan 在远程工作区判成未开通。

```text
桌面端                                   远端主机
main ──ensureDesktopDeviceMidSync──┐     entry-stdio ──ensureTelemetryDeviceMid──┐
                                   ├─> ~/.zcode/v2/telemetry-state.json.deviceMid <─┤
host ──buildZCodeSourceHeaders 读──┘     services ──buildZCodeSourceHeaders 读──────┤
                                          zcode-cli ──ensureCliDeviceMid──────────┘
```

- 远端 server 在 `packages/server/src/entry-stdio.ts` 握手完成后、services 创建前调用 `ensureRemoteServerDeviceMid()`，内部复用 `@zcode/services/node` 的 `ensureTelemetryDeviceMid()`，与 telemetry 上报、CLI 使用同一个文件、字段与锁，同一主机上 server 与 Agent 得到同一个 `deviceMid`。
- 远端拥有自己的设备身份，不借用也不下发桌面 `deviceMid`；同一远端被多台桌面连接时身份保持稳定。
- 确保失败（文件系统或锁异常）只记录 warn 并继续启动；此时请求与修复前一样省略 `X-Device-Mid`，不伪造设备 ID。
