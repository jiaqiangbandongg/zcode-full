# message_completion provider_name

## 背景

`message_completion` 之前只上报 `model_provider`。自定义 provider 场景下该字段通常是内部 provider id 或 uuid，无法直接按真实请求域名做分析。

## 方案

- 保留 `model_provider` 兼容既有数仓口径。
- 新增 `provider_name`，当前取 provider endpoint 的 hostname，只上报 hostname，不包含 protocol、path、query、header 或 API key。
- 初始发送快照从当前 provider registry 的 endpoint `baseURL` 解析 hostname。
- 运行时收到 `model_request_started` 时，如果事件带 `baseURL`，以真实请求 `baseURL` 的 hostname 覆盖发送快照。
- `send_btn` 与 `message_completion` 共用同一份 prompt telemetry extraDetail；首发、续聊和队列发送都会在 send 事件里带同一个 `provider_name` 初始快照。
- 无法解析 URL 时字段留空，避免把内部 uuid 或原始 endpoint 当 hostname 上报。

## 影响面

该变更只影响 UI 遥测 extraDetail，不修改 app-agent 协议和任务流语义。桌面 continuous 与手机 web-remote replayable 都复用同一 prompt telemetry 状态，`provider_name` 作为普通维度字段随现有 `message_completion` 上报。
