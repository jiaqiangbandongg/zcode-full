# Windows CUA 源码开发运行手册

本手册只覆盖 Windows 登录用户桌面上的本地开发链路。它不适用于 SSH、WSL、Docker、远程 workspace 或手机 `/remote`；这些路径不能启动或附着 Windows Computer Use Helper。

## 准备 source Helper

先在 `zcode-cua` source 根目录构建 JavaScript Helper 和本机 N-API addon：

```powershell
$zcodeCuaRoot = 'D:\path\to\zcode-cua'
Set-Location $zcodeCuaRoot
pnpm install
pnpm rebuild:native
pnpm build
pnpm test
```

构建完成后，`package.json.zcodeCuaRuntime.windows` 声明的两个文件必须存在。当前契约示例为：

```text
<zcode-cua>\dist\windows-helper.js
<zcode-cua>\build\Release\ax_native.node
```

每次修改 `zcode-cua` source 后都要再次执行 `pnpm rebuild:native`（改动 native addon 时）和 `pnpm build`。不需要重新打包 ZCode 产品。

若 Windows Smart App Control 处于强制模式，新编译且未由 Trusted Root Program CA
签名的 `ax_native.node` 会被 Code Integrity 拒绝加载；成功编译不等于当前机器可执行。
此时 live smoke 会在创建 Helper/fixture 前以 2 退出，并报告 native addon blocked 或
unavailable。不要为源码验收自动关闭系统安全策略；使用具备受信开发签名的构建，或在
允许本地未签名原生模块的专用开发机上复验。产品签名与安装包闭环不属于本手册阶段。

## 启动桌面开发环境

官方 `zcode-cua` plugin 必须已启用。随后在 ZCode source 根目录运行：

```powershell
$zcodeRoot = 'D:\path\to\z-code'
Set-Location $zcodeRoot
$env:ZCODE_CUA_DEV_MODE='1'
$env:ZCODE_CUA_DEV_ROOT=$zcodeCuaRoot
pnpm dev:desktop:prod
```

`ZCODE_CUA_DEV_MODE=1` 是现有的 one-knob bundle：它同时启用内部开发 feature。不要把它替换或拆分为新的环境变量。`ZCODE_CUA_DEV_ROOT` 只用于解析 source 构建产物，且只允许 desktop-local Windows Host 使用。

`ZCODE_CUA_DEV_ROOT` 必须直接指向物理 source root：根目录不能是 symlink/junction，
`package.json`、契约 entry 和 nativeAddon 也必须是非链接普通文件，且 `realpath` 必须位于
该 root 内。准入失败时不会回退安装包资源；请修正目录布局，不要用链接绕过隔离。

若不设置 `ZCODE_CUA_DEV_ROOT`，`pnpm dev:desktop:prod` 会缺省绑定本仓库已安装的 producer
（`<repo>\node_modules\@zcode\zcode-cua`，即 `pnpm-workspace.yaml` catalog pin 的那一版，与
产品 staging 同源），对应 `scripts/dev-desktop-cua-env.mjs`。这只是缺省值：本手册要验证自己
的 producer 改动时，按上面显式设置该变量即可，显式取值永远优先。dev 下 Electron 的
`process.resourcesPath` 指向 `node_modules/electron/dist/resources`，其中没有
`tools/cua-helper`，因此不设任何值时产品分支必然以 `invalid-runtime-manifest` 失败。

预期进程和通信链路如下：

```text
ZCode desktop Host Process
  └─ Node/Electron child: package.json 声明的 entry
       ├─ package.json 声明的 nativeAddon
       └─ \\.\pipe\zcode-cua-<random>

official zcode-cua plugin ── authenticated broker RPC ──┘
```

broker token 鉴权已被 node_repl 重构整体删除：连接门改为 native peer-identity（code-signature /
`parentProcessPid`），Helper 环境不再注入任何 broker token。`ZCODE_CUA_PERMISSION_BROKER_TOKEN`
现在只作为**必须被剥离的敌意输入**存在（见 `windowsCuaDevRuntime.test.ts` 的 `must-not-be-forwarded`
与 cli 侧 `zcode-cua-plugin-host-authority` 测试），不再是凭据来源；源码中已无任何注入方。不要把它
与 browser-use 的 `ZCODE_NODE_REPL_BROWSER_BROKER_TOKEN` 混为一谈，后者属于 node_repl browser
broker，是另一条链路。正式凭据只剩 socket + `pluginAuthority` 二元组，由 Host 通过
`buildCuaProductHelperAgentEnv()` 交给官方 plugin，不接受用户编写的 plugin 配置覆盖。
`pluginAuthority` 是当前唯一的敏感凭据，不得出现在 child argv、进程标题、日志、错误文本、
telemetry 或可复制 UI 文本中。

## 验证 source Helper

先确认 source Helper 已按上节构建，再执行 opt-in 真机测试：

```powershell
Set-Location $zcodeRoot
$env:ZCODE_CUA_DEV_MODE='1'
$env:ZCODE_CUA_DEV_ROOT=$zcodeCuaRoot
pnpm exec vitest run packages/services/test/windowsCuaDevHelper.integration.test.ts
```

`ZCODE_CUA_DEV_MODE=1` 在这里和启动桌面开发环境时同样必需：它是启用内部开发 runtime/feature
的 one-knob bundle（见上文），不能只设 `ZCODE_CUA_DEV_ROOT`。

broker 的连接门是 native peer-identity（`getPeerCredentials` / code-signature /
`parentProcessPid`），Windows 侧的 peer 校验尚未落地。**自 producer `37a0c9ef` 起该门在
Windows 上被临时放开**（producer 侧常量 `WINDOWS_PEER_IDENTITY_GATE_TEMPORARILY_OPEN`，
否则打包版结构上拿不到 dev 豁免——`app.isPackaged` 注入的 `ZCODE_RUNTIME_ENV=production`
让所有 localDev 判据恒为 false，Helper 必然启动失败）。因此现在 broker 不再因缺 opt-in 而
报 `refusing to start an unauthenticated broker`，而是带一行 stderr 告警
（`peer identity verification temporarily disabled`）以无鉴权状态启动：Windows 上任何本机
进程都能连这条 named pipe。M5 的原生 peer 原语落地后该常量回收，门自动重新闭合，上述拒绝
启动的行为也随之恢复。

该测试仅在四项都满足时运行：Windows、已设置 `ZCODE_CUA_DEV_ROOT`、生产者契约有效、
契约声明的 entry/nativeAddon 存在。它验证真实 child、随机 named pipe、health/`broker_info`、
只读应用列举、官方 plugin 环境二元组、`pluginAuthority` 不泄露，以及 `stop()` 后 child 退出。对外 MCP
tool 名为 `list_apps`；source broker 的实际只读 RPC 名为 `list_applications`，测试按该既有
映射调用，不新增 alias 或改变 plugin tool surface。

注意该文件不在 `pnpm typecheck` 覆盖范围内（`packages/services/tsconfig.json` 的 `include`
只有 `src`），且默认在 CI 里 skip。因此它引用的服务层符号被重构删除时，既不会有类型错误也不会
有测试失败，只会在 Windows 本地真机首次运行时炸成 `ReferenceError`。改动 CUA 凭据契约后必须
本地实跑一次这个文件，不能依赖 CI 绿灯。

## 验证 packaged resources

产品资源验收与 source override 是两条独立路径。构建产品时必须移除
`ZCODE_CUA_DEV_ROOT`，并为 `--dir` 命令显式传入仓库配置文件：

```powershell
Set-Location $zcodeRoot
Remove-Item Env:ZCODE_CUA_DEV_ROOT -ErrorAction SilentlyContinue
$env:ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR=$zcodeCuaRoot
$env:ZCODE_SKIP_REMOTE_ASSETS='1'
$env:ZCODE_TARGET_OS='win32'
$env:ZCODE_TARGET_ARCH='x64'
pnpm --filter @zcode/desktop build
pnpm --filter @zcode/desktop exec electron-builder `
  --config electron-builder.config.js --win --x64 --dir
Remove-Item Env:ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR
```

`ZCODE_CUA_HELPER_RUNTIME_PACKAGE_DIR` 只选择构建期 producer，不会开启安装包的 source
runtime override；运行期仍只认 `ZCODE_CUA_DEV_ROOT`。本地 producer commit 尚未 push 时必须使用
前者完成 staging，同时保持 workspace/lockfile 指向可远端获取的上游 commit。

Windows 原生文件在 electron-builder 复制 `extraResources` 时完成签名，因此 staging
manifest 的哈希只描述复制前字节。Windows `afterPack` 会先核对实际构建 context 的
win32/arch，再基于最终已签名字节刷新 hash 并严格复验。目标环境变量与 `--win/--x64`
（或 `--arm64`）不一致时构建会直接失败。

`electron-builder.config.js` 不是 electron-builder 自动发现的默认文件名。省略
`--config` 会绕过 `extraMetadata.version`、Windows CUA `extraResources` 和 afterPack
配置，因此不是有效产品构建命令。

真实生命周期验收使用两个显式变量，避免测试意外读取开发目录或当前进程：

```powershell
$env:ZCODE_CUA_PRODUCT_RESOURCES_PATH = `
  (Join-Path $zcodeRoot 'packages\desktop\dist\win-unpacked\resources')
$env:ZCODE_CUA_PRODUCT_EXECUTABLE = '<可运行的 Electron 41.0.3 x64 executable>'
pnpm exec vitest run packages/services/test/windowsCuaProductHelper.integration.test.ts
Remove-Item Env:ZCODE_CUA_PRODUCT_RESOURCES_PATH
Remove-Item Env:ZCODE_CUA_PRODUCT_EXECUTABLE
```

测试先用 resources path、当前架构和 Electron `41.0.3` 解析产品 manifest，只覆盖解析结果的
`command` 为显式 executable；root、entry、addon 与依赖闭包仍固定来自 packaged
resources。它验证 ready/health/`broker_info` PID 一致，随后 `stop()` 并在有界 deadline
内确认新 pipe 连接失败、exact owned PID 消失、token 不在 argv 或捕获日志。两个变量缺失
时真实 lifecycle 用例必须显示为 skipped；invalid packaged root 用例始终运行并断言稳定
`WindowsCuaDevRuntimeResolutionError`。

启用 Windows Application Control 的本机可能拒绝尚未完成发布签名的 branded exe；不要
关闭系统策略。此时可以用 exact、hash 已验证且 ABI 相同的 Electron 41.0.3 executable
完成 packaged-resources/ABI 验收，但必须在报告中明确它不等于最终 branded/signed exe
验收。最终结论仍需 CI/签名机完整完成 `rcedit`、原生文件/EXE 签名、afterPack 和 branded
exe lifecycle。2026-07-29 的具体路径、版本、hash、live smoke 与本地构建限制记录在
`docs/cua/windows-product-runtime.md`。

Windows 指针实机冒烟必须在已解锁的交互桌面上显式 opt in：

```powershell
Set-Location $zcodeCuaRoot
pnpm rebuild:native
pnpm build
$env:ZCODE_CUA_WINDOWS_POINTER_LIVE='1'
pnpm smoke:windows:pointer
Remove-Item Env:ZCODE_CUA_WINDOWS_POINTER_LIVE
```

冒烟只接受一个 `active=true` 的 live 前台应用，使用其精确
`{pid,bundle_id,name}` 作为 `app_ref`。它把光标向所在 display 中心移动最多 24 个坐标
单位，通过同一作用域路径发送 `amount:0` 的滚轮探针，然后在 `finally` 中还原原始位置
并验证两像素容差；最后用五秒 `hold_key` 验证 Helper shutdown 能在 1.5 秒内唤醒等待、
释放按键并干净退出。脚本默认关闭，不设置 opt-in 时不会启动 Helper 或移动光标。

Windows 原生文本剪贴板冒烟同样必须在已解锁的交互桌面上显式 opt in：

```powershell
Set-Location $zcodeCuaRoot
pnpm rebuild:native
pnpm build
$env:ZCODE_CUA_WINDOWS_CLIPBOARD_LIVE='1'
pnpm smoke:windows:clipboard
Remove-Item Env:ZCODE_CUA_WINDOWS_CLIPBOARD_LIVE
```

该脚本启动自己唯一可识别的 Helper，确认 `clipboard=true` 后读取原始文本、写入随机 marker、
精确读回，并在 `finally` 中恢复和复核原始文本。stdout 只输出布尔摘要，不输出原文、marker、
token 或 pipe。脚本默认关闭，不设置 opt-in 时会在启动 Helper 前退出。运行前必须注意：
`CF_UNICODETEXT` smoke 只能保存和恢复文本，若系统剪贴板还含图片、文件列表或应用私有格式，
这些非文本格式不能由该脚本恢复；应先由操作者确认可以覆盖。

Windows WGC 视觉冒烟也必须在已解锁的普通交互桌面上显式 opt in：

```powershell
Set-Location $zcodeCuaRoot
pnpm rebuild:native
pnpm build
$env:ZCODE_CUA_WINDOWS_SCREEN_CAPTURE_LIVE='1'
pnpm smoke:windows:screen-capture
Remove-Item Env:ZCODE_CUA_WINDOWS_SCREEN_CAPTURE_LIVE
```

它只创建两个受控 WPF 窗口：绿色/洋红 checkerboard target 与不透明蓝色 occluder。
脚本自动验证 `screen=true`、`screenshot=true`、选中 display 的 PNG/bounds、目标窗口在
完全遮挡前后的像素等价、`capture_app(include_screenshot=true)`、官方 MCP
`get_app_state` 返回的 `state_id` 和 `state_image` 安全按钮点击、最小化固定失败，以及
Helper/fixture 干净退出。stdout 只打印布尔值、尺寸、固定结果码和退出事实，不打印图片、
窗口标题、临时路径、token 或 pipe。未 opt in、锁屏、非 default input desktop 或 native
签名策略阻断时，脚本会在启动任何 Helper/fixture 前退出 2。

Windows canonical 30-tool 总验收在同一受控桌面上运行：

```powershell
Set-Location $zcodeCuaRoot
pnpm rebuild:native
pnpm build
$env:ZCODE_CUA_WINDOWS_TOOL_SURFACE_LIVE='1'
pnpm smoke:windows:tool-surface
Remove-Item Env:ZCODE_CUA_WINDOWS_TOOL_SURFACE_LIVE
```

该脚本通过官方 `buildServer` + MCP client 直接调用 28 个非剪贴板工具，验证
`open_application({app:{pid}})` 只解析/激活已有 WPF fixture 而不二次启动、UIA/WGC
观察、display、`state_image`、全部 pointer/keyboard、元素 action/focus、wait 与 stop。
`read_clipboard` / `write_clipboard` 继续由会精确恢复原文本的 clipboard companion smoke
负责；两者并集必须与 canonical 30-tool manifest 完全一致。脚本保存并复原光标、释放
held input、等待 Helper/fixture 干净退出；默认关闭或预检失败时不创建子进程。

再验证官方 plugin 的 fail-closed 边界：

```powershell
pnpm --filter @zcode/zcode-cua-plugin test
```

该命令会直接执行 `tests/zcode-cua-plugin-host-authority.node-test.ts`。该文件只包含 Host authority 凭据边界测试；脚本不再依赖 Node 的 `--test-name-pattern`，因此文件缺失、无法加载或断言失败都会使验证命令失败，不能产生零匹配的假绿。

应核对三项：没有 broker 凭据时可用 CUA 工具为零或返回明确 unavailable；Host 注入的有效凭据保留官方 server 配置；用户手写 plugin 配置中的 token 永远不会被接受。

该命令会先运行 plugin launcher 自身的测试，再构建 CLI 依赖并运行官方 `__zcode-plugin-host` 的权威凭据测试。后者验证 Host 注入的 canonical product/broker/socket 配置被保留，并拒绝用户 authored env 或 argv 对 broker 凭据的覆盖；它不接受用户 token 作为凭据来源。

Windows 上运行通用 broker 单测时，live server/client 用例必须连接每例唯一的
`\\.\pipe\zcode-cua-test-<random>`，不能把临时目录下的 `b.sock` 交给 Node
`net.listen()`。认证、协议、dispatch、超时与关闭时序仍应在真实 named pipe 上执行；
`0600/0700`、symlink、stale Unix socket 与 unlink 等依赖 POSIX 文件节点的断言只在
macOS/Linux 执行。对应边界如下：

```text
win32 ──> \\.\pipe\zcode-cua-test-<random> ──> live transport / protocol tests
posix ──> <private tmpdir>/broker.sock       ──> live transport + fs security tests
```

## 日志、安全与限制

开发时优先从 ZCode 服务日志与 `~/.zcode/cli/log`、`~/.zcode/cli/debug`、`~/.zcode/cli/rollout` 追踪 session/Helper 生命周期；Helper stderr 只用于本地诊断。复制或提交日志前必须检查并删除 broker token、随机 pipe 路径及其他连接凭据。

Windows 锁屏、Session 0 或非交互用户桌面必须 fail closed：Helper 不能注入输入，也不能把不可交互状态伪装成可用。Windows pointer 操作要求目标 `app_ref` 的 PID 在派发瞬间仍是唯一前台应用；负坐标副屏使用 virtual desktop 映射；`left_mouse_up` 仅作为已按下鼠标键的清理操作，可在焦点变化后释放。Windows 原生文本剪贴板使用 `CF_UNICODETEXT` 与 N-API async worker，只有交互桌面预检和读写双导出同时成立才报告 `clipboard=true`；它不使用 PowerShell、外部命令或 Electron fallback。Windows 截图使用 WGC 与 N-API async worker：显示器按选中 bounds 捕获，窗口按 HWND/PID/完整 executable/bounds 在前后两次复核；最小化、锁屏、目标变化和更高完整性级别均固定失败关闭。当前 PNG 是 8-bit BGRA SDR，保留系统默认 capture border，不承诺 HDR/色彩管理保真。UIA worker 的进一步隔离尚未完成，不能用空白像素或其他 fallback 冒充成功。

### Windows launcher 与 GUI 进程身份

`open_application` 启动前必须异步采集一次 UIA application PID/identity snapshot。launcher PID 若能由 UIA 可靠解析，应始终优先使用；只有 Windows 才允许把无窗口 launcher 换绑到 GUI child，并且 child 必须同时满足：不在启动前 snapshot、具有非空 canonical executable identity、与启动器解析出的 identity 精确相等、当前仍由 UIA 暴露且候选唯一。旧进程、仅 name/basename 相同、不同路径同名或多个新候选都必须 fail closed，禁止通过 `active` 或枚举第一项猜测。

Win11 的 `notepad.exe` 是 App Execution Alias；不能假定命令文本或 basename 就是进程身份。当前实现会在 `spawn` 返回 PID 后立即通过 native `processExecutablePath(pid)` 查询该进程的完整 executable path；实机返回 WindowsApps 内真实 `...\Notepad\Notepad.exe`。跨 PID rebind 只能使用这条完整路径，不能回退到 alias 文本、name 或 basename。UIA 注册在实机上可比 spawn 晚约 2 秒，因此 resolver 使用有界 `30×100ms` 等待；延长预算不能放宽 snapshot、完整路径、live 再验证或唯一性条件。非 Windows 平台保持原有 bundle/name 解析语义，不进入 launcher→GUI child rebind。

Windows direct preferred/launcher PID 也不是单独可信的稳定身份。resolver 在接受 `applicationInfo(preferredPid)` 前，必须把其 live `bundle_id` 规范化为完整 executable path，并与 launch 后立即读取的 canonical full executable path 精确比较；两者不一致时不得返回该 PID，应继续寻找满足上段全部约束的唯一新 GUI candidate，最终没有安全候选则 fail closed。canonical lookup 缺失、抛错或返回非绝对路径时，即使 UIA 已能直接看到 preferred PID，也不得把它当成本次 launch 成功证据。该规则防止 PID 复用以及“读取 launcher identity 后、UIA 接受前进程身份变化”的 TOCTOU；非 Windows direct PID 继续保持原有行为。

Windows `axSource` / UIA 缺失时，backend 必须在 spawn 前拒绝 `open_application`，resolver 还必须防御性返回 `null`，绝不能返回 `launchHint`；非 Windows 保留既有 no-`axSource` fallback。

Windows packaged app 不能沿用上述 executable-path rebind。像 Calculator 这样的应用由
`ApplicationFrameHost.exe` 承载，host executable 既不是 AUMID，也不能证明具体应用
身份。packaged app 必须由 `bundle_id` 传入精确 AUMID，通过原生
`IApplicationActivationManager` 激活，再从可见顶层 HWND 的
`PKEY_AppUserModel_ID` 精确解析唯一 PID；0 个或多个 PID 候选都 fail closed。后续
`get_app_state` 和动作优先使用 `open_application` 返回的 PID。普通 Win32 app 继续传
显式 executable name（例如 `notepad.exe`），完整路径校验规则不变；禁止用本地化标题、
basename、active 状态或枚举第一项猜测。

官方 CUA provider-visible 工具名仍只有 `mcp__computer-use__*`。Agent 仅对已经通过
Host authority 校验的官方 server 接受模型偶发生成的 `mcp__computer_use__*` 单向
运行时别名，并在 permission、hook、event、history 和 MCP dispatch 之前恢复规范名称。
第三方 MCP server 不获得该别名，也禁止全局归一化连字符和下划线。

## 实机验收记录（2026-07-29）

本轮在 Windows 11 10.0.26200 x64、交互式 Session 1、Node 24.18.0（ABI 137）和 pnpm 10.33.2 上，从 source desktop 启动并验证了官方 `computer-use@zcode-plugins-official` 链路。验收限定为本地 desktop continuous 链路；未启动或附着 SSH、WSL、Docker、远程 workspace、手机 `/remote`，Phase 1 全程未请求截图。

实机首先暴露出两个 Windows 启动身份缺陷：默认 runner 的 `windowsHide: true` 使现代 Notepad 进程成功但首个 GUI 窗口以隐藏状态启动；现代 Notepad 又会把 `spawn` 返回的 launcher PID 转交给另一个持有可见窗口的 child PID。最终修复让 runner 显式显示 GUI，并以“启动前 PID snapshot + launcher 完整 executable path + 启动后新增 PID + `applicationInfo` live 再验证 + 唯一候选”完成 Windows-only rebind。旧 active 同名窗口、不同路径同 basename、多候选和 name-only identity 都由 RED tests 锁定为 fail closed。

官方插件 live smoke 的保留结果如下：

- Managed Host 注入 socket/token/authority 后，`__zcode-plugin-host` 成功初始化 `zcode-cua` MCP，列出 30 个工具；
- `list_apps`、无 shell 的 `open_application(notepad.exe)`、无截图的 UIA `get_app_state` 成功；
- 编辑器以 element target 点击，`type` 写入 `ZCode Windows CUA Phase 1` 后由刷新 UIA state 精确验证；
- `Ctrl+A` 成功后只做只读重观察，未重放该动作；replacement `type` 写入 `ZCode Windows CUA Phase 1 Replacement`，再由刷新 UIA state 精确验证；
- 日志扫描未发现 token 或完整 pipe；Helper lifecycle 事件为低频 `info`/`warn`，未走 macOS Helper.app/TCC、SSH、WSL 或 Docker 路径。

同一真实 `WindowsCuaHelperHost` 的恢复 smoke 也已通过：generation 1 child 经 exact PID/parent/executable/entry 校验后被结束，旧 pipe 拒绝连接；同一 Host 随后产生 generation 2，pipe 与 token 均轮换，`pluginAuthority` 保持完全相同；最终 `stop()` 后 child 退出。source ZCode 关闭后，main、Host、Helper 和 official plugin-host 均无孤儿，关闭前 pipe 在关闭后拒绝连接。

provider-driven task 仍未完成：等待退避窗口后的首次 bounded retry 仍被限流；此后继续退避约 45 分钟，又从当前 source desktop 启动一个新 task `sess_049c964a-c225-4e7f-8147-dcdd53a24c4f`，只发送一次完整 Notepad 指令。对应 model I/O 包含 official `mcp__computer-use__*` tool surface，但 `tool_use=0`、`tool_result=0`；模型“已工作 1 秒”后仍在首个 tool call 前返回 `The service is currently rate limited. Please retry later.`。没有第二次发送，Notepad 未启动，也没有 capture/replay 可替代。源码应用随后通过正常 app-quit 链路等待 Host cleanup 并退出，没有本轮 Helper、plugin-host、watcher 或 Notepad 孤儿。因此不得把 direct official-plugin smoke 冒充为模型任务成功，状态保持 `BLOCKED/NEEDS_CONTEXT`。

完成 Windows CUA 单测可移植性治理并再次退避后，于 source desktop 新建 task `sess_70f5f0a4-f1de-4bda-9840-e9693cb6e3da`，仍只发送一次完整 Notepad 指令。该 task 的唯一 `main_turn` model I/O 在 941ms 后限流；请求已注入 48 个工具，其中 30 个是 official `mcp__computer-use__*` 工具，但响应仍为 `tool_use=0`、`tool_result=0`。UI 显示“已工作 2 秒”后返回同一 rate-limit 文本。session title 生成器另有 6 次内部、无工具的限流重试；它们不是用户指令重发，也没有进入 CUA。Notepad 未启动，任何写动作都未 dispatch。退出时先通过非持久化 main-process setting 关闭本次进程的 close-to-tray，再走正式 `before-quit -> Host dispose -> agent/plugin/Helper cleanup`；最终 source Electron、Windows Helper、source CUA plugin-host、app-server、watcher、5174/9229 端口和 Notepad 均无遗留，用户持久化的 close-to-tray 仍为 `true`。本轮仍不能完成 provider-driven Notepad 验收，状态继续保持 `BLOCKED/NEEDS_CONTEXT`，且不得自动再次发送。

此前 Task 8 门禁中，zcode-cua 的 typecheck、lint、build 和全量 test 均为 exit 0；当时全量为 107 passed / 6 skipped files、1952 passed / 67 skipped / 18 todo tests。两轮复审补强后的 C1 focused 为 2 files / 24 tests，C2 delivery-state focused 为 4 files / 116 tests，均 exit 0。`pnpm test:unit:affected` 在当时 HEAD 与隔离 clean worktree 的 exact `bb8798db1c` 上使用同一 Windows / Node / pnpm / lockfile 环境运行：base 为 29 failed files / 100 failed tests / 1 unhandled，HEAD 本次为 31 / 102 / 1。集合差分显示 29/100 的 baseline failure 全部仍在 HEAD；HEAD-only 是 `animatedSidePanePanelLayout` 的 30 秒 timeout 和 `workspaceShellRemoteMobileLayout` 的 15 秒 timeout，两者都不在 Task 8 代码路径，且独立 review 先前在同一 HEAD 得到 29/100，属于 full-suite 负载相关的非稳定 timeout。该对照没有发现 C1/C2 回归，但不能把 brief 的 exit-0 gate 自行改成通过；仍需 gate owner 明确 waiver 或独立治理 Windows 全量基线。

随后继续治理 Windows 单测基线：通用 broker/auth/Node Helper live tests 改用每例唯一 named pipe，macOS `.app`、LaunchServices、codesign、`/usr/bin/unzip` 和 POSIX mode/symlink 断言按平台精确分类。独立审查后又把 broker round-trip/lifecycle、installer 注入状态机、Helper PID evidence、owner/reaper 纯决策逻辑恢复为 Windows 必跑；`pnpm exec vitest run packages/services/test/cua` 现为 38 files passed、788 tests passed、35 platform skips、2 todo，exit 0。所有认证、NDJSON、dispatch、超时、graceful-stop 和 Node Helper 生命周期仍在 Windows 真实 named pipe 上运行。再次执行 `pnpm test:unit:affected` 后从 31 files / 102 tests / 1 unhandled 降为 17 files / 17 tests / 0 unhandled，936 files / 8017 tests passed；剩余失败均不在 CUA 文件，门禁仍保持 exit 1，不宣称全仓通过。

本轮又完成 Windows 原生文本剪贴板链路：TypeScript adapter 只在交互桌面预检通过且
native addon 同时具备异步读写导出时报告能力，broker 会等待 Promise 完成；原生层使用
`CF_UNICODETEXT`、独立的 250ms 互斥预算、`8×10ms` 的 `OpenClipboard` 有界重试和
8 Mi UTF-16 code units 上限。没有引入 PowerShell、外部命令、Electron fallback，也没有
修改 SSH、WSL、Docker、远程 workspace 或手机 `/remote`。

2026-07-29 的首次 clipboard live smoke 不能记为通过：Helper 正常 ready，
`broker_info.capabilities.clipboard=true`，但读取原始文本前 `OpenClipboard(NULL)` 已返回
access denied；同一环境的前台应用为 `LockApp`。脚本没有写入 marker，未改变剪贴板，并
干净退出自己的 Helper。20 次只读诊断均返回 `unavailable`，Win32 只读诊断也确认是
`OpenClipboard` 访问拒绝；因此没有放宽交互桌面门控或增加 fallback。随后在解锁的普通
交互桌面复验，pointer live smoke 全部通过并复原光标，clipboard live smoke 写入/读回
随机 Unicode marker 后精确恢复原文本，Helper 均以 0 退出。运行前的只读格式检查为
`formatCount=2`、`textOnly=true`；这次证据只证明文本剪贴板闭环，不外推到图片或文件格式。

剪贴板实现完成后的最新门禁中，zcode-cua 的原生重建、typecheck、lint、build 和全量
test 均为 exit 0；剪贴板相关 focused 为 8 files / 139 tests，全量为 115 passed /
6 skipped files、2016 passed / 67 skipped / 18 todo tests。ZCode source Helper 真子进程
集成为 1 file / 2 tests，CUA 服务回归为 38 files / 788 passed / 35 skipped / 2 todo，
官方插件构建及凭据边界为 6 tests，主仓 typecheck/lint 均为 exit 0。最新
`pnpm test:unit:affected` 仍为 exit 1：13 files / 17 tests failed，940 files /
8135 tests passed，且 17 条失败都不在 CUA 测试文件；失败分布在 UI 超时/源码文本断言、
bot 锁、Git/CI 和桌面环境等既有区域。因此 CUA focused 门禁通过，但仍不宣称全仓单测通过。

同日继续完成 WGC visual loop：native addon 增加显示器/窗口异步捕获 ABI，broker
`screenshot` 保留选中副屏原点，`capture_app` 将验证后的窗口 PNG/bounds 绑定到 UIA
snapshot，`state_image` 按该 bounds 投影。受控 WPF fixture 已真实创建 HWND、写入
PID/HWND/bounds 握手、响应私有关闭信号并以 0 退出；视觉 smoke 的默认门禁与模拟锁屏
门禁均证明在子进程创建前退出。早期加载曾出现 Smart App Control / Code Integrity
3077/3033，但清理并重新构建 native addon 后 source binary 在同一机器成功加载，
`isScreenCaptureSupported=true`。完整 WGC live smoke 随后通过：选中 display PNG/bounds、
完全遮挡窗口的前后像素等价、`capture_app`、官方 MCP `get_app_state` →
`state_image` event click、最小化固定失败，以及 Helper/两个 fixture 全部 clean exit。
这证明当前源码开发闭环可运行；Trusted Root Program CA 签名、安装包和产品发布仍是后续
闭环，不能从 source pass 推导为正式分发已解决。

同一轮 canonical tool-surface live smoke 也已全绿：官方 server 注册的 30 个工具与
manifest 完全一致，28 个非剪贴板工具均发生真实 MCP 调用，clipboard 两项由上述 companion
smoke 覆盖。过程中实机发现并修复两项设计缺陷：PID 分支曾把窗口标题误送启动器造成二次
launch；Windows `*_to_app` 键盘 handler 曾在验证前台 PID 前就因缺少 macOS per-pid 原语
返回 unavailable。现在 PID 只解析/按双确认激活已有进程；Windows 键盘只有在 UIA 证明
`app_ref.pid` 是唯一前台应用后才转全局 `SendInput`。最终 observation/display/pointer/
keyboard/semantic/focus/runtime 分组均为 true，光标复原，Helper/WPF fixture 均以 0 退出。
这次变更仍未进入 SSH、WSL、Docker、远程 workspace、手机 `/remote`、安装包或发布闭环。

最终收口时，WGC smoke 在修复后连续三次全绿。其间发现验收 fixture 自身有两个
Windows PowerShell 5.1 兼容问题：Dispatcher delegate 在 StrictMode 下不能依赖局部
HWND/window/timer 闭包；UTF-8 无 BOM + LF 的中文注释又可能被 5.1 按 ANSI 代码页误读，
吞掉换行并把下一条语句并入注释。fixture 现在显式使用 script-scope live HWND/window/
timer；两个 WPF fixture 均保留 UTF-8 BOM 回归断言。最小化信号只有在
`IsIconic(HWND)` 为真后才确认，
不能再用“信号已消费”代替 Win32 状态事实。

最新源码门禁为：zcode-cua Windows focused 16 files / 158 tests，全量 122 passed /
6 skipped files、2105 passed / 67 skipped / 18 todo tests，native rebuild、build、
typecheck、lint 均 exit 0；screen、pointer、clipboard、30-tool surface 四套实机 smoke
全部 exit 0，剪贴板文本和光标均恢复，无 Helper/fixture 孤儿。ZCode focused integration
为 4 files / 175 passed / 1 skipped，`pnpm --filter @zcode/zcode-cua-plugin test`
共 6 tests，主仓 typecheck/lint 均 exit 0。裸跑 plugin 的 `node --test` 不是有效门禁，
因为它缺少 package `build` 前置；必须使用上述 package test 命令。

最新 `pnpm test:unit:affected` 仍为 exit 1：13 failed files / 20 failed tests，
940 passed files / 8132 passed tests / 104 skipped / 2 todo。失败分布在既有 agent 时序、
UI 超时、bot lock、Git/CI 和 desktop 文本断言，没有 CUA 源码或 CUA 测试文件。因此
Windows 本地 source CUA 功能与 30-tool 运行证据已收口，但不能把该结论外推到正式签名、
安装包、HDR/色彩管理、provider 是否实际选择调用工具，或全仓非 CUA 基线。

## 干净关闭

关闭桌面应用或停止开发进程后，Host 会先停止接收新工作，再发送 Helper shutdown、关闭 named pipe 并等待 child 退出。可在任务管理器确认没有遗留的 `windows-helper.js` Node/Electron child；若仍存在，保留脱敏日志并停止继续使用该 broker，直到原因得到修复。
