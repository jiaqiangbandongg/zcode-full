# Provider 本轮最终复审与交付

范围：基线 `1bc2e9bc42` 起的 Todo113 第二轮及 Todo115–132，共 19 项。代码分支 `provider-stabilization-20260911`。各 Todo 的规格及实施记录仍是逐项依据，本页统一记录最终批次结果；不把局部通过等同于真实多端全部验收。

## 逐项结果

| Todo       | 已实现并复审的要求                                                              | 实现／核验提交 |
| ---------- | ------------------------------------------------------------------------------- | -------------- |
| 113 第二轮 | 已核实新模型目录、智能配置、聚合差异、退役成员清理；真实 SDK 请求及冻结能力传递 | `262c42e592`   |
| 115        | Provider 标题栏、菜单、开关热区；不改变模型行布局                               | `8d16f98136`   |
| 116        | 单一获取 Key URL，清理配置、类型、Schema、传输及展示中的团队第二入口            | `3c22794269`   |
| 117        | 保留账号域，显式套餐选择；账号 Provider 不能禁用，手动 Key 仍可启停             | `30bb5f7005`   |
| 118        | 首次导入保留自定义 Provider 外层 enabled；不重迁覆盖新配置                      | `8481a34543`   |
| 119        | 连接测试恢复绿色反馈，展示 Provider 名称                                        | `875b5578ac`   |
| 120        | 官方两 URL 与显式 Coding Plan Key 共用完整签名链，成对及真实请求验收            | `ad3277af02`   |
| 121        | 追加 0022 补回可确定的历史档位，覆盖已执行／未执行 0020 两种升级路径            | `7b2bd3968d`   |
| 122        | Subagent 失败原因及模型身份投影；不冒称解决尚未复现的启动根因                   | `e1a28f23eb`   |
| 123        | 历史容量按已保存模型身份查 Registry；未知为 null，保留历史用量                  | `6d4c3cc571`   |
| 124        | 禁用 Provider 的连接测试提示改为不可执行，避免误报不存在                        | `875b5578ac`   |
| 125        | 九处帮助说明与双尺寸交互                                                        | `1c1da97537`   |
| 126        | Coding Plan GLM-5.3 隐藏视觉标仅影响展示；Flash PDF、套餐 API Turbo 默认值      | `1bf21bee22`   |
| 127        | 在线 Built-in 下载、严格校验、生命周期更新、过期请求失效及原子发布事实          | `036c3dd3c8`   |
| 128        | Provider 启动契约与闲时资格一致，合并并发启动、丢弃旧账号查询结果               | `b2e2b31ea3`   |
| 129        | 埋点边界恢复旧 ID，Team 分类及首页闲时门禁；不改报表或实际模型身份              | `ba119dde2f`   |
| 130        | 手动字段编辑契约；保留非编辑字段与正式保存边界                                  | `dcb231de22`   |
| 131        | 智能配置位置、原子恢复、旧请求失效                                              | `1c1da97537`   |
| 132        | 名称显式确认保存，选项底色与交互反馈                                            | `8d16f98136`   |

最终浏览器合跑暴露测试 fixture 的全局订阅互相覆盖，已隔离场景初始化并重跑全部通过：`0ac735ee98`。这不是产品账号状态回归。

推送门禁的扩大关联回归又覆盖 968 文件：964 通过、4 文件 16 项失败（10267 项通过）。逐项检查后处理如下，不能把首次门禁写成通过：

- 11 项模型编辑器失败定位到本轮帮助按钮嵌入 label，误占输入标签关联。先保留失败断言，再以唯一 id/htmlFor 绑定输入，帮助按钮放到 label 外；组标题不冒充单字段标签。复测 40/40，双尺寸真实浏览器补充“标题点击聚焦输入、九个帮助均不嵌 label”断言通过。
- 改名的两项旧测试补显式确认标记；闲时首页的一项测试改为验证共享 freshness 通知，而非组件自行跳过初始化通知。真实 Store 的并发去重与旧请求失效仍由本轮专项测试验证，未为迁就旧断言回改产品。
- 资源监视器两项失败为基线已有 Linux CPU 口径 fixture：原产品／测试与基线完全相同，模拟四核却把整机数值直接当 Electron 单核值。只修 fixture 原始输入换算，不改监视器实现或指标口径。

同一复修将恢复按钮 JSX 移入原有 Actions 文件，保持主弹窗在 400 行门禁内；行为及回调不变。随后同步了旧结构测试的标签预期。最终 **完整推送门禁通过**：root lint、架构、53 个直接改动测试文件及 118 个源文件的关联回归均通过，使用本轮真实基线 `1bc2e9bc42`，未跳过 hook。日志 `/tmp/provider-stabilization-final-push3.log`。

代码结果 `7c62534821` 已推送并核对远端 `origin/provider-stabilization-20260911`；此前未通过的两次门禁没有产生远端发布。标签修正后类型检查及 lint/架构再次通过，帮助／恢复的双尺寸真实浏览器 4/4 通过（`/tmp/provider-final-help-browser3.log`）。未创建 MR、未推送其他分支、未发布线上配置。

## 整批验证

| 检查                          | 结果与证据                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 根目录相关单测 68 文件        | **1028/1028**，`/tmp/provider-final-root-tests2.log`                                                                                         |
| Agent SDK／签名／Model 6 文件 | **173/173**，含新增第二轮真实 SDK wire 58 项；`/tmp/provider113-sdk-final.log`                                                               |
| 迁移／Bootstrap／Core 7 文件  | **241/241**，`/tmp/provider-final-cli-tests.log`                                                                                             |
| 独立入口契约                  | **4/4**，`/tmp/provider-final-entry-tests.log`                                                                                               |
| 真实 React 浏览器交互         | **20/20**，桌面宽度英文深色、手机宽度中文浅色；`/tmp/provider-final-browser2.log`，截图 `/tmp/zcode-provider-settings-batch`                 |
| 类型检查                      | 根、Adapter、Bootstrap 均通过；`/tmp/provider-final-{types,adapter-types,bootstrap-types}.log`                                               |
| 根 lint／架构                 | lint **0 errors / 42 warnings**；architecture **0 violations**；`/tmp/provider-final-lint3.log`、`/tmp/provider-final-architecture2.log`     |
| CLI Adapter 全量 lint         | **未通过**，26 项 max-lines；与开工日志比较错误文件及规则集合一致，未扩修原有超长文件。`/tmp/provider-final-cli-lint.log`                    |
| 新鲜 Desktop／Agent 构建      | 通过；后续 Electron 启动前 SIGTRAP，不能记作 E2E 通过。`/tmp/provider-final-electron.log`                                                    |
| 最终发布文件完整性            | revision **22** 文件 14 项通过；SHA256 `f94d2fe55eebbfda79c667c6ea90c71eb28d40bf2d020013c20288ab2a70f623`；`/tmp/provider-final-release.log` |

此前合批 Core 410 通过／5 失败已在基线复现：旧冷恢复 fixture、远程 Cron 禁用列表、账号 Provider 序列化预期。保留失败记录，不算本轮全绿，也不扩大为无关修复。

Todo120 已向两家官方服务各走普通 Key／显式 Coding Plan Key 入口，四次均握手成功、带签名、模型返回 200 及文本。原始 Key 仅在被忽略的本地环境文件，未进入代码、文档或 Air。新模型其他付费端点只有真实 SDK 本地 fetch 捕获，不能称真实服务验收。

## Pro 补充验收（2026-09-12）

此前“Pro 普通 SSH 命令失败”不能归因于网络或 Pro 不可用：`macbook-pro` 使用 tunnel-only key／forced command；已有 `macbook-pro-admin` 才是管理连接，已确认正常。私有依赖重新下载仍受钥匙串权限限制，但可以在隔离目录复制已有依赖，从当前提交重新构建，不必操作日常配置或传递凭据。

- 隔离目录 `/Users/dev/provider-stabilization-pro.euQzIZ`，源代码为 `git archive fc757c0ec9`。仅复用旧测试目录的 node_modules；App、Host、Agent 均重新构建，测试配置／Session 独立，不使用旧安装包冒充本轮结果。
- Electron 冷恢复 **1 文件、1 场景通过**，实际包含 CW01–CW06：1M/64K、Compact 冷水位、缺档位身份仍查得容量、未知模型历史可打开且无伪分母。`/tmp/provider-20260912-pro-cold-resume.log`。
- Electron 设置 **3 文件、4 项通过**：智能配置及恢复的真实文件往返、取消／失败草稿、Map 编辑、模型修复与删除提示、连接测试成功／失败及原选择保留。`/tmp/provider-20260912-pro-settings.log`。
- Pro Chrome 双尺寸交互 **20/20**：使用真实共享 React 组件及隔离 fixture。默认 Playwright 缺少浏览器，改用已安装 Chrome 后成功；首次启动失败不算产品失败。`/tmp/provider-20260912-pro-browser2.log`。中文浅色帮助、标题栏／单链接截图已人工查看，中文字形与窄屏显示正常；本地证据 `/tmp/provider-20260912-pro-artifacts/`。
- Electron 账号 CTP-12 **通过**：完整应用使用隔离套餐服务 fixture，长团队名宽窄布局、套餐切换落盘、重新进入／重启保留选择；不是仅渲染组件。`/tmp/provider-20260912-pro-account.log`。
- 同批 `provider-readiness-agent-startup` **失败**：到达空配置草稿后，测试要求点击发送，实际按钮 disabled。测试文件及 `ConversationComposer.canSend` 的 `submissionReady` 门禁与本轮基线 `1bc2e9bc42` 相同；后续测试还依赖已撤销的账号菜单 `preset:` API Key 入口。属于旧测试与当前交互契约不一致，不放开发送或恢复旧菜单来迁就测试；本轮未重写该既有用例，其后半段不能记作已验证。生命周期的本轮定向单测结果仍有效，不用其替代缺失实机证据。
- 上述浏览器场景不等于手机 shared-host／SSH 联合实机，也不证明已登录控制台或真实付费 Team 服务成功。
- Todo116 原生链接后续补齐：新增 K116-N01 **通过**，两类模板 Access、有/无 Key 经真实设置按钮、平台接口和未 mock 的 Electron shell 打开系统浏览器，由本机唯一 canary GET 确认精确 URL，配置文件字节不变。`/tmp/provider-20260912-pro-native-key2.log`；首次测试漏填 templateId，按“仅模板提供入口”的已裁决规则修正测试后通过，无产品修改。新的 pending 用例和无模型请求 manifest 一并留存，不宣称官方控制台登录通过。
- 原生用例最终 review 补充排除 Electron 内部导航后，`/tmp/provider-20260912-pro-native-key3.log` 再次通过，网络记录模型请求 0。根/E2E 类型、lint、架构及 coverage audit 通过；fixture checker 不支持 settings 目录，明确记录而不扩改框架。剩余 SSH 正式用例要求的测试 host/username/password 在当前本机和 Pro 会话均未配置，两端无 docker 命令；不借用日常账号或未隔离目录冒充测试环境。
- Todo127 后续补齐：Pro 真实 HTTP 慢正文／两个真实消费进程／Registry 配置消费三项通过，`/tmp/provider-20260912-pro-builtin-runtime.log`。另新增 BR117-N02 完整 Electron **通过**：设置页刷新驱动正式控制面→HTTPS CDN→Active→Registry，容量500K→700K；两次真实模型请求使用同一模型、`top_p` 从0.17变为0.37，Personal 文件字节及最近选择缓存不变。最终日志 `/tmp/provider-20260912-pro-builtin-refresh3.log`，本地 wire `/tmp/provider-20260912-refresh-asserted-wire.json`、控制面/CDN记录 `/tmp/provider-20260912-refresh-network.json`。模型响应来自 case 内本机 synthetic server，不冒充官方模型响应、运行中 Model 或手机／SSH。
- 新用例复审：复用现有网络代理、CA、退出后种入隔离配置及正式按钮；不直接写 Active，不替换下载器或 Registry。Root/E2E 类型、根 lint（0错误/42既有警告）、architecture、coverage audit 通过；日志 `/tmp/provider-20260912-refresh-{root-types,e2e-types,lint,architecture,audit}.log`。用例及两请求 manifest 保持 pending，未越过人工晋级或不受支持的 settings fixture checker。
- 整页 `settings-ui-polish` 再补验：初次运行发现本轮漏更新的删除菜单、分组 label、最终 DeepSeek 两成员断言，以及原头像菜单未关闭污染后续真实滚轮。仅修测试及收尾，未改产品，未删滚动检查。最终 `/tmp/provider-20260912-pro-settings-polish4.log` 通过：8项实际执行，另1项 Windows 在 macOS 提前返回（WDIO算 passing但本记录不计已验），1项 SSH 缺环境跳过；单跑创建/滚动也通过。创建、删除真实 Personal、模型调序、编辑/取消/保存、Map 原文、两个视觉入口和390px中英深浅布局已覆盖，截图 `/tmp/provider-20260912-pro-editor-{dark,light}-390.png` 已检查。Root/E2E 类型、lint、架构、coverage audit 通过；未创建新正式测试或将 pending 擅自晋级。

## 最终交集复审（契约）

- **迁移与恢复**：0020 checksum 未动；0022 只补可证明同模型、尚未被后续修改的回填记录。旧字段、消息正文、时间与已有 options 不覆盖。历史显示查询元数据不要求创建执行 Model，不能因此放宽正式执行校验。
- **配置与账号**：账号禁用取消由共同解析及写入边界落实；手动 Provider 开关只作用于本身。配置保存不再清空账号域；启动、在线更新及闲时查询对旧结果有版本边界，不添加业务发送前强同步或第二事实源。
- **请求与身份**：签名复用既有正式链路；埋点旧 ID 只在输出边界投影，不渗入选择、执行或存储。新 Schema 能力在 Model binding 时冻结，无 Runtime 厂商名判断；正在执行的模型不因配置更新改变。
- **UI 与多端**：设置及选模展示共用规则；视觉标例外仅在产品指定展示层。编辑草稿、保存、恢复各有独立边界。未修改桌面 continuous、手机 replayable/shared-host 或 workspace identity 协议。双尺寸浏览器通过不替代手机远控实机验证。

## 保留事项与交付边界

1. **真实桌面／多端验收**：Linux Electron 启动限制保留，但 Pro 已补齐冷恢复、设置真实文件交互、中文实际字形和原生 URL 打开；不再称这些项目未测。Air 独立环境仍有私有依赖权限限制。真实付费 Team 状态及手机／SSH 联合链路尚无本轮实机证据，不能用浏览器 fixture 通过代替。
2. **线上配置不是自动发布**：实际 CDN 仍是 revision 19，带已删除字段，严格解析会拒绝。仓库及验收产物已为 revision 22；需要有权限的发布流程发布最终文件，不能把本地 HTTP／双进程成功说成线上已更新。
3. **未确认模型供给**：Omni 北京 Messages、百炼 Kimi 高速版对应协议／附件、MiMo UltraSpeed 商业开放等仍按 Todo113 研究记录保留，不猜 ID 或能力；不阻塞其他已证实型号。

独立可执行工作已处理；按用户授权推送当前分支，不发布配置、不建 MR。不宣称 19 项已全部实机验收，也不将这些限制偷偷转给 Todo102 后关闭本 Goal。
