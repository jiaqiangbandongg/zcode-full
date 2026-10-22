# 启动存储屏障

main 只调度启动，由此 adapter 调用现有 resolver 定位的 CLI 执行 `storage-migrate`。数据库路径和迁移 SQL 归 CLI；此模块不打开数据库，也不启动 app-server、模型、MCP 或 session。

保留 executable/runtime 前缀参数（含有空格的 bundle 路径），移除 app-server/agent-server 及其运行参数，使用参数数组执行，禁止 shell 拼接。环境由启动入口与 resolver 注入，保留自定义 dataBaseDir。命令不符合原 Agent 约定时拒绝，不猜测 wrapper 行为。

成功要求子进程零退出并返回版本化严格 JSON；共享 schema 校验后返回 migration 结果。非零退出或解析失败传播到 main 已有重试/备份/退出交互。无超时重启或重试队列；SQL runner 自己处理幂等、锁和回滚。输出限额防失控，不按数据库大小设置执行截止时间。

时序：app migration → CLI storage-migrate → 两者成功 → scheduler/Host/window。两个库不宣称跨进程原子事务；重试依赖每库 ledger，未知未来 id 和校验和规则仍由公共 runner 执行。
