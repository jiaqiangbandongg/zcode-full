# ZCode Lite Static Distribution

## 背景

ZCode Lite 是不安装 Desktop App 的本地 Web 形态。内网下载源只托管静态发布资源，用户机器负责运行 Node.js、本地 HTTP server、ZCode services 和 agent runtime。

当前内网下载源是普通静态文件服务，不提供 npm registry metadata API：

```text
http://intranet.example.invalid:12345/zcode/deps/
  -> /Users/dev/shared/zcode/deps/
```

因此 ZCode Lite 不依赖 `npx --registry`。发布产物放在 `zcode-lite` 目录下，安装入口优先使用 `install.sh`，tarball 作为可直接下载的备选产物。

## 目标

- 构建脚本能在本地生成一套可上传到静态下载源的 ZCode Lite 发布目录。
- 发布目录包含安装脚本、版本 manifest、压缩包和校验文件。
- 用户机器只要求已有 Node.js，不随 ZCode Lite 打包 Node runtime。
- `zcode-lite serve` 默认随机选择可用端口、绑定 `127.0.0.1`、自动打开浏览器。
- 用户显式传 `--host 0.0.0.0` 时允许局域网访问，并默认启用访问 token。

## 非目标

- 不把 push/upload 写进 build 脚本。上传目标是临时的，build 产物应能被发布到任意静态源。
- 不实现 npm registry。
- 不复用手机 Web 远控 relay，也不改变 `/remote` 的 replayable 恢复语义。
- 不支持一个共享 server 服务多个隔离用户；运行发生在安装者自己的机器或服务器上。

## 架构

```text
内网静态下载源
  /zcode/deps/zcode-lite/
    install.sh
    latest.json
    releases/<version>/
      zcode-lite-<version>.tar.gz
      sha256.txt

用户机器
  ~/.zcode/lite/releases/<version>
  ~/.zcode/lite/current -> releases/<version>
  ~/.local/bin/zcode-lite

运行时
  zcode-lite serve [--host <host>] [--port <port>]
      |
      v
  Node local server
    |-- packages/web/dist 静态资源
    |-- /ws RPC
    |-- createLocalServices()
    |-- bundled zcode.cjs app-server --stdio
      |
      v
  浏览器访问 Web UI
```

ZCode Lite 使用普通 Web 模式同源 `/ws`，不是手机远控：

```text
Lite Web:
browser -> local server -> local services -> local agent runtime

Mobile Remote:
mobile browser -> relay -> desktop main -> existing host/services -> existing runtime
```

## 当前普通 Web 支持边界

这里的“普通 Web”指浏览器直接连接 `@zcode/server` 的同源 `/ws`，包括开发环境的 Web 入口和 `zcode-lite serve` 打开的 ZCode Lite 页面；它不包括手机 `/remote`。

当前普通 Web 没有 Desktop 的窗口级 Local Host 进程，因此也没有 Window Host Controller。依赖 Window Host Controller 聚合本地及远程 source 的左侧全局任务列表，暂时不支持普通 Web / ZCode Lite；Controller 不可用时，不在 Web renderer 中另外实现一套聚合或 fallback 逻辑。

```text
当前普通 Web / ZCode Lite：
browser
  -> @zcode/server /ws
     -> createLocalServices()
        -X-> Window Host Controller
        -X-> 基于 Controller 的左侧全局任务列表

当前 Desktop 与手机 /remote：
Desktop renderer -----------------------+
                                        v
mobile /remote -> relay/main 透传 -> Desktop Window Local Host
                                        |
                                        v
                                Window Host Controller
                                        |
                                        +-> 本地 source
                                        +-> SSH / WSL / Docker / Server source
```

这条边界只限制依赖 Window Host Controller 的全局任务列表和多 source 聚合，不表示普通 Web 的静态页面、文件、终端、会话等现有 `/ws` 能力整体不可用，也不改变 Desktop 本地、Desktop 远程 workspace 或手机 `/remote` 的现有链路。

后续只有在 Lite / Browser Controller Runtime（或经架构确认的等价服务端 Controller 边界）实现，并补齐普通 Web、Desktop 和手机 `/remote` 回归验证后，才重新支持普通 Web 的全局任务列表。目标架构见 `docs/architecture/unified-zcode-lite-server-multi-server-plan.md`。

## 命令行为

默认命令：

```bash
zcode-lite serve
```

默认行为：

- `--host` 默认为 `127.0.0.1`。
- `--port` 省略时随机找一个可用端口。
- 绑定本机地址时默认自动打开浏览器。
- `--host 0.0.0.0` 时默认不自动打开浏览器。
- `--host 0.0.0.0` 时默认生成访问 token，并在 URL 中输出 `?token=...`。

常用服务端启动：

```bash
zcode-lite serve --host 0.0.0.0 --port 3030 --no-open
```

## 安全边界

本地 `127.0.0.1` 启动不强制 token。绑定 `0.0.0.0` 时必须默认生成 token，server 对 `/api/*` 和 `/ws` 做 token 校验。浏览器首次携带 `?token=...` 访问时，server 写入同源 cookie，后续同源 WebSocket 自动带 cookie。

静态资源可以被局域网读取；真正能读写文件、执行命令、访问 agent 的 RPC 入口必须受 token 保护。

## 发布目录

build 脚本只生成本地目录，例如：

```text
dist/zcode-lite/
  install.sh
  latest.json
  releases/<version>/
    zcode-lite-<version>.tar.gz
    sha256.txt
```

上传是临时动作，不落脚本。当前内网上传目标是：

```text
/Users/dev/shared/zcode/deps/zcode-lite/
```

## 验证

完成后至少验证：

- `pnpm --filter @zcode/server test -- serverInfoHttp.test.ts` 覆盖静态资源和 token 保护。
- `pnpm --filter @zcode/web build` 确认 Web bootstrap 能读取 `/api/server-info`。
- `node scripts/build-zcode-lite.mjs --skip-build` 能生成发布目录和 tarball。
- 解压 tarball 后运行 `node bin/zcode-lite.mjs serve --port 0 --no-open` 能启动 server 并输出 URL。
- 提交前执行 `pnpm typecheck` 和 `pnpm lint`。
