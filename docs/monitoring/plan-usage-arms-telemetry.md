# Plan Usage ARMS 自定义事件

ZCode 桌面端通过 ARMS custom event 补充所有 LLM request 的请求级用量看板。

## 事件口径

| 字段     | 值                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------- |
| group    | `plan_usage`                                                                                                               |
| name     | `plan_request` / `plan_ttft`                                                                                               |
| value    | `plan_request` 为 `1`；`plan_ttft` 为 `ttft_ms`                                                                            |
| 触发时机 | `plan_request` 在真实网络状态进入 live fact feed 时上报；`plan_ttft` 在 foreground 本地 prompt 的首 token 时间可计算后上报 |

该事件不等待 `message_completion`，也不复制 `/event/report` 的完整 completion payload。
`plan_request` 不绑定 `send_btn`，而是跟随真实的 `model_request_started`、
`model_request_completed`、`model_request_failed`、`model_retry_scheduled`、
`model_stream_stalled` 五类状态，因此覆盖前台和后台的真实 LLM request。initial、cold hydration、
gap recovery 不生成事件，且不得从 V4 `apiRetry`、accepted 或 queued 投影反推。客户端不按 provider
白名单过滤；真实状态没有 `provider_id` 时用 `unknown` 兜底。

`plan_ttft` 仍是 renderer 用户体验口径：从本 renderer 的桌面发送 seed 到本 renderer 收到首个
live 正文、思考或工具进展。不能用 provider/runtime TTFT 代替，切到 background 后也不补报。
完整生命周期与多端边界见 [conversation-telemetry-v4.md](./conversation-telemetry-v4.md)。

## 自定义属性

| 属性             | 说明                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `provider_id`    | 请求时解析到的 provider id；内置 provider 保留稳定 ID（例如 `builtin:zai` / `builtin:zai-coding-plan`），自定义 provider 固定写 `custom` |
| `provider_scope` | `builtin` / `custom` / `unknown`，与 `provider_id` 一同判定                                                                              |
| `model_name`     | 模型请求事件中的 model id/name；仅保留 telemetry 白名单内的内置稳定模型 ID，其余写 `custom`                                              |
| `ask_mode`       | 模型请求事件中的 query source                                                                                                            |
| `request_status` | `plan_request` 专用；`started` / `completed` / `failed` / `retry_scheduled` / `stream_stalled`                                           |
| `request_id`     | 模型请求 id                                                                                                                              |
| `task_id`        | ZCode task id                                                                                                                            |
| `input_id`       | 用户输入 id                                                                                                                              |
| `query_id`       | query id                                                                                                                                 |
| `event_key`      | 协议事件去重键                                                                                                                           |
| `attempt`        | 当前模型请求 attempt                                                                                                                     |
| `max_attempts`   | 最大 attempt                                                                                                                             |
| `ttft_ms`        | `plan_ttft` 专用，首 token 延迟毫秒数                                                                                                    |

`provider_id` / `model_name` 与 `chat_error_banner` 的 `provider_id` / `model_id` 共用
`@zcode/shared` 的同一条白名单和归一实现：自定义 provider 的 id 与模型名由用户命名，原样上报会
泄露私有名称并制造高基数，因此一律归一为 `custom`。白名单匹配与输出都用规范化小写 ID。
归一只作用于上报值，不改变 `provider_id` 为空时不发事件的既有闸门，也不改变本地日志与业务的
provider 选择。

内置 provider 有两套 ID：运行时 ID（`account:zai-start-plan` 等）与旧报表身份（`builtin:zai` /
`builtin:zai-coding-plan` / `builtin:zai-start-plan` 及 bigmodel 对应项）。V4 supervisor 投影
`/report` detail 时已把运行时 ID 映射为旧报表身份，`plan_ttft` 与 `perf_ui_*` 复用同一份 detail，
`plan_request` 则直接使用协议事件里的运行时 ID。因此归一实现必须把两套 ID 都判为内置并原样保留，
否则内置用户会整体落入 `custom`。`model_name` 允许 `<providerId>/<modelId>` 复合值或
`custom:<providerId>:<modelName>` 编码值，归一时先剥出裸模型 ID 再查白名单。

模型白名单以 `@zcode/shared` 的官方 GLM 模型名单（`OFFICIAL_GLM_MODEL_IDS`）为来源，另附
官方名单之外的历史内置模型；官方名单新增模型即进入白名单，不在名单内的模型写 `custom`。

`provider_id=unknown` 是「协议事件没带 provider」的既有兜底桶，不并入 `custom`；该分支下
`model_name` 按模型 ID 自身的白名单判定，命中内置白名单则保留，否则写 `custom`。

ARMS main 进程桥会自动补齐 `app_version`、`arms_env`、`device_mid`、`platform`、`renderer_id`、`metric_value`。

## 查询建议

- 请求量：筛 `group=plan_usage`、`event_name=plan_request`，按 `provider_id` / `model_name` 分组。
- 首 token 延迟：筛 `group=plan_usage`、`event_name=plan_ttft`，看 `value` 或 `ttft_ms` 的平均值、P95。
- 访问用户数：同上筛选后看 ARMS 关联访问用户数，或在日志查询里按 `properties.device_mid` 去重。
- 不要与 `/event/report` 的 `message_completion` 直接相加；两者是不同链路，前者是 ARMS 请求级看板，后者是业务 completion 明细。
