# Windows CUA 原生文本剪贴板设计

## 目标

为 Windows source Helper 补齐 `read_clipboard` 和 `write_clipboard` 的真实文本实现，使
`broker_info.capabilities.clipboard` 只在完整原生读写链路存在时为 `true`。实现必须使用
Win32 `CF_UNICODETEXT`，不得调用 PowerShell、shell、外部命令或 Electron clipboard。

本阶段只覆盖本地 Windows 登录用户 Session 中的 source Helper。macOS、Linux、SSH、
WSL、Docker、remote workspace、手机 `/remote` 与产品打包签名链路不变。

## 已确认方案

采用 additive 原生异步 ABI：

- `readClipboardTextAsync(): Promise<NativeClipboardReadOutcome>`
- `writeClipboardTextAsync(text): Promise<NativeClipboardWriteOutcome>`

Windows `ax_native.node` 在 libuv worker 上运行有界 Win32 clipboard 操作；
`createNodeAutomationAdapter` 在且仅在两个导出同时存在时使用它们。旧 Windows addon
缺任一导出时继续报告 `clipboard=false`，不允许半实现或同步 fallback。

未采用的方案：

1. 把 native clipboard 注入 `WindowsNodeSystemSurface`：会扩大 Helper factory 与
   SystemSurface 构造参数，而 adapter 已同时持有 native 与 system，增加中转没有收益。
2. TypeScript FFI：会新增运行时依赖与 ABI 风险，并重复 N-API 已有的平台隔离能力。
3. PowerShell / `Get-Clipboard` / `Set-Clipboard`：违反 source Helper 不依赖外部命令的
   约束，也会引入编码、进程生命周期和命令策略差异。

## 边界与非目标

包含：

- 读取和写入 Windows `CF_UNICODETEXT`；
- 空文本与空/无文本剪贴板的真实语义；
- UTF-8 ↔ UTF-16 严格转换；
- bounded worker、Helper 内部串行化、外部占用重试；
- capability、broker error、delivery-state 与 source runbook 更新；
- 显式 opt-in 的真实 broker round-trip，并在 `finally` 中恢复原文本。

不包含：

- 图片、HTML、RTF、文件列表、延迟渲染或剪贴板历史；
- 保留写入前的非文本 clipboard formats；
- 跨设备或远程剪贴板同步；
- WGC、窗口像素捕获或 UIA worker 隔离；
- 新增、删除或重命名 MCP 工具。

`write_clipboard` 的产品语义就是用纯文本替换当前剪贴板。显式实机 smoke 也会短暂执行该
动作；它能恢复原始文本，但不能恢复原来同时存在的 HTML、图片等附加格式。因此 smoke
默认关闭，只有设置专用 opt-in 后才能运行。

## 架构与数据流

```text
read_clipboard
  │  READ_ONLY
  ▼
broker handler ──await──> Node automation adapter
                              │
                              ├─ win32 + 两个 native async export
                              │       │
                              │       ▼
                              │   ClipboardReadWorker
                              │       │
                              │       ├─ Helper clipboard mutex
                              │       ├─ bounded OpenClipboard retry
                              │       ├─ CF_UNICODETEXT / GlobalLock
                              │       └─ CloseClipboard → UTF-8 outcome
                              │
                              └─ macOS/Linux 现有 SystemSurface

write_clipboard
  │  T1_INPUT + possibly_sent
  ▼
broker handler ──await──> Node automation adapter
                              │
                              ▼
                         ClipboardWriteWorker
                              │
                              ├─ UTF-8 → UTF-16 + 预分配 HGLOBAL
                              ├─ Helper clipboard mutex
                              ├─ bounded OpenClipboard retry
                              ├─ EmptyClipboard
                              ├─ SetClipboardData(CF_UNICODETEXT)
                              └─ 成功后把 HGLOBAL 所有权交给系统
```

broker 的 action delivery-state 不变：`write_clipboard` 一旦进入 possibly-sent 区间，
传输错误不得自动重放。native 在 `EmptyClipboard` 前失败时保证未修改系统状态；在
`EmptyClipboard` 后失败时返回明确 write failure，调用方仍按 possibly-sent 处理。

## Native ABI 与内存所有权

### Outcome

读结果：

```ts
type NativeClipboardReadOutcome =
  | { ok: true; text: string }
  | {
      ok: false;
      error: "busy" | "unavailable" | "invalid_data" | "too_large";
    };
```

写结果：

```ts
type NativeClipboardWriteOutcome =
  | { ok: true }
  | {
      ok: false;
      error: "busy" | "unavailable" | "too_large" | "write_failed";
    };
```

Outcome 不包含 clipboard 文本、pipe、token、进程路径或 Win32 原始错误消息。

### 串行化与时间边界

- 使用独立 `std::timed_mutex g_clipboardMutex` 串行化本 Helper 的读写，不复用输入序列锁；
- worker 最多等待 250ms 获取 Helper mutex，超时返回 `busy`，期间没有 clipboard 副作用；
- 获取 mutex 后，`OpenClipboard(nullptr)` 最多尝试 8 次，每次间隔 10ms；
- worker 的正常上限低于 500ms，因此 Helper graceful stop 可以等待已接收操作收尾；
- broker freeze 后不再接收新的 clipboard 操作，无需把 clipboard worker 接入输入停止门闩。

Win32 clipboard 只有同步 API；把它放到 `Napi::AsyncWorker` 是本阶段不阻塞 broker/N-API
线程的必要条件，不允许在 JS 主线程轮询或 sleep。

### 读取

1. 成功打开 clipboard 后用 RAII 保证所有出口调用 `CloseClipboard`；
2. `CF_UNICODETEXT` 不存在时返回 `{ok:true,text:""}`，表示剪贴板当前没有文本；
3. format 存在但 `GetClipboardData` / `GlobalLock` 失败时返回 `invalid_data`；
4. 用 `GlobalSize` 约束可读范围，在范围内寻找第一个 UTF-16 NUL，禁止无界 `wcslen`；
5. 文本超过 8 Mi 个 UTF-16 code units 时返回 `too_large`；
6. 严格转换成 UTF-8，转换失败返回 `invalid_data`。

### 写入

1. N-API 线程只读取参数并复制 UTF-8 字符串，不调用 Win32 clipboard；
2. worker 严格转换 UTF-8 到 UTF-16，最多 8 Mi 个 code units，并包含结尾 NUL；
3. 在 `OpenClipboard` / `EmptyClipboard` 前完成 `HGLOBAL` 分配和内容复制；
4. `SetClipboardData` 成功后由 Windows 接管 `HGLOBAL`，worker 不再释放；
5. 任何更早的失败均由 worker 释放自己的 `HGLOBAL`；
6. `EmptyClipboard` 后 `SetClipboardData` 失败返回 `write_failed`，不得伪报成功。

## Adapter、capability 与错误语义

`HelperNativeAddon` 增加两个 optional async 方法和 outcome 类型。

`ElectronAutomationAdapter` 的 clipboard 方法允许 sync 或 Promise 返回；backend 两个
handler 改为 `async` 并统一 `await`，因此 macOS/Linux 的同步 SystemSurface 保持兼容。

Windows native clipboard 只有在以下条件同时满足时启用：

```text
platform == win32
AND typeof native.readClipboardTextAsync == "function"
AND typeof native.writeClipboardTextAsync == "function"
```

capability 规则：

- Windows 两个导出齐全：`supportsClipboard=true`；
- Windows 缺任一个：沿用 `WindowsNodeSystemSurface.supportsClipboard=false`；
- macOS/Linux：继续使用各自 SystemSurface 的现有 capability，不读取 Windows ABI。

错误映射：

- `busy` → broker `timeout`，并注明在 mutation 前失败；
- `too_large` → `invalid_request`；
- `unavailable` / `invalid_data` → broker `internal`，因为 Windows 没有需要用户授予的
  clipboard 权限开关，不得误导用户修改权限；
- `write_failed` → broker `internal`，保留 possibly-sent，不允许自动重放。

所有日志与错误禁止包含剪贴板内容。高频调用不新增 `info` 日志。

## 生命周期与安全

- Session 0、非交互 desktop 或 addon startup preflight 失败时不暴露 native clipboard；
- 锁屏不等同于 Session 0。Windows 允许同一登录 Session 访问 clipboard，但 pointer
  前台门禁仍独立 fail closed；
- clipboard mutex 与 input state mutex 相互独立，禁止交叉持锁；
- worker 不持有 UIA COM 对象，不需要进入 UIA apartment；
- Helper stop 先 freeze broker admission，再 drain 已接收 worker；超时仍按现有 Helper
  进程死亡证据 fail closed；
- 读写工具、tier、annotation、30-tool manifest 与 broker method 名称不变。

## 测试策略

采用 TDD：

1. native source/ABI tests：先锁定 worker、bounded retry、RAII close、size guard、HGLOBAL
   ownership 和两个导出；
2. adapter tests：覆盖双导出启用、单导出拒绝、macOS/Linux system fallback，以及每个
   native outcome 的 broker 映射；
3. capability truthfulness tests：旧 Windows addon 仍为 false，新双导出为 true；
4. broker tests：`read_clipboard` 返回真实空字符串，`write_clipboard` await native 成功，
   busy/too-large/write-failed 不伪造成功；
5. MSVC rebuild 与 compiled-addon export checks；
6. 默认关闭的真实 source Helper smoke：
   - 读取原文本；
   - 写入随机非敏感 marker；
   - 读回精确比对；
   - `finally` 恢复原文本并再次验证；
   - 输出仅含布尔值和平台，不输出原文本、marker、token 或 pipe；
7. zcode-cua 全量 gates、ZCode CUA focused gates、typecheck 与 lint。

实机 smoke 若在恢复阶段失败，必须返回非零并提示用户当前剪贴板可能仍是测试 marker；
不得在无法恢复时报告通过。

## 验收标准

- Windows source Helper 的 `broker_info.capabilities.clipboard === true`；
- `read_clipboard` 能区分真实空文本与实现缺失；
- `write_clipboard` 写入 Unicode 文本后可由同一真实 broker 精确读回；
- live smoke 精确恢复原文本，且默认不 opt in 时不读取或修改 clipboard；
- 旧 Windows addon 缺失 additive ABI 时继续 fail closed；
- macOS/Linux clipboard 行为和 30-tool surface 不变；
- 不出现 PowerShell、shell、外部命令或同步主线程 clipboard 轮询；
- native build、focused tests、全量 zcode-cua tests、两仓 typecheck/lint 均达到各自既有门禁要求。
