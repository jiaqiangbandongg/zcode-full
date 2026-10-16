# Web Remote Test 静态资源部署设计

## 背景

当前手机远控页是 `packages/web` 的 Vite SPA。仓库已经有两条静态部署链路：

```text
v2:
  pnpm run build:web-remote-control
  -> base=/remote/
  -> Dockerfile.web-remote-control
  -> nginx.web-remote-control.conf
  -> uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-v2
  -> zcode/frontend/deployment-remote.yaml
  -> /remote

v3:
  pnpm run build:web-remote-control:v3
  -> base=/remote/v3/
  -> Dockerfile.web-remote-control-v3
  -> nginx.web-remote-control-v3.conf
  -> uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-v3
  -> zcode/frontend/deployment-remote-v3.yaml
  -> /remote/v3
```

新需求是在同一套远控 Web 代码上新增测试资源路径 `/remote/__test__`，并让发布脚本最终只更新
`cgx-dev-k8s` 仓库中的 `zcode/frontend/deployment-remote-test.yaml`。

## 目标

1. 新增 `/remote/__test__` 静态资源部署链路。
2. `/remote/__test__` 使用独立构建脚本、Dockerfile、nginx 配置、镜像名和 k8s deployment 文件。
3. 发布脚本最后只修改 `zcode/frontend/deployment-remote-test.yaml`。
4. 保持 `/remote` 和 `/remote/v3` 现有链路不变。
5. 不修改 desktop 默认二维码 URL；测试入口通过 `ZCODE_WEB_REMOTE_CONTROL_URL=https://zcode.z.ai/remote/__test__` 指定。
6. 不修改 relay 协议、shared-host attachment、task stream、snapshot、queue 或 replayable 恢复语义。

## 非目标

1. 不把 `/remote/__test__` 合并到 v2 或 v3 容器中做子路由复用。
2. 不在 z-code 发布脚本里创建 k8s deployment、service 或 ingress。
3. 不修改 `packages/desktop/src/main/index.ts` 的默认 `mobileRemoteControlUrl`。
4. 不改变 `/web-remote` OAuth 兼容入口。
5. 不新增独立 Agent runtime、local host、SSH/WSL/Docker session 或 relay 业务状态。

## 推荐方案

采用第三条并行静态部署链路：

```text
test:
  pnpm run build:web-remote-control:test
  -> packages/web/dist, base=/remote/__test__/
  -> Dockerfile.web-remote-control-test
  -> nginx.web-remote-control-test.conf
  -> image uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-test:<tag>
  -> zcode/frontend/deployment-remote-test.yaml
  -> /remote/__test__
```

该方案复用 v3 的隔离思路，发布 test 资源时不会覆盖 v2/v3 镜像，也不会误改
`deployment-remote.yaml` 或 `deployment-remote-v3.yaml`。

## Web 构建

在根目录 `package.json` 新增脚本：

```json
"build:web-remote-control:test": "pnpm --filter @zcode/web exec vite build --base=/remote/__test__/"
```

`packages/web/dist` 仍是唯一输出目录。发布脚本在 Docker build 前执行 test build，因此不需要新增单独
dist-test 目录。

`packages/shared/src/web-remote-control.ts` 中的 `resolveWebRemoteControlRoutePathFromBaseUrl()` 已经能把任意
Vite base 规范化为 QR 入口路径：

```text
/remote/__test__/ -> /remote/__test__
```

实现时只需要补单元测试，证明 test base 会被识别为远控 QR route。

## Nginx 配置

新增 `nginx.web-remote-control-test.conf`，结构参考 v3 配置，核心路由为：

```text
/remote/__test__                  -> /index.html, no-cache
/remote/__test__/                 -> 301 /remote/__test__
/remote/__test__/assets/*         -> /usr/share/nginx/html/assets/*, immutable
/remote/__test__/material-icons/* -> /usr/share/nginx/html/material-icons/*, immutable
/                                  -> 302 /remote/__test__
```

配置中不需要新增 `/web-remote` 路由。test 构建产物的 HTML 必须引用
`/remote/__test__/assets/...`，生产网关只需要把 `/remote/__test__` 前缀转发到 test service。

## Docker 镜像

新增 `Dockerfile.web-remote-control-test`：

1. 基础镜像使用 `nginx:alpine`。
2. 复制 `packages/web/dist` 到 `/usr/share/nginx/html`。
3. 复制 `nginx.web-remote-control-test.conf` 到 `/etc/nginx/nginx.conf`。
4. 暴露 80 端口。
5. healthcheck 访问 `http://127.0.0.1/remote/__test__`。

镜像内不安装 Node，不包含 `node_modules`、server、relay、desktop runtime 或远端 agent 资源。

## 发布脚本

新增 `scripts/docker-build-and-push-web-remote-control-test.sh`，从 v3 脚本复制并收敛默认值：

```text
DOCKER_IMAGE_NAME=uhub.service.ucloud.cn/tianqi/zcode-remote-mobile-test
DOCKERFILE=Dockerfile.web-remote-control-test
K8S_DEPLOYMENT_FILE=zcode/frontend/deployment-remote-test.yaml
K8S_BRANCH_NAME=deploy/zcode-remote-mobile-test-<tag>
MR title=chore: update zcode remote test image to <tag>
build command=pnpm run build:web-remote-control:test
```

脚本继续使用现有流程：

```text
docker login
pnpm run build:web-remote-control:test
docker build --platform <platform> -f Dockerfile.web-remote-control-test -t <image> .
docker push <image>
git -C <cgx-dev-k8s> checkout/update base branch
replace first image field in zcode/frontend/deployment-remote-test.yaml
commit and push MR branch
```

如果 `deployment-remote-test.yaml` 不存在，脚本直接失败并提示，避免 z-code 仓库越权生成 k8s 资源。

## Desktop 入口

不修改 desktop 默认二维码 URL。当前默认仍由 `packages/desktop/src/main/index.ts` 指向生产远控路径。

测试 `/remote/__test__` 时通过环境变量覆盖：

```bash
ZCODE_WEB_REMOTE_CONTROL_URL=https://zcode.z.ai/remote/__test__ pnpm dev:desktop
```

该方式保留线上默认行为，同时允许 test 部署独立回归。

## k8s 配套要求

z-code 发布脚本只更新 deployment image。k8s 仓库需要提前准备：

1. `zcode/frontend/deployment-remote-test.yaml`
2. 指向 test deployment 的 service
3. ingress 中 `/remote/__test__` 前缀指向 test service
4. ingress 中 `/remote` 和 `/remote/v3` 前缀继续指向原服务

因为 `/remote/__test__` 是 `/remote` 的子路径，ingress 必须保证更具体的 test 前缀不会被旧 `/remote`
前缀吞掉。

## 测试

新增 smoke test：

```bash
bash scripts/test-web-remote-control-test-docker-build.sh
```

验证项：

1. `pnpm run build:web-remote-control:test` 成功。
2. `packages/web/dist/index.html` 存在。
3. `packages/web/dist/assets` 存在。
4. `packages/web/dist/material-icons` 存在。
5. HTML 首个 script 资源路径以 `/remote/__test__/assets/` 开头。
6. 容器内 `/remote/__test__` 返回 200。
7. 容器内 `/remote/__test__/` 返回 301。
8. `/remote/__test__/assets/<built-js>` 返回 200。
9. `/remote/__test__/material-icons/typescript.svg` 返回 200。
10. `/` 返回 302 到 `/remote/__test__`。

实现完成后执行：

```bash
pnpm run typecheck
pnpm run lint
bash scripts/test-web-remote-control-docker-build.sh
bash scripts/test-web-remote-control-v3-docker-build.sh
bash scripts/test-web-remote-control-test-docker-build.sh
```

如果当前机器缺少 Docker，则至少执行 `pnpm run typecheck`、`pnpm run lint`、
`pnpm run build:web-remote-control:test` 和相关单元测试，并在提交说明中列出 Docker smoke test 未验证。

## 风险与缓解

1. `packages/web/dist` 是共享输出目录。缓解方式是发布脚本每次 docker build 前先执行对应版本 build。
2. test 发布脚本误改 v2/v3 deployment。缓解方式是独立脚本默认固定
   `zcode/frontend/deployment-remote-test.yaml`，并在测试中断言脚本文本。
3. test 资源路径被旧 `/remote` ingress 吞掉。缓解方式是在 k8s 仓库配置更具体的
   `/remote/__test__` 前缀。
4. desktop 默认入口误切到 test。缓解方式是不改默认二维码 URL，只通过 `ZCODE_WEB_REMOTE_CONTROL_URL`
   做测试覆盖。
5. Web 入口识别漏掉 test base。缓解方式是为 `resolveWebRemoteControlRoutePathFromBaseUrl()` 增加
   `/remote/__test__/` 单元测试。

## 待实施文件

预计实现改动：

1. `package.json`
2. `packages/shared/test/webRemoteControl.test.ts`
3. `packages/desktop/test/root-build-scripts.test.ts`
4. `Dockerfile.web-remote-control-test`
5. `nginx.web-remote-control-test.conf`
6. `scripts/docker-build-and-push-web-remote-control-test.sh`
7. `scripts/test-web-remote-control-test-docker-build.sh`
8. `docs/web-remote-control/web-remote-control-architecture.md`

