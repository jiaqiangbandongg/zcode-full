# 单个工作区历史冲突阻塞整个远程项目选择页

Status: ready-for-human

业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5`，测试补丁 07。
批次 `r3-server-20261011125749338-152f05` 的 `history-conflict`：旧程序自然生成两条线路历史，
测试仅在 A 目录注入 canonical/source 任务身份矛盾，再切回当前程序连接。
该次原始用例最终在 880.0 秒后失败，退出原因是 helper 的“SSH 部署/连接没有完成”。
同批 `history-conflict-sources`（两个 source 之间的身份矛盾）也在 865.2 秒后以相同等待超时退出；
其独立失败录像同样显示 A 的 `SourceServerWorkspaceIdentityConflictError`、空项目列表和禁用的新建按钮。
两种注入均在首次正常目录 B 的项目选择阶段被阻塞，尚未进入后续冲突处理动作。

测试先请求打开未冲突的 B 目录。真实运行中的只读 WebDriver 探针在 21:46 后确认：
SSH 连接向导已关闭，“添加远程项目”页显示
`SourceServerWorkspaceIdentityConflictError: Source Server workspace task identity conflict`，
错误指向 A；“新项目”按钮禁用，没有任何项目可选。因此用例尚未到达 A 的冲突处理页、
重试或放弃合并断言，也没有证明 B 仍可独立使用。

```text
仅 A 历史注入冲突 → Source 连接成功 → 读取整个项目树
  → A 冲突使项目树请求失败 → 项目列表为空、新建禁用
  → 不能先打开正常目录 B
```

[R3 迁移合同](../../architecture/r3-source-server-remote-architecture.md) 要求失败按 workspace
粒度阻止打开，不阻塞连接；当前项目模型仍需提供无冲突项目的进入路径。
`RemoteProjectPicker` 的 `service.readTree` 整体失败后只展示 error 并禁用新建；应核对
远端项目树读取与惰性历史迁移的边界，不能通过忽略冲突或删除旧历史恢复可用性。

本轮未修改业务实现。测试 helper 会在项目页出现明确错误时立即报告原始原因，
避免把永久禁用误判成仍在加载而空等 10 分钟。补丁 08 的批次
`r3-server-20261011143037600-31012b` 已验证此优化：同一 `history-conflict` 场景在 328.2 秒
结束，并明确报告上述身份冲突，原批次为 880.0 秒。两次都保留自然历史生成和冲突夹具，
业务失败仍记 FAIL；不同批次的总耗时差不等同于固定安装阶段的性能比较。
同一补丁的 `history-conflict-sources` 为 304.8 秒，原批次为 865.2 秒，也立即报告相同的项目页冲突。

证据：上述批次 `history-conflict` 的 run log、`upgrade-history.json` 与失败录像；
只读探针返回 picker=true、disabled=true 及上述页面文本。
