# Windows CIM 进程清理与告警降噪设计

## 目标

在 Windows 10 及以上环境中移除 WMIC 进程查询后端，统一使用 PowerShell `Get-CimInstance Win32_Process`，并将 Agent 进程清理的 error 告警收敛到最终重试失败，减少 `runtime process tree cleanup incomplete` 的误报警，同时保持 PID reuse 防护和 fail-closed 安全边界。

## 非目标

- 不改变 `transport_ready` / `functional_ready` 两阶段 Helper 启动协议。
- 不允许仅凭裸 PID 调用 `taskkill /PID /T /F`；仍由 Host 持有且确认存活的受管
  `ChildProcess` root 句柄属于独立所有权证据，不按裸 PID 处理。
- 不引入 Windows Job Object；该方案另行设计。
- 不扩大 Windows 进程清理 deadline。

## 设计

### CIM capability

Local Host 生命周期内维护 PowerShell/CIM 能力状态。首次全量 CIM 查询即完成真实能力确认并缓存结果，不额外启动一次探测进程；能力探测必须验证 `powershell.exe` 和 `Get-CimInstance Win32_Process` 的真实可调用性，而不是只检查可执行文件存在。

能力状态至少区分：

- `cim`：当前 Host 可执行 CIM 查询。
- `identity-unavailable`：PowerShell 不存在、被策略阻止或本轮查询不可用。

硬失败可以在 Host 生命周期内缓存；单次 timeout 不得永久污染后续 cleanup，仍需允许下一轮重试。

### Process snapshot and force verification

Agent cleanup 开始时执行一次异步全量 CIM 查询，按 PID 建立索引，保存 `pid`、`parentPid` 和规范化的 `CreationDate`。后代只从本次快照和受管 root 生命周期推导。

Graceful 退出等待后，force 阶段仍须对快照中的已知 root/descendant 做定向 CIM 身份复核。后代只有 PID 与 CreationDate 同时匹配才允许执行 `taskkill /PID /T /F`；查询失败、超时或身份不匹配时继续 fail-closed。root 另有一个受限例外：cleanup 未进入 `unverifiedRootOnly`，且 Host 持有的原始 `ChildProcess` 仍满足 `exitCode/signalCode` 均为 `null`、句柄可发送信号并确认 PID 存活时，可仅对该 root 执行 graceful `/T` 或 deadline `/T /F` 兜底。该例外不允许沿 root PID 重新发现或认领后代，也不允许把未复核后代加入 `/F` 目标。

```text
Host init
  -> CIM capability (cached)
  -> cim / identity-unavailable

Agent spawn
  -> one full CIM snapshot
  -> PID index + parent links + CreationDate

cleanup
  -> EOF + graceful taskkill
  -> targeted CIM identity recheck
  -> exact match: taskkill /PID /T /F
  -> managed root handle still live: root-only /T /F fallback
  -> unavailable/mismatch descendant: no bare PID force, observe deadline
  -> unverifiedRootOnly: no handle fallback, observe deadline
```

### Alert policy

`cleanupManagedProcessWithRetry` 的第一次失败只记录可恢复的 `warn` 并保留原始错误；retry 成功时最终 cleanup 视为成功，不产生 error 告警。只有 retry 也失败时，才记录一次最终 `error`，并保留最终错误作为返回值。

## 验收标准

1. 代码和测试中不再启动 `wmic.exe`。
2. WMIC 不存在时不再产生 `wmic.exe ENOENT` warning。
3. PowerShell/CIM 可用时全量快照、定向身份复核和 force 行为保持正确。
4. `identityVerification: "unavailable"` / `unverifiedRootOnly` 路径仍 fail-closed，不发送裸
   PID `/F`；受管 live root 句柄例外只能作用于 root，不能扩散到未复核后代。
5. cleanup 第一次失败、retry 成功时不产生最终 error；两次失败只产生一次最终 error。
6. 相关 Windows 单测和 Agent process manager 单测通过。
7. 回归测试覆盖定向 CIM 复核失败时的受管 root-only `/F` 兜底，以及
   `unverifiedRootOnly` 下不发送任何 root `/F`。
