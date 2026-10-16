# Anthropic 请求设备与会话 Metadata

## 状态

- 本文是 zcode-cli Anthropic 模型请求 `metadata.user_id` 的事实规范。
- 设备身份沿用 `{dataBaseDir}/.zcode/v2/telemetry-state.json` 的 `deviceMid`。
- metadata 的拼装与注入只发生在 zcode-cli，不修改 Desktop、Host、Web 或 app-agent 协议。

## 请求契约

所有由 zcode-cli AI SDK adapter 发出的 Anthropic 格式请求都必须携带：

```json
{
  "metadata": {
    "user_id": "{\"device_id\":\"7f1431f0-53e8-41c1-9cf9-22d11aa51d6a\",\"account_uuid\":\"\",\"session_id\":\"2d480878-38af-4bae-a54f-096e2fb0f4d7\"}"
  }
}
```

`metadata.user_id` 是 JSON 字符串，内部字段语义如下：

- `device_id`：当前 Agent 运行环境的持久化 `deviceMid`，原样使用 UUID，不转换为另一种 ID。
- `account_uuid`：当前固定为空字符串；zcode-cli 尚无对应的 Anthropic OAuth account UUID。
- `session_id`：当前模型请求的 session id，复用 `x-session-id` 的外部归一化逻辑，剥离
  `sess_` 和 `subagent_agent_` 内部前缀；底层调用没有 session context 时使用空字符串。

请求级 metadata 必须覆盖 provider 静态配置中的 `anthropic.metadata.userId`，避免静态配置把
旧设备或旧会话身份带入新请求；其他 Anthropic provider options（例如 `thinking`、`effort`）
必须保持不变。

## DeviceMid 所有权

Desktop、远端 zcode-server 和 zcode-cli 拥有彼此独立的“确保 deviceMid 存在”入口，但共同读写同一份状态：

```text
Desktop ensure（同步） ─────────┐
远端 server ensure（启动时异步）├─> {dataBaseDir}/.zcode/v2/telemetry-state.json.deviceMid
CLI ensure（异步） ─────────────┘                          │
                                                  v
                                  zcode-cli Anthropic metadata.device_id
```

- 本地 Desktop 通常会在 Agent 启动前生成 `deviceMid`，zcode-cli 读取并消费同一个值。
- 独立 CLI 或 SSH/WSL/Docker Agent 无需依赖 Desktop，由 CLI 自己生成并持久化；SSH/WSL/Docker 远端的 `zcode-server` 启动时也会确保同一文件里有 `deviceMid`，Agent 随后读到同一个值。
- CLI 使用与 Desktop/telemetry 相同的 `createUuid()` 格式，并保留 state 文件中的其他字段。
- CLI 使用 `telemetry-state.lock` 协调并发读写，进程内按 state 文件缓存同一个 ensure promise。
- 文件读写或锁异常不能阻断模型请求；此时返回并缓存当前进程生成的 UUID，下次进程启动再尝试持久化。
- `ZCODE_DATA_BASE_DIR` 决定实际数据根目录；没有配置时回退到当前 Agent 环境的 home 目录。
- model I/O debug 记录保留 metadata 结构，但将 `user_id` 整体替换为 `[REDACTED]`，不落盘设备身份。

因此本地 Desktop 与其启动的 Agent 消费同一设备身份；远端 Agent 在远端数据目录拥有独立设备身份。
手机 `/remote` 通过 shared-host attachment 使用已连接 Agent 的身份，不生成手机端身份。

## 请求路径与边界

```text
ModelStatusContext.sessionId ──归一化──────────────┐
CLI ensureDeviceMid() ────────读取/生成────────────┼─> JSON.stringify(user_id)
account_uuid ─────────────────固定空字符串─────────┘
                                                    │
                                                    v
                         providerOptions.anthropic.metadata.userId
                                                    │
                                                    v
                                  AI SDK Anthropic 请求 metadata.user_id
```

- `generateText`、`streamText`、compact、title、子 Agent、工具二级模型和 adapter retry
  共享同一个模型请求选项路径。
- 只有 `providerKind === "anthropic"` 时注入；OpenAI、OpenAI-compatible、gateway 和 custom
  transport 不增加该 metadata。
- retry 可以生成新的 `x-request-id`，但同一逻辑请求的 `device_id` 和 `session_id` 保持不变。
- 该字段只用于上游请求归因，不作为本地鉴权、会话路由或 workspace 隔离依据。

## Impact Brief

| Field            | Value                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| Developer intent | Anthropic 请求携带与 Desktop/telemetry 共享的设备身份及当前 session                                                  |
| Capability       | Anthropic request attribution metadata                                                                               |
| Change layer     | `commit-effect`、`persistence`                                                                                       |
| Operating mode   | `planning`                                                                                                           |
| Primary seeds    | `ensureDesktopDeviceMidSync`、`createTelemetryCore`、`runGenerateText`、`runStreamText`、`createGenerateTextOptions` |
| Out of scope     | UI、app services 请求头、协议、conversation/replay 状态、非 Anthropic provider                                       |

UI Surface Matrix：无 UI 入口。权威持久化是 Agent 所在主机的
`telemetry-state.json.deviceMid`；zcode-cli model adapter 是 metadata commit sink。

| Rank           | Relationship                                  | Reason                                    |
| -------------- | --------------------------------------------- | ----------------------------------------- |
| must-inspect   | CLI deviceMid ensure → telemetry state        | 必须复用同一字段并保留其他 telemetry 状态 |
| must-inspect   | model runner → Anthropic provider options     | generate/stream 和 retry 必须共用注入行为 |
| should-inspect | session attribution header → metadata session | header 与 body 不得出现两套前缀规则       |
| conditional    | local Agent → remote Agent data root          | 设备身份跟随实际 Agent 运行环境           |
| invariant-only | non-Anthropic providers                       | 不得新增 metadata 或改变 provider options |
| invariant-only | desktop continuous / mobile replayable        | 不改变消息流、snapshot 或恢复边界         |

图谱漂移：现有 feature graph 未声明 Anthropic request metadata 和共享 deviceMid persistence；
本功能确认后补充相应 capability、service、persistence 与语义边。

## Accepted Cases

| Case  | Setup                                    | Action                    | Assertions                                |
| ----- | ---------------------------------------- | ------------------------- | ----------------------------------------- |
| ARM01 | state 已有 `deviceMid`                   | Anthropic generate        | body 使用已有值和归一化 session           |
| ARM02 | state 缺少 `deviceMid`                   | 独立/远端 CLI 首次请求    | CLI 生成 UUID、保留其他 state 并持久化    |
| ARM03 | 并发首次请求                             | Anthropic generate/stream | 同一 state 文件只产生并消费一个持久化 ID  |
| ARM04 | 静态 Anthropic metadata 与 thinking 并存 | 发起请求                  | 动态 userId 覆盖静态值，其他 options 保留 |
| ARM05 | OpenAI-compatible provider               | 发起请求                  | 不注入 Anthropic metadata                 |
| ARM06 | state IO 失败                            | Anthropic 重试            | 请求继续，同一进程使用相同 fallback ID    |

不需要 conversation case catalog、coverage matrix 或 E2E handoff；以 adapter 单测和实际
Anthropic wire body 测试作为证据。
