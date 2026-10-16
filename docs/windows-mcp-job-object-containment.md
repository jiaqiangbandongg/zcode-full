# Windows MCP Job Object 进程托管（原型）

## 目的

在 Windows 上为 ZCode 的本地 stdio MCP root 进程创建独立的 Job Object，并在 MCP 关闭时优先终止该 Job。这样可以覆盖 root 在托管期间创建的后代进程，减少 Agent/MCP 退出后遗留的控制台进程。

## 范围

- 只覆盖 Agent 侧 `ProcessTreeStdioClientTransport` 启动的本地 stdio MCP。
- macOS/Linux 保持现有 process group 清理逻辑不变。
- Job Object 创建或 PID 加入失败时，继续使用现有 `taskkill /T /F` 回退路径。
- 本原型在 Node SDK 已创建 root 后进行 attach，因此不能保证覆盖 attach 之前已经创建的后代；要保证完整覆盖所有后代，后续仍需 native `CREATE_SUSPENDED → AssignProcessToJobObject → ResumeProcess` launcher。

## 生命周期契约

```text
MCP start
  ├─ 非 Windows：现有 process group 路径
  └─ Windows：SDK spawn root → 尝试 attach Job Object → 失败则保留 taskkill

MCP close
  ├─ Windows Job 存在：TerminateJobObject + CloseHandle
  └─ 之后仍执行 SDK pipe/transport 清理；Job 失败不阻断 fallback
```

## 安全边界

- 每个 MCP transport 独立持有一个 Job，不使用全局 Job，避免误杀其他 workspace 或 MCP。
- 仅使用 transport 自身的 root PID attach，不根据进程名或全局进程表匹配。
- 所有 Windows API 调用失败均降级到既有回收逻辑，不改变非 Windows 行为。
- 该原型不宣称消除 spawn/attach 竞态，生产化前必须增加 Windows 真机测试，验证 root 在 attach 后创建的 descendant 会随 Job 终止。
