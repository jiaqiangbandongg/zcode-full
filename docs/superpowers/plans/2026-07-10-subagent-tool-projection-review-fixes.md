# Subagent Child Tool Projection Post-Commit 修复计划

## 目标

在不改变现有 background subagent、desktop continuous、web remote replayable 行为边界的前提下，修复 `0771f6312` post-commit review 发现的 child tool 投影问题：

- running snapshot 不得把 live terminal tool 降级回 running；
- tool identity/input 的完整元数据不得随 parent turn parser cache 一起清空；
- 前台订阅切换 task 时不得复用上一 task 的 projection memory；
- BG21 必须确定性证明 child tool 在 session 隐藏期间完成；
- 清理确认无调用的 missing-update 兼容分支。

本计划只做上述收口，不扩展 restart/resume 持久化协议，也不改 background runtime 生命周期。

## Phase 1：Running Snapshot 单调合并

- [x] 在 `zcodeChatMessages.test.ts` 增加“live terminal + stale running snapshot”失败测试。
- [x] 确认测试在实现前失败。
- [x] 将 tool status 合并改为单调状态合并，并复用统一 display identity 合并。
- [x] 运行 `zcodeChatMessages.test.ts`，确认新增和现有测试通过。

通过标准：已 terminal 的 child tool 不会被 running snapshot 复活；snapshot terminal 仍可收口 live running。

## Phase 2：Projection Metadata 生命周期

- [x] 在 UI projection 测试中覆盖 scheduled -> parent turn completed -> terminal result。
- [x] 在 UI projection 测试中覆盖 scheduled -> started/progress 仍携带 input/description。
- [x] 在 services replayable projection 测试中覆盖同样的跨 parent turn 场景。
- [x] 确认新增测试在实现前失败。
- [x] 将流式 JSON parser state 与 task-scoped complete tool metadata 分离。
- [x] UI 与 services 共同复用 shared metadata helper；所有 update 分支统一携带 remembered input。
- [x] 运行 UI/services focused tests。

通过标准：parent turn 结束只清 parser state，不会丢 background child tool 的 name/input；desktop continuous 与 replayable 恢复保持一致。

## Phase 3：Task 级状态隔离

- [x] 增加 task A -> task B 切换不继承 projection memory 的测试。
- [x] 确认测试在实现前失败。
- [x] 前台订阅启动时显式采用目标 task 的 hidden projection state，或创建全新 state。
- [x] 运行相关 hook/projection focused tests。

通过标准：重复 tool id 不会跨 task 继承 name/input；切回仍运行的 background task 可以继续接管其自身 hidden state。

## Phase 4：死代码清理

- [x] 用引用检查确认 `patch-existing-only` 无调用方。
- [x] 删除未使用 union member 与分支。
- [x] 删除 complete input 迁移后遗留的 streaming parser 死字段。
- [x] 运行 message merge focused tests。

通过标准：行为不变，missing tool update 模式只保留实际使用的语义。

## Phase 5：BG21 确定性 E2E

- [x] 将 BG21 child Bash 改为 sentinel/barrier 控制。
- [x] child tool 已 running 后切走 session；确认隐藏后才释放 sentinel。
- [x] 切回后断言 tool 仍在原 Agent 下、terminal、identity/input/output 完整且无重复孤儿卡。
- [x] 更新 case catalog、coverage matrix 与 fixture manifest 描述。
- [x] 运行 fixture check、coverage audit、BG21/BG22。

通过标准：测试不再依赖固定 sleep 猜测时序，能真实覆盖隐藏期间 terminal update 与切回仍 running 两种路径。

## Phase 6：提交前验证

- [x] 运行所有相关 unit tests。
- [x] 运行 `pnpm typecheck`。
- [x] 运行 `pnpm lint`。
- [x] 运行 desktop E2E typecheck。
- [x] 运行 BG21/BG22 与 background focused E2E。
- [x] 回扫 diff、依赖方与 desktop/replayable 边界。
- [x] 确认工作区改动未自动提交。

## Phase 7：Post-Review 竞态收口

- [x] 增加强制进入 running snapshot replace 路径的回归测试，证明旧流式 snapshot 不会覆盖较新的 live input/raw。
- [x] backfill 与 running replace 共用同一套 snapshot tool input/raw 选择规则。
- [x] terminal tool result/error 同步清理 streaming parser、complete input 与 tool name memory。
- [x] 运行 6 个 projection/runtime focused test 文件，共 319 个测试通过。
- [x] 运行 `pnpm typecheck`、`pnpm lint` 与 desktop E2E typecheck。
- [x] 运行 BG21、BG22 与 ExitPlanMode session-switch E2E。

通过标准：snapshot 与 live streaming 并发时 input/raw 不倒退；finalized snapshot 仍能补全空预览；terminal child tool 不残留 parser state。

## Phase 8：Projection 等价重构与 E2E 转正收尾

- [x] 运行重构前 focused tests，确认 ExitPlanMode、running snapshot、UI/services projection 基线通过。
- [x] 将 tool projection memory 的标准初始化收敛到 shared factory，保留 partial state 的 lazy ensure 兼容边界。
- [x] 将 complete input 落盘与 streaming raw buffer 释放收敛到 shared lifecycle helper。
- [x] 删除 snapshot input/raw 选择中的重复 raw-kind 解析，并让普通 merge 与 running replace 共用单调 status 选择 helper。
- [x] 运行 focused tests，确认纯重构前后行为一致。
- [x] 重新 review UI、services、hidden monitor、ExitPlanMode 与 background control 依赖链。
- [x] 确认 BG21/BG22 位于正式 E2E 路径、无 skip/only，并同步 catalog、matrix、fixture contract。
- [x] 运行 fixture check、coverage audit、BG21/BG22、ExitPlanMode E2E、typecheck、lint 与 diff check。
- [x] 验证完成后按 Conventional Commits 提交，不自动 push。

通过标准：三处重复逻辑收敛后 provider/runtime/UI 行为不变；ExitPlanMode 仍可从 finalized snapshot 补齐参数；background child tool 与右上角 control 的恢复/终态行为保持通过；正式 E2E 和仓库门禁全部通过。
