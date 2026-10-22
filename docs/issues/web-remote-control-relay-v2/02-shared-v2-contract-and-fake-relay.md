# 02 — Relay V2 共享契约与假 relay 测试夹具

**What to build:** 在不改变任何现有 V1 行为的前提下（expand 阶段），为桌面与手机两端提供 Relay V2 的共享契约：V2 relay 消息类型与运行时校验、设备注册/列表/删除与一次性 token 的 HTTP 契约类型、支持无 `hash` 的二维码 URL 构建与解析、V2 心跳常量；以及一个两端测试共用的进程内假 relay V2。完成后，任何一端都能在不依赖线上环境的情况下针对 V2 握手、心跳、错误码和 HTTP 失败编写并运行测试。

**Blocked by:** None — can start immediately.

**Status:** in-progress

**Parent:** [Web 远控接入 Relay V2：手机登录后连接桌面](./01-relay-v2-login-pairing.md)

## 验收标准

- [x] 文档先行：新建 `docs/web-remote-control/relay-v2-pairing.md` 骨架，写入 V2 WebSocket 消息契约（`auth_init` 无 `role`、`pair_status_query` 无 `device_sid`、`client_ts` 为 Unix 秒）、HTTP 契约（设备注册/列表/删除、`role=device|terminal` 一次性 token）与假 relay 的能力边界。
- [x] shared 新增 V2 出入站 relay 消息类型、HTTP 请求/响应类型及对应的运行时解析函数；解析拒绝非法字段。V1 类型与解析保持不动，现有 shared 测试全部通过。
- [x] 二维码 URL 构建器支持不带 `passHash`/`timestamp` 的 V2 形态；解析器接受 `sid`、`mid`、`name`、`app_version` 全部可选且无 `hash` 的 URL。V1 带 `hash` 的解析结果不变。
- [x] 心跳常量新增 V2 组：基准 5 秒、jitter ±1 秒、ACK deadline 15 秒；V1 常量保留。
- [x] 假 relay V2 夹具：进程内同时提供设备注册/列表/删除与 token 签发的 HTTP 处理器，以及 `/api/v1/remote/ws2?token=` WebSocket 服务器。token 一次性、绑定 `role` 与用户；`auth_init` 校验设备归属，非本用户设备返回 `AUTH_FAILED`；同角色新连接替换旧连接并向旧连接发送 `KICKED`；`data` 在配对双方间透传并替换 `client_ts` 为 `server_ts`。
- [x] 假 relay 可编排：`auth_ack`/`pair_status_ack` 的 `pair_status`、任意错误码（`AUTH_FAILED`/`WRONG_PARAM`/`KICKED`/`INTERNAL`/`DEVICE_OFFLINE`）、服务端主动断连、HTTP 401/5xx/网络错误；记录收到的每条消息与每次 HTTP 调用供断言。既能服务 Node `ws` 客户端，也能服务浏览器 WebSocket 兼容客户端。
- [x] 假 relay 自身有测试证明上述行为与 V2 文档一致。夹具放在桌面与手机测试都能导入的位置，具体位置在实现时决定并写入 `relay-v2-pairing.md`。
- [ ] `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、受影响单测通过。

## Comments

2026-09-19：功能实现完成，验证门禁仍有基线/环境阻塞，状态保留 `in-progress`，未提交。

- 契约依据与夹具 API 见 [Relay V2 配对契约](../../web-remote-control/relay-v2-pairing.md)。shared 独立 V2 消息/HTTP 解析、显式 V2 二维码解析、V2 心跳常量及共用假 relay 已实现，V1 默认行为保留。
- `pnpm typecheck`、`pnpm lint`（0 errors，60 个既有 warnings）、`pnpm architecture:check --changed` 通过；最终共享包及桌面/手机既有 transport 回归为 133 文件、1,504 测试通过。
- implement 要求的全量 `pnpm test:unit` 已执行：1,914 文件通过、4 文件失败、2 文件跳过；17,943 测试通过。定向复跑后 CUA staging、TTFT 超时及 teardown 错误未再出现，仍失败的是 `e2eRuntimePaths.test.ts`（既有 `feedback-upload-privacy.test.ts:105` 使用 `/private/tmp`）和 `storagePreparationProtocol.test.ts`（`@zcode/adapters/storage` 导出的本地 dist 缺少源码已有的 `SqliteSessionStore.openStartup`）。相关源码相对任务开始基线无改动；未混入与本票无关的修复。
- code-review 双轴评审：Standards 无发现；Spec 发现的删除 HTTP 状态/业务码差异已修复并复核关闭。全量门禁未通过，遵循根规则保留改动，不自动 commit。
