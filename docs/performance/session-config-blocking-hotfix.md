# 3.12.2 聊天配置等待隔离

基线：`origin/hotfix/3.12.2`，`5f7d77dac3`。本记录只描述本次修复；下面是 2026-09-14 macOS arm64 的现场结果。

## Feature Summary

| 项目 | 决策 |
| --- | --- |
| 意图 / capability | 聊天创建与冷恢复不依赖可选远端配置；OffPeak 工具在实际调用时准入 |
| 层级 / mode | validation、recovery、运行期默认值；implementation-handoff |
| Primary seeds | createZCodeAgentService、getModelContextBudgetStrategy、AgentRuntime、getAutoCompactThreshold |
| 不包含 | draft 重复创建、MCP 启动、配置网络故障本身、页面灰度、配额/计费算法 |

## UI Surface Matrix

| 场景 / UI | 本地状态 / 命令 | 共享 owner | 行为 / 边界 |
| --- | --- | --- | --- |
| 冷 draft / Composer | Renderer draft → V4 createSession | Host capability → CLI Runtime | 本地注册工具；配置 pending 不阻塞发送 |
| 已有会话 / Composer | sendText | 同一 CLI Runtime | 无新增预算读取；FIFO 不变 |
| 侧栏冷恢复 | subscribe → resumePersistedSession | workspace capability → createRecord | 保留原 workspace 策略通道，恢复历史与工具 |
| 闲时创建工具 | approval → OffPeakCreate | Host handler → OffPeakTaskService | 调用时校验灰度/套餐/模型，之后才取号/落库 |
| 闲时查询工具 | OffPeakList | Host 本地 task repo | workspaceKey 隔离；无新增远端查询 |
| 手机 / remote workspace | trusted attachment → preferences | 现有 shared-host/remote bridge | 同一固定预算；remote 仍不注册闲时工具 |
| 闲时页面 | 原 store / form | 原 subscription + task service | 页面灰度与准入规则不变 |

## Shared And Divergent Behavior

两处 Host resolver 都直接返回同一共享预算常量；CLI 在 Runtime 与协议物化边界归一 legacy 输入。
工具注册只说明本机可承接调用，创建准入说明账号此刻能否取号。页面可见性独立，不随注册放开。

## Relationships / Owners / Invariants

| Rank | 关系 | owner / sink / 证明 |
| --- | --- | --- |
| must-inspect | workspace 同步与 legacy/V4 创建 → 工具注册 | Host 本地能力；策略测试与 SCB01/02 |
| must-inspect | OffPeakCreate → 校验 → createTask | Host handler；SCB03 拒绝时 createTask=0，既有允许路径 |
| must-inspect | Runtime budget → compact / 每步输出 cap / 子 Agent | Core 统一 preflight；SCB04 / OTB / subagent 单测 |
| invariant-only | trusted clientMode、workspaceIdentity、owner/FIFO | 原 attachment/CLI 权威，不创建队列或 Host |
| invariant-only | client-config 成功缓存/强制刷新/其他消费者 | 原 provider owner；未增加缓存、计时器、后台刷新 |

不新增数据库/Settings 持久化；兼容协议仍接受 legacy，新 Runtime 不采用旧算法。

## Codegraph / Graph Drift / Delta

新 worktree 无 `.codegraph`，按约定不建立索引；通过精确函数/调用点检索检查深度 2 的
Host → 配置 / CLI → Runtime → compact、output cap 路径。未声称执行 codegraph 扫描。
图谱缺少聊天启动不得等待这两类配置的约束，已在 conversation-runtime 与 off-peak-model-execution
节点加入用户确认的不变量。其他节点/边与持久化结构不变。

## Planning Handoff

用户最终确认：本地工具始终注册、灰度只在实际创建时查；预算固定 preflight-v1，取消远端回退。
SCB01–05 的 setup/action/assertion 与证据层已先写入 case catalog 和 coverage matrix。
网络延迟参数不做全排列：pending 屏障代表最坏等待；配置拒绝由 Host 单测代表；旧进程热升级剪枝。
无未决产品项。新增 E2E 仍在 manual-review/pending，不标为已人工审阅或 Docker 已准入。

## Validation

### 运行链路与计时

```text
Enter -> Host 本地能力 + 固定预算 -> CLI 接纳 -> 页面绑定/用户消息 -> provider HTTP
               client/configs 始终 pending，不参与上述等待
OffPeakCreate -> 现有审批 -> Host 灰度/套餐/模型 -> createTask -> 取号/落库
```

同一隔离配置网关、相同 fixture；baseline 临时恢复基线生产源码后重建测试，随后恢复全部修复。
以下为单次样本（毫秒），不代表线上分位数。HTTP 点为本地 provider 代理收到请求的时间，
接纳点取 CLI 的 `v4 prompt admitted` 日志；页面绑定与用户消息可见由 DOM observer 记录。

| 场景 | CLI 接纳 | 页面绑定 | 用户消息可见 | HTTP 请求 |
| --- | ---: | ---: | ---: | ---: |
| 基线冷 draft | 39444 | 39486 | 40081 | 40091 |
| 修复冷 draft | 591 | 613 | 1259 | 3373 |
| 修复已有会话续发 | 16 | 0 | 115 | 36 |
| 修复重启冷恢复后发送 | 45 | 0 | 113 | 1476 |

续发/恢复行的页面绑定 0 表示 Enter 前已打开该会话。基线有 8 个配置请求、0 个响应，
最终发送后因工具列表没有 OffPeakCreate 而失败；修复三个阶段分别 6/6/10 请求、始终 0 响应。
原始证据在工作区 `packages/desktop/.e2e-artifacts/scb-baseline/` 与 `scb-final/`，
各自 `timing-reviewed.json` 保留关联 session id 与原始时间戳，runtime-logs 保留接纳日志。

新增用例进一步要求 Enter 到 HTTP 小于现有单次配置超时 15 秒，不能以“等超时后最终成功”通过。
独立重跑 `scb-guard-isolated/` 通过，冷/续发/恢复 HTTP 为 2743/87/2118 ms，配置仍无响应。

### 自动化结果

- 定向服务/Host 4 文件 91 项、Core 6 文件 59 项、会话协议 2 文件 90 项通过。
- shared-host attachment、remote workspace bridge、connection scope 3 文件 38 项通过。
- 闲时工具 bridge、真实临时数据库/模拟网关集成、task service 3 文件 29 项通过。
- Desktop 实际 Electron E2E：配置等待隔离、model-output-token-budget、model-output-token-preflight
  三个 spec 通过；Compact 94K 阈值、21K reserve、summary 20K 与逐请求上限均走真实 Runtime/HTTP。
- root `pnpm typecheck`、Desktop `typecheck:e2e`、Core typecheck 通过；root lint 0 errors，
  Core/bootstrap/contracts 的独立 lint 0 errors；架构检查 0 新增问题。
- `ZCODE_AFFECTED_TEST_BASE=origin/hotfix/3.12.2 pnpm verify:pre-push` 通过：
  按基线 `5f7d77dac3` 到实现 commit 的真实差异运行 lint、架构、变更单测和 related 单测，
  并非未提交差异下的跳过结果。最终仅补本文记录与 D49 文档格式，生产代码和测试未再改变。
- fixture metadata check 通过。新 case 保留 manual-review/pending，不声称人工审阅或 Docker 准入。

### 未通过项与边界

- Bootstrap 协议测试 109/111 通过，两项失败在原基线复现：remote Cron denylist、
  Account Config providers 的数组/对象契约。未顺带修改这些行为。
- 全局 conversation coverage audit 9 项错误在原基线一致：I74/I75 引用、四项统计、三份生成文档陈旧。
  graph YAML 可解析且无重复 id；四条悬空边在原基线一致，本次只增加两个节点的不变量。
- 附加 `conversation-session-offpeak-create` E2E 在 beforeSession 因既有 mock 配置代码按对象
  读取现有数组形式的 providers，报缺少 `account:zai-offpeak-idle-plan.api`，未进入测试正文，
  不计通过。取号/落库正常路径由服务集成测试验证。
- 一次附加配置 E2E 捕获模型切换期间 Host `runtime is not running`，没有提交用户消息；
  日志保存在 `scb-final-guard/`。本次未处理模型切换/重复 draft 竞态；独立重跑通过，
  不把该失败解释为配置等待，也不以重跑宣称这个竞态已修复。
- 手机链路本次验证到 shared-host/remote bridge 的协议与服务层，未跑真机手机、SSH/WSL/Docker
  完整 GUI；未执行 Windows/Linux Desktop。continuous/replayable、owner 与 identity 代码未改。
- CLI 顶层 lint wrapper 缺少可用 turbo 配置；上述逐包 lint 为实际执行结果。
- 未修改配置网络/MCP 启动根因，不新增缓存或后台刷新；旧运行进程升级前仍使用自身算法。
