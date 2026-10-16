# Read Tool 模型可见结果契约

## 背景

Read 工具的 provider-visible `tool_result`（包括 `is_error` 和文本内容）是模型理解读取结果的唯一依据。本文约束 Read 在 warning、重复读取、preflight 失败、图片与普通文本读取时的模型可见形态，结构化输出与内部错误类型不在此收敛范围内。

## 目标

- Read 的模型可见 warning / dedup / preflight error 使用固定、可回归的文案与包装。
- 保持结构化输出和内部错误类型可调试；只收敛模型可见文本边界。

## 设计

- `file_unchanged` 模型可见内容固定为：
  `Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.`
- Read tool result 内联 warning 使用单行 `<system-reminder>body</system-reminder>`。这是 Read mapper 的专用路径，不替换全局 `wrapSystemReminderForSource(...)`。
- 成功读取非空文本时，不追加旧版 malware reminder；只输出按条件生成的 freshness / truncation reminder 与带行号正文。
- 图片 Read 的 provider-visible tool result 只保留 image block。图片 resize 产生的尺寸和坐标换算数据继续保留在结构化 output，但不再生成额外 text block。
- Read input semantic preflight 失败时，handler 捕获 `ReadInputSchema.parse(...)` 的 custom issue，并抛出可恢复 `ToolExecutionFailed`，message 为 `<tool_use_error>${issue.message}</tool_use_error>`。
- 非 Read 或非 custom semantic validation 错误继续走现有通用 validation 路径，避免把所有 schema 错误误包装成 `<tool_use_error>` 格式。

## 验收

- `read-tool-contract.test.ts` 覆盖成功文本不追加旧版安全提醒、图片只含 media block、dedup 文案、Read warning 单行 wrapper、binary/device preflight 的 `<tool_use_error>`。
