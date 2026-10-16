# 模型链路当前审计

更新日期：2026-07-17

> **历史审计，已被 Provider Refactor 取代。** 本文记录的是迁移前的 App Provider Snapshot、
> `runtimeModel` fallback 和 workspace catalog 链路，不是当前实现。当前模型事实由目标 Environment
> 的 Effective Provider Config、Model Config Rules、Provider Registry 与 ModelFactory 共同产生；
> 当前设计见 `docs/working-memory/provider-refactor/design/`。

本文汇总以下四条当前链路，并记录仍然存在的复杂性和缺口：

- `docs/chat/task-switch-model-resolution-chain.md`
- `docs/chat/new-task-model-resolution-chain.md`
- `docs/chat/manual-model-switch-resolution-chain.md`
- `docs/chat/send-prompt-model-resolution-chain.md`

## 审计结论

V4 已经删除“UI task config、task meta、workspace 默认、session snapshot、runtimeModel cache 多级共同决定
当前模型”的旧主链路。当前边界可以归纳为三层：

```text
草稿偏好 / workspace provider registry
  -> createSession.config 或预热 session CAS
  -> CLI session runtime config（唯一写入权威）
  -> ModelSelected（用户切换与 registry fallback 共用）
  -> ConversationSnapshot.config（只读投影）
  -> V4 toolbar
```

已有 session 的模型权威在 CLI runtime；草稿偏好只决定新 session 初值；UI 目录只决定可选择什么。发送
不再携带独立模型，配置与发送通过同一 barrier 排序。

## 当前必须保留的复杂性

| 复杂性                          | 保留原因                                               | 边界                                                                                                 |
| ------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| workspace provider registry     | custom provider 凭据和模型元数据在 app/service 侧      | 按 workspace identity 和 remote session 同步                                                         |
| `runtimeModel` 一次性 fallback  | CLI registry 尚未看到新 provider 时安装 client overlay | 仅在 `provider.notInRegistry` 后重试一次                                                             |
| service `runtimeModel` 派生缓存 | provider header/capability 热刷新需要模型运行配置      | accepted/noop 后按 decision 顺序重建；duplicate 不写；Agent 校验 model+thought，不允许它承担切换意图 |
| draft prewarm                   | 避免首发临时建 session 和 workspace default 慢写       | deferred、内存态、未提升即清理                                                                       |
| draft global seed               | 新草稿延续用户上次选择                                 | 不能覆盖本草稿显式选择                                                                               |
| Agent registry fallback         | 历史 session 模型从 registry 移除后仍可续聊            | Agent 按 default、last-used、catalog first 决策并发布 projection；UI 不写                            |
| config command barrier          | 防止“切模型 → 立即发送”越序                            | 只线性化本 renderer admission，不承诺跨端全局 FIFO                                                   |

## 已删除的旧事实源

以下概念可能仍出现在 2026-06 的历史计划、测试迁移记录或兼容 adapter 中，但不再决定 V4 conversation
当前模型：

- `ChatInputToolbar` / `useToolbarModelChange` 的 active-task 分支；
- `useZCodeChatSendPrompt` 的 resume hint 解析；
- `taskConfigOptionsByTaskId` 作为 conversation config 权威；
- renderer-local busy prompt queue；
- `session/setModel`、`workspace/setDefaultModel` 作为 V4 会话写入口；
- 从消息最后一个 model 或 task meta 推导 toolbar 当前值。

`zcodeSessionStore` 仍服务 workspace shell、task list、未读、兼容服务投影和草稿目录，不等于它仍拥有 V4
conversation transcript 或 session config。

## 已验证的不变量

1. 已绑定 session 的 toolbar 值只能由 snapshot config 确认。
2. draft 显式选择优先于异步水合的全局种子。
3. `createSession.config` 在 `firstInput` 前应用；预热 session 首发前再次对齐。
4. 跨模型时不把源模型 thought 强写给目标模型。
5. 同值配置是 noop；stale revision 有界重试；provider registry 恢复只重试一次。
6. `sendText` 不携带第二份模型选择，queued input 也不固定入队时模型。
7. desktop continuous 与 mobile replayable 共享 session 事实，但保留不同 delivery/recovery 机制。
8. relay 和 desktop main 不保存模型、queue、snapshot 等 conversation 业务状态。
9. provider registry 失效后的自动 fallback 只由 Agent 决策；UI 模型菜单是目录投影，不按菜单首项写回会话。
10. 自动 fallback 与手动切换共用 `setModel → 实际 thought → ModelSelected`，模型、thought 和能力目录不能拆分发布。
11. create/resume/fork、legacy 写、V4 写、registry fallback 和 runtime refresh 共用同一个 session
    model-config 临界区；旧 runtimeModel 与当前 model/thought 不一致时只能被忽略，不能回写选型。

## 当前缺口

- context window switch guard 尚未迁回 V4；running session 目前允许直接切模型。
- `createSession.config` 应用失败采用“会话创建成功、配置降级 runtime 缺省”的语义；需要依赖 UI 屏障、日志和
  后续 snapshot 暴露偏差，不能把 accepted create 简化成“指定模型一定应用成功”。
- 多客户端同时配置同一 session 只依赖 revision/CAS 收口，没有“某客户端永久拥有模型选择”的产品语义。

## 审计入口

- `packages/ui/src/v4/SessionPane.tsx`
- `packages/ui/src/v4/composer/useDraftConfigControl.ts`
- `packages/ui/src/v4/composer/useDraftSessionPrewarm.ts`
- `packages/shared/src/zcode-protocol-v4/command.ts`
- `packages/shared/src/zcode-protocol-v4/snapshot.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/model-config.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/session-mgmt.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`
