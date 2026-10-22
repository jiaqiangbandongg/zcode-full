# 设置页“在侧边栏中显示”未定位项目焦点

Status: ready-for-human

业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5`，测试补丁 07。
批次 `r3-server-20261011125749338-152f05` 的 `settings-safeguards` 在 153.1 秒后失败。

真实 SSH 项目已连接。设置页设备卡“更多 → 在侧边栏中显示”返回主界面后，
持续 10 秒没有把焦点交给对应项目。测试已经使用当前的 `data-project-workspace-identity`
读取焦点所属项目；不是继续查找旧测试 selector 导致的失败。

`SettingsPage.tsx` 的 `onShowInSidebar` 仍查询 `[data-remote-project-identity]` 与
`dataset.remoteProjectIdentity`，然后对其中 `[role="button"]` 调用 focus。
当前 `ProjectNode.tsx` 输出的是 `data-project-workspace-identity`，项目标题是
`data-testid="virtual-project-toggle"` 的原生 button。原查询无法取得新项目行，后续滚动和聚焦不执行。

[设备设置合同](../../architecture/remote-device-connection-ux-spec.md)要求此操作定位已有项目，
不依赖设备在线状态。应沿当前项目入口标识和可聚焦控件完成定位。本轮不修改业务实现，
保留用例的定位与焦点断言；后续移除确认步骤在此失败之后，尚未覆盖。

证据目录：`packages/desktop/.e2e-artifacts/r3-server-20261011125749338-152f05-settings-safeguards/`。
