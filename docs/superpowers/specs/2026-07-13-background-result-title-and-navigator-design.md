# 后台结果标题与真实用户轮次目录设计

## 目标

独立的 background Agent/Bash completion turn 不再使用不准确的“已工作 N 秒”作为摘要标题，而是展示任务启动时已经确定的 title。该结果已经是模型总结，不提供展开/收起能力。Conversation Turn Navigator 只索引用户主动提交的 `realUser` 输入，不能把 runtime 以 `role=user` 持久化的系统通知当成用户 query。

```text
background task terminal
  │ { backgroundSource, workId, title }
  ▼
synthetic provider context ──► idle runtime command ──► TurnStarted
                                                        │
                                                        ▼
                                           TurnHeaderRow.originMeta
                                                        │
                              ┌─────────────────────────┴──────────────────────┐
                              ▼                                                ▼
                    static title + full history                  navigator ignores turn

real user send ──► UserInputRow(origin=realUser) ──► navigator item
```

## 结构化数据边界

- 新增统一的后台结果元数据：`backgroundSource: "bash" | "subagent"`、`workId`、`title`。
- Subagent title 使用启动 Agent 时的 description；Bash title 沿用现有 `description → command → toolName → workId` 解析结果。
- 元数据随 background notification 的 synthetic message 持久化，并经 runtime command、`TurnStarted`、cold hydration、product projection 到达 `TurnHeaderRow.originMeta`；禁止从通知正文解析或按完成时间反查任务。
- active-loop 内直接合流的通知不创建独立 `backgroundResult` turn，因此不插入标题。只有 idle wake 的独立 model-only turn 使用该展示。
- replayable snapshot/coalesce 复用 row 元数据，不新增 relay/main 业务状态，也不改变 desktop continuous 与 mobile replayable 的恢复边界。

## UI 语义

- 只有 `turnHeader.origin === "backgroundResult"` 且 source、workId、非空 title 完整时启用新分支。
- 新分支用弱层级文本标题展示完整 title，允许自然换行；历史 rows 永久完整渲染，不创建 `Collapsible`、chevron、触发按钮或本地 open state，也不显示工作耗时。
- 普通 Assistant turn 及缺少结构化元数据的旧 background turn 保持现状；旧历史不做文本猜测或迁移。
- navigator item 的必要条件是 turn 内存在可见 `UserInputRow(origin="realUser")`。assistant-only、background result、goal continuation、mailbox 和其它 synthetic role=user 输入全部排除；guided/queue-drained 只要投影为 `realUser` 仍保留。
- 该规则由共享 renderer 同时服务桌面和 Web；手机窄屏不显示 rail，但恢复出的 row 必须保留相同元数据。

## 验收与剪枝

- 接受：Agent idle wake、Bash idle wake、live/cold 同构、刷新后标题保留、navigator 数量与 preview 只来自真实用户轮次。
- terminal success/failed/stopped 共用同一展示规则，E2E 取代表路径，状态组合由 focused tests 覆盖。
- 剪枝：active-loop title 插入、无元数据旧会话迁移、通知文本解析、手机 rail 交互 E2E、terminal 状态全排列。
- 自动化至少覆盖协议/运行时元数据守恒、cold hydration、projection、两种 title 静态渲染、普通 turn 折叠回归、legacy fallback 和 navigator 严格过滤。
