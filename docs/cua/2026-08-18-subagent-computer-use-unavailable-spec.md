# Subagent Computer Use 不可用边界

## 目标

子 Agent 不得使用官方 `zcode-cua` Computer Use。限制只绑定已经由 Host authority
验证的官方 CUA server，不按工具名称或 display name 猜测，因此第三方 MCP 不受影响。

主 Agent 继续使用 canonical `mcp__computer-use__*` 及兼容 alias；桌面
`desktop-continuous`、Web 远控 `web-remote-replayable`、Host、UI 和协议 schema 均不变。

## 两层边界

```text
child spawn
  ├─ authority = computeOfficialCuaServerNames(parent config, trusted names)
  ├─ wildcard profile -> 从 borrowed snapshot 移除官方 server/tools
  ├─ explicit CUA server/tool/selector/skill -> 启动前配置错误
  └─ child SkillPort -> 隐藏官方 computer-use

child MCP call (runtime_scope=subagent)
  └─ zcode-cua preflight -> 返回错误，不进入 kill-switch/Broker/handler
```

错误码为 `SUBAGENT_COMPUTER_USE_UNAVAILABLE`，错误文本为
`Computer Use is not available in subagent`。producer 只信任 namespaced
`com.zcode/request-context.runtime_scope`；缺失、格式错误或 `main` 保持兼容，顶层同名字段不可信。

## 子 Agent 语义

- 没有显式 CUA 配置时，wildcard、Explore、general-purpose、custom、background 和 resume
  子 Agent 都不看到官方 CUA server、descriptor、canonical/raw/alias 工具或 Skill。
- 显式声明官方 server、canonical/raw/alias tool、MCP server selector 或官方 Skill 时，child
  runtime 在首次模型请求前失败，不静默删除用户配置。
- 过滤使用冻结的官方 plugin catalog、plugin id、root path 和 qualified name；同名第三方
  Skill 不受影响。
- parent snapshot、parent MCP lifecycle 和主 Agent registry 不被修改。

## Producer 语义

`zcode-cua` 的 30 个工具共享同一个 preflight。`runtime_scope=subagent` 时在 kill-switch
检查、Broker 访问和 handler 之前返回 `isError`；request access、stop、wait、clipboard 等
工具也不能绕过该边界。工具名称、schema、annotations、权限组和结果协议不变。

## 验收

- 子 Agent provider-visible tool/Skill surface 不含官方 CUA，非官方 MCP/Skill 仍可用。
- 直接绕过 surface 的 CUA 调用不会触发 Broker。
- 主 Agent 官方 CUA 调用行为保持不变。
- 覆盖 z-code 单元测试、zcode-cua producer 单元测试及一条 conversation manual-review/replay case。
