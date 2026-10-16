# Windows CUA 源码开发运行时设计

> 日期：2026-07-28
>
> 状态：已确认
>
> 范围：Windows 本地桌面源码开发环境
>
> 关联仓库：`z-code`、`C:\Users\dev\zcode-cua`

## 1. 背景

ZCode 当前的 Computer Use 产品链路以 macOS 为主：

```text
ZCode Host
  -> 安装、校验并启动独立 Helper.app
  -> 生成 socket + bearer token
  -> 向官方 zcode-cua plugin 注入凭据
  -> plugin 通过 MCP 向 Agent 暴露工具
  -> Helper.app 通过 AX / ScreenCaptureKit / CGEvent 执行
```

外部 `@zcode/zcode-cua` 仓库已经包含 Windows UIA、named pipe、基础
`SendInput` 点击/键盘以及部分元素语义动作，但当前还没有形成 ZCode 本地桌面的完整运行链路：

- ZCode 默认 Product Helper 只允许 `darwin`；
- Windows standalone 会错误进入 macOS Helper 启动逻辑；
- 当前安装中没有可加载的 `ax_native.node`；
- Windows 截图、剪贴板、应用启动和完整鼠标动作没有闭环；
- UIA 采集仍可能同步阻塞 V8 主线程；
- 坐标输入主要按主屏计算，未完整覆盖虚拟桌面和混合 DPI；
- Windows 测试仍混入 POSIX 路径、Unix socket 和文件 mode 假设。

本设计先解决“源码开发环境真实可运行”，不在同一个里程碑内解决安装包、
预编译二进制、代码签名、自动更新或正式发布。

## 2. 进程与目标校验原则

Windows Computer Use 遵循以下进程、截图和目标校验原则：

- Windows Helper 是独立原生进程，由宿主按需启动；
- Helper 监视 `--parent-pid`；
- pipe 名包含随机 UUID；
- 最后一个客户端关闭后 Helper 和 pipe 一起退出；
- 截图使用 Windows Graphics Capture，可获取被遮挡窗口；
- 输入绑定明确的窗口，并校验窗口、bounds、截图和用户输入状态；
- UIA element index 与当前 observation snapshot 绑定；
- 物理 Escape 可以中断当前 Computer Use turn。

实现不复用任何第三方专有二进制或未公开协议。

## 3. 目标

第一里程碑必须达到：

1. 在 Windows 登录用户的交互桌面中，从源码构建并加载 `ax_native.node`。
2. ZCode 本地 Host 按需启动独立 Windows Computer Use Helper。
3. Host 生成随机 named pipe 和 bearer token，并只向官方 CUA plugin 注入。
4. Helper 就绪后，官方 plugin 才能启动 MCP server；Helper 不可用时 fail closed。
5. Agent 能在记事本等普通桌面应用中完成：
   - 应用和窗口枚举；
   - UIA 树观察；
   - 窗口激活；
   - 元素或窗口坐标点击；
   - 文本输入和快捷键；
   - 已支持的 UIA 语义动作。
6. Helper 崩溃、退出、ZCode 关闭或客户端关闭时，不留下可继续接受请求的孤儿进程。
7. Windows 源码开发失败必须给出可诊断原因，不能把 native 编译或加载失败静默伪装成成功。

完成第一里程碑后，继续在同一架构上补齐：

- Windows Graphics Capture；
- 窗口快照和 stale action 防护；
- 完整鼠标动作；
- 多屏、负坐标和混合 DPI；
- 剪贴板与应用启动；
- UIA 工作线程、取消和超时；
- 中文、emoji、组合键与焦点竞争验证。

## 4. 非目标

本阶段明确不包含：

- SSH、WSL、Docker 或任意 remote workspace CUA；
- 手机 Web 远控或 replayable realtime 链路；
- Windows 安装包、预编译 addon、代码签名、SmartScreen、自动更新；
- macOS Helper 安装、TCC、签名或 notarization 改造；
- Linux AT-SPI 或 Linux broker host 改造；
- Windows 权限设置 UI 或应用级授权 UI；
- 复用、调用或重新分发第三方专有 Computer Use 二进制；
- 改变现有 30 个 MCP 工具名称；
- 新建一套绕过 Broker 的 Host capability router。

## 5. 核心决策

### 5.1 独立 Windows Helper

Windows 使用独立 Helper 子进程，不把 UIA/native backend 运行在：

- ZCode Host 业务进程；
- Agent 主进程；
- 官方 CUA MCP plugin 进程。

原因：

- 原生崩溃不会拖垮 session、terminal、file 等 Host 服务；
- UIA 阻塞不会阻塞 Agent MCP stdio；
- 生命周期和凭据注入可以复用 macOS 控制面；
- 后续从 Node Helper 迁移为 SEA 或原生可执行文件时，上层协议不变。

第一阶段 Helper 形态为：

```text
Node.js child process
  + @zcode/zcode-cua broker/server
  + ax_native.node
```

正式产品阶段可以替换为：

```text
SEA / signed native executable
```

但不得要求 MCP plugin 或 Agent 感知该替换。

### 5.2 Host 只管理生命周期和凭据

ZCode Host 负责：

- 判断本地 Windows 开发态是否启用；
- 解析受控的本地 `zcode-cua` 源码根目录；
- 启动、停止和健康检查 Helper；
- 生成 pipe、token 和 capability generation；
- 仅向官方 CUA plugin authority 注入凭据；
- Helper generation 失效后阻止旧凭据继续进入新 Agent；
- 使用现有 active-turn 和 Agent recycle 边界完成安全恢复。

ZCode Host 不负责：

- UIA 树采集；
- 屏幕或窗口截图；
- 鼠标、键盘注入；
- HWND、element token 或 screenshot revision 管理；
- CUA 工具参数到平台动作的解释。

这些业务能力全部留在 `zcode-cua` Helper/backend。

### 5.3 Windows Graphics Capture

Windows 截图正式实现使用：

```text
Windows.Graphics.Capture
  -> Direct3D11CaptureFramePool.CreateFreeThreaded
  -> ID3D11Texture2D / SoftwareBitmap
  -> BGRA buffer or encoded image
  -> existing zcode-cua image pipeline
```

不把 `BitBlt`、PowerShell `System.Drawing` 或外部截图命令作为正式主路径。

如果 WGC 暂时没有完成，第一里程碑允许 `includeScreenshot=false` 的 UIA 闭环先通过，
但 screenshot capability 必须真实报告为 unavailable，不能返回伪造或空白成功结果。

### 5.4 窗口级输入

Windows action 不再只表达“向当前前台窗口发送全局输入”。每个窗口级动作必须解析为：

```text
WindowIdentity {
  pid
  hwnd
  processPath?
  title?
  bounds
}
```

动作执行前至少校验：

- HWND 仍存在；
- HWND 仍属于相同 pid；
- 目标不是锁屏、不可交互桌面或已拒绝的高完整性进程；
- 窗口 bounds 没有脱离当前 observation 允许的范围；
- 坐标从窗口空间正确映射到虚拟桌面空间；
- 目标窗口可以被安全激活或已经是预期前台窗口。

校验失败必须要求重新观察，不得将输入发送给“恰好处于前台”的其他应用。

### 5.5 Observation snapshot

逐步将现有 `state_id` 强化为 Windows observation revision：

```text
ObservationSnapshot {
  stateId
  revision
  windowIdentity
  accessibilityRevision?
  screenshotId?
  screenshotBounds?
  capturedAt
}
```

规则：

- element index 只在生成它的 accessibility revision 内有效；
- screenshot/state-image 坐标只在生成它的 screenshot revision 内有效；
- 任何可能改变窗口布局、焦点或 modal 状态的 action 后，旧 revision 不再用于下一次 action；
- stale、unknown 或窗口不匹配时 fail closed，并返回“重新观察”诊断；
- post-write transport failure 继续保留 `possibly_sent`，不得因为需要重新观察而自动重放 action。

## 6. 运行架构

```text
ZCode renderer / Agent request
             |
             v
ZCode local Host Process
  WindowsCuaHelperHost
    - local-only admission
    - child lifecycle
    - pipe/token generation
    - health + generation
             |
             | spawn
             v
Windows Computer Use Helper (Node child)
    - CuaPermissionBrokerServer
    - named pipe server
    - ax_native.node
    - UIA worker
    - WGC capture worker
    - SendInput actuator
             ^
             | authenticated broker RPC
             |
official zcode-cua MCP plugin
             ^
             | MCP stdio
             |
ZCode Agent
```

禁止形成以下路径：

```text
UI -> native addon
UI -> Repo
Host service -> concrete UIA implementation
remote Host -> local Windows Helper
ordinary MCP server -> broker credentials
```

## 7. 启动时序

```text
ZCode local Host starts
  |
  |-- platform == win32?
  |-- ZCODE_CUA_PRODUCT_HELPER enabled?
  |-- local host only?
  |-- official CUA plugin enabled for workspace?
  |-- ZCODE_CUA_DEV_ROOT resolves to allowed source root?
  |
  | no -> no Helper, no credentials, no CUA MCP injection
  |
  ` yes
      -> build/runtime preflight
           - dist Helper entry exists
           - ax_native.node exists and loads
           - interactive user desktop available
      -> mint random pipe + token
      -> spawn Helper with parent pid and controlled environment
      -> Helper reads token without exposing it in logs
      -> Helper binds pipe
      -> Host authenticates and calls broker_info
      -> validate pid/platform/capabilities/version
      -> publish credential generation
      -> official plugin host receives canonical broker argv/env
      -> MCP server starts
      -> Agent sees CUA tools
```

Helper 通过健康检查前，不得向 Agent 暴露一个能够启动但无法连接的 CUA server。

## 8. 生命周期状态机

```text
DISABLED
   |
   | enable + local Windows admission
   v
STARTING ---- preflight/spawn/health failure ----> FAILED
   |                                            |
   | health verified                            | explicit retry/restart
   v                                            |
READY ------------------------------------------+
   |
   | app exit / manual restart / credential invalidation
   v
DRAINING
   |
   | stop admission -> settle admitted calls -> close pipe -> child exit
   v
STOPPED
```

约束：

- 同一 Host lifecycle 同时最多一个 Windows Helper generation；
- STARTING/READY 使用 singleflight；
- FAILED 不保留可注入的旧 tuple；
- READY 才能返回 resolver credentials；
- DRAINING 后拒绝新 action；
- action 已写入 broker 后连接断开，仍按 `possibly_sent` 处理；
- ZCode Host 退出时先停止 admission，再结束 Helper；
- Helper 监视 parent pid，父进程消失后自行退出；
- 停止或重启时必须释放本 Helper 按下的所有键和鼠标按钮。

## 9. 开发态源目录

新增显式开发配置：

```text
ZCODE_CUA_DEV_ROOT=C:\Users\dev\zcode-cua
```

语义：

- 只在 `win32` + 本地 Host + Product Helper 显式启用时读取；
- 必须解析为绝对、存在的目录；
- 必须包含预期 `package.json`、Helper 入口和 native build 产物；
- 路径只用于代码/构建产物解析，不作为 workspace identity；
- 不写入用户 workspace 配置；
- 不允许被 remote host 透传；
- 未配置或无效时返回明确开发诊断，不回退到 macOS Helper；
- 正式产品构建不依赖该变量。

建议开发命令：

```text
cd C:\Users\dev\zcode-cua
pnpm install
pnpm build
pnpm rebuild:native

set ZCODE_CUA_PRODUCT_HELPER=1
set ZCODE_CUA_DEV_ROOT=C:\Users\dev\zcode-cua
pnpm dev:desktop
```

实际脚本名称可在实施时调整，但配置边界和 fail-closed 语义不得改变。

## 10. Windows native/backend 设计

### 10.1 UIA 线程

- COM/UIA 运行在独立 MTA 工作线程；
- Node/V8 主线程只做参数校验、排队和 Promise 完成；
- 每个请求携带 deadline 或取消信号；
- 大型 UIA 树必须有节点数、深度、文本长度和时间预算；
- Helper 关闭时等待或取消 worker，不能让 worker 使用已销毁的 N-API handle；
- UIA element token 绑定 snapshot/revision，并有容量上限和淘汰策略。

### 10.2 输入执行

- 使用虚拟桌面坐标：
  - `SM_XVIRTUALSCREEN`
  - `SM_YVIRTUALSCREEN`
  - `SM_CXVIRTUALSCREEN`
  - `SM_CYVIRTUALSCREEN`
  - `MOUSEEVENTF_VIRTUALDESK`
- 坐标统一在物理/逻辑空间边界处显式转换；
- 每次输入前校验目标 HWND/PID；
- 激活失败、UIPI 拒绝或非交互 session 均 fail closed；
- `hold_key`、drag 和 mouse-down/up 必须有终止清理；
- 用户或 stop signal 中断时优先释放输入状态。

### 10.3 Windows system surface

Windows system surface 最终负责：

- 应用启动；
- 剪贴板读取/写入；
- 窗口截图；
- 屏幕/显示器信息；
- 光标信息。

不得让 Windows 默认落入 macOS 的 `screencapture`、`pbcopy`、`open` 命令路径。

## 11. Broker 与安全边界

源码开发阶段仍保留：

- 随机 named pipe；
- 高熵 bearer token；
- token constant-time comparison；
- 官方 plugin authority 限定；
- 普通工具子进程 env sanitation；
- token 日志脱敏；
- Helper generation；
- action delivery state；
- interactive-session 和 UIPI 检查。

源码开发阶段不宣称已经完成：

- current-user-only named pipe DACL；
- Windows 可执行文件签名；
- 安装包身份校验；
- SmartScreen；
- 应用级用户授权。

这些未完成项必须在诊断和文档中明确，不能用“Windows security complete”描述。

Bearer token 不得出现在：

- 日志；
- error message；
- telemetry；
- process title；
- 可复制的 UI 文本。

优先复用现有 one-shot token 或受控继承机制；token 不应作为普通 argv 出现。

## 12. 错误和恢复语义

| 场景                             | 必须行为                                             |
| -------------------------------- | ---------------------------------------------------- |
| Visual Studio C++ toolchain 缺失 | 构建失败并给出明确依赖提示                           |
| `ax_native.node` 缺失            | dev preflight 失败，不静默 `available=false`         |
| addon ABI 不匹配                 | 输出 Node ABI、addon 路径和重建提示                  |
| 非交互 session / 锁屏            | Helper unavailable，不注入输入                       |
| Helper 启动超时                  | 终止本次 child，清理 pipe，不发布 tuple              |
| 健康检查失败                     | 不向官方 plugin 注入凭据                             |
| Helper action 后断线             | `possibly_sent`，不自动重试                          |
| HWND/PID/revision stale          | 返回重新观察诊断，不执行输入                         |
| UIPI 拒绝高权限应用              | 明确 permission denied，不自动提权                   |
| Helper 崩溃                      | generation 失效，按现有 active-turn/recycle 边界恢复 |
| ZCode 关闭                       | 停止 admission、释放输入、关闭 pipe、退出 child      |

## 13. 仓库职责

### `z-code`

- Windows 本地 Helper admission；
- `WindowsCuaHelperHost` 生命周期实现；
- dev root resolver；
- credential injection；
- active-turn/restart/recycle 集成；
- Windows Host 单测与集成测试；
- 开发启动说明。

### `zcode-cua`

- Windows Helper CLI/entry；
- Windows named-pipe broker host；
- `ax_native.node` 构建和严格加载；
- UIA worker；
- WGC screenshot；
- window identity / revision；
- Windows system surface；
- Windows 输入和多屏坐标；
- 跨平台测试修复；
- native 与 live desktop 验收。

### 官方 `zcode-cua-plugin`

- 继续作为 broker-only 薄壳；
- 缺 socket/token 时继续 fail closed；
- 不在 plugin 内启动第二个 Windows broker；
- 只在必要时修正 Windows artifact 名称和测试。

## 14. 分阶段实施

### Phase 0：构建与测试基线

- 补齐 Windows C++ build prerequisites 文档和检查；
- 让 native build failure 在开发命令中显式失败；
- 修正未声明的 lint 依赖；
- 修正 Windows 上的 POSIX path/Unix socket 测试假设；
- native addon 缺失时测试应明确 skip 或 fail，不得 null dereference；
- 保持 macOS/Linux 测试语义不变。

### Phase 1：开发态运行闭环

- 新增 Windows Helper entry；
- Host 按需启动独立 child；
- named pipe + token + health；
- 官方 plugin credential injection；
- UIA list/capture；
- 窗口绑定点击、输入、按键和已支持语义动作；
- Notepad live smoke；
- stop/restart/orphan cleanup。

### Phase 2：视觉与完整指针

- WGC window capture；
- screenshotId/revision；
- `state_image`/window coordinate mapping；
- move、scroll、drag、mouse-down、mouse-up；
- 虚拟桌面、多屏、负坐标、DPI；
- clipboard、launch app。

### Phase 3：可靠性

- UIA MTA worker、deadline、cancel；
- stale token LRU；
- foreground/bounds/user-input guard；
- physical Escape 或等价明确中断；
- CJK、emoji、dead key、键盘布局；
- modal、minimized、occluded window；
- 高完整性应用和锁屏行为；
- named pipe DACL。

### 后续产品闭环

- 预编译 x64/arm64 artifact；
- SEA 或原生 Helper；
- 安装包 staging；
- 签名、版本、hash 和身份校验；
- release CI 与 Windows 实机门禁；
- 用户设置和 readiness UI。

## 15. 验收标准

### 自动化

`zcode-cua`：

- `pnpm typecheck`
- `pnpm lint`
- Windows platform/path/pipe/native targeted tests
- broker delivery-state tests
- Helper lifecycle tests
- Windows screenshot/input contract tests

`z-code`：

- `pnpm typecheck`
- `pnpm lint`
- services Windows Helper host tests
- official plugin credential injection tests
- Agent recycle/generation regression tests

平台专属测试必须显式分类。macOS POSIX mode、Unix socket 或 `.app` 测试可以在 Windows
按明确理由 skip，但平台中立测试不得为了获得绿色结果而整体跳过。

Broker 的 live transport 测试必须使用当前平台真实支持的地址：Windows 使用每例唯一的
`\\.\pipe\zcode-cua-test-<random>` named pipe，macOS/Linux 使用受控临时目录中的
Unix socket。认证、NDJSON、dispatch、超时与 graceful-stop 等平台中立契约必须在
Windows named pipe 上继续执行；只有依赖 socket 文件节点的 `0600/0700`、symlink、
stale-file 与 unlink 断言允许在 Windows 跳过，并由独立 Windows named-pipe 分支测试
守住“不得触碰 POSIX 文件系统节点”的边界。

### Windows 实机

在登录用户 Session 中验证：

1. 启动 ZCode，Helper 按需出现。
2. Agent 能看到官方 CUA 工具。
3. 枚举记事本窗口。
4. 获取 UIA tree。
5. 点击编辑区域并确认目标 HWND。
6. 输入中文、英文和 emoji。
7. 执行 `Ctrl+A`、替换文本和 Enter/Tab。
8. 通过 UIA action 操作按钮或菜单。
9. 重启 Helper 后重新建立 generation。
10. 关闭 ZCode 后没有残留 Helper。
11. Phase 2 完成后验证遮挡窗口截图。
12. Phase 2 完成后验证副屏、负坐标和不同 DPI。

每次实机验收必须记录：

- Windows 版本；
- Node 版本和 ABI；
- addon 构建架构；
- ZCode commit；
- zcode-cua commit；
- 测试应用；
- 是否本地交互 session；
- 失败日志路径；
- 未覆盖场景。

## 16. 兼容性约束

- macOS `desktop-continuous` 主链路保持不变；
- Web remote replayable 链路完全不进入本设计；
- local/remote 判断必须在 Helper admission 前完成；
- 不新增 `workspaceIdentity` 与 `workspacePath` 混用；
- 不修改 Agent 与 App 的 `@zcode/protocol`，除非后续确实出现新的跨进程产品协议；
- broker method/schema 变化在 `@zcode/zcode-cua` 内严格校验并保持旧调用兼容；
- IO 使用异步 API；
- services 日志使用 `createServiceLogger(scope)`；
- UI 未包含在本阶段；若后续修改 `packages/ui`，实施前必须读取 `DESIGN.md`。

## 17. 风险

1. **工具链风险**：当前机器缺少 Visual Studio C++ workload，native 实机验证被阻塞。
2. **ABI 风险**：系统 Node、ZCode bundled Node 和 Electron ABI 可能不同。独立 Node Helper
   必须明确使用哪个 Node runtime，并针对该 ABI 构建。
3. **UIA 阻塞风险**：当前同步 BFS 可能卡住 Helper，需要 worker 化。
4. **截图复杂度**：WGC 涉及 WinRT、D3D11、窗口关闭和设备重建，不应作为小型补丁处理。
5. **焦点竞争风险**：只调用 `SetForegroundWindow` 不能证明输入目标正确。
6. **测试债务**：现有大量测试将 macOS/POSIX 假设写死，Windows 绿色基线需要先分类。
7. **版本漂移**：ZCode compile-time `@zcode/zcode-cua`、Helper runtime alias 和 plugin 版本
   当前不完全一致，开发闭环必须记录实际服务端/客户端版本。

## 18. 已确认项与开放项

第 1 项已通过本次 resolver 契约确认；其余问题留到实施计划中用 spike/测试关闭，
不改变本设计的进程边界：

1. **已确认：Windows dev Helper 使用当前进程的 Node runtime。** resolver 固定返回
   `command = process.execPath`，并在 child 环境中设置
   `ELECTRON_RUN_AS_NODE = "1"`。Desktop Host 已对 zcode-agent 使用相同模式；
   CLI/test host 的 `process.execPath` 自然指向 Node。`ax_native.node` 为 N-API addon，
   必须在目标 Windows 机器针对该 runtime 重建。该 resolver 阶段不注入 broker token。
2. WGC native 层返回 BGRA buffer 还是直接返回 JPEG/PNG。
3. 现有 `state_id` 能否兼容扩展为 revision，还是需要新增字段。
4. one-shot token 文件在 Windows dev 阶段采用何种最小 ACL 实现。
5. physical Escape 放在 Phase 2 还是 Phase 3。

默认原则是选择最小但可继续产品化的实现，并通过 TDD/spike 获取运行时证据后再关闭开放项。
