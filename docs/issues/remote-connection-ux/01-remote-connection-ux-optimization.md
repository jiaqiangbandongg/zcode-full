# 远程连接交互与视觉体验优化

Status: in-progress

2026-10-10 汇总：12 张实施子票为 done；ssh-agent/默认密钥评估仍为 ready-for-human，
不自动安排或实现。父票保留原问题范围与待决事项，不复制正式规格的状态表、错误表和流程。

2026-10-12 新增 [15 — 项目创建与远程连接管理分离](15-project-device-selection-and-connection-management.md)，
Status 为 ready-for-agent。该票是下一轮已确认的交互目标，尚未实施；下文范围描述保留 02–14 批次的原合同，
15 对入口、连接完成去向和草稿返回的替代范围以其正文为准。

## 问题与当前规格

原问题为连接错误难理解、状态不一致、首连路径过长、断线后内容与恢复入口缺失，以及设备管理和视觉规则分散。
当前事实分别由以下文件维护：

- [连接 UX](../../architecture/remote-device-connection-ux-spec.md)：五态、错误、三屏向导、设备卡、日志、安装预览、更新与无障碍。
- [项目导航](../../remote/project-first-remote-navigation-spec.md)：平铺项目、保留目录意图、原地重连、导航恢复与历史数据边界。
- [R3 主规格](../../architecture/r3-source-server-remote-architecture.md)：身份、Host/Source 权威、版本和迁移。
- [设计规范](../../../DESIGN.md)：主题、语义色与组件尺度。

### 范围与边界

- **以交互流程为范围**，不改领域模型、连接状态机和任务协议语义；仅允许下列明确列出的契约扩展。
  - `sourceServerId`、Connection Profile、workspace identity 三层模型保持不变。
  - "平铺项目 + 连接后选目录"的导航合同保持不变。
- **允许的契约变更限定为以下五项**（第 4、5 项于 2026-09-29 经用户确认，服务于 [11 — 连接中屏与选目录屏](./11-connecting-and-directory-screens.md)）：
  1. 连接错误码集合扩展。
  2. 服务层新增"读取设备最近一次操作日志"。
  3. 更新提示的去重记录改为持久保存。它属于 UI 本地偏好，不涉及协议。
  4. 管理快照提供只读安装预览：发布版本、远端实际安装路径和安装包大小。包大小不冒充解压后占用。
  5. 提供只读远端运行任务清单：沿既有任务 owner 的活动投影，经 `running-tasks --json` 和管理快照交给强制更新确认界面；不支持该能力的旧远端明确显示清单不可用。
  - 第 4、5 项不改变任务运行、连接状态机、持久化 `status.json` 格式、工作区身份隔离或桌面 `continuous` / 手机 `replayable` 恢复语义。
- **进度日志收窄和脱敏**属于主进程和 host 侧的行为修复，不新增契约。
- **ssh-agent 和默认密钥暂不承诺。** 支持 config 中的 IdentityFile/IdentityAgent、默认 `~/.ssh/id_*`、ssh-agent（Windows 上是 OpenSSH agent 管道或 Pageant）需要单独评估服务层改动量和跨平台差异，评估结果交用户决定是否排期。
- **只改桌面端。** 手机 Web `/remote` 不调整，只做回归，保证不回退。
- **只影响桌面端的恢复。** 涉及恢复时序的改动只作用于桌面 `continuous` 恢复，手机 `replayable` 的恢复边界不变。

## 子任务与证据

| 子任务                                                                                      | 记录状态        |
| ------------------------------------------------------------------------------------------- | --------------- |
| [02 — 连接日志与错误契约](02-connection-log-and-error-contract.md)                          | done            |
| [03 — 远程连接展示模型、5 种状态与术语](03-presentation-model-states-and-glossary.md)       | done            |
| [04 — 向导止血与流程控制器抽取](04-wizard-p0-fixes-and-flow-controller.md)                  | done            |
| [05 — 设置页防护、编辑连接与作用域标注](05-settings-safeguards-edit-and-scope.md)           | done            |
| [06 — 交互原型与评审](06-interaction-prototype-review.md)                                   | done            |
| [07 — ssh-agent 与默认密钥评估](07-ssh-agent-default-key-evaluation.md)                     | ready-for-human |
| [08 — 断线体验与原地重连](08-disconnect-experience-and-in-place-reconnect.md)               | done            |
| [09 — 重连或重启后回到原处](09-restore-after-reconnect-and-restart.md)                      | done            |
| [10 — 三屏向导：骨架、统一选择屏与收起进度行](10-three-screen-wizard-and-selection.md)      | done            |
| [11 — 连接中屏与选目录屏重做](11-connecting-and-directory-screens.md)                       | done            |
| [12 — 侧栏、会话头部与菜单](12-sidebar-header-and-menus.md)                                 | done            |
| [13 — 设置页设备卡、未完成的连接与更新提示](13-settings-device-cards-and-updates.md)        | done            |
| [14 — 视觉打磨与无障碍](14-visual-polish-and-accessibility.md)                              | done            |
| [15 — 项目创建与远程连接管理分离](15-project-device-selection-and-connection-management.md) | ready-for-agent |
| [27 — 新建连接表单排布与配色](27-new-connection-form-polish.md)                             | done            |

各子票保留根因、对应 spec 和运行证据。done 不代表 formal/CI 准入；
[case 目录](../../conversation-session-case-catalog.md)定义场景，
[覆盖矩阵](../../testing/conversation-session-e2e-coverage-matrix.md)登记测试文件、pending 状态和证据。

## Out of Scope

- **手机 Web `/remote` 的远程展示和交互调整**，包括 R3-ISSUE-017 的设备名失真。本次只保证不回退。
- **设备和项目规模很大（20 个以上）时的筛选或分组。** 导航继续保持平铺。
- **设备在线但没打开项目时的空闲超时断开。** 这会改连接状态机。
- **统一设置页各分区的作用域归属**，比如子智能体固定作用于本机。本次只做显式标注。
- **钩子在远端作用域下的真实行为验证。**
- **离线消息排队，以及发送时自动重连。**
- **本文所列五项契约变更以外的领域模型、状态机和协议改动。**
- **ssh-agent 和默认密钥支持。** 需要单独评估后，由用户决定是否排期。
- 以上前五项登记到 open issues 文档，作为后续议题。

## 未决事项与历史依据

- 原型评审已记录于子票 06；ssh-agent 评估由子票 07 保留用户决策关口。
- 范围外议题统一见 [R3-ISSUE-017/025–028](../../architecture/r3-source-server-remote-open-issues.md#连接体验后续议题rdux-范围外)。不把未完成项隐藏到历史正文。
- 本机过旧更新方向、重复更新通知、恢复进度的原走查推断不能冒充运行证据；后续覆盖以对应子票和矩阵为准。
- 诊断日志整体是否进一步脱敏仍需独立评估；本轮合同只覆盖用户可见连接日志及反馈附带内容。
- 原始走查基线 `e185847b58`，临时截图目录为 `/tmp/zcode-remote-ux-walkthrough/`，不保证其他机器可用。
- 完整问题列表、用户故事、原始截图名及决策过程保存在整理前提交，不再作为第二份当前规格：

```bash
git show a17a875588b8d66c2bee49236292e174df651363:docs/issues/remote-connection-ux/01-remote-connection-ux-optimization.md
```
