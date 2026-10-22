# 手机远控首页被职业引导覆盖

Status: needs-triage

## 2026-10-11 基线复核

业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5` 的全量批次
`r3-server-20261011105317614-4a6780`，`soakdual/mobile-initial.json` 已显示真实远程项目、
原任务 ID 和首轮消息，`failures=[]`，没有 `onboarding-page`。本次 146.2 秒失败由配对 helper
继续等待已退役的“已连接到当前桌面窗口”文案引起，不是以下旧引导问题的再次复现。

测试改为等待调用方指定的任务/项目节点，再由原 case 核对 Desktop 的手机连接状态；
空侧栏不算成功。草稿专项使用原 projectId 的新建任务入口，继续要求零模型消息。
单测已复现旧提示缺失并验证新就绪判据；真实手机后续链路与 10 分钟长稳仍待复跑。
以下旧基线证据保留，本轮不据旧问题直接判定手机仍被引导阻塞。

## 预期与实际

[手机远控合同](../../web-remote-control/web-remote-control-architecture.md)要求扫码后进入任务首页，浏览当前桌面窗口的工作区和任务。
在当前分支上，手机浏览器已加载同版本 Web 资源并进入 home-only Root，却显示三步职业引导，任务首页与配对状态文案被覆盖。
这使 `mobile`、`mobileperm` 无法继续验证任务切换、权限和断网恢复；不能用跳过引导或播种手机状态把这些路径标为通过。

## 实际证据

- 业务基线：`54ece08f23f79ae54aea1f51e0d941497d627392`，未修改业务代码。
- 批次：`r3-server-20260924051309226-ac32d1`，服务器 `/home/e2e/z-code-stability-20260924`。
- `mobile` 与 `mobileperm` 各自使用独立 Desktop HOME、容器和 Playwright context，均等待首页失败。
- 两份 `mobile-pairing-1.json` 都记录 `testIds: ["onboarding-page"]`，正文为「工作方向 / UI 模式 / 助手偏好」，资源加载错误数组为空。
- 独立批次 `r3-server-20260924054830817-45203b` 的 `soakdual` 也出现同一页面，199 秒后失败；尚未进入 10 分钟观测，不能据此宣称稳定性已验证。
- 当前分支 Web 构建由测试宿主 loopback 托管，HTML 和 JavaScript 实际返回 200；真实 test relay 与产品配对流程保持不变。
- 本地证据：[mobile](../../../packages/desktop/.e2e-artifacts/remote-stability-20260924/mobile-pairing-recheck07.json)、[mobileperm](../../../packages/desktop/.e2e-artifacts/remote-stability-20260924/mobileperm-pairing-recheck07.json)。完整产物保留在服务器 `.e2e-artifacts/<batch>-<case>/`，不含公开配对凭据。

## 代码定位

1. `packages/web/src/main.tsx` 的 `renderExternalRelayHomeOnlyRoot` 使用 `createHomeOnlyWebRemoteControlServices()`；其 settings 只有 recentProjects/locale，未提供 onboardingRecordService。
2. `packages/ui/src/Root.tsx` 在桌面和手机路径都用 `OccupationOnboarding` 包裹 workspace/home 内容。
3. `packages/ui/src/onboarding/useOnboardingTrigger.ts` 在记录服务不存在时回退到 `!hasStoredOccupation`，因此 home-only 服务触发引导。

以上是与实机结果一致的调用链定位；尚未修改实现，也未将其归因于 relay 或 SSH 失败。

## 复现与验收

在已准备好的远程 harness 运行 `node harness/remote/run-queue.mjs mobile mobileperm`。
修复应保留手机首页的只读空服务边界，不能为了初始化首页创建独立 Host/Agent 或强制连接工作区。
随后验证 fresh context、再次配对及断开工作区首页均能进入任务列表，并继续完成原 mobile/mobileperm/soakdual 断言。

另一个独立环境问题是已发布测试站点 `/remote/v4?app_version=3.12.2` 的脚本 404，见 [harness 记录](../../../harness/remote/README.md)。该 404 与本 Issue 的同版资源引导覆盖不能混为一谈。
