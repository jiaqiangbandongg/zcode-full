# Todo105–113 本批实施与交付复审

2026-09-10。范围：105、106、107、108、110、111、112、113；109 保持已完成迁移语义，102 既有欠测、101 Draft 不实施。

## 逐项结论

| Todo | 实现与证据                                                                                                                     | 抽象及边界复审                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 105  | 四个个人/团队 Account 名单只保留 5.3/Flash；实际发布配置、Settings/Registry 成员测试                                           | 不删型号专用规则，手动添加 5.2/Turbo 仍能解析；不改 Start、闲时或历史选择                                                                        |
| 106  | Sonnet 5 不再误开 MCS；Opus 4.8 模型级开启；普通套餐/Start/闲时各 URL 独立规则；真实 SDK 捕获 system/search wire               | Runtime 不恢复域名特判；Personal 可覆盖；不把套餐媒体能力扩到普通 5.3 或闲时                                                                     |
| 107  | Provider 外层 enabled、三色灯、删除三态反馈与重试、连接测试成功关闭按钮、纵向拖拽、全部 17 模板 Key URL                        | Resolver 唯一准入源；不逐模型禁用、不解绑、不清选择、不收回已绑定 Model；Team 菜单按具体 ID 查 Settings View，不使用其继承的个人 Provider        |
| 108  | Verifier 继承绑定模型推理档位、输出使用模型上限；5 条真实 Runtime/Adapter 请求测试                                             | 不改变其他低成本辅助调用，不在通用 Factory 加特判                                                                                                |
| 110  | Guide 仍重新解析；比较旧 Loop Model 与新完整 Selection 决定重建 System；9 条真实 Runtime 请求测试                              | 同选择改配置后实际输出上限更新，System 不被切模逻辑重建；Session 与 Loop 不混用；真实切模时输出风格冻结的既有问题不扩修                          |
| 111  | 普通/套餐 × BigModel/Z.ai 四模板；新增 zhipu-coding-plan-api-key；双域手动套餐进入安全校验、普通 API 不进入；SDK/开关/缓存测试 | 不迁移现有实例；普通 API 搜索不开；Key 保存保留新类型；仍复用现有安全校验、配置分发和账号校验路径                                                |
| 112  | 官方 GLM 名单、精确规则及 Start 名单规范；Subagent/Bot/Wiki 导入补确定性改名；SQLite 0021、App 0003 增量迁移                   | 不修改旧 migration/checksum；旧字段、时间、正文、历史来源、闲时 Ticket 不动；坏 JSON/缺失字段不崩，回滚重升不复活旧选择；自定义/未知型号不猜     |
| 113  | GPT-6 Astra、Fable 5.1、DeepSeek Flash；聚合模板仅加入核实 ID；SDK 16 个协议/档位用例                                          | 新型号专用规则不扩大旧 Pro/代理别名视觉；Fable adaptive + auto tools + JSON Schema，沿用跨模型 thinking 清理；不启用强制工具调用或新增 beta 特判 |

## 关键链路

```text
开关 -> 现有 Personal Overlay 事务 -> ProviderConfigRule.enabled
     -> 同一配置快照序列化/分发 -> Resolver -> Settings View / Registry
                                          |                 |
                                       灰黄绿            新 Model 准入
已绑定 Model ---------------------------- 保持原执行

手动套餐 Key -> 共用 Key 配置/保存 -> 显式 access type 安全校验准入
                                 -> 既有开关/官方版本请求安全校验 -> SDK 请求
```

配置层统一缺省 enabled=true；UI 只投影 enabled/executable。不新增同步系统、发送屏障、账号查询或 Runtime。桌面 continuous 与手机 replayable 边界不变，远端仍使用目标 Host 的配置，不回退本地。

## 验证与限制

- 最终合并批次：105 个测试文件、1091 条单测全部通过；包含 Provider/Account 服务、配置规则、数据库及文件迁移、请求安全校验和设置 UI。最终 typecheck、lint（41 个既有 warnings、0 errors）、架构检查（baseline/new 均 0）通过。

- 首次 pre-push 全量检查发现 `legacyProviderUpgrade` 一条旧测试仍要求模板返回小写 `glm-5.3`，与 Todo112 已裁决的官方 ID 不符。仅更新为 `GLM-5.3`，保留 Key、旧文件、后续编辑及不重复导入的原断言；不借此调整旧 Provider 迁移语义。

- Provider/配置/迁移/设置第一组 507 条通过；扩展服务与 UI 集合原有 523 条通过，3 条旧预期随本批调整后复验通过。账号组合及 Team 状态灯另有回归。
- Adapter 6 文件 42 条通过（双域安全校验、MCS、DB 回滚、Verifier、新模型）；新模型 auto tools/JSON Schema 和 reasoning history 2 文件 41 条通过。Guide 9 条通过，前一批 Runtime/tool-loop 186 条通过。集合有重叠，不相加宣称独立总数。
- 共用请求安全校验的 Key 隔离、并发合并、失败降级、Abort/凭据错误不降级及动态开关测试复验；没有使用真实 Key 或付费模型。
- 新增 `packages/ui/test/browser/manual-review/pending/provider-settings-batch.test.mjs`：真实组件 + 隔离服务适配器；390px/中文/浅色和 1200px/英文/深色通过，覆盖分组、非空 Key 入口、enabled 保存、拖拽、删除失败重试、成功关闭。不是 shared-host 实机证明。
- 更新 settings-ui-polish、pending provider-settings-write-recovery、Guide GS/P06 预期；三份 Electron 测试本轮未完整实跑。Pro SSH 此次未能连接，真实手机 shared-host + SSH、线上模型响应、控制台登录态不宣称已验证；不把用户延期的联合实机验证写成通过。
- `pnpm typecheck`、CLI adapters/core typecheck、`pnpm lint` 已通过（lint 既有 warnings、无 errors）；最终提交前统一复验，以 MR 记录为准。架构 baseline 不更新，无关既有问题不扩修。

## 模板 Key URL 核对（2026-09-10）

URL 在 Built-in 模板元数据唯一维护。智谱四类入口见 Todo111；其余新增入口：

| 模板            | 官方入口                                                            | 层级                            |
| --------------- | ------------------------------------------------------------------- | ------------------------------- |
| Kimi            | https://platform.kimi.com/console/api-keys                          | Key 控制台                      |
| MiniMax         | https://platform.minimaxi.com/console/access?tab=api-keys           | Key 控制台                      |
| Qwen 中国       | https://bailian.console.aliyun.com/cn-beijing?tab=model             | 官方区域控制台，不猜用户深链    |
| Qwen 国际       | https://modelstudio.console.aliyun.com/ap-southeast-1?tab=dashboard | 官方国际控制台                  |
| MiMo            | https://platform.xiaomimimo.com/                                    | 官方上级入口，未声称直达 Key 页 |
| OpenRouter      | https://openrouter.ai/keys                                          | 官方 Keys；未登录重定向         |
| OpenCode 三协议 | https://opencode.ai/auth                                            | 官方 Zen 登录，共用 Key         |

DeepSeek/OpenAI/Anthropic/xAI 沿用已有官方控制台 URL；全模板断言存在 HTTPS 链接。

## Impact-only 复核

实际 diff 对 feature graph codeSeeds 扫描命中 model-capabilities、model-selection、provider-templates、plan-entitlements、provider-registry、subagents，以及 provider-settings / conversation-model-control。必须检查 Settings Facade、Resolver、Access 序列化、ModelFactory/Adapter；一跳检查 Composer、Automation、Bot、Wiki、Subagent 的候选与独立提交。

本分支还包含先前已提交 DB109 与文档，故命中 task-index、session-model-timeline、assistant-message-model-provenance、plugin-reference-reminder-history、conversation-share-context。这不是本批重写这些功能，DB109 回滚测试继续覆盖。测试、i18n、文档归属上述证据；无需要新增产品边界的 diff 差集。

无 codegraph 服务，不声称调用图全量证明。建议 graph delta：Start 官方型号规范化来源、新手动套餐 Key access，以及 Verifier 不属于低成本辅助调用的例外。不增加跨层运行时依赖；真实手机与线上端点按上述限制交付。
