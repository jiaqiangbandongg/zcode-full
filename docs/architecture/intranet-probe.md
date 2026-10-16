# 内网探测能力（外部服务版）

## 目标

提供独立、可复用的内网连通性探测能力。具体产品功能是否使用探测结果，由对应功能自行定义。

## 方案

- 在内网机器启动一个轻量 HTTP 服务（默认 `10.0.0.100:3850`，可通过 `INTRANET_MACHINE_HOST` 覆盖）
- 客户端调用 `systemService.probeIntranet(...)` 探测该服务
- 服务返回固定 JSON：`{ ok: true, marker: "xxx" }`
- 客户端校验：
  - HTTP 状态 `2xx`
  - `ok === true`
  - 如果配置了 `expectedMarker`，则 `marker` 必须匹配

## 服务端（独立于本仓库）

内网探测服务不跟随本项目代码维护，直接在内网机器上独立部署即可。

默认探测路径：

- `GET /api/intranet/probe`
- `POST /api/intranet/probe`（兼容，行为一致）

可选环境变量：

- `PORT`（默认 `3850`）
- `ZCODE_INTRANET_PROBE_PATH`（默认 `/api/intranet/probe`）
- `ZCODE_INTRANET_PROBE_MARKER`（默认 `zcode-intranet`）
- `ZCODE_INTRANET_PROBE_TOKEN`（可选，配置后客户端需带 `x-zcode-intranet-token`）

## 客户端

调用示例：

```ts
const result = await services.systemService.probeIntranet({
  targets: [
    {
      kind: "service",
      url: "http://10.0.0.100:3850/api/intranet/probe",
      expectedMarker: "zcode-intranet",
      // token: "可选",
    },
  ],
});

if (result.isIntranet) {
  // 当前网络可以访问目标内网服务
}
```

### SSH 入口展示策略

UI 里的远程连接（SSH）入口始终展示。SSH 是否可用取决于目标机器、网络链路和凭据，不使用内网探测结果作为产品可见性门禁。

## 兼容说明

`probeIntranet` 仍保留旧的 TCP 目标探测（`host + port`），用于历史兼容或双轨过渡。
