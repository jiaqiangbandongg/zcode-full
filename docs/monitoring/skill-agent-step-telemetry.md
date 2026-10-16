# Skill `agent_step` telemetry

## 目标

在保留现有 `agent_step` 计数、时序和工具归因口径的前提下，识别一次
`Skill` tool call 实际加载的是哪个 skill，以及它来自哪个 plugin/source。

本改动不新增 skill description step，也不把 SKILL.md 正文或 description 写入高频
`agent_step` 事件。

## 字段

仅在现有 `tool_name=Skill` 的 `agent_step.event_extra_detail` 中按需增加：

| 字段                   | 说明                                                          | 来源                                  |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------- |
| `skill_qualified_name` | 规范化 skill 名，例如 `document-skills:pptx`                  | `SkillContent.metadata.qualifiedName` |
| `skill_plugin_id`      | 完整 plugin id，例如 `document-skills@zcode-plugins-official` | `LoadedPlugin.id`                     |
| `skill_source`         | 现有 `SkillSource` 枚举值                                     | `SkillContent.metadata.source`        |

三个字段都可选；metadata 缺失时省略，不根据名字字符串猜测来源。

## 数据链路

```text
ToolCallScheduled(Skill)
        |
        v
SkillPort.loadSkill() -- resolved SkillMetadata --> ToolCallResult / ToolCallError
        |
        v
tool.lifecycle fact
        |
        v
existing agent_step finalization
```

Skill metadata 作为 session event 的 telemetry-only 数据传播，不进入模型可见的
tool result content 或错误正文。若 Skill 已完成解析、但后续 serialize/post_hook 阶段失败，
metadata 通过 `ToolCallError` 保留到最终失败的 `agent_step`。

## 边界与不变量

- `tool_name !== "Skill"` 的 step 不得包含任何 `skill_*` 字段。
- document、CUA、BUA 等流程产生的 Bash/MCP step 不继承 Skill metadata。
- 如果 CUA/BUA 流程自身调用 `Skill`，只有该 `Skill` step 写入对应字段。
- 不新增 step，因此 `agent_step_cnt`、`loop_index`、耗时和 token 口径保持不变。
- 官方 bundled plugin 当前通过 plugin root 暴露，`skill_source` 仍报告为 `plugin`，
  `skill_plugin_id` 使用真实 marketplace id；不擅自改成 `bundled`。

## 兼容性

旧 session event 和无法解析 metadata 的 Skill call 仍按原有 `tool_name=Skill` 逻辑
收口；新增字段全部为可选，旧消费者无需迁移。
