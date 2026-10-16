# Todo157：厂商套餐入口、Go 模型补齐与手动 Key Access 收口

> 状态：待执行；新厂商为待评估候选。2026-09-16 本轮仅整理 Todo 与索引，未修改产品代码或配置。
>
> 来源：本次 Kimi API／Coding Plan、其他厂商套餐与 OpenCode Go 目录的对照讨论。用户明确取消手动特殊 Access 对自定义代理域名的安全校验放行；视觉徽标采用模板身份的方案记录在下文。

## 目标与实施顺序

1. 补齐已有厂商的 API／订阅入口及 OpenCode Go 目录，避免用户把套餐 Key 填入按量端点。
2. 移除 `zhipu-coding-plan-api-key`，手动 Key 统一为 `api-key`；取消其独立安全校验准入，并解除视觉徽标对该类型的依赖。
3. 评估第一批新厂商，再按明确的产品入口和实际协议证据逐家接入；候选不等于已验证可发布。

各切片独立验证和提交。本条承接 [Todo22 新厂商规划](./todo-22-additional-builtin-providers-and-cloud-access.md)、[Todo113 模型目录更新](./todo-113-new-model-catalog-refresh.md) 和 [Todo149 Go 支持](./todo-149-opencode-go-support.md) 的相关范围，不重复开启它们已经完成的工作。实施前将最终契约同步至 [现行设计](../design-v2/design.md) 及对应功能 spec；历史结论按 [权威顺序](../design-v2/README.md) 读取。

## 1. 已有厂商的产品入口

以下是 2026-09-16 的调查基线，端点、成员和套餐权限在实施时重新核实。

| 厂商           | 当前问题                                                                       | 目标                                                                                   |
| -------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Kimi           | `moonshot-kimi` 指向开放平台，但包含 Code 侧 `k3`／`k3-256k`，没有独立订阅入口 | 拆 Kimi API 与 Kimi Coding Plan（Kimi Code）；分别维护端点、Key 页面、模型成员和能力   |
| MiniMax        | 只有普通 MiniMax 入口                                                          | 补 Token Plan；明确订阅 Key 与按量 Key 的区别，国内／国际凭据按官方契约分别核对        |
| 阿里云百炼     | 只分中国／国际 API                                                             | 补 Coding Plan、Token Plan；个人／团队、地域与协议分别核对，不能仅凭套餐名字重复建模板 |
| Xiaomi MiMo    | 只有普通 API                                                                   | 补 Token Plan；套餐 `tp-` Key 与普通 `sk-` Key、分地域套餐端点分别匹配                 |
| Z.ai／BigModel | API 与 Coding Plan 已分模板，但手动套餐仍用特殊 Access                         | 保留四个模板身份和现行名称，套餐 Access 改为通用 `api-key`                             |

- Kimi Code 官方列出的模型 ID 为 `k3`、`k3-256k`、`kimi-for-coding`、`kimi-for-coding-highspeed`；当时 `kimi-for-coding` 对应 K2.8 Preview。不可把开放平台版本名当作 Code 的请求 ID，不能假设所有会员拥有全部模型权限。
- 新增 API Key 型套餐优先复用 `api-key`；不为每家套餐新增特殊 Access。若需要 OAuth、凭据续期或账号权益刷新，独立设计真实认证契约后再接入。
- 同一端点不代表同一计费凭证；相同 Key／端点但模型权益不同也不必机械拆模板。每个入口应有明确的密钥获取页、API 类型、Base URL 和模型范围。
- 已有实例的 Provider ID、名称、Key、个人覆盖、排序和历史 ModelSelection 不批量重建。Kimi 的既有模板保留为开放平台入口；清理默认目录前核对旧选项及用户自定义模型的恢复边界。

依据：[Kimi 平台区别](https://www.kimi.com/code/docs/kimi-code/faq.html)、[Kimi Code 模型](https://www.kimi.com/code/docs/kimi-code/models.html)、[MiniMax Token Plan](https://platform.minimax.io/docs/token-plan/quickstart)、[百炼各方案接入](https://help.aliyun.com/zh/model-studio/more-tools)、[MiMo Token Plan](https://mimo.mi.com/docs/zh-CN/tokenplan/Token%20Plan/quick-access)。

## 2. OpenCode Go 目录补漏

本轮生产与测试配置均为 25 个模型，官方端点表列出 28 个。差集如下：

| 缺失 Model ID                | 目标模板                | 协议             |
| ---------------------------- | ----------------------- | ---------------- |
| `longcat-2.0`                | `opencode-go-chat`      | Chat Completions |
| `muse-spark-1.3-contributor` | `opencode-go-responses` | Responses        |
| `muse-spark-1.2-contributor` | `opencode-go-responses` | Responses        |

- 现有 25 个模型分组与官方端点表一致，`minimax-m2.5` 仍在端点表中，不因简介列表省略就删除。
- Zen 的 `muse-spark-1.2-contributor-free` 不算 Go 覆盖，不复用其 ID 或权益。
- 沿用 Todo149 的站点规则、真实请求和默认启用边界；Muse Contributor 先默认关闭，核对地域和数据使用说明，不作为默认推荐模型。
- 补成员时同时核对输入能力、上下文、最大输出、工具调用、推理档位和映射。来源不能证明的字段不按模型名猜测。
- 本轮直接请求 `/zen/go/v1/models` 返回 HTTP 403，差集来自 [官方端点表](https://opencode.ai/docs/go/#endpoints)。未进行带 Key 的请求验证，不能把目录核对写成线上调用已通过。

## 3. 移除手动套餐特殊 Access

### 3.1 安全校验裁决

用户已明确取消：`zhipu-coding-plan-api-key` 可以不依赖域名、让手动 Key 在自定义代理地址进入安全校验流程的行为。不以新字段、模板 ID 或其他隐式判断恢复这条旁路。

目标准入顺序：

```text
Model 已绑定的 Access + Base URL
  ├─ zhipu-account / Start 或 Off-Peak → 不进入安全校验，保留原 JWT / Key / Ticket
  ├─ zhipu-account / 个人或团队 Coding Plan → 保留既有账号安全校验准入
  ├─ 手动 api-key → 仅现有官方域名或精确测试 hostname 可进入安全校验流程
  └─ 其余 → 不进入安全校验流程
                   ↓
         原远端开关 → HTTPS 约束 → 官方版本请求安全校验 / 重试 / 降级
```

- 保留官方 `z.ai`／`bigmodel.cn` 根域及子域、`api.z.ai`／`zcode.z.ai` 精确测试域规则，不扩大 hostname 边界。
- 本次仅取消手动特殊 Access 入口；账号个人／团队的原有安全校验规则不随之取消。Start／Off-Peak 优先排除继续有效。
- 保留现有请求安全校验、开关、缓存、错误与取消语义，不新增第二套校验状态。
- 本条取代 [Todo111](./todo-111-zhipu-coding-plan-api-key-and-standard-api-templates.md)、Todo136 中手动特殊 Access 独立准入的部分；Todo142 的账号例外保留（这两份文档只在官方版本保留）。

### 3.2 GLM-5.3 视觉徽标

采用最小展示调整：手动套餐由 `templateId` 识别，账号套餐继续由已有 Access mode 识别。两个 View 已携带模板身份，设置页与模型菜单共用判断，不新增 Model 能力 Schema。

| 条件（模型 ID 忽略大小写后精确为 `glm-5.3`）   | 视觉徽标                |
| ---------------------------------------------- | ----------------------- |
| 模板 `zai-api`／`bigmodel-api`                 | 隐藏                    |
| 账号个人／团队 Coding Plan 或 Start Plan       | 隐藏                    |
| 普通 API 模板、无模板自定义 Provider、Off-Peak | 按 `supportsImage` 显示 |

- 所有模型先满足 `supportsImage === true` 才可能显示；GLM-5.3-Flash 和其他型号继续按能力显示。
- 保留 GLM-5.3 的实际图片输入能力。禁止为隐藏徽标把 `supportsImage` 改成 false，或改变附件上传、校验与请求编码。
- 不按显示名称、Provider ID 前缀、Key 内容或官方域名猜测是否为套餐模板。已关联套餐模板的实例即使改名／改 URL，展示仍按其模板身份；这不赋予安全校验准入或套餐权益。
- 无模板的旧特殊 Access 归一后按普通自定义 Provider 展示，不为保留历史徽标伪造模板关联。
- 本条替代 [Todo126](./todo-126-glm-flash-pdf-and-coding-plan-turbo-defaults.md)／[Todo137](./todo-137-start-plan-glm53-vision-badge.md) 对手动套餐的识别方式，其图片能力和账号套餐展示边界保留。

### 3.3 配置兼容与退役

- 正式 Schema、领域对象、序列化与 Runtime 只保留通用 `api-key` 和现有 `zhipu-account`；不长期维护两套手动 Key 语义。
- 实施前审计 Built-in 缓存、Personal 配置、导入与远端配置读取边界。在唯一明确的兼容解码／迁移入口将旧手动类型归一为 `api-key`，保留 Key、管理页、已有 templateId 和个人覆盖；不能让旧值导致整份配置读取失败或覆盖时丢 Key。
- 兼容层不恢复特殊安全校验行为，不双写旧类型。记录具体入口、旧配置仍可能到达的来源、测试证据和退出条件；不只删除 enum 就宣布完成。
- 不重建历史 Provider／ModelSelection，不改账号 Access 或凭据 owner；本地／远端各自处理所属配置，不混用 Host 的凭据。

## 4. 新厂商候选与退出条件

候选来自公开的第三方 provider 预设整理（本轮核对），优先级为本轮建议，尚未证明所有入口可发布。推广链接、历史套餐和客户端专用配置不直接复制。

| 批次   | 候选                                                     | 实施前必须收口                                                                                                                                              |
| ------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 第一批 | 火山方舟／豆包                                           | API、Agent Plan 与旧 Coding Plan 的有效入口、模型身份和存量边界；[官方 Agent Plan](https://www.volcengine.com/activity/agentplan)                           |
| 第一批 | 腾讯 TokenHub                                            | 优先 Token Plan；通用／Hy 套餐共用 Key 和端点、模型权益不同，避免重复模板；[官方接入](https://cloud.tencent.com/document/product/1823/130119)               |
| 第一批 | 百度千帆                                                 | API 与 Token Plan 个人版；旧 Coding Plan 已停止续费，不能作为新增默认；[升级公告](https://cloud.baidu.com/news/notice_e839687d-1cf7-4a5b-afbd-ea2f7bcd325d) |
| 第一批 | SiliconFlow                                              | 中国／国际地址、Key 归属和各协议实际支持模型；[官方接入](https://docs.siliconflow.cn/docs/usercases/use-siliconcloud-in-ClaudeCode)                         |
| 第一批 | Google Gemini API                                        | 仅评估官方 OpenAI 兼容接口与 API Key，验证工具调用、思考签名及图片链路；[官方兼容说明](https://ai.google.dev/gemini-api/docs/openai)                        |
| 第二批 | StepFun、LongCat、PPIO、ModelScope、NVIDIA NIM、BytePlus | 按用户需求评估产品入口、现有协议表达能力和模型证据，暂不发布半成品模板                                                                                      |

- Gemini 候选不自动解除 Todo22 对 Google 原生 Adapter／Vertex 的排除；若兼容接口无法满足契约，记录缺口后独立设计。
- Bedrock、Azure 等复杂云认证继续留在 Todo22 专题，不混入普通模板补漏。新增类型需有真实认证需求，不能用手写 URL 掩盖区域、部署身份或签名差异。
- 候选转为可实施切片前，列明准确名称、Template ID、Key 页面、端点、原始 Model ID、默认启用范围、能力与参数证据、真实验证条件。

## 5. 实施入口与验收

配置入口为 `config/provider/zcode-builtin.json`；只编辑生产来源，通过 `pnpm provider:config:sync-test` 生成测试配置，并运行 `pnpm provider:config:check-test`。按实际最新 revision 递增，不固定沿用本轮基线 28，不自动发布线上配置。

Access 与读取边界重点检查 `packages/provider/src/config/`、`packages/provider/src/resolver.ts`、`packages/provider-node/` 及现有持久化／导入消费者；安全校验准入入口为 `apps/zcode-cli/packages/adapters/src/model/model-execution.ts`。展示入口为 `packages/ui/src/lib/modelVisionBadge.ts`、`modelSelectionGroups.ts`、设置页 `ProviderFormControls.tsx` 及其 props 传递链。

- [ ] 实施前重新检查基线和用户改动，按命中目录规则做架构影响梳理；更新对应 spec 与历史冲突裁定，不将研究候选写成现行事实。
- [ ] 先补预期测试：四个智谱模板均为 `api-key`；旧特殊类型读取归一、Key 保存和覆盖不丢失，模板关联与历史选择保留。
- [ ] 安全校验测试同时覆盖官方／精确测试域、相似域名、自定义代理、开关关闭、HTTPS 与降级；代理手动 Key 不进入安全校验，账号例外不回归。
- [ ] 设置页和模型菜单覆盖两个手动套餐模板、普通 API、无模板自建、个人／团队／Start／Off-Peak；GLM-5.3 精确匹配、Flash 与底层图片能力保持。
- [ ] 真实加载 Built-in 验证各入口成员、默认启停、完整能力与映射；Go 目录差集归零或逐项说明暂缓原因，不将地域受限型号当作所有账号可用。
- [ ] 新入口验证最终 generate／stream 请求、工具调用、推理与 usage；已有模板和手动同端点在无个人覆盖时执行配置一致。真实 Key 缺失时记录未验证范围。
- [ ] 运行根 typecheck、lint、`pnpm architecture:check --changed`、受影响测试；CLI 改动另跑 CLI typecheck／lint 和相关包测试。
- [ ] 按 E2E 工作流复用／维护设置及模型选择用例，覆盖桌面／手机、深浅主题与中英文；共享组件浏览器证据不冒充原生或手机远控整链路通过，pending 不自动转正。
- [ ] 检查本地／远端配置及凭据隔离，保留 continuous／replayable 边界；检查模板创建、编辑、重启恢复及旧配置兼容。
- [ ] 完成 diff 自检，按切片记录验证与剩余问题后本地提交；Push、MR、线上配置发布另按用户请求执行。

## 本轮实际交付与剩余问题

- 仅新增本 Todo 和实施索引；产品实现、配置更新、旧类型迁移与以上验收均未执行。
- 调查时运行现有 CLI 安全校验准入／等价性两文件测试，134 项通过。它们证明当前行为及官方端点等价性，不证明移除特殊类型后的新行为；实施时需要修改代理域名等旧预期。
- 新厂商的最终模板清单、各套餐可用模型和真实调用证据尚待补齐。此处保留候选状态，不新增自动发布或账号授权操作。
