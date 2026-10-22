# 远程主目录失效后原任务历史无法打开

Status: ready-for-human

业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5`，测试补丁 07。
批次 `r3-server-20261011125749338-152f05` 的 `directory-missing`、`directory-file`、
`directory-denied` 分别在 188.4、191.2、190.0 秒失败，均停在打开失效目录 A 的原任务。

补丁 08、批次 `r3-server-20261011143037600-31012b` 已用项目内可见任务行的真实指针复验三种变体。
三份 `historyNavigation` 均记录 expectedTaskId=A，但只有一个可见 primary pane，仍绑定 B；
A 的 path/identity 保留而 remoteSessionId 为空。已排除全局 DOM click 选错隐藏行的解释。

## 运行事实

三个场景分别移走主目录、把主目录改成普通文件、撤销独占父目录遍历权限。权限场景确认
非特权 Core 和访问探针实际得到拒绝。Source 重连后 B/C 已恢复新 attachment，B 成功续聊。
A 的项目入口和任务行保留，新建任务与文件按钮禁用，目录不可用提示正确。

点击 A 原任务后，primary pane 连续 30 秒仍显示 B 的首轮及续聊消息。missing 的录像末帧
也显示 B；快照中 A identity/path 保留，但没有 remoteSessionId。Desktop 日志未提供足够
导航事件，不能据此认定唯一根因，也不能宣称 A 的数据已丢失。

```text
A/B/C 在线 → 断开 Source → A 主目录失效 → 重连
  → B/C 恢复，B 可续聊
  → A 禁止新建/文件，任务行保留
  → 点击 A 原任务 → 页面仍为 B
```

[主目录可用性合同](../../project-primary-root-availability.md) 要求历史读取不依赖目录存在，
不能为读历史重建目录。当前结果未满足此项；后续目录修复与原任务续聊尚未到达。
业务代码未修改。与 [Renderer 重载导航问题](14-renderer-reload-task-navigation.md) 的关系尚未确认。

证据位于上述批次的三个 `directory-*` 用例目录，包含 `directory-resilience.json`、失败录像与日志。
