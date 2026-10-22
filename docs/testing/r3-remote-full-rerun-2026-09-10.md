# R3 远程连接全量重跑记录(2026-09-10 ~ 09-11)

> 背景:R3 合并后代码有较多改动,对远程连接 e2e 全量重跑(49 case:standard 37 + special 10 + soak 2)。
> 原则:**环境类假失败必须修复消除,产品真实缺陷不得被掩盖,反之产品缺陷也不得误归为测试缺陷。**
> 逐轮详细取证见 `.e2e-artifacts/r3-rerun-20260910/ANALYSIS.md`(§1-§61,本文为其脱敏摘要)。

## 执行方式

- 统一 runner(`run.mjs`):每 case 独立容器 + 独立 home,FAIL 自动重跑一轮;失败保留容器与 home(docker stop 保文件系统现场),成功清理
- 自愈主控(`recover-all.sh`):幂等队列轮询,完成判定 = console `[rec] <case> exit=` 标记(注:`exit=` 是 runner 进程退出码恒 0,**PASS/FAIL 判据必须读 results.json 的 status**,该陷阱曾致删除器误判,§54 附记)
- 环境门槛(mem_gate,0911 修正版):内存压力等级 = normal 且可回收余量 ≥ 3000MB 才开新 case(swap used 是单调不降的冷页计数,只记录进日志不作闸门,§44);测试期间共遇 5 次内存杀手(§43/§44),主控可从断点续跑
- 所有凭据注入经环境变量;密码脱敏(redactText/redactDir);本文档不含任何密钥材料

## 结果汇总(历史终态,0911 12:48 全量收口)

| 批次                                | 总数   | PASS   | FAIL                       | BLOCKED |
| ----------------------------------- | ------ | ------ | -------------------------- | ------- |
| standard(单容器 replay)             | 37     | 34     | 3                          | 0       |
| special(docker/live/systemd/mobile) | 10     | 7      | 3(含 1 计 BLOCKED)         | 1       |
| soak(reconnect/dual)                | 2      | 2      | 0                          | 0       |
| **合计**                            | **49** | **43** | **6**(其中 1 实为 BLOCKED) | **1**   |

> FAIL 6:r3-install-faults / r3-live-bigmodel-team(=BLOCKED)/ r3-provisioning-gui / r3-settings-scopes / r3-terminal / ssh-remote-project-conversation-scope。历史终态保留；复核后其中 2 个产品缺陷定论、2 个测试缺陷(r3-install-faults、ssh-remote-project-conversation-scope，后续均复跑 PASS)、1 个产品嫌疑(terminal)、1 个环境材料失效(BLOCKED)。

soak 批次结案:soak-reconnect 50 轮全绿;soak-dual 56 轮(5 分钟定案轮)全绿——桌面/手机双向回显增量对账 0 缺失、断网恢复 18 轮全过、无泄漏。**产品侧零缺陷,全程根因均为测试代码缺陷**(DOM 虚拟化对账模式修正,§55)。

## FAIL 根因分类

### 一、产品缺陷(定论,维持 FAIL 立项)

| case                                  | 缺陷                                                                                              | 证据                                    | 分析节  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------- | ------- |
| r3-provisioning-gui                   | 同步途中断开未拒绝旧 RPC，Provisioning lane 阻塞重连 attachment；已修复，0911 16:15 完整复跑 PASS | 真实连接探针与 GUI 复跑，见下方修复记录 | §19/§25 |
| r3-settings-scopes                    | scope 选"用户"新建 agent,文件落到远端 home(归属歧义/错写)                                         | 保留容器实锤文件在远端                  | §42     |

> 后续状态：`r3-settings-scopes` 原缺陷成立，2026-09-11 修复后 GUI 回归 PASS，详见本文末尾复核记录。上表与 49 case 汇总保留历史口径。

### 二、产品缺陷(嫌疑,立 issue 排查,维持 FAIL)

| case                     | 嫌疑                                                                                                                                                                                                       | 分析节      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| r3-terminal              | 远程终端 PTY 数据流间歇断续(输出 45s 零数据 / 输入回显 32s 全败,两轮各一种);SSH 层已排除;嫌疑提交 6a1de7485c / 9b56031ac2 / 13c82d12e1                                                                     | §57         |
| r3-uninstall(指引部分)   | 卸载后向导报错指引"请在连接管理确认身份换代",而连接管理实际只有"重新安装并连接"入口——**指引文案与实际入口不一致**                                                                                          | §56         |
| r3-uninstall(重连静默群) | 卸载后三条 UI 重连路径全部静默锁死:① 首连换代错误指引失效 ② 设备行 attach 静默(§52)③ "重新安装并连接"点击后弹目录快选面板、条目恒 disabled、main 侧零连接动作 10min(§58 取证:12:05:40-12:15:52 主进程空白) | §52/§53/§58 |

### 三、BLOCKED(环境材料失效,非产品问题)

| case                  | 原因              | 处置                                  |
| --------------------- | ----------------- | ------------------------------------- |
| r3-live-bigmodel-team | live 凭据材料失效 | 需在本机 app 重新登录 BigModel 后重跑 |

### 四、测试缺陷(已修复,全部收口 PASS)

| case                          | 原缺陷                                                                                                                                                                  | 修复                                                                                            | 状态                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------- |
| r3-install-faults             | 故障破坏 x64 包但目标为 ARM64；B 在线复用会话未进入校验                                                                                                                 | 按每台目标架构选包、finally 恢复；B 显式断开并切回本地草稿                                      | **PASS(0911 14:43 复跑)** |
| ssh-remote-project-conversation-scope | 首次 conversation 连接漏处理向导内嵌安装确认；原日志在 project 场景执行前超时，§26/§40 产品归因撤销 | 先调用公共 waitForSSHDirectoryStep，再保持原 conversation/project 隔离断言 | **PASS(0911 16:32 复跑)** |
| r3-uninstall(业务断言部分)    | 全新容器无首装 → if 分支进不去;身份换代合同未按产品流程走;七段卡目录快选面板(产品静默缺陷)                                                                              | 八段版:首装 → 卸载对账 → 静默取证采样 → 移除全部连接 → 全新首连重装 → installationId 断言       | **PASS(round 36)**        |
| r3-subagent                   | agent 进程 cwd 过滤口径(cwd 实为 daemon home /home/dev,§59 取证实锤)                                                                                                    | 断言改 args 匹配存在性口径(≥1 ≤2),cwd 留 facts 观察                                             | **PASS(round 37)**        |
| r3-ui-pairwise                | §32 同款安装确认悬挂(boundary catch 吞错)                                                                                                                               | waitForSSHConversation 前插 waitForSSHDirectoryStep                                             | **PASS(round 38)**        |
| ssh-remote-provisioning-ready | §32 同款(90s waitUntil 只认 ConfirmDialog 抓不到 inline 按钮)+ §60:model-selection 合同被 provider-refactor-m2(b10e5e5d80)整体移除,本地/远端都改落 provider_config.json | submit 后插 waitForSSHDirectoryStep;远端+本地对账改 provider_config 存在性(内容含凭据,脱敏不读) | **PASS(round 42)**        |

## 测试侧沉淀(方法论)

1. **spec 校验**:esbuild 单文件 transpile 不校验跨模块导出(waitForWorkspaceApp 事故 §56 附记);必须 `tsc --noEmit --ignoreConfig` + grep `TS2305|TS2724|does not provide`
2. **wdio loader 时序**:worker 启动时读 spec/helper,修改晚于进程启动则读旧版——spec 修改后必须确认下一轮 wdio 启动时间晚于落盘时间(§55 实录)
3. **DOM 虚拟化对账**:全量收尾对账在高轮次下必失效;逐轮增量对账(标记刚发送必在窗口底部)+ 等待式回显(容忍断网轮重挂载)是正确模式(§55)
4. **主控 exit= 陷阱**:完成标记的 exit 值是 runner 进程码恒 0,判 PASS/FAIL 必须读 results.json(§54 附记)
5. **删除器模式**:等 `[rec] <case> exit=`(until grep -q,勿用 `grep -c` 计数比较——zsh 零匹配时 `$()` 捕获双行致整数比较死循环)→ sleep 5 → 读 results.json status → FAIL 才删标记 → 主控重调度;PASS 不动;删标记用**全量重写**(open w + replace,同路径不换 inode,tail 监控不丢;r+ seek 原地写单字节实测不可靠,§59 附记)
6. **FAIL 现场保留**:wdio.conf `onComplete` 曾无条件删 case home,已改 `exitCode!==0 && ZCODE_E2E_KEEP_HOME_ON_FAIL=1` 时保留(§47)
7. **ssh2 噪音**:REQUEST_FAILURE 紧跟 keepalive ping 的是 sshd 拒 global request,无害,勿误判连接故障(§57)

## 环境侧修复史(假失败消除)

- mem_gate:swap > 7500MB 暂停轮询,消除内存杀手连环击杀(5 次,§43/§44)
- docker exec -i 送 CLI 卸载确认(stdin 分 chunk,SSSH exec 通道会吞早到 chunk,§51)
- 容器 x64 模拟启动慢 → probe/安装等待窗口放宽;测试目录迁移 noexec 环境适配(install-environment 三 case)
- swap 高位时段(19:0x/01:5x)的失败全部复跑核实,不作为定性依据

## 产品缺陷 issue 清单(立项建议)

1. 远程入口静默需按根因分别核验：§19 已确认并修复为底层 RPC 未收口导致 Provisioning 发布屏障阻塞；不能继续归因到 openRemoteConversationWorkspace。§26/§40 产品立项撤销：实际未执行到 project 场景，首装确认测试修正后完整复跑 PASS。§52、§53 保留各自证据，不因 UI 症状相似合并根因。
2. 卸载后 UI 重连路径静默失效群:§56(指引文案与入口不一致)+ §58("重新安装并连接"点击后零连接动作,main 侧 10min 空白取证)
3. 撤销安装故障静默卡死立项：§35 已被原始成功日志反证，见下方复核
4. scope 归属错写:§42("用户" scope 写到远端 home)
5. 远程终端 PTY 数据流间歇断续:§57(嫌疑,附嫌疑提交清单)

## r3-install-faults 复核及测试修正（2026-09-11）

结论：原“安装失败静默卡死”是误判。spec 硬编码破坏 linux-x64 包，runner 却使用 linux/arm64 容器；run.log:6081 记录上传完好的 ARM64 包，8953 记录 remote-connected，9239 记录 workspace-context-bound，9413 才是 dialog-gone。df13428b 是故障前安装的 B 对照设备，不是失败遗留的半注册设备；遥测批次中的 exception 不能替代连接结果。

修正合同见 `r3-remote-automation-case-matrix.md` 的 BLD-04/06 补充：按每台远端架构选包，注入后 finally 恢复，保留严格失败及安装对账断言。新增实跑发现 B 首装后仍在线，会复用会话而跳过安装包校验；测试已补通过设备菜单断开并等待同一 identity 离线的前置条件。断开后显式切回本地草稿。**2026-09-11 14:42:13–14:43:49（北京时间）完整 GUI E2E PASS**，test body 66.984s，历史 49 case 结果仍保留原始记录。

验证：新增 fixture 回归与真实 resolver 单测 14/14 通过；当前修改的聚焦 TypeScript 检查、architecture:check（0 violation）、oxfmt、lint（0 errors；59 个现有 warnings）通过。`pnpm typecheck` 与 `pnpm --filter @zcode/desktop typecheck:e2e` 已执行，但被现有 `r3-docker-transport.test.ts:72–74` 和 `r3-live-zapi.test.ts:61–64` 的 7 处 ProviderAccessConfig/nullability 类型错误阻塞；本次不修改这两个文件。

完整新证据：`packages/desktop/.e2e-artifacts/r3-install-faults-fix-final-20260911/cases/r3-install-faults/` 的 result.json、test-results.ndjson（末条 passed=true）、install-faults.json、install-cancel.json。四种 A 故障全部 error/none/null；B 故障明确报错且 SHA 不变；取消后 none/null；所有 Host 对账为单一 Local Host。最后恢复包后的安装 SHA 与 A 对应 descriptor 一致，项目打开成功。

验证范围：macOS arm64 Desktop → 两个 Linux arm64 容器；x64/Darwin 选包归一化经单测覆盖，未声明这些平台的真实 GUI 验证。验证基于当前工作区（包括既有 E2E helper 修改）。本次只修测试与文档，不改变产品 remote/session 状态逻辑。

## r3-settings-scopes 修复与回归（2026-09-11）

原 §42 是真实产品缺陷：Subagents 选择 User 后仍继承 active remote workspace 的 path/identity，
导致用户配置写入远端 home。修复在 Subagents scope target 处固定普通 User 的 base Host
服务，插件初始化只使用可用的本机 workspace；User 保存刷新同 service authority 的已有
子智能体上下文，避免远端激活或无 workspace 时漏刷本机缓存，并保护切换中尚未完成的远端加载。
远程 Workspace 与显式 Source User 继续使用各自的服务。模型 Provider provisioning、Host
拓扑和 desktop continuous / mobile replayable 链路未变。

测试先观察到 4 项相关失败，再验证修复；新增的刷新竞态也先取得失败断言。最终相关单测
107/107 通过，包含 User/远程同路径 scope、离线与无本机 workspace、显式 Source 注入和
跨 authority 缓存隔离。E2E 改按 identity 选择同名 workspace，并对本机与远端同时查文件；
远端 conversation 的 default 是 workspace，已移除“选最后一个 default 冒充远端 User”的错误口径。
显式 Source User 的 GUI 入口和其它设置分区读写未计入本次通过范围。

**最终真实 GUI E2E PASS：2026-09-11 15:18:44–15:20:34（北京时间）**。
独立 home / Linux arm64 容器，macOS arm64 Desktop 重新构建；User 文件本机存在、远端
同名文件为空，conversation 文件只在远端 backing workspace，project 文件只在远端项目，
本机 user/project 均无远程项目同名文件，窗口 Host 对账不变。第一次修复构建也已 PASS；
最终轮覆盖了缓存代码收敛后的版本。

验证：`pnpm architecture:check --changed` 0 violation；`pnpm lint` 0 errors、59 个既有 warnings；
改动文件 oxfmt 与 diff check 通过；`pnpm exec tsc -b packages/ui` 与本 case 聚焦 E2E 类型检查通过。
`pnpm typecheck` 和 Desktop `typecheck:e2e` 均执行，仍被已有的 `r3-docker-transport.test.ts:72–74`
和 `r3-live-zapi.test.ts:61–64` 共 7 处 ProviderAccessConfig/nullability 错误阻塞，本次未改这两个文件。

最终证据：`packages/desktop/.e2e-artifacts/r3-settings-scopes-fix-final-20260911/`，包含
`verification.md`、各检查日志及 `cases/r3-settings-scopes/` 的 `result.json`、`settings-scopes.json`
和 `test-results.ndjson`。原失败容器和历史报告未覆盖。未实跑 Windows/Linux Desktop、手机端
及全部主题组合；此次 UI 修改不涉及样式或文案，跨端继续消费既有服务注入。

## r3-provisioning-gui 根因修复与复跑（2026-09-11）

结论：原产品缺陷成立，修复后完整 GUI E2E PASS。根因在 `ServerRemoteConnection` 的物理连接生命周期：仅关闭 socket/agent 没有 dispose ChannelClient，同步途中断开会让旧 RPC 永久 pending，Main 的 Environment lane 无法结束，后续连接被 initialSync 发布屏障阻塞；本例尚未进入 openRemoteConversationWorkspace。

修复由连接统一拥有 RPC 客户端与协议，在主动断开、socket close/error、握手失败时幂等释放，复用原有同步失败收口与重新上线同步流程；不增加延时或重试，不绕过首次同步屏障。规范见 `../remote/provider-provisioning.md` 的“物理连接关闭与同步请求收口”。

测试先证伪后修复：新增 WebSocket/Duplex × 主动断开/对端关闭共 4 个真实网络回归，修复前全部失败，修复后全部通过；同时覆盖旧响应未返回时新 Environment 同步、迟到响应、重复释放和关闭后调用。连接、Source 自动恢复、Main attachment、手机 shared-host/relay 与底层 RPC 相关测试合计 179 项通过。

完整 GUI 首轮已通过项目/conversation 恢复及最新配置同步，随后暴露被旧故障遮挡的测试前置缺陷：B-05 在任务 A 的 Composer 切到临时 Provider 后才新建草稿，随后删除该 Provider，导致 A 续发选择失效。取证轮 `resumedModelConfig` 的 provider/model/thought 为空。测试改为先新建 B-05 草稿再切模，最终显式验证 A 仍持有原模型与思考档位。另将删除完成判据限定到供应商导航：全页残留名称不能推翻已经成功的删除 RPC 与远端文件对账。所有业务断言保留。

**2026-09-11 16:14:13–16:15:45（北京时间）完整 GUI PASS**。facts：initialContainsSeeded、onlineSave、b05ExistingAgentRefresh、deletePropagated、offlineEditsNotSyncedWhileOffline、afterReconnectHasBothOfflineEdits 全部通过；project/conversation 均恢复且 session 不同，原任务选择为 lifecycle model/disabled，并成功完成续发。证据：`packages/desktop/.e2e-artifacts/r3-provisioning-fix-verified-20260911/cases/r3-provisioning-gui/`。首次修复验证重新构建当前 Desktop 源码，后续仅调整 E2E 时复用同一构建；历史失败产物保留于独立目录，原 49 case results.json 未覆盖。

验证：Host/Main 与新增生命周期测试的聚焦类型检查通过；Lint 0 errors（59 个原有 warnings）、architecture 0 violations。`pnpm typecheck` 与 `pnpm --filter @zcode/desktop typecheck:e2e` 已执行，仍受原有 r3-docker-transport:72–74、r3-live-zapi:61–64 共 7 处类型错误阻塞。未在 Windows/WSL 真机重跑；手机边界由 shared-host/relay 聚焦测试覆盖，未执行手机 GUI。

自动恢复补测：`r3-transport-loss` 在同一修复构建上 PASS，覆盖运行中断开后的 A/B 同组 session 换代、远端任务继续，以及 permission 阻塞跨断连恢复后完成、哨兵只执行一次。该用例前后 permissionDialogId 采样均为 null，不能据此证明请求 ID 连续性。证据：`packages/desktop/.e2e-artifacts/r3-provisioning-fix-verified-20260911/cases/r3-transport-loss/`。

## ssh-remote-project-conversation-scope 复核及测试修正（2026-09-11）

结论：撤销 §26/§40 的“project 点 conversation 入口静默”产品定性。原始四份 run 日志的失败堆栈均停在未修改 spec 的第 55 行，即初始 conversation 首连；project 与任务 + 分别在后续第 64–74 行，尚未执行。最后一轮 1201 次轮询均为 `dialogOpen=true`，与 §40 的 `false` 描述相反；项目历史为空不能证明 project bind 丢失历史。

测试的 `waitForRemoteConversationTab` 只处理旧 ConfirmDialog，漏掉 SSH 向导内嵌的“安装并继续”。先用当前真实连接步骤组件执行历史日志中的原始轮询脚本：确认按钮未被点击，状态保持 dialogOpen=true/tabs=[]；公共 helper 的中英文对照均能点击，隔离探针 3/3 通过。修正在 `connectSSHConversation` 提交后调用已有 `waitForSSHDirectoryStep`，处理安装/边界确认，再执行原 conversation identity/session/激活断言；未放宽 project/conversation 独立 session 或单 Host 合同，也未修改产品代码。

**2026-09-11 16:31:12–16:32:14（北京时间）完整 GUI E2E PASS**，test body 26.505s、无重试。全新 Linux arm64 容器、独立 home，基于 `9267b534287a1248a32dfb03feeea0e9d3cf9fff` 工作区重新构建 Desktop。run.log:4324 记录内嵌安装按钮，7600 记录向导关闭；随后 project 与新 conversation attachment 分别完成 bind，原独立 remoteSessionId、当前激活 tab、Window Host 不变断言全部通过。

新证据在 `packages/desktop/.e2e-artifacts/r3-project-conversation-fix-20260911/` 的 verification.md 和 `cases/ssh-remote-project-conversation-scope/` 下的 result.json、test-results.ndjson、run.log。原始失败日志、容器及 49 case results.json 保留。历史应用 bundle 已清理且 manifest 未记录 SHA，本次通过仅证明上述当前工作区；历史失败阶段以保留的原始脚本和堆栈核对。

验证：fixture check、聚焦 E2E 类型检查、oxfmt、architecture（0 violation）、lint（0 errors、59 个既有 warnings）通过。`pnpm typecheck` 与 Desktop `typecheck:e2e` 已执行，仍被未改动的 r3-docker-transport:72–74、r3-live-zapi:61–64 共 7 处已有类型错误阻塞。未实跑 Windows/Linux Desktop 或手机 GUI；本次只修测试前置，desktop-continuous 与手机 shared-host/replayable 的产品实现不变。
