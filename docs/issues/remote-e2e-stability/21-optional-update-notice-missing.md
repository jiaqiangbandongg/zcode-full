# 兼容版本连接成功后，设备卡缺少可延后的更新提示

Status: ready-for-human

业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5`，测试补丁 07。
批次 `r3-server-20261011125749338-152f05` 的 `version-optional` 在 214.2 秒失败。
版本夹具使用完整当前 runtime，只修改编译版本与兼容元数据，不代表真实未来版本实现。

## 运行事实

首装版本为 `3.15.1`，夹具安装为 `3.16.0`、minimum=`3.15.0`。连接后 A/B 均恢复新 attachment，
最终远端仍为 `3.16.0`，没有发生强制降级。设备卡连续等待 30 秒后仍只显示已连接、SSH、
原 A/B 项目及断开/编辑/日志入口，没有更新提示或“稍后”按钮。
`version-policy.json` 保存了两个 restoredProjects 和完整 optionalPanelText；这次已排除
设置页刚挂载时读取单帧过早的问题。延后提示及重挂设置页的去重断言尚未到达。

```text
兼容的更高 Server 版本 → 原 A/B 恢复 → 打开远程设备设置
  → 30 秒内卡片仍无更新提示 → 无法验证“稍后”与去重
```

## 合同与边界

[设备卡更新合同](../remote-connection-ux/13-settings-device-cards-and-updates.md) 要求可选更新
使用中性横幅和“稍后 / 更新”，不弹 toast。当前兼容判定将版本不同且兼容的端点记为可选更新；
在本夹具版本关系下，更新方向应是桌面端，不能误称远端必须升级。
设置卡代码已有 `upgradeTarget=controller` 的分支，但当前页面没有收到或展示对应状态。
需继续定位连接兼容状态到设备卡的投影；本轮没有修改业务代码，也不把正常恢复的项目记为连接失败。

证据：上述批次 `version-optional` 的 `version-policy.json`、运行日志和失败录像。
