# WSL Host Pooling 运行态验证证据

## 验证范围

- 日期：2026-07-20（Asia/Shanghai）
- 分支：`fix/wsl-remote-process-cleanup`
- 被测提交：`8a9f553abfcdc53ddb514fce372b118428a2a84b`
- 平台：Windows + WSL2 `Ubuntu`，Linux user `dev`
- App 版本：`3.4.0`
- Electron：`41.0.3`
- remote 资源：内网 CDN `http://intranet.example.invalid:12345/zcode/@electron/release/v3.4.0/`
- 启动变量：`ZCODE_DEV_REMOTE_ASSET_USE_CDN=1`，并用
  `ZCODE_REMOTE_ASSET_CDN_BASE_URL` 指向上述内网根。

本次验证使用当前分支重新构建的 `packages/desktop/out`，renderer 的 Chromium 参数包含
`--app-path="E:\GitProject\z-code\z-code\packages\desktop"`。没有使用已安装的旧版 ZCode。

## 自动化验证

直接调用仓库本地 binary，避免 pnpm wrapper 在离线环境触发 install：

```text
vitest desktop affected: 6 files, 54 tests passed
vitest server affected: 5 files, 46 tests passed
vitest services affected: 1 file, 79 tests passed
vitest shared validation: 1 file, 25 tests passed
tsc -b ...: exit 0
oxlint: 0 errors, 52 existing warnings
```

覆盖了连接建立中释放、Host shutdown phase、窗口级 pool、60 秒 fake timer、running task
阻止释放、mobile attachment owner、Docker dedicated、WSL discovery cache、remote asset installer、
WSL backend 和 stdio lifecycle。

## 运行方式

桌面端从当前分支启动，通过开发态固定端口 `9229` 的 CDP 调用 preload bridge：

```js
window.zcode.connectRemote(
  { kind: "wsl", distro: "Ubuntu" },
  requestId,
  { workspacePath, workspaceIdentity },
);
```

进程采样使用：

```powershell
Get-CimInstance Win32_Process
wsl.exe -d Ubuntu -- bash -lc "ps -eo pid,ppid,rss,lstart,args"
```

## 共享结果

### 一个 workspace

第一个连接成功，logical session 为
`80b8b530-d2ca-447a-9966-9d3472f76dae`：

| 层 | PID | RSS | 启动时间 | 说明 |
| --- | ---: | ---: | --- | --- |
| Windows remote UtilityProcess Host | 24868 | 未单独采集 | 17:26:13 | 第一个 WSL workspace 创建 |
| WSL `zcode-server` | 1083 | 192188 KiB | 17:26:24 | 唯一 server |

### 两个 workspace

第二个 logical session 为 `ba41c70a-8a04-46dc-a193-aeaa9062d8f0`。连接后 Windows remote
Host 仍为 PID `24868`，WSL `zcode-server` 仍为 PID `1083`，server 计数为 `1`。

### 五个并发 workspace

清理前一轮后重新启动 App，并发执行五次同 distro/user、不同 workspace identity 的连接：

```text
elapsedMs=9985
success=5/5
remoteSessionId:
  6de57d48-38ea-4c13-b1cc-2ec5c8d0b180
  9987c0cf-6aa2-4462-9fa0-a66cd96a5616
  e386ab31-8ca7-4db7-ab05-693e42ea9bde
  60557e34-c818-4d4c-943b-a324b4a0d83a
  0e03e8c0-213f-4966-a119-0a4ebfcf6808
```

| 层 | PID | PPID | RSS | 计数 |
| --- | ---: | ---: | ---: | ---: |
| Windows remote UtilityProcess Host | 24708 | 3596 | 未单独采集 | 1 |
| Windows `wsl.exe` launcher | 26684 | 24708 | 未单独采集 | 1 个 launcher 链路 |
| WSL `zcode-server` | 1106 | 1105 | 198232 KiB | 1 |

释放第 4、5 个 logical session、保留三个 workspace 后，Host PID 仍为 `24708`，server PID
仍为 `1106`，server 计数仍为 `1`；当时 RSS 为 `167216 KiB`。

结论：同窗口、同 distro、同 user 的 1、3、5 个 logical workspace 都复用一套 Windows Host 和
一套 WSL `zcode-server`。后续 attach 没有再创建 server。

## 回收时间

### 单 workspace detach

关闭第一个 logical session 后，第二个 session 仍持有 owner：Host PID `24868` 和 server PID
`1083` 均保持，不会误杀共享连接。

### 最后 owner 与 idle TTL

关闭最后一个 logical session：

```text
T+2s: Host PID 24868 present; server PID 1083 present
约 60s 边界后: Host PID 24868 absent; zcode-server-count=0
```

命令采样与 WSL 启动本身存在数秒调度开销，因此运行态只记录“约 60 秒边界”；精确
`60_000ms` 由 `remoteWslHostPool.test.ts` 的 fake timer 断言。

### App 退出覆盖 TTL

重新连接一个 workspace 后：

| 资源 | 退出前 PID | 正常关闭后约 4.0s |
| --- | ---: | --- |
| Windows remote Host | 25468 | 不存在 |
| WSL `zcode-server` | 1122 | 计数 0 |

主窗口调用 `CloseMainWindow()` 后，main process 在 `741ms` 退出；从发起关闭到最终 PID 检查为
`4024ms`。第二轮仍有三个 workspace owner 时重复关闭，main 在 `396ms` 退出，`3641ms`
检查时 Host PID `24708` 和 server PID `1106` 同样已经消失。

结论：真实关闭整个 App 会跳过 60 秒 idle TTL，立即进入有界回收。

## 未覆盖与边界

- 本次没有启动实际 task，因此没有产生 workspace Agent/MCP PID；running-task draining 由单元测试验证。
- 没有实际执行更新安装，只验证了与更新共用的 app/window shutdown manager 路径和 App 退出运行态。
- 没有执行手机 replayable 的真实设备连接；mobile attachment owner 边界由 desktop manager 测试覆盖。
- Docker 没有进入本次 WSL PID 实测；代码与测试确认它仍走 dedicated `InitRemoteWorkspace`，本改动没有
  为 Docker 增加共享 pool。
- 不调用 `wsl --terminate` 或 `wsl --shutdown`；验证结束后 distro 可继续运行，只有 ZCode-owned server
  被回收。
