# 远程 UI 设计入口

旧设备分组、五步向导、四态颜色和手动模型同步设计已退出。当前合同分别由以下文档维护：

- [连接 UX](../architecture/remote-device-connection-ux-spec.md)：三屏向导、统一五态、错误、设备卡、日志和无障碍。
- [项目导航](../remote/project-first-remote-navigation-spec.md)：平铺项目、详情、原地重连和导航恢复。
- [设计规范](../../DESIGN.md)：语义 token、字号、尺寸、主题及可访问性。
- [Provider Provisioning](../remote/provider-provisioning.md)：本地编辑与自动下发，无远端模型编辑或手动同步入口。

远程无项目聊天 UI 已停用；历史数据保留。项目在线图标和未连接状态采用中性展示，
“需要处理”使用警告；完整优先级只在 UX 五态表维护。

原型未入库，不能作为可重放验证证据。历史 §20、RUI-SIMPLE 编号、评审及旧待定问题见固定快照：

```bash
git show a17a875588b8d66c2bee49236292e174df651363:docs/design/r3-remote-ui-redesign.md
```

仍未决事项统一见 [R3 问题台账](../architecture/r3-source-server-remote-open-issues.md)，
实跑与 pending 状态见 [覆盖矩阵](../testing/conversation-session-e2e-coverage-matrix.md)。
