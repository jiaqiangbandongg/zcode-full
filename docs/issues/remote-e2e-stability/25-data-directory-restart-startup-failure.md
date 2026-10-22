# 桌面设置和数据目录变更后冷启动失败

Status: done

业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5`，补丁 09。
批次 `r3-server-20261011150809016-2aeaba` 的 `desktopauthority` 在 203.1 秒失败。

远程项目激活时，通过真实设置页更改硬件加速、浏览器证书策略与本机数据目录，并保存后立即完整重启。
重启前已经核对：桌面字段只写本机，Source 自动归档反向对照正常；Source 桌面字段没有污染，
本机 canary 已复制到新数据目录。`settings-authority.json` 保存这些阶段的成功事实。

新 Main 没有进入主界面，而是显示“无法完成启动准备 / 数据准备进程意外退出或连接中断”。
数据库启动 attempt `6bae681b-502c-4a44-9231-634811d33575` 在 2692ms 后以
`status=failed, errorCode=transport_closed` 结束；Host 日志记录 Worker exit 后
`Storage preparation failed: transport_closed`。盘面可用空间仍超过 128GB。

```text
远程项目激活 → 桌面设置与数据目录保存、canary 复制成功
  → 正常退出旧进程 → 新 Main / Host 启动
  → 数据准备 Worker 连接关闭 → 启动失败页
```

这不是等待了错误的默认项目：本轮只等待可操作主界面，失败页仍持续显示。
尚未唯一定位 Worker 退出原因，也不能仅凭该组合场景认定只由数据目录或硬件加速其中一项导致。
本轮业务代码未改；重启后读取新本机配置的最终断言未到达。

证据：上述批次 `desktopauthority` 的 `settings-authority.json`、失败录像和 Desktop 日志。

## 2026-10-12 继续定位（未修改业务实现）

将事故堆栈 `host/index.js:2:458` 对照尚未重建的同版本 test bundle，位置落在
`prepareSessionStorage` 的 Worker exit 分支。因此退出的是 **CLI 会话库准备 Worker**，
不是 `prepareHostStorage` 的任务索引库 Worker；外围 `transport_closed` 不能作为数据库根因。
该分支只有收到 storagePrepared、正常退出且无先前错误才成功；未收到完成帧或异常退出均可产生当前错误。
现有代码直接排空该 Worker stderr，历史日志没有保存原始 CLI 错误与退出码。

只读检查事故日志后，在隔离临时目录调用同业务版本的真实构建入口：任务索引 Worker 使用
保留的旧目录数据库副本，默认目录与自定义目录均返回 done、exit 0；CLI 会话库 Worker
在显式临时数据库路径下，分别使用 Node 与 Electron Node runtime，两种目录布局均返回
storagePrepared、exit 0，stderr 为空。
这些探针不复现完整设置保存与冷启动，也没有使用已被旧用例清理的新目录数据库，
所以只能缩小排查范围，不能排除复制时数据库状态、实际环境或其他启动输入问题。

下一项有效检查：在原组合场景重启前保留新目录数据库副本和解析后的存储路径，
采集 CLI Worker 的 stderr、退出码及最后控制帧，再与单独数据目录变更对照。
硬件加速、证书策略和数据复制均未被认定为唯一根因；本轮不改这些实现。

## 2026-10-12 Worker 取证与已确认根因

本项本轮仅诊断，不修改启动业务。批次 `r3-server-20261012012923737-60d156` 的
`desktopauthority` 205.4 秒后仍失败；业务构建与问题 11 复验相同。
测试专用 `storage-worker-diagnostics.mjs` 通过 E2E 预加载旁观 Worker，未替换存储入口、
控制帧、退出码或恢复流程；stderr 最多保留 64 KiB，仅写本次 artifact 的 0600 文件。

| 时点           | 退出码 | stderr                                                                   | 最后控制帧              |
| -------------- | ------ | ------------------------------------------------------------------------ | ----------------------- |
| 修改数据目录前 | 0      | 空                                                                       | startup/storagePrepared |
| 保存并冷重启后 | 1      | `--cwd path is not accessible: <new-data-root>/.zcode/workspace/default` | 无                      |

在失败页仍存在时检查文件系统：新 data root 和 `.zcode` 存在，但 `.zcode/workspace`
及其 `default` 子目录均不存在。这是缺少启动工作目录，不是已观察到的数据库损坏或硬件加速故障。

```text
远程项目为 lastActiveWorkspace + 新数据根
  → copyDataDirectory 只复制 .zcode/v2
  → resolveStartupWindowBootstrap 远程活动分支返回 {}，未创建本机默认 cwd
  → Main 仍把新根下 default 作为 agentSpawnFallbackCwd
  → Host 无本地 warmup targets，选用该 cwd 准备会话库
  → CLI --cwd 校验失败，exit 1，尚未发送 storagePath
  → Host 丢弃 stderr，以 transport_closed 呈现
```

责任边界：`packages/desktop/src/main/startupWorkspace.ts:resolveStartupWindowBootstrap`
与 `index.ts` 的 `agentSpawnFallbackCwd` 交接，未保证交给存储准备的 app-owned cwd 存在。
`resolveZCodeAgentSpawnCwd` 在请求与备用目录都不可用时保留原路径，CLI 的拒绝符合路径准入契约。

反证与最小探针：

- 当前真实 bootstrap + cwd resolver 输入远程活动选择、新的默认目录，返回 bootstrap={}、
  cwdCreated=false、cwdExists=false；没有改写原源码。
- 同版本真实 CLI bundle、Electron Node runtime、相同 argv/环境/隔离数据库：cwd 不存在时
  exit=1、stderr 同现场、frames=[]；仅创建该目录后 exit=0、stderr 为空并收到 storagePrepared。
  没有切换硬件加速/证书配置、修改数据库或增加重试。
- 测试观察器自身使用真实 Worker 验证：原 exit=23 不变，stderr 与最后帧完整保留。

判定：问题成立、根因已确认、repair_ready=true；原端到端已复现，边界反事实已验证。
后续修复目标是启动 owner 在 Host 存储准备前确保其 app-owned cwd 可用；不扩大为重建失效用户项目目录。
完整设置序列修复后的成功仍未验证，本轮不把诊断成功写成产品用例 PASS。
证据：本机 `packages/desktop/.e2e-artifacts/issue15-20261012/` 中的
`worker-cwd-observation.json`、`worker-cwd-counterfactual.jsonl`、`bootstrap-probe.json`，
以及上述服务器 case 的 `storage-workers/*.json`。

## 2026-10-12 最小修复实施

修复目标 `56ca74621f0da771728e310e36d967afd5259c6d`，根因相关代码未变化。
Main 的 `resolveStartupWindowBootstrap` 在没有本地活动预热目标的远程活动分支返回前，
异步创建已由数据根解析出的 `conversationWorkspaceDir`，等目录就绪再交给 Host。
返回的导航/预热结果仍为空，不创建用户远程路径、不增加本地项目、不抢占远程焦点。
沿用现有首次启动与失效本地目录的 mkdir 契约，错误直接传播，不吞错或新增重试。

先验证新版活动字段、旧列表导入、既有目录内容保留及创建失败；再重跑原 desktopauthority
组合场景（远程激活、硬件加速、证书策略、数据目录保存、完整冷重启）。E2E 保留 Source 设置
不被污染及重启后配置读取的断言，并增加新根默认 cwd 的前后存在性证据。

局部验证：新旧远程活动设置和目录创建失败三个回归在修复前均失败，修复后通过。
`startupWorkspace`、`hostDatabaseStartup`、`storagePreparationWorker` 三文件 20 项通过；
受影响测试 17 文件 219 项通过。根类型、lint（207 条既有警告、0 error）、架构（0 violation）、
fixture 与改动格式检查通过。服务器原场景及冷启动回归均通过，见下表。

### 最终复验

实施状态：已实施；验证状态：计划内必要验证通过。
批次 `r3-server-20261012013853643-f32109`，同一 test 部署重新构建业务包；输入为修复起点
加本次补丁，完整源码清单 SHA-256：
`8a674355697c004b22a12bbe6e973df9adf75501652f43fbd2d8f01f8810a94a`。

| 场景             | 结果           | 已确认行为                                                                                                      |
| ---------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| desktopauthority | PASS，107.7 秒 | 保留原设置组合与完整重启；重启前新根默认 cwd 不存在，重启后存在；桌面设置保留、Source 未被污染、canary 复制成功 |
| coldreconnect    | PASS，150.0 秒 | 活动远程任务冷恢复、按需打开另一项目、双方续聊、关闭自动重连和手动恢复均通过                                    |

Worker 观察器记录重启前后均为 exit=0、stderr 为空、最后帧为 startup/storagePrepared；
与修复前 exit=1、cwd 不可访问且无控制帧形成同场景对照。
没有改变 CLI 路径校验或存储协议，没有扩大目录复制范围，也没有新增恢复重试。
E2E 为 Linux 服务器；本机聚焦测试覆盖 macOS 文件系统行为，不将其外推为原生 Windows E2E。
本机证据：`packages/desktop/.e2e-artifacts/issue25-fix-20261012/` 的 `summary.json`、
`settings-authority.json` 与 `storage-workers/`。队列、测试容器和锁已回收。
回滚只需撤销远程活动分支的目录准备；已创建目录内的数据不随回滚删除，原启动故障会再次暴露。
