# SSH Remote P0 E2E 规格

## 定义

SSH P0 不是单个 case，而是“用户能连接、开发、对话并在常见生命周期后继续工作”的核心 case 集合。

```text
Ubuntu 24.04 + password SSH
  |
  +-- connect/auth ----> directory ----> remote workspace identity/session
  |                                         |
  |                                         +-- file tree / terminal / Git
  |                                         |
  |                                         +-- task / request / reply
  |                                         |
  |                                         +-- close / restart / disconnect / reconnect
  |
  +-- one BrowserWindow ----> one Window Host ----> one shared SSH connection
                                               +--> workspace A logical session
                                               +--> workspace B logical session
```

每个 case 必须有自己的 setup、action 和 assertion；不能因为长链路经过某个状态，就宣称该状态已覆盖。

## 用户确认与环境边界

2026-08-10 用户确认第一阶段只使用一台现有服务器：Ubuntu 24.04、root、password SSH。凭据由运行环境注入，文档、spec、fixture、artifact 和错误消息不得保存密码。

| 维度               | 第一阶段包含                                                     | 第一阶段剪枝                                                |
| ------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| target             | 单台 Ubuntu 24.04 SSH server                                     | 多服务器、同路径不同 host identity                          |
| auth               | password                                                         | SSH config alias、private key、passphrase、agent forwarding |
| workspace          | 同 target 下多个绝对路径                                         | 其它 SSH target、3 个以上 workspace 的规模组合              |
| client             | Desktop `desktop-continuous`                                     | 手机 `web-remote-replayable`、Bot、跨窗口                   |
| user capability    | connect、directory、file、terminal、Git、task、restart/reconnect | tool/MCP、附件、queue、stop、permission、Goal、compact      |
| internal lifecycle | App 冷启动、SSH Host 断线和手动重连                              | renderer reload；由独立 `R1-RELOAD-01` 覆盖                 |

## P0 Case 集合

### A. 连接与认证

| Case ID        | Setup                                                                                        | Action                                                                                                      | Assertions                                                                                                                                                                             | 状态                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| SSH-P0-CONN-01 | 本地 E2E workspace ready；目标服务器可达                                                     | 从 composer workspace 菜单打开 SSH 向导，使用 password 连接并选择远端目录                                   | 部署/握手/目录 RPC 成功；tab 的 path、`workspaceIdentity`、`remoteSessionId` 正确；只有一个 Window Host；tab/store/log 不保存 secret                                                   | formal                                                                                         |
| SSH-P0-CONN-02 | 目标服务器可达                                                                               | 使用错误 password 连接，看到失败后改用正确 password 重试                                                    | 错误可见且不含 secret；失败不提交 workspace tab，不留下可用 logical session/Agent；重试后连接成功                                                                                      | formal                                                                                         |
| SSH-P0-CONN-03 | 目标服务器可达；本地测试代理对首个 TCP connection 保持 pending、后续 connection 透传真实 SSH | 使用旧 password 发起连接，在 pending 阶段确认停止；随后对同一 host/port/username 使用正确 password 立即重试 | 首连接关闭且无 logical session/远端写入；重试使用新 request/credential 进入目录选择并打开 workspace；Host PID 不变；不影响 WSL/Docker/Server 取消语义                                  | pending (`manual-review/pending/conversation-session-ssh-remote-cancel-retry.test.ts`)         |
| SSH-P0-CONN-04 | 目标服务器可达；设置页配置本地 HTTP 代理；远程资源测试 CDN 只允许经该代理返回                | 选择“本地下载后上传”并连接 SSH workspace                                                                    | proxy 捕获每次部署必发的 fresh manifest 请求；fake CDN 域名无法直连；部署/握手和 workspace 打开成功；Host PID 不变。组件归档的同端口路由由 `remoteDeploy.test.ts` 强制 cache miss 覆盖 | pending (`manual-review/pending/conversation-session-ssh-remote-local-download-proxy.test.ts`) |
| SSH-P0-CONN-05 | 本地含损坏的同步凭据，SSH target 可达 | 连接失败后恢复凭据，保留失效默认模型并重试 | 首次错误和连接日志含安全 source-read-failed；不含凭据；无脏 tab；重试成功且默认偏好未改写 | pending（manual-review/pending/conversation-session-ssh-provisioning-failure.test.ts） |

### B. 远端开发基础能力

测试数据只放在由 case 创建的 `/root/.zcode-e2e/ssh-p0-*` 隔离目录；setup/cleanup 通过测试控制连接完成，不修改隔离目录外的用户文件。

| Case ID       | Setup                                        | Action                                                               | Assertions                                                                                   | 状态   |
| ------------- | -------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------ |
| SSH-P0-DEV-01 | 远端隔离目录含唯一 marker 文件               | 连接该目录，展开 file tree 并打开文件；Terminal 新增文件后刷新文件树 | 列表和预览来自远端；新文件可见；本地同路径不参与；path 执行语义正确                          | formal |
| SSH-P0-DEV-02 | 已连接远端隔离 workspace                     | 打开 Terminal，执行 `pwd`、Ubuntu/system marker 和文件写入命令       | 输出来自远端 Ubuntu；cwd 等于 remote `workspacePath`；写入只落远端；控制连接复核远端文件     | formal |
| SSH-P0-DEV-03 | 远端隔离目录是带 baseline commit 的 Git repo | 修改远端文件并打开 Git pane/status                                   | Git pane 显示远端 repo 的 tracked/untracked 变化；控制连接复核修改 marker；不创建测试 commit | formal |

### C. Task、请求与多 Workspace

| Case ID        | Setup                                                                                                | Action                                                | Assertions                                                                                                                                        | 状态                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| SSH-P0-TASK-01 | case-local provider replay 通过测试专用 SSH reverse tunnel 对远端 Agent 可达；同 target 两个目录存在 | workspace A/B 各自新建 task 并首发；依次切回 A/B 续发 | task row 在正确 workspace；running→idle 无 error；四个请求和回复可见；A2 只带 A 历史、B2 只带 B 历史；identity/session 独立；Window Host PID 不变 | formal                                                                                   |
| SSH-P0-TASK-02 | A/B 已连接且各有已完成 task                                                                          | 关闭 workspace A，再切回 B 继续发送；随后重新打开 A   | A 关闭只释放自己的 attachment/session；B task、请求、回复继续工作；重新打开 A 复用共享 Host 且不覆盖 B                                            | pending (`manual-review/pending/conversation-session-ssh-remote-task-lifecycle.test.ts`) |
| SSH-P0-TASK-03 | A 已连接且有已完成 task；case-local replay 的续发响应延迟 15s                                        | 续发进入 streaming 后打开并关闭设置页；等待任务完成   | 续发期间侧栏 task 行转圈；设置页开关不新建第二条 sessions-index 订阅（同 attachment 同 topic 会被 CLI 静默替换）；任务完成后侧栏 running 消失、与聊天区一致 | pending (`manual-review/pending/conversation-session-ssh-remote-settings-overlay-sidebar-status.test.ts`) |

### D. 持久化、断线与恢复

| Case ID        | Setup                        | Action                                                                       | Assertions                                                                                                                         | 状态                                                                                     |
| -------------- | ---------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| SSH-P0-LIFE-01 | A/B 已连接且各有已完成 task  | 完整重启 Electron/Main/Host；从 disconnected workspace 手动重连并继续原 task | 冷启动不自动连接；持久化条目保留 path/identity 且不含 secret；手动重连后恢复 task/history；续发命中原 task；不创建重复 workspace   | pending (`manual-review/pending/conversation-session-ssh-remote-cold-reconnect.test.ts`) |
| SSH-P0-LIFE-02 | A/B 共享同一 SSH Host 且在线 | 只终止本 case 启动的远端 `zcode-server`，不操作 `sshd`；随后对 A 点击重连    | A/B 同时 disconnected，本地 workspace 不受影响；只建立一次新 SSH Host；A/B 分别获得新 `remoteSessionId` 并恢复；task/file 路由不串 | pending (`manual-review/pending/conversation-session-ssh-remote-server-fault.test.ts`)   |

## 共享不变量

| 不变量                                  | P0 证明                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 每个 BrowserWindow 只有一个 Host        | 所有 case 前后 Process Monitor 只存在同一个 Window Host PID；App 冷启动除外，冷启动后只能有一个新 Host   |
| 同 target workspace 共用 SSH connection | A/B 不重复部署/握手；远端只有一个对应 `zcode-server`；logical session 独立                               |
| identity 与 path 不混用                 | 隔离/key 使用 `workspaceIdentity?.trim() \|\| workspacePath`；file/git/terminal cwd 使用 `workspacePath` |
| 远端执行、本地 app-global               | file/git/terminal/Agent 来自远端；setting/credential/provider 来自本地并显式同步                         |
| desktop continuous 不扩散 replayable    | P0 不建立手机 attachment，不断言 replayable gap/snapshot                                                 |
| secret 不持久化、不进证据               | password 只来自 `ZCODE_E2E_SSH_PASSWORD`；tab、settings、fixture、capture、日志和失败文本均不包含密码    |

2026-08-19 用户确认 SSH cancel/retry 的状态剪枝：只接受“最后一个 SSH pending waiter 取消”作为新增
底层 abort 语义；共享 waiter、online SSH cache 继续使用现有契约用例；WSL、Docker、Server 保持原 transport
生命周期，不与 SSH 做笛卡尔积。SSH-P0-CONN-03 使用首连接阻塞/后续透传的同端口 TCP 代理固定 pending
窗口，避免用 sleep 或错误密码响应速度制造时序。该 case 不发送 prompt，provider request policy 为 none。

## Fixture 与运行约束

- 必需环境变量：`ZCODE_E2E_SSH_HOST`、`ZCODE_E2E_SSH_PORT`、`ZCODE_E2E_SSH_USERNAME`、`ZCODE_E2E_SSH_PASSWORD`。
- 默认 formal 全量发现只有在 `ZCODE_E2E_SSH_HOST`、`ZCODE_E2E_SSH_USERNAME`、
  `ZCODE_E2E_SSH_PASSWORD` 均存在时才纳入真实 SSH spec；端口继续允许默认 22。缺少凭据
  时默认套件应排除这些环境型 case，不能把“环境未配置”统计成产品失败。显式定向运行 SSH
  spec 仍保持 fail-closed，并报告缺少的变量，方便环境维护者验证配置。
- workspace 路径使用 `ZCODE_E2E_SSH_WORKSPACE_PATHS`；conversation 默认 `/root,/home`，开发基础能力使用 case-local `/root/.zcode-e2e/ssh-p0-*`。
- provider case 使用 case-local OpenAI-compatible replay fixture；reverse tunnel 只传递测试 provider 流量，产品 SSH 连接仍通过真实 UI 建立。
- 远端 fixture 必须带本次 run 唯一前缀并在 `finally` 清理。断线 case 只能终止由当前窗口连接启动的 `zcode-server`，禁止修改 `sshd`、系统网络或其它用户进程。
- 所有 spec 先放在 `manual-review/pending`，未经人工审阅不晋升 formal。
- `SSH-P0-CONN-04` 的代理/CDN 必须完全由 case 本地进程提供，不访问真实发布 CDN；测试目标 URL
  在直连路径不可解析，只有代理 mock 能返回 manifest，以机械证明没有 silent direct fallback。

## 运行证据

- `SSH-P0-TASK-01`：2026-08-10 在 Ubuntu 24.04 上按 `/root,/tmp` 完成 formal 默认 replay（1 passing，artifact `desktop-e2e-20260810-074921-918`）与显式 case-local replay（1 passing，artifact `desktop-e2e-20260810-075053-683`）。
- `SSH-P0-CONN-01/02`：2026-08-10 在同一 Ubuntu 24.04 上完成 formal 默认 replay，1 passing，artifact `desktop-e2e-20260810-073137-368`。
- `SSH-P0-DEV-01/02/03`：2026-08-10 在 case-local `/tmp` repo 上完成 formal 默认 replay，1 passing，artifact `desktop-e2e-20260810-073248-576`。
- `SSH-P0-TASK-02`、`SSH-P0-LIFE-01/02/03` 在实际运行通过前保持 `pending`；不得用 unit/integration 证据替代真实 SSH Electron E2E 状态。
- `SSH-P0-TASK-03`（2026-09-04 新增）：来源于 3.11.1 WSL 用户反馈——远程 workspace 运行中打开设置页后侧栏永久转圈；根因与单元证据见 `docs/wsl-task-status-inconsistency.md` T3。fixture 合同检查已通过（`pnpm --filter @zcode/desktop e2e:fixture:check`），真实 SSH 运行通过前保持 `pending`。

## Lifecycle pending 实现

以下 pending spec 已按同一套 Ubuntu password SSH + reverse-tunnel replay harness 编写，尚未声称
formal/covered；必须在真实 SSH 环境完成 capture/replay 与人工审阅后再 promotion：

- `conversation-session-ssh-remote-task-lifecycle.test.ts`：关闭 A、验证 B 续发，再重新打开 A。
- `conversation-session-ssh-remote-cold-reconnect.test.ts`：`browser.reloadSession()` 冷重启后保留断连条目，点击 A 的重连入口并恢复 A/B。
- `conversation-session-ssh-remote-server-fault.test.ts`：只终止本次连接新建且记录的 `zcode-server` PID，验证 A/B 断连和按组重连；不会调用 `sshd`、`wsl --terminate` 或 `wsl --shutdown`。
- `conversation-session-ssh-remote-cancel-retry.test.ts`：首连接保持 pending，确认停止后同 target 立即以正确 password 重试；不发送 provider 请求。

这些 case 的 case-local replay fixture 和 manifest 已建立，fixture check 通过；真实运行前仍需确认
provider stream、SSH server PID 归属、断连事件和重连分组行为。
