# 原项目连接中的认证、升级与重装交接缺失

Status: done

## 2026-10-11 当前项目入口回归

业务基线 `d31e735905cf744e75a0a93548a80acabe871ae5`，test 构建。
批次 `r3-server-20261011101534847-c8a52a` 的 `version-snapshot-failure-required` 已完成
真实 SSH 首装、A/B 项目创建和旧版本元数据夹具安装。点击原项目菜单“连接”后没有打开向导，
页面停在“需要处理 / 重新连接”，远端最终仍为 `3.14.0`。

- 运行日志确认 `remote-projects.connectHost` 返回 `SourceServerUpgradeRequiredError`：
  `Source Server 3.14.0 must be upgraded to at least 3.15.1`。
- 快照故障夹具仅在向导存在时截获读取；299 次运行采样均为零条请求。此次失败发生在
  升级意图交接之前，不能归因于快照拒绝后的恢复逻辑，也不能声称已覆盖该故障分支。
- 当前 `packages/ui/src/project-sidebar/index.tsx` 的项目连接动作直接调用
  `remoteService.connectHost`，未走此前恢复原项目时的向导升级交接。该调用链与上述运行错误一致。
- 证据位于 `packages/desktop/.e2e-artifacts/r3-server-20261011101534847-c8a52a-version-snapshot-failure-required/`：
  `version-policy.json`、`test-results.ndjson`、失败录像和 `logs/desktop` 日志。

全量批次 `r3-server-20261011105317614-4a6780` 再次复现：`manual-required` 397.3 秒失败，
`snapshot-failure-required` 213.9 秒失败。两者 `finalInstalledVersion` 都仍为 `3.14.0`，
均未得到 `restoredProjects`。测试中另有升级后版本硬编码 `3.15.0` 的过时断言，已改为本轮
真实首装版本；这两次失败发生在恢复等待阶段，尚未执行到该版本断言，不能归为硬编码造成的误报。

本轮只记录业务回归，保留失败断言，不修改业务实现。完整队列中的普通手动更新变体还需独立复核；
以下旧版本修复与通过记录保留，不作为当前基线的通过证据。

同基线测试补丁 07 的批次 `r3-server-20261011125749338-152f05` 中，`serverupdate`
（213.3 秒）和 `serverupdate-force`（226.7 秒）也停在“恢复入口没有提供更新操作”。
这两个同版本异 SHA 的用例未到达 running-task 强制更新确认，不能把它们计为 guard 已覆盖。
原断言和独立目标仍保留，业务交接恢复后需继续验证后续取消/强制分支。

同批 `version-snapshot-failure-required` 在 225.7 秒后失败，原始首装版本为 `3.15.1`，
故障结束仍为 `3.14.0`，没有 `restoredProjects` 或 `snapshotFailure` 结果。
这是升级交接之前的阻塞；快照拒绝、重试只更新一次的后续断言仍未到达。
该批 `manual-required` 398.4 秒失败，最终也仍为 `3.14.0`，没有恢复项目。

## 后台更新后的恢复仍待分诊

同一全量批次 `automatic-required` 的远端最终已是 `3.15.1`，与手动分支未更新不同。
运行日志记录 `source-server-management.updateSource OK (64480.1ms)`；其后只看到一个 Source
连接的 ready ACK，未看到原 A/B 的 workspace-context-bound。等待 B 恢复的快照仍保留 active
identity/path，但没有匹配 tab 或 remoteSessionId，382.8 秒后失败。

该分支不能记为“升级没执行”，也不能只凭导航缓存缺行就断言物理连接失败。
原项目自动恢复的合同保留，后续需结合 Source attachment 与项目导航 owner 继续分诊。
`optional` 已恢复 A/B 且远端保持 `3.16.0`。测试补充异步等待后，补丁 07 复验仍缺少更新提示，
A/B 恢复正常；已另记为[可选更新提示缺失](21-optional-update-notice-missing.md)，
避免与原项目升级/恢复失败混为一项。

测试补丁 07 的 `automatic-required` 再次在 395.2 秒后失败：`finalInstalledVersion=3.15.1`，
但没有 `restoredProjects`。与同批手动分支保留 `3.14.0` 的结果不同，后台更新完成后的项目恢复
仍需单独修复，不能用补上手动升级向导交接一项就宣称全部恢复。

## 同基线的卸载后重新安装入口

全量批次 `r3-server-20261011105317614-4a6780` 的 `uninstall` 也没有到达原项目的安装确认。
`uninstall.json` 记录正式 CLI 两次 DELETE 确认完成：`current.json`/releases 已清除，
原 installationId、配置、历史和用户数据哨兵保留。原 task 已进入离线保留态，点击项目“连接”后，
30 秒内没有“安装并继续”向导。失败视频末帧保留原消息，页面显示“需要处理 / 重新连接”，
侧栏项目仍离线，未出现安装确认。

这是已观察到的重新安装交接缺失；尚不能只凭相似界面断言与升级分支具有完全相同根因。
运行日志中的 `remote-projects.connectHost OK (32.3ms)` 也不能证明重新安装完成。
定向复跑 `r3-server-20261011123601821-eca14c` 已确认：失败后 `current=none`、releases 为空、
原 tab 的 remoteSessionId 为 null、项目 offline、dialog 为 null。没有发生静默重新安装。
不改为从新设备入口安装来绕过原项目合同。
证据目录：`packages/desktop/.e2e-artifacts/r3-server-20261011105317614-4a6780-uninstall/`。

## 原项目缺少凭据时没有进入认证向导

补丁 08、批次 `r3-server-20261011143037600-31012b` 的 `projectnavigation` 已通过离线项目
平铺、时间线切换、设备标注、项目菜单与停用远程无项目入口检查。夹具故意不保存 SSH 密码，
从项目菜单点击连接后，Host 明确返回 `Connection Profile requires interactive credentials`，
但 20 秒内没有认证向导，整体在 86.5 秒失败。

这是缺凭据时的交接缺失，不是凭据丢失：该夹具本来就没有保存密码。跨设备表单隔离和既有
下载方式保留的后续断言尚未到达。当前项目动作直接调用 connectHost 的路径应继续交给
既有认证流程，不能仅让用户看到不可处理的失败。业务实现未修改。

## 规格与原失败行为

飞书桌面 SSH 指南“远端版本更新”和主规格
[§6.3](../../architecture/r3-source-server-remote-architecture.md#63-版本兼容与远端更新d10)
要求显式手动连接时自动发起一次受保护更新，无运行任务时继续原操作。
原测试基线的原项目入口打开正确的“更新远端”页面，但不自动发起更新。

## 运行证据

- 业务基线 `a13999a28927f629d0c64080a5096cf8b4f23bae`。
- `conversation-session-ssh-remote-version-policy.test.ts`，`manual-required`。
- 批次 `r3-server-20261009223735233-3b63ee` 和 `r3-server-20261009234650716-227ddc`。
- 独立目标用本轮完整 runtime 的版本元数据变体模拟 Server 3.14.0；CLI 记录 daemon runtime
  已收敛到 3.14.0。不是用版本字符串冒充旧业务实现。
- A/B 已打开，无运行任务；从原项目 B 点击连接。Host 报
  `Source Server 3.14.0 must be upgraded to at least 3.15.0`。
- 原项目、目录意图仍保留，向导显示“更新远端”，但等待 180 秒后 B 的 session 仍为空。
  Desktop 日志没有该操作触发的 `source-server-management.updateSource`；复跑后的
  `finalInstalledVersion` 仍为 3.14.0。

## 判定与边界

原测试将其保留为原项目入口与自动更新合同之间的差异；后续根因核实见下节。
不通过在 case 中补点“更新远端”来把“自动更新”断言变绿。原回归轮次未改业务。
后台等待用户更新与确认强制更新均有独立通过证据，不代表此原项目自动更新分支通过。

## 根因与修复（2026-10-10）

修复起点 `6ea1a0e30e8c62c278cb7c948ea936f8ff5b7704`。向导、项目入口、更新动作及 Host
兼容检查代码与原业务基线相同。`requestRemoteProjectConnection` 将已完成的连接失败作为
`initialFailure` 交给向导；`acceptInitialFailure` 只设置错误与更新按钮后返回，绕过
`startRemoteConnection` 异常分支中已有的自动更新逻辑。指南第 41 版和主规格 §6.3
均明确手动连接自动更新；普通连接失败不自动重试的规则不取消这项升级合同。

当前真实 dispatcher + Hook 探针已复现：同一 SSH Profile 和升级快照，普通向导自动调用
`updateSource(force:false)` 一次，原项目交接调用零次；再点更新按钮可继续原目录。
该边界使用模拟服务 I/O，历史真实 SSH 的错误、截图与 session 未恢复结果单独核对，
不以探针代替远端安装成功证据。

修复将必须更新的编排收敛到向导同一函数，原项目交接与普通连接错误均读取 Host 最新快照，
只为远端 required 状态自动执行一次受保护更新。沿用运行任务 guard、显式强制确认、
原目录意图及现有 epoch；取消或换意图后的结果不继续旧连接，失败保留操作入口，
更新后仍不兼容不自动循环。本机过旧、普通失败与后台恢复不新增自动更新。

```text
原项目连接失败 / 普通向导连接失败
  -> 同一向导意图 -> Host 快照确认远端 required -> updateSource(force=false)
  -> running-task guard：等待用户确认；成功：只继续一次原目录连接
  -> 取消 / 换意图：旧 epoch 失效，不恢复旧项目
```

验证记录：

- 新增 9 项真实 dispatcher / Hook 回归，修复前 7 项失败、2 项正常对照通过；
  修复后相关两文件 27 项全部通过。覆盖首次报升级、已有需升级状态、运行任务取消/确认、
  更新取消后的晚到结果、更新失败、更新后仍不兼容、收起恢复、本机过旧和普通失败。
- `pnpm test:unit:affected --base 6ea1a0e30e8c62c278cb7c948ea936f8ff5b7704`：
  370 个 Vitest 文件 / 4379 项用例及 28 项 Node 审计通过，未跑全量单测。
- 根类型检查、E2E 类型检查、lint、架构、fixture、改动代码格式和开源术语检查通过；
  lint 保留 81 条既有警告。
- macOS Electron → 独立 Linux arm64 SSH 容器，
  `desktop-e2e-20261010-version-fix-manual-required-r2` **1/1 PASS**。
  仅点击原项目 B 连接，真实 `updateSource` 成功，远端从夹具 3.14.0 更新回 3.15.0，
  A/B 保留原 identity、目录且取得新 session。新增这两项 session 换代断言及 artifact，
  原 180 秒恢复断言保留。构建证据 `fresh-stable` 中向导源码摘要与修复工作区一致。
- 本机首轮没有带服务器 harness 的外层预算，被 WDIO 默认 120 秒在夹具准备阶段截断，
  尚未进入原项目重连。复跑按既有 `ZCODE_E2E_MANUAL_REVIEW_HOLD_MS=780000` 配置补齐
  外层 15 分钟预算，与 spec 自身预算一致；没有放宽恢复断言或添加业务重试。
- `desktop-e2e-20261010-version-fix-{automatic-required,optional,controller-required}-r2`
  三个独立变体均 **1/1 PASS**：后台先等待、点击后更新及恢复 A/B；可选版本保持 3.16.0、
  两项目恢复且“稍后”跨设置重开生效；本机过旧只提示升级本机，远端 archive 不变。
  后两项未出现 Desktop 管理服务更新成功日志，远端版本/产物保持。三个复用构建的原始状态仍保留
  `unverified-reused-build`；另将全部 5282 个产物摘要与上述 `fresh-stable` 构建逐一比较，
  完全一致，核验结果保存为各 run 的 `version-fix-verification.json`。

本轮四个变体保留 `manual-review/pending`，未做人工转正或 CI 准入。版本输入仍是完整当前
runtime 的元数据变体，不宣称验证真实 3.14.0 旧业务实现。运行任务取消/强制确认和晚到结果
由真实 Hook 边界测试覆盖，未另跑运行中任务的真实 SSH 强制更新场景；未复跑原生
Windows/Linux 桌面宿主及手机 relay 整链路。修复只调整桌面显式连接的向导编排，不改变
Host/协议、数据迁移或 continuous/replayable 权威；回滚本次提交即可恢复原来的等待按钮行为。

## 升级快照失败的显式恢复（2026-10-10）

`dcf125265e` 引入自动交接后，新增快照读取若失败，只清空 `upgradeProfileId`，
仍保留旧的升级错误；“更新远端”按钮因缺少 Profile 直接返回。修复在同一异常分支清除旧升级错误，
展示真实读取异常和既有“重试”，由用户重新发起原线路/目录的连接与升级核验。沿用 epoch 隔离，
不使用旧快照自动更新，不增加后台重试。

- 先补普通连接与原项目交接两个失败回归，修复前均失败；取消后迟到快照异常作为对照。
  修复后三项及原 Hook 用例 **23/23 PASS**。
- 受影响验证（起点 `dcf125265e55416eed962a342250b592c0f46461`）：
  **370 个 Vitest 文件 / 4382 项用例、28 项 Node 审计通过**；最终 E2E helper 调整后的
  inventory 审计 **9/9 PASS**。类型检查、E2E 类型检查、lint、架构及 fixture 检查通过；
  lint 保留 81 条既有警告。
- `r3-server-snapshot-fix-20261010-r2` **1/1 PASS**：重新构建桌面端，真实 SSH 升级夹具上
  注入短暂快照读取故障，向导出现实际错误详情及“重试”，失败期间未更新；点击后只更新一次，
  A/B 保留原身份和目录并取得新 session，远端最终版本为 3.15.0。
  `version-policy.json` 保存拒绝读取数（本轮 2 次）、按钮、更新调用数与恢复结果；
  `snapshot-failure.png` 保存失败界面。
- 首轮测试只拒绝首个无参数快照请求，命中并发后台读取而未覆盖向导，不能作为修复有效证据。
  测试改为短暂读取故障持续至向导确认失败，再恢复读取后验证用户重试；未修改业务方案或放宽恢复断言。

这次验证仍使用当前 runtime 的版本元数据变体，不证明真实旧版业务实现；未重跑原生
Windows/Linux 桌面宿主或手机 relay。手机不使用本次桌面显式连接向导，Host/协议及恢复 owner 不变。

## 2026-10-12 当前基线复核与修复边界

修复起点 `07c35ed00085b9bb105d07633488951ff02032c2`。原日志中的项目菜单仍直接调用
remoteProjectService.connectHost，现行 RPN-06/§2.2 则要求需要交互时交给唯一向导并保留目录。
既有 Root dispatcher/向导已具备凭据、受保护更新及安装确认处理，菜单没有接入；直接替换回调
还不充分：新版仅恢复活动 tab，Root 旧入口遇到未加载 tab/历史 entry 会直接返回。
真实 Root hook 的无 tab 项目回归确认了这一边界：认证/升级/安装交接及正常设备连接均未执行。

```text
已加载项目 → Root 原地重连 → 等待处理 → 唯一向导 → 原目录
未加载的已保存项目 → Host 成员 connectHost → 等待处理 → 同一向导 → 原目录
                                   └─ 普通成功只恢复设备，不新建导航 tab
```

推荐修复：桌面项目菜单调用现有 Root 重连入口；Root 在没有 tab 时从本机成员目录解析目标，
复用既有 dispatcher 和 connectHost。交接前重读成员，移除/替换后的迟到结果不打开旧向导。
连接状态、凭据及物理连接仍归 Host；不把 Renderer tab 恢复成项目入口权威。
非桌面路径继续使用原 Host 连接，不新增手机向导能力。

后台更新用例另按 F5 核对：冷启动只恢复活动项目，旧兼容列表中的另一项目应按需打开。
不能把未加载 A tab 当作更新失败；运行中已有 A/B attachments 的手动升级仍保留恢复断言。

### 首轮运行与进一步取证

批次 `r3-server-20261012022109986-c4ed79` 使用当前基线加项目入口修复，结果 5 PASS / 2 FAIL：
serverupdate 271.8 秒、serverupdate-force 268.9 秒、manual-required 260.0 秒、
snapshot-failure-required 263.3 秒、automatic-required 270.1 秒均通过。
后两项仍失败：projectnavigation 没有认证向导；uninstall 已点击安装确认，但随后收到
source-server-install-required。未把到达安装确认当作重装成功。

认证新增根因：SourceServerDirectory.resolveProfileTarget 缺少凭据时抛普通 Error，丢失了既有
credentials-required 公开码；真实 Directory 回归先失败，再在错误产生边界补码后通过。
Root 的文本分类不扩大为猜测认证原因。安装确认的真实 Flow hook 已验证传出 confirmSourceServerInstall=true
且旧错误清空；下一轮在 Main IPC 只记录确认标志与返回结果，不记录 target 或凭据，继续定位重装剩余失败。

### 重装根因复核：新恢复周期读取了旧终态失败

第四轮 Main 已确认 confirmSourceServerInstall=true，排除 UI/Main 丢失确认。第六轮 Registry
记录确认时 route=null，但同一 Source 仍有另一线路的 terminal owner，recovery=false、failure=true；
随后新连接才进入 canonical Source 归属。此前同线路 recovering 的合成探针没有覆盖现场，
安装特判与 Manager 授权接纳候选已撤回，不纳入最终实现。

现场：项目导航使用不含口令的 metadata 线路；用户确认连接加载了口令，得到不同 route key，
握手后仍属于同一个 Source。Manager 重新发布物理连接时，旧终态 owner 开始异步挂回 workspace，
但 recoveryFailure 直到全部挂回结束才清除，recoveryReady 又已在终态被清空。
新线路在此期间 join canonical owner，会直接抛出上一次的安装等待错误，尽管新安装连接已经建立。

```text
旧 owner：terminal + 旧 failure + 无 recoveryReady
新物理连接 → logical 挂回（异步）→ 新线路 join → 误读旧 failure
修复：新物理连接 → 新 recoveryReady，清旧 failure → logical 挂回 → join 等新周期结果
```

真实 Registry 回归使用现场同样的 agent/password 两种线路 key、同一 Source 和受控 workspace
准备屏障，修复前得到与现场相同的 Remote connection recovery exhausted 错误。
最终只在 terminal owner 收到新物理 reconnect 时调用既有 beginRecovery，并标记新的 recovering
周期；不新增安装特判、Manager flight 字段、重试或超时。回归与相邻 Registry/Manager 两文件
120 项通过。最终补丁的批次 `r3-server-20261012042036306-3218d0` 已通过真实重装（187.4 秒）、
恢复守卫（177.4 秒）和冷启动重连（187.1 秒）。源码清单 SHA-256 为
`3da756d09a6a91969782149c7f1d177124e49e5def287fcfde14ed11d56cd85d`。
重装证据确认安装 ID、Profile、项目身份、配置哨兵和用户数据保留；session 已替换，原任务仍可继续，
Host 进程集合没有增加。

### 最终服务器验收

批次 `r3-server-20261012042909750-5eed5a` 复用上述同一源码清单及已验真构建
`beb4f93a0a86d3c6f4d0fab7d21188f5838fd7a07248f9eb7162e7d0db5551ae`，六项全部通过。
与上一批三项共同覆盖本问题七项及相邻恢复/冷启动两项；没有合并不同补丁的 PASS。

| 用例                              | 结果 / 耗时     |
| --------------------------------- | --------------- |
| serverupdate                      | PASS / 256.9 秒 |
| serverupdate-force                | PASS / 255.3 秒 |
| uninstall                         | PASS / 187.4 秒 |
| version-manual-required           | PASS / 273.6 秒 |
| version-snapshot-failure-required | PASS / 231.5 秒 |
| version-automatic-required        | PASS / 237.5 秒 |
| projectnavigation                 | PASS / 73.1 秒  |
| recov                             | PASS / 177.4 秒 |
| coldreconnect                     | PASS / 187.1 秒 |

取消强制更新保持原 SHA/Core；确认强制更新后才替换。快照故障恢复后仅调用一次更新，
运行中手动升级恢复 A/B 两个原目录；冷启动自动升级按 F5 恢复活动 B，A 保留入口并按需打开。
认证验证保存项目无需已有 tab 即可进入向导，切换设备不泄漏上一设备的密码或下载方式。
最终代码与测试逐文件匹配服务器源码清单；之后仅补充验收文档。

### 本地验证与影响边界

- `pnpm test:unit:affected --base 07c35ed00085b9bb105d07633488951ff02032c2`：442 个 Vitest 文件、
  5174 项用例及 70 项 Node 检查通过；没有运行全量单测。此前一轮未改动的 Web 构建测试因并发
  超时失败，独立复验 45 项通过，最终受影响范围也全部通过，没有修改超时或断言。
- 类型检查、Lint、架构检查通过；Lint 为 208 条既有 warning、0 error，架构为 0 违规。
- 四份改动 E2E 的 fixture 合同检查通过；server-update 保留既有的升级标记未被 matcher 覆盖提醒。
- 版本策略场景使用当前 runtime 的版本元数据夹具，不能证明真实旧版程序的数据迁移。
  服务器运行覆盖 Linux Electron 与真实 SSH/Docker；未复验原生 Windows/macOS 或实体手机。
  非桌面连接仍走原 Host，Direct Server 的连接及错误语义由新增回归保持。
- 无存储格式、凭据迁移或协议字段变更。回滚本次提交即可回到原实现；不需要回滚用户数据。
