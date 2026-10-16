# MCP Tool Output Budget

## 背景

MCP server 是外部输入源，工具结果不能默认信任其体积。之前 MCP 图片会被转换成模型可见的 inline image block；`resultBudget` 只按 `modelMessageContentToText` 统计占位文本，导致大 base64 图片没有在工具结果层被截断。虽然主模型请求还有 4 MiB media budget，但单张约 2 MiB 的 MCP screenshot 仍可能超过 provider/proxy 的 HTTP body 限制并触发 413。

## 目标

- MCP 文本结果继续受 `resultBudget` 约束。
- 普通第三方 MCP 图片 base64 payload 超过 200 KiB 时，不再 inline 进模型请求。
- 保留的 `node_repl/js` 是 browser use 的可信宿主工具；其 `nodeRepl.emitImage(...)` 图片超过
  200 KiB 时先压缩到预算内，成功后继续作为 image block 进入模型，而不是直接丢失视觉能力。
- 无法压缩的超限 MCP 图片保存一份本地 artifact 副本，模型只收到 artifact path/URI 和尺寸说明。
- 没有 artifact store 时也不能把超限图片继续 inline，必须降级为文本说明。
- 桌面端 `desktop-continuous` 和手机端 `web-remote-replayable` 的 session/task 语义不变；这是 agent runtime 内的工具结果投影，不改变远控 owner、queue、snapshot 边界。

## 设计

MCP tool handler 在调用 `McpPort.callTool` 后立即规范化结果，而不是等到 `formatModelContent`。原因是 handler 拥有 `artifactStore`、`sessionId`、`turnId` 和 `toolCallId`，可以保存副本；`formatModelContent` 只有 output，无法落盘。

规范化规则：

1. `type: "image"` 且 `data` / `mimeType` 合法时，计算 base64 payload 的 UTF-8 字节数。
2. payload 不超过 `200 * 1024` 字节时保持 inline，兼容小图和现有视觉能力。
3. 对 `serverName=node_repl && toolName=js` 的宿主图片先调用 `ImageProcessorPort.prepareForModel`：
   - base64 payload 上限固定为 `200 * 1024` 字节；
   - decoded binary 上限固定为 `floor(200 * 1024 * 3 / 4) = 153600` 字节，保证重新编码后的
     base64 不越界；
   - 最长边上限为 2000，和现有 `Read` 模型图片的可读尺寸一致；
   - 复用 adapter 既有候选序列：保留格式/PNG 优化、2000 边界缩放、JPEG 质量阶梯、PNG 量化、
     渐进缩放，最后才使用低质量 JPEG 小尺寸兜底；禁止在 MCP bridge 里新增另一套编解码器。
4. 宿主图片压缩成功后，必须再次按实际 base64 字节数校验 `<= 200 KiB`，只把变换后的
   `data` / `mimeType` 作为 image block 交给模型；原图不进入 provider request。
5. 普通第三方 MCP 图片不执行 CPU 密集型压缩，仍直接进入 artifact 策略，避免把不可信 MCP
   payload 变成通用图像解码攻击面。
6. 宿主图片缺少 `ImageProcessorPort`、解码/压缩失败或防御性复验仍超预算时，也进入原有 tool
   artifact 降级。优先使用 `writeToolResultBinaryArtifact` 保存 decoded binary，并按 `mimeType`
   选择 `.png` / `.jpg` / `.gif` / `.webp` 等扩展名；模型只看到本地 path/URI。
7. 模型可见 content block 替换为文本：说明 MCP 图片已保存、本地 path/URI、原始大小和阈值。
8. 如果当前 artifact store 还不支持二进制写入，则 fallback 到文本 artifact：JSON 中包含
   `dataUrl`、`mimeType`、server/tool 名称、原始 base64 字节数和生成时间。
9. 如果 artifact store 不可用，替换为文本说明并明确没有保存副本，避免继续发送大 base64。

### 范围与状态组合

| 来源           |  原始 base64 | ImageProcessor     | 结果                              | 状态     |
| -------------- | -----------: | ------------------ | --------------------------------- | -------- |
| `node_repl/js` | `<= 200 KiB` | 任意               | 原图 inline                       | accepted |
| `node_repl/js` |  `> 200 KiB` | 成功压到预算内     | 压缩图 inline                     | accepted |
| `node_repl/js` |  `> 200 KiB` | 缺失/失败/复验超限 | 原图 artifact 或无 store 文本降级 | accepted |
| 其他 MCP       | `<= 200 KiB` | 任意               | 原图 inline                       | accepted |
| 其他 MCP       |  `> 200 KiB` | 任意               | 原图 artifact 或无 store 文本降级 | accepted |

本变更只发生在 agent tool-result 投影阶段，不新增 protocol 字段，不改变 session/task 状态，也不区分
`desktop-continuous` 与 `web-remote-replayable`：两端共享同一个已预算化的工具结果。

## 验证

- MCP 小图片仍投影为 image block。
- MCP 大图片被替换为文本，支持二进制 artifact store 时保存 decoded image bytes，并返回图片 path/URI。
- `node_repl/js` 的超限 PNG/JPEG 在 `ImageProcessorPort` 可用时压缩为不超过 200 KiB base64 的
  image block，且不写 artifact。
- 宿主图片压缩失败或压缩结果仍越界时不 inline，继续保存原图 artifact。
- 真实 Jimp adapter 对长页面 screenshot 比例的 PNG 覆盖 2000 最长边与 200 KiB base64 双预算。
- 旧 artifact store 仍可 fallback 为 JSON artifact，模型请求中不包含原始 base64。
- 没有 artifact store 时，大图片仍被替换为文本，不进入模型请求。
- 运行 MCP bridge 和 runtime tool loop 相关单测。
- 执行 `pnpm typecheck` 和 `pnpm lint`。
