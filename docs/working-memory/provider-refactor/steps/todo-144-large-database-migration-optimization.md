# Todo 144：数据库启动保护（SQL 优化已撤出范围）

> 后续执行已转入 [Todo 145：进入 ZCode 前统一准备数据库](./todo-145-global-database-startup-loading.md)。本文仅保留首轮实施轨迹；工作区 loading 和 Host 延后范围不再是当前方案。

> 状态：范围调整中；2026-09-14 用户取消 SQL 优化，启动前全屏 loading 待重新设计。
> 优先级：P0。日期：2026-09-14。
> 创建基线：`hotfix/3.12.2`，`16c3f15c3f`。
> 当前授权：2026-09-14 用户「开始执行」，实施并用隔离数据库验证；20 GB 性能测量仍暂缓。

## 最新范围与执行清单（优先于下方历史记录）

用户认为现有优化未解决关键的峰值内存问题，决定本 hotfix 不做迁移 SQL 优化，也不继续实现 batch。

- [x] 删除 0020/0022 优化 SQL 和执行白名单，runner 直接执行冻结原 SQL。
- [x] 删除优化专属扫描计划测试，保留原 SQL 执行、账本兼容、用户后续修改与失败回滚回归。
- [x] 移除执行版本和实现指纹字段，仅保留既有 migration checksum；不改变原 SQL、ID、账本或数据库结构。
- [x] 验证同步/异步启动执行原 SQL；继续验证等锁、状态 flush、提交后 ready、崩溃恢复。
- [x] 准备当前草稿 MR 的范围与验证记录，随本次提交推送更新；不把历史优化测试作为当前性能证据。
- [ ] 按“进入 ZCode 前全屏 loading”重新设计启动入口。现有工作区门禁未满足目标，不能标记完成。

本次撤回只减少执行实现，不重置分支，不撤销独立 Provider JSON 保护，不修改用户数据库。
SQLite/账本继续拥有唯一迁移事实；Host/UI 只观察阶段。下方保留首轮实施轨迹，其中 SQL 优化及其验证结果已退出交付范围。

### 本次撤回验证

- 先增加实际执行原 SQL 的断言，撤回前失败（0020/0022 被替换），撤回后通过。
- 存储、冻结原迁移与同步/异步 runner、真实锁和崩溃恢复：4 文件 55 用例通过；旧迁移及旧 Reader 回归：5 文件 46 用例通过。
- Host 协议与门禁：2 文件 15 用例通过；bootstrap Writable flush：1 文件 1 用例通过。
- `pnpm typecheck`、CLI adapters/bootstrap typecheck、`pnpm lint`（42 个既有 warning，0 error）、`pnpm architecture:check --changed`（0 violation）通过。
- bootstrap 首轮测试加载旧 adapters/dist，因旧执行指纹不符合新 schema 失败；重新构建 adapters 后同一测试通过，无生产代码兜底。
- 原 migrations.ts 与 migrations/ 相对 hotfix 目标分支 diff 为空；未修改用户数据库，未执行大库性能测量或 UI E2E。
- dep:refs 未加载 CLI adapters project；删除边界依据仓库全文引用扫描与 CLI/跨包类型检查，不声称语言服务确认零引用。

## 首轮实施历史（已被上述范围修订覆盖）

## 本次 hotfix 范围裁决

2026-09-14 用户在讨论 Host 初始化改动规模后，确认先按会话库范围继续：
- 本次：会话库 `db.sqlite` 的 SQL 优化、锁等待、启动通知、业务请求门禁和 loading。
- 后续：[Host tasks-index 初始化可观测性](./host-tasks-index-startup-followup.md)。本次不改它的初始化线程、事务或服务发布顺序。
- 20 GB 性能测量、Windows/macOS 真机验证和发布灰度仍单独记录，不以隔离小库测试代替。

## 1. 背景与目标

部分用户已灰度升级，部分用户仍未迁移；历史会话数据库可能达到 20 GB。
当前 0020 对 part 执行三条 JSON 条件 UPDATE，0022 对历史用户消息排名后关联修复对象，存在减少扫描和中间结果的空间。
数据库迁移又处于启动事务中，可能与其他 Agent 的 5 秒锁等待、普通协议约 3 分钟请求超时及进程回收冲突。

目标：同一 hotfix 兼容已完成和未完成迁移的用户，减少大表处理成本，并让用户在真实迁移完成后进入依赖它的工作区。
20 GB 的扫描量、耗时和内存分析目前只是静态估算，不作为性能结果或通过阈值。

关联：

- [完整启动门禁、协议、错误与跨端方案](../../../desktop/database-migration-startup-gate-plan.md)
- [Todo 109：数据库迁移与回退可读性](./todo-109-database-migration-consolidation-and-rollback-readability.md)
- [SQLite 多 Agent 并发启动合同](../../../superpowers/specs/2026-07-15-sqlite-concurrent-agent-startup-design.md)
- [已合入的聊天配置等待隔离](../../../performance/session-config-blocking-hotfix.md)：不得在启动门禁中重新引入可选远端配置依赖。

## 2. 实施清单

### A. 先固定语义与测试

- [x] 核对最新分支 `dc1026894d`、0020–0022 冻结定义及 config.storage.sessionDbPath 路径来源。
- [ ] 发布评审：执行契约交数据库 owner 复核。本次无 schema 变更，没有触发「修改数据库结构必须同步」条件；未联系他人。
- [x] 先建立冻结旧 SQL 与候选新实现的差分测试，再实现优化。
- [x] 覆盖新库、未迁移、已迁移、部分账本、失败回滚、旧版回退再升级。
- [x] 固定 JSON null/缺失、未知字段、显式空选择、坏 JSON、相同排序值、旧回退字段及用户后续修改的断言。

### B. P0：0020 的 part 三次扫描合并

- [x] 将 fromModel、toModel、subtask.model 的转换合并为一次候选扫描。
- [x] timeline/model_change 同一行同时处理 from/to；subtask 按自身规则转换。
- [x] 精确保留每个字段的触发条件，未匹配的行不写入，不把缺失字段无条件改成 null。
- [x] 保留所有旧成员、未知成员、正文、附件引用、行 ID 和时间字段。
- [x] 核对执行计划确实减少 part 扫描，而非仅把三段 SQL 包进 CTE 后仍重复扫描。

```text
当前：扫描 part → from；扫描 part → to；扫描 part → subtask.model
目标：扫描 part → 按类型与字段条件转换 → 每个匹配行一次更新
```

### C. P0：0022 缩小历史查询范围

- [x] 先确定符合原规则的候选 session_entry/session，候选为空直接结束。
- [x] 在排名输入中限定候选会话，或使用候选会话驱动的索引查询取得最新用户消息。
- [x] 保持“先取最新用户消息，再检查模型/档位”的顺序；不能改为寻找更早的有效档位。
- [x] 保持 sequence、time_created、rowid 的原有排序与并列规则。
- [x] 保持原先“迁移后用户未修改过且模型一致”约束，不修复无关会话。

### D. P1：消息转换与中间结果

- [x] 评估 0020 用户/助手消息的两条 UPDATE 合并扫描，保持两类触发条件和结果。
- [x] 评估排名列：0020 去掉 `message.*`，仅携带 session_id/时间/data；0022 改成索引查询。0020 纯 ID 排名后回表仍留作后续性能比较，未宣称实现。
- [x] 优先利用已有索引；增加大索引须计入构建成本、磁盘空间和锁占用，不默认新增。
- [x] 不把 SQL 函数调用次数直接当成 JSON 全量解析次数；以后以执行计划和测量确认收益。

### E. P0：灰度兼容执行契约

- [x] 保留原 migration ID、原 SQL 定义、原 checksum 和 ledger 格式；历史定义不原地修改。
- [x] 评审并实现明确白名单的优化 executor / executionRevision，作为同一冻结语义的可审计执行实现。
- [x] 已记录项仍按原 checksum 校验并跳过；只有未执行项进入优化实现。
- [x] 优化实现与账本同事务提交；不提前写成功、不删除账本、不跳过 checksum 错误。
- [x] 保持原迁移顺序及逐项跳过行为；存在部分账本时只处理缺失项。
- [x] 新实现的错误/回滚行为也必须等价；不能只比较正常结果后填回旧 checksum。
- [x] 使用冻结旧版实际 Reader/binary 验证回退后内容可读，再升级不重迁或复活用户清空的设置。

```text
已完成迁移 → 校验原 checksum → 跳过大扫描
未完成迁移 → 等价优化实现 → 数据与迁移记录同事务提交
执行失败   → 回滚 → 下次按真实账本重试
```

### F. P0：配套启动保护

- [x] 按完整方案建立 checking / waiting_for_lock / migrating / committing / ready / failed 状态。
- [x] 复用现有 Agent，在数据库业务就绪前传出严格类型的启动通知，禁止解析 stderr 文案作为状态协议。
- [x] Host 提供带 attempt/generation/sequence 的快照和订阅，Root 展示真实阶段与已用时间，不显示虚假百分比。
- [x] SQLite 保持唯一迁移协调者；取得锁后重新检查账本，不让 Host/UI 持有第二把迁移锁。
- [x] 区分迁移锁等待与普通请求超时；迁移期间不发送普通业务请求，防 watchdog 回收导致反复迁移。
- [x] 服务层阻止依赖库的会话、历史、Wiki、scheduler/bot 提前进入；不能只加 UI 遮罩。
- [x] 数据准备不依赖账号、Key、权益或可选远端配置；不同物理库保持独立。
- [x] 完成 Host 同步初始化静态审查；用户确认移入后续任务，本次 loading 不覆盖服务发布前的 tasks-index 初始化。
- [ ] 覆盖多窗口、独立 CLI、SSH/WSL/Docker、Web；手机复用 shared-host，不另起 runtime，不混用 continuous/replayable。
- [ ] 评审具体等待预算、退出和错误重试策略；失败保留数据库，不建空库、不删除 WAL/SHM。

## 3. 验收与证据

- [x] 差分：旧/新实现最终行语义、旧字段、顺序、时间戳、账本及错误回滚一致。
- [x] 并发：持锁超过旧 5 秒后等待者仍可正常完成；同库只迁一次；异库不相互阻塞。
- [ ] 生命周期：COMMIT 前崩溃、COMMIT 后通知丢失、Root reload、手机重连、迟到旧 ready 正确处理。
- [x] 灰度：已完成用户不重扫、不覆盖后续修改；首次与部分升级执行正确；原 checksum 错误仍明确失败。
- [ ] E2E：先确认完整方案 DBSTART-01～18 用例，按 e2e-case-lifecycle 进入 pending，记录 UI/协议/DB 证据。
- [ ] 性能（后续明确允许测试时）：隔离的 20 GB、不同表体积分布和超大单行；对比扫描/执行计划、耗时、峰值 RSS、WAL/临时空间、持锁时间。
- [ ] 平台：Windows/macOS/Linux，以及深浅主题、中英文、手机视口；无法验证的项目明确列出。
- [ ] 机械检查：typecheck、lint、architecture:check、相关差分/多进程/协议测试已通过；E2E 类型检查通过，但桌面运行被当前环境阻塞，不能勾选整体通过。

## 4. 发布与回滚

- [ ] 同包按“已迁移 → 未迁小库 → 未迁大库 → 多进程/远端”逐步灰度，分别观察失败率和资源开销。
- [ ] 优化执行分支可回退为冻结旧实现；已经提交的迁移不反向重跑，旧性能风险须写明。
- [x] 普通业务 timeout 不因升级策略被整体放宽；不修改 task owner/lease、CommandInbox 或 replay 边界。
- [ ] 提交与 MR 单独列出 SQL优化、执行契约、启动UI/协议及平台验证；与 Provider JSON 读取保护补丁区分范围。

不在本 Todo 中做：分批 COMMIT、后台半迁移格式、运行时每次读取补迁、无条件全库备份、未知数据清洗或直接修改用户真实数据库。
完成标准是数据兼容、首次迁移成本与启动体验同时有证据；仅出现 loading 或单次迁移最终成功，不视为完成。

## 5. 2026-09-14 实施与验证记录

代码已落地，按用户要求进入独立分支提交与草稿 MR；E2E 和发布验收未完成前不标记 Todo 完成。

| 层次 | 已有证据 | 限制 |
| --- | --- | --- |
| 旧/新 SQL 差分 | `optimized-migrations.test.ts` 16 个用例；完整行与 JSON 字节、账本、回滚、未知字段、自定义 trigger；EXPLAIN 验证 part 单次扫描与候选会话索引查询 | 隔离小库；不代表 20 GB 峰值内存或耗时 |
| 迁移协调 | `async-migration-startup.test.ts` 4 个用例，真实写锁保持 5.1 秒；同/异库、超预算与错误回滚 | 大库及操作系统差异未测 |
| 原有存储回归 | `session-store.test.ts` 44 个用例含重复双进程启动；旧 Selection/Reasoning/Provider 迁移与旧版实际 Reader 的 5 文件 52 个用例通过 | 回退证据使用冻结旧 Reader，未运行完整旧版本 GUI |
| 崩溃恢复 | `migration-crash-recovery.test.ts` 2 个真实子进程用例；COMMIT 前 SIGKILL 后重迁，COMMIT 后通知丢失不重迁 | 当前 Linux |
| 状态通知与日志 | `bootstrap/tests/storage-startup.test.ts` 1 个用例；真实 Writable flush 屏障、严格 schema、attempt/databaseId/sequence 与诊断同源 | 状态日志按阶段产生，无逐行 SQL 日志 |
| Host 与 UI | 最新聚焦 6 文件 59 个用例通过：协议请求计时、进程管理、门禁、hook 换代/手机观察、Root 远控订阅边界 | 手机真实 relay/SSH/WSL/Docker 尚待回归 |
| E2E | pending 新增 `conversation-session-database-startup.test.ts`，真实旧库+写锁+页面刷新+释放后核对数据 | 正在验证，尚未晋级正式覆盖 |

执行预算：内置新版 Agent 首通知 30 秒；SQLite 外部写锁总等待 60 分钟，单次 native busy 25ms，异步退避 10–200ms；长 SQL 不加自动超时杀进程，10 分钟显示耗时提示。业务期恢复原 5 秒 busy timeout，普通 RPC 原 timeout 不变。自定义旧 Agent 仍兼容旧路径；收到合法启动帧后启用新等待语义。

保留历史 ledger 中未知 ID 的原有兼容行为，仅校验当前已知 ID 的 checksum；不为本 hotfix 新增“遇到未来 ID 就失败”的规则。存在非标准 trigger 时执行冻结原 SQL；原 0015 的两个已知 AFTER INSERT sequence trigger 不受合并 UPDATE 影响。

诊断环境：最初 desktop E2E 在浏览器会话创建前失败，日志确认虚拟 X server 缺少 `/usr/bin/xkbcomp`。依赖只解压到 `/tmp`；不修改系统安装或用户真实配置。后续结果以 E2E 产物为准。

### 最终补查（当前环境）

- 追加真实子进程回归发现并修复：旧启动请求结清时，即使 pending RPC 为 0，迁移也不能进入 idle 回收。`zcodeAgentProcessManager.test.ts` 40 个用例通过；ready 后恢复原空闲策略。
- 最新会话库/崩溃/启动通知聚焦运行：5 文件 67 个用例通过；App 门禁聚焦 6 文件此前 59 个用例通过，随后进程管理器增加上述第 40 个用例。
- `pnpm typecheck`、`pnpm lint`（42 个既有 warning，0 error）、`pnpm architecture:check --changed`（0 violation）、CLI bootstrap typecheck、desktop `typecheck:e2e` 通过。
- 最后一次桌面 E2E 产物：`packages/desktop/.e2e-artifacts/desktop-e2e-20260914103736847-p37727-53170acac47dff56/summary.md`。用例尚未进入执行，ChromeDriver 在创建会话时失败。补齐虚拟显示后，一个仅调用 `app.whenReady()` / `new BrowserWindow()`、不加载 ZCode 的最小 Electron 应用仍以 `Trace/breakpoint trap` 退出（`/tmp/zcode-migration-electron-minimal.log`）；因此当前环境不具备完成桌面 UI 验证的条件，不将它标为业务用例失败或通过。
- 仍待可运行桌面环境补验 loading/刷新/成功放行、失败重试、主题/语言/手机视口与真实远端链路。未执行 20 GB 测量，未发布。用户在了解验证限制后要求更名分支、推送并建 MR，并明确本次忽略 Agent 会话 trailer；不猜测 ID。
- 未使用 codegraph。`dep:refs` 不加载 CLI bootstrap project，旧协议同步 helper 的移除依据仓库全文引用检查与入口切换后的类型检查，不声称语言服务确认零引用。

### 提交基线与授权

2026-09-14：源分支改为 `fix-database-migration-startup`，目标 `hotfix/3.12.2`。先快进至 `5d7165d328`（CLI 异常遥测），再合回本次改动，无冲突；与新增遥测共用的进程管理器和协议经过聚焦回归，7 文件 72 个用例通过，typecheck 通过。Provider JSON 读取保护独立提交，和 Todo 144 同一草稿 MR 供审查；草稿阶段仍保留上述 E2E/平台/性能待验项。

推送前扩大回归：首次 related 扫描 971 文件，970 通过，Root update overlay 的 6 个用例因旧 `useWorkspaceServices` mock 将首参路径原样返回而失败。修正测试替身的服务契约后，6 个用例聚焦通过；生产代码不为测试增加空服务兜底。
