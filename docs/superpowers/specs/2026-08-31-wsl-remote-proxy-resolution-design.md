# WSL 远程工作区代理自动解析

## 背景

桌面端的网络代理配置属于 Windows Host；WSL 远程工作区中的 Agent 是另一个 Linux 进程。
在 WSL NAT 网络模式下，Agent 不能把 `localhost:端口` 当成 Windows Host 的代理地址，导致
工作区连接后模型、MCP 或工具网络请求失败。当前 staging 已将远程资源下载接入 Host 代理，
本设计只补齐 WSL 内 Agent 的运行时代理边界。

## 目标

- 复用设置页现有的显式 `httpProxy` / `httpProxyNoProxy` 配置。
- WSL NAT 模式下，自动把 loopback 代理地址转换成 WSL 可达的宿主网关地址。
- WSL mirrored 模式或代理本来就是非 loopback 地址时保持原值。
- 自动转换失败时不扫描局域网、不猜测端口，并保留原始配置作为可诊断的回退。
- SSH、Docker、server remote、桌面 `desktop-continuous` 与手机 `web-remote-replayable` 链路保持原行为。

## 非目标

- 不新增全局代理发现或局域网端口扫描。
- 不把 Windows 的凭据、shell 环境代理或完整代理 URL 日志传到远端。
- 不修改 remote workspace 的 owner、lease、queue、snapshot 或 delivery 语义。
- 本次不处理 Windows 证书路径到 WSL 路径的转换；自定义 CA 仍需后续独立设计。

## 链路与边界

```text
AppSettings.httpProxy (Windows Host)
              |
              v
      WSL remote connect
              |
              +-- Host/CDN fetch: 使用 Windows 原始代理 localhost:port
              |
              +-- WSL Agent env:
                    loopback + NAT -> 解析 WSL host gateway -> gateway:port
                    loopback + mirrored -> 保持 localhost:port
                    非 loopback -> 保持用户配置
```

连接初始化只把代理作为显式的 remote runtime network 选项传给 WSL server command；
不扩展 `pickRemoteRuntimeEnv(process.env)`，避免继承用户 shell 的 `HTTP_PROXY` 越过现有
运行时环境清洗边界。远端 server 再把这份显式网络配置用于下一次 Agent spawn。

## 解析规则

1. 无显式代理：不注入任何代理环境变量。
2. 代理主机不是 `localhost`、`127.0.0.1` 或 `::1`：保持原始代理 URL。
3. 代理主机是 loopback：
   - 先在 WSL 内探测原始 loopback 的 TCP 端口；成功则认为是 mirrored/可直达，保持原值；
   - 原始地址不可达时，优先读取 `ip route show default` 的下一跳作为宿主网关；只有 `ip`
     不可用或没有 default route 时，才回退到 `/etc/resolv.conf`；
   - route 候选拒绝 loopback；resolv.conf 候选还必须是私网或链路本地地址，避免把公网/企业
     DNS 当作宿主网关；找到合法网关后替换 URL 的 hostname，保留 scheme、端口、认证和路径。
4. 网关解析或探测失败：保留原始代理值，并在连接日志中说明自动解析未确认；不阻断 WSL
   server 握手，以免错误的网络诊断阻塞本地工作区打开。

自动解析后的地址只存在于本次远程 server 进程和其 Agent 子进程环境中，不写回设置文件，
因为 WSL 网关地址可能随发行版重启变化。

## 安全与兼容性

- 只探测用户已经配置的 host/port，不进行网络扫描。
- 日志只记录代理解析结果的 scheme、host、port 和 resolution kind，隐藏用户名、密码和路径。
- 仅 `target.kind === "wsl"` 使用该能力；SSH/Docker/server 仍使用原有运行时环境。
- 远程 Agent 仍属于 shared-host attachment；桌面链路保持 `desktop-continuous`，手机链路保持
  `web-remote-replayable`。

## 测试计划

- 纯函数：loopback、IPv4、IPv6、非 loopback、带认证 URL 的替换与脱敏。
- WSL backend：loopback 可达时保持原值；不可达且能解析 gateway 时替换；解析失败时保留原值。
- connect：仅 WSL 注入显式代理环境；不把 `HTTP_PROXY` 从调用进程环境白名单透传到 SSH/Docker。
- 回归：现有 remote asset、remote connect、WSL lifecycle 单测；执行 `pnpm typecheck`、`pnpm lint`。
