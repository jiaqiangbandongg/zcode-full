# 自动重连执行三次，但项目页不显示重试进度

Status: ready-for-human

业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5`，测试补丁 07。
批次 `r3-server-20261011125749338-152f05` 的 `retry-budget` 在 122.7 秒失败。
真实 TCP gate 中断连接并拒绝后续连接；`retry-budget.json` 记录拒绝次数为 3，
整个重试期间的 DOM MutationObserver 没有观察到任何 `1/3`、`2/3`、`3/3`。
项目最终已处于 offline，并显示连接错误入口。

```text
真实断线 → 三次 TCP 重连均被拒绝 → offline + 错误入口
  └─ 页面观察：进度计数始终为空
```

[连接展示验收](../remote-connection-ux/12-sidebar-header-and-menus.md) 要求展示“自动恢复 2/3”
这样的进度。当前 `ProjectConnectionStatus` 只接收 connecting/error/logs，连接中仅显示 spinner；
`RemoteConversationBanner` 虽获取 presentation，却没有渲染其中的 recovery 计数。
本次只确认项目/会话页面缺少进度，不声称设置页也没有，更不把它误报为后台没执行重试。

本轮保留业务实现。测试将此非前置的展示断言移到场景末尾，保留失败要求，同时继续验证
网络放通后的静默恢复与手动接管。补丁 08 的批次 `r3-server-20261011143037600-31012b`
已完成这两段：静默恢复和手动接管分别获得不同的新 session，Host 数量保持；最后仍因
displayedAttempts=[] 失败（276.8 秒）。因此当前剩余缺陷是可见进度，后台恢复路径已有独立通过证据。

证据：上述批次 `retry-budget` 的 `retry-budget.json`、run log 和失败录像。

2026-10-15 进展：项目行远程身份详情顶部新增连接进度区，读取状态注册表的 `recoveryAttempt/Limit` 显示“自动恢复 n/3”。
`retry-budget` 改为连接中打开详情并保持到终态，`hovercard-retry-20261015-r3` 观察到 `displayedAttempts=[1,2,3]` 并 PASS。
项目行本身按已确认设计只显示“连接中”，不常驻计数；会话横幅仍未渲染 recovery 计数，是否补充待人工确认。
