# Agent Tool Call Renderer

`packages/ui` 为子代理委派类工具新增了独立的 `AgentToolCallBlock`。

当前约定：

- 摘要行显示 `agentName + primaryText + status`，不再给子智能体编号
- v4 Agent/Task 行始终是单行摘要，不再展开 Prompt、输出、活动或子工具
- 行拿到 `rootSessionId + parentSessionId + childSessionId` 和打开 callback 时，摘要行是详情动作：点击或按 Enter/Space 在桌面/普通 Web 打开右侧只读 tab，在手机 `/remote` 打开现有右侧抽屉
- child 尚未投影或启动前失败时，摘要保持静态、不可点击；child 目标后到只切换为可点击，不自动打开详情
- `agentName` 优先取已配对 `subagentRow.subagentType`、`output.agentType`、`input.subagent_type` / `input.agent_type` 等真实智能体名称，不使用协议实现名 `Agent`
- `subagent_type` 采用三态展示：已解析出显式类型时立即显示；`raw.inputPreviewComplete !== true` 且尚未拿到权威类型时留空；仅当输入预览明确完整、仍省略类型时显示真实默认值 `general-purpose`
- `primaryText` 会跳过 `Agent` / `Task` / `spawn_agent` 等实现名，优先展示 nickname、title、description 或 agent type
- foreground/background 只影响 runtime 生命周期，不影响详情入口
- child tool lifecycle 仍可用 `source: "subagent"` 镜像到父 runtime 供兼容消费者和诊断使用，但父 V4 ProductProjection 不得把这些 mirror 物化成 `ToolCallRow`；否则 child 的 Read/Bash 会被误画成 main 自己的工具调用。child session topic 继续物化完整工具历史，桌面 `desktop-continuous` 与手机 `web-remote-replayable` 使用同一隔离规则
- 父会话只保留 Agent/Task 摘要、subagent 运行状态、background work 和带 `origin.kind: "subagent"` 的阻塞交互；等待 foreground child 仍属于 main turn 的真实运行态，不依赖 child tool row 续住
- child 当前 `snapshot.control.lastError` 在只读详情展示，不新增父行 inline fallback、timeline row 或持久化字段
- `Task` 是 Claude Code 历史兼容别名，和 `Agent` 使用同一 renderer；Workflow 不在本规则内
- 不复用 `Explore` 语义，也不使用通用 `ToolCallBody`

命中条件：

- `raw._meta.claudeCode.toolName === "Agent"`
- `raw._meta.zcode.toolName === "Agent"`
- `raw._meta.zcode.toolName === "spawn_agent"` / `raw.name === "spawn_agent"` / `kind === "spawn_agent"`（Codex）
- `kind === "think"` 且 `title === "Agent"`（GLM/ZCode Agent）
- 或 `kind === "think"` 且 `input.subagent_type` 存在

## 流式类型展示边界

`inputText` 是增量 JSON。半截 JSON 尚未包含 `subagent_type`，不能等价为模型省略该字段；
否则首个 `tool_input_start` 帧会短暂显示 `general-purpose`，后续真实类型到达后再跳变。

```text
tool_input_start / row.inputText 增量
                 |
                 v
       +----------------------+
       | 已有权威/显式类型？   |
       +----------------------+
          | 是             | 否
          v                v
      显示真实类型   inputPreviewComplete === true ?
                         | 是                  | 否
                         v                     v
                 显示 general-purpose        留空

subagentRow.subagentType 到达后 --------------------> 显示该权威类型
```

这里保留 Agent 工具“完整输入省略 `subagent_type` 时默认为 `general-purpose`”的 runtime
语义，只延迟 UI fallback；不得通过扫描半截 JSON 白名单来猜测字段是否还会到达。
