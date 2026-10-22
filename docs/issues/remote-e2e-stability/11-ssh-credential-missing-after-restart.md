# SSH 已保存连接在冷重启后缺少凭据

Status: done

## 当前证据

- 业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5`，test 构建；批次
  `r3-server-20261011104332183-3a0c00`，`boundary`，90.1 秒后失败。
- 从设置页“新建连接”进入真实 SSH 向导，输入本轮容器密码，完成首装并创建项目 A/B。
  首次持续运行说明出现、关闭后第二项目不重复，`remoteBoundaryOnboardingVersion=2`。
- 使用现有安全重启 helper 完整退出旧进程并复用 userData。重启后原项目可以从快照恢复，
  再从设备入口选择目录时报“没有可用的 SSH 密码或私钥凭据，请返回配置后补充”。
- 保留 HOME 中仍有一个 Source、一个 Connection Profile，Profile 仍带 password credential 引用，
  但 `credentials.json` 为零条。设置、项目与 onboarding 状态保留，不是整个 HOME 被重置。
- 运行日志在重启后的首次目录操作前记录一次 `credential.delete`。后续复验与只读探针确认了
  workspace 历史重投影越权删除 Profile 凭据的路径，见下节。

## 根因证据

批次 `r3-server-20261011105317614-4a6780` 的同一 case 记录：重启前 passwordRefs=1、presentRefs=1；
失败后仍有 passwordRefs=1，但 presentRefs=0。因此不是初次未保存，丢失发生在重启恢复期间。

保留设置中的远程 history 使用 route identity（`remote:ssh:...`），其 target 却引用
`connection-profile:*:password`。恢复到 canonical `remote:server:*` 时：

```text
旧 route history 引用 Profile secret
  → buildRemoteWorkspaceSessionMutation 改投影为 server identity
  → 新 snapshot 正确去掉 Renderer 不拥有的 credential ref
  → 差异清理把旧 Profile ref 加入 credentialKeysToDelete
  → Renderer 调用 credential.delete，正式 Profile 留下悬空引用
```

对当前真实 `buildRemoteWorkspaceSessionMutation` 做合成输入的只读探针：旧 entry 为
`remote:ssh:127.0.0.1:2222:dev:/work`，password ref 为 `connection-profile:fixture-profile:password`，
新 identity 为同目标的 server identity。返回 `deletesProfileOwnedCredential=true`、
`saveCount=0`、`entryCount=1`。探针没有调用持久化 API，也没有修改凭据文件。

当前 `preservesRollbackCredential` 仅保护旧 `remote-workspace:remote:*` key；Profile owner 的 key
没有得到保护。凭据服务本身采用文件锁下的读改写，没有发现进程内旧缓存覆盖的证据。
修复应恢复 Source Directory 对 Profile 凭据的唯一所有权，而不是在 case 中补写密码。

## 预期与影响

正式保存的 SSH 连接在正常冷重启后应能复用凭据。当前需要再次输入密码，阻塞重启后的
目录选择，也使边界说明的“重启不重复”后半段无法继续验证。

证据目录：`packages/desktop/.e2e-artifacts/r3-server-20261011104332183-3a0c00-boundary/`，
包括 `boundary-ack.json`、`test-results.ndjson`、录像和桌面日志；失败 HOME 由 runner 保留。
测试已增加重启前后 credential 引用存在性的只读诊断，不记录口令或 key 正文。

本轮不修改业务代码，不通过补写凭据、自动重试或删除恢复断言掩盖失败。

同业务基线、测试补丁 07 的 `project-order` 在冷启动后也被连接恢复阻塞。运行中的只读探针
确认两个项目行均为 offline，设置中保留 1 个 SSH passwordCredentialKey，但实际凭据中该 key
不存在（passwordRefs=1、presentRefs=0）。这不是拖拽步骤失败；断开/上线后的排序断言尚未到达。
证据来自批次 `r3-server-20261011125749338-152f05`，不把该例视为排序回归通过。

同批 `recov` 的旧 Source 冷启动阶段已成功；随后 Main 日志先记录 `credential.delete OK`，
约 4 秒后项目手动连接报 `Connection Profile requires interactive credentials`。
因此该用例后半段的失败有直接凭据证据，不归为“超过 7 天不恢复”。

## 2026-10-12 根因修复与回归

修复起点 `bc61ed5cc95264464937121788277bd40714566b`，业务边界与上述事故版本一致。
`remoteWorkspaceHistory` 的清理收集器此前把“快照引用的 key”当成“历史拥有的 key”；
本次统一只收集 `remote-workspace:` 自有凭据。Profile 的密码和私钥口令由 Source Directory
继续管理，成功重投影移除引用、容量裁剪和显式历史移除均不得删除它们。
没有新增重试、补写密码、复制凭据或修改连接恢复时序；legacy 回退保护与历史自有凭据清理保留。

先补真实模块回归：成功 rekey、容量裁剪、显式移除三项在修复前失败，均返回了 Profile 的
密码和私钥口令删除意图；失败恢复对照保持通过。修复后该文件 28 项通过，连同
Source Directory 41 项，共 69 项通过。已有 boundary E2E 增加重启前后凭据引用存在性
硬断言，仍要求重启后真实读取目录成功，不记录 key 或口令正文。

修复阻止后续误删；已被旧版删除的凭据无法凭空恢复，仍需通过现有认证入口重新保存。
回滚只涉及历史清理 helper，回滚会重新暴露误删风险。

### 验证结果与剩余阻塞

实施状态：已实施；验证状态：部分已验证，相关冷启动回归仍失败，未自动提交。

- 类型检查、lint（207 条既有警告、0 error）、架构（0 violation）、改动格式与 diff 检查通过；
  boundary 的 canonical fixture 检查通过。
- 受影响测试选择 397 个 Vitest 文件及 4 个 Node 测试文件。Vitest 批跑 4465 项通过、1 项
  inventory 清单检查超过 30 秒；同代码定向复跑该文件 11 项通过（1.47 秒），未改超时或期望。
  Node 脚本 34 项通过；Source Directory 另有 41 项通过。不把首次批跑写成全绿。
- 远程批次 `r3-server-20261012003650390-d1994e`：6 项全部执行，**1 PASS / 5 FAIL**。
  业务产物重新构建，输入为起点 commit 加本次未提交补丁；完整源码清单 SHA-256：
  `86911f42edffb5a382f780bb6b469367606753e8cfcda3ec34fb920b7cf97724`。

| 用例          | 结果           | 本轮证据                                                                                 |
| ------------- | -------------- | ---------------------------------------------------------------------------------------- |
| recov         | PASS，176.5 秒 | 8 天前的连接记录冷恢复与后续手动连接完成，不再因缺凭据受阻                               |
| boundary      | FAIL，326.6 秒 | 重启前与结束时密码引用/实际存在均为 1/1；等待 A workspace 恢复失败，目录页后续断言未到达 |
| mixed         | FAIL，404.6 秒 | 运行探针密码仍为 1/1；冷启动只恢复 A，未补齐 B                                           |
| coldreconnect | FAIL，242.3 秒 | 等待冷启动后 A 的 identity/session 收敛失败，active 仍为 B                               |
| project-order | FAIL，234.4 秒 | 运行探针密码仍为 1/1；原项目恢复失败，后续排序断言未到达                                 |
| rdux14        | FAIL，220.0 秒 | 运行探针密码仍为 1/1；未设过期的 A 先恢复失败，不能据此认定存在 7 天过滤                 |

剩余失败延续[工作区恢复问题 15](15-cold-start-open-workspace-siblings.md)，不能用继续补写密码
或新增重试掩盖。本轮不修改该恢复链，也不宣称 29 个历史失败已全部解决。
本机证据位于 `packages/desktop/.e2e-artifacts/issue11-20261012/`：`summary.json`、
`case-evidence.json` 与问题 25 的隔离探针输出。队列已结束，测试容器及队列锁已回收。

## 2026-10-12 最终验证完成

问题 15 根因复核发现旧冷启动断言与新版 F5 冲突，修正验收后，批次
`r3-server-20261012012923737-60d156` 的 boundary/mixed/coldreconnect/project-order/rdux14
全部 PASS；恢复业务逻辑没有额外修改。boundary 重启前、重启后和结束时均为密码引用 1、
实际存在 1，重启后真实目录读取成功；此前 recov 已在同一业务修复构建下 PASS。
新增凭据回归和 Source Directory 测试通过，受影响测试与必要代码检查通过，实施与本项验证完成。
上节 1 PASS / 5 FAIL 是修正过时验收前的历史结果，不再作为本项剩余阻塞。
