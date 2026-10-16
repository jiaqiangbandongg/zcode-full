# Model attempt 错误诊断字段

## 背景

`model_attempt` 目前只保留归一化后的错误消息。流式请求被包装为
`TerminalStreamChunkError` 时，真实网络异常可能位于包装错误的因果链中，导致
ARMS 只能看到 `terminated`，无法区分连接重置、DNS、TLS 或其他传输错误。

## 目标

结束失败的 `model_attempt` span 时，继续保留现有脱敏字段，并额外写入因果链末端
错误的诊断信息：

- `error.cause.type`
- `error.cause.code`
- `error.cause.message`

字段值必须经过现有错误脱敏器处理，长度和字符集限制与 `error.type`、
`error.message` 相同；不得写入请求正文、鉴权凭据或完整响应内容。

## 采集规则

1. `TerminalStreamChunkError` 必须公开其包装错误的 `cause`，使分类器和遥测都能
   沿因果链读取原始异常。
2. 因果链字段只在存在嵌套错误且源错误首次被认领时写入；父级 span 不重复复制
   错误正文。
3. 没有因果链时保持现有行为，不能因为遥测字段失败影响模型请求。

## 查询示例

```sql
json_extract_scalar(attributes, '$["error.cause.type"]')
json_extract_scalar(attributes, '$["error.cause.code"]')
json_extract_scalar(attributes, '$["error.cause.message"]')
```

可将这些字段与 `zcode.model_attempt.error_category`、
`zcode.model_attempt.failure_stage`、HTTP 状态码和 request/session id 一起聚合。

## Todo103 合入边界与验收

- 来源 `79413e33cb`。保留上述诊断意图，不恢复旧 `registry.ts` 或嵌套 `statusContext.model`；本次不改变模型选择、重试次数、请求字段或用户可见错误文案。
- 只在存在独立嵌套错误对象时填写 cause；普通 Error、自指 cause 不得把自身重复登记为根因。
- 沿 cause 优先、adapterError 次之、error 最后的单条包装链遍历；保留原八层上限与循环检测，不扩大为扫描任意错误对象属性。
- G13-A01：终止流包装器保留真实 cause；没有 cause 时保留 adapterError；message 与 adapterError 身份不改变。
- G13-A02：嵌套原因经过脱敏，普通错误与自引用不产生虚构 cause；深链和循环有界。
- G13-A03：真实内存 OTel exporter 中首个 span 收到脱敏根因，父级 span 不重复上报；无嵌套原因的 span 不新增 cause 属性。
- G13-A04：流式使用量、原始 finish reason、部分工具输入和闲时重试回归。原始 finish reason 测试仍引用已删除的 AiSdkModelRegistry 时，只迁到本文件已有 TestProviderConfigFixture，不删除或放宽原断言。
- 本子组仅有日志/遥测副作用，不改变 App 交互，无新增 UI E2E；使用实际 exporter 和 adapter 单测验证执行行为。对话错误 Banner 的其他来源提交仍由 G13 后续独立核验，不能用本子组通过代替。
