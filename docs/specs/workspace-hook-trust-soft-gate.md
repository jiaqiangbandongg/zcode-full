# Workspace Hook Trust 软门禁(Soft Gate)设计

> 状态:已实施。2026-08-13 的持久信任简化由
> [`workspace-hook-trust-persistent-only.md`](./workspace-hook-trust-persistent-only.md) 定义；
> 本文涉及 `allow_once`、`keep_blocked`、独立审核面板与 SessionStart 补跑的旧描述均由该规格取代。

## 1. 第一性原理

从安全与产品的基本公理出发,而不是从现有实现出发:

1. **未信任代码绝不执行。** default-deny 是底线,任何交互设计不得放宽它。
2. **对话不可被安全决策劫持。** 被卡住的用户会为了解锁对话而点"全部信任"——受胁迫的同意不是同意(consent fatigue 反模式)。信任决策必须在无压力的带外场景中做出。
3. **策略改变了行为,就必须可见。** hook 被跳过时,用户必须能在聊天现场看到"为什么没生效"以及"去哪里处理"。
4. **信任是异步行为,作用于未来,不回溯解锁过去。** 不存在"turn 停下来等审核结果再继续"的语义。
5. **执行点复杂度留在准入层。** 不把安全状态机扩散到协议 RPC、队列、UI 跳转等远端层次。

由公理 2+4 推出:**turn 永不停等审核**;由公理 1 推出:**pending hook 本轮直接跳过(blocked)**;由公理 3 推出:**会话内常驻提示 + 一键去审核**;由公理 5 推出:**删除 parked-turn 全套协议机制**。

## 2. 行为对比

```
旧(硬门禁):
  user prompt ──ACK──> turn 停在 activate() ──强制打开 Settings/Hooks──> 用户被迫决策
                        │                                                    │
                        └──── 10min watchdog / turnStartTimeout（超时不写 Trust） ────┘
                        (审核完成后 turn 才继续;用户被丢在设置页)

新(软门禁):
  user prompt ──ACK──> turn 立即执行,pending hooks 一律跳过(HookRunBlocked)
                        │
                        └─> 事件: WorkspaceHookAdmissionUpdated { pendingCount>0 }
                              └─> snapshot.workspaceHookAdmission
                                    └─> 聊天底部常驻提示条 [N 个 Hook 待审核] [去审核] [忽略]
                                          └─(用户主动点击)─> requestWorkspaceHookReview
                                                └─> controller 开 review flow(受 supervisor 监管)
                                                      └─> Settings/Hooks 未信任行显示[信任]
                                                            └─> exact persistent trust 落盘,revision bump
                                                                  └─> 只影响未来自然发生的 Hook event
```

时序(信任生效链路,涉及状态同步,按规范画图):

```
Renderer                     V4 Server(bootstrap)                Core Runtime
   │                              │                                   │
   │ prompt #1                    │                                   │
   ├─────────────────────────────>│ startPromptTurn                   │
   │                              ├──────────────────────────────────>│ activate(): pending → skip
   │                              │        WorkspaceHookAdmission     │ 记录 skippedSessionStart
   │<── snapshot{pendingCount:2} ─┤<──────── Updated(2) ──────────────┤ + securityRevision R1
   │ [提示条出现]                  │                                   │ turn 正常执行(无 hooks)
   │                              │                                   │
   │ 点击[去审核]                  │                                   │
   ├─ requestWorkspaceHookReview >│ openReviewFlow + supervise        │
   │<── ReviewRequested ──────────┤                                   │
   │ 行内点击[信任]                 │                                   │
   ├─ respondWorkspaceHookReview >│ exact grant → 落盘 → revision R2  │
   │<── ReviewSettled ────────────┤                                   │
   │<── snapshot{pendingCount:0} ─┤<──── AdmissionUpdated(0) ─────────┤
   │ [提示条消失]                  │                                   │
   │ prompt #2                    │                                   │
   ├─────────────────────────────>│ startPromptTurn                   │
   │                              ├──────────────────────────────────>│ 不补跑旧 SessionStart
   │                              │                                   │ 仅后续自然事件使用新 Trust
```

## 3. 设计决策

### D1. 准入层:pending 即跳过,不再开 flow、不再等待(core)

`workspace-hook-runtime-admission.ts`:

- 删除 `reviewPendingSnapshot()` 及其在 `activate()` 中的调用、`reviewActivation` 状态、`review` port 的等待用途。
- pending 声明的运行时语义与既有 headless 路径**完全一致**:runner 逐条发 `HookRunBlocked`(`errorCode: workspace_hooks_pending_trust`),turn 照常执行。桌面与 headless 语义合流,不再有分叉。
- `activate()` 计算 pending 快照后,通过新 port 上报 `{ pendingCount, bundleDigest, workspaceIdentity }`(见 D2)。
- `waitForWorkspaceHookAdmission` 保留(trust-store bootstrap 仍需要),仅删除 review 等待的调用点。
- fail-closed 路径(`bootstrapFailed` / `invalidatedReason`)语义不变。

### D2. 会话级状态载体:snapshot 附加字段(shared + bootstrap)

- `conversationSnapshotSchema` 新增 additive 字段(**必须带 `default: null`**,遵守 snapshot.ts 冻结规则):

  ```ts
  workspaceHookAdmission: {
    pendingCount: number;      // configuredEnabled && admissionClass === "pending" 的声明数
    bundleDigest: string;      // 提示条 dismiss 的幂等 key
    workspaceIdentity?: string;
  } | null
  ```

- 新会话事件 `WorkspaceHookAdmissionUpdated`(与 `WorkspaceHookReviewRequested/Settled/Superseded` 同族),投影层据此写入/清空 snapshot 字段(`pendingCount === 0` → 置 null)。
- 触发点:
  1. `activate()`(startup / resume)完成评估后;
  2. exact persistent trust 后,由 controller 重新评估并发布;
  3. toggle 重建 bundle、revoke 之后同理。
- **不用** `pendingInteractions` 承载 admission(它是"阻塞性"的 load-bearing 语义:隐藏 composer、压 spinner、通知、侧栏);`hooksService.loadHooks` 仅用于 Settings 静态持久 Trust 视图。snapshot 走 V4 协议,桌面/Web 远控天然同源,满足多端约束。

### D3. 按需开审核 flow:新命令 `requestWorkspaceHookReview`(shared + bootstrap)

- 命令 shape 克隆 `revokeWorkspaceHookTrust` 的 non-flow target 变体(`sessionId + workspaceIdentity + bundleDigest`,无 interactionId)。
- Handler → controller 现成的 `openReviewFlowForNewPendingItems(getCurrentSnapshot())`;已有活跃 flow 时复用(`openOrReuseFlow` 幂等)。
- **必须走 `superviseFlow`**——否则重蹈"撤销后面板永久失效"UAT bug(见 `workspace-hook-review-supervisor.ts` 头注)。
- flow deadline 只使 immutable request 过期并发送 `ReviewSettled(timed_out)`；不创建 Trust、
  不写负向决定，也不清除 admission pending。用户可从提示条重新请求新 generation。

### D4. UI:常驻提示条 + Hooks 行内信任(packages/ui)

- 新组件 `WorkspaceHookPendingBanner`,置于 `SessionPane` 的 `conversationBottomDock`(`ConversationQuotaBanner` 同级,composer 之上),样式/结构仿 `PendingCommandRecoveryBanner`(`role="status"`、border/bg-surface、主操作+忽略)。
- 显示条件:`snapshot.workspaceHookAdmission?.pendingCount > 0` 且未被忽略。
- 文案(zh/en 双侧,i18n key `chat.workspaceHookPending.*`,缺 key 校验仿 `workspaceHookTrustState.test.ts` 的 parity 断言):
  - 正文:"N 个工作区 Hook 待审核,本会话暂未启用" / "N workspace hooks pending review; disabled for this session"
  - 主按钮:"去审核" / "Review";次按钮:"忽略" / "Dismiss"
- [去审核] = `setPendingSettingsSectionIntent("hooks")` + `openSettingsTab()` + 经 `findWorkspaceHookCommandBinding`(该通道正是为无 pending-review 时保留命令通道而设,当前无 caller)发送 `requestWorkspaceHookReview`。
- [忽略] = renderer 本地 dismiss,key 为 `sessionId + bundleDigest`;bundle 变化(hook 内容变更)后提示条重新出现。不落盘。
- 删除 `V4InteractionDialogs.tsx` 的强制跳转(`presentedWorkspaceHookReviewInteractions` Set + `setPendingSettingsSectionIntent/openSettingsTab`);保留 store connect/upsert/clear(面板数据通路)与"不降级为通用对话框"守卫。
- `chatLoadingVisibility.ts`:`workspaceHookReview` 不再是 chat-loading blocker(对应测试断言反转)。
- `SessionPane` 的 `blockingInteractionId` 推导必须排除 `workspaceHookReview`,否则用户点开审核面板时 composer 与提示条会被 `display:none`。
- 删除 `WorkspaceHookReviewPanel` 与 Hooks 行内 configured/trust/effective 三组徽章。
- 未信任 workspace Hook 只在最右侧配置开关左边显示一个 outline `信任` 按钮；点击成功后刷新持久 Trust 快照，按钮消失。已信任行不显示额外状态或撤销入口。
- 遵守 `DESIGN.md`(颜色/圆角/主题/国际化)与多端约束(banner 数据源是 V4 snapshot,web-remote 同样生效)。

### D5. SessionStart 不补跑(core)

- 第一次真实 SessionStart 到达时，未信任声明被跳过，该事件即结束。
- 后续 prompt 不得把已结束的 SessionStart 伪装成 catch-up 再执行。
- 当前 task 中建立的 Trust 只影响后续自然事件；SessionStart 最早在下一新 task/session 生效。
- 删除 skipped digest、revision-at-skip 与 catch-up filter 状态，避免信任动作反向触发历史代码执行。

### D6. 协议层删除清单(bootstrap)

parked turn 消失后,以下机制整体退役(近期 deadlock/超时监管 bug 的高发区):

| 位置                | 删除内容                                                                                                                                                                                                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt-turn.ts`    | review observer 全套(`workspaceHookReviewProgress`、deferred/waiters、`observeWorkspaceHookReview` 等)、early-ACK 分支(`requestAuthority: "workspace_hook_review"`)、`monitorTurnStartedAfterWorkspaceHookReview`、`admittableHookTimeoutMs` 延时、`WORKSPACE_HOOK_REVIEW_SETTLE_GRACE_MS`、相关类型与头注双权威条款 |
| `prompt-turn.ts`    | `observeAcknowledgedPromptInputFailure`(review-only,3 个 call site 一并清理)                                                                                                                                                                                                                                         |
| `handlers/queue.ts` | `finalizeReviewedQueuePromotion` review 分支(确认无其他 caller 后删)                                                                                                                                                                                                                                                 |

保留:review flow/controller/supervisor(按需生成 immutable 操作快照)、`WorkspaceHookReviewRequested/Settled/Superseded` 事件与投影。删除独立 panel、once/user-block 分支；flow timeout 只使快照过期。

### D7. 兼容性

- snapshot 字段 additive + default → 旧 client 解析不受影响。
- `requestWorkspaceHookReview` 仅由新 UI 发送,桌面端 server 与 UI 同版本捆绑,无需新增 capability 协商;`workspaceHookReview` capability 保持原样。
- headless CLI 行为不变(本来就是 skip + 诊断);desktop 与其语义合流。
- web-remote:提示条数据源为 V4 snapshot,replayable 链路天然携带;不触碰 stream/queue/blocking request 语义。

## 4. 测试计划(先写测试)

- **core**:admission skip 语义(pending → 不等待、port 上报 pendingCount);SessionStart 在 Trust 变化后也不补跑——回归测试。
- **shared**:snapshot 字段 default 解析;`requestWorkspaceHookReview` schema。
- **bootstrap**:命令 handler(幂等复用 flow、必受 supervise);settle/toggle/revoke 后 `WorkspaceHookAdmissionUpdated` 重算;投影写入/清空 snapshot 字段;prompt-turn 不再 park(改写 `v4-native-commands.test.ts:968` 起五案、`v4-native-queue.test.ts` 三案为"直接 TurnStarted + AdmissionUpdated")。
- **ui**:banner 显隐/dismiss 幂等 key/去审核动作；Hook 行只在未信任且有匹配 generation 时显示“信任”，成功后刷新消失；旧 panel/状态徽章不渲染；i18n zh/en parity。
- 手册:`docs/testing/workspace-hook-trust-manual-acceptance.md` §1 重写为软门禁验收。

## 5. 明确不做(本期)

- 会话创建时(首个 prompt 之前)即推送 pendingCount——首次评估仍发生在 activate();提示条最早出现于第一条消息之后,与旧行为的拦截时点一致。
- 批量选择、全选和设置页内撤销入口。
- 区分"本地刚编辑的 hook"与"仓库带来的 hook"的差异化确认。
