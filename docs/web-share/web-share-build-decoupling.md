# Share 独立构建与 CUA 依赖边界

## 状态

- 状态：已实现
- 范围：Share 静态落地页的构建依赖
- 不改变：Share API、OAuth 协议、Desktop 导入、手机 `/remote`、完整 Web 入口

## 当前问题

历史版本的 `build:web-share` 曾通过 `packages/web/src/main.tsx` 构建完整 Web 应用。
当前已切换为独立的 `@zcode/web-share` 入口；Share 仅复用 `@zcode/share-ui`、协议类型、
认证/Share API 客户端和只读 presentation，不再进入完整 Web 的 CUA 依赖闭包。

```text
历史：@zcode/web -> @zcode/client / @zcode/ui -> @zcode/services -> @zcode/zcode-cua
当前：@zcode/web-share -> @zcode/share-ui / @zcode/shared
      @zcode/web       -> @zcode/client / @zcode/ui -> @zcode/services -> @zcode/zcode-cua
```

## 目标边界

- `@zcode/web-share` 只包含 Share 路由、Preview API、OAuth callback 和只读时间线。
- Share 构建不声明、解析或下载 `@zcode/services` 与 `@zcode/zcode-cua`。
- `@zcode/share-ui` 提供 Share 所需的只读 presentation 入口；Desktop/Remote 继续使用完整
  `@zcode/ui`。
- Share 与完整 Web 共用协议类型和已确认的只读展示实现，不共用运行态 service。
- Remote 构建继续保留 CUA secret 与 CUA Git 依赖。

## 构建链路

```text
Dockerfile.web-share
  -> pnpm install --frozen-lockfile --filter @zcode/web-share...
  -> pnpm --filter @zcode/web-share build
  -> nginx static image
```

Share Dockerfile 不再需要 `zcode_cua_git_user` 和 `zcode_cua_git_token` BuildKit secret。

## 验收

- Share 镜像构建命令不包含 CUA secret。
- Share 构建日志不访问 `git.example.invalid/codegeex/zcode-cua.git`。
- `/cn/share`、`/share`、callback、mock fixture 和资源路径保持可用。
- 完整 Web 和 Remote v4 的构建依赖边界不变。
- Share 页面不创建 Host、Agent、service 或 remote session。
