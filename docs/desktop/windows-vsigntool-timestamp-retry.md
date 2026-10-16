# Windows vsigntool 时间戳重试

## 背景

Windows 打包阶段通过 `scripts/sign-windows.ps1` 调用 VSigntool/SafeNet 对 electron-builder 产物签名。CI 会连续签多个可执行文件，每次签名都会请求时间戳服务；当 TrustAsia 等 TSA 偶发返回 `0x80072ee2` 网络超时时，单次失败会中断整个打包。

## 规则

- `scripts/sign-windows.ps1` 保持 GUI 日志同款命令形态：`vsigntool --config <config> --cmd sign -i <file> -m <mode> -r <rule>`。
- 显式设置的 `VSIGNTOOL_PATH` 优先于 `PATH` 自动发现，用于固定 CI 实际调用的签名程序。
- 每个签名规则默认最多重试 5 次，即每个规则最多尝试 6 次；可通过 `VSIGNTOOL_RETRY_COUNT` 或 `-RetryCount` 覆盖，设为 `0` 表示每个规则只尝试一次。Windows CI 使用更保守的 2 次重试，即每规则最多尝试 3 次。
- 重试默认等待 15 秒，可通过 `VSIGNTOOL_RETRY_DELAY_SECONDS` 或 `-RetryDelaySeconds` 覆盖，设为 `0` 表示失败后立即重试。
- 单次 `vsigntool` 默认 600 秒超时，可通过 `VSIGNTOOL_ATTEMPT_TIMEOUT_SECONDS` 或 `-AttemptTimeoutSeconds` 覆盖；有效范围为 1-3600 秒。Windows CI 设置为 120 秒。
- 重试是第一层策略：当前规则失败后，必须先用同一规则耗尽标准重试次数，不因单次错误立即切换规则。
- 时间戳服务商切换是第二层策略：只有当前规则重试耗尽，且最后一次子进程原始输出仍命中明确的时间戳/TSA/`0x80072ee2` 特征，才切换到下一个 VSigntool 规则；新规则重新获得完整的重试次数。脚本自身注入的 attempt-timeout 诊断不参与该判定，避免 PIN、SafeNet 或本机工具挂起被误判为 TSA 故障。
- SafeNet/智能卡错误（例如 `0x8010006a`）不做特殊分类，按当前规则执行标准重试；重试耗尽后直接失败，不因 SafeNet 错误切换时间戳规则。
- 默认 fallback 规则是 `zcodedigicert`，要求 CI 机器的 VSigntool GUI 已保存同名规则，且该规则使用 DigiCert 时间戳。
- 可通过 `VSIGNTOOL_TIMESTAMP_FALLBACK_RULES` 或 `-TimestampFallbackRules` 覆盖规则名列表，例如 `zcodedigicert,zcodeglobalsign`。
- 规则列表按大小写不敏感去重。脚本启动时校验主规则存在；fallback 只在准备切换时检查 `config.xml`，若缺失则明确报错并停止，不为不存在的规则再消耗一轮重试。
- VSigntool 当前 sign 命令只暴露 `-i/-m/-r`，没有单独 TSA 参数；脚本通过切换 `-r <rule>` 改变时间戳服务商，不修改 `config.xml`。
- 脚本并发读取 `stdout` 和 `stderr`，避免错误输出填满管道导致 CI 卡死。
- 单次签名超时后，脚本会检查 `taskkill /T /F` 的退出码，并在短时间内确认目标进程确实退出；只有该路径成功才能报告进程树已终止并允许下一次重试。若 `taskkill` 失败，`Process.Kill()` 仅作为父进程收口手段，必须报告进程树终止失败及“子进程未验证”，并立即结束整个签名脚本，禁止规则内重试或 fallback 启动新的 signer。终止等待和输出收集都必须有界。

## 运行预算与验证

单个产物的理论签名预算约为：

```text
规则数 × (每规则尝试次数 × 单次超时 + 规则内等待) + 规则切换等待
```

CI 默认最多使用 2 个规则、每规则 3 次尝试、单次 120 秒超时；若每次都挂满 deadline，单个产物理论上限约 13 分钟。实际打包会签多个产物，因此 job 仍需保留整体超时保护。

签名后仍使用 Windows 原生校验确认时间戳存在：

```powershell
signtool verify /pa /tw "path\to\artifact.exe"
```
