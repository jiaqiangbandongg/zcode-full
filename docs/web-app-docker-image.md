# Web App Docker Image Spec

## 目标

提供一个本地可运行的完整 Web App Docker 镜像，包含 Web 静态资源、`@zcode/server` HTTP/WS 服务和 ZCode agent app-server。镜像用于本地 Docker 验证，不替代桌面端远控 shared-host 架构。

## 运行结构

```text
browser
  |
  | http://localhost:3030
  v
Node gateway
  |-- static files: packages/web/dist
  |-- /api/* proxy
  `-- /ws* proxy
       |
       v
@zcode/server entry-http
  |
  | stdio
  v
zcode.cjs app-server
  |
  | app data
  v
/data/.zcode
  |-- v2        app settings, task index
  `-- cli       agent session DB, logs, rollout
```

## 镜像内容

- 基础镜像通过 `NODE_BASE_IMAGE` build arg 指定，默认 `node:24-bookworm-slim`。
- builder 阶段执行：
  - `pnpm install --frozen-lockfile`
  - `packages/desktop/scripts/prepare-agent-node-bundle.mjs`
  - `pnpm --filter @zcode/server build`
  - `pnpm --filter @zcode/web build`
- runtime 阶段只暴露一个端口，默认 `3030`。
- runtime 阶段保留 server 的 pnpm runtime 依赖，因为 `entry-http.js` 会外置 `ssh2`、`node-pty`、`undici` 等包。

## 数据与工作区

- `HOME=/data`
- `ZCODE_DATA_BASE_DIR=/data`
- `ZCODE_STORAGE_DIR=/data/.zcode`
- 默认工作区为 `/workspace`

启动脚本只在 `setting.json` 缺失或 workspace 列表为空时 seed `/workspace`，不会覆盖已有 volume 中的模型、账号或任务数据。

## 本地使用

```bash
pnpm docker:build:web-app
pnpm docker:run:web-app
```

可覆盖变量：

```bash
IMAGE=zcode-web-app:dev NODE_BASE_IMAGE=node:24-bookworm-slim pnpm docker:build:web-app
PORT=3030 DATA_VOLUME=zcode-web-data WORKSPACE_DIR="$PWD" pnpm docker:run:web-app
```

访问 `http://localhost:3030/`。
