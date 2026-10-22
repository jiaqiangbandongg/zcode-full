# 06 · 会话

## 新建与恢复

普通 `--prompt` 默认创建新会话。成功的 JSON 输出包含 `sessionId`；恢复时保存并显式传回它：

```sh
zcode --prompt "继续检查上一步的文件" --resume sess_example --cwd /absolute/path/to/task --mode yolo --json
```

保持相同的数据目录和有效工作目录。`--continue`/`-c` 选择当前目录最近的会话，与 `--resume` 互斥；并发任务不要依赖“最近”来关联结果。

```text
首次 prompt → 新 session → 保存 sessionId 与运行记录
后续 prompt + resume → 加载历史 → 新 turn → 保存本次运行记录
```

恢复不意味着工作区文件、外部服务和插件状态自动回到历史时刻。需要精确复现时，另行保存仓库提交、文件快照和任务环境。`traceId`、`turnId` 应按每次输出原样记录，不要自行假定跨进程恢复后所有标识保持不变。

## 目标与工作流

`--target "目标"` 与 `--prompt` 互斥；已有目标需要替换时显式使用 `--target-replace`。它不是“执行一次普通 prompt”的等价写法。评测通常使用普通 prompt；需要持续推进目标或工作流时，应另设终止条件并保存其事件。

当前源码的工作流模式为 `disabled`、`onDemand`、`alwaysOn`，默认 disabled。不同模式会改变模型可见工具及运行过程，不要在一组比较实验中混用。

## 持久化与用量

默认 CLI 会话数据库位于 `~/.zcode/cli/db/db.sqlite`，可通过配置或环境变量重定向。数据库结构属于实现细节；不要把旧手册中的 SQL 表结构当成稳定 API，更不要直接删除或修改行来“重置任务”。

需要分析数据库时使用只读连接；备份活跃 SQLite 数据库使用 SQLite backup API，或先停止相关进程并处理 WAL 文件。只复制主文件可能漏掉尚未 checkpoint 的记录。

JSON 中的 `usage` 反映本次输出提供的用量统计。不同 provider 对缓存和推理 token 的上报可能不同，缺失值不等于零。不要用本次结果推算整段会话、后台任务或账号账单。

TUI 的斜杠命令与 headless 分发不同。自动化切换会话使用 `--resume`，模型使用[配置文件](03-config.md)，不要默认把 TUI 中的所有斜杠命令塞进 `--prompt` 都会执行。
