# Todo 113：近期新模型目录与智能配置更新

> 状态：**第二轮实现、局部及整批代码 review、本地测试完成；真实多端验收限制保留**。2026-09-11 用户已授权本轮 Goal 执行。逐型号官方事实、聚合差异、未确认供给见 [第二轮研究与裁决](./todo-113-round2-research.md)，最终证据见 [整批复审](./provider-stabilization-20260911-final-review.md)。未确认的 Omni 北京 Messages、百炼 Kimi 高速版附件/协议、MiMo UltraSpeed 商业开放不猜测接入。
>
> 第一轮（2026-09-10）已完成三款官方新模型及已核实聚合成员、真实 SDK 请求验证；历史结果见 [本批交付复审](./provider-todos-105-113-delivery-review.md)。下方第 1–4 节保留第一轮记录，不代表本轮已完成；第二轮执行以第 0 节为准。

## 0. 第二轮：完整目录补漏、配置深查与下线清理（2026-09-11）

### 0.1 已确认原则

- **已经下线的型号可直接从相应服务商的内置模型列表移除，不再仅保留为默认关闭。** 清理与被移除成员配套的模板精确规则；不因原厂下线就认定第三方也已下线，按各接入方事实分别处理。
- 本轮不仅补模型名称，也必须补齐或纠正其智能配置。模板名单、模板精确默认规则、通用模型匹配、API／站点映射需一起核对，不能出现“列表中有，但手动添加或解析后落到未知模型默认配置”。
- **所有新增型号都必须检查现有聚合服务商是否已支持**，包括第一轮已新增型号的复核；不能只更新原厂后宣布完成。官方确认具体 ID、协议和服务状态后才加入相应聚合模板。
- 已确定的型号与结论也要在执行时深度研究：本轮调查只确定缺口和方向，不代替最终参数、协议、请求与回归验收。
- 不确定的细节执行时继续核实，不为了现在填满表格猜结论；普通事实核实自行完成。需改变产品语义、默认选择或扩大适配架构时，再带具体问题讨论，不将未确认事项默认为通过。
- 本次只落盘并改为待执行，不更新 JSON、代码或线上配置。

### 0.2 当前基线与具体缺口

调查对象为 builtin revision 19；本地与当时最新 `origin/staging` 的 Provider 配置及实现无差异。执行时必须重新检查最新基线，避免覆盖同期目录更新。

| 对象                                                     | 本轮确认的现状                                                                                                                          | 待执行改动                                                                                                                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 原厂 `deepseek-flash`                                    | 第一轮已接入，官方 ID 对应 V4.1 Flash                                                                                                   | 复核原厂容量、视觉及三协议映射，不重复新增                                                                                                                   |
| `gpt-5.4`、`gpt-5.4-pro`、`gpt-5.4-mini`、`gpt-5.4-nano` | 四款已在 OpenCode Responses 内置列表，对应模板精确规则仅声明 `enabled: false`；通用模型规则缺失，原厂及带前缀的聚合接入均未得到专用配置 | 四款分别深查官方规格，补上下文、最大输出、输入能力、工具／结构化输出、合法推理档位及各接入参数映射；不得整族套用 GPT-5.6，也不能以补配置为由直接打开默认启用 |
| OpenRouter `deepseek/deepseek-v4.1-flash`                | 官方已上架；当前模板缺成员，且该 ID 不匹配原厂 `deepseek-flash` 或旧 V4 Flash 规则                                                      | 新增 OpenRouter 成员及相应精确默认规则，补 V4.1 Flash 命名匹配及 OpenRouter 实际协议映射；不把 V4 Pro／旧第三方 V4 Flash 改成 V4.1                           |
| `qwen3.8-omni-flash`                                     | 百炼有正式型号；两个百炼模板和专用配置均未覆盖                                                                                          | 按地域供给补百炼模板；独立核对容量、文本／图片／音频／视频输入、文本输出、工具及结构化输出、推理档位与映射，不复制普通 3.8 Flash                             |
| `qwen3.7-max`、`qwen3.7-plus`、`qwen3.7-flash`           | 部分 OpenRouter／OpenCode 模板已有成员，但通用智能配置遗漏；原厂两个百炼模板也未列出                                                    | 核对北京／国际可用性后补原厂目录，补专用模型及协议规则；保留并修正聚合模板现有成员，按聚合供给补漏                                                           |
| `qwen3.6-plus`、`qwen3.6-flash`                          | 同样存在聚合模板已有而专用配置缺失的问题                                                                                                | 按地域供给补原厂目录及智能配置，并核对聚合成员；与 3.7 各型号分别研究，不能整批套同一组容量／档位                                                            |
| `kimi-k2.7-code-highspeed`                               | Kimi 官方已提供；原厂模板缺成员，当前后缀匹配可继承 K2.7 Code 配置                                                                      | 补原厂成员及默认规则；深入比较高速版与基础版参数、能力、协议，确认可复用后保持共用规则；逐一核对聚合支持                                                     |
| `qwen3.8-max-0902`、`qwen3.8-max-2026-09-02`             | 官方快照及别名已存在；当前手动添加能命中 3.8 Max 规则                                                                                   | 复核快照差异与别名语义；目录是否单列在执行时依据现行策略确定，不把“未单列快照”当成缺少智能配置                                                               |
| `mimo-v2.5-pro-ultraspeed`                               | 官方公告同时保留旧试用内容，顶部声明内测已结束、商业版待发布；现有后缀匹配可得到 Pro 配置                                               | 执行时确认商业版是否已正式开放、真实 ID 与独立参数；未确认前不加入正式预设，不把匹配成功当作可用证明                                                         |

实际解析证据：OpenRouter V4.1 Flash、Qwen3.8 Omni Flash，以及上列五个 Qwen3.7／3.6 型号目前都落到 `200000` 上下文、`32000` 最大输出、视觉关闭、仅 `disabled` 档位。Kimi 高速版和 MiMo UltraSpeed 能命中各自基础版规则，但尚未证明其配置完全相同。

2026-09-11 补查 GPT-5.4：实际运行 Resolver，原厂 `gpt-5.4`、OpenCode `gpt-5.4`、OpenRouter `openai/gpt-5.4`，以及原厂 Pro／Mini／Nano 均得到 `200000` 上下文、`32000` 最大输出、图片关闭、推理档位仅 `disabled`。当前仍能继承通用 API 参数映射，但缺少该型号专用能力和值域；这是配置缺漏，不是页面未显示。聚合平台真实支持哪些变体仍需逐个核实，解析带前缀 ID 不代表平台已上架。

### 0.3 内置模型列表逐模板计划

修改源为 `config/provider/zcode-builtin.json` 的 `providerConfigRules.templateRules[].config.builtinModelIds`，配套检查 `modelConfigRules.templateModelRules`。新增成员的排序与默认启停需要在最终研究结果中明确，按现行模板策略处理；不能将“官方已提供”直接等同于“应默认全部启用”。无法从现行策略确定时执行阶段讨论。

| 模板 ID                                                                | 内置列表变动与保留边界                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deepseek`                                                             | 保留 `deepseek-flash`、`deepseek-v4-pro`；移除已退役原厂旧成员 `deepseek-v4-flash` 及其模板精确规则。`deepseek-v4-flash-vision-exp` 若执行基线仍未列出，不新增；如已列出则依据官方退役公告移除                                                                                                                                    |
| `moonshot-kimi`                                                        | 新增 `kimi-k2.7-code-highspeed`；移除 `kimi-k2.5`、`moonshot-v1-8k`、`moonshot-v1-32k`、`moonshot-v1-128k`、`moonshot-v1-8k-vision-preview`、`moonshot-v1-32k-vision-preview`、`moonshot-v1-128k-vision-preview`。保留主力 K3／K2.7 Code／K2.6；现有 `k3`、`k3-256k` 别名核实服务与语义后处理，不能仅因未出现在某一页就断定已下线 |
| `xiaomi-mimo`                                                          | 保留 V2.5 Pro／V2.5；已确认退役的 `mimo-v2-pro`、`mimo-v2-omni` 从原厂预设移除。`mimo-v2-flash` 结合官方“V2 系列下线”通知核实具体接口去向，确认后移除。UltraSpeed 仅在商业开放和参数完成核实后加入                                                                                                                                |
| `qwen-alibaba-model-studio-cn`、`qwen-alibaba-model-studio-intl`       | 分地域核实并补 `qwen3.8-omni-flash`、`qwen3.7-max`、`qwen3.7-plus`、`qwen3.7-flash`、`qwen3.6-plus`、`qwen3.6-flash`。保留现有仍在服务的型号；3.8 Max 快照是否单列待执行研究。不将北京目录无条件复制到国际目录                                                                                                                    |
| `openrouter`                                                           | 明确补 `deepseek/deepseek-v4.1-flash`；现有五个 Qwen3.7／3.6 前缀 ID 继续保留并补齐配置。核查新增 Omni、高速版及其他本轮新增型号的准确前缀 ID、供应状态和协议，确认后补成员与精确规则；原厂下线不直接删除聚合成员                                                                                                                 |
| `opencode-zen-responses`、`opencode-zen-messages`、`opencode-zen-chat` | 对全部新增型号逐个查 Zen 官方目录或模型接口，按实际 Endpoint 归入对应模板；核对现有 Qwen3.7 Max／Plus、3.6 Plus 配置并检查缺失型号是否上架。新 DeepSeek／Omni／Kimi 高速版的 ID 不猜，不把原厂或 OpenRouter ID 套进来                                                                                                             |
| `openai`                                                               | 保留 GPT-6 Astra 及现有主力；补 GPT-5.4 四款的通用智能配置，分别核实原厂服务状态后按当前目录策略决定内置成员补录、排序与默认启停。不能因原厂模板未列出就跳过手动添加时的配置支持；不机械复制 5.6 参数                                                                                                                             |
| `anthropic`                                                            | 保留第一轮 Fable 5.1 及现有主力；深度复核准确 ID、上下文／输出、档位及请求兼容，检查官方同期稳定新型号，不因上轮测试通过而跳过                                                                                                                                                                                                    |
| `minimax`、`xai`                                                       | 当前主力 MiniMax-M3、Grok-4.6 已在目录；继续核对官方同期新型号、变体和配置变化，没有可靠新增事实则不改列表                                                                                                                                                                                                                        |
| `zai-api`、`bigmodel-api`、`zai-standard-api`、`bigmodel-standard-api` | 不重复实施 [Todo126](./todo-126-glm-flash-pdf-and-coding-plan-turbo-defaults.md) 的 Flash PDF／套餐 API Turbo 默认值；GLM-4.7 视觉按用户裁决保持。仅在发现独立的新型号或下线事实时纳入本项并说明与 Todo126 的边界                                                                                                                 |

**“直接移除”指从相应服务商内置供给目录移除，不是清除个人配置或迁移用户历史。** 不重写已保存 ModelSelection、消息、统计或正在执行的绑定模型。旧别名的模型能力规则如仍被个人配置、聚合接入或原厂兼容路由使用，保留相应匹配能力，不随着目录删除而整族删掉。已退役原厂型号与第三方仍供给的旧版本必须区别处理。

GPT-5.4 聚合补充：OpenCode Responses 已有四款成员，保留现有默认关闭，补齐解析配置与请求映射即可，不重复新增。OpenRouter 等适用聚合接入逐变体核实准确 ID、服务状态及实际 API；确认支持后补缺失成员与配套精确规则，并覆盖 `openai/gpt-5.4` 等真实前缀形式。所有变体分别验证，不将 Pro／Mini／Nano 或其他 GPT 版本误匹配为基础 5.4。

### 0.4 执行时必须完成的深度研究

每个新增或纠正型号都要形成一份简短的“官方事实 → 当前解析 → 最终改动”记录，包括来源 URL、核对日期和仍未确认项。已确定的候选也执行这一过程，不能照抄本轮搜索摘要或用基础版推断变体。

- **身份与服务状态**：准确原厂 ID、快照／别名、公开稳定或试用、国内／国际供给、退役及重定向；不混淆模型名称相近与真实同款。
- **容量与能力**：上下文与输出分别核对，明确文档的 K／M 单位及思考预算是否另计；图片／视频／音频／PDF、工具调用、JSON Schema 约束输出、MCS、原生搜索分别核实。普通 JSON 输出不等于 Schema 约束，文件上传／提取接口不等于模型原生 PDF。
- **选项与协议**：合法推理档位、是否允许关闭、排序、CEL Map 及实际请求字段；分别核对所支持的 Messages／Chat Completions／Responses，不把厂商原始字段误写成 SDK 配置字段。
- **分层**：通用模型能力归 Model；协议差异归 Model+API；端点增强及聚合转换归 Site；目录默认启停归模板精确规则；Personal 保持现有优先级。不以宽泛正则让新模型覆盖旧型号、其他变体或账号产品。
- **聚合服务商必查**：至少覆盖当前维护的 OpenRouter 和 OpenCode Zen；百炼的第三方型号目录也核对适用成员。对每个新增型号记录“已支持（准确 ID／Endpoint）／官方未列出／试用或受限／证据不足”，后两类不冒充支持。“已有基础版”不证明高速版或新版本已上架。
- **请求验证**：检查最终 Resolver 配置和真实 SDK 序列化请求；模型公开规格、网关转换与当前 Adapter 实际能力分别给证据。涉及不能靠配置表达的问题，先提出最小具体方案，不自行开展大范围 Runtime 改造。

已存在但要深入复核的具体点：OpenRouter V4.1 Flash 页面给出 `1,048,576` 上下文，原厂文档写 1M；不能未核对单位就机械合并数值。Qwen3.8 Omni 的容量与其他 3.8 型号不同，不能套 1M；各 Qwen3.7／3.6 的推理映射、快照视觉变化分别检查。Kimi 高速版继承和 MiMo UltraSpeed 后缀命中仅为当前代码事实，不是官方等价保证。

### 0.5 已更新的官方事实与证据

核对日期为 2026-09-11；执行时重新访问，资料变化或相互矛盾时明确记录。

- [DeepSeek 最新更新日志](https://api-docs.deepseek.com/updates/)和[模型规格](https://api-docs.deepseek.com/quick_start/pricing/)：V4.1 Flash 原厂 ID 为 `deepseek-flash`，旧 V4 Flash／Vision Exp 已退役但原厂旧名暂时路由到新 Flash；**V4 Pro 在 9 月 14 日之后继续提供服务，原计费不变。旧“9 月 14 日 Pro 切到 Flash”计划已被最新公告取代，不执行该切换。**
- [OpenRouter V4.1 Flash](https://openrouter.ai/deepseek/deepseek-v4.1-flash)：已提供准确聚合 ID、视觉、容量及输出说明。
- [Qwen3.8 Omni Flash](https://help.aliyun.com/zh/model-studio/qwen3-8-omni-flash)、[Qwen Omni 使用指南](https://help.aliyun.com/zh/model-studio/qwen-omni)：核实独立多模态、推理及容量限制，注意页面重定向与系列共用说明。
- [百炼文本模型目录](https://help.aliyun.com/zh/model-studio/text-generation-model)、[模型上下架](https://help.aliyun.com/zh/model-studio/newly-released-models)、[Qwen3.7 Plus](https://help.aliyun.com/zh/model-studio/qwen3-7-plus)、[Qwen3.7 Flash](https://help.aliyun.com/zh/model-studio/qwen3-7-flash)、[Qwen3.6 Plus](https://help.aliyun.com/zh/model-studio/qwen3-6-plus)、[Qwen3.6 Flash](https://help.aliyun.com/zh/model-studio/qwen3-6-flash)：目录、地域和配置缺口的依据。
- [Kimi 官方模型列表](https://platform.kimi.com/docs/models)、[K2.7 Code](https://platform.kimi.com/docs/guide/kimi-k2-7-code-quickstart)：高速版已提供，K2.5／moonshot-v1 已于 8 月 31 日下线。
- [MiMo UltraSpeed 最新公告](https://mimo.mi.com/docs/en-US/news/latest/beta-extended)、[MiMo 套餐 FAQ](https://mimo.mi.com/docs/en-US/quick-start/faq/token-plan)：UltraSpeed 商业状态与 V2 Pro／Omni 等退役；不要依赖同一公告中未清除的旧试用段落作结论。
- [OpenCode Zen](https://opencode.ai/docs/zen/)、[OpenRouter 模型目录 API](https://openrouter.ai/api/v1/models)：聚合供给需逐型号、逐 Endpoint 核实。官方目录可用不等于所有 Key／套餐必有权限。
- [OpenAI Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)、[Claude 型号列表](https://platform.claude.com/docs/en/models/overview)、[MiniMax 型号列表](https://platform.minimax.io/docs/guides/models-intro)、[xAI 型号列表](https://docs.x.ai/developers/models)：已覆盖主力也要复核，检查稳定新成员；不扩展到无关语音／图像生成产品。

### 0.6 第二轮验收与当前状态

```text
原厂事实 + 各聚合服务商实际供给
                |
       模板名单 / 模型与协议规则
                |
        个人覆盖 + 同一 Resolver
                |
     设置页 / 各选模入口 / 新 Model 请求

旧选择与历史不代写，已绑定执行不换模
```

- [x] 完成上列已知候选的深度研究，以及其他已维护厂商同期稳定型号与下线状态核查；将不确定项解决或明确留下阻塞原因。
- [x] 为每个新增型号记录 OpenRouter、OpenCode 等适用聚合接入核实结果；实际支持者同步更新内置列表，未确认者不猜 ID。
- [x] 形成逐模板最终新增／移除／保留名单及默认启停、排序；成对维护模板精确规则，移除已下线成员，保留个人与历史边界。
- [x] 先补失败测试，再改配置：目录和专用规则对应、上下文／输出／媒体／档位、别名正例与邻近型号负例、原厂与第三方差异、个人显式覆盖均验证。
- [x] GPT-5.4 基础版／Pro／Mini／Nano 各有专用配置证据和解析断言；覆盖原厂、OpenCode Responses、已核实的 OpenRouter 前缀及接入映射，验证仍保持已有默认启停和个人覆盖，不再落到未知模型默认值。相关新断言在实施前应先复现当前缺漏。
- [x] 验证实际 SDK 请求中的推理、输出参数、工具及支持的媒体编码；不以静态 JSON 正确代替请求正确。无法执行真实付费服务验证时如实说明。
- [ ] 检查桌面与手机、各选模入口共享配置结果；不改 continuous／replayable、账号状态、持久化或正在执行的模型绑定。代码与双尺寸浏览器已查，真实多端仍受最终复审记录的环境限制。
- [x] 两轮历史与本轮新结果分开记录；最终递增 latest builtin revision，执行相关测试、typecheck、lint、架构门禁，不新增 Schema 迁移。CLI 既有 lint 失败如实记录；不自动发布，分支推送按本轮 Goal 的后续明确授权执行。

第二轮实施记录：

- 从 revision 21 递增至 22，完成已核实的原厂与聚合目录、智能配置、精确默认规则和退役清理；新增均关闭，保持原启用前缀。原厂/聚合容量、Schema、档位和快照差异限定在对应层；具体名单与限制见第二轮研究。
- 先复现 15 项目录/参数缺漏，再实现；最终 22 项新增配置测试及历史目录、规则、Map 合批通过。真实 SDK 捕获测试覆盖三协议、工具、Schema、图片/音频/视频和 binding 冻结；与签名及原有 Model 测试合批 173 项通过，未请求这些无凭据的付费端点。
- 请求层发现配置允许 Schema 但 Chat SDK 默认降为 JSON object，最小修复为 binding 传入并冻结该能力，不加厂商判断或新协议。先红后绿，原有关闭能力与配置修改不影响已绑定模型均有断言。
- 整批回归发现 Todo95 测试假设所有历史来源永远支持关闭，已改为 Kimi Code 不再支持关闭时明确拒绝；不改旧改名表、已保存选择或历史。
- 局部 review：规则完整性、邻近型号不误匹配、Personal 优先、目录与精确规则配对、系统/接口字段归属均核对；桌面和手机仍共用 Registry，无新增账号/协议/数据迁移。根及 Adapter 类型检查、根 lint（0 errors / 42 warnings）、架构（0 violations）通过。最终构建/浏览器/多端限制在执行账本集中记录，不将本项局部结果替代整批验收。

## 1. 第一轮目标与调查结论（历史记录）

补齐开发期间发布的新模型，首批明确覆盖以下三款；实施时顺带核对现有维护厂商的近期官方更新，避免漏掉同一批稳定公开型号，不扩成全网模型收录工程。

| 模型                | 已核实的官方事实                                                                                                                           | 当前配置缺口                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| GPT-6 Astra         | ID 为 `gpt-6-astra`；1,050,000 上下文、128,000 最大输出；公开推理档位 low / medium / high / xhigh / max                                    | OpenAI 模板仍以 GPT-5.6 为主，无 GPT-6 专用匹配与成员                                       |
| Claude Fable 5.1    | ID 为 `claude-fable-5-1`；1M 上下文、128K 最大输出；始终启用 Adaptive thinking；官方明确存在强制工具调用及跨模型 thinking block 等兼容变化 | 模板仍为 Fable 5；5.1 会命中现有宽泛 Claude 5 规则，不能将“命中旧规则”当作正确适配          |
| DeepSeek V4.1 Flash | 9 月 10 日发布，官方正式 API ID 为 `deepseek-flash`，支持原生视觉；官方仍接受旧 Flash 名并路由到新版                                       | 目前模板和规则主要针对 `deepseek-v4-flash` / `deepseek-v4-pro`；新 ID、视觉和协议映射需补齐 |

官方证据（核对日期 2026-09-10）：

- [OpenAI GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)。不把产品简称 `gpt6` 当 API ID。
- [Claude Fable 5.1](https://platform.claude.com/docs/en/models/fable-5-1/overview)。实施时进一步核对合法 effort、MCS 与强制工具调用，不机械复制旧型号。
- [DeepSeek 官方更新日志](https://api-docs.deepseek.com/zh-cn/updates/)及[首次调用](https://api-docs.deepseek.com/)。当时记录了 9 月 14 日 12:00 北京时间后 V4 Pro 请求路由到 V4.1 Flash 的预告；**该预告已被 2026-09-11 核实的继续提供 Pro 公告取代，当前裁决见 §0.5，不能执行旧切换。**
- [DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。按协议核对映射与 reasoning 内容回传；临时测试型号不加入长期预设。

## 2. 大致改动点

实施规格（2026-09-10）：GPT-6 Astra / Fable 5.1 均为 low、medium、high、xhigh、max，
不添加关闭档；分别沿用 Responses reasoning.effort / Messages adaptive + output_config.effort。
DeepSeek Flash 为 1M / 384K，文本和图片，disabled、low、high、max；补齐三协议映射。
旧 Flash 在官方端点的别名视觉规则单独声明，不把第三方旧 V4 Flash 强行改成新模型。
正式模板新增新 ID，旧成员保留但关闭旧 Flash 的默认启用，旧选择与个人覆盖不变。
OpenCode 官方目录已列 GPT-6 / Fable5.1；OpenRouter 官方页面确认各自带供应商前缀 ID。
尚未确认聚合端的新 DeepSeek ID 不猜。
Fable5.1 的普通 auto 工具调用与 JSON schema 输出沿用既有链路；不把 forced tool choice
偷偷改成 auto。跨模型签名 thinking 已由既有通用过滤处理；本项补负例验证，不新增 beta。

- [x] **模型目录**：更新官方模板成员及对应精确规则；已维护的聚合模板仅在其官方目录确认有对应 ID 后补入，不直接套用原厂 ID。保留用户已有选择，不借上游别名变化改写历史或清理 Personal。
- [x] **智能配置**：更新上下文、输出上限、输入类型、结构化输出、合法推理档位与参数映射；能力按 Model / API / Endpoint 分层，一 URL 一规则，延续既有 Map 写作风格。不能用一个泛匹配将新型号的能力扩散到所有旧型号。
- [x] **请求兼容**：重点检查 Fable 5.1 的始终思考、工具调用及 thinking block 约束，以及 DeepSeek 新 ID 的三协议映射和原生视觉。优先配置解决；只有证明现有适配层无法表达且阻碍基本使用时才提出最小代码修复，不预先承诺一定零代码。
- [x] **完整性与回归**：先更新相关 spec 和定向测试，再实施；覆盖目录成员、精确默认启用规则、模型匹配、最终请求参数与旧型号负例。整批验证、复审，不每补一款就跑全量或 Pro。

## 3. 边界与协作

- 不自动更改用户已选模型、历史消息、使用统计、运行中执行或已绑定 Ticket，不新增数据库迁移。
- 不把这些模型加入智谱账号套餐；Account 名单必须以其实际服务目录为准。
- Todo106 负责既有 MCS 纠正，本项在其裁决上补新型号；Todo111 四类智谱模板及 Todo112 GLM 大小写仍分别负责，不重复实施。
- 不改账号同步、有效选择、默认选择和各入口保存时机；不新增厂商专用 UI。不为了接新型号强行接入全部 beta 功能。
- 当前无需用户再做产品选择。尚需核实的详细参数、聚合平台 ID、实际 Adapter 兼容性属于实施调查；若确需新增产品语义或扩大协议架构，再单列裁决。

## 4. 简版 Impact Brief

### Feature Summary

能力为模型目录及智能配置；变更层为 option-source / validation。主要种子是 `config/provider/zcode-builtin.json` 的模板、模型规则、API/站点规则和模板精确规则。范围外是选择持久化、账号架构及 UI 重设计。

### UI Surface Matrix

| 入口                              | 共享来源／校验                                  | 草稿与提交归属                                           | 多端及隔离边界                         |
| --------------------------------- | ----------------------------------------------- | -------------------------------------------------------- | -------------------------------------- |
| 添加供应商、模型设置              | Template / ProviderSettingsFacade、公共规则解析 | 模板创建 Personal；编辑仍按现有保存机制                  | 桌面与手机共享配置，不在 UI 塞默认参数 |
| 对话、自动化、Subagent、Wiki 选模 | Registry 与现有公共选择解析                     | 各自草稿、Session／任务／Markdown／Wiki 配置；不互相代写 | 仅更新候选与能力，不改发送或保存时机   |

### Shared And Divergent Behavior / State Owners And Commit Sinks

共同的是 Built-in 发布、Personal 覆盖及 Resolver；模板成员、账号实际供给与各业务持久化仍有各自归属。新默认只影响正常配置解析，不直接写会话数据库；已绑定执行不被动态换模。

### Feature Relationships / Must-Preserve Invariants

- must-inspect：模板成员与 exact rule 对齐、模型/API/站点覆盖顺序、最终请求编码；配置为事实源。
- should-inspect：模型设置和各选模入口消费新结果；不重写各入口业务。
- invariant-only：Personal 优先、旧选择保留、已绑定执行固定、桌面 continuous 与手机 replayable 隔离。
- evidence-only：`packages/provider/test/model-config-rules.test.ts`、`model-rule-collections.test.ts`、`provider-template.test.ts` 及 Adapter 测试；本轮未运行，不计作通过。

### Codegraph Evidence / Graph Drift Candidates / Graph Delta

本环境未提供 codegraph 工具，因此只读扫描配置和现有语义图，未声称完成调用图深度 2 审计。图中 ModelConfigRules / ProviderRegistry / ProviderSettingsFacade 和模板能力节点作为后续起点；直接调用方在实施前补查。本轮未确认新产品关系，不更新图；历史文档字段示例不能盖过当前 JSON 与最终 schema。

### Unresolved Questions / Planning Handoff

无阻塞用户裁决；详细能力与线路支持待实施核实。若发现强制工具调用、thinking block 等需要广泛 Runtime 改造，先记录具体缺口，不借目录更新扩大范围。完成需有配置与请求层证据，真实服务未测必须注明；当前只是 Todo，不宣称新模型已接入。
