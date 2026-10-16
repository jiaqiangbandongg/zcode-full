# Goal Manual Review Case Coverage

## 背景

Goal 相关 e2e 已覆盖一部分自动断言，但还有若干状态组合缺少可自动运行的人工验收入口。当前需求不是把这些组合全部做成强断言 e2e，而是先让用例能自动跑到可观察状态，并把 UI、队列、网络和运行态证据落到 artifact，供人工逐项验收。

## 范围

本次补齐非异常路径的 manual-review case：

- completed 无 goal 时设置 goal：观察 UI target、网络请求、运行态和持久化线索。
- completed 已有 goal 时更新 goal：观察目标替换是否只保留当前目标。
- running 无 goal / 已有 goal 时发送 `/goal`：观察只入队、不立即发请求，后续消费时更新目标。
- goal continuation 被 stop：观察 completed/interrupted 语义、无 paused、queue 保留且默认不自动消费。
- goal verification 阶段：观察 UI 不出现独立 validating 禁止态，并采集 compact/fork/edit 控件状态。
- queue 中多个 goal、普通文本、`/compact` 混合：观察顺序、goal kind、编辑、删除、重排和“立即引导”消费。
- manual / auto compact 与 queued goal 组合：观察成功、stop、失败未触发时的当前状态；失败路径不强制通过断言。
- fork/edit/session 切换组合：观察 goal running 时控件禁用、完成后控件恢复、编辑旧 query 后目标语义、session 切换后 goal/queue/模型不串。

本次明确不覆盖异常路径：429、503、SSE 中断、sidecar 失败、断网、磁盘满。

## 实现策略

- 扩展 `packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-goal-run-cases.test.ts`。
- 保持 `ZCODE_E2E_MANUAL_REVIEW=1` 与 capture 模式入口，继续生成每个 step 的 screenshot、chat root、queue、messages、tool blocks、network summary。
- 对不稳定或需要真实失败注入的场景采用“observe but do not fail”策略：等待短窗口，若未观察到目标状态，则把未观察到的状态写入 artifact，case 继续运行。
- 增强 manual review summary 的请求摘要，展示最近模型请求是否包含 `/goal`、goal marker 和 compact sentinel，辅助人工判断协议层是否把 `/goal` 当普通 user message 透传。

## 验收方式

运行 manual-review spec 后，人工查看 `manual-review/goal-run-cases/<case>/summary.md`：

- `chat.targetObjective` / `chat.targetStatus` 是否符合当前 case。
- `queue` 的 `kind` 与顺序是否符合预期。
- `network.recentModelRequests` 中 goal 请求是否符合协议预期。
- `messages` 是否隐藏 goal continuation/system reminder。
- `details` 中控件状态、store 快照、compact marker 是否符合产品定义。
