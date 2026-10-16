# 多模态 tool result P0 回归用例

## 目标

验证 ZCode 将 MCP/内置工具结果转换为 Anthropic `tool_result.content[]` 时，
多块文本、图片和状态文本不会在 BigModel Anthropic 兼容接口中静默丢失。

本组用例同时覆盖两条边界：

```text
工具/MCP CallToolResult
        ↓
ZCode model-content projection
        ↓
Anthropic tool_result.content[]
        ↓
BigModel compatibility projection
        ↓
模型可见内容
```

P0 runner 只读取环境变量，不在代码或 fixture 中保存 API key：

```bash
ANTHROPIC_API_KEY=... \
ZCODE_MODEL=glm-x-preview-f \
ZCODE_BASE_URL=https://open.bigmodel.cn/api/anthropic \
node scripts/multimodal-tool-result-p0.mjs
```

## 用例

| ID                         | 输入块顺序                             | 目标                                     | 失败含义                       |
| -------------------------- | -------------------------------------- | ---------------------------------------- | ------------------------------ |
| `text-three-blocks`        | `text0, text1, text2`                  | 三个 nonce 全部可见且顺序不变            | 兼容层静默丢弃后续文本         |
| `mcp-text-image-text`      | `text, image, text`                    | 两个文本和图片内 marker 全部可见         | 普通 MCP 混合结果丢块          |
| `android-screenshot-shape` | `text, image`                          | metadata 与截图内 marker 同时可见        | Android 截图图片丢失           |
| `ios-screenshot-shape`     | `text, image`                          | metadata 与截图内 marker 同时可见        | iOS 截图图片丢失               |
| `browser-multiple-images`  | `imageA, imageB, text`                 | 两张图片和文本全部可见                   | Browser Use 后续图片或文本丢失 |
| `cua-observation`          | `image, frame_ref, ax_tree, outcome`   | raster、frame、AX tree、outcome 全部可见 | CUA 状态屏障/动作约束丢失      |
| `multiple-tool-results`    | 两个独立 `tool_result`，每个含两段文本 | 每个 `tool_use_id` 的结果均完整可见      | 多工具结果之间发生投影截断     |

所有 marker 都由每次运行生成的 nonce 唯一化；提示词不包含 marker 值，避免模型从指令中猜答案。

## 判定

- `PASS`：HTTP 200，模型输出包含该 case 的全部 marker，且顺序正确。
- `FAIL`：HTTP 200 但缺少任意 marker，或者顺序错误。
- `BLOCKED`：模型服务返回 403、429、529 等服务状态，不能把它判为链路通过或失败。

`scripts/multimodal-tool-result-p0.mjs` 只验证兼容接口语义；ZCode 真链路需要另行确认 ZCode 发出的原始
`content[]` 与工具产出一致。

捕获结果只作为链路证据，不把 API key 或图片 base64 写入测试 fixture。
