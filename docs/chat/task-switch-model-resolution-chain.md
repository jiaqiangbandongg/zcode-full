# Task 切换后的当前模型判定链路

更新日期：2026-07-17

V4 中 task/session 切换是 pane 绑定和 topic 订阅切换。当前模型不再由 renderer 从 task meta、消息历史和
workspace 默认值多级猜测；`ConversationSnapshot.config` 是已绑定 session 的唯一展示权威。

## 切换与订阅

```text
侧栏 sessions-index summary
  -> pane 绑定 sessionId
  -> subscribe conversation/<sessionId>
  -> initial snapshot（或 replayable recovery snapshot）
  -> ConversationProjectionStore 原子替换
  -> SessionPane / V4ComposerToolbar 读取 snapshot.config
```

- `sessions-index` 只提供列表摘要、phase、轻量 interaction 计数等，不提供完整 conversation config。
- conversation snapshot 包含 rows、phase、config、inputRouting、actions 和 control；UI 不从旧 session 的
  store 缓存拼出新 session 首帧。
- snapshot 按 subscription/generation/seq 校验。gap 触发 recovery；恢复期间迟到 online 帧不能覆盖新
  snapshot。
- desktop 使用 online continuous 帧，手机远控使用 replayable recovery；两者终态 snapshot 相同。

## 模型显示与恢复

snapshot 到达前 toolbar 处于未就绪状态，不用 workspace 默认模型冒充历史 session 模型。到达后：

1. `snapshot.config.provider/model/thought` 决定当前展示。
2. workspace `configOptions` 只提供可选目录和 provider 元数据。
3. UI 不根据模型是否“仍可见”写回 session；entitlement loading、菜单过滤与排序只影响目录展示。
4. 如果当前模型已被 Agent workspace registry 删除，Agent 在 idle 或下一 turn admission 的安全边界按
   `default → last-used → catalog first` 选择 fallback，并用 `ModelSelected` 原子投影模型、实际 thought
   和 thoughtLevels。
5. snapshot 到达前后都不允许 renderer 发送菜单首项作为自动切换；用户显式选择只走一次
   `switchModelConfig`，由 revision/CAS 与 Agent projection 收口。

冷恢复时 CLI 由持久 message/part/session facts 重建 projection 和 runtime config。`rowId`、renderer
store 和 sessions-index summary 都不是模型持久权威。

## Workspace 与 session 的隔离

- 已存在 session：模型来自该 session runtime/projection。
- draft pane：模型来自草稿种子和 workspace default，直到 createSession 建立 session 权威。
- 切换 session 不把草稿 workspace 默认值写入历史 session。
- workspace 身份使用 `workspaceIdentity?.trim() || workspacePath`；远程恢复还必须保持
  `remoteSessionId`，禁止只按路径复用订阅、缓存或 provider registry。

## 再次打开的差异

再次打开可能命中本地 projection store 的 UI 缓存，从而更快显示，但订阅仍必须用 initial/recovery
snapshot 校准。CLI record 是否仍在内存只影响恢复成本，不改变模型来源；runtime epoch 变化后必须重新订阅，
不能把旧 projection 当作权威继续发送。

## 当前代码入口

- `packages/ui/src/v4/SessionPane.tsx`
- `packages/ui/src/v4/conversationProjectionStore.ts`
- `packages/ui/src/v4/agentConversationTransport.ts`
- `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts`
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-catalog.ts`
