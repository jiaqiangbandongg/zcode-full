# 后续任务：Host tasks-index 初始化可观测性

> 最新范围：已并入 [Todo 145：进入 ZCode 前统一准备数据库](./todo-145-global-database-startup-loading.md)，不再单独延后。以下为前轮范围记录；Repo 构造与实际打开/迁移的时机须按新 TODO 重新核对。

状态：待单独设计；不纳入 Todo 144 本次会话库 hotfix。

2026-09-14 用户讨论改动规模后确认先完成会话库范围。
Host 部分 Repo 在服务发布前同步打开或迁移 tasks-index.sqlite，届时会话库状态服务尚不可用。
必须先设计状态提供方、数据库执行线程、依赖服务的准入顺序、后台 scheduler/bot 启动以及失败重试边界，再实现。

- [ ] 梳理 AutomationRepo、OffPeakTaskRepo、TaskIndexRepo 的初始化和迁移时机。
- [ ] 决定迁移 Worker 或延迟服务初始化方案；Main 保持调度/透传职责。
- [ ] SQLite 保持同一物理库的唯一迁移协调者，避免再加 Host 迁移锁。
- [ ] 服务发布前即可观察阶段；依赖 Repo 的业务只能在事务提交后开放。
- [ ] 验证多窗口、远端 Host、手机 shared-host、崩溃/重连及失败恢复。

会话库和任务索引是不同文件，各自的锁与完成状态不能混用。
