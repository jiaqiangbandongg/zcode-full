# Todo 106：MCS 与站点能力规则纠正

> 状态：实现、真实 SDK wire 验证及逐项复审完成。2026-09-10。实施/测试证据、逐条边界复审及真实环境限制见 [本批交付复审](./provider-todos-105-113-delivery-review.md)。

## 原则与目标

遵循 [Design V2 的 Match 配置维护原则](../design-v2/design.md)：主流配置、官方优先，不为落后的第三方兼容实现降低默认能力；站点规则按一具体 URL 一条维护。

## 已确认改动

1. 移除 Anthropic 官方站点对全部 `claude-*` 开启 MCS 的宽泛声明。按官方明确支持的型号及 API Schema 声明 MCS；不得让 Sonnet 5 被误开启，也不顺带关闭既有原生联网搜索。
2. 恢复 `claude-opus-4-8` 在 Anthropic Messages 下的模型级 MCS 默认支持，覆盖既定前后缀形式，不要求代理站点另行放行。代理不支持时用户可在 Personal 中关闭；修正当前“未知站点上的 Opus 4.8 必须为 false”的测试。
3. 以下两项分别写一条站点规则，API 为 `anthropic-messages`、模型不限，均声明 `supportsMidConversationSystem: true` 与 `supportsNativeWebSearch: true`：
   - `https://zcode.z.ai/api/v1/zcode-plan/anthropic`
   - `https://zcode.z.ai/api/v1/off-peak/anthropic`
4. 对本次涉及的合并 URL 站点规则按 URL 拆开（包括普通 Z.ai / BigModel endpoint）；保留各 URL 的既有独立能力，不因拆规则给某站点增加另一站点的能力。不做无关规则或 Runtime 重构。

## 核查依据及边界

- 当前实际 Built-in 解析已复核：官方 `claude-sonnet-5` 的 MCS 为 true；代理 Opus 4.8、Start 和 Off-Peak 的 MCS 为 false。
- 改造前 `fe8a3159c7^` 的 `contracts/src/model/mid-conversation-system.ts` 和 `contracts/src/tools/websearch.ts` 都按 `z.ai` 等域名及子域放行；因此上述两个 endpoint 的 MCS、原生联网搜索原来均被声明为支持。此证据确认旧代码行为，不冒充真实网关测试通过。
- [Anthropic 官方 MCS 文档](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)明确 Sonnet 5 不支持 MCS；实施时核对官方支持型号，不使用笼统 Claude 品牌匹配。
- Runtime 继续只消费最终属性；不恢复旧 URL allowlist、fast model 特判，不修改 Selection、账号状态或请求失败后的重试策略。
- Personal 显式关闭继续优先，不因模型或站点默认开启而失效。

## 验收清单

- [x] 先补配置解析回归：官方支持／不支持型号、第三方 Opus 4.8、前后缀型号、API 类型隔离。
- [x] 复核 BigModel / Z.ai 的 Start 与闲时共四个 Provider，最终 MCS 和原生联网搜索均开启；普通 Coding Plan 不回退。
- [x] 验证 URL 规范化及负例，不误匹配无关域名／路径；个人关闭可覆盖默认。
- [x] 在最终请求编码处验证开启时独立 system reminder、关闭时既有 user reminder，以及原生搜索的工具编码；不只检查配置布尔值。
- [x] 按整批执行相关测试、复审规则层次和覆盖顺序，记录真实服务验证限制，不把本地请求捕获当作上游验收。

## 实施与复审证据

- 按官方 MCS 文档当前支持名单，在 `modelApiRules` 声明 Opus 4.8/5、Fable 5/5.1、Mythos 5/5.1；Sonnet 5 不开启。移除官方 URL 的宽泛 MCS，保留它的搜索声明。
- 普通 Coding Plan、Start、Off-Peak 各 URL 分别维护 MCS/搜索；原三 URL 媒体规则也按 URL 拆分，未将媒体能力扩展到 Off-Peak。
- `mcs-capability-rules.test.ts` + Builtin 完整性 + rule-collections：20 条通过，覆盖官方/代理、前后缀与点号别名、不同 API、精确路径负例、尾斜杠、Personal false 和八个 Account Provider。
- `builtin-mcs-search-wire.test.ts` 经发布规则 → Core reminder 投影 → 实际 SDK/Adapter → mock fetch，7 场景通过；联合现有 MCS wire/WebSearch 共 14 条通过。确认四个 Start/Off-Peak 的 system reminder 与原生搜索工具编码，Sonnet 降为 user reminder，代理 Opus 开启及个人关闭。
- 逐条复审：无 Runtime URL/模型 allowlist、无新鉴权或重试分支、无 Selection 写入；保持规则顺序与 Personal 最终覆盖。测试的 Key/网络全为夹具，未调用真实服务。
- 官方证据：[MCS 支持型号](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)，2026-09-10 再核对。Fable 5.1 模板/其他能力由 Todo113 接续，不重复加模板。
