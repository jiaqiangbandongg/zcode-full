# 04 — 桌面端登录门禁与远控生命周期联动

**What to build:** 未登录的桌面用户打开远控弹窗时看到"需要先登录"并有登录入口，main 不注册设备也不连接 relay；用户登录成功后 main 收到通知，若存在"上次已启用"目标且窗口 workspace 已同步则自动恢复远控；用户登出后远控立即停止并停在 `auth-required`；应用启动时若无 JWT，恢复流程停在 `auth-required` 等待登录。附一条桌面 E2E。

**Blocked by:** 03

**Status:** in-progress

**Parent:** [Web 远控接入 Relay V2：手机登录后连接桌面](./01-relay-v2-login-pairing.md)

## 验收标准

- [ ] 文档先行：`relay-v2-pairing.md` 补登录/登出与远控生命周期的时序图及 `auth-required` 语义；架构文档"桌面应用重启后的启用状态恢复"一节更新为需等待 JWT；列出 `auth-required` 状态的 zh-CN/en-US 文案表（标题、说明、登录按钮）供确认。
- [x] 远控状态新增 `auth-required` 呈现：弹窗显示"需要先登录"文案与登录入口（复用现有登录触发），不展示二维码；zh-CN 与 en-US 文案齐备。
- [x] 视觉核对：实现后提供弹窗 `auth-required` 状态截图（深浅主题 × zh-CN/en-US），由本票 E2E 顺带产出。
- [x] 新增 renderer→main 单向 IPC 登录状态通知（登录成功 / 登出），renderer 在 OAuth 会话变化时发送；协议使用严格类型与运行时 schema 校验。
- [x] main 收到"登录成功"：若存在已启用目标且该窗口 workspace 已同步，重试恢复；收到"登出"：停止当前 runtime、状态置 `auth-required`、不清除已启用记录。应用启动恢复时无 JWT → 保持 `auth-required` 等待通知，不另起 host、远程 session 或 Agent runtime。
- [x] 测试（manager 公开接口 + 假登录状态源）：无 JWT 拒绝启动且无任何 HTTP/WS 调用；登录通知触发恢复；登出通知停止并保留已启用记录；启动恢复在无 JWT 时等待。IPC schema 有拒绝非法字段的测试；弹窗 `auth-required` 状态有渲染测试。
- [ ] 桌面 E2E 一条：未登录状态打开远控弹窗显示需要登录，且 main 未发起注册或 relay 连接；按 E2E 工作流 skill 新增、验证并转正。
- [ ] `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、受影响单测与新增 E2E 通过。

## 实施与验证

- 已补登录生命周期时序、双语文案表、严格单向 IPC、manager 登录门禁/恢复，以及登录入口。远控 workspace 改为完整快照唯一入口；等待登录、磁盘读取期间关闭目标、远程占位缺 session、重复通知和迟到异步结果均有回归。
- 桌面 pending E2E 完整构建后 1/1 通过，远控 HTTP/WS 次数均为 0；深浅主题 × 中英文截图位于 `packages/desktop/.e2e-artifacts/desktop-e2e-20260919054022407-p76850-149c65ccfe5737d4/`。已请求人工确认，尚未转正。
- 全仓单测已运行：17,958 通过、1 失败、12 跳过。唯一失败为 `e2eRuntimePaths.test.ts` 检测到原有 `feedback/manual-review/pending/feedback-upload-privacy.test.ts` 的 `/tmp` 字面量；该文件与任务开始基线及 HEAD 内容一致，单独复跑仍失败。本票最终增量另跑 10 个文件、125 项相关测试全部通过。
- `pnpm typecheck`、`typecheck:e2e`、`pnpm lint`（60 个既有 warning、0 error）、`pnpm architecture:check --changed` 和 diff 空白检查通过；Standards/Spec 两路复核剩余发现均为 0。
- `e2e:fixture:check` 当前只支持 conversation-session/plugins，auth-config 路径不受支持；无模型请求 manifest 按本领域现有契约直接核验。
- 未修改用户已有 02/03 票改动。按项目规则，全仓单测未全绿且人工转正尚未完成，暂不自动 commit。手机与 Windows/Linux 未实测。
