# 远程项目从符号链接创建任务后未收敛到 realpath identity

Status: ready-for-human

## 复现与运行证据

业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5`，test 构建。
批次 `r3-server-20261011105317614-4a6780`，`sourcelines`。

1. 同一 SSH Source 上创建真实目录 A 和指向 A 的符号链接。
2. 为 A 创建远程项目，并从项目创建草稿，得到 canonical workspace attachment。
3. 为符号链接创建另一个项目，再从该项目创建草稿。
4. 等待当前执行 identity 收敛到 A，60 秒后仍失败。

运行日志在 19:00:51 记录 Host `bound remote workspace context` 的路径为
`/home/dev/r3-workspace-link`，sessionId 为 `5fd8a173-9662-4a51-8970-602e7b97a241`。
Main/Renderer 随后使用 `remote:server:<同一 Source ID>:/home/dev/r3-workspace-link`。
失败快照中 active identity/path 仍为链接路径；原 A 的 tab 保持
`remote:server:<同一 Source ID>:/home/dev/r3-workspace-a`，sessionId 为
`569d26f6-a878-4c6e-998e-733fa916ce0e`。

```text
项目 A root = realpath → workspace A / attachment 1
项目 B root = symlink → workspace link / attachment 2
预期：项目可以不同，执行 workspace 经远端 realpath 收敛为同一个 A
```

## 合同与影响

[R3 身份合同](../../architecture/r3-source-server-remote-architecture.md) §3.2 要求打开 workspace 前
在远端执行 realpath，避免 symlink 别名产生两个身份。
[当前项目合同](../../superpowers/specs/2026-10-10-session-manage-upstream-integration.md) 允许多个项目共享目录，
因此旧 case 的“不能出现第二个项目”断言已迁移；允许多个项目不等于允许同一真实目录产生多个执行 identity。

现象确认于 Host 绑定日志与 Renderer 快照，不能仅解释为旧项目数量断言或侧栏 selector 失效。
影响同一目录的 attachment 复用与任务运行上下文归属。具体漏掉 realpath 的调用点仍需业务修复时定位；
本轮不修改产品代码，也不把预期路径改成 symlink 来消除失败。

证据目录：`packages/desktop/.e2e-artifacts/r3-server-20261011105317614-4a6780-sourcelines/`；
对应 run log 保留在同批 `r3-server/run-logs/`。测试 helper 已补项目 identity 的严格就绪检查，
该补丁尚待同基线复验，不将静态检查算作 E2E 通过。
