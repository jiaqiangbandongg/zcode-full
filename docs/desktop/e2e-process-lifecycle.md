# Desktop E2E Process Lifecycle

## Run Identity

Desktop WDIO E2E uses one run identity for both file isolation and process cleanup:

- `ZCODE_E2E_RUN_ID`
- `ZCODE_E2E_HOME_DIR`
- Electron app arg `--zcode-e2e-run-id=<runId>`

`ZCODE_E2E_HOME_DIR` isolates persisted app data. `ZCODE_E2E_RUN_ID` is also passed on the Electron command line so process scans can identify the root process for the current WDIO run without relying on shared build paths.

## Cleanup Boundary

Process cleanup may only select a root process when its command line contains the current run id arg or the current normalized E2E home directory. After a root is selected, cleanup recursively includes its children so host and agent subprocesses are reclaimed even when their own command lines do not include the run marker.

macOS 的 Electron main 与 ChromeDriver 可能不会保留 `appArgs`，但 renderer、utility、
host 或 crash handler 的命令行仍会携带当前 run 的 HOME/profile 路径。清理器允许从这类
精确命中的后代向上补齐连续的 Electron main 与 ChromeDriver 父链，再从得到的根节点
向下回收整棵树；遇到 WDIO controller、shell、terminal 或其他非 Electron/ChromeDriver
父进程必须停止。反向追溯必须由当前 runId/HOME 的精确命中触发；不能仅凭
`ZCode E2E`、共享 build 路径或进程名称直接选择清理根。

`beforeSession` 的进程退出屏障、fixture/mock 初始化和 HOME reset 是一个 fail-closed
前置事务。WDIO config hook 会吞掉普通 rejection，因此事务失败时必须保存原始错误，并由
Mocha 原生 root hook 在任何产品 case body 前抛出；失败 worker 只能产生一条基础设施
root-hook failure，不能带着缺失的 replay/capture、日志目录或旧 HOME 继续执行产品断言。

Shared markers are intentionally not cleanup identities:

- `ZCode E2E`
- `APP_ENTRY_POINT`
- `out/main`

Those values only prove that a process belongs to this repository or product test build. They do not prove it belongs to the current WDIO run. Using them as kill conditions lets one shard or local run terminate another shard with a different `ZCODE_E2E_HOME_DIR`, causing DevTools disconnects, `DevToolsActivePort` failures, white screens, or random suite exits.

## Platform Notes

The same boundary applies on macOS, Linux, and Windows. Windows retry cleanup after HOME removal failures uses the shared cleanup helper as well, because stale file handles are common there and the fallback must remain parallel-run safe.

## Continuous Windows Runner

`scripts/ci/run-e2e-bitable-loop.ps1` provides a PowerShell 7 entry point for a dedicated Windows E2E host. Each iteration:

1. enters the configured z-code checkout;
2. fetches `staging` from the configured HTTPS repository and updates the local branch with a fast-forward merge;
3. clears inherited spec filters and runs the desktop E2E suite once, without entering the shard runner, through `pnpm --filter @zcode/desktop test:e2e:serial`;
4. invokes `scripts/ci/push-e2e-metrics-to-bitable.mjs` and then `scripts/ci/push-e2e-report-to-feedback.mjs` for that artifact directory, including when the E2E command fails. Failure artifact collection is enabled so the report upload can attach failed-case videos.

The continuous loop owns exactly one run-specific output directory:
`packages/desktop/.e2e-artifacts/continuous-<UTC timestamp>-<PID>/`. The serial
WDIO child writes `summary.json` directly into that directory, so metrics upload
does not need to discover or merge per-shard summaries. Its application state
uses the fixed, ignored `packages/desktop/.e2e-home/` directory; the loop must not
create run-specific `packages/desktop/.e2e-home-<run>-shard-*` siblings. The
serial entry point applies only to this continuous loop. Other E2E entry points
may keep their own sharding policy.

The loop never resets or discards repository changes. A dirty checkout, failed fetch, or non-fast-forward branch skips that iteration and retries after the configured delay. Generated E2E HOME directories are ignored by Git so test state from a prior interrupted run is not mistaken for a source change. Bitable credentials and `ZCODE_FEEDBACK_NOTIFICATION_TOKEN` remain environment variables consumed by the upload scripts. `-Once` runs one iteration for maintenance or validation.

Before each fetch, the loop removes only runner-owned transient state from the
previous iteration: the fixed `packages/desktop/.e2e-home/`, legacy
`packages/desktop/.e2e-home-*` directories, and the legacy
`packages/desktop/.e2e-network-capture/` directory. Every deletion target must
resolve inside the checkout and must still be ignored by Git. The loop retains
`.e2e-artifacts/` so a failed report upload can be diagnosed or retried, and it
retains `.e2e-cache/` and normal build caches. After cleanup, any remaining
tracked or non-ignored change is printed with its porcelain status and blocks
the fetch; the runner never resets, checks out, or deletes source changes.

Bitable HTTP requests have their own 30-second timeout. The loop limits the complete Bitable uploader process to 120 seconds by default (`-UploadTimeoutSeconds`) and the report/video uploader process to 1800 seconds (`-FeedbackUploadTimeoutSeconds`). Either timeout terminates the uploader process tree, records a non-zero result, and proceeds to the next iteration after the configured delay. Both uploaders are attempted even when one fails; an E2E failure remains the primary iteration exit code.

```powershell
pwsh -File .\scripts\ci\run-e2e-bitable-loop.ps1
pwsh -File .\scripts\ci\run-e2e-bitable-loop.ps1 -Once
```

The runner validates `LARK_E2E_APP_ID`, `LARK_E2E_APP_SECRET`, `LARK_E2E_BITABLE_TOKEN`, `LARK_E2E_TABLE_ID`, and `ZCODE_FEEDBACK_NOTIFICATION_TOKEN` before starting the first E2E run. `ZCODE_FEEDBACK_BASE_URL` remains optional and uses the report uploader default when omitted.
