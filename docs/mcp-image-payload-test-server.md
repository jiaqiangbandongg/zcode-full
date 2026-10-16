# MCP Image Payload Test Server

## 目的

`scripts/mcp-image-payload-test-server.mjs` 是本地调试用 stdio MCP server，用来验证 MCP 图片结果的 inline / artifact 分流逻辑。它会生成合法 PNG，并通过 PNG `tEXt` ancillary chunk 填充字节，让 image content 的 base64 payload 接近指定大小。

## 工具

MCP server 名称建议配置为 `zcode_image_payload_test`，工具名为 `emit_image`。

输入：

- `preset`：`tiny`、`below_limit`、`just_over_limit`、`large`、`huge`
- `base64Bytes`：手动指定目标 base64 payload 字节数，会覆盖 `preset`
- `label`：可选文本标签
- `dataUrl`：可选；为 `true` 时在 image `data` 字段里返回 data URL

默认 preset 是 `below_limit`，约 `180 KiB` base64；`just_over_limit` 约 `210 KiB` base64，用来验证超过 `200 KiB` 后被保存为二进制 artifact 并只返回 path/URI。

## 本机 ZCode 配置

ZCode Agent MCP 用户配置位于 `~/.zcode/cli/config.json` 的 `mcp.servers`。本地测试可加入：

```json
{
  "mcp": {
    "servers": {
      "zcode_image_payload_test": {
        "type": "stdio",
        "command": "node",
        "args": ["/Users/dev/workspace/z-code/scripts/mcp-image-payload-test-server.mjs"]
      }
    }
  }
}
```

修改配置后，需要新建或重启 ZCode Agent session，让 MCP 列表重新加载。
