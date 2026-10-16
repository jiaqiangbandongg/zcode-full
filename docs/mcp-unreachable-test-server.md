# MCP 默认不可连接测试 Server

## 背景

MCP 设置页打开开关后，曾出现不可连接 server 初始显示为绿色，随后真实连接失败才变红的状态流转。为了稳定复现该问题，需要默认启用、但不会连通的 ZCode Agent MCP server，分别覆盖 HTTP 连接失败和 STDIO 进程启动失败。

## 配置位置

测试配置写入用户级 ZCode Agent MCP 配置：

```json
{
  "mcp": {
    "servers": {
      "zcode-unreachable-http-test": {
        "type": "http",
        "url": "http://127.0.0.1:9/mcp",
        "timeoutMs": 3000
      },
      "zcode-unreachable-stdio-test": {
        "type": "stdio",
        "command": "zcode-mcp-stdio-server-that-does-not-exist-for-test",
        "args": [],
        "timeoutMs": 3000
      }
    }
  }
}
```

说明：

- 不写 `enable: false`，保持默认启用，用于观察初始状态和连接失败后的状态变化。
- HTTP 测试项使用 `127.0.0.1:9`，请求只落在本机回环地址，不访问外网。
- STDIO 测试项使用不存在的命令名，预期触发进程启动失败。
- 如果本机端口 9 被占用，需要把 HTTP 测试项换成另一个未监听的本机端口。

## 预期验证

1. 启动桌面端后打开 Settings -> MCP Servers。
2. `zcode-unreachable-http-test` 和 `zcode-unreachable-stdio-test` 应出现在 ZCode Agent MCP 列表中。
3. 打开任一 server 开关或刷新 MCP 状态时，不应长期保持绿色 connected。
4. 真实连接完成后应展示 failed/error，并保留错误信息；STDIO 测试项的错误应指向命令无法启动或找不到。

该配置只用于本地诊断，不应作为默认产品配置下发。
