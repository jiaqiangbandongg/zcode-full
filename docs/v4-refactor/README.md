# V4 会话架构：当前状态与文档导航

更新日期：2026-07-15

V4 conversation 主链路已经落地：CLI 维护 canonical facts、command inbox 和 product projection；
Host/relay 转发连接与 topic；renderer/web 订阅 projection、发送 command，并只保留局部 UI 状态。

本目录混合了两类文档：

- 当前规格：schema、恢复、fault、sessions-index 等仍约束现行代码；
- 实施轨迹：phasing、review、deletion/parity 记录迁移依据，正文中的 legacy 路径、行数和“待实现”
  只代表当时状态。

产品语义优先读 [Conversation Product Protocol](../conversation-product-protocol.md)，系统总览优先读
[ZCode Protocol](../zcode-protocol.md) 与 [Message Flow](../architecture/message-flow.md)。

## 当前拓扑

```text
Electron / Web / mobile remote
  |-- SessionPane + read-only projection stores
  |-- command(commandId, clientId, baseRevision, payload)
  `-- local draft / scroll / focus / optimistic overlay
          |
          | @zcode/rpc MessagePort / remote attachment
          v
Host connection scope
  |-- trusted clientMode / connectionId
  |-- owned topic subscription routing
  |-- runtime generation / stale subscription cleanup
  `-- no conversation reducer or second queue
          |
          | @zcode/shared/zcode-protocol-v4 over stdio
          v
ZCode CLI
  |-- transcript + session metadata + goal facts
  |-- V4 command inbox / durable input admission
  |-- ProductProjection + SessionsIndexProjection
  |-- topic publisher: snapshot / delta / seq / logEpoch
  `-- runtime config, queue, interaction and active/background work
```

手机 `/remote` 通过 shared-host attachment 连接桌面已存在、承载目标 workspace scope 的 Local/Remote Host。relay 和
desktop main 只做鉴权、配对、心跳与 frame/app payload 透传，不拥有 session、queue、snapshot 或
projection。

## 当前不变量

- conversation UI 按 projection rows 渲染，不从 flat message 数组重新推导 turn、timeline、endedness
  或 action availability。
- command 使用 `commandId` 幂等身份和可选 `baseRevision`；ACK 与后续 projection 分工明确。
- 每个 attachment/subscription 有独立 ownership、generation、seq 和 recovery；下行帧只投递 owner port。
- desktop 是 continuous online delivery；mobile remote 是 replayable recovery。两端共享 CLI 事实，
  但 recovery frame 不能扩散到桌面 online 主链路。
- snapshot 原子替换；delta 必须连续；gap/epoch 变化触发 resync，恢复在途时不能让迟到 online 帧覆盖。
- session queue 和 interaction pending state 位于 CLI；Host、relay、renderer 不建立第二份 accepted queue。
- identity/cache/topic 隔离使用 `workspaceIdentity?.trim() || workspacePath`；路径执行仍使用
  `workspacePath`，远程链路还要携带 `remoteSessionId`。
- `tasks-index` 拥有持久 task 行集合以及 pin/archive/group/unread 等组织态；`sessions-index` 只拥有
  列表活性与实时详情摘要，客户端以 task row 为左表做字段级 join。

## 当前代码入口

| 层 | 入口 |
| --- | --- |
| V4 schema | `packages/shared/src/zcode-protocol-v4/` |
| UI transport/store | `packages/ui/src/v4/agentConversationTransport.ts`、`conversationProjectionStore.ts`、`sessionDataLayer.ts` |
| UI pane/commands | `packages/ui/src/v4/SessionPane.tsx`、`ConversationComposer.tsx` |
| Host/service route | `packages/services/src/zcode-agent/zcodeAgentConnectionScope.ts`、`zcodeAgentService.ts` |
| CLI gateway | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts` |
| CLI projection | `product-projection.ts`、`sessions-index-projection.ts` |
| CLI commands | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/` |

## 文档索引

| 文档 | 当前角色 |
| --- | --- |
| [01-topology.md](./01-topology.md) | 拓扑和职责设计；结合当前总览读取 |
| [02-projection.md](./02-projection.md) | projection 设计与裁决依据 |
| [03-commands.md](./03-commands.md) | command/ACK/inbox 规格与未完成项 |
| [04-sync-and-recovery.md](./04-sync-and-recovery.md) | topic 订阅、seq、snapshot、recovery 约束 |
| [05-transport-and-backpressure.md](./05-transport-and-backpressure.md) | transport/wire/backpressure 规格 |
| [06-ui.md](./06-ui.md) | V4 UI 设计和实施轨迹 |
| [07-persistence.md](./07-persistence.md) | canonical facts、投影重建和迁移 |
| [08-phasing.md](./08-phasing.md) | 历史分期与清理轨迹，不是当前进度表 |
| [09-protocol-schema.md](./09-protocol-schema.md) | 早期 schema 设计；字段冲突时让位于代码与 10 |
| [10-protocol-spec.md](./10-protocol-spec.md) | V4 字段级主规格 |
| [11-deletion-plan.md](./11-deletion-plan.md) | 历史删除执行清单 |
| [12-fault-catalog.md](./12-fault-catalog.md) | fault/reason code 词表 |
| [13-golden-test-mapping.md](./13-golden-test-mapping.md) | case 到 reducer/protocol/WDIO 证据映射 |
| [14-sessions-index.md](./14-sessions-index.md) | sessions-index 当前规格和实现入口 |
| [design-review.md](./design-review.md) | 迁移前代码审计与风险轨迹 |
| [review-meeting-brief.md](./review-meeting-brief.md) | 评审历史输入，不是现状摘要 |
