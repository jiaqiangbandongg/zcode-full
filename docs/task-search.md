# Task Search

侧栏“新建任务”下方提供“搜索”入口，快捷键为 `Cmd/Ctrl+K`。入口打开统一 Command Center；空搜索时展示当前任务最近变更、最近任务和分组命令，输入关键词后按命令、任务正文和文件匹配当前已打开 workspace 的 active 任务与文件。

搜索数据仍通过各 workspace scope 对应的 `zcodeTaskService.listTaskList` 获取：本地 workspace 通过本窗口
共用的 Local Host，并按 workspaceKey 隔离查询；远程 workspace 查询对应 remote session 所属的 Remote Host。
workspace scope 不代表独立 Host 进程。UI 不直接读取 session JSON，避免绕过 desktop / web remote 的服务边界。

为支持正文搜索，task sqlite 索引新增 `searchable_text` 字段。保存 task 时同步消息正文；旧会话在 schema migration 3 中从 session 快照回填。正文索引最多保留 200000 字符，避免长会话无限放大 `tasks-index.sqlite`。
