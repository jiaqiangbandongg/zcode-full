# Share 落地页 Jenkins 静态发布

## 目标

Share 落地页单独构建并发布为 nginx 静态镜像，不和手机远控 `/remote` 镜像或
Deployment 共用。Jenkins Job 通过 `ZCODE_ENV=test|production` 选择构建时注入的
ZCode API/OAuth endpoint；页面入口为 `/cn/share`（中文）或 `/share`（英文）。

## 发布链路

```text
Jenkins checkout z-code
  -> pnpm / Dockerfile.web-share
  -> Vite build:web-share (base=/cn/share/)
  -> nginx static image
  -> Docker registry push
  -> kubectl set image share Deployment
  -> rollout status
```

Jenkins 不把 API token 或 Docker 密码放入 Docker ARG、镜像标签、构建上下文或日志。
Share 构建只安装 `@zcode/web-share` 的轻量依赖，并使用仓库锁文件保证渲染依赖可复现；
过滤安装不会把完整 Web/Remote 的 CUA 依赖带入闭包，也不需要 CUA Git token。运行时镜像只有
nginx 和静态产物，material-icons 从 `packages/web/public` 一并复制。

## Jenkins 配置

`Jenkinsfile.web-share` 按现有 remote Job 使用 Kubernetes Pod 模板 `default`，要求
该模板包含 `buildkit` 和 `kubectl` 容器。Pipeline 默认配置面向 staging：

- registry：`openwebui-hk-registry-vpc.cn-hongkong.cr.aliyuncs.com/glm-chat`
- 镜像：`staging-zcode-conversation-share`
- Deployment 与容器：`staging-zcode-conversation-share`
- namespace/context：`zcode` / `openwebui`
- `ZCODE_ENV=test`，构建 endpoint 为 `https://zcode.z.ai`

可通过 Pipeline 参数切换 `production`，并覆盖镜像名、Deployment 名和容器名。Git 仓库
credential 沿用 remote Pipeline 的值；Share 不需要 CUA credential。share 专属的镜像和
Deployment 命名需要由基础设施维护方确认。

Jenkins 需要启用 Pipeline script from SCM，并将脚本路径设为 `Jenkinsfile.web-share`。
Pipeline 会浅克隆 `BRANCH_TO_BUILD`，以 `<clean-branch>-<commit sha 前 8 位>` 生成不可变 tag，
使用 BuildKit 构建并推送 `Dockerfile.web-share`，然后执行：

```text
kubectl set image deployment/<DEPLOYMENT_NAME>
  <CONTAINER_NAME>=<REGISTRY>/<IMAGE_NAME>:<tag> -n zcode --context openwebui
kubectl rollout status deployment/<DEPLOYMENT_NAME> -n zcode --context openwebui --timeout=4m
```

## 验收路径

镜像启动后必须满足：

- `/cn/share`、`/cn/share/callback`、`/share`、`/share/callback` 返回 200；
- `/cn/share/` 重定向到 `/cn/share`，`/share/` 重定向到 `/share`；
- 两个入口都能访问 SPA、mock fixture 和资源；构建产物默认使用 `/cn/share/assets/` 前缀；
- `/remote/v4` 不由 share 镜像提供。

本地构建和 nginx 路由的完整 smoke test 仍可使用 `scripts/test-web-share-build.sh`；它只需要
Docker，不需要 CUA Git 凭据。
