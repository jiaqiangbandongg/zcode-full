# ZCode CLI 有界关闭规格

> 状态：accepted，2026-07-22。

协议型 CLI 的生命周期由[Agent Server spec](../apps/zcode-cli/docs/design/v2/zcode-protocol-agent-server.md#协议进程生命周期)
定义：其 deadline 从首次 EOF/信号/致命错误开始，覆盖启动中和在途请求；不依赖 `run()`
返回才启动 watchdog。下文一次性命令与 plugin-host 的既有规则保持不变。

## Feature/change summary

| 字段         | 决策                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Change       | 修正一次性 CLI 在模型完成后被继承 pipe、悬空 Browser close 或其它 adapter handle 永久保活的问题                                         |
| 用户可见入口 | `zcode --prompt`、`--target` 与 TUI 退出；Desktop/remote host 复用同一 session cleanup 不变量                                           |
| 状态 owner   | Execution adapter 持有命令进程组和 stdio；managed CDP adapter 持有 Chromium；session facade 编排 teardown；CLI entry 只持有最终退出边界 |
| 成功标准     | 正常清理优先；任一外部 close 永不 settle 时，ZCode CLI 仍在固定上限内结束，不等待孤儿进程自然死亡                                       |
| Out of scope | 纯 Node 跨平台保证杀死已经 `setsid`/daemonize 并脱离原进程组的任意第三方进程；改变 desktop continuous / mobile replayable 语义          |

## Clarification log

| 问题                                 | 用户输入 / 现场证据                                                                               | 固定边界                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 只修继承 pipe 是否足够               | 单独打包 `fix(cli): clean up inherited subprocess pipes` 后仍复现                                 | 关闭必须覆盖 execution、browser、MCP 与 CLI entry，不把 pipe 修复当全局 teardown                 |
| 直接 `process.exit()` 是否作为主修复 | teardown 日志可完成，但 Node event loop 仍可能被未知 handle 保活                                  | 先做所有已知资源的有界清理；仅在 `run()` 已返回且 event loop 仍存活时由 watchdog 强退            |
| `run()` 返回是否总表示进程应退出     | `__zcode-plugin-host` 的 MCP `server.connect()` 完成后 `main()` 会返回，但 stdio 服务仍应持续运行 | watchdog 只属于一次性 CLI；plugin-host 由 MCP stdio/父进程持有生命周期，不进入一次性退出策略     |
| 是否必须杀任意 daemon                | POSIX 新 session / Windows reparent 后，父 PID 或原 PGID 不再足以寻址                             | 同组后代尽力清杀；失去 ownership 时销毁本端 pipe 并保证 CLI 退出，OS 级绝对 containment 另立能力 |

## Boundary decisions

| 边界                     | 决策                                                                                                                       | 禁止行为                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| root shell `exit`        | 只代表直接子进程结束，不代表 execution 的 pipe/后代完成                                                                    | 不能在 pipe 未 EOF 时立刻从 active ownership 移除 background execution                 |
| foreground pipe drain    | 最多等待有限 drain；随后清理进程组并销毁本端读流                                                                           | 不能用无上限 `await closePromise` 阻塞 prompt                                          |
| background session close | 即使组长已经退出，也继续向原进程组发送 TERM/KILL；最终销毁 pipe                                                            | 不能因 `exited === true` 跳过 cancel                                                   |
| runtime admission        | teardown 第一拍关闭 background notification/model wake admission                                                           | 不能让 execution cancel 的 terminal event 在关库期间新开模型轮次                       |
| resource teardown        | Browser session、Execution、MCP、Node REPL broker 各自容错并带 deadline；一个失败不能跳过其它资源                          | 不能串行 `await` 一个永不 settle 的 close 后永久停住                                   |
| managed Chromium         | context、browser、late launch 都使用有界 close；CLI adapter 仍负责 best-effort 回收                                        | 不能因 `context.close()` 或 `browser.close()` 悬空阻断 execution cleanup               |
| CLI entry                | 一次性命令的 `run()` 返回后设置 unref watchdog；event loop 自然耗尽时不触发，否则保留既有 exit code 强退                   | 不能在模型响应/stdio 输出尚未完成时提前 `process.exit()`                               |
| plugin-host entry        | `__zcode-plugin-host` 成功启动 MCP server 后由 stdio/父进程决定存活与关闭，不注册一次性 CLI watchdog；初始化失败仍有界强退 | 不能把 MCP server 的有效 stdio handle 当成泄漏，也不能让失败插件残留的 handle 永久保活 |

## Domain scope and high-risk cross-products

主域是 architecture/process boundary、background Bash lifecycle、managed Browser lifecycle 与 CLI release。

| Cross-product                                           | 风险                                                                      | 处理                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| background Bash × root exited × inherited stdout/stderr | `close` 事件依赖孙进程 EOF，CLI 永久保活                                  | accepted：保留 ownership、杀组、销毁流                             |
| detached descendant × lost PGID                         | 第三方服务仍活着且原 pipe 不 EOF                                          | accepted：本端释放 + CLI watchdog；进程回收只承诺 best-effort      |
| BrowserContext close × WS/SSE 页面                      | Playwright close 可能永不 resolve                                         | accepted：per-operation deadline，继续 execution/MCP cleanup       |
| normal prompt × unknown active handle                   | 所有已知 teardown 已结束但 event loop 不空                                | accepted：入口 watchdog                                            |
| plugin-host × MCP stdio active handle                   | `server.connect()` 返回后 stdio handle 是服务存活条件，不是一次性命令泄漏 | accepted：跳过 CLI exit watchdog，父端关闭 stdin 后自然退出        |
| desktop/mobile/remote delivery × cleanup                | 错把 host cleanup 扩散为 conversation replay 规则                         | pruned：不改 protocol、snapshot、queue、clientMode 或 deliveryKind |

## State sequence

```text
model terminal
  -> runtime.beginShutdown()          # 封住新 notification/model wake
  -> [browser session | execution | MCP | REPL broker] bounded cleanup
       | timeout/error on one stage
       +---------------------------------> other stages still run
  -> session store close
  -> CLI-owned browser runtime bounded close
  -> run() returns exitCode
  -> process role
       | one-shot CLI  -> unref exit watchdog
       |                  | event loop empty -> natural exit
       |                  + handles remain   -> process.exit(existing exitCode)
       + plugin-host   -> MCP stdio owns lifetime -> parent closes stdin / signal exits
```

## Candidate combinations and pruning

| Case       | Setup / action                                                     | Assertions                                                              | 分类 / 证据                                         |
| ---------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------- |
| CLI-SD-001 | foreground wrapper 退出，孙进程继承 pipe                           | 有限 drain 后孙进程组被清理；流销毁；result 收口                        | accepted；真实进程集成                              |
| CLI-SD-002 | background wrapper 退出，孙进程继承 pipe，随后 session close       | close 前 task 仍 running；close 后 cancelled/killed，CLI 不被 pipe 保活 | accepted；真实进程集成                              |
| CLI-SD-003 | 孙进程另建 session/进程组并继续持 pipe                             | 本端 pipe 最终销毁，close 有上限；不声称必然杀死已逃逸进程              | accepted；真实进程集成 + finally 清理 fixture       |
| CLI-SD-004 | BrowserContext `close()` 永不 settle                               | Browser close 仍被尝试；Execution/MCP cleanup 仍执行                    | accepted；adapter/session focused test              |
| CLI-SD-005 | `browser.close()` 或 app `close()` 永不 settle                     | prompt/TUI cleanup 返回；入口 watchdog 使用原 exit code 强退            | accepted；CLI focused test                          |
| CLI-SD-006 | 所有 close 正常，event loop 自然耗尽                               | watchdog 为 unref，不人为延迟正常退出                                   | accepted；CLI focused test                          |
| CLI-SD-007 | Windows process tree                                               | `taskkill /T /F` best-effort，pipe fallback 与 watchdog 相同            | accepted pairwise；当前 macOS 不能实机验证 taskkill |
| CLI-SD-008 | mobile replayable / remote identity 全排列                         | cleanup 不读取或改变 delivery/workspace 状态                            | pruned；host-side invariant                         |
| CLI-SD-009 | plugin-host 的 `main()` 在 MCP connect 后返回，父端保持 stdin 打开 | 超过一次性 watchdog deadline 后 host 仍存活；父端关闭 stdin 后正常退出  | accepted；真实 CLI 子进程集成 + SEA smoke           |
| CLI-SD-010 | plugin-host 初始化占住 stdin 后抛错                                | 保留失败 exit code，并由 watchdog 有界强退                              | accepted；真实 CLI 子进程集成                       |

## Coverage matrix / E2E handoff

- conversation background catalog：`BG40`，focused adapter/runtime coverage，不新增 GUI E2E。
- Browser Use matrix：`BCP-212` / `HCDP-013`，覆盖悬空 close 与后续 cleanup。
- CLI 层以真实子进程集成和 Node focused test 为主；plugin-host 必须覆盖“保持 stdin 超过 watchdog deadline 仍存活、关闭 stdin 后退出”；GUI E2E 无法比进程 PID/pipe handle 证据更强。
- Linux/Windows 待 CI 补对应 process-tree 实机；macOS 本地验证 POSIX PGID、detached escape 与最终有界退出。
