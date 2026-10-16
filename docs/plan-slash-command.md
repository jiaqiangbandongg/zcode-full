# `/plan` Composer 快捷命令

## 目标

为桌面端、Web 端和手机 `/remote` 的 V4 Composer 提供可发现的 `/plan` 快捷命令，
把“切换到 Plan 模式”和“提交一个任务”组合成一次输入操作。

本命令只属于 App Composer 表面，不扩展 CLI TUI、`--prompt` 或 headless 输入入口。

## 语法与结果

| 输入                                       | 结果                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `/plan`                                    | draft 更新 renderer draft mode；已有 session 发送 `switchCollaborationMode(plan)`；不发模型请求。 |
| `/plan <task>`                             | 先完成 mode CAS，再按普通 `sendText(<task>)` 发送；provider 和 transcript 只看到 `<task>`。       |
| `/plan` 或 `/plan <task>` 携带附件/context | 显式提示首版不支持，保留输入、附件和 context，不切换模式、不发送。                                |
| 其他文本（例如 `/planner`）                | 按普通文本处理。                                                                                  |

参数名称大小写不敏感，任务正文去除首尾空白但保留内部换行与内容。
命令被消费后，Composer 清空命令输入；`/plan` 本身不生成 user transcript row。
原始命令可以保留在本地 prompt history，但不得进入 provider prompt 或 conversation transcript。

## 状态与失败边界

```text
Composer submit
      │
      ├─ attachments/context -> unsupported toast -> keep draft
      │
      └─ text only
           ├─ draft
           │    ├─ update current Composer Draft mode to plan
           │    └─ task present -> create/prewarm config mode=plan -> send task
           └─ existing session
                ├─ switchCollaborationMode(plan)
                ├─ accepted/noop/duplicate
                ├─ no task -> done
                └─ task -> ordinary sendText(task)
```

配置命令与发送命令继续使用现有 config barrier。CAS stale 使用已有有界重试；如果最终不是
`accepted`、`noop` 或 `duplicate`，返回 `blocked`，不清空 Composer，也不发送任务。
已处于 Plan 模式时，mode CAS 以 noop 收敛后仍允许发送任务。

draft 的 `/plan` 与工具栏模式切换共享 renderer draft preference；已有 session 的切换不会改写
后续 draft 默认值。running/queued 输入仍由 CLI runtime `CommandInbox` 按现有 FIFO 接纳，
不会创建 `/plan` 专用队列或 mode snapshot。

## 跨端边界

desktop local/remote workspace 继续使用可信 `desktop-continuous` attachment，手机 `/remote`
继续使用可信 `web-remote-replayable` attachment。两端复用同一 Composer 命令顺序，但不改变
relay、desktop main、Host、workspace identity、remoteSessionId 或 replayable snapshot/gap 责任。

不新增 V4 wire command、协议字段、持久化结构或独立 runtime。

## 验收证据

- slash catalog 显示 `/plan [task]`，选择后插入 `/plan `。
- draft 空命令只改变模式；已有 session 空命令不产生模型请求或 user row。
- 带任务时 mode CAS 先于 `sendText`，provider/transcript 只出现任务正文。
- CAS 失败、附件/context 拒绝均保留完整 Composer 状态。
- desktop continuous 与 mobile replayable 只在 delivery profile 上不同，最终命令语义一致。
