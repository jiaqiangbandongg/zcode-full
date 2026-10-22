# 收起连接向导后主界面没有进度卡

Status: ready-for-human

业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5`，补丁 09。
批次 `r3-server-20261011150809016-2aeaba` 的 `three-screen` 在 141.0 秒失败。
独立 TCP 目标已接受连接并停在握手中，点击“收起”后返回主界面，确认项目区可见；
5 秒后仍没有 `remote-connection-minimized`。录像显示正常主界面与项目行，排除了只在设置页找侧栏卡片的前置错误。

[三屏向导合同](../remote-connection-ux/10-three-screen-wizard-and-selection.md) 要求收起后在项目区显示
持续进度，失败结果保留并可恢复向导。
当前 `RemoteConnectionMinimizedProgress` 在没有 slot.container 时直接返回 null；
源码保留 Slot 定义与 Root provider，但没有找到当前项目侧栏对 `RemoteConnectionProgressSlot` 的挂载。

```text
连接 pending → 收起向导 → 返回项目区
  → 未注册进度容器 → 没有进度卡，也没有该卡片的恢复入口
```

本轮不修改业务实现。此结果不证明连接被取消；后续“后台失败留存、恢复查看、不重复拨号”断言
因进度卡缺失而未到达。走查用例的后台进度段也观察到相同缺失，须记为段落失败。

证据：上述批次 `three-screen` 的失败录像和日志；补丁 08 走查的 `index.json` 保留后台进度段失败。
