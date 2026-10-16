# Windows CUA WGC 视觉捕获设计

## 背景

Windows source Helper 已具备 UI Automation 元素树、指针输入和原生文本剪贴板，但视觉链路仍是占位实现：

- `ax_native.node` 的 `captureWindowImage` 固定返回 `null`；
- Windows `SystemSurface` 声明 `supportsScreenCapture=false`；
- `screenshot` 无法捕获所选显示器；
- `get_app_state(include_screenshot=true)` 只能返回 UIA 状态，不能附带窗口图像；
- `space:"state_image"` 和 `space:"screenshot"` 已有坐标语义，却没有 Windows 图像来源。

macOS 已经形成“窗口身份校验 + 窗口图像 + 状态缓存”的完整闭环。Windows 采用相同的产品边界，但底层像素来源使用 Windows Graphics Capture（WGC），以支持被其他普通窗口遮挡的目标窗口。

本设计只覆盖本地 Windows source Helper。macOS、Linux、SSH、WSL、Docker、remote workspace、手机 `/remote` 与产品打包链路保持不变。

## 目标

本阶段一次完成 Windows 本地视觉闭环：

1. `screenshot` 捕获用户所选显示器，保留负坐标显示器原点；
2. 捕获指定 HWND，即使窗口被其他普通窗口完全遮挡仍返回目标窗口内容；
3. `get_app_state(include_screenshot=true)` 将同一次已验证观察的窗口图像附加到状态；
4. 复用现有 `state_id`、`space:"state_image"` 和最新 screenshot visual-frame 语义，不新增截图修订协议；
5. 截图前后验证显示器或窗口身份、进程、可执行路径与边界，拒绝把陈旧 UIA 树和新图像拼成同一状态；
6. native 捕获和 PNG 编码在后台 worker 执行，不阻塞 N-API/V8 主线程；
7. capability 只在完整、可调用的 WGC 链路存在时为真；
8. 保持现有 30 个 MCP 工具名称、参数与 tier/annotation 不变。

## 非目标

本阶段明确不包含：

- Electron/macOS/Linux 的视觉链路重构；
- SSH、WSL、Docker、remote workspace 或手机 `/remote`；
- 产品安装包、签名、商店 identity、应用 manifest、预编译 x64/arm64 产物；
- 申请或绕过“无黄色捕获边框”的受限 capability；source 开发接受系统默认 WGC 边框；
- 用 BitBlt、PrintWindow、PowerShell、外部命令、Electron `desktopCapturer` 或私有二进制作为 fallback；
- 新建 Rust/napi-rs sidecar 或额外常驻进程；
- 改造现有 UIA 同步读取为独立 worker；
- 引入独立的 `screenshotId` 截图句柄，或修改 MCP tool schema；
- 视频、流式捕获、画中画、多帧 diff；
- 最小化窗口的“成功截图”承诺；最小化目标必须诚实失败；
- HDR 完整色彩管理。第一阶段输出 SDR BGRA8 PNG，HDR tone mapping 作为后续产品质量项。

## 已确认方案

采用现有 Windows C++ addon `ax_native.node`，增加 C++/WinRT + D3D11 + WIC 实现，并通过 N-API 异步 Promise 暴露给 TypeScript。

未采用的方案：

1. **Rust/napi-rs sidecar**：会新增进程、工具链、发布物和协议边界，不适合当前 source Helper 的快速闭环。
2. **Electron `desktopCapturer`**：把独立 Node Helper 反向耦合到 desktop renderer/main，破坏当前 Helper 可独立启动的边界。
3. **BitBlt/PrintWindow/PowerShell**：不能可靠满足遮挡窗口语义，且会引入不同的权限、颜色、DPI 与生命周期行为。

技术选型依据：

- [`IGraphicsCaptureItemInterop`](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nn-windows-graphics-capture-interop-igraphicscaptureiteminterop) 提供 `CreateForWindow` 和 `CreateForMonitor`，允许从 HWND/HMONITOR 创建 capture item；
- [`Direct3D11CaptureFramePool.CreateFreeThreaded`](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded) 使用内部 worker thread 触发 frame event，不要求调用线程拥有 `DispatcherQueue`；
- [Windows screen capture 文档](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture) 要求先检查 `GraphicsCaptureSession.IsSupported`，并说明 WGC 的 frame-pool/session 生命周期；
- [Windows app capability 文档](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations) 说明受限 capability 属于产品 manifest/发布边界，因此本阶段不把“无系统边框”混入 source runtime 验收。

## 架构与事件顺序

```text
screenshot / get_app_state(include_screenshot=true)
  |
  v
TypeScript capability + target identity gate
  |
  v
native Promise
  |
  v
Napi::AsyncWorker（后台 MTA）
  |
  +--> IGraphicsCaptureItemInterop
  |      +--> CreateForMonitor(HMONITOR)
  |      `--> CreateForWindow(HWND)
  |
  v
Direct3D11CaptureFramePool::CreateFreeThreaded
  |
  v
等待第一张有效帧 / target closed / deadline
  |
  v
只复制 ContentSize 到 D3D11 staging texture
  |
  v
WIC 内存 PNG 编码
  |
  v
再次校验 monitor/HWND/PID/exe/bounds
  |
  +--> screenshot：写入最新 visual-frame
  |
  `--> get_app_state：图像与 UIA 状态一起进入 state cache
                         |
                         `--> state_id + space:"state_image"
```

所有状态关联仍由现有 broker 负责：

```text
显示器 screenshot N
  `--> visual-frame N（原点 = 该显示器物理 bounds）
       `--> space:"screenshot" 只允许引用当前 visual-frame

窗口 capture_app N
  `--> UIA tree N + PNG N + capture bounds N
       `--> state_id N
            `--> space:"state_image" 只允许引用 state_id N 的图像
```

后一次 screenshot/zoom 会替换 session 当前 visual-frame；后一次 `get_app_state` 会生成新 `state_id`。因此现有协议已经具备截图版本边界，无需再引入 `screenshotId`。

## Native ABI

在 Windows addon 上增加 additive、可选导出：

```ts
type NativeScreenCaptureSuccess = {
  ok: true;
  format: "png";
  data: Uint8Array;
  width: number;
  height: number;
  bounds: [number, number, number, number];
};

type NativeScreenCaptureFailure = {
  ok: false;
  error:
    | "unsupported"
    | "unavailable"
    | "busy"
    | "timeout"
    | "invalid_target"
    | "target_changed"
    | "too_large"
    | "device_lost"
    | "capture_failed"
    | "encode_failed";
};

type NativeScreenCaptureOutcome = NativeScreenCaptureSuccess | NativeScreenCaptureFailure;

interface AxWinNativeAddon {
  isScreenCaptureSupported?(): boolean;

  captureMonitorPngAsync?(
    bounds: [number, number, number, number],
  ): Promise<NativeScreenCaptureOutcome>;

  captureWindowPngVerifiedAsync?(
    windowId: number,
    pid: number,
    expectedCanonicalBundleId: string,
    expectedBounds?: [number, number, number, number],
  ): Promise<NativeScreenCaptureOutcome>;
}
```

`data` 在实现中可由 Node `Buffer` 承载，但 ABI 按 `Uint8Array` 校验，避免上层依赖 Buffer 专有方法。失败 outcome 不暴露 HRESULT、系统错误文本、窗口标题、可执行路径、图像内容、pipe 或 token。

三个导出必须成组存在。旧 addon、半组导出、异常返回值或 rejected Promise 全部 fail closed，不允许回退到同步占位函数。

## 显示器定位

broker 已选择显示器并持有其物理 bounds。native 不信任暴露给 JS 的 `HMONITOR` 数值长期有效，而是：

1. 接收 `[x, y, width, height]`；
2. 枚举当前显示器，寻找 bounds 精确匹配的 `HMONITOR`；
3. 创建 WGC item 前重新读取一次 bounds；
4. PNG 完成后再次确认显示器仍存在且 bounds 未变化；
5. 任何不匹配都返回 `target_changed`。

成功 outcome 的 `bounds` 是最终验证过的显示器物理 bounds。负 `x/y` 保留，不做归零；visual-frame 用该 bounds 作为全局到图像坐标的原点。

## 窗口身份与边界

窗口捕获接收 HWND、期望 PID、规范化可执行路径以及 UIA 观察时的可选 bounds。捕获前后执行相同校验：

1. `IsWindow(hwnd)` 为真；
2. `GetWindowThreadProcessId` 等于期望 PID；
3. 查询到的 canonical executable path 与期望 bundle id 相同；
4. 目标不是 Helper 自身、锁屏 shell 或已知受保护系统桌面；
5. 目标进程不高于 Helper 完整性级别；
6. `IsIconic(hwnd)` 为假，窗口宽高大于零；
7. `GetWindowRect` 为有效物理坐标；
8. 若调用方传入 UIA 观察 bounds，则捕获开始前必须相等；
9. 捕获结束后的 HWND、PID、exe 和 bounds 必须仍与开始时一致。

若窗口、进程或边界在观察期间变化，返回 `target_changed`。对于 `get_app_state`，此错误使整个观察失败并要求重新观察，不能把旧 UIA tree 和另一时刻的图像组合起来。

WGC 的帧像素尺寸与 `GetWindowRect` 可能受系统边框或平台实现细节影响。成功 outcome 的 `bounds` 表示捕获前后已复核的桌面物理坐标范围，`width/height` 表示 PNG 像素尺寸；上层以这两组数据建立 `state_image` 坐标映射，不盲目信任先前 UIA outer bounds，也不在二者不一致时假设 1:1。

## 像素管线

每个 capture worker 完成一张图后立即销毁捕获会话：

1. 创建支持 BGRA 的 D3D11 device；
2. 首选 hardware adapter，失败后允许 WARP device；WARP 仍是 WGC 路径，不是 BitBlt fallback；
3. 将 DXGI device 包装为 WinRT `IDirect3DDevice`；
4. 用 `Direct3D11CaptureFramePool::CreateFreeThreaded` 创建 2-buffer frame pool，避免依赖 DispatcherQueue；
5. 创建 capture session 并开始；
6. 等待第一张尺寸有效的帧，同时监听 item closed 与 deadline；
7. 只复制 frame `ContentSize` 范围，拒绝复用纹理中的历史边缘像素；
8. 复制到 CPU-readable staging texture，按 `RowPitch` 读取；
9. 使用 WIC 在内存中编码 BGRA8 PNG；
10. 关闭 session/frame pool 并释放 staging、D3D、WinRT 与事件对象。

输出是非交错标准 PNG。第一阶段使用 SDR BGRA8；HDR 显示器的颜色精度是已知限制，但不得因此伪报 capture success 后返回空白图。

## 线程、并发与资源上限

WGC 与编码不能运行在 JS 主线程：

- 每个调用使用 `Napi::AsyncWorker`；
- worker 初始化 MTA，并在 worker 内捕获全部 C++/WinRT 异常；
- `NAPI_DISABLE_CPP_EXCEPTIONS` 继续约束 node-addon-api；WinRT 异常不得越过 worker/native ABI；
- 使用独立 `std::timed_mutex g_screenCaptureMutex`，一个 Helper 同时最多执行一项 WGC 捕获；
- 等待 capture mutex 最多 250ms，超时返回 `busy`；
- 第一张有效帧 deadline 为 2000ms，超时返回 `timeout`；
- 最大单边 16,384 像素；
- 最大总像素 33,554,432（覆盖单屏 8K）；
- 最大 PNG 128 MiB；
- 超限在分配大块 staging/PNG 内存前返回 `too_large`。

Helper 关闭时先停止新 admission。worker 在创建 session 前和取得帧后都检查 shutdown 状态；已接收的 worker 通过 RAII 关闭 session、frame pool、D3D/WinRT 对象后才完成 Promise。不得留下捕获线程、窗口、进程或磁盘临时图像。

## Capability 与状态

Windows `supportsScreenCapture` 为真必须同时满足：

```text
platform == win32
AND interactive desktop preflight passed
AND isScreenCaptureSupported() == true
AND typeof captureMonitorPngAsync == "function"
AND typeof captureWindowPngVerifiedAsync == "function"
```

`isScreenCaptureSupported()` 内部使用 `GraphicsCaptureSession::IsSupported()`，并确认运行系统支持 `IGraphicsCaptureItemInterop::CreateForWindow/CreateForMonitor`。

状态语义：

- 完整链路存在：`screenCaptureStatus="granted"`；
- 非交互 desktop、锁屏/安全桌面或启动 preflight 拒绝：`"denied"`；
- 旧 addon、系统不支持或 ABI 不完整：`"unknown"`，同时 capability 为 false。

capability 表示当前 source Helper 可执行视觉捕获，不代表产品安装包、签名或无边框 capability 已完成。

## TypeScript 集成

### Adapter

`createNodeAutomationAdapter` 沿用原生剪贴板的成组 capability 模式：

- Windows 完整三导出存在时，直接 await native capture；
- Windows SystemSurface 继续是无截图的 fail-closed surface，不增加外部 fallback；
- macOS/Linux 继续使用现有 SystemSurface；
- malformed outcome、同步 throw、Promise rejection 都映射为净化后的 broker 错误。

`captureScreenPng(area)` 调用 monitor capture，并将成功结果转换为现有 screen capture 结构。它不缓存第二份图片；session visual-frame 仍由现有 backend 建立。

### App state

`createAxWinReadOnlySource` 增加一个可注入的 verified window capture callback：

- `includeScreenshot=false` 时不启动 WGC；
- `includeScreenshot=true` 时，先取得 UIA snapshot 和窗口身份，再调用 verified capture；
- 成功时附加 PNG、实际 bounds 和像素尺寸；
- `invalid_target` / `target_changed` 使整个 observation 失败；
- identity 稳定但 `busy`、`timeout`、`device_lost`、`capture_failed` 或 `encode_failed` 时，允许保留 UIA tree，同时 `screenshot=null`，并附加 additive、净化后的 `screenshot_error` warning；
- 没有图像的 state 不建立 `state_image` visual target，后续 `space:"state_image"` 必须明确拒绝并要求重新观察。

这样既不因为一次只读视觉失败丢掉可用 UIA 信息，也不会让模型误以为该 state 含有图像。

## 错误映射

| Native error                        | Broker 语义                           | 重试规则                       |
| ----------------------------------- | ------------------------------------- | ------------------------------ |
| `busy` / `timeout`                  | `timeout`                             | 只读观察可由调用方显式重试     |
| `unsupported`                       | capability false / `not_authorized`   | 不在本次 session 重试          |
| `unavailable`                       | `internal` 或启动 capability false    | 环境恢复后显式重试             |
| `invalid_target` / `target_changed` | `element_unavailable`，要求 reobserve | 不复用旧 state                 |
| `too_large`                         | `invalid_request`                     | 缩小目标后重试                 |
| `device_lost`                       | retryable `internal`                  | 不自动重放动作，只重试只读捕获 |
| `capture_failed` / `encode_failed`  | sanitized `internal`                  | 显式重试                       |

视觉捕获是只读操作，可以明确重试；任何后续点击、输入等动作仍遵循原有 delivery-state，视觉失败不能触发动作自动重放。

## 坐标一致性

Windows 进程已使用 `PER_MONITOR_AWARE_V2`，因此 UIA、`GetWindowRect`、monitor bounds 与 WGC capture bounds 都按物理像素解释。

### `space:"screenshot"`

```text
全局物理坐标 = screenshot 图片坐标 + selected monitor bounds 原点
```

非主显示器的负坐标必须保留。后一次 screenshot 或 zoom 替换当前 visual-frame，旧 screenshot 坐标不得继续使用。

### `space:"state_image"`

```text
全局物理坐标 = state_image 图片坐标 + state capture bounds 原点
```

state cache 保存 native 成功 outcome 的实际 bounds 和像素尺寸。若实际像素尺寸与 bounds 宽高不一致，上层必须按现有 image transform 显式缩放；不得默认为 1:1 后静默点击错误位置。窗口移动、缩放、最小化、销毁或 HWND/PID 复用都使旧 state 失效。

## 安全与隐私

- 非交互 desktop、锁屏与安全桌面不捕获；
- 不捕获高完整性级别目标；
- native 与 TypeScript 日志不包含 PNG、像素摘要、窗口标题、可执行路径或用户内容；
- 默认不把 PNG 写入磁盘；
- 高频捕获只允许 `debug` 级生命周期统计，且只记录结果类别、耗时、尺寸，不记录内容；
- error message 只使用固定错误码；
- live smoke 使用非敏感 marker，输出中不打印 marker 或图像内容。

source 开发阶段接受 Windows 自带捕获边框，这是系统向用户展示捕获行为的一部分；不通过隐藏窗口、manifest 欺骗或私有 API 绕过。

## TDD 与验证策略

实现阶段严格按以下顺序先写失败测试，再写最小实现：

1. **ABI/type tests**
   - 三导出齐全才启用；
   - 缺一项、旧 addon、非函数、malformed outcome、rejected Promise 全部 fail closed；
   - Buffer 可按 Uint8Array 消费。
2. **adapter tests**
   - monitor/window success；
   - 每个 native error 到 broker error 的映射；
   - Windows 不回退 SystemSurface；
   - macOS/Linux 路径不读取 Windows ABI。
3. **state source tests**
   - `includeScreenshot=false` 不调用捕获；
   - 成功图像与实际 bounds 进入同一 state；
   - identity/bounds 变化使整个 observation 失败；
   - transient failure 保留 UIA tree，但没有 `state_image` target。
4. **native source tests**
   - CreateForWindow/CreateForMonitor；
   - free-threaded frame pool；
   - hardware/WARP device 顺序；
   - ContentSize crop、RowPitch、WIC PNG；
   - mutex、deadline、size guards、RAII cleanup；
   - pre/post identity 与 bounds 校验；
   - 固定错误码且不泄漏 HRESULT 文本。
5. **MSVC compiled-addon checks**
   - 三个导出存在；
   - capability 在支持系统上真实返回；
   - invalid bounds/HWND 返回结构化失败，不 crash。
6. **broker/source Helper tests**
   - `broker_info.capabilities.screen_capture`；
   - `screenshot` 建立正确 monitor visual-frame；
   - `get_app_state` 建立带图像的 state；
   - 没有图像时 `state_image` fail closed；
   - Helper 正常关闭且无 orphan。
7. **全量门禁**
   - zcode-cua focused/full tests、build、typecheck、lint；
   - ZCode CUA focused tests、`pnpm typecheck`、`pnpm lint`；
   - 现有非 CUA 基线失败如仍存在，必须单独列出，不能伪报全绿。

## 实机 smoke

实机 smoke 默认关闭，必须显式 opt-in，并且只在普通已解锁桌面运行。测试使用受控测试窗口或测试期间启动的普通应用，不依赖用户已有窗口内容。

验证顺序：

1. 启动 source Helper 并确认 capability 为真；
2. 捕获所选显示器，解析 PNG header，校验宽高和 monitor 原点；
3. 启动可识别的测试窗口并记录 HWND/PID/bounds；
4. 首次捕获目标窗口；
5. 用另一个测试窗口完全遮挡目标窗口，再次按 HWND 捕获；
6. 校验遮挡前后均为有效、非空目标图像，且不是遮挡窗口内容；
7. 调用 `get_app_state(include_screenshot=true)`，确认返回图像、新 `state_id` 和正确 capture bounds；
8. 验证 `state_image` 坐标转换命中测试窗口内预设的安全目标；
9. 最小化目标窗口，确认 fail closed；
10. 恢复所有前台、窗口位置和测试资源，关闭 Helper，确认无 orphan。

任何恢复失败都使 smoke 失败。锁屏、LockApp、无 foreground、非交互 desktop 环境只记录为“环境不满足”，不得报告 live acceptance 通过。

## 验收标准

- Windows source Helper 的 `screen_capture` capability 在完整 WGC ABI 下为 true；
- `screenshot` 返回所选显示器的有效 PNG，并正确处理负坐标原点；
- 指定 HWND 被普通窗口完全遮挡时仍可得到目标窗口图像；
- `get_app_state(include_screenshot=true)` 返回同一已验证窗口观察的 UIA tree、PNG、bounds 与新 `state_id`；
- `space:"state_image"` 只使用对应 state 的图像和 capture bounds；
- 目标身份或 bounds 变化时不产生混合 state；
- 最小化、高完整性、锁屏/安全桌面和无效 HWND 均 fail closed；
- 旧/半实现 addon 不虚报 capability；
- 不存在 BitBlt、PrintWindow、PowerShell、外部命令或 Electron fallback；
- native worker 不阻塞 JS 主线程，Helper 退出后没有残留线程、进程或临时图像；
- macOS/Linux、30-tool surface、remote/mobile 链路无行为变化；
- 自动门禁达到各仓库既有要求，普通已解锁桌面的 opt-in live smoke 有明确证据。

## 已知风险与后续产品闭环

- WGC 默认系统边框可能进入视觉体验；无边框需要产品 identity/manifest/capability 评审；
- HDR 到 SDR 的颜色与亮度可能不完全一致，需要后续 tone mapping；
- 部分 GPU/驱动可能发生 device lost，当前只返回可识别错误，不自动隐藏；
- WGC、`GetWindowRect` 与可见内容边界可能存在系统边框差异，必须以返回的 capture bounds/尺寸做映射；
- 8K PNG 的峰值内存较高，已有像素与 PNG 上限保护，产品阶段仍需压力测试；
- x64/arm64 预编译 addon、安装包签名、升级兼容和正式发布 smoke 留到后续产品闭环。

这些风险不改变本阶段选择：先让源码开发环境形成可重复、可验证的 Windows WGC 视觉闭环，再进入发布与产品化。
