# Session 停止来源诊断

Todo103 G13-B；来源 `8e3e10df4d`、`ee30f2ad33`。

## 契约

- Composer 停止按钮标记 `button`，当前聚焦 Pane 的 Esc 标记 `escape`。
- 沿用现有 `canStop`、弹窗 / 已消费 Esc、只读 Pane 和前台执行 ID 防护，不增加停止入口，不改变命令协议。
- 发出命令与无可停执行而跳过两条路径均走 `logger.lifecycle.info`；发送失败走 `logger.lifecycle.warn`。普通 `logger.info` 在生产构建禁用，不能承担误停归因。
- 仅记录来源、Session ID 和已存在的前台执行 ID，不记录提示词、模型凭据或消息正文。一次停止操作记录一次，不按流式事件打印。
- 日志表示“尝试发出命令”，不表示 Agent 已接受或已终止；最终状态仍由原有命令 ACK / Session 投影负责。

```text
停止按钮 / 未被消费的 Esc
             |
             v
现有 Pane / canStop 防护
   ├─ 不可停止 -> 跳过日志，不发命令
   └─ 可停止 -> 来源日志 -> 原 stop 命令（原执行 ID）
                               └─ 发送失败 -> 生命周期 warning
```

## 验证

1. 真实挂载 SessionPane，点击 Composer 回调：命令仍携投影中的执行 ID，并记录 button 来源。
2. 不可停止的 Session：不得发 stop 命令，记录 skipped 来源。
3. Logger 生产分支测试：lifecycle 经桌面桥转发，普通 info 不转发；无桌面桥不抛错。
4. 既有停止 / 队列 E2E 保留，最终整合时复验；本项不改变桌面 continuous 或手机 replayable 的路由及状态语义。
