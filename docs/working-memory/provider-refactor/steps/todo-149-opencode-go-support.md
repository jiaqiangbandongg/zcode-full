# Todo149：OpenCode Go 预设与请求配置支持

状态：代码与离线验证完成，待原生界面／线上 Go 实测（2026-09-14）；未发布或修改用户配置。

## 目标与已知问题

通过现有 Provider 配置体系支持 OpenCode Go，同时覆盖预设创建与手动填写 Go 地址的供应商。
不新增 Access 类型、配置 Schema、专用 Runtime 或数据库迁移。

2026-09-14 Air 实例：`new-provider / glm-5.3` 在连接测试中正确使用
`https://opencode.ai/zen/go/v1`、Chat Completions，但返回 HTTP 400，明确拒绝
`enable_thinking`、`reasoning`。当时缓存 revision 25 没有对应的 GLM Chat／Go 站点映射，
落到同时生成 `thinking`、`enable_thinking`、`reasoning_effort`、`reasoning` 的通用映射。
请求 ID：`2546e69c-330c-4653-9b70-c57088425cf7`。
此证据只证明两个字段被拒绝，不证明删除后其他参数、响应与工具调用必然兼容。

## 实施要求

### 1. 三个预设模板

在“添加供应商”的“其他”分组中与 Zen 相邻，复用现有 OpenCode 深浅主题图标及创建流程：

| Template ID | 名称 | API 类型 | 官方接入表中的主要系列 |
| --- | --- | --- | --- |
| `opencode-go-chat` | OpenCode Go (Chat) | `openai-chat-completions` | GLM、Kimi、DeepSeek、MiMo、LongCat、Hy |
| `opencode-go-messages` | OpenCode Go (Anthropic) | `anthropic-messages` | MiniMax、Qwen |
| `opencode-go-responses` | OpenCode Go (Responses) | `openai-responses` | GPT、Grok、Muse |

- 共同 Base URL：`https://opencode.ai/zen/go/v1`；Access 使用 `api-key`。
- 获取 API Key 仅一个入口：`https://opencode.ai/auth`。
- 保留服务端原始 Model ID，不添加 `opencode-go/` 之类的客户端命名空间前缀。
- 模型按 Go 官方协议分组，不复制 Zen 全量清单，尤其不能把 Go 的 MiniMax 放入 Chat 模板。
- 不改已有 Zen 模板、已创建供应商的 ID、Key、个人配置和历史 Selection。

### 2. 统一配置匹配，覆盖自建供应商

```text
Go 模板创建 ─────┐
                ├─> 地址 + API 类型 + Model ID 的 Built-in 规则
手动填写 Go URL ─┘                    |
                                     v
                          现有个人覆盖 / 手动模式
                                     |
                                     v
                          Registry -> Model -> 请求
```

- Go 差异放在 `providerSiteRules`，按 Go 完整 Base URL、API 类型和模型范围声明；
  沿用现有 URL 规范化，覆盖末尾斜杠，不误匹配 Zen、相似域名或其他路径。
- 相同 Provider API 与模型、无个人覆盖时，模板创建和手动创建应解析出相同的执行参数。
  Template 专属规则仅承担成员默认启停等模板事实，不把协议兼容修复藏在其中。
- 已有准确的公共模型/API 规则直接复用；Go 差异通过站点规则覆盖。
  修复必须替换错误的推理映射表达式，不能只是向原有错误映射追加字段。
- 用户个人映射和关闭智能配置后的手动模式继续遵守当前优先级；不偷偷清除旧覆盖。
  因此新配置能修复继承推荐的自建供应商，不承诺覆盖用户已经固化的错误手动配置。
- Runtime 只消费解析结果；不按 Provider 名称猜协议，不在请求失败后自动切换协议、模型或 Zen 地址。
- 不在连接测试中专门删字段，正式聊天及其他模型消费入口必须使用相同配置规则。

### 3. 模型目录及参数核对

- 优先解决已复现的 GLM-5.3，并覆盖 GLM-5.3-Flash；核实 Go 接受的准确字段后补映射。
- 按“模型系列 × API 类型”核对上下文、最大输出、输入能力、工具调用、推理档位和参数映射。
  MiniMax／Qwen 的 Messages 参数不能直接假定与 Claude 或 OpenRouter 完全一致。
- 模型成员以实施时 Go 官方端点表与目录交叉核对；公开 `/models` 只给出 ID 等基础字段，
  不能据此推导能力、账号权益或请求已成功。只出现在目录、协议/能力无法确认的型号暂缓加入。
- 初始建议默认启用已核实的主力型号；历史、实验型号默认关闭。实施时记录具体清单和依据。
  Muse Contributor 涉及训练数据与地域条款，建议先默认关闭，不作为默认推荐模型。
- 不把智谱 Coding Plan 的搜索、图片/视频桥接等站点能力移植到 Go。
- 本轮不重做全局通用推理映射，不扩大到 `none/disabled` 标准统一。

### 4. 请求头与配置交付

- 复用公共 `User-Agent: ZCode/<版本>`、版本头及原生会话头；验证实际请求，不伪装其他客户端。
  官方已说明 Go 识别 ZCode 原生会话头，`x-opencode-session` 不是本轮必需新增项。
- 普通 API Key 鉴权，不进入智谱 Sig，不增加 OAuth／套餐账号／额度查询体系。
- 只编辑生产 Built-in，通过 `pnpm provider:config:sync-test` 同步生成测试配置；
  Go URL 两个环境相同。按既有规则更新 revision，验证最终配置含模板与站点规则。
- 不自动发布远端配置或修改 Air 用户配置；实机修复和测试使用明确授权的配置与隔离场景。

## 影响面与边界

| 入口 | 共享改动 | 保持原状的状态与提交边界 |
| --- | --- | --- |
| 添加供应商、模型设置 | Template 列表、推荐模型配置 | 页面草稿经 Settings Service 保存 Personal；不物化未编辑的推荐字段 |
| 连接测试 | Registry 解析与正式 Adapter 请求参数 | 既有提示词、预算、流式完成判断；不修改会话模型选择 |
| 聊天、自动化、Subagent、Wiki 等 | Registry 候选和 Model 请求配置 | 各入口的默认、继承、校验、提交和持久化各自独立 |
| 远程工作区及手机 | 既有配置交付后的同一执行规则 | 不新增同步链路；桌面 continuous 与手机 replayable 边界不变 |

必查：Built-in、规则解析优先级、Settings 创建与连接测试、正式请求体与请求头。
回归关注：共享模型候选、辅助调用、Zen 和其他供应商不误命中、生产/测试配置一致性。
无需改变：Provider/Model Schema、持久化格式、账号身份、会话恢复、执行中 Model 冻结语义。

只读影响核对起点：`ProviderTemplatePicker`、`ProviderSettingsFacade`、`ModelConfigRules.resolve`、
`providerSettingsConnectivity`、`AiSdkModelExecution.captureModelSnapshot`、`testModelConnectivity`。
本次 codegraph 工具不可用，未执行深度 2 调用图扫描；以上为源码及当前日志证据，不等同完整测试覆盖。
图谱漂移候选：部分 Provider 启停、模板分组描述与当前代码/近期裁决不一致，不据此扩大本次任务。
建议图谱增量：在现有 Provider Templates / Registry 能力下补 Go 别名及站点配置证据，不新增状态 owner。

## 执行与验收

先更新相关配置规范及测试场景，再补测试、实现；按协议/模型系列成组验证，最后统一复审。
不因某个型号未确认阻塞其他型号，不把局部连接成功写成全部模型功能通过。

- [x] 三个模板、单一 Key 链接、图标与准确成员列表完成；记录默认启停及能力来源。
- [x] 配置测试：模板/手动创建结果一致，URL 规范化及负向匹配正确，个人覆盖/手动模式保留。
- [x] 正式 SDK 请求体断言：实际 URL/API、推理映射、输出预算、鉴权、版本/会话头正确；
      GLM 不再发送被拒绝字段。每种不同映射覆盖公开档位，不只测最低档。
- [ ] UI E2E 覆盖模板创建、填 Key、模型列表/选择及连接反馈；复用现有布局并检查主题、窄屏。
- [ ] 实机复测 Air GLM-5.3 自建供应商问题，再按三种协议与不同推理映射选代表模型验证
      连接、聊天和工具调用；记录版本、Builtin revision、结果与 request ID，不记录 Key。
- [ ] 定向覆盖辅助模型调用，不改系统提示词；若服务端限制或权限不足，明确标记未测/阻塞。
- [x] 集中执行相关单测、typecheck、lint、配置同步检查及配置产物构建；复审跨端/远程配置消费边界。
- [x] 代码双向复审：Go 规则已接入；Zen、其他域名、用户覆盖与现有 Provider 架构未回退。线上行为仍需上述实测。

## 待核实项与停止边界

技术待核实：各系列 Go 原生映射、能力值、输出预算限制，以及初始默认启用的具体清单。
这不阻塞先补 GLM 已知问题与模板基础；未知型号不猜配置。
若必须新增 SDK 适配、扩大通用映射变更或改变用户覆盖语义，先说明具体证据与新增范围，另行裁决。
### 本次实现裁决

- 按 Go 官方端点表与 models.dev 的 `opencode-go` 元数据交叉确认 25 个型号；LongCat-2.0 的请求开关尚未确认，Muse Contributor 两款涉及额外数据条款，本次不预置。目录中未列明协议的旧别名也不加入。
- Chat：GLM-5.3/Flash/5.2、DeepSeek V4 系列、Kimi K3、Hy 使用 Go 声明的 effort 值域与单独 `reasoning_effort`；不发送通用四组混合参数。GLM-5.1、Kimi K2.6/K2.7 Code、MiMo 使用服务端固有思考模式（单个 enabled、空参数映射），不假装提供未确认的关闭选项。
- Messages：MiniMax M3 使用 adaptive/disabled；M2.7/M2.5 固有思考模式、不注入 Claude effort。Qwen 复用已有模型/API 映射（enabled/disabled，3.8 同时携带 output_config.effort），不增加 Claude 必需但 Qwen 可选的固定 thinking budget。
- Responses：GPT 5.6 Luna、Grok 4.6 使用 reasoning.effort。容量/模态/档位的 Go 差异全部放站点规则；未声明的 Schema 输出不由模型名推断开启。
- 默认启用当前主力：GLM-5.3/Flash、Kimi K3/K2.7 Code、DeepSeek V4.1 Flash/V4 Pro、MiMo V2.5/Pro、MiniMax M3、Qwen3.8 Max/Flash、GPT 5.6 Luna、Grok4.6。其余旧型号与实验/preview 默认关闭，可手动开启。
- UI E2E 接受场景 G149-01：真实添加菜单显示三个 Go 模板；逐个创建后验证协议、地址、模型成员与唯一 Key 入口，隔离假 Key 保存后回读。网络协议及响应由 SDK 离线测试覆盖，不在 E2E 用假 Key 访问 Go。既有连接按钮交互继续由 C91-04 覆盖，不重复改其未提交测试。
- 依据：[models.dev 模型元数据](https://models.dev/api.json)、[原厂兼容 Messages 参数](https://www.alibabacloud.com/help/en/model-studio/anthropic-api-messages)。公开配置不等于线上全型号实测，分别记录。

## 实施证据与复审（2026-09-14）

- Built-in revision 27：Chat 15、Messages 8、Responses 2，共 25 个型号；13 个默认开启，12 个旧型号／实验型号默认关闭。启用成员排在停用成员前，生产／测试由现有生成脚本保持同步。
- 产品修改只有 Built-in 配置。Go 兼容性由 URL + API + model 的现有 Resolver 解析，个人覆盖仍最后生效；没有新增 Runtime、Schema、账号逻辑、自动重试或协议切换。
- Header 复审发现当前基线已通过 `3b67992023` 提供 Go 的 `x-opencode-session`；本次保留并实测该字段与原生 `x-session-id` 一致，不删除既有能力，不重复新增 Header 路径。版本头、UA、API Key 和无 Sig 断言通过。
- 先红后绿：配置用例初始 13 项失败，正式 SDK 用例初始 8 项失败；分别抓到缺少模板、错误四组参数、错误公开值域、Go 容量差异与 MiniMax 混入 Claude effort。
- 配置相关 5 个文件 **56/56** 通过；Adapter Go／新模型／公共 Header 3 个文件 **81/81** 通过；配置构建与同步脚本 **20/20** 通过。合计 157 项（不重复累计后续重跑）。Go 新增 30 项，SDK 参数按公开档位与 1/4096 Token 预算枚举，并覆盖三协议正文／工具意图／用量解码。响应是离线合成数据，不是 Go 线上成功证明。
- `pnpm typecheck`、Adapter `tsc --noEmit`、`pnpm --filter @zcode/desktop typecheck:e2e` 通过；根 `pnpm lint` 0 error／42 个既有 warning；新增文件格式检查通过。架构门禁 0 baseline／0 new violation。
- 生产／测试配置实际经 `stageBuiltinProviderConfig` 分别输出，均为 revision 27／3 模板／25 型号，产物 `/tmp/opencode-go-build-kYChiD/zcode-builtin.json`（后一次为 test）。环境选择与实际 tsup 嵌入由上述 20 项构建测试覆盖；没有重打整个桌面安装包。
- 语义差分复审：移除本次 Go 三个模板、25 条站点规则和25条模板成员默认规则、还原 revision 后，整份配置与 HEAD 深度相等。没有修改 Zen、普通 API 或全局混合兜底。
- G149-01 已写入 `packages/desktop/test/e2e/settings/manual-review/pending/provider-opencode-go.test.ts`，通过 E2E 类型检查。当前 Linux 无 DISPLAY、Xvfb 或 Docker，未运行原生 Electron 用例；深浅主题／窄屏、Air 真机连接／聊天／工具调用及辅助调用均保留未测，未远程部署或覆盖 Air 配置。
- 本次不包含工作区既有 Todo144 未提交改动，不推送、不发布在线 Built-in；Air 不会因本地提交自动获得新规则。

## 资料（2026-09-14 调研，实施时复核）

2026-09-15 推送门禁补充：历史 Todo95 Map 等价测试只校验原基线，不把 Go 新站点 Map
当成原基线新增项。仅对 Go 精确站点匹配规则分离范围；其完整模型成员、公开档位和请求参数
继续由 `opencode-go.test.ts` 与 `opencode-go-wire.test.ts` 验证，不更新历史基线快照或改产品配置。

- [Go 接入、协议、客户端兼容与隐私](https://opencode.ai/docs/go/)
- [Go 公开模型目录](https://opencode.ai/zen/go/v1/models)
- 当前规范：`docs/working-memory/provider-refactor/design/registry/settings.md`、
  `docs/working-memory/provider-refactor/design/registry/request-compatibility-and-access-protocols.md`。
