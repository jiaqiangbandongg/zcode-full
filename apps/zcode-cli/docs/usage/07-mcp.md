# 07 · MCP

MCP 为 CLI 提供外部工具。运行配置使用 `mcp.servers`，每个 server 必须声明传输类型。先确保 `features.mcp` 已启用。

## 配置示例

```json
{
  "features": { "mcp": true },
  "mcp": {
    "servers": {
      "example": {
        "type": "stdio",
        "command": "node",
        "args": ["/absolute/path/to/mcp-server.mjs"],
        "enabled": true,
        "timeoutMs": 30000
      }
    }
  }
}
```

`mcp-server.mjs` 应是符合 MCP 协议的服务，不是普通输出 JSON 的脚本。stdio 服务的 stdout 专用于协议，诊断写 stderr。`command` 对应的程序及其依赖须在目标机器安装；CLI 的 SEA 产物不会为外部脚本自动提供 Node 命令。

远程服务可使用 `type: "http"`，配合 `url`、可选 `headers`、`oauth` 和 `timeoutMs`；旧 SSE 传输使用 `type: "sse"`。协议选择 `protocolVersion` 支持 `auto`、`legacy`、`2026-07-28`，只在服务兼容性需要时显式设置。精确字段见[配置 schema](../../packages/adapters/src/config/schema.ts)。

同名 server 的用户配置优先于项目配置。定位“改了项目配置却没生效”时，先检查用户配置和插件是否也声明了该服务。

## 验证与评测

用最小无副作用工具测试连接、schema 和返回结果。检查请求中的实际工具名，不要仅凭模型声称“能访问 MCP”判断成功。常见名称包含 `mcp__` 前缀；插件服务可能添加命名空间，以本次注册结果为准。

工具能注册不等于鉴权完成，也不等于有执行权限。非交互任务应预先完成所需凭据配置；授权过程中要求用户交互的服务不能直接视为批处理就绪。

MCP 的可见性、工具过滤和权限是不同层。移除 MCP 工具时记录全名；需要完全禁用此能力可关闭 `features.mcp`，并检查插件、浏览器或其他工具是否仍提供等价通道。

评测记录服务版本、工具 schema 和必要的非敏感配置。密钥、Authorization header 和 OAuth 凭据不进入数据集。
