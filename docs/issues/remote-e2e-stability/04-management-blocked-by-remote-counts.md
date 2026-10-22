# 远程 RPC 停滞时设备管理页无法显示已有设备与断开入口

Status: fixed; real SSH E2E verified (2026-09-26)

## 预期与实际

远端请求尚未返回时，用户仍需通过已保存的设备记录执行手动断开。
当前分支进入「远程连接」设置页后，只显示连接偏好和新建连接按钮，已有设备列表为空，无法断开已有 Source。

此问题阻塞 R3A-PRV-13 的真实「同步尚未返回时断开」验收；不能释放回包后再点击断开，或绕过 UI 调用内部命令后将该路径判为通过。

## 实际证据

- 业务基线：`54ece08f23f79ae54aea1f51e0d941497d627392`，未修改业务实现。
- 批次：`r3-server-20260924172343371-384821`，测试源码清单 `0fa28903814184a7dedf86882691a963d75096178722f4369add693a7f858462`。
- Source 已真实删除指定 Provider；Desktop 产品 SSH 回包被代理扣留 11772 字节，模型回放隧道与控制探针使用独立直连。
- Main 的同步结果数在提交前后均为 7，尚未收到本次结果；原 remoteSessionId 仍绑定。
- 打开设备管理后等待 30 秒未找到已保存设备的「断开」入口，测试失败。
- [失败前约 20 秒的视频帧](../../../packages/desktop/.e2e-artifacts/remote-stability-20260924/provisioning-management-stalled.png)显示设备区域为空。该帧位于清理动作之前，不是 `clearAppData` 后的空状态。
- [原始视频](../../../packages/desktop/.e2e-artifacts/remote-stability-20260924/provisioning-failure-smoke-01.webm)和 [受控注入事实](../../../packages/desktop/.e2e-artifacts/remote-stability-20260924/provisioning-failure-smoke-01-facts.json)保留了失败过程。
- 独立批次 `r3-server-20260924181553216-617c6a`（测试清单 `dd76d5be828b2dc4014c4fafc7b4c44630a963ecb1ad7b02ffeb7068d634964b`）先证明健康链路下已有设备和断开按钮可用。之后扣留 17200 字节，Main 结果数保持 18；31.247 秒后再次失败。失败现场确认本机 Source 记录仍存在，而页面只剩连接偏好与新建连接。
- [健康链路页面](../../../packages/desktop/.e2e-artifacts/remote-stability-20260924/provisioning-management-before-hold.png)与 [停滞后的页面](../../../packages/desktop/.e2e-artifacts/remote-stability-20260924/provisioning-management-pending-failure.png)均由用例在清理前直接采集；[完整事实](../../../packages/desktop/.e2e-artifacts/remote-stability-20260924/provisioning-failure-smoke-03-facts.json)还证明 PRV-12 写入失败只告警、本机成功反馈、连接保持和恢复后的再次保存均已完成。

## 代码定位

1. `packages/desktop/src/host/sourceServerManagementService.ts:getSnapshot` 先读取本机目录，再等待 `readMigrationCounts`，之后才返回整个快照。
2. `readMigrationCounts` 对在线 Source 等待 `getFailedPathCount()`、`getAbandonedPathCount()` 两个远端 RPC；这一读取没有独立截止或降级结果。
3. `packages/ui/src/hooks/useSourceServerManagementSnapshot.ts` 初始快照为 null，只有整个 `getSnapshot()` 完成后才展示数据。
4. `SourceServerManagementPanel` 的已有设备与断开按钮由快照生成，因此被迁移统计的未完成请求一起挡住。

上述调用链与实测空列表一致；当前实测只有一个 Source，尚未验证多个 Source 时的影响范围。

## 修复边界与验收

本机目录和连接状态应保持可读，远端迁移统计不可用不应阻塞手动断开。统计状态需要明确表达未取得数据，不能伪造为零。
修复后重新执行受控回包用例，保留 Source 已提交、Main 尚未收到结果的前置条件，再通过真实 UI 断开并验证旧 RPC 释放、离线修改及重连后的最新配置。

## 根因修复与验证（2026-09-26）

用户明确授权根因修复后，移除了 `getSnapshot()` 对远端统计的等待。Host 管理服务先返回
本机 Directory 与 Manager 的一致快照；[统计投影](../../../packages/desktop/src/host/sourceServerMigrationCounts.ts)
按当前物理连接独立读取计数，`loading` / `unavailable` / `requires-connection` 都不携带伪造的零值。
只有 `available` 包含经过 schema 校验的真实计数，顶层总数仅汇总这些已知项。

```text
Directory / Manager → 本机一致快照 → 设备列表与断开按钮
当前连接的统计 RPC → 独立完成 → 检查连接和投影仍有效 → generation / 目录事件 → 补全统计
```

同一连接至多一组统计请求在途；一项失败也等待该组另一项收口。在途失效合并为后续一次读取，
不会因连续目录事件积累挂起请求。换代、删除、dispose 后的旧结果不发布；目录变化与迁移
重试/放弃会使计数失效。显式进入或刷新页面请求更新统计，事件触发的刷新只读已有投影，避免
形成反馈轮询。该可选请求参数和返回状态在共享契约中严格校验。

修复没有改变 Provider apply、身份持久化、远端 Server/Agent 协议或 desktop continuous /
mobile replayable 路由。统计投影只在 Host 内存中存在，不增加持久化格式或迁移；回滚需一起
撤销 Host 实现、共享管理契约和 UI hook，会恢复原来的远端统计阻塞风险。

验证证据：

- 有效 UUID 夹具在旧管理服务上运行，4 项回归均失败；修复后相关 10 个测试文件共 121 项通过。
  覆盖慢 Source 不阻塞另一个 Source、手动断开、读取合并、错误状态、显式刷新、在途刷新合并、
  连接换代、Source 移除、dispose 和迟到结果。此前无效 UUID 夹具造成的失败不计作根因证据。
- 类型检查、E2E 类型检查、架构检查通过；lint 为 0 错误、65 个原有警告。
- 最终版本以业务基线 `362a5dd23304d1aed78d8e961bc12e3205123909` 加修复补丁执行，输入清单
  SHA-256 为 `bd8b2ccd0a86748a035cb2c7794df41ce3d25512c616035141158c529aa9c22c`。
  批次 `r3-server-20260926013327721-60bf25`、`r3-server-20260926014117100-b67658`、
  `r3-server-20260926014430621-fefb7b` 的 `provisioning` 全部 PASS，分别约 215、187、184 秒。
  第一批同时验证了 `devicerow`、`uninstall`，均 PASS。
- 三轮均确认 Source 已提交、Main 结果数仍不变且代理仍扣留约 17 KB 回包；随后通过原 UI
  手动断开。原用例没有改变断言或提前释放回包，离线修改不下发、重连同步两次修改、A/B 工作区
  恢复以及 PRV-12 写入失败恢复均完成。

真实 E2E 覆盖一个 Source 的两个工作区；多个 Source 的相互隔离由真实管理服务的单测证明。
逻辑断开后代理仍可能转发先前缓冲的加密 SSH 字节，不能把它描述为“所有传输字节都被丢弃”；
旧 RPC 拒绝的生命周期契约另由 `serverRemoteConnectionLifecycle.test.ts` 的真实连接测试覆盖。
本修复未宣称其他业务问题或原生编辑器平台覆盖已完成。
