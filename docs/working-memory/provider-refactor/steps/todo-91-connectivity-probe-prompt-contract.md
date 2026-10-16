# Todo 91：固定连接测试 Prompt 契约

> 2026-09-12：输出预算由 Todo144 接续调整为独立 1 Token；本文历史的 5,000 预算记录不再作为当前要求，精确 Prompt 契约不变。

> 验证归属更新（2026-09-09）：本文残余欠测/失败/人工晋级统一转交 [Todo102](todo-102-verification-debt-closeout.md)，关闭在本文中的独立验证排期；历史证据保留，转交不代表测试通过。

> 状态：已实现并完成定向复审、离线请求验证及 Pro 隔离 Electron 验证（2026-09-08）。服务端白名单未修改、未用真实账号试探。
>
> 核对基线：`c017752329`，`provider-refactor-e2e-recovery`。

## 1. 已确认裁决

连接测试统一使用以下固定消息，保留精确文本、大小写、标点、角色与顺序：

```yaml
system: You are ZCode connectivity probe.
user: hi
```

- 保留当前正式 Model 的流式执行链路，消费完整流并沿用现有错误处理。
- 不恢复 staging 的 Start Plan 权益探测分流，不把“查权益成功”当成模型连接成功。
- 不向这组消息添加说明、国际化文案、历史对话、工具或另一个 system；不让普通对话、标题、Wiki、Subagent 等其他请求复用这组 Prompt。
- 普通 API Provider 与 Account Provider 的连接测试使用同一模板。Off-Peak 保持隐藏，不新增设置页测试入口，不获取或消耗 Ticket。
- 本项不恢复旧 Host HTTP Probe，不修改模型选择、账号连接、Personal Config、持久化格式或迁移。

## 2. 背景与纠错记录

当前 `core/src/runtime/methods/workspace-generate-text.ts` 的 `testModelConnectivity()` 只发送 user 消息 `Reply briefly to confirm connectivity.`；`8ea78019f7` 引入，`49e1f83710d` 后续测试固化了该文本。

旧 Start Plan helper 在 `2ae01c7584` 中加入上述 system + hi；但 `3162baa586` 随后将上层正常入口改成只查 billing/balance。固定 staging `16d999f6a48b` 与本地 `origin/staging` `a311537aa6` 均保留提前返回。因此“旧 helper 仍存在”不等于“staging 当前发送这个 Prompt”，更不证明服务端白名单已经废弃。

用户说明服务端可能按 Prompt 白名单限制账号请求。客户端仓库不能证明白名单当前内容或规则；本次裁决是采用明确的固定模板，不宣称服务端已配置或真实账号已验证通过。未确认前不得用真实账号反复试探。

## 3. 影响与状态归属（Impact Brief）

模式：planning；层级：commit-effect / 请求内容契约。范围仅连接测试，未改变会话或恢复语义。

| UI 场景 | 共享实现与展示状态 | 来源与校验 | 提交/权威执行 | 模式与隔离 |
| --- | --- | --- | --- | --- |
| Account 详情模型行测试 | Detail → ModelRowInput / useModelProviders；行内 pending 与结果反馈 | 已保存 Provider/Model；正式 Registry、Request Auth 校验 | Settings Service → Agent 协议 → testModelConnectivity → Model.streamText | Desktop/Web 共用；保留既有目标 Environment 路由，不改当前连接 |
| 普通/模板实例模型行测试 | InlineEditableProviderCard → 同一行控件和 hook | 先 flush Provider 草稿；服务等待相关写入，Worker 刷新 Registry | 同上；API 格式及选项映射由正式 Adapter 负责 | 不新增临时 Registry，不改其他模型或正在运行的请求 |

```text
点击测试 -> 等待现有保存边界 -> 正式 Registry 创建 Model
                                      |
                               固定 system + hi
                                      |
                        正式 Adapter / Request Auth
                                      |
                            当前 API 格式的流式请求
```

| 分级 | 关系与核对点 |
| --- | --- |
| must-inspect | `testModelConnectivity` 构造消息；Adapter 转为 Anthropic system/messages、Chat messages、Responses instructions/input 的最终请求体 |
| should-inspect | 当前测试 `workspace-generate-text-streaming.test.ts` 固化旧 user 文本；替换为新契约，并补无历史/无工具断言 |
| conditional | Account 请求仍依赖当前凭据、正常的请求安全校验链；不能以恢复 Prompt 为由绕过鉴权 |
| invariant-only | 保存/刷新、最低公开 reasoning 档位、输出预算、超时/重试、错误反馈、工作区隔离均保持；不改 Session/Active Model |
| evidence-only | 旧 staging helper 与上层 Service、旧权益测试用于说明历史，不整文件恢复 |

代码图工具不可用，已从 `surface.provider-settings` / `service.provider-settings` 的种子以直接调用追踪核对；默认两层，跨 App–Agent 的执行落点进一步追到 Core/Adapter。相关路径为 ModelProviderSection → useModelProviders → Provider Settings Service → zcodeAgentService → workspace-model-runtime → Core testModelConnectivity。图谱增加本 Todo 来源链接；暂不重写其他历史图谱语义。

## 4. 实现与清理边界

1. 实现前更新当前有效 `design/registry/settings.md` 的连接测试描述，明确固定模板与范围，再先写失败测试。
2. 在连接测试消息构造处维护唯一的固定模板/命名常量，不散落多份同义 Prompt；无需新增配置项、UI 输入或协议参数。
3. 删除被替代的旧字符串和相应旧断言；不复制 staging 已不可达的 Start Plan helper，不引入 Provider ID 特判。
4. 精确文本是硬契约；协议序列化复用现有 Adapter。最终 body 必须保留 system 角色和 user 角色，不能把 system 拼进 user。若服务端要求特定序列化结构且现有 Adapter 不满足，先明确服务端要求，再讨论最小适配，不能猜测改请求。
5. 输出预算（当前辅助调用最多 5,000）、流式、最低 reasoning、来源头、请求安全校验、超时和重试不随本项改动。此前审计提到的其他差异没有在本轮获准恢复；来源头风险仍须另行讨论，不能以本 Todo 完成宣称已经消除全部网关拒绝风险。

## 5. 验收与剪枝

| Case | 场景与操作 | 断言/证据 | 状态 |
| --- | --- | --- | --- |
| C91-01 | Core 测试连接，mock Model 收集请求 | 恰好 system + user 两条、固定精确文本与顺序，无 tools/历史；流错误仍失败 | accepted；单测待实现 |
| C91-02 | Anthropic / Chat / Responses 三种正式 Adapter，注入离线 transport | 拦截最终请求体，确认 system/user 文本和角色、stream=true；请求 model ID 不变，不靠 prompt contains 放行 | accepted；协议请求测试待实现 |
| C91-03 | Account（Start/个人/Team）与普通 Provider 使用假凭据 fixture | 相同模板；身份及凭据不串用；Start 仍走模型请求，不改回权益探测 | accepted；服务/执行路径测试待实现 |
| C91-04 | 隔离 Electron 环境从模型行点击测试 | 最终请求满足契约，成功/失败反馈正常；正常对话选择与配置不变 | accepted；E2E 待编写/审阅/运行 |
| 非连接测试消费者 | 标题、Wiki、普通对话、Subagent | invariant-only；不改通用 generateWorkspaceText 或共享辅助选项来传递此 Prompt | 不扩张为全域改造 |
| 真实账号白名单试探 | 重复发送不同 Prompt | pruned；封号风险，不作为自动化验证方法 | 禁止用于本轮验证 |
| 所有品牌×所有协议×所有主题 | 全排列 | pruned；固定文本无 locale/theme 分支，协议三类及账号/普通代表足够 | 代表覆盖 |

实现阶段按现有 E2E 生命周期补模型连接测试用例及 coverage 记录，新增用例先 pending 人工审阅；测试 transport 禁止回落真实网络。MacBook Pro 运行隔离 Electron 验证，手机/远程没有实际验证则明确列出，不以桌面通过替代。执行相关单测、`pnpm typecheck`、`pnpm lint` 后提交。

## 6. 交接与未确认项

- Todo 90 继续负责添加/编辑模型共用草稿，与本项独立；MFJS 样式和覆盖高亮正在讨论，不混入此 Prompt Todo。
- 唯一外部未确认项：服务端当前白名单按哪些字段、角色与序列化形式匹配。这里记录客户端目标，不声称服务端已放行。
- 实施记录见下一节；不将离线验证等同于真实账号白名单已放行。

## 7. 实施与复审记录（2026-09-08）

| 项目 | 结果 |
| --- | --- |
| C91-01 | Core 四种身份精确消息断言先红（4 条），修改唯一构造点后通过；新增抛错、error event、无 finish 失败断言，原低 reasoning/预算/完整流及 Wiki 行为保留 |
| C91-02/03 | `connectivity-probe-wire.test.ts` 使用正式配置解析、runner options 和三种 SDK Adapter，离线 transport 截获最终 JSON；六组普通/Account 身份验证精确角色文本、stream/model、假凭据隔离、无 tools；所有请求被拦截，不回落网络 |
| C91-04 | pending E2E 从真实设置模型行发起，case-local loopback server 返回成功 SSE/400 失败；两次最终请求均为固定模板，Personal 文件、连接选择和 Composer 草稿保持原样 |
| 代码复审 | 生产只改连接测试消息及命名常量；未修改通用 generateWorkspaceText、Adapter、Request Auth、协议、预算、重试或连接状态。删除旧 Prompt 断言，没有恢复 staging 旧分流 |
| 本地验证 | CLI 3 个定向文件 32 测试通过；Core typecheck、根 pnpm typecheck 通过；根 lint 0 errors / 40 既有 warnings |
| Pro | `desktop-e2e-20260908-102455-529`，1/1 通过，隔离目录 `/Users/dev/zcode-todo93-e2e.88xgST`；已重新构建 Agent，复跑只复用该新构建 |

首轮 E2E `desktop-e2e-20260908-102321-138` 已出现成功/失败 UI，但失败断言错误期待原始网关文案；正式链路归一化为 `Provider rejected the model request.`。按既有契约修正断言后通过，未为测试改变产品错误处理。

E2E 文件：`packages/desktop/test/e2e/settings/manual-review/pending/provider-connectivity-prompt.test.ts`。固定白名单禁止追加 Prompt marker，使用独立 `E2E_C91_MODEL`、完整消息数组和 localhost endpoint 识别；synthetic / fast-text 响应只用于连接探测。保持 pending，未代替用户人工审阅转正。手机/远程和真实 Account 网络未实测。

额外执行 CLI Core 包级 lint：既有多个无关文件超 400 行等导致失败；本次唯一生产文件的定向 oxlint 通过。未借 Prompt 修复重构这些无关文件，根 lint 仍通过；包级 lint 不记录为绿色。
