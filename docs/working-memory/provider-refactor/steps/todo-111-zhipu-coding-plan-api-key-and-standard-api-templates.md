# Todo 111：智谱四类 API 模板与 Coding Plan 手动 Key 请求安全校验

> 2026-09-14 命名更新：上排两个模板的中英文名称统一为 `BigModel Coding Plan`、`Z.AI Coding Plan`，去掉末尾 `API`；下排 `BigModel API`、`Z.AI API` 不变。本条取代下文历史命名。名称仍由 Built-in 的 `templateNameMap` 统一提供，生产配置修改后生成测试配置，不增加前端特判。不修改模板 ID、Access、URL、模型能力或已有 Personal Provider 名称，不做数据迁移。

> 状态：四模板、新 Access、双端点请求安全校验和浏览器验证完成。2026-09-10。实施/测试证据、逐条边界复审及真实环境限制见 [本批交付复审](./provider-todos-105-113-delivery-review.md)。
>
> 2026-09-11 Goal 更新：Todo120 已完成32组成对与共享底层测试（合计147项），两家官方地址两种Access均实际完成请求安全校验、HTTP200并正常返回文本。下方“Z.ai新增普通Key路径未实测”由本次证据替代；Air/手机/SSH独立安装包未验收的限制仍有效，详见Todo120末节（Todo120 文档仅官方版本保留）。

> 2026-09-11 后续裁决已实现、待完整验收：补充普通 `api-key` 精确命中两家官方 Coding Plan Anthropic URL 时的安全校验准入。此条取代下文“普通 Key 无论地址均不进入安全校验”的旧限制；不修改持久化 Access，也不新增旧实例迁移。当前边界见 [请求协议 §5.2](../design/registry/request-compatibility-and-access-protocols.md#52-官方版本请求安全校验)，已有证据见文末；用户要求的完整等价性验证与 review 由 Todo120（文档仅官方版本保留）承接，未完成前不能宣称该补充已完整验收。

## 1. 目标与已裁决范围

纠正现有 `zai-api` / `bigmodel-api` 模板名称、访问协议与实际端点不一致的问题：现有两个模板是 Coding Plan 端点，应改名为 Coding Plan API 并接入请求安全校验；另外新增两个真正的普通 API 模板，共四个手动 Key 模板。

| 模板展示名称             | 默认 API 协议             | 默认 Base URL                            | Access                           |
| ------------------------ | ------------------------- | ---------------------------------------- | -------------------------------- |
| Z.AI Coding Plan API     | `anthropic-messages`      | `https://api.z.ai/api/anthropic`         | 新增 `zhipu-coding-plan-api-key` |
| BigModel Coding Plan API | `anthropic-messages`      | `https://open.bigmodel.cn/api/anthropic` | 新增 `zhipu-coding-plan-api-key` |
| Z.AI API                 | `openai-chat-completions` | `https://api.z.ai/api/paas/v4`           | 原有 `api-key`                   |
| BigModel API             | `openai-chat-completions` | `https://open.bigmodel.cn/api/paas/v4`   | 原有 `api-key`                   |

- Coding Plan 也有 Chat Completions 端点，路径是 `/api/coding/paas/v4`，不能与普通 `/api/paas/v4` 混用。四模板默认值按上表，不借本次扩大成全部协议模板组合。
- 账号授权连接的个人／团队 Provider 仍独立存在，不计入这四个手动 Key 模板。
- 手动套餐 Key 的使用不依赖 ZCode OAuth 登录；个人／团队 Key 共用此 Access，不为团队 Key 强制要求组织、项目或当前账号事实。
- 支持持 Key 接入不代表官方允许任意分发 Key；不把用户关于分发的业务描述写成已核实的官方授权结论。

## 2. 请求安全校验链路与复用边界

```text
账号个人／团队：zhipu-account
    -> 账号服务取得请求 Key --------+
                                  |
手动套餐：zhipu-coding-plan-api-key +-> 共用官方版本的请求安全校验
    -> 读取用户填写的 Key ---------+     -> 远端开关 / 缓存
                                        -> 重试 / 降级
普通 api-key
    -> 保持普通鉴权，不进入请求安全校验
```

1. 新 Access 以现有手动 Key 配置为基础，至少表达 `type`、`apiKey`，复用现有模板 Key 获取 URL 元数据。不要附加账号专属的 `current`、`entitled`、组织、项目等字段。
2. 复用官方版本现有的请求安全校验实现与 transport，不复制算法，不让新类型调用 `AccountProviderRequestAuthService` 获取 Key，也不伪装成 `zhipu-account`。
3. 安全校验准入依据显式 Access；2026-09-11 补充普通 `api-key` 对两个官方套餐完整 URL 的精确匹配。不能按整个域名、模型名、模板 ID 或 Key 格式扩大准入；普通 API 地址保持不进入校验。
4. 复用官方版本请求安全校验现有的远端开关、按 Key 隔离缓存、取消、重试和降级。新增类型不等于强制任何情况下都进入校验。
5. 开关关闭／获取失败及允许降级的校验失败仍按既有规则不经校验发送；指定校验错误刷新重试后仍失败时保留既有降级。非法凭据、缺必要请求上下文等非降级错误不应被新增类型吞掉。
6. 当前请求安全校验只访问模型端点同源的 HTTPS 地址、不跟随重定向，没有官方域名白名单；不得将“同源”误称为“仅发送给官方”。模板使用已确认的官方默认地址；若拟改变地址可编辑范围或增加白名单，应单列裁决，不顺带改掉现有策略。
7. 新类型仍沿用普通 Key 类的配置完整性、模型执行资格和个人配置保存机制，不派生账号权益、套餐额度、闲时资格或自动账号切换。
8. 连接测试与正常模型调用共用请求链，保持既有连接测试白名单 Prompt，不为手动套餐 Key 发明另一套探测消息。

## 3. 配置与消费者必须完整贯通

当前代码只认识 `api-key | zhipu-account`，新增类型不能只修改安全校验准入函数。

- Access 稀疏／完整 Schema、配置对象、Overlay、反序列化、Registry 完整类型与序列化均须支持新类型，穷尽分支不得把它落入 Account 分支。
- 设置页应复用手动 Key 的显示、初始化、脏检查、保存和获取 Key 入口。`ProviderDraftSave` 目前保存时写死 `type: api-key`，必须保留实际 Access 类型，避免编辑后失去请求安全校验。
- Adapter 配置转换必须同时保留 Key 与接入协议事实，不能只传账号 `accountAccess` 后丢掉新类型的安全校验准入信息。
- 收敛“手动 Key 类”的公共判断，不在各调用方复制不完整的二分法；账号专属消费者继续明确判断 `zhipu-account`。
- 检查本地与远程 Provider 配置交付、Worker 序列化和请求期绑定不丢类型／Key；请求安全校验在既有执行 Adapter 完成，不能在桌面、手机、SSH 各做一套。
- 模板名称、说明、可访问性文案中英文一致；无 Key／已有 Key 均显示已声明的获取入口，沿用 Todo107。

### 3.1 添加供应商：两段分组与样式（已裁决）

同一添加页面分为“智谱”和“其他”两段，不增加 Tab、抽屉、折叠或额外页面；仅整理入口布局，复用现有卡片与创建流程。

```text
添加供应商
    | 20px
智谱
    | 12px
[BigModel Coding Plan API]  [Z.AI Coding Plan API]
[BigModel API]              [Z.AI API]
    | 24px（上组卡片底部至下组标题）
其他
    | 12px
[创建自定义供应商]           [其他预设模板……]
```

- “智谱”固定为这四个手动 Key 模板，套餐一行、普通一行，BigModel 在前、Z.AI 在后；账号登录连接入口不混入。
- “其他”首项为创建自定义供应商，其他模板沿用现有顺序；每个模板只出现一次，不遗漏、不重复。
- 分组标题与卡片左边缘对齐，不缩进到卡片内部文字处。无图标、横线、数量徽标、分组底色或额外外框。
- 遵守 `DESIGN.md`，只用现有语义 token。以下字号是默认界面字号下的值，不写死像素字号，随用户界面字号设置变化。

| 元素                   | 已裁决样式                                                           |
| ---------------------- | -------------------------------------------------------------------- |
| “添加供应商”页面标题   | 保持 `text-ui-lg font-semibold text-foreground`，默认 16px           |
| “智谱／其他”分组标题   | `text-ui-base font-medium text-foreground-subtle`，默认 14px         |
| 页面标题栏至第一组标题 | 20px                                                                 |
| 分组标题至本组卡片     | 12px                                                                 |
| 卡片横纵间距           | 保持 8px                                                             |
| 上组卡片底部至下组标题 | 24px                                                                 |
| 卡片尺寸               | 保持基准高度 64px、左右内边距 16px，沿用现有圆角、Logo、颜色与交互态 |

- 桌面／宽 Web 两列，手机窄屏单列；分组顺序、字号层级和间距不变。长名称允许两行，不依赖 Tooltip 或截断隐藏 Coding Plan API 等区别；字号放大导致两行仍不足时允许卡片撑高，不能因固定高度裁切。
- 中英文同步，分组标题对应 `智谱 / Zhipu`、`其他 / Other`；两种主题共用语义色，不写死灰色。保留键盘可达性和既有焦点样式。

## 4. 模型能力分层

### 4.1 视觉：模型本体与端点增强分开

- 普通 API 的 `GLM-5.3` 为纯文本输入，不因 Coding Plan 提供视觉工具而在通用模型规则中开启图片／视频。
- `GLM-5.3-Flash` 是原生多模态，官方声明支持图片、视频、文件；不能和 GLM-5.3 一起关闭视觉。具体文件／PDF 编码仍需按当前 Adapter 支持核对，不能把“File”泛称当作所有文件格式已接通。
- 当前模型规则已有 GLM-5.3 图片／视频关闭、Flash 单独开启；套餐站点规则另行开启输入能力。保留这类分层，逐项核对最终解析结果，不因为增加模板误扩散站点能力。
- Coding Plan 视觉工具与模型原生视觉不是同一个事实；只有目标端点确实接受该输入的增强才放在站点规则，独立客户端 MCP 的存在不能直接证明模型端点接受图片。
- 沿用已裁决的一个 URL 一条站点规则、主流配置／官方优先，以及 Personal 最终覆盖。相关 MCS 与 Start／闲时修正由 Todo106 承接，不复制另一套规则。

### 4.2 普通 API 搜索：服务有能力，但当前 Adapter 尚未接通

官方文档既有独立 Web Search API，也有 Chat Completions 的 `tools: [{ type: "web_search", ... }]` 对话内搜索。不能概括成“只有 Coding Plan 有搜索”。

当前 `toAiSdkProviderNativeTool()` 只支持 Anthropic 原生 WebSearch 编码；Chat Completions 会报不支持编码。仅设置 `supportsNativeWebSearch: true` 不是有效接入。

- 最终裁决：普通 BigModel／Z.ai API 暂不开启内置 WebSearch，本轮不做搜索 Adapter 适配，不再列作待裁决或本轮必须补齐的功能。
- 两家的 Chat Completions 搜索是 `tools[].web_search` 厂商扩展，不是 OpenAI Chat Completions 的顶层 `web_search_options`；也不能与 OpenAI Responses 的同名工具混为一谈。以后若接入，须单独核对请求和结果格式。
- 新普通 API 模板的最终配置不得虚假声明已支持内置搜索；不因此关闭已有 Coding Plan 搜索，也不改变其他搜索工具。旧型号的官方示例不算 GLM-5.3 搜索组合已验证。

### 4.3 其他相关配置

- 普通 API 与 Coding Plan 的模型名单分别核对，不能把现有宽泛名单直接复制成套餐支持名单。
- 推理档位／Mapping、输出上限、结构化输出、MCS 与媒体输入需核对模型＋协议＋端点的最终结果，不把 Anthropic 配置整体复制给 Chat Completions。
- 不因接口拆分把模型静态能力、Access 鉴权、账号权益混成一个判断；能力继续由统一配置声明。

## 5. 获取 Key 的 URL 与已裁决展示

2026-09-11 纠正：个人／团队双入口不符合用户预期，由 [Todo116](./todo-116-single-api-key-management-url.md) 全面撤销。只保留 `apiKeyManagementUrl` 和一个“获取 API Key”按钮，沿用原有主链接。

| 产品／身份           | 官方文档指向的链接                                  |
| -------------------- | --------------------------------------------------- |
| BigModel 普通 API    | `https://bigmodel.cn/usercenter/proj-mgmt/apikeys`  |
| BigModel Coding Plan | `https://bigmodel.cn/coding-plan/personal/overview` |
| Z.ai 普通 API        | `https://z.ai/manage-apikey/apikey-list`            |
| Z.ai Coding Plan     | `https://z.ai/manage-apikey/apikey-list`            |

- Z.ai 普通与套餐模板使用相同主链接，不为了凑四个不同链接自行编造 URL。
- 一个套餐模板可接受个人／团队 Key，但获取入口不按身份拆分；控制台内的个人／团队导航交给用户，不根据 ZCode 当前账号猜测。
- 获取 Key 直接跳转上表控制台，不采用说明页替代。仅使用 `apiKeyManagementUrl`，不保留团队专用字段或双入口 UI，复用同一平台打开机制，不在组件硬编码地址。
- 普通 API 使用已确认的直接 Key 管理页；沿用 Todo107 的模板元数据唯一来源和平台打开机制，不在组件维护第二份地址表。

## 6. 模板整理，不做旧数据迁移

实施命名：保留 `zai-api` / `bigmodel-api` 作为现有套餐模板的内部身份，展示名称明确加 Coding Plan；
新增普通模板为 `zai-standard-api` / `bigmodel-standard-api`。这样不必改既有登录入口的模板引用，
也不把模板整理误扩成历史 Provider ID 改写。套餐预设收敛为当前 GLM-5.3 / GLM-5.3-Flash；
普通模板保留原普通模型目录并按 Todo112 规范化 ID，不将旧宽泛目录作为套餐权益声明。

- 用户最终裁决：这两个模板尚无人使用，本轮不为它们设计旧数据迁移或兼容处理。此前“Provider ID 也改”的表述已澄清为“不需要数据迁移”，不是要求重写个人 Provider 身份。
- `templateId` 是预设模板的标识；`providerId` 是创建后 Personal 配置中的具体 Provider 身份，两者不同。模板名称／标识按四类入口整理，具体实例仍复用现有创建和身份机制，不随模板改名重建 Provider ID。
- 不实现旧模板别名、旧 Access／Personal Overlay 自动转换、旧端点识别或历史 Selection 改写；不为未上线配置的中间态增加兼容分支和迁移测试。已有显式 Overlay 不会因为改模板自动获得新 Access，不把这项不在范围内的迁移宣称为已完成。
- 不涉及 Session 数据库迁移，不批量修改或清理用户 Key、模型配置和其他个人数据；取消迁移要求不等于授权删除这些数据。

## 7. 核查证据与源文件

官方资料（核查日期 2026-09-10）：

- [智谱 Coding Plan 快速开始](https://docs.bigmodel.cn/cn/coding-plan/quick-start)、[普通 API 快速开始](https://docs.bigmodel.cn/cn/guide/start/quick-start)、[HTTP API](https://docs.bigmodel.cn/cn/guide/develop/http/introduction)：套餐／普通端点、个人／团队 Key 获取路径。
- [Z.ai Coding Plan 快速开始](https://docs.z.ai/devpack/quick-start)、[普通 API 说明](https://docs.z.ai/api-reference/introduction)：端点、Key 入口与鉴权。
- [GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3)、[GLM-5.3-Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash)：文本与原生多模态的区别。
- [智谱搜索](https://docs.bigmodel.cn/cn/guide/tools/web-search)、[Z.ai 搜索](https://docs.z.ai/guides/tools/web-search)：独立搜索与对话内搜索的区别；不作为所有模型已实测的依据。

主要代码：`config/provider/zcode-builtin.json`；`packages/provider/src/config/provider-data-schema.ts`、`provider-config.ts`、`schema.ts` 与 `packages/provider/src/resolver.ts`；`packages/ui/src/settings/model-provider-section/ProviderDraftSave.ts`、`InlineEditableProviderCard.tsx`；`apps/zcode-cli/packages/adapters/src/model/model-execution.ts`、`tool-transform.ts`；官方版本的请求安全校验实现；`packages/services/src/model-provider/accountProviderRequestAuthService.ts`。

现有设计 `design/registry/request-compatibility-and-access-protocols.md` 明确将官方版本请求安全校验限定为账号个人／团队，本 Todo 是新增显式 Access 的后续裁决。实施前更新该 spec 及功能图，普通 `api-key` 仍不启用请求安全校验，不将新 Access 写入 Model Config。

前置只读核查中请求安全校验／开关／账号鉴权 54 项、Adapter 模型执行 33 项现有测试通过；这些不代表新类型已经实现或线上校验通过。

## 8. 测试、复审与完成标准

- [x] 实施前更新 spec；获取 Key 入口按 §5 的最新单入口裁决由 Todo116 纠正，普通 API 搜索不纳入本轮适配。
- [x] 先补 Schema / Overlay / 序列化测试：新类型合法且完整往返，账号类型不被混入，Key 缺失只影响本 Provider 完整性。
- [x] 四模板默认名称、协议、地址、Access、Key 链接与名单正确；普通／套餐、GLM-5.3／Flash 的最终能力有区分力断言。
- [x] Key 编辑保存保持新类型，不回退到 `api-key`；有 Key／无 Key 均显示声明的入口，中英文与窄屏可用。
- [x] 无 OAuth／账号连接时，手动套餐 Key 仍通过相同的请求安全校验工作；账号个人／团队保持原行为，普通 Key、Start／闲时不被误纳入校验。
- [x] 用 mock transport 与真实 Adapter 捕获最终请求，验证两家套餐端点的开关与请求安全校验，以及普通 API 请求不进入校验；覆盖按 Key 隔离、失败降级与不能降级的错误，不访问真实用户凭据。
- [x] 验证新 Access 经目标 Host／Worker 交付、配置刷新与 Model 绑定不丢失，不引入手机独立 Runtime 或另一套 SSH 安全校验链。
- [x] 从四类模板新建实例时模板引用、Access 与个人 Provider 身份正确；不引入旧模板／Overlay 迁移、别名兼容或历史 Selection 改写。
- [x] 普通 API 模板未启用内置 WebSearch，未新增搜索 Adapter；已有 Coding Plan 搜索不受影响。
- [x] 添加供应商分组成员、顺序及创建行为正确，标题字号／颜色／间距符合 §3.1；覆盖桌面两列、手机单列、中英文、深浅主题、长名称与键盘操作，既有创建反馈不回退。
- [x] 补充或更新相关设置交互 E2E，整批执行定向回归、类型检查、lint 与架构检查，按风险组织验证，不为每个小项重复全量或 Pro 验证。
- [x] 复审四模板完整性、Access／Model／Account 分层、普通计费与套餐语义、隐式消费者及旧裁决更新；提交代码和证据，不自动推送。

全部已裁决范围实现并验证后才能声明该范围完成。套餐 Key 链接展示已无待裁决项，单入口纠正的实施和验收见 Todo116；普通 API 搜索适配已明确排除本轮，不把文档落盘或旧测试通过写成整项完成。

## 9. 2026-09-11 URL 补充准入验证与复审

- 单一实现位置仍为 Adapter 的官方版本请求安全校验准入入口，使用已绑定的 Access/Base URL。匹配只影响是否进入同一请求安全校验；没有配置迁移、持久化写入、额外缓存、UI/Host 分支或模型名特判。
- 测试先红后绿：普通 Key 的官方 URL、尾斜杠及标准 URL 等价形式原先未进入校验，修复后通过；普通 API 路径、其他路径、相似／第三方域名、非默认端口、HTTP、查询串、fragment 不误入校验。开关关闭时即使命中也不进入校验，原显式套餐类型仍支持原来的自定义端点。
- Adapter 定向 2 文件 51 项、共享请求安全校验／开关 2 文件 47 项，共 98 项通过，包含既有账号 Start/Off-Peak 排除、按 Key 隔离、缓存、重试／降级与错误边界。
- 使用用户授权的 Key，在隔离内存配置中将 Access 保持为 `api-key`，实际请求 BigModel 官方套餐端点：官方版本请求安全校验流程完成，最终模型请求 HTTP 200、正常结束。Prompt 严格为 system `You are ZCode connectivity probe.` / user `hi`。Key 与校验材料不写入文档、配置或诊断输出；没有修改 Air 配置。
- 根目录 typecheck、Adapter typecheck、根目录 lint（41 个既有 warnings、0 errors）、修改文件格式检查、架构检查（baseline/new 均 0）通过。Adapter 全目录 lint 仍因未改文件的既有 max-lines 等问题失败，不借本项扩修；修改文件定向 lint 通过。
- 本次没有改交互和消息投递边界，不新增 UI E2E；两家地址均有实际 SDK + 离线 transport 断言。新增普通 Key 路径的线上实测仅 BigModel，不将其写成 Z.ai、Air 安装包、真实手机或 SSH 均已验收。
