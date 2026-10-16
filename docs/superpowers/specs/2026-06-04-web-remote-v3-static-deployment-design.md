# Web Remote v3 静态资源并行部署设计

## 背景

当前手机远控页是 `packages/web` 的 Vite SPA。生产发布链路是先执行
`pnpm run build:web-remote-control`，把产物写入 `packages/web/dist`，再用
`Dockerfile.web-remote-control` 将静态产物复制到 `nginx:alpine` 镜像中。现有服务路径是
`/remote`，发布脚本默认推送 `uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-v2:<tag>`，
并在 `cgx-dev-k8s` 仓库中更新 `zcode/frontend/deployment-remote.yaml`。

新版本需要使用新的服务路径 `/remote/v3`，同时保留原来的 `/remote` 资源、镜像、脚本、
deployment 和服务行为不变。

## 目标

1. 新版本手机远控静态资源部署到 `/remote/v3`。
2. 原 `/remote` 资源构建、镜像构建、发布脚本和 k8s deployment 更新路径保持不变。
3. v3 发布脚本最后只更新 `zcode/frontend/deployment-remote-v3.yaml`。
4. 新版本桌面端默认二维码 URL 指向 `https://zcode.z.ai/remote/v3`。
5. v3 静态资源继续由 nginx 托管，不引入 Node server、relay、agent runtime 或 desktop runtime 资源。
6. `/remote` 与 `/remote/v3` 的浏览器资源路径互不依赖，避免任一版本发布影响另一版本。

## 非目标

1. 不修改外部 relay 协议、`rpc-frame` 透传、shared-host attachment、task stream 或 replayable 恢复语义。
2. 不把 `/remote/v3` 做成 `/remote` 容器中的子路由复用。
3. 不在 z-code 发布脚本里创建 k8s service、ingress 或 deployment 文件。
4. 不改变旧 `/web-remote` OAuth 兼容入口。
5. 不迁移或删除旧 `/remote` 镜像与部署。

## 推荐方案

采用并行 v3 发布链路，而不是复用或改写现有 v2 链路。

```text
v2:
  pnpm run build:web-remote-control
  -> packages/web/dist, base=/remote/
  -> Dockerfile.web-remote-control
  -> nginx.web-remote-control.conf
  -> image zcode-remote-mobile-v2:<tag>
  -> zcode/frontend/deployment-remote.yaml
  -> /remote

v3:
  pnpm run build:web-remote-control:v3
  -> packages/web/dist, base=/remote/v3/
  -> Dockerfile.web-remote-control-v3
  -> nginx.web-remote-control-v3.conf
  -> image zcode-remote-mobile-v3:<tag>
  -> zcode/frontend/deployment-remote-v3.yaml
  -> /remote/v3
```

这样可以把发布失败、nginx 路由错误、资源 base 错误和 k8s image 更新错误限制在 v3 链路内，
不会覆盖旧镜像，也不会改动旧 deployment。

## 构建脚本

根目录 `package.json` 保留现有脚本：

```bash
pnpm run build:web-remote-control
```

新增 v3 脚本：

```bash
pnpm run build:web-remote-control:v3
```

脚本内容使用 Vite base：

```bash
pnpm --filter @zcode/web exec vite build --base=/remote/v3/
```

`packages/web/dist` 仍作为唯一静态产物目录。发布脚本顺序执行，所以 v2 和 v3 不需要同时保留两个
dist 目录。Docker 构建前必须先执行对应版本的 build。

## Web 入口判断

`packages/web/src/main.tsx` 当前只用 `window.location.pathname === "/remote"` 判断 QR 远控入口。
v3 页面路径是 `/remote/v3`，如果不改这里，v3 页面会走普通 Web bootstrap。

设计上入口判断应基于当前构建产物的 Vite base 计算：

```text
import.meta.env.BASE_URL = "/remote/"    -> 远控入口路径 "/remote"
import.meta.env.BASE_URL = "/remote/v3/" -> 远控入口路径 "/remote/v3"
```

这样 v2 构建只识别 `/remote`，v3 构建只识别 `/remote/v3`。它避免旧 v2 产物在被重新构建后意外识别
`/remote/v3`，也避免 v3 产物接管旧 `/remote`。

## Nginx v3 配置

新增 `nginx.web-remote-control-v3.conf`，服务根目录仍是 `/usr/share/nginx/html`，但只对 v3 路径提供
SPA fallback 和静态资源别名。

核心路由：

```text
/remote/v3                 -> /index.html, no-cache
/remote/v3/                -> 301 /remote/v3
/remote/v3/assets/*        -> /usr/share/nginx/html/assets/*, immutable
/remote/v3/material-icons/* -> /usr/share/nginx/html/material-icons/*, immutable
/                            -> 302 /remote/v3
```

保留 `/assets/*` 和 `/material-icons/*` 直连兼容不是 v3 的目标。v3 产物的 HTML 应使用
`/remote/v3/assets/...`，生产网关也应只需要转发 `/remote/v3` 前缀。

`/web-remote` 和 `/web-remote/callback` 是旧 OAuth 兼容入口，不属于 QR v3 静态部署的变更范围。
v3 nginx 配置不需要新增 `/web-remote` 路由。

## Docker v3 镜像

新增 `Dockerfile.web-remote-control-v3`：

1. 以 `nginx:alpine` 为基础镜像。
2. 复制 `packages/web/dist` 到 `/usr/share/nginx/html`。
3. 复制 `nginx.web-remote-control-v3.conf` 到 `/etc/nginx/nginx.conf`。
4. 暴露 80 端口。
5. healthcheck 访问 `http://127.0.0.1/remote/v3`。

镜像内不安装 Node，不包含 `node_modules`，不包含 `packages/server`，不包含 relay，不包含 desktop runtime，
不包含远端 agent 资源。

## 发布脚本

保留 `scripts/docker-build-and-push-web-remote-control.sh` 原样服务 v2。

新增 `scripts/docker-build-and-push-web-remote-control-v3.sh`，沿用旧脚本结构，但默认值改为：

```text
DOCKER_IMAGE_NAME=uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-v3
DOCKERFILE=Dockerfile.web-remote-control-v3
K8S_DEPLOYMENT_FILE=zcode/frontend/deployment-remote-v3.yaml
K8S_BRANCH_NAME=deploy/zcode-remote-mobile-v3-<tag>
MR title=chore: update zcode remote v3 image to <tag>
```

脚本执行顺序：

```text
docker login
pnpm run build:web-remote-control:v3
docker build --platform <platform> -f Dockerfile.web-remote-control-v3 -t <image> .
docker push <image>
git -C <cgx-dev-k8s> checkout/update base branch
replace first image field in zcode/frontend/deployment-remote-v3.yaml
commit and push MR branch
```

如果 `deployment-remote-v3.yaml` 不存在，脚本直接失败并提示。原因是 service、ingress、deployment
资源边界属于 k8s 仓库，不应由 z-code 发布脚本临时生成。

## 桌面二维码 URL

`packages/desktop/src/main/index.ts` 中 `mobileRemoteControlUrl` 的默认值改为：

```text
https://zcode.z.ai/remote/v3
```

`ZCODE_WEB_REMOTE_CONTROL_URL` 环境变量继续保留最高优先级，用于本地调试或临时回退：

```bash
ZCODE_WEB_REMOTE_CONTROL_URL=https://zcode.z.ai/remote pnpm dev:desktop
```

这样新桌面版本默认扫码进入 v3，老桌面版本仍然使用自己构建时的旧默认 `/remote`。

## k8s 配套要求

z-code 发布脚本只更新 v3 deployment 的 image。k8s 仓库需要独立准备：

1. `zcode/frontend/deployment-remote-v3.yaml`
2. 指向 v3 deployment 的 service，例如 `remote-mobile-v3`
3. ingress 中 `/remote/v3` 前缀指向 v3 service
4. ingress 中原 `/remote` 前缀继续指向 v2 service

因为 `/remote/v3` 是 `/remote` 的子路径，k8s ingress 必须保证更具体的 `/remote/v3` 匹配不会被
旧 `/remote` 前缀吞掉。该行为应在 k8s 仓库的 ingress 配置中验证。

## 测试

新增 v3 Docker smoke test：

```bash
bash scripts/test-web-remote-control-v3-docker-build.sh
```

验证项：

1. `pnpm run build:web-remote-control:v3` 成功。
2. `packages/web/dist/index.html` 存在。
3. `packages/web/dist/assets` 存在。
4. `packages/web/dist/material-icons` 存在。
5. HTML 首个 script 资源路径以 `/remote/v3/assets/` 开头。
6. 容器内 `/remote/v3` 返回 200。
7. 容器内 `/remote/v3/` 返回 301。
8. `/remote/v3/assets/<built-js>` 返回 200。
9. `/remote/v3/material-icons/typescript.svg` 返回 200。
10. `/` 返回 302 到 `/remote/v3`。

保留旧 smoke test：

```bash
bash scripts/test-web-remote-control-docker-build.sh
```

旧 test 继续证明 `/remote` v2 链路没有被改坏。

## 回归验证

实现完成后执行：

```bash
pnpm typecheck
pnpm lint
bash scripts/test-web-remote-control-docker-build.sh
bash scripts/test-web-remote-control-v3-docker-build.sh
```

若当前机器缺少 Docker 或无法访问 registry，至少执行本地 Vite build 和脚本静态检查，并在提交说明中列出
未补验证项。

## 风险与缓解

1. `packages/web/dist` 是共享输出目录。缓解方式是发布脚本每次 docker build 前先执行对应版本 build。
2. v3 页面被普通 Web bootstrap 接管。缓解方式是按 `import.meta.env.BASE_URL` 计算远控入口路径。
3. k8s ingress 子路径被旧 `/remote` 前缀吞掉。缓解方式是在 k8s 仓库配置更具体的 `/remote/v3` 前缀，
   并在 v3 deployment MR 中验证线上路由。
4. 新桌面版本二维码仍指向旧路径。缓解方式是改桌面默认 `mobileRemoteControlUrl`，同时保留环境变量回退。
5. v3 发布脚本误改旧 deployment。缓解方式是新增脚本并把默认 `K8S_DEPLOYMENT_FILE` 固定为
   `zcode/frontend/deployment-remote-v3.yaml`。

## 待实施文件

z-code 仓库内预计改动：

1. `package.json`
2. `packages/web/src/main.tsx`
3. `packages/desktop/src/main/index.ts`
4. `Dockerfile.web-remote-control-v3`
5. `nginx.web-remote-control-v3.conf`
6. `scripts/docker-build-and-push-web-remote-control-v3.sh`
7. `scripts/test-web-remote-control-v3-docker-build.sh`
8. `docs/web-remote-control/web-remote-control-architecture.md`
9. 相关单元测试中对默认 `/remote` 的断言改为覆盖 v2 helper 和 v3 desktop 默认 URL

