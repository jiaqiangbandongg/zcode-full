# Skill `agent_step` telemetry

## 目标

在保留现有 `agent_step` 计数、时序和工具归因口径的前提下，识别一次
`Skill` tool call 实际加载的是哪个 skill，以及它来自哪个 plugin/source。

本改动不新增 skill description step，也不把 SKILL.md 正文或 description 写入高频
`agent_step` 事件。

## 字段

仅在现有 `tool_name=Skill` 的 `agent_step.event_extra_detail` 中按需增加：

| 字段                   | 说明                                                          | 来源                                                                        |
| ---------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `skill_name`           | 所有 Skill step 的技能名称，不限插件来源                      | 仅使用解析后的 `SkillContent.metadata.name`，未解析或校验失败时为 `unknown` |
| `skill_qualified_name` | 规范化 skill 名，例如 `document-skills:pptx`                  | `SkillContent.metadata.qualifiedName`                                       |
| `skill_plugin_id`      | 完整 plugin id，例如 `document-skills@zcode-plugins-official` | `LoadedPlugin.id`                                                           |
| `skill_source`         | 现有 `SkillSource` 枚举值                                     | `SkillContent.metadata.source`                                              |

`skill_name` 在 `tool_name=Skill` 的 step 中始终填写，但只接受已解析 metadata 的名称。
不读取调度或兼容 stream 的 `input.skill/name`；加载前失败、拒绝、停止及旧事件缺少
已解析名称时均填 `unknown`，即使请求字符串看起来像合法名称也不回退。

名称为 1–64 个 ASCII 字母、数字、下划线或连字符，以字母或数字开头；不 trim、不截断。
路径分隔符、冒号、空白、换行、URL、邮箱、非 ASCII 字符及超长值整体替换为 `unknown`。
复用已有 telemetry 凭据清洗规则；被识别为凭据的名称同样整体替换，而不保留片段。
格式校验不证明任意文本安全，因此真实解析来源与格式校验必须同时满足。

同一纯函数用于 CLI 终态 fact、UI 兼容 metadata/step 和最终 `/report` 清洗；V4 schema
验证名称约束。旧调度 fact 的 skillName 不作为已解析 metadata；仅终态且有 source 时
接受名称，避免混用旧 CLI 时重新引入请求参数兜底。业务 Skill 输入和加载规则不变。
其余三个插件字段仍可选，保留既有语义；不根据名字猜测来源。旧数据不回填。

## 数据链路

```text
ToolCallScheduled(Skill，不提取请求名称)
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
调度事实不携带名称，终态只接受解析后且符合约束的 metadata；名称随现有 step owner 保存，
不新增缓存或队列。桌面 continuous 与手机 replayable 沿用同一事实字段及各自交付边界。

## 边界与不变量

- `tool_name !== "Skill"` 的 step 不得包含任何 `skill_*` 字段。
- document、CUA、BUA 等流程产生的 Bash/MCP step 不继承 Skill metadata。
- 如果 CUA/BUA 流程自身调用 `Skill`，只有该 `Skill` step 写入对应字段。
- 不新增 step，因此 `agent_step_cnt`、`loop_index`、耗时和 token 口径保持不变。
- 官方 bundled plugin 当前通过 plugin root 暴露，`skill_source` 仍报告为 `plugin`，
  `skill_plugin_id` 使用真实 marketplace id；不擅自改成 `bundled`。

## 兼容性

旧 session event 和无法解析 metadata 的 Skill call 仍按原有 `tool_name=Skill` 逻辑
收口；协议新增字段可选，新客户端兼容旧事件。新字段由配套 CLI/App 上报，历史埋点不回填。

## 验收

- `zcode`、`agents`、`bundled`、`remote`、`plugin` 来源均上报符合遥测规则的解析后 `skill_name`，不合规名称为 `unknown`。
- 插件限定请求名在成功解析后变为原始技能名，原有插件字段不变。
- 解析前失败、拒绝、停止一律 `unknown`，不保留任何请求名称。
- 兼容旧 `input.name`、只到达终态、旧 metadata；缺少解析名称为 `unknown`，非 Skill 工具不携带 `skill_name`。
- 路径、URL、换行、模拟凭据、65/5000 字符名称不能进入 fact 或最终 `/report` 请求体；
  覆盖失败、拒绝、停止与 HTTP 重试，正常解析的普通/插件名称仍可统计。
- App ↔ CLI strict schema 接受可选 `skillName`；既有步骤计数、状态、Token 不变。
