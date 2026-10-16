# E2E Metrics Bitable Dashboard

## 背景

`scripts/ci/push-e2e-metrics-to-bitable.mjs` 将 E2E `summary.json` 写入飞书多维表格 `E2E Test Metrics` 的 `e2e_runs` 表。原看板趋势图直接用 `started_at` 作为横坐标，同一天多次提交会按随机提交时间分散，导致总览趋势不易阅读。

## 字段约定

看板依赖两个 Base 公式字段，字段值由历史记录即时计算，不需要推送脚本额外写入：

- `started_day`: `TEXT([started_at], "YYYY-MM-DD")`
- `started_day_time`: `TEXT([started_at], "MM-DD hh:mm")`

Windows 运行记录额外写入 `windows_version`。该字段优先读取运行机器的 `Win32_OperatingSystem.Caption`，从中保留真实的 Server / Home / Pro / Enterprise / Education 等产品信息；不得仅凭内核 build 推导 Edition。产品描述不可用时只记录原始 Windows build，不补造 `Pro` 等 Edition。

新增趋势图时不要直接把 `started_at` 用作总览横坐标。总览用 `started_day`，平台独立看板用 `started_day_time`。

## 看板分层

当前 Base 内维护三个看板：

- `E2E 测试质量看板`：总览看板。趋势组件按 `started_day` 聚合；通过率、耗时类指标取 `AVERAGE`，失败数类指标取 `SUM`。
- `E2E 测试质量看板 - macOS`：macOS 专项看板，统一过滤 `platform = darwin`。
- `E2E 测试质量看板 - Windows`：Windows 专项看板，统一过滤 `platform = win32`。

总览看板不保留 macOS / Windows 单独数据或平台对比图；平台数据只放在独立平台看板中。

每个独立平台看板包含：

- 概览指标卡：运行次数、平均通过率、失败数、Assertion 失败、Timeout 失败、Crash 失败、Infra 失败。
- 趋势图：通过率趋势、Case 耗时 P50/P95、Suite 总耗时、失败数趋势。

独立平台看板按 `started_day_time` 展示每次提交时间点。

## 维护注意

- 新增平台时，优先复制现有独立平台看板的组件结构，只替换 `platform` 过滤值。
- 如果重建 Base 或表，需要先恢复上述公式字段，再创建看板组件。
- 飞书 dashboard block 更新接口有频控，批量修改组件时应串行执行并在请求间留出短暂间隔。
- Bitable token 和记录写入请求各自有 30 秒超时；请求失败或超时必须返回非零退出码，交由调用方决定是否阻断当前 CI。
