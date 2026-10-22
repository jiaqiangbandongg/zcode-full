# 资料跟踪与研究记录

本页保留首次调研与持续跟踪方法。后续的[2026-10-14 全面扩展计划](./expansion-plan.md)已补充公开 Models API 对账、实际规则解析、新供应商和套餐候选、MiniMax 迁移期限及分批实施建议；其中明确标注哪些结论取代首次调查的未核实项。

新增授权、既有变更讨论和协议暂缓以[当前范围原则](./scope.md#新增与既有变更的授权边界)为准；首次调查中的待确认描述不覆盖后续已确认原则。

## 持续跟踪方法

维护者同时跟踪新发布、接口变更、别名重定向、套餐目录、退役公告和费用/限额变化。新闻、官方社交账号、社区反馈用于发现线索；最终配置依据官方 API 文档、具体产品目录、Models API 与实际请求。宣传名称不能直接转换成模型 ID。

建议工作节奏：每周浏览已维护供应商的官方变更与退役页，每月复核范围和待验证项；重大新型号、参数不兼容或退役通知触发即时调查。每次都记录检查日期、资料自己的发布日期及生效日期；无法找到发布日期就写“未标注”，不能拿抓取日期代替。这里只定义人工维护节奏，未安装定时任务或新闻自动接入。

资料比较以“入口 × 模型 ID × 协议”为单位。Models API 可能受账号、地区和套餐过滤；出现不代表所有能力可用，缺失也不能单独证明全球退役。遇到冲突先保留原始链接、时间和最小脱敏响应，标明待确认，不凭搜索摘要改配置。

## 官方资料入口

以下是 2026-10-14 的检索入口；“可读”只代表取得正文，不代表真实调用通过。继续维护时从这些页进入最新发布、退役、协议和 Key 页面，复核重定向。

| 供应商/入口           | 官方来源                                                                                                                                                                                                                   | 本轮阅读状态与用途                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Z.AI                  | [模型目录](https://docs.z.ai/guides/overview/overview)                                                                                                                                                                     | 可读；型号与能力入口，普通 API 与套餐另核对                           |
| BigModel              | [官方文档](https://docs.bigmodel.cn/)                                                                                                                                                                                      | 本轮抓取超时；需人工浏览或重试，不能直接套用 Z.AI 结论                |
| Kimi                  | [开放平台文档](https://platform.kimi.com/docs/get-api-key)                                                                                                                                                                 | 旧 Moonshot 文档重定向到此；核对 Key 与产品入口                       |
| MiniMax               | [模型发布记录](https://platform.minimax.cn/docs/release-notes/models)                                                                                                                                                      | 可读；原 minimaxi 文档重定向，区分语言与音视频生成模型                |
| DeepSeek              | [变更记录](https://api-docs.deepseek.com/updates/?release=deepseek-coder)                                                                                                                                                  | 无 query 的目录抓取超时；该官方页可读，包含别名路由变更               |
| Qwen / 百炼           | [模型目录](https://help.aliyun.com/zh/model-studio/models)                                                                                                                                                                 | 可读；国内/国际的产品和协议仍需分别确认                               |
| MiMo                  | [Token Plan 指南](https://mimo.mi.com/docs/tokenplan/subscription)、[接入指南](https://mimo.mi.com/docs/zh-CN/tokenplan/Token%20Plan/quick-access)、[Anthropic API](https://mimo.mi.com/docs/en-US/api/chat/anthropic-api) | 主站为动态页面，搜索可取得官方指南正文；精确套餐型号继续人工/Key 验证 |
| OpenAI                | [模型目录](https://developers.openai.com/api/docs/models)、[Changelog](https://developers.openai.com/api/docs/changelog)                                                                                                   | 可读；关注具体 API ID、协议、思考参数及退役页                         |
| Anthropic             | [模型目录](https://platform.claude.com/docs/en/models/overview)                                                                                                                                                            | 可读；提供模型 ID、能力、Models API 和退役入口                        |
| xAI                   | [模型目录](https://docs.x.ai/developers/models)                                                                                                                                                                            | 可读；核对 Responses 和流式协议差异                                   |
| OpenRouter            | [模型说明](https://openrouter.ai/docs/guides/overview/models)                                                                                                                                                              | 可读；下一步按实际目录交集及路由分别验证                              |
| OpenCode              | [模型/原 Zen 文档](https://opencode.ai/v2/docs/console/models/)、[Go](https://opencode.ai/v2/docs/console/go/)                                                                                                             | 旧文档重定向到新版，端点与产品目录需要重新核验                        |
| Google Gemini（观察） | [模型目录](https://ai.google.dev/gemini-api/docs/models)                                                                                                                                                                   | 可读；原生协议、兼容入口及当前 Adapter 能力分别调查                   |
| Mistral（观察）       | [模型目录](https://docs.mistral.ai/models)                                                                                                                                                                                 | 可读；包含通用/代码模型、生命周期和退役表                             |

## 2026-10-14 对照结果

首次调查基线为 staging `5e74234f498c` / revision 32。下表保留当时的外部证据，仓库跟进状态在有明确变化时补充；当前库存基线已更新为 `68fac8de4fcc` / revision 33。观察不是自动接入授权；本轮未取得供应商 Key、未调用计费模型 API、未读取登录后的私人目录。没有把“文档可读”升级为“端点已验收”。

| 观察项              | 官方证据与事件时间                                                                                                     | 与仓库差异 / 下一步                                                                                                                                                                                                   | 状态                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| OpenAI 新型号       | 目录列 `gpt-6.1-sol`、`gpt-6-luna`；Changelog 明确 2026-09-29 发布前者                                                 | `openai` 模板未列这两个 ID。核对 Responses 工具循环、档位和聚合入口是否同步提供；不顺带启用其他新功能                                                                                                                 | 资料确认，待验证                          |
| Anthropic 当前系列  | 目录列 `claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5`；目录未标统一发布日期                                | 当前模板仍为 Opus/Sonnet 5 与 Haiku 4.5 等。逐型号核对思考能否关闭、effort、输出和历史回放；不能只继承品牌规则                                                                                                        | 资料确认，待验证                          |
| Z.AI FlashX         | 目录列 GLM-5.3-FlashX；发布日期未标注                                                                                  | 当前普通模板未列该 ID。核对真实 API ID、普通/套餐可用性及相对 Flash 的差异，BigModel 单独取证                                                                                                                         | 资料确认，待验证                          |
| xAI Grok 4.7        | 官方模型页明确 `grok-4.7`，并描述 Responses 的加密推理内容行为；发布日期未标注                                         | 当前模板为 4.6 等。需要请求/响应证据，不能仅追加型号与容量                                                                                                                                                            | 资料确认，待验证                          |
| DeepSeek 别名       | 官方变更页说明 `deepseek-flash` 指向 V4.1 Flash，旧 V4 Flash ID 暂时转发；V4 Pro 在 2026-09-14 后继续服务              | 当前官方模板已用 `deepseek-flash`；核对视觉能力与聚合入口旧 ID，不把旧 ID 转发当永久承诺，不机械删除 V4 Pro                                                                                                           | 别名/退役复核                             |
| MiMo 产品和型号     | 官方指南区分普通 API Key 与 Token Plan 专用 Key/端点；新接入示例出现 `mimo-v2.6-pro`，查询资料的事件日期未统一标注     | 调查时只有 V2.5 普通模板；2026-10-14 staging 合入双模板与 V2.6 Pro/Flash（revision 33）。Token Plan 使用 `https://token-plan-cn.xiaomimimo.com/anthropic`，成员及默认启停见[当前状态](./current-state.md#xiaomi-mimo) | 配置已实施；本轮真实 Key 与线上采用未验证 |
| OpenCode 端点与目录 | 新版 Models/Go 页面分别列 `/inference/v1/models`、`/inference/go/v1/models`，Go 清单增加多个新系列；迁移生效日期未标注 | 当前模板仍为 `/zen/v1`、`/zen/go/v1`。先确认旧端点是否继续兼容、真实 ID 和各协议路径；重定向不等于旧 API 已停止                                                                                                       | 优先核验，不能直接替换 URL                |
| Gemini              | 官方目录包含 3.8 Flash、3.5 Flash-Lite 等；不将音频/图像生成目录混入普通 Agent 模板                                    | 没有内置原生模板。先确定原生或兼容入口方案及认证/工具支持，再提出接入设计                                                                                                                                             | 范围观察/待设计                           |
| Mistral             | 官方目录列 Large 4、Small 4 等，并列出独立代码与退役目录；Large 4 标记 v26.10                                          | 没有内置模板。评估适合 Agent 的具体型号、协议和 Key；不能把补全/Embedding 型号当对话模型                                                                                                                              | 范围观察/待设计                           |

首次调查未完成各入口 Models API 对账，也未重新调查云入口协议。后续[扩展计划](./expansion-plan.md)已完成 OpenRouter / OpenCode 公开目录对照，并核对 Azure v1、Bedrock Responses、方舟套餐及 TokenHub 的官方资料；其他登录后目录和计费调用仍未验证。不能据此写“全部供应商已跟上最新型号”。

## 资料归档与下一次检查

本目录已纳入主流范围、官方优先、产品入口拆分、规则分层及容量基线的理由，分别见[范围原则](./scope.md)和[配置规范](./configuration.md)。revision 32 的匹配与容量简化、revision 33 的 MiMo 双产品入口均已落地；实现、真实 API 验证和线上采用仍分别记录。库存和实现以代码核验，历史记录不作为客户端目录源，也不作为阅读本目录的前置条件。

每项进入实施的观察按本目录[维护工作流](./workflow.md)补充 spec、状态和验收；Issue 不另发到远端。记录产品 owner、维护者、验证协作者、检查日期、下一步和阻塞。完成后将结果更新到当前状态，保留这份带日期的研究证据，不把历史原文改成今天已验证。

新增供应商按范围原则补充官方来源，定期检查失效链接、跨站重定向和资料权限。搜索结果中的社区观点、排行榜与第三方目录不能成为运行时配置源，也不能自动提升默认启用状态。
