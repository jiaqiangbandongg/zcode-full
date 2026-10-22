# 版本门禁详情没有说明应升级桌面端

Status: ready-for-human

业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5`。版本夹具使用当前 runtime 的编译版本元数据变体，
Server=`3.16.0`、minimum=`3.16.0`，Desktop=`3.15.1`。

## 运行证据

补丁 07 的 Host 日志明确拒绝项目连接：`ZCode Desktop 3.15.1 must be upgraded to at least 3.16.0`。
主页只显示“需要处理 / 请查看详细信息并按提示处理后重试”。测试随后补齐真实详情操作。

补丁 08、批次 `r3-server-20261011143037600-31012b` 的 `version-controller-required`
在 223.4 秒后失败。已点击横幅的“详细信息”，并尝试展开可见技术详情；弹窗文本仍只有
“需要处理 / 需要更新 / 请查看详细信息并按提示处理后重试”，没有桌面端、所需版本或对应动作。
录像与 `controllerGuidance` 一致，已经排除“未打开详情便扫描主页”的测试问题。

```text
Host 正确拒绝旧 Desktop → 主界面要求查看详情
  → 打开详情 → 仍让用户查看详情，没有说明升级对象
```

同页路径标签直接显示 `workspaceSidebar.projectPath`，也是可见的文案缺失。
最终远端版本仍为 `3.16.0`；原归档 SHA 不变的后续断言尚未到达，不将版本字段当作完整归档验真。

## 处理范围

应保留正确的兼容门禁，把已有 controller 升级方向、最低版本和可执行动作传到当前项目详情 UI。
不应降级远端，也不应让用户在没有方向的“需要更新”中猜测。与
[兼容版本的可选提示缺失](21-optional-update-notice-missing.md) 分开记录；本轮业务代码未修改。

证据：补丁 07 的 `version-controller-required` Desktop 日志；补丁 08 同名用例的
`version-policy.json`、失败录像和日志。
