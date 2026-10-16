# R2 Server CLI 与 daemon 生命周期测试计划

本文是 `r2-server-cli-and-daemon.md` 的可执行测试补充，覆盖 R2-CLI-01—R2-CLI-14 以及 P0/P1 发布链路。测试把业务状态留在 Server Core，把 Supervisor 限制在生命周期快照和控制面；不会为了统计运行任务在 Supervisor 中复制 Task/Session registry。

## 测试边界

```text
CLI 命令解析 ── JSONL control contract ──> Supervisor
                                       │
                                       ├─ lock / status / crash budget
                                       └─ child IPC ──> Server Core ── HTTP/WS ingress
                                                               │
                                                               └─ Agent CLI turn lifecycle facts
```

- 文件测试使用临时 data root，验证 `install.json` ownership、`current.json`、`pending.json` 和 `status.json` 的临时文件 + rename 原子写入；同进程并发写使用唯一临时文件名。
- IPC 测试同时覆盖 JSONL 粘包、拆包、非法 schema、超长 frame 和请求超时。
- Supervisor 测试使用可控 fake Core process，并补真实 `fork()` spawn error 进程测试，验证 ready、heartbeat、shutdown-ack、异常退出、重启退避、回滚和 crash-loop 熔断；并发生命周期写操作只能有一个 owner，SIGKILL 后无终态进入 `stop-failed` 且不得释放锁或启动替代 Core，旧 child/generation 的消息不得污染当前状态。
- Core HTTP/WS 合同测试验证回环动态端口、`/api/server-info`、Web replayable `/ws`、capability-gated desktop continuous `/ws/host`，并检查 `clientMode` 不串线。
- 平台测试不调用真实系统服务管理器：检查 macOS launchd、Linux systemd user、Windows Task Scheduler descriptor 的稳定字段和命令参数。
- update/uninstall 测试只允许删除带有效 `install.json` ownership 的 server root 内 ZCode allowlist，明确保留 root 内未知文件、workspace、git repo 和其他用户文件；无 ownership 时必须拒绝。

## 用例映射

| 用例 | 自动化覆盖 |
| --- | --- |
| R2-CLI-01 | `cli.test.ts`：无参数和未知命令走 lazy legacy delegate，不导入 Core |
| R2-CLI-02/03/04 | `supervisor.test.ts` fake Core ready/动态端口及真实 spawn error；`runtimeUpdateIntegration.test.ts` 真实 Core parent IPC disconnect 后端口收口；`parentDisconnect.test.ts` handler 注册/撤销；`lock.test.ts` 多子进程竞争 stale lock 只有一个成功；`linux-amd64-dev` SSH 实机完成 daemon ready/重复启动验证 |
| R2-CLI-05 | `cli.test.ts` stop 幂等；`supervisor.test.ts` 并发 stop 收敛、不同生命周期操作返回 `operation-in-progress`、停止未收口进入 `stop-failed`；`ipc.test.ts` control client 有界超时 |
| R2-CLI-06/07 | `crashBudget.test.ts` 退避序列单元；`supervisor.test.ts` fake Core 连续崩溃按 1/2/4/8/16 秒重启并在预算耗尽后熔断，运行任务只在当前 Core 快照中计数，换代后旧 child 消息被拒绝且 ghost running count 归零 |
| R2-CLI-08/09 | `pathsAndRelease.test.ts` pending release 原子切换与并发临时文件隔离；`releaseInstaller.test.ts` 并发安装不覆盖已存在 release 且不遗留 incoming；`componentCache.test.ts` 已存在 release 只校验复用、永不移动活动目录；`cli.test.ts` 覆盖 `prepared` / `prepared-offline` / `up-to-date` / source missing，并验证在线 catalog 确认最新时清除 stale pending；`taskActivityTracker.test.ts` 从 Agent turn facts 统计跨 workspace 活动；`supervisor.test.ts` 两个并发 apply 只产生一个 candidate、running-task guard 拒绝 update/uninstall、`--force` 中断路径经 control socket 端到端验证；spawn error/超时先收口 candidate、回滚 pointer 并恢复旧 Core |
| R2-CLI-10/11 | `cli.test.ts` 双重 `DELETE` 确认取消保护、无 ownership 拒绝卸载、有效 ownership 只删除 allowlist、写 `uninstalled.json` 并报告保留的未知文件；`supervisor.test.ts` 有运行任务时 confirm-uninstall 被拒绝；卸载前解除 launchd/systemd/Task Scheduler 注册 |
| R2-CLI-12 | `coreHttp.test.ts`：server-info、Web replayable `/ws`、capability-gated `/ws/host`、ticket 重放与过期 401、显式稳定 serverId；`serverIdentity.test.ts` ownership marker 到 installationId；`hostCapability.test.ts` TTL/一次性语义；真实 Core wiring/transport RPC frame 仍留作 R3 Transport contract |
| R2-CLI-13 | `cli.test.ts`/真实 daemon 验证 `--server-root` 全链路；`lock.test.ts` 不同 data root 的锁互不干扰；`platform.test.ts` 不同 canonical root 派生不同 service identity 和 descriptor 文件名，并安全识别旧固定 service id |
| R2-CLI-14 | `platform.test.ts` 三平台 descriptor 使用 stable launcher 并携带绝对 server root；`pathsAndRelease.test.ts`/`contracts.test.ts` Node 22 runtime manifest 校验；`packaging.test.ts` staging 布局（bundle 裸依赖扫描、生产依赖闭包、node-pty 交叉打包白名单、@lydell linux prebuild 补齐、spawn-helper 执行位、manifest entrypoints、Windows cmd/zip）；`agentWiring.test.ts` 验证接线计算和显式配置优先，`runtimeUpdateIntegration.test.ts` 用真实 old/new Core 子进程验证 update 后按 release runtime 重算 wiring 与 data root |
| P0-01 | `packaging.test.ts` 六平台 staging、Windows cmd/zip、runtime/tools、runtime/packages、agent 外置依赖闭包 |
| P0-02 | `releaseDownload.test.ts` catalog、SHA-256、超时、临时文件清理和目标校验 |
| P0-03 | `releaseInstaller.test.ts` immutable archive install、stable launcher、pending/current 原子切换、并发复用及 incoming 清理 |
| P1-01 | `componentCache.test.ts` 五组件内容寻址缓存、archive SHA/内容双校验、变化组件覆盖、恶意链接拒绝、最终 release 一致性与 immutable target 复用 |
| P1-02 | `serviceManager.test.ts` root-scoped descriptor identity + launchctl/systemctl/schtasks executor adapter；`cli.test.ts` 验证注册失败不伪装成功、显式 fallback 报告未注册、已有 idle fallback 可迁移到 OS service、service entry 不重复注册；launchd descriptor 验证正常 stop 不因 `KeepAlive` 立即重启 |

需人工补充的仅剩 OS 特有权限：Windows named pipe ACL、真实 launchd/systemd/schtasks 登录会话行为；其余下载、安装、组件复用、回滚和 Linux x64 SSH 流程均已自动化或实机验证。

## SSH 远端部署验证（第 2 层，R3 SSH Transport 预演）

`packages/zcode-server-cli/scripts/verify-remote-ssh.mjs` 把 staged 发行包部署到带 sshd 的
Ubuntu 22.04 容器，从本机经 `ssh -L` 隧道验证完整链路（依赖本机 docker，不进 CI）：

此外，已使用 `linux-amd64-dev`（SSH 用户 `dev`）完成 Linux x64 实机验证：解压约 74 MB
发行包后，`serve --daemon`、status/stop、在线全量更新、带 archive SHA 与内容 hash 校验的
组件增量更新、坏 release 回滚、`node-pty`、`@zcode/tui`/`playwright-core`/`koffi` 动态加载，
以及 bfs/rg/ugrep 和七个随包官方插件均已通过。

```bash
pnpm --filter @zcode/server-cli stage --target linux-arm64
node packages/zcode-server-cli/scripts/verify-remote-ssh.mjs --target linux-arm64   # --keep 保留现场
```

```text
本机                                     容器 (ubuntu 22.04 + sshd)
────                                     ─────────────────────────
stage 产物 tar.gz ──scp──────────────>   解压 /root/zcode-server
ssh "bin/zcode serve --daemon --json" >  Supervisor+Core ready（仅回环+动态端口）
ssh -L <local>:127.0.0.1:<port> ─────>   隧道（Core 只监听回环，隧道是唯一到达路径）
fetch /api/server-info               ✓
WS /ws replayable 升级               ✓
GET /ws/host 无 ticket → 401         ✓
ticket 签发 → /ws/host 升级 → 重放 401 ✓
runtime/node 加载 node-pty spawn pty ✓   （linux pty.node 走 @lydell 补齐路径）
ssh status → stop → stopped          ✓
```

该脚本同时是 R2-CLI-12（跨网络边界的 ingress 合同）与 R2-CLI-14（linux 目标 Node runtime
可启动）的真实环境补充；`ssh -L` 即未来 SSH Transport Adapter 的最小形态，R3 spec 应以
此脚本暴露的事实为设计输入。

## 失败语义

- Core 异常退出只触发 Supervisor 的退避/熔断，不重放已接受输入。
- Core fork spawn error 即使只有 `error + close`、没有 `exit`，也必须走同一崩溃/更新回滚终态，Supervisor 不得退出。
- 同一时刻只能有一个生命周期写操作；冲突请求返回 retryable `operation-in-progress`，不得排队或启动第二个 Core。
- Core IPC 必须绑定 child/generation；Core 终止或换代时清空 Core-scoped 状态，旧 heartbeat/task-activity 不得改变当前 guard。
- Core 启动失败（fatal）后必须显式退出进程，让 Supervisor 观察到 exit 并进入退避，不允许卡在 `starting`。
- `update` 默认在运行任务存在时返回可操作的 guard 错误；只有显式 force 才会停止 Core。
- `uninstall` 在运行任务存在、任何确认失败、路径校验失败或服务移除失败时都保持原状态并返回结构化错误。
- 单实例锁必须可恢复：持锁进程已死（kill -9/断电）时按 ownership token claim stale 文件后重试，活进程持锁才拒绝启动；多个真实进程同时回收时只能一个成功，失败者不得删除成功者的锁。
- 前台 `serve` 启动失败（含 crash-loop）必须先停 Supervisor 收口锁与 control socket，再向用户报错。
- update 进入 ready timeout 时必须先停止仍存活的新 Core，再恢复旧 current pointer 并启动旧 Core；SIGKILL 后仍未观察到 exit/close 则进入 `stop-failed` 并保留锁，禁止双 Core 并存。
- `serve --daemon` 只允许一个 OS service owner；服务 entry 不得重复注册或并行启动第二个 Supervisor，注册失败必须返回错误，显式 fallback 必须报告 `serviceRegistered=false`。
- service descriptor 必须使用 `<serverRoot>/bin/zcode` 稳定入口并显式携带 `--server-root`；service identity 与 descriptor 文件名按 canonical root 隔离，自定义 root 的真实 daemon 测试必须确认默认 root 没有副作用。
- Core-local activity tracker 必须从 Agent turn lifecycle facts 同时统计 desktop continuous 与 Web replayable；测试不得只伪造 Task facade 的 `activePromptInputIds`。
- launchd 正常 stop 不得因无条件 KeepAlive 被自动拉起；异常退出仍保留服务管理器的重启能力。
- 组件增量更新必须删除新 manifest 已移除组件的旧文件。
- archive 安装与组件组装只能 promote 到不存在的 immutable release；目标存在时校验复用且清理 incoming，禁止移动或删除目标。
- 所有高频 heartbeat 和 frame 细节走 debug logger；status 和退出原因只返回不含 secret 的摘要。
- Supervisor 被强杀/IPC disconnect 时 Core 必须清理并退出，不能留下仍监听端口的 orphan Core；在线
  catalog 已确认 current 最新时必须清理 stale pending，避免后续离线分支降级。
