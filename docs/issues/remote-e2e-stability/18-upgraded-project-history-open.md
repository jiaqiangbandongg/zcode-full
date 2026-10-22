# 旧版项目历史打开：测试交互修正

Status: done

## 补丁 08 的复验进展

批次 `r3-server-20261011143037600-31012b` 中，`history-single` 和 `history-merge` 使用项目内
可见行的真实指针后，分别打开并续聊了 1 / 2 个原 taskId。导航快照的 canonical identity、active pane
与原 taskId 一致；多线路还通过 completed ledger 和备份断言。因此原疑点不再列为已确认业务缺陷。
业务代码未修改。旧版回退的测试入口修正后，补丁 09、批次 `r3-server-20261011150809016-2aeaba`
两例均完整通过：single 275.9 秒、merge 310.0 秒。覆盖原历史续聊、真实旧程序回退；多线路还
核对两个旧线路实际读取后合并数据仍保留。整体 history 用例现已计为 PASS。

## 首次疑点

当前业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5`，旧版夹具为
`7a6e2eb3f1946aba9155155178e86cd947cee655`。测试补丁 07，批次
`r3-server-20261011125749338-152f05`：`history-single` 258.3 秒失败，
`history-merge` 281.5 秒失败。

旧版真实程序生成任务后，升级至当前版，再从项目列表加入迁移后的原 projectId。
远端数据库中的任务 project_id、项目和原 root 均已核对；没有新建同目录“(2)”项目来替代旧项目。
任务行出现，但点击原任务后 30 秒内没有对应 session pane。单线路录像停在“连接中 / 设备未连接”，
多线路则仍是空草稿。日志中单线路的新 Main 在 21:42:00 收到一个 workspace-context-bound
ready，但缺少原任务的新订阅记录。不能把 Source 连通直接视作旧工作区与任务已成功恢复。

```text
旧程序自然生成历史 → 当前程序连接并迁移 → 加入原项目
  → 旧任务行可见 → 点击 → 原任务 pane 未出现
```

首次结果不足以定位身份重键、attachment 发布、任务导航三者中哪一步失败，也不能证明数据丢失。
当时后续旧任务续聊和旧程序回退尚未到达。测试补充项目内可见行的真实指针操作，并记录点击前后的
项目 identity、连接状态、导航缓存和可见 pane；业务实现保持不变。

证据位于上述批次的 `history-single` / `history-merge` 用例目录，含 `upgrade-history.json`、
失败录像和 Desktop 日志。[Renderer 重载任务导航](14-renderer-reload-task-navigation.md) 的业务失败仍独立跟踪。
