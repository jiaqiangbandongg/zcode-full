# 连接向导 case 误用项目创建入口

Status: done

## 原因与修复

业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5` 下，项目区创建通过 `ProjectConnection`
只选择 Host，随后进入 `RemoteProjectPicker`。设置页“新建连接”才是保留三屏目录步骤的独立向导。
旧 `boundary` case 经共享项目入口连接，却继续等待旧向导的 `remote-boundary-hint`，因此误报提示缺失。

批次 `r3-server-20261011101534847-c8a52a` 和 `r3-server-20261011102656782-52518d` 的录像均显示
“添加远程项目”列表，而非该 case 要验证的目录页。修复让向导专项显式选择设置入口，并沿真实
目录选择、项目保存和项目内新任务流程继续；普通 SSH 业务 case 保留项目入口。

## 复验与边界

- 回归测试先证明旧 helper 忽略入口选择、仍走项目路径，修复后通过。
- `r3-server-20261011104332183-3a0c00` 的 `boundary-ack.json` 实际记录首次说明文本、项目 A identity、
  `secondProjectHintAbsent=true`；onboarding 版本保持为 2。
- 原提示缺失不是设置连接向导的业务缺陷。新版项目路径是否也需承接同一说明属于独立产品讨论，
  本轮不据旧 case 的入口错误修改业务或删除提示断言。
- 完整 case 仍 FAIL：冷重启后保存连接缺少凭据，见[问题 11](11-ssh-credential-missing-after-restart.md)。
  不把前半段通过描述为整个 case PASS。
