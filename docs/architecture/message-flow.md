# Message Flow（当前事实）

## 主链路

```text
ConversationComposer / SessionPane
  │ createSession | sendText | other V4 command
  ▼
agentConversationTransport
  ▼
Host: sendConversationCommandV4
  ▼
workspaceKey 对应的 zcode-cli
  ├─ command inbox 裁决
  ├─ core 执行
  └─ ProductProjection 更新
       │ snapshot / delta
       ▼
SessionDataLayer
  ▼
ConversationProjectionStore
  ▼
ConversationTimeline / Composer / StatusPanel
```

UI 不调用旧 `sendPrompt()` 构造聊天状态，也不从 legacy task event 拼消息。`IZCodeTaskService` 仍可服务列表、元数据或过渡兼容面，但不是 V4 conversation 正文事实源。

## 输入时序

```text
UI          Host             CLI inbox        Core/Projection
 | command   |                  |                    |
 |---------->| forward          |                    |
 |           |----------------->| validate/CAS       |
 |           |<-----------------| ACK                |
 |<----------|                  |                    |
 |           |                  |----execute-------->|
 |           |                  |<---events----------|
 |<========== snapshot/delta from conversation topic |
```

ACK 与 projection 是两条不同语义：ACK 回答“命令是否被接纳/拒绝”，projection 回答“产品状态现在是什么”。UI 最终必须以后者收敛。

## 多端交付

- 桌面：`desktop-continuous`，直接订阅 live topic；断线后按 seq 恢复。
- 手机远控：`web-remote-replayable`，经 shared-host attachment 订阅同一 Host/CLI，并保留 gap/snapshot 恢复。
- relay 与 Electron main 只做鉴权、配对、心跳、frame 透传和 attachment 调度，不拥有 conversation 状态。

```text
mobile /remote
  -> relay
  -> Electron main
  -> existing Host attachment
  -> existing workspace CLI
```

## SSH Remote Source 路由

SSH remote workspace 由窗口唯一 Host 内的 registry 路由；Main 只转发连接控制请求和端口，不改变 V4 conversation 事实链：

```text
remoteSessionId A -- attachment A --┐
                                    ├-> Window Host / RemoteConnectionRegistry
remoteSessionId B -- attachment B --┘
                                    -> remoteHostKey 对应的 one SSH connection / zcode-server
                                    -> workspaceKey A/B 对应的独立 CLI/runtime
```

每个 attachment 都携带独立 `attachmentId` 和可信 `clientMode`。Renderer reload 只替换对应
desktop attachment；`DetachServicePort` 只释放一个逻辑 workspace 的 RPC/订阅，不销毁窗口 Host 或仍被使用的 SSH connection，
也不会把手机 replayable 恢复语义带入桌面 continuous 链路。

## 关键入口

| 层                  | 当前入口                                                                   |
| ------------------- | -------------------------------------------------------------------------- |
| UI pane             | `packages/ui/src/v4/SessionPane.tsx`                                       |
| UI transport        | `packages/ui/src/v4/agentConversationTransport.ts`                         |
| UI projection       | `packages/ui/src/v4/sessionDataLayer.ts`、`packages/ui/src/v4/conversationProjectionStore.ts` |
| Host service        | `packages/services/src/zcode-agent/zcodeAgentService.ts`                   |
| V4 schema           | `packages/shared/src/zcode-protocol-v4/`                                   |
| CLI gateway/reducer | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/`                 |
| Desktop host        | `packages/desktop/src/host/index.ts`                                       |
