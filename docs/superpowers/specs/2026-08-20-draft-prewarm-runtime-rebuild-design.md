# 草稿预热会话在 runtime 换代后的重建

- 日期：2026-08-20
- 分支：`fix/draft-prewarm-runtime-rebuild`（基于 `feat/cua-merge-0819`）
- 状态：设计已确认，待实施

## 背景

用户报了两个现象，根因诊断确认它们是同一条链的两端：

1. **图片无法上传**（dev）——附件加进输入框后静止，只能移除；日志中没有任何 `attachmentBeginV4`。
2. **传完、电脑控制变绿后发不出去**（生产）——图片上传成功后点发送失败。

### 根因

CUA Helper 就绪会触发 agent runtime 无条件回收（`packages/services/src/node.ts:1094-1102` 的设计注释说明这是为了回收拿到 `BROKER_UNAVAILABLE` 的 stranded agent）。回收把 generation 1 里刚建立、尚未持久化的会话一并冲掉：

```
10:42:46.139  attachmentCommitV4 OK                     图片上传完成（gen1）
10:42:46.340  cua helper ready pid=33314                「电脑控制变绿」
10:42:46.991  agent process exited pid=33308            回收 stranded agent
10:42:49.531  agent process started runtimeGeneration=2 新 runtime
10:42:50.091  attachmentBeginV4 FAIL  sessionNotFound: sess_e0b036a8
10:42:50.129  subscribeConversationV4 FAIL  sessionNotFound: sess_e0b036a8
```

草稿态的 `effectiveSessionId = sessionId ?? prewarmSessionId`（`SessionPane.tsx:1487`），`sessionId === null` 时完全依赖预热会话。预热会话消失后：

- `SessionPane.tsx:1637` 在订阅报错时调 `prewarmBinding.discard()`；
- `discard()` 会设 `blockedInvalidationVersion = current.invalidationVersion`（`useDraftSessionPrewarm.ts:354`）；
- `reconcile()` 在 `blockedInvalidationVersion === requestedVersion` 时直接 return（`:313-315`），**同版本不再重建**；
- 于是 `prewarmSessionId` 永久为 null，附件卡在 `waitingSession`，即现象 1。

冷启动时 `createSession` 因 `ZCode Protocol client disposed` 失败（`useDraftSessionPrewarm.ts:139-144` 只 warn、无重试）会到达同样的终态。

## 方案选择

已在讨论中确认：**容忍回收、事后补偿**，而不是在 services 侧避免回收。

理由：不改动 services 层的回收语义（那是本分支为修复「CUA 工具永远载入不了」而刻意引入的），风险集中在 renderer；代价是用户会看到一次短暂的重传。

被否决/推迟的替代方案：
- 在回收侧区分触发源（`onHelperHealthy` 冷启动首次就绪 vs `onHelperCredentialsRotated`），使正在服务的 workspace 不被回收；
- 给 `ZCodeAgentService` 补活跃 turn 查询，把 `hasActiveTurnRef`（`node.ts:1467` 现为 `() => false`）真正接上。

这两条与本方案不冲突，可后续单独推进。

**回收触发源不止一个**，这是选择「事后补偿」而非「回收侧堵」的关键依据。除冷启动首次 ready 外，liveness watchdog 的恢复路径同样会回收。2026-08-20 12:26 的 dev 日志：

```
12:26:43.617  cua helper liveness: Helper unreachable (attempt 3); triggering resolver recovery
12:26:44.980  cua helper ready pid=97629
12:26:45.489  ZCode agent cleanup ... reason='workspace-dispose'
              runtimeIdentity: /Users/dev/.zcode/workspace/default:4:57273
```

helper ready 后 509ms 触发回收，且该 workspace 已到 generation 4。若改从回收侧堵，需同时覆盖 `onHelperHealthy`、`onHelperCredentialsRotated` 与 liveness 恢复三条路径，改动面显著大于 renderer 侧补偿。

## 目标

- runtime 换代后，草稿态能自动拿到在新 runtime 中有效的预热会话。
- 换代期间禁止发送；重建成功或超时后解除。
- 附件在换代后自动重传到新会话，不需要用户手工重来。

## 非目标

- 不修改 services 侧的回收语义，不触碰 `hasActiveTurn`。
- 不处理正式会话态（`sessionId !== null`）的恢复——那条路径由 CLI 的 `cold-session-resume.ts` 负责。
- 不改 `useDraftSessionPrewarm` 的对外接口。

## 设计

### 1. 触发与重建链路

复用现成通路，不新建订阅：

```
transport.onRuntimeRestart                         SessionPane props:446，已按 workspaceKey 过滤
  → 新增 effect（仅 sessionId === null）
  → invalidateDraftRuntime(workspacePath, workspaceIdentity)    已存在：zcodeSessionStoreWorkspaceSlice.ts:408
  → draftRuntimeInvalidationVersion + 1
  → reconcile()：清 blockedInvalidationVersion → retireCurrent → startCurrent
  → onReady → 新 binding → prewarmSessionId → effectiveSessionId
```

**本节**的新增代码只有 SessionPane 里的那个 effect（门禁与附件改动见第 2、3、4 节）。重建、清闸、单飞、旧会话清理都是 coordinator 中已有的逻辑：

- `reconcile()` 在 `requestedVersion` 变化时清掉 `blockedInvalidationVersion`（`useDraftSessionPrewarm.ts:297-302`），解除 `discard()` 设下的永久闸；
- `retireCurrent()` → `controller.dispose()`，而 `dispose()` 只在 `promotionState === "draft"` 时才 `deleteSession`（`:169`）。**发送进行中（`pending`）遇到换代不会误删正在跑的会话**，这个保护已存在。

**正式会话态不触发**：`sessionId !== null` 时不调 `invalidateDraftRuntime`。

### 2. 发送门禁

在 SessionPane 内维护 `draftRebuilding` 状态，不改 hook 接口（`binding === null` 无法区分「重建中」与「永久回落」，但 SessionPane 知道 invalidate 是不是它自己触发的）。

- invalidate 时置 `true`；
- 新 `prewarmBinding` 到达置 `false`；
- **超时 5s** 后置 `false`，回落到既有的「发送时创建正式 session」路径（`SessionPane.tsx:1829` / `:1886` 的 `beginPromotion` 分支）；
- 重建中再次换代 → 重置计时器；
- 接入 `SessionPane.tsx:3494` 的 `disabled` 计算；
- 配一句提示文案，避免按钮无声置灰。

超时值依据：实测 agent `start → ready` 约 550-650ms，`createSession` 再数百 ms，5s 有充分余量且不至于让用户久等。

**不允许永久禁用**：重建失败必须回落，否则 runtime 持续异常时用户无法发送任何消息。

超时与重建成功并非互斥：超时解除禁用后，迟到的 `prewarmBinding` 仍会正常到达并更新 `effectiveSessionId`，附件随之被唤醒重传。超时只解除门禁，不取消重建。

### 3. 附件重传的竞态

换代时有两条链同时动附件：

- `useComposerAttachments.ts:461` 的 `onRuntimeRestart` 回调——清 ref、`autoRetryCount + 1`、按 `target.sessionId` 入队；
- `:441` 的 effect——`attachmentSessionId` 变为真值时把 `waitingSession` 重新入队。

问题在于 `:461` 读的是 `targetsRef.current`，那是**渲染期写入的旧值**（`:192-199`）。换代事件到达时它仍持有已失效的 sessionId，于是拿旧 id 入队——这正是日志里那次 `sessionNotFound` 的成因。

解耦两条链：

- `:461` 不再依据 `target.sessionId` 决定入队，**一律置 `waitingSession`**（换代后旧 id 必然失效），由 `:441` 统一唤醒；
- 新增 `restartEpoch`（hook 内部 state，`onRuntimeRestart` 回调中递增），加入 `:441` effect 的依赖，换代后强制重扫 `waitingSession` 并入队。

`restartEpoch` 是必需的：正式会话态 runtime 重启后 `attachmentSessionId` 不变，仅依赖它的 effect 不会重跑，附件会永久停在 `waitingSession`。

不受影响的两类附件（`:470-476` 已跳过）：
- `localZeroCopy`（本地文件拖入，`ref` 直接是本地路径，从不上传）——这解释了为什么问题集中在粘贴/截图的图片上，它们没有 `localPath`；
- `referenceOwnership === "session"`（已随消息发出）。

### 4. 重传配额

`:481` 现为 `autoRetryCount >= 1` 即判 `failed`。换代重传不是「重试失败的上传」而是「换了会话重新传」，用同一个计数器会让换代烧掉用户可见的上传重试配额。

**改为两个计数器分开计：**

- `autoRetryCount` 保留原语义（上传本身失败的自动重试），上限维持 1，不动；
- 新增 `runtimeRebuildRetryCount`，仅在草稿态因换代触发重传时递增，上限 5。

不合并计数器的原因是换代次数比最初估计的多：2026-08-20 12:26 的 dev 日志中同一 workspace 已到 `runtimeGeneration=4`（3 次换代），且回收触发源不止一个（见「方案选择」），单一计数器上限 3 会在正常使用中被耗尽并误报失败。

用 `restartEpoch` 去重，保证**同一次换代只触发一次重传**；上限 5 只作为 helper 反复崩溃时的兜底。

### 5. 测试

| 层 | 用例 |
| --- | --- |
| coordinator | `invalidationVersion` 递增时 retire + 重建；`blockedInvalidationVersion` 被清除 |
| controller | `dispose()` 在 `pending` 态不删会话（回归保护） |
| attachments | 换代后置 `waitingSession`；新 sessionId 到达后入队；正式态 sessionId 不变时也能被 `restartEpoch` 唤醒 |
| attachments | 同一 `restartEpoch` 内不重复重传；`runtimeRebuildRetryCount` 达 5 才判 `failed`，且不影响 `autoRetryCount` |
| 门禁 | 重建中禁用；新 binding 到达解除；超时解除并回落 |

两个本地已知坑：

- 超时计时器若 `unref`，缺陷会被 vitest runner 掩盖（runner 自身保活事件循环）；需要 tsx 子进程探针验证，不能只靠单测。
- desktop 侧 `test/*.test.ts` 不在任何 tsconfig 归属内，根 `pnpm typecheck` 覆盖不到；改动涉及 desktop 时需单独核验。

## 边界与失败模式

| 情况 | 行为 |
| --- | --- |
| 重建期间再次换代 | `invalidationVersion` 再 +1，reconcile 重新 retire + 建；门禁计时器重置 |
| 发送进行中换代 | `promotionState === "pending"`，`dispose()` 不删会话；正式 session 由 cold-resume 负责 |
| 切换 workspace | `invalidateDraftRuntime` 按 `workspacePath` / `workspaceIdentity` 定向，不影响其他 workspace |
| 重建失败 / 超时 | 解除禁用，回落无预热发送路径；附件保持 `waitingSession` 直到下次有有效 session |
| 旧会话清理失败 | 无碍——旧 session 已随 runtime 消失，`deleteCreatedSession` 的 catch 已忽略失败 |

## 风险

- **重传可见性**：用户会看到附件进度条回到 0 并重传一次。属预期行为，需确保文案（`chat.attachments.upload.runtimeRestarted`）读起来不像错误。
- **门禁误报**：若 `onRuntimeRestart` 在非草稿态误触发，会无谓禁用发送 5s。effect 内以 `sessionId === null` 收紧，并在测试中覆盖。
- **本方案不消除回收本身**：CUA Helper 冷启动仍会回收 agent，用户仍会经历一次会话换代。彻底消除需要前述被推迟的两条替代方案之一。
