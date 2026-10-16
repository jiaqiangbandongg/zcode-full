# MR 2028 改动范围：Workspace Hook Trust v2（feat/hook-trust-v2 → staging）

**总量**：21 commits / 196 files / +25,700 −1,225（基于 origin/staging）。

## 0. 这个 MR 做什么

Workspace Hook Trust = 工作区级 Hook 信任/准入机制（软门禁）。背景攻击链：外部 deep link
→ 打开恶意 workspace → 项目配置声明的 SessionStart hook 自动执行本地命令。此前修复把项目
hooks 从可执行配置中剥离（一律忽略）；本 MR 在此之上建立完整信任体系并恢复项目 hook 的
可用性：

- 项目 hook 声明规范化为 immutable `HookBundleSnapshot`，逐条计算 `hookDeclarationDigest`；
- 持久 Trust 以 `workspaceIdentity + hookDeclarationDigest` 为 key 存用户侧 trust store
  （`~/.zcode/security/workspace-hook-trust-v1.json`，workspace 文件不能自授信任）；
- **软门禁**：未信任 hook 不阻塞 turn——本轮跳过并上报 `HookRunBlocked`，聊天底部出现
  pending banner，用户在 `设置 → 钩子` 逐条点"信任"；信任只作用于未来自然事件，已跳过的
  SessionStart 不补跑；声明语义变化 → digest 变化 → 旧 Trust 失效；
- managed policy deny 优先；无 capable host、store 损坏、snapshot mismatch 全部 fail-closed；
- headless/CLI 通过 `zcode hooks trust status|grant|revoke` 操作。

语义权威 spec：`docs/specs/workspace-hook-trust-persistent-only.md`（v2 只保留"对单条精确
声明的逐条持久 Trust"一种授权，删除 v1 的 allow_once/trust_all/keep_blocked 多态授权）。

## 1. 分层改动一览

```
┌─ UI ─────────────────────────────────────────────────────────────┐
│ 设置→钩子 行内[信任]按钮+锁定开关 · pending banner · review store  │  27 files
├─ Services ───────────────────────────────────────────────────────┤
│ hooksService 读取 trust store（完整 schema 同判）· 设置数据模型   │  18 files
├─ Shared ─────────────────────────────────────────────────────────┤
│ v4 协议投影 workspaceHookAdmission/review · discovery · store     │  30 files
│ 文件 schema（单源权威，contracts re-export）                      │
├─ Bootstrap（apps/zcode-cli）─────────────────────────────────────┤
│ app 装配 · review controller/supervisor · pretrust RPC ·         │  46 files
│ CLI status/grant/revoke · v4 commands handlers                   │
├─ Core ───────────────────────────────────────────────────────────┤
│ 信任域（digest/records/evaluation）· coordinator · runtime        │  31 files
│ admission（软门禁+HookRunBlocked）· review flow · policy/telemetry│
├─ Contracts / Adapters / CLI ─────────────────────────────────────┤
│ trust store 文件/记录/decision schema · 原子持久化（rename 重试） │  26 files
│ · zcode hooks trust 命令                                         │
├─ Desktop E2E ────────────────────────────────────────────────────┤
│ HK05–HK07 manual-review pending spec + fixture + wdio 冷启动接线  │   3 files
├─ Docs / Scripts ─────────────────────────────────────────────────┤
│ 主 spec/persistent-only/soft-gate · 用户指南 · 人工验收 ·         │  13 files
│ UAT fixture 生成器 · coverage matrix · 改动范围文档               │
└──────────────────────────────────────────────────────────────────┘
```

## 2. 按模块明细

| 模块 | 规模 | 核心内容 |
| --- | --- | --- |
| **bootstrap** | 46 files +6,879−337 | review flow 唯一生产入口 `requestReview`（controller L607：flow 复用/supervisor/串行队列/deadline 收口）；workspace 级 Settings pretrust RPC（v2 新增，无 session 场景，managed policy 校验后落盘）；`zcode hooks trust` CLI 域逻辑（status 对 corrupt 显式 `workspace_hooks_trust_store_corrupt`）；v4 protocol commands 接线 |
| **core** | 31 files +3,480−358 | 信任域三件套（types/domain/records）；`evaluateWorkspaceHookEntry`（`effectiveRunnable = admitted && configuredEnabled && policy != deny`）；per-workspace coordinator（security revision、policy 订阅）；runtime admission（pending 上报 `{pendingCount,bundleDigest,workspaceIdentity}`）；runner 软门禁发 `HookRunBlocked`（reasonCode `workspace_hooks_pending_trust`，不阻塞 turn） |
| **shared** | 30 files +2,625−55 | v4 协议：`zcode-protocol-v4/workspace-hook-review`（decision/target/payload）、snapshot/delta 增量字段 `workspaceHookAdmission`（additive, default null）；discovery 对齐；**store 文件 schema 单源** `workspace-hook-trust-store-file.ts`（CR-01 修复的落点） |
| **ui** | 27 files +2,524−103 | `HooksSection`/`HooksList` 行内信任交互（未信任行：[信任]按钮 + 锁定关闭 Switch，无状态徽章/无批量动作）；`useWorkspaceHookInlineTrust`（RPC 必须路由到 target workspace 的 host，防越界）；`WorkspaceHookPendingBanner`（[去审核]/[忽略]，忽略为 renderer 本地 dismiss）；review store；reasonCode→i18n 映射 |
| **services** | 18 files +1,575−240 | `hooksService` 读 workspace 配置 + trust store（v2 终态：完整 strict schema，与 runtime/adapters 同判；异步 ENOENT 区分）；workspace hook 设置模型（discovery→UI 行）；trust store corrupt 上报 `trustStoreCorrupt` |
| **adapters** | 11 files +1,432−83 | 文件 trust store：原子写（temp+fsync+rename，Windows EPERM/EBUSY 有界重试）、文件锁+stale 清理、corrupt 改名恢复（`*.corrupt-<ts>`）、revoke 空数组拒绝、compact |
| **contracts** | 6 files +724−2 | digest schema v1、review timeout、`WorkspaceHookTrustState`/admission class/reasonCode 枚举、effective state schema、bundle snapshot schema、review flow state、store 文件 schema（现为 shared re-export）、policy schema |
| **cli** | 9 files +610−20 | `zcode hooks trust status|review|grant|revoke` 命令（--workspace/--hook-digest/--all-current/--bundle-digest/--json）；human 输出含 pending 的 grant 指引与 corrupt 的恢复指引 |
| **desktop** | 5 files | HK05–HK07 正式 e2e + fixture helper + wdio.conf 冷启动接线 + case-local provider fixture/manifest |
| **docs** | 13 files +5,005−27 | 主 spec `workspace-hook-trust.md`、语义权威 `workspace-hook-trust-persistent-only.md`、软门禁设计 `workspace-hook-trust-soft-gate.md`、用户指南（含 corrupt 恢复）、人工验收手册、conversation-session case catalog（HK05–07）+ coverage matrix、改动范围文档（本文件） |
| **scripts** | 1 file +258 | `create-workspace-hook-trust-uat-fixture.mjs`：生成无害 UAT workspace（3 条声明 + executions.jsonl recorder），`--verify` 现场防漂移 |
| **根/其他** | 2 files +137 | `pnpm-lock.yaml`（contracts 新增 `@zcode/shared` workspace 依赖）；`.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml`（特性图登记） |

## 3. 关键设计决策

1. **v2 = persistent-only**（`141ebf7bda`）：删除 v1 多态授权状态机（allow_once/trust_all/
   keep_blocked/timeout 自动决策/SessionStart 补跑/独立审核面板），只保留逐条精确持久
   Trust。决策契约收敛为 `{ action: "trust_selected"; reviewItemIds }`。
2. **trust store schema 单源**（CR-01）：schema 下沉 `@zcode/shared`（zod4），contracts
   re-export（zod3 侧不组合引用），services/runtime/CLI 对同一文件同判——JSON 语法错误
   与结构非法（缺 schemaVersion/必需字段、非法 decision/时间戳、未知字段）一律 corrupt
   fail-closed，corrupt 下不展示任何 trusted_persistent。
3. **软门禁语义**：未信任 hook 跳过本轮 + `HookRunBlocked`（不伪装 `HookRunFailed`），
   turn 不停等；信任只作用未来自然事件；banner 忽略是 renderer 本地行为（key =
   sessionId+bundleDigest），不产生 Trust mutation。
4. **workspaceIdentity 隔离贯穿**：trust key、review binding、pretrust RPC、缓存去重均以
   `workspaceIdentity` 为准（本地 fallback workspacePath），远程 workspace 不得经 path
   fallback 成为本地提交通道。

## 4. 测试与验证状态

| 层 | 证据 |
| --- | --- |
| 单测/集成 | 2,800+ 用例：contracts/core/adapters/bootstrap/cli/services/shared/ui 全覆盖（含 CR-01 parity 9 用例红→绿、schema 损坏样本 12 用例、review controller 时序/并发/superseded） |
| 桌面 E2E | HK05–HK07 manual-review pending spec，macOS replay 3/3 通过（`desktop-e2e-20260817093717062-p95687-5fe4ae6a35334d65`，staging 合入后复跑） |
| typecheck/lint | shared/services/contracts/bootstrap/cli + desktop 全过 |
| 人工验收 | `docs/testing/workspace-hook-trust-manual-acceptance.md`（UAT-01~05）+ UAT fixture 脚本 |

**待补验证**（合并后跟进）：

- Windows：trust store rename 重试、e2e Docker admit / CI 分片（`run-windows-e2e-shards.mjs`）。
- e2e spec 人工 review 后走 `e2e:promote` 转正式目录并更新 matrix 路径。
- staging 上游既有 6 个单测失败（appARMSBootstrap minified pattern / feedback base 断言 /
  onRuntimeLifecycle mock）与本 MR 无关，需另行修复。

## 4.5 伴生的 v4 并发修复（评审说明）

MR 中存在一处与 hook trust 非同域但有逻辑耦合的 v4 改动，在此显式声明以便知情评审：

**prompt-turn.ts / queue.ts 的 turn-start 不确定性语义**（+133/−81 与 +31）：

- 新增 `turnStartUncertain` 标志与 `fault.command.turnStartProjectionCommitFailed` reasonCode；`queue.ts` 的 sendQueuedNow 在 promotion 失败且属于不确定性失败时**保持 promoting 不回滚 queued**——迟到的 canonical TurnStarted 若与重试并发会形成重复消息。
- 与软门禁的逻辑关联：软门禁要求"turn 永不停等审核"，pending hook 跳过路径与 turn 启动共享同一 authority/projection 提交时序；修复 admission 异常注入该时序后暴露的并发窗口属于同一条提交链路，无法干净剥离（剥离需重写历史并 rebase 后续全部 commit）。
- 评审建议按独立并发正确性修复看待：重点看 queue.ts 的 `isPromptTurnStartUncertainFailure` 分支（保持 promoting）与 prompt-turn.ts 的 `isTurnStartAuthorityObserved` 判定。

**fork-edit-retry.ts**：曾混入的 prettier 重排噪音（+24/−57 零语义变化）已还原为 staging 版本，不再出现在 MR diff 中。

## 5. 兼容性说明

- 协议增量均为 additive（v4 snapshot/delta 新字段 default null），旧客户端可忽略。
- 已有 zcode.json/.zcode/config.json 的用户升级后：项目 hook 从"被安全策略忽略"变为
  "待信任软门禁"，首次会在设置页看到逐条信任入口——行为变化符合预期且有 banner 引导。
- 桌面 continuous 与手机 replayable 链路：trust 判定在共享 runtime/services 层完成，
  未改动 stream/snapshot/队列/owner 语义；手机端走同一 review RPC 与同一 trust store。
