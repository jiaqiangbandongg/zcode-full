# ZCode 数据目录占用 ARMS 上报

## 结论

Desktop 每台设备最多每 24 小时采集并上报一次本地 ZCode 数据根目录
`getZCodeDataRootDir()` 的逻辑字节数。采集优先等待系统空闲、ZCode 无运行任务且窗口在
后台的低干扰窗口；实际目录遍历在 Worker 线程执行，Electron main 只负责调度和最终
ARMS `sendCustom`。

旧 `perf_resource_disk_space` 统计的是 Electron `userData` 与安装目录，不等价于用户的
ZCode 数据目录。本功能使用独立事件 `perf_resource_zcode_data_size`，避免新旧口径混合；
新版本不再从通用资源窗口发送旧事件。

```text
app/ARMS ready
      |
      v
read persisted state ---- failed ----> fail closed, retry state read after 6h
      |
      +-- missing -------------------> first startup schedule
      |
      +-- recent success/reservation -> wait until 24h due time + device jitter
      |
     due / no history
      v
wait 2..10min startup jitter / poll every 5min
      |
      +-- system idle >= 5min
      +-- no Agent task running
      +-- app is background
      |
      v
Worker scans getZCodeDataRootDir()
      |
      +-- activity resumes before 6h fallback --> abort, retry after 30min
      +-- scan failure ------------------------> retry after 6h
      +-- complete / partial -----------------> persist report reservation
                                                   |
                                                   +-- persist failure --> do not send
                                                   |
                                                   v
                                             main sendCustom
                                                   |
                                                   v
                                         confirm lastReportedAt
```

等待低干扰窗口满 6 小时后只放宽系统输入空闲与窗口后台要求，仍禁止与 ZCode 运行任务
并发。这样避免一直活跃的设备永久缺样，同时不与模型生成、命令、自动化
争抢磁盘。

## 指标契约

事件：`perf_resource_zcode_data_size`，`group=resource`。

| 字段                  | 口径                                                 |
| --------------------- | ---------------------------------------------------- |
| `value`               | 本次已统计的 `zcode_data_bytes`                      |
| `metric_kind`         | 固定 `zcode_data_bytes`                              |
| `zcode_data_bytes`    | 普通文件 `stat.size` 之和                            |
| `scan_status`         | `complete` / `partial`                               |
| `partial_reason`      | `time_limit` / `file_limit` / `io_error`；完整时不传 |
| `scan_duration_ms`    | Worker 扫描墙钟耗时                                  |
| `files_scanned`       | 已计入的普通文件数                                   |
| `directories_scanned` | 已成功打开的目录数                                   |
| `scan_error_count`    | 无权限、文件消失或其他局部 IO 错误数                 |
| `data_root_kind`      | `default` / `custom`                                 |
| `schema_version`      | 固定 `1`                                             |

公共维度继续由 Desktop main 写入 `device_mid`、`platform`、`app_version`、`arms_env`、
`event_name` 与 `metric_value`。禁止上报数据根绝对路径、文件/目录名、用户名、项目路径、
workspace/session/task id、远端目标或凭据。

`zcode_data_bytes` 是跨平台一致的逻辑文件大小，不是文件系统 allocation blocks。符号链接
不跟随，避免循环和越出数据根。目录在扫描期间仍可能变化，因此结果是低频近似快照，
不承诺文件系统事务一致性。

## 调度与状态

- 发送前先原子写入 `reportReservedAt` 作为限流 reservation；reservation 写入失败时不
  发送。发送成功后移除 reservation 并写入实际的 `lastReportedAt`；发送失败则恢复原状态
  并在 6 小时后重试。若进程在 reservation 与发送之间退出，启动后保守地按已发送处理，
  宁可少一个样本也不重复上报。
- 只有状态文件明确不存在时才视为无历史状态。状态读取、解析或格式校验失败时必须
  fail-closed，不启动扫描或上报，并在 6 小时后重新读取状态；重试成功前不得进入首次启动
  调度。状态读取重试复用 scheduler 的单一 timer，不得累计重复 timer。
- 无历史状态时，ARMS ready 后按设备稳定散列延迟 2～10 分钟。
- 有历史状态时，24 小时到期点再叠加按 `device_mid + due bucket` 计算的 0～60 分钟
  稳定 jitter；启动恢复时必须先计算包含 jitter 的实际到期点，不能在基础 24 小时到期
  后改走 startup jitter。所有设备不能固定在同一钟点。
- 到期但不满足低干扰条件时每 5 分钟检查一次。
- 低干扰等待满 6 小时后，仅要 ZCode 无运行任务即可采集。
- 扫描期间低干扰条件失效则终止 Worker，30 分钟后重试；6 小时 fallback 扫描仅在
  新 ZCode 任务开始时终止。Worker 返回后以及 reservation 写入后都必须在发送前同步
  复查 eligibility，关闭 activity poll 之间的竞态窗口。
- 扫描或 Worker 失败不发送 0 值，不更新成功状态，6 小时后重试。
- `complete` 和 `partial` 都是成功送达的样本并更新 `lastReportedAt`；看板精确统计必须
  筛选 `scan_status=complete`，partial 仅表示下界。
- App 退出时清除 timer 并终止 Worker，不等待扫描完成。

调度状态持久化在 Electron `userData` 下的专用状态文件中，不复用
`~/.zcode/v2/telemetry-state.json`，避免与 `/report` telemetry state 的进程锁和写入语义
发生竞争，也避免状态文件改变被测目录大小。

## 扫描保护

默认保护值：

- 最大墙钟时间：30 秒；
- 最大普通文件数：200,000；
- 单个 Worker；
- 不跟随符号链接；
- 局部 IO 错误继续扫描并把结果标记为 `partial/io_error`；
- 时间或文件数达到上限立即结束并标记 `partial`。

旧同步扫描最多统计 50,000 个普通文件，却没有暴露结果不完整。本实现移除该 main
process 同步遍历；上限只作为 Worker 的资源保护，不能伪装成完整值。

## Feature Impact Brief

| Field            | Value                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| Developer intent | 低干扰、低频上报本地 ZCode 数据目录占用                                  |
| Capability       | `capability.zcode-data-size-telemetry` / `capability.data-observability` |
| Change layer     | `commit-effect` + `persistence`                                          |
| Operating mode   | planning                                                                 |
| Primary seeds    | `getZCodeDataRootDir`、目录扫描 Worker、空闲调度器、ARMS reporter        |
| Out of scope     | UI、远端机器 `~/.zcode`、磁盘剩余空间、目录清理、conversation delivery   |

### UI Surface Matrix

| User scenario            | UI entry | Shared implementation           | Display/draft owner | Default/inherit source  | Validation/gating         | Commit action     | Authority/persistence                   | Mode boundary           | Must remain isolated from                         |
| ------------------------ | -------- | ------------------------------- | ------------------- | ----------------------- | ------------------------- | ----------------- | --------------------------------------- | ----------------------- | ------------------------------------------------- |
| Desktop 本地数据占用遥测 | none     | Desktop main scheduler + Worker | none                | `getZCodeDataRootDir()` | due/idle/task/scan limits | ARMS `sendCustom` | Worker snapshot + local scheduler state | desktop app-global only | renderer、remote host、mobile replay、task stream |

### Shared And Divergent Behavior

| Concern   | Shared across surfaces         | Deliberately different                            | Why it matters for this change          |
| --------- | ------------------------------ | ------------------------------------------------- | --------------------------------------- |
| Data root | services path source of truth  | default/custom root only changes `data_root_kind` | 不能把 Electron userData 当成业务数据根 |
| Timing    | one app-global scheduler       | each device has stable jitter                     | 防止集中 IO 与上报峰值                  |
| Runtime   | main dispatches and reports    | Worker owns traversal                             | 避免阻塞 Electron main                  |
| Delivery  | existing ARMS resource channel | remote/mobile receive nothing                     | 不污染 continuous/replayable 状态       |

### Feature Relationships

| Rank           | From                    | Semantic edge               | To                         | Condition                   | Why inspect it               | Evidence          |
| -------------- | ----------------------- | --------------------------- | -------------------------- | --------------------------- | ---------------------------- | ----------------- |
| must-inspect   | scheduler               | resolves-root-through       | `getZCodeDataRootDir`      | after dataBaseDir bootstrap | 自定义数据目录必须生效       | code/spec         |
| must-inspect   | Worker                  | returns-bounded-snapshot-to | Desktop main               | due and eligible            | main 不遍历目录              | code/test         |
| must-inspect   | Desktop main            | reports-through             | ARMS RUM                   | complete/partial result     | 单一凭据与设备维度 owner     | code/test         |
| should-inspect | Host runtime task count | gates                       | scheduler                  | Agent running               | 不与用户任务争抢磁盘         | code/test         |
| invariant-only | data-size event         | must-remain-isolated-from   | conversation/task realtime | all modes                   | 不进入 continuous/replayable | architecture/spec |
| invariant-only | local data root         | must-not-inspect            | remote `~/.zcode`          | SSH/WSL/Docker/server       | 不触碰远端用户文件           | spec              |

### State Owners And Commit Sinks

| State/fact       | Draft/display owner | Authoritative owner        | Commit command/service | Persistence/cache             | Evidence  |
| ---------------- | ------------------- | -------------------------- | ---------------------- | ----------------------------- | --------- |
| data root        | none                | services path config       | `getZCodeDataRootDir`  | setting/dataBaseDir           | code      |
| due time         | none                | Desktop scheduler          | timer decision         | dedicated userData state file | spec/test |
| idle eligibility | none                | Electron main observations | scheduler decision     | none                          | code/test |
| scan result      | none                | one-shot Worker            | worker message         | none                          | code/test |
| final event      | none                | Desktop main               | `armsRum.sendCustom`   | ARMS                          | code/test |

### Must-Preserve Invariants

| Invariant                                  | Surfaces/modes           | Proof needed             | Evidence         |
| ------------------------------------------ | ------------------------ | ------------------------ | ---------------- |
| no synchronous directory traversal in main | desktop all platforms    | scanner runs in Worker   | unit/build       |
| no user path/name in payload               | default/custom data root | exact payload test       | unit             |
| at most one successful report per 24h      | restart/long-running app | persisted scheduler test | unit             |
| running ZCode task always blocks scan      | normal/fallback window   | state-machine test       | unit             |
| partial is distinguishable from complete   | limit/error cases        | scanner + payload test   | unit             |
| remote/mobile delivery unchanged           | local/remote/mobile      | no protocol/schema edits | static invariant |

### Codegraph Evidence

当前环境未提供 codegraph 工具，使用 live `rg` 调用方扫描替代：

| Seed                                | Query        | Direct callers / key path                           | Depth | Interpretation                 |
| ----------------------------------- | ------------ | --------------------------------------------------- | ----- | ------------------------------ |
| `configureDesktopResourceTelemetry` | callers      | Desktop main ARMS-ready bootstrap                   | 1     | 现有 resource reporter owner   |
| `hostRunningTaskCountMap`           | callers      | Host task reporter → main map → app lifecycle count | 2     | 可复用运行任务事实，不新增队列 |
| `getZCodeDataRootDir`               | callers      | services path source + local data writers           | 1     | 被测目录权威路径               |
| `perf_resource_disk_space`          | text callers | resource flush + monitoring docs/tests              | 2     | 旧错误口径下线范围             |

### Graph Drift Candidates And Delta

- 现有图只有通用 `capability.data-observability`，缺少本地数据目录大小、Worker owner、
  低干扰调度与 remote/mobile 隔离关系。
- 本实现新增 `capability.zcode-data-size-telemetry` 节点、spec/code seeds 与上述不变量。

### Unresolved Questions

无。目录口径、逻辑字节、24 小时周期、设备 jitter、空闲门控、6 小时 fallback、扫描
限制、partial 语义、隐私字段与本地-only 边界均已由用户确认。

## Case Planning

### Boundary Decisions

| Boundary  | Decision                                | Includes                     | Excludes / prunes                 | Source              |
| --------- | --------------------------------------- | ---------------------------- | --------------------------------- | ------------------- |
| data root | `getZCodeDataRootDir()`                 | default/custom local root    | Electron userData、remote root    | user + code         |
| schedule  | 24h + device jitter                     | startup and long-running app | fixed wall-clock batch            | user                |
| idle      | 5min OS idle + app background + no task | 6h fallback                  | system-wide external probes       | user + architecture |
| scan      | Worker, 30s/200k cap                    | regular file logical bytes   | symlink targets/allocation blocks | user                |
| payload   | one primary size + quality metadata     | complete/partial             | path/name/task/workspace          | user + privacy      |

### Dimensions And Pruning

| Dimension       | Values / equivalence classes                     | Include?                | Reason                                |
| --------------- | ------------------------------------------------ | ----------------------- | ------------------------------------- |
| root            | missing/default/custom/nested files              | yes                     | path source and scan behavior         |
| due             | fresh/due/overdue >6h                            | yes                     | timing and fallback                   |
| activity        | idle/background, active/foreground, task running | yes                     | eligibility guards differ             |
| result          | complete/time limit/file limit/io error/failure  | yes                     | payload and retry semantics differ    |
| platform        | macOS/Windows/Linux                              | representative + static | Worker uses Node fs; no shell command |
| client/delivery | desktop continuous/mobile replayable             | pruned by invariant     | event never enters delivery pipeline  |
| remote kind     | local/SSH/WSL/Docker                             | pruned by invariant     | only local app-global data root       |

### Accepted Cases

| Case ID       | Setup                             | Action            | Assertions                                 | Evidence layers      | E2E status |
| ------------- | --------------------------------- | ----------------- | ------------------------------------------ | -------------------- | ---------- |
| DATA-SIZE-001 | nested regular files              | scan              | exact byte/file/directory counts, complete | filesystem + unit    | not-needed |
| DATA-SIZE-002 | more files than limit             | scan              | partial/file_limit, value is lower bound   | filesystem + unit    | not-needed |
| DATA-SIZE-003 | zero time budget                  | scan              | partial/time_limit                         | filesystem + unit    | not-needed |
| DATA-SIZE-004 | due + idle + background + no task | scheduler check   | one scan/report, persist success           | state machine + unit | not-needed |
| DATA-SIZE-005 | due + user active before 6h       | scheduler check   | no scan, retry in 5min                     | state machine + unit | not-needed |
| DATA-SIZE-006 | overdue wait >=6h + no task       | scheduler check   | fallback scan despite foreground activity  | state machine + unit | not-needed |
| DATA-SIZE-007 | any due state + task running      | scheduler check   | no scan                                    | state machine + unit | not-needed |
| DATA-SIZE-008 | partial result                    | build/send event  | primary bytes + quality fields, no path    | payload + unit       | not-needed |
| DATA-SIZE-009 | recent persisted success          | restart scheduler | no report before 24h+jitter                | persistence + unit   | not-needed |
| DATA-SIZE-010 | report reservation write fails    | due collection    | scan may finish, but no event is sent      | state machine + unit | not-needed |
| DATA-SIZE-011 | task starts before final send     | finish scan       | abort without reporting                    | state machine + unit | not-needed |
| DATA-SIZE-012 | restart inside daily jitter       | restore scheduler | wait until effective due time              | persistence + unit   | not-needed |
| DATA-SIZE-013 | persisted state read/parse fails  | start scheduler   | no scan/report; retry state read after 6h  | persistence + unit   | not-needed |

### Planning Handoff

| Item             | Destination                   | Status     |
| ---------------- | ----------------------------- | ---------- |
| Spec update      | this file + performance docs  | complete   |
| Case catalog     | Accepted Cases above          | complete   |
| Coverage matrix  | non-UI/non-conversation       | not-needed |
| Decision backlog | none                          | complete   |
| E2E handoff      | bounded local worker behavior | not-needed |
