# R3 合并后远程自动化实际测试方案

导出边界：`harness/remote/**` 是内部远程测试部署设施，不进入开源树；直接依赖它的 `r3RemoteMobileSite`、`r3RemoteProcess`、`r3RemoteProfiles`、`r3RemoteScheduler`、`r3RemoteSource`、`r3RemoteSpecInventory`、`r3RemoteVpn` 单测同步排除。公共远程实现与独立 E2E 保留，排除合同见 `opensource/README.md`。

当前范围与验收标准。2026-09-07 确认的完整验收目标继续保留；早期分支名、环境准备过程和执行缺口属于历史记录，不能作为当前运行结果。
执行命令、环境准入和资源隔离由 [harness README](../../harness/remote/README.md)维护；
用例定义见[矩阵](r3-remote-automation-case-matrix.md)，阶段结果见[桌面 SSH 指南回归](desktop-ssh-guide-regression.md)和各日期报告。

完整验收要求 50 次恢复循环、2 小时长稳；当前 harness 的 soak-reconnect 为 10 轮、soak-dual 为 10 分钟。
两者不能互相替代。补足完整档位及其运行证据仍是覆盖差距，本次不降低要求、不改编排、不宣称完成。

## 1. 已确认决策

2026-09-07 三轮 grilling 与 2026-09-08 后续确认的结论（逐轮问答表见 git 历史 2026-09-13 前版本）：

- 范围：整条远程主线；逐项建立变更、行为、用例和证据映射，不局限于 Provider happy path。
- 真实性：Desktop、SSH、安装、RPC、文件和 Agent 执行均真实，只控制模型响应；可控回放不允许未匹配时转 live；另有真实模型验收。
- 隔离：专用账号或独立 SSH 容器承担故障；workspace 子目录不足以隔离全局 Provider、凭据和 Server；不接管用户当前应用数据。
- 平台：macOS → Linux SSH 完整回归、Docker 代表、手机浏览器真实 relay；WSL 单独 Windows 执行包，缺环境为 BLOCKED；移动浏览器与手机实机分别登记。
- 执行方式：WDIO 固定套件 + Agent 探索补漏；新用例首次审阅语义和关键录像，稳定用例重复执行自动收证；保留 dev:desktop 开发入口验收。
- 基线：clean / premerge R3 / supported-old 三类；旧 App、旧 Server、旧数据分别认证，不以版本号或空 runtime fixture 替代完整旧环境。
- 真实模型代表：账号 Coding Plan 用 BigModel **Team Coding Plan**（同一现有登录下的 Team 项目，已通过独立 Linux x64 最小请求；个人套餐 429 只保留为历史结果）；API Key 用本机名为 `ZAPI` 的 Anthropic Messages 配置 / glm-5.3（此前豆包结果保留为历史）。真实请求消耗上限已取消，按覆盖需要执行并记录请求次数、失败、重试与服务返回的 usage。
- 覆盖策略：行为与状态转换全覆盖，高风险交叉专项，其余 pairwise；不进行全局笛卡尔积，每项剪枝有理由与代表证明。
- 分档：smoke / full / soak；50 次循环 + 2 小时长稳；首次完整验收包含 soak，耗时由试跑测量，分档不缩减完整验收范围。
- 缺陷处理：可修测试基础设施；产品缺陷先复现、定位、记录；阻断依赖路径、继续独立路径；产品修复进入独立阶段，设计问题交用户裁决。
- 过程记录：必需的运行、步骤、失败、清理和修复前后记录合同见 §8。

## 2. Feature Summary 与范围发现

| 字段             | 内容                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Operating mode   | implementation-handoff：交付可实施方案与已接受用例，历史规划阶段；当前实现清单由 harness inventory 和覆盖矩阵维护                         |
| Change layers    | presentation、option-source、draft-default、validation、commit-effect、persistence、recovery      |
| 主要领域         | 连接/部署/身份；Provider 配置与执行；工作区/对话/设置；跨端恢复                                   |
| 必须检查         | 首连屏障、重连换代、全转发 RPC、Source 写路由、旧配置与身份迁移、构建实际身份                     |
| 条件检查         | SSH 平台能力、Docker/WSL、浏览器 relay、模型账号与真实请求、旧版运行与回退                        |
| 不变量检查       | 本地流程、单 Window Host、CLI 单队列、continuous/replayable、不同 Source 隔离、日志无 secret      |
| 不扩展的产品范围 | 远端 cron automation、Direct URL 新产品入口、R4 全量 key 清洗、崩溃后自动续跑、任意多窗口角色切换 |

实施第一个 gate 必须生成 `change-map.json`：分别扫描 R3 主线、合并增量和后续修复的改动，记录文件/符号、命名的语义关系、权威规格、相关用例 ID。非远程改动填写排除理由；共享 facade、协议、构建和状态 owner 不得因路径未包含 remote/ssh 而排除。未解释的远程相关改动标 `unmapped`，完整覆盖不能验收。静态可达性只提供线索，不把所有 staging 文件机械纳入远程用例。

### UI Surface Matrix

| 场景 / UI 入口                                                 | 共享实现 / 展示草稿 owner                           | 默认/校验                                                      | 提交动作 / 权威落点                                         | 模式与隔离                                                            |
| -------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| 添加 SSH / 设备连接向导                                        | SSHDialog、Host 连接管理                            | target、安装确认、版本门、首连 Provisioning                    | Connection Manager → Transport → Source daemon → attachment | 凭据不进 tab；确认前无安装；本地下载必须显式选择并断言                |
| 设备设置页 / sidebar / device picker                           | Controller projection、Source 行                    | Source online、操作状态、identity                              | RemoteWorkspaceController → management/profile 服务         | 三入口共享意图；离线不回落本地                                        |
| 项目与历史用途隔离                                               | Root history、open membership、TabStore             | Source/realpath/purpose、已有 attachment                       | Source backing workspace、logical session、持久 open set    | 本地/远端同 path、两 Source、项目/聊天互相隔离                        |
| 模型设置页                                                     | SettingsPage → Local ServiceProvider                | 本地 Provider draft、Configured Default；本地 connectivity cwd | Local ProviderSettings → 成功保存 → Provisioning source     | 激活远端 tab 仍编辑本地；不出现远端编辑/手动同步入口                  |
| 对话模型选择 / 无模型横幅                                      | useModelSelectionView、pane draft                   | 目标 Host Registry / selection validation                      | 目标 ModelSelection、CLI 创建 Model                         | remote-waiting 不用本地候选兜底；旧 generation 回包丢弃               |
| Skills/MCP/Plugins/Hooks/Subagents/Memory/Output/Settings-sync | Source scope 与 workspace scope 的 hooks/attachment | online、user/project scope、目标投影一致                       | 所选 Source 正式配置 / workspace 文件                       | 模型页本地化不能带偏这些设置；手机不开放 Source 管理                  |
| 文件/终端/Git/媒体                                             | 全转发 RemoteWorkspaceRpcContract                   | scope、路径执行、媒体授权                                      | 远端 services / filesystem / PTY / repo                     | 真实远端 IO；客户端本地能力走 platform seam                           |
| 会话区 / task 列表 / pending interaction                       | V4 pane、Controller 索引投影                        | task address、owner/lease、CLI admission                       | 远端 CLI / Session / task index                             | 本地/远端 task 不串；拒绝、ACK、queue 唯一去向                        |
| 手机 /remote                                                   | browser projection、trusted attachment              | 已有 Host/session、可信 clientMode                             | 现有 CLI，同一 CommandInbox                                 | replayable 独立订阅；不创建 SSH/Host/Agent；不影响 desktop continuous |

### Shared And Divergent Behavior / State Owners And Commit Sinks

```text
Desktop 模型设置 -> Local 正式配置提交 -> trigger
                                          |
Main coordinator [Environment key / generation / registration，仅元数据]
                                          |
Window Host 现读 Local Source -> Remote Target.apply
                                          |
远端正式 Store -> Account/Registry refresh -> 新建 Model

首连: applied / already-applied -> Workspace ready
      failed / rollback_failed / unsupported -> 拒绝 ready、释放待建 attachment
重连: 新 remoteSessionId -> 恢复 workspace；重新登记同步失败只 warning

Desktop continuous ------+                 +-> 独立 desktop subscription
                         +-> 已有 Host/CLI +-> 一个 CommandInbox
Mobile replayable -------+                 +-> 独立 mobile gap/snapshot
```

- `sourceServerId` 是稳定设备环境身份；`remoteSessionId` 是可换代的连接路由；`workspaceIdentity?.trim() || workspacePath` 是隔离 key，文件/cwd 使用 path。
- Host Directory 是 Source/Profile 事实源；open membership 与全部设备历史是不同状态；task index 不能代替 Session 正文或 CLI runtime。
- Provisioning 的 Environment key **按 transport target 派生**，不是 Source ID。同 key 多 workspace/窗口共享 lane；同 Source 不同线路允许独立同步。不同 `syncId` 的两次 apply 不叫同一次幂等重放。
- 配置静态事实冻结在已创建的 **Model 对象**。普通下一 turn 创建新 Model，目标刷新完成后同 Session 下一 turn 就应读新配置；动态账号 header 另走其刷新合同，不能宣称所有鉴权永久冻结。
- Provider 同步仅替换 Personal Layer、Configured Default、账号窄字段和 allowlist 凭据。目标自行刷新 Registry；Builtin Release、代理、locale、目录、非 allowlist 凭据保留。
- 明文 Personal Provider Config 是当前合同；日志、trace、snapshot、artifact 不能泄露 secret。不能把正式 store 内合法明文误判成“日志泄露”。

### Codegraph Evidence / Feature Relationships

本次没有 callable codegraph；使用 git diff、精确 rg、源码与测试追踪 1–2 个语义跳点。不得宣称执行过 codegraph 或运行测试。以下是后续索引复核种子：

| Rank           | 种子 / 当前直接路径                                                                                    | 关系与证明任务                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| must-inspect   | desktopRemoteSessions → ProviderProvisioningEnvironmentCoordinator → remoteProviderProvisioningService | 首连 ready、重连换代、single-flight、旧 Host 注销                  |
| must-inspect   | ProviderSettings/credentials 保存 → node.ts source trigger → providerProvisioningSource/Target         | 最新快照、事务/回滚、幂等、allowlist 删除                          |
| must-inspect   | SettingsPage → Local ProviderSettings；useModelSelectionView → remote facade → turn-model              | 编辑权威与执行权威分离；当前/下一 Model 配置                       |
| must-inspect   | sourceServerReleaseResolver → sourceServerConnectionManager → transportAdapter → CLI release runtime   | 同版本 SHA 变化、真实安装与活动进程一致                            |
| must-inspect   | useRemoteWorkspaceHistory → Controller/Registry → renderer port bridge                                 | 保留失败历史、明确断开、旧回包、open membership                    |
| must-inspect   | sourceSettingsServiceCollection → SubagentsSection 等 Source hooks                                     | 无项目 user scope 与模型选择接缝；不可用代理只是风险候选，需实跑   |
| should-inspect | remoteWorkspaceRpcContract → full-forward services → mediaPreview/file/Git/terminal                    | 新 channel 集合和 Source 权威；合同仍为 v1，兼容门应在分发前拒旧端 |
| invariant-only | windowHostAttachmentRpcPolicy、Core http.ts、task realtime / CommandInbox                              | 手机无 provisioning/terminal/management；desktop sibling 持续工作  |
| evidence-only  | SSH P0 formal/pending specs、CLI verify-remote-ssh                                                     | 复用 harness 与 fixture；存在 spec 或旧 artifact 不代表当前通过    |

### Graph Drift Candidates / Graph Delta

已确认的过期关系：旧 `provider-sync` service/journal、Source 设置中的旧 model-provider hook；它们被自动 Provisioning 替代，更新语义图的当前边与文档入口。`zcode-domain-cross-products.md` 的旧双队列、Desktop Provider Registry 权威同步描述同时改成现行 CLI/Environment 合同。

历史文档里的“本地删除不会撤销远端凭据”与当前 allowlist replace/delete 相冲突，以 [Provisioning 当前规格](../remote/provider-provisioning.md) 及 Target 正式 store 写入为准，修正文档漂移。旧 R3 的一般性多窗口非承诺不取消具体的跨窗口 lane 和 RCONV-16 合同；其余未定义窗口角色行为留在矩阵的 undefined 区。

## 3. 环境、材料与隔离

| 环境      | 本轮用途                                                                    | 真实程度 / 验收边界                                                                                              |
| --------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| E-SSH     | 当前 macOS Desktop → linux-amd64-dev 的 Linux x64 SSH                       | 密码、真实 sshd、archive、Server/Agent、开发入口；实测该 alias 指向本机 Docker 暴露的 SSH，不能宣称跨机 WAN 验证 |
| E-ISO-A/B | 新建独立 SSH 容器，两个独立 Source，相同绝对项目路径                        | 配置删除/损坏、版本切换、kill Core/Agent、配额/权限/网络故障；每轮可重建                                         |
| E-SVC     | 带可用 user service manager 的独立目标                                      | systemd 成功、缺 bus 环境恢复、真实注册失败；当前 E-SSH 仅有 detached 能力                                       |
| E-DKR     | Desktop Docker transport → 独立 Linux 容器                                  | 真正 Docker proxy-stdio 代表，不用“SSH 到 Docker 容器”替代                                                       |
| E-MOB     | 移动 viewport 浏览器 + 本地 web + 显式匹配环境的外部 relay + 已有 SSH scope | 真实配对/attachment/恢复；browser 自动化不是 iOS/Android 实机证据                                                |
| E-WSL     | Windows Desktop + WSL2                                                      | 平台执行包准备，缺 Windows 时 BLOCKED；不降低跨 transport 发布门禁                                               |
| E-OLD     | 认证的旧 Desktop / Server / 数据 fixture                                    | 三者单独记录版本、来源、SHA、schema 与可运行性                                                                   |

隔离要求：

1. 当前桌面 SSH adapter 固定远端用户 `~/.zcode/server`。CLI 虽支持 `--server-root`，该能力未贯穿桌面入口；不得把本地 `ZCODE_DATA_BASE_DIR` 或两个项目目录当作远端环境隔离。
2. 专用本地 E2E profile + 专用远端用户/容器；真实模型只将选定代表配置通过产品写入口导入隔离 profile，再由正式 Provisioning 下发。不得盲拷用户完整 `.zcode`。App数据/Chromium/CLI/Helper目录必须分别检查：旧版Helper还需要独立 `ZCODE_HOME`，仅设置 `ZCODE_DATA_BASE_DIR` 与 `ZCODE_DESKTOP_HOME_DIR` 不足以隔离它。
3. 项目 fixture 位于各自实际 workspace 的 `.zcode-e2e/<run>/<case>`；两个 Source 使用相同 POSIX path 验证身份隔离；同时保留一个本地 workspace 作为反向污染哨兵。
4. 专属环境串行执行 `ZCODE_E2E_MAX_INSTANCES=1`；独立环境可由未来 runner 做有界并行，不能共享默认安装根、provider store、端口或录像输出。
5. systemd 容器不得因使用 private cgroup namespace 就视为完全隔离。启动前必须持久 mask `systemd-binfmt.service`，核对 Docker VM 的 binfmt 注册前后不变，并复验已有 x64 目标。未验证这些前置条件的 privileged fixture 禁止复用；不得通过手工重写共享 binfmt 来绕过失败。
6. 故障只作用于登记的容器/用户、连接和 PID。PID 操作前复核 start time、运行路径、releaseId、归属；不再用 `zcode-server.cjs` 名字或新旧 PID 差集猜所有权。不操作宿主 sshd、系统网络或填满共享磁盘。
7. 网络和文件故障优先外部 TCP 代理、限额测试文件系统、权限控制与已支持的服务依赖注入。若准确事务阶段没有控制点，先建测试 seam 并单测，不能靠 sleep 猜测写入窗口。

## 4. 测试执行链与实现缺口

```text
change-map + materials preflight
  -> 本轮构建与 archive 内容验真
  -> 干净 profile / 专属 target / replay ready
  -> 首装与首连 barrier
  -> 独立 full 测试包 [开发 / 配置 / 身份 / 对话 / 恢复 / 设置]
  -> 升级迁移 / Docker / Mobile / live 代表
  -> soak
  -> evidence audit + cleanup audit + 分环境结论

某依赖失败 -> 该分支 BLOCKED_DEPENDENCY，保存根失败引用
           -> 继续资源独立的分支，不批量制造相同超时
```

### 已有命令与能力

```bash
node scripts/check-workspace-freshness.mjs
pnpm bootstrap:with-remote
pnpm dev:desktop

# 单项 pending 的现有 WDIO 入口；SSH 凭据在受控运行环境注入。
ZCODE_E2E_MANUAL_REVIEW=1 pnpm --filter @zcode/desktop test:e2e -- --spec './test/e2e/conversation-session/manual-review/pending/<case>.test.ts'
```

`bootstrap:with-remote` 最后重新 stage remote archives，但不构建 Desktop bundle。WDIO 自身构建 E2E Desktop；开发入口验收另用 `pnpm dev:desktop`。两者必须从同一确定源码状态准备，不能将 WDIO PASS 写成已验证开发启动方式。跳过构建仅在 build receipt 的源码/配置/产物摘要匹配时允许。

**统一 `preflight/smoke/full/soak` runner 尚未实现**；这些是待实施 subcommand，本文不伪造已可运行的 pnpm script。最少需要五项能力：

| 工作包                | 复用                                                  | 需要补齐的能力 / 完成证明                                                                                                 |
| --------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| H1 运行清单与资源管理 | WDIO runId、SSH helper、CLI verifier                  | alias 标准解析、独占 target、能力探测、build receipt、账号类别与请求记录；缺材料时明确 BLOCKED                                |
| H2 产品连接与生命周期 | SSH dialog、cold reconnect pending                    | 显式选择本地下载、R3 Supervisor/Core PID 身份、断线代理、跨窗口/项目控制；不直接注入“已连接”状态                          |
| H3 同步与模型 oracle  | case-local replay、SSH reverse tunnel                 | 远端 Store 摘要/Registry readiness、实际 provider/model/body、syncId/generation；barrier 控制流和同步，未匹配 fail-closed |
| H4 Mobile/live 编排   | dev:web-remote-control、现有 attachment 合同          | 移动 browser 配对、真实 relay、独立断线；实际模型请求含辅助/重试均记录，不设人为消耗上限，鉴权值不进记录            |
| H5 记录与审计         | reporter、Electron window recorder、failure artifacts | 成功代表录像/关键截图、远端日志窗口、每步 JSONL、首次失败保留、前后数据对账、cleanup 审计、HTML/Markdown 汇总             |

H3 通过真实 SSH reverse tunnel 将远端模型请求送到受控响应服务；控制 SSH 连接与模型回放 tunnel 分离。断开 UI SSH 不应意外停止模型响应服务，否则无法证明远端任务独立继续。正式配置同步和远端 Agent 执行必须经过产品链路，禁止直接写目标配置后声称同步通过。

2026-09-08 实跑补充：通用 replay Personal Provider fixture 必须在空 Built-in 层也能独立进入 Registry，不能依赖本机 E2E Built-in 补足字段。需要显式给出 Provider group、Model enabled、requiresMfjsToolSchema、完整 properties，以及 reasoningLevel/maxOutputTokens 的 option map；显式禁用的 seed 仍保持禁用。否则本地默认模型下发到独立远端时会触发合法的 Registry 拒绝，不能把该夹具错误误判成产品同步失效。

## 5. 产物验真与历史兼容

每轮记录并核对：

```text
Git HEAD + 工作树变更摘要 + Node/pnpm/构建配置
  -> archive descriptor [version,target,SHA,size]
  -> 上传/安装事件 [local-download-upload]
  -> 远端 current.json [archiveSha256,releaseId]
  -> 活动 Supervisor/Core [PID,startTime,release 路径]
  -> 新 Agent [进程/加载入口身份] -> case marker 实际请求/执行
```

同版本的旧 daemon 是必测类，不能只比较版本号；同 SHA 的无操作复用与异 SHA 的更新分别验证。被 running-task guard 拦截时必须保留可操作错误与明确 force 入口，不应拿旧进程继续出 PASS。

旧材料分为：

- 本轮用户指定旧端：`/Applications/ZCode.app`，实际版本 `3.11.2`、包内 build commit `89817f5b`；保留原安装，仅用隔离 profile 启动。新端当前源码声明 `3.11.1`，验证基线为 `e31f76568f`。这是旧代码/新代码角色，不是按版本号大小排序；不得为了满足“同版本”假设修改版本元数据。先前 Downloads 3.10.0 探针保留为历史，不再作为默认旧端。精确同版本异 SHA 分支仍需单独证明，不能把这个实际版本不相等的组合计为通过。
- 合并前 R3：固定 `8009d8cd08`，可在隔离 checkout 重建旧 Desktop/Server；版本相同不代表提交相同。
- 支持的旧版本：选用经过来源、SHA、平台/包内 manifest 及实际启动验证的 App/Server 组合。现有旧包首先是候选，不把“文件存在/校验匹配”写成可运行或正式发行认证。
- 旧数据：由对应旧程序在专属环境创建项目、对话、选中模型、账号窄状态，再备份并在当前版迁移；数据库异常分支可用有明确 schema 来源的合成 fixture，报告标注 synthetic。
- 旧 Desktop 回退、旧 Server 更新和旧数据迁移是三个不同证明。源码重建可证明固定提交行为，不能代替正式签名发行包、自动更新分发或系统安装体验；旧版账户/远程服务不可用时保留对应 BLOCKED。

## 6. 用例分档、状态枚举与剪枝

完整 setup/action/assertion 与证据见 [矩阵](r3-remote-automation-case-matrix.md)。覆盖关系不是 spec 文件计数：每个已接受行为必须有独立 case ID、期望与证据，即使共用同一昂贵环境启动。

| 档位  | 内容                                                                                      | 用途                                               |
| ----- | ----------------------------------------------------------------------------------------- | -------------------------------------------------- |
| smoke | 材料/产物门、安装/首连、一个远端文件与终端操作、同步/首发、多 workspace 隔离、一次恢复    | 快速定位主链阻断；耗时实测后公布，不预先承诺分钟数 |
| full  | 全部 accepted 功能/故障/迁移、受影响 unit/contract、代表 Docker/Mobile/live、开发启动路径 | 按包执行，可恢复调度；不能把某包 smoke 当 full     |
| soak  | 50 次断开恢复 + 2 小时 Desktop/Mobile 并发、进程/连接/订阅/fd/内存趋势、生产日志量        | 首次完整验收与重大生命周期变更；模型使用回放       |

高风险维度：首次/重连、同步在途再次保存、空/无效/旧配置、旧/新 Model、同/异 Environment key、同 path 异 Source、项目/无项目聊天、主动/意外断开、running/blocking/idle、旧 generation 回包、desktop/mobile、旧版本/旧数据。主题/语言/viewport 用成对组合；服务纯事务分支用真实 store 集成、关键代表经 GUI，不复制所有数据库排列到 Electron。

## 7. 验收与失败处理

- 状态分别记录 `planned / running / PASS / FAIL / BLOCKED_ENVIRONMENT / BLOCKED_ACCOUNT / BLOCKED_DEPENDENCY / NOT_RUN / PRUNED / UNDEFINED`；产品覆盖与执行结果是两个字段。未实现、环境缺失、skip 均不计 PASS。
- P0：主链不可用、数据丢失/串 Source、secret 泄露、手机另起 runtime。P1：恢复挂死、假 online、更新/写路由错误、核心用户动作失败。二者阻断相应完整验收；P2 单列人工裁决，不能静默豁免。
- 每个 GUI case 至少 UI + runtime/protocol/network/persistence 之一；权限、同步、隔离与升级应组合检查实际请求和数据，不能只看 toast/records.length。
- 异步等待基于事件、请求 marker、权威状态与 guard；deadline 是失败上限，不能将 sleep 当作到达目标状态的证明。
- 时序问题修复后连续三次通过，保留首次失败及修复提交；不以“重试终于通过”关闭 flaky。每次迁移从全新旧数据 fixture 开始。
- 产品缺陷记录复现、预期/实际、源码/构建/环境、最小失败步骤和归因证据，进入独立修复阶段。测试自身失效可修，但必须保留修复前结果和变更原因。
- 资源计数需要在工作完成、所有 owned attachment 释放后的同等静止状态对比；connection/session/listener/fd 不应逐轮累积。内存采 warm-up 后序列并分析 retained trend，GC 波动不能直接当泄漏；没有证据不能任意放宽阈值。
- 首轮完整验收 = 当前可用环境 accepted 功能完成 + 时序复验 + soak + 证据/清理审计。SSH 通过与跨平台发布通过分开；WSL 等必需平台 BLOCKED 时不宣称全平台发布验收完成。

## 8. 测试过程记录合同

默认 artifact：`packages/desktop/.e2e-artifacts/r3-<UTC>-<runId>/`，产物不提交 Git。docs 只保存脱敏结果摘要与 artifact 索引。每个实际测试动作在操作前记录 start，操作后记录 observation/断言/结束；崩溃时也能找到最后未完成步骤。

```text
run/
  run.json                 代码、构建、环境、命令、配置摘要、材料校验、请求与usage记录
  change-map.json          变更 -> 规格 -> case ID -> artifact
  events.jsonl             时间、case/step、动作、预期、观察、状态、耗时
  cases/<id>/
    result.json            setup/action/assertions、各证据路径、失败分类
    screenshots/           关键交互状态
    recording.webm         首次代表路径/失败的 Electron window 录像
    protocol.jsonl         脱敏身份、generation、syncId、seq/ACK 与 reasonCode
    requests.jsonl         请求 marker/provider/model/静态参数；鉴权仅存在性
    process-before.json    归属、PID/startTime/releaseId、连接数
    process-after.json
    persistence.json       fixture marker、配置摘要、key 类别与数量、对账结果
    logs/                  case 时间窗内 Desktop/Host/远端 Core/Agent 日志
    cleanup.json           创建资源、实际回收、残留及恢复结果
  issues.json              首失败、最小复现、根因分类、后续修复关联
  summary.md               按环境/测试包统计和未执行原因
```

- 每个 case 的模型请求标记 `E2E_R3_<ID>_<run>`；artifact 引用 original failure，而不是只保留末次重试。
- 日志收集使用偏移/时间窗；远端旧日志不能混算为本轮错误。设置/凭据不全量 dump；只保存允许字段、非敏感配置 fingerprint、key 类别/存在性。低熵 secret 不以裸 SHA 作为对外证据。
- 提交前做 canary redaction 审计；截图遮挡凭据和个人身份，完整 replay 请求体也须移除 headers/token。账号真实认证结果不包含 token、邮件或用户资料。
- cleanup 失败使该 case 非 PASS，并阻止复用污染环境；已完成的业务断言和清理失败分别保留。不通过销毁环境来掩盖数据损坏，先完成证据与对账再销毁。
- Agent 探索也使用相同事件记录与 artifact；发现的问题必须补回稳定 case ID。未经固定断言的“看起来正常”记录为探索观察，不能计入自动化覆盖。

## 9. E2E handoff 与交付顺序

1. 先完成材料认证和 `change-map`；按矩阵逐包将 accepted case 写入 `manual-review/pending`，实现前检查当前图谱/规格漂移。
2. 优先修复 H1/H2/H3 的 harness 缺口，让安装、首连、配置下发、文件/终端和双 workspace 对话取得当前构建证据。
3. 补配置/身份/恢复包，再补升级迁移、Docker/Mobile/live；在资源独立时继续其他测试包。
4. case-local provider/file fixture，确定性流用 controlled-stream，协议故障用 fault-stream；真实 SSH case 不因在容器中运行就自动获得 Docker transport 或平台证明。
5. 首次 GUI/行为审阅后按 `e2e-case-lifecycle` promotion dry run → fixture check → apply → default replay。需入 Docker preset 的用例先独立 admission，再批量跑稳定 preset。
6. 机械检查：`pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm typecheck`、`pnpm lint`、相关 fixture/coverage audit。受影响测试足够时不追加无关全量 UT。
7. 实施提交遵守 Conventional Commits 与[仓库提交规范](../git/ai-agent-commit-message-guidelines.md)。完成报告分别列方案状态、harness 状态、测试执行状态，避免混为“已完成”。

### Planning Handoff / 未决项

| 产物/问题                                         | 落点 / 处理                                           |
| ------------------------------------------------- | ----------------------------------------------------- |
| 规格与测试策略                                    | 本文；语义共识已确认                                  |
| accepted/undefined/pruned 与实现状态              | 专项矩阵；主 catalog/coverage matrix 添加索引         |
| 可用账号、额度、环境、旧包                        | 准备度记录；元数据存在不等于在线可用                  |
| 精确原版历史基线                                  | 认证现有旧包或重建指定提交；不能猜版本所对应的 commit |
| 多窗口一般性自动重连角色、全空 workspace idle TTL | 保持 UNDEFINED；具体 lane/RCONV-16 合同正常验收       |
| 测试实现                                          | H1–H5 与矩阵逐包实施，当前均未新实施/实跑             |
