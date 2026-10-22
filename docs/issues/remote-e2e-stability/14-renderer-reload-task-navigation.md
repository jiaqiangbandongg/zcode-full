# Renderer 重载后已就绪的远程任务无法切换

Status: ready-for-human

## 真实指针复验

业务基线不变，测试补丁 07；批次 `r3-server-20261011125749338-152f05` 的 `renderer`
在 143.5 秒后失败。这次按项目 identity 限定任务行，等待可见后使用 WebDriver 真实指针点击。
Main 仍为 A/B 两个原 session 各记录一次有效 reload ready ACK，2026ms 后 Renderer 可操作。

`beforeSelectingA` 表明当前页面为 B，导航缓存没有 A；真实点击 A 后缓存仍没有 A，active 仍是 B。
`afterSelectingA.panes` 只有一个可见 pane，sessionId 为 B 的
`session_18e17db7fc3de951f1952295a7f6d8cd`。因此这次失败不是只点了隐藏旧行，
也不是探针先读到隐藏 pane；真实可见页面没有切换。

当前任务导航链先调用 `ensureTaskNavigationWorkspace` / `activateTabByPath`；缺少远程 tab
有拒绝分支。这与“attachment 已 ready、导航缓存缺项、点击不生效”的事实相符，但没有足够
日志把唯一根因定位到该分支。修复需核对实际 attachment 与导航入口的交接，不能仅补一个无端口的假 tab。
本轮保留业务代码与失败断言。

```text
Renderer reload → A/B 原 attachment ready
  → 当前 B、缓存缺 A
  → 真实点击项目 A 的原任务
  → B 仍是唯一可见 pane（30 秒后失败）
```

证据目录：`packages/desktop/.e2e-artifacts/r3-server-20261011125749338-152f05-renderer/`。

## 首次发现与排除项

业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5`，测试补丁 06。
定向批次 `r3-server-20261011123601821-eca14c`，`renderer`，184.6 秒失败。

重载后 2232ms Renderer 可操作；Main 分别为两个原 remoteSessionId 写出了有效
`renderer-reload` ready ACK，因此不能继续把这个结果归为两个 attachment 未恢复。
用例从侧栏打开 A 成功，再以 task B 的 test id 触发 DOM click，30 秒后 primary pane 仍是 A。
失败视频末帧显示 A 的标题和首轮正文，不能只用缓存探针解释为界面已切换但检测错误。

B 的任务为 `session_bcb5ecb4a2c7bc043954b54e1f376f6c`。Desktop 日志确认重载时 B 的
conversation 订阅曾成功；切到 A 后 B 释放订阅，随后未见再次订阅 B。当前尚未确认未切换的直接原因。
代码阅读发现任务导航存在以 tab 激活结果判断远程准入的分支，但本次日志没有明确证明命中该分支，
不将其直接写成根因。

```text
Renderer reload → A/B 原 attachment 都 ready
  → 侧栏选择 A → A 可见
  → DOM 选择 B → A 仍可见（失败）
  → 下一步：限定项目的真实指针点击 + 记录前后 tab / 可见 pane
```

上述 DOM 操作疑点已由本页开头的真实指针复验排除。没有通过创建新会话代替原任务恢复。

证据目录：`packages/desktop/.e2e-artifacts/r3-server-20261011123601821-eca14c-renderer/`，
包含 `renderer-reload.json`、失败视频及 Desktop 日志。
