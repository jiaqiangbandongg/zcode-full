# Windows CUA 完整指针与虚拟桌面基础设计

> 日期：2026-07-29
>
> 状态：已确认
>
> 范围：Windows 本地 desktop continuous 源码开发链路
>
> 关联仓库：`z-code`、`C:\Users\dev\zcode-cua`

## 1. 背景

Windows CUA Phase 1 已经在源码开发环境中完成以下闭环：

- ZCode local Host 按需启动独立 Windows Helper；
- Helper 使用随机 named pipe 和 bearer token；
- 官方 CUA plugin 通过 Host authority 获得 broker 凭据；
- UIA 可以列举应用和窗口、观察元素树、执行已支持的语义动作；
- `open_application`、元素/坐标点击和键盘输入可以在 Notepad 真机链路工作；
- Helper 停止、重启和 ZCode 退出不会遗留可继续接受请求的旧 pipe。

现有 30 个 MCP 工具中，Windows native addon 尚未导出
`moveTo`、`scrollAt`、`drag`、`mouseDown` 和 `mouseUp`，所以
`mouse_move`、`scroll`、`left_click_drag`、`left_mouse_down` 和
`left_mouse_up` 在 Windows 上仍会 fail closed。现有坐标点击还使用主显示器尺寸计算
`SendInput` 绝对坐标，没有覆盖虚拟桌面、负坐标和副屏。

工具层还存在一个跨平台契约缺口：上述指针工具虽然在工具描述中要求 `app_ref` 或
`state_image` 作用域，但向 broker 发送请求时只保留了坐标，没有把解析得到的
`app_ref` 一并发送。这样 Windows 只能执行无法证明目标窗口身份的全局 `SendInput`，
与既有“前台窗口、PID 和观察状态必须匹配”的设计不一致。

此外，Windows system surface 当前把未实现的剪贴板读取表示为空字符串，把写入表示为
no-op 成功；native `screenCaptureStatus()` 也会在尚无 WGC 实现时报告 `granted`。这些
返回值会让模型把“能力未实现”误认为“真实操作成功”，必须先恢复真实能力语义。

## 2. 本阶段目标

本阶段完成 Windows 指针输入基础，而不改变 MCP 工具数量和名称：

1. 让以下五个已有工具在 Windows 源码 Helper 中真实工作：
   - `mouse_move`
   - `scroll`
   - `left_click_drag`
   - `left_mouse_down`
   - `left_mouse_up`
2. 让现有坐标点击和新增指针动作统一使用 Windows 虚拟桌面坐标。
3. 在全局 `SendInput` 前验证目标应用仍是唯一前台应用；无法证明时 fail closed。
4. 保留 `left_mouse_down` / `left_mouse_up` 的 session holder 约束。
5. 任何部分失败、Helper 停止或父进程消失后，不遗留由 CUA 按下的鼠标按钮。
6. 未实现的截图和剪贴板能力必须明确报告 unavailable/unknown，不得返回空值或 no-op 成功。
7. macOS 和 Linux 继续复用原有实现，不改变它们的 native 派发语义。

## 3. 非目标

本阶段不包含：

- Windows Graphics Capture、D3D11、截图 revision 或 `state_image` 像素闭环；
- UIA MTA worker、UIA 取消、UIA 卡死隔离；
- Windows 原生剪贴板的真正实现；
- 产品安装包、SEA、预编译 addon、签名、SmartScreen、自动更新；
- SSH、WSL、Docker、remote workspace、手机 `/remote` 或 replayable 链路；
- 新增 Windows 专用 MCP 工具名或绕过 broker 的输入通道；
- 修改 macOS Helper、Linux AT-SPI 或现有 30-tool manifest。

## 4. 方案选择

### 方案 A：在工具层增加 Windows 专用工具

例如增加 `windows_scroll`、`windows_drag` 等工具，并由工具层直接调用 Windows
实现。

不采用。它会重新引入平台分叉和工具语义冲突，也会绕过现有 broker 的 delivery-state、
session holder 和生命周期约束。

### 方案 B：只给 addon 补五个导出

保持工具层和 broker 不变，仅实现 `moveTo`、`scrollAt`、`drag`、`mouseDown`、
`mouseUp`。

不采用。当前工具层没有把解析后的 `app_ref` 传给 broker；单独补 native 导出只会让
原来明确 unavailable 的请求变成无法验证目标身份的全局输入。

### 方案 C：端到端补齐现有平台中立 seam

采用该方案：

- 工具层保留坐标和解析后的 `app_ref`；
- broker 对 Windows 全局指针请求执行严格的前台 PID 门禁；
- Node adapter 继续通过 optional native ABI 暴露能力；
- Windows addon 实现既有五个 ABI 和虚拟桌面坐标；
- Helper lifecycle 负责终止时释放 CUA 持有的输入状态；
- 未实现的系统能力改为明确 fail closed。

它不改变 MCP surface，也不要求 Agent 感知 Windows 特例。

## 5. 运行链路

```text
MCP pointer tool
  |
  | resolve target -> screen point + app_ref
  | reject missing/mismatched scope
  v
official zcode-cua plugin
  |
  | broker action RPC
  | { point/start/end, app_ref, session_key, ... }
  v
Windows Computer Use Helper broker
  |
  | resolve live app identity
  | verify exactly one frontmost app and expected pid
  | verify no-focus policy + holder state
  v
NodeAutomationAdapter
  |
  | existing optional native ABI
  v
ax_native.node
  |
  | virtual desktop mapping
  | SendInput move / wheel / drag / down / up
  | guaranteed release on partial failure or terminal shutdown
  v
interactive Windows desktop
```

禁止形成以下链路：

```text
tool -> Windows API
renderer -> native addon
remote Host -> local Windows Helper
missing app scope -> unchecked global SendInput
failed drag -> mouse button remains down
```

## 6. 工具层作用域契约

### 6.1 单点操作

`mouse_move`、`scroll` 和 `left_mouse_down` 解析 target 后必须同时得到：

```text
ResolvedPointerTarget {
  point
  appRef
}
```

显式顶层 `app_ref` 可以覆盖 target 自带的 `app_ref`，但覆盖值仍由 broker 进行 live
解析。请求不得只发送 `point`。

Windows 上如果 accessibility source 可用但无法得到可解析的应用作用域，请求必须在
任何 native input 前失败。不能因为 pid-scoped ABI 不存在而静默退回不受约束的全局输入。

### 6.2 拖拽

`left_click_drag` 必须分别解析起点和终点：

```text
from_target -> { startPoint, startAppRef }
to          -> { endPoint, endAppRef }
```

规则：

- 显式顶层 `app_ref` 存在时，它统一约束两端；
- 否则两端必须能解析到同一个应用身份；
- 两端明确属于不同 PID/identity 时，在 broker 调用前拒绝；
- 无法证明同一应用时，不执行拖拽；
- 不允许用“当前前台应用”猜测缺失的一端。

### 6.3 清理操作

`left_mouse_up` 仍不接受任意目标。它只释放同一 MCP session 已成功或可能成功发送的
`left_mouse_down`。这是安全清理，不重新解析应用身份；即使用户在 down/up 之间切换了
窗口，也必须能够释放 CUA 自己按下的按钮。

## 7. Broker 前台门禁

Windows 没有 macOS `CGEventPostToPid` 的等价能力，`SendInput` 永远作用于当前交互桌面。
因此：

1. broker 从 `app_ref` 解析唯一 live PID；
2. 紧接 native 派发前重新列举 live applications；
3. 只有恰好一个 `active=true` 应用且 PID 等于目标 PID 时才允许动作；
4. 0 个或多个 active 应用、目标已退出、身份歧义或前台 PID 不同都 fail closed；
5. 错误要求重新激活目标并重新观察，不自动激活、不自动重放动作；
6. `mouse_up` 是唯一不执行前台门禁的指针动作，因为它只负责释放已登记的 CUA holder。

门禁复用现有 raw click 的前台验证逻辑，并把错误信息从 click-specific 扩展为通用 method。
macOS/Linux 的 pid-scoped 或既有全局路径保持现状。

```text
SCOPED
  |
  | resolve live identity
  v
FRONTMOST_CHECK
  | expected pid == unique active pid
  |------------------------------ no -> REFUSED (no input sent)
  v yes
NATIVE_DISPATCH
  |------------------------------ transport lost after send -> possibly_sent
  v
DONE
```

## 8. Windows native 输入契约

### 8.1 虚拟桌面坐标

所有绝对鼠标输入统一读取：

- `SM_XVIRTUALSCREEN`
- `SM_YVIRTUALSCREEN`
- `SM_CXVIRTUALSCREEN`
- `SM_CYVIRTUALSCREEN`

转换使用虚拟桌面左上角作为原点：

```text
normalizedX = (x - virtualLeft) * 65535 / (virtualWidth  - 1)
normalizedY = (y - virtualTop)  * 65535 / (virtualHeight - 1)
```

要求：

- 拒绝非有限坐标和不合法虚拟桌面尺寸；
- 输入点可以是负 screen coordinate；
- 超出虚拟桌面的点 fail closed，不做静默 clamp；
- 绝对移动必须同时设置 `MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`；
- 现有 `clickAtPoint` 与新增 move/drag 共用同一个转换函数；
- 不使用主屏 fallback 常量伪造成功。

### 8.2 指针原语

Windows addon 补齐既有 optional ABI：

```text
moveTo(x, y)
scrollAt(x, y, amount, direction)
drag(fromX, fromY, toX, toY, button)
mouseDown(button)
mouseUp(button)
```

行为：

- `moveTo`：一次虚拟桌面绝对移动；
- `scrollAt`：先移动到目标点，再发送垂直或水平 wheel；
- `amount=0`：合法 no-op，不产生 wheel 事件；
- `drag`：移动到起点、按下、有限次数插值移动到终点、释放；
- `mouseDown` / `mouseUp`：仅支持已声明按钮；当前工具面只暴露 left；
- 任一 `SendInput` 部分写入都视为失败；
- drag 在 down 之后的任何失败都必须 best-effort 补发 up；
- modifiers 的 down/up 继续由 broker 的 `withSyntheticModifiers` 管理。

### 8.3 输入状态与停止

Windows addon 维护本 Helper 进程持有的合成输入状态。最低要求是跟踪鼠标按钮；现有
`keyDownGlobal` / `keyUpGlobal` 产生的按键状态也纳入同一终止清理入口。

```text
IDLE
  |
  | mouseDown succeeds
  v
HELD
  | mouseUp succeeds ----------------------> IDLE
  |
  | drag/input failure/helper stop/parent gone
  v
RELEASING
  | best-effort synthetic up for owned inputs
  v
TERMINAL
```

约束：

- terminal shutdown 先关闭新 broker admission，再调用 native 输入清理；
- 清理只释放 Helper 已登记的输入，不把任意用户物理按键当成 CUA 状态；
- terminal latch 之后拒绝新的 hold/down；
- 清理失败要记录脱敏诊断，Helper 不得报告 clean shutdown；
- 该阶段不把 UIA 调用迁移到 worker，避免混合两个独立里程碑。

## 9. 截图与剪贴板能力真实性

在 WGC 和原生剪贴板实现之前：

- Windows `screenCaptureStatus()` 返回 `unknown`，不得返回 `granted`；
- `captureScreenPng` / `captureWindowPng` 继续返回无图，最终工具调用明确失败；
- `get_app_state(include_screenshot=true)` 可以返回 UIA-only state，但必须标明无图；
- `read_clipboard` 明确返回 unavailable 错误，不用空字符串代表真实空剪贴板；
- `write_clipboard` 明确返回 unavailable 错误，不得 no-op 后返回成功；
- 不增加 PowerShell、`System.Drawing`、BitBlt 或外部命令 fallback。

本阶段只修复能力声明，不实现 Windows clipboard 或 WGC。

## 10. 错误与重试语义

| 场景                        | 结果                                                |
| --------------------------- | --------------------------------------------------- |
| 缺少 native pointer ABI     | `not_authorized`                                    |
| target 缺应用作用域         | action 前 fail closed                               |
| drag 两端身份不同/不明      | action 前 fail closed                               |
| 目标不是唯一前台 PID        | `element_unavailable`，要求重新激活和观察           |
| 坐标不在虚拟桌面            | `invalid_request` 或稳定的 permission error；无输入 |
| `SendInput` 返回 0/部分写入 | `permission_denied`                                 |
| down 后 drag 失败           | 补发 up，再返回失败                                 |
| action 写入后 broker 断线   | 保留 `possibly_sent`，不自动重放                    |
| Helper terminal stop        | 冻结 admission，释放已登记输入，关闭 pipe           |
| WGC/clipboard 未实现        | 明确 unavailable，不返回伪成功                      |

## 11. 测试策略

实现遵循 TDD，先写失败测试。

### 11.1 TypeScript 单元测试

- 每个 pointer tool 都把解析后的 `app_ref` 传给 broker；
- 显式顶层 `app_ref` 覆盖 target scope；
- drag 同应用通过、跨应用拒绝、缺失身份拒绝；
- Windows broker 对 move/scroll/drag/down 执行唯一前台 PID 门禁；
- Windows `mouse_up` 只按 session holder 清理且不要求前台 PID；
- native ABI 缺失保持 `not_authorized`；
- clipboard read/write 不再空值/no-op 成功；
- screen capture status 不再误报 granted；
- macOS/Linux 既有 handler 行为与测试保持不变。

### 11.2 Native 源码/绑定测试

- addon 导出五个 pointer ABI；
- virtual desktop 公式使用 `SM_*VIRTUALSCREEN` 和
  `MOUSEEVENTF_VIRTUALDESK`；
- 负坐标、边界、超界、零尺寸使用纯函数测试覆盖；
- scroll 四方向和 amount=0；
- drag 正常释放、部分失败释放；
- terminal cleanup 只释放 tracked inputs；
- 非交互 session 和 terminal latch 继续 fail closed。

### 11.3 Windows 真机测试

使用本地交互桌面，不启动或附着 SSH/WSL/Docker/remote：

1. 从源码构建 `ax_native.node` 和 `dist/windows-helper.js`；
2. 启动 source desktop 和官方 CUA plugin；
3. 在一个明确前台的测试窗口验证 move、纵横 scroll、drag、down/up；
4. 切到另一个前台应用后重放旧 scoped 请求，必须拒绝且不移动/滚动/按下；
5. 在 down 后停止 Helper，确认鼠标没有保持按下；
6. 在具有负坐标副屏时验证绝对位置；若当前机器没有该拓扑，保留自动化公式测试并明确
   真机待补项；
7. 确认无 Helper/plugin-host/pipe 孤儿。

不依赖 provider/model 完成该里程碑；模型驱动验收在 provider 可用后作为额外证据，不能替代
直接 official-plugin 真机验证。

## 12. 强制验证

`zcode-cua`：

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm rebuild:native
pnpm build
```

`z-code`：

```powershell
pnpm typecheck
pnpm lint
pnpm exec vitest run packages/services/test/cua
pnpm test:unit:affected
```

若 `pnpm test:unit:affected` 仍有与 CUA 无关的已知 Windows baseline failure，必须保留完整
exit code、失败集合和与 clean baseline 的对照；不得把 focused green 冒充全量通过。

## 13. 后续里程碑

本阶段完成后继续按以下顺序推进，整体保持同一 Helper/broker 架构：

1. UIA MTA worker、deadline、取消与卡死隔离；
2. Windows Graphics Capture、window/screenshot revision、`state_image` 坐标；
3. 原生剪贴板；
4. 中文、emoji、组合键、混合 DPI 和多屏真机矩阵；
5. 产品闭环：SEA/预编译 addon/签名/安装/更新。

这些后续项未验证前，不得宣称 Windows CUA 已达到完整产品发布状态。
