# Coding Plan Quota Remaining API

日期：2026-06-29

## 用途

用量看板的 `Quota remaining` 用于展示 Coding Plan 的剩余额度，包括 5 小时额度、Weekly 额度和 MCP 额度。

## API

```http
GET /api/monitor/usage/quota/limit
```

## 鉴权

使用 API Key 鉴权。

```http
authorization: <API Key>
```

注意：

- `authorization` header 直接传完整 API Key。
- 不额外拼接 `Bearer` 前缀。
- 用量看板读取当前选中的 Coding Plan provider，不使用普通模型 provider 的 API Key。

## 额度卡片匹配规则

额度卡片通过 quota 接口返回的 `limits[]` 中 `type`、`unit`、`number` 字段判断。

| 看板卡片 | 匹配条件 |
|---|---|
| 5 小时额度 | `type === "TOKENS_LIMIT"` 且 `unit === 3` 且 `number === 5` |
| Weekly 额度 | `type === "TOKENS_LIMIT"` 且 `unit === 6` |
| MCP 额度 | `type === "TIME_LIMIT"` 且 `unit === 5` 且 `number === 1` |

## 百分比展示

接口返回的 `percentage` 按“已使用百分比”处理。

前端展示剩余百分比时使用：

```ts
remainingPercentage = 100 - percentage;
```
