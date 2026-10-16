# Todo154 调研：Start 独立 Provider 的当前限制

> 调查日期：2026-09-16。
> 调查代码基线：`c9f959050b8b17e0815f1680d674f09355649da0`。
> 后续工作区已快进到 staging `2772217134`；本调查与 17 项单测证据仍属于原基线，行号和接入点需在实施前复核。上游 Todo153 已被占用，本条由 Todo153 顺延为 Todo154。
> 本文保留实施前调查，不作为当前代码状态；2026-09-16 已授权实施，最终实现与 Pro 验证见 Todo154 §8。
> 结论去向：[Todo154](../steps/todo-154-start-plan-independent-provider.md)；目标设计以 [Design V2](../design-v2/design.md) 为准。
> 本文只记录代码事实、既有材料差异和证据限制，不把实现候选定义为架构。

## 1. 需求对应的实际代码

| 事实 | 代码入口 | 对本需求的影响 |
| --- | --- | --- |
| 两家各有固定 Start Provider ID，静态 Access 为 zhipu-account/start-plan | `packages/shared/src/model-provider-types.ts`、`model-provider-family.ts` | 现有对象已经存在，用户要增加的是独立展示/使用入口，不等于新增登录账户 |
| 服务按品牌加载 OAuth profile/token | `packages/services/src/node.ts` 的 loadAccountIdentity 和 auth 注入 | Start 可继续使用当前登录；不存在本需求必须增加第二套 OAuth 的证据 |
| Start 余额查询与个人套餐独立；余额决定权益和动态模型集合 | `packages/services/src/model-provider/codingPlanProviderAvailability.ts` | 取消手动连接不能取消 pending、空模型和无权益判断 |
| current 由当前品牌与 selection.kind 一起计算 | `packages/services/src/model-provider/accountProviderConnectionResolver.ts` | 未选 Start 即使有权益，也不是当前执行连接 |
| Registry 通过 current !== false 参与 providerExecutable | `packages/provider/src/resolver.ts` | UI 单独显示 Start 不能使真实执行通过 |
| 所有内建账号套餐被分为 account-plan；有效选择要求恰好一个 current 并映射 providerId | `packages/provider-node/src/model-selection-facade.ts`、`packages/provider/src/effective-model-selection.ts` | 直接让 Start 与 Team 都 current 会破坏选模；必须收口公共选择策略 |
| 请求期身份要求当前 selection 与 access.mode 匹配 | `resolveCurrentAccountAccess` | 只放开 Registry 仍会在鉴权前被拒绝 |
| Start 凭据从登录 tokenSet.zcodeJwtToken 读取 | `packages/services/src/model-provider/accountProviderRequestAuthService.ts` | 无需在 Provider Config 或 UI 中新增 token 副本 |
| family 子项折叠到使用 Start ID 的 side key，详情会按当前套餐定位 | `packages/ui/src/settings/model-provider-section/useModelProviderNavigation.ts` | 独立 Start 需要导航身份与详情解析一起调整 |
| 点击 Start 会生成 kind:start-plan 并保存 family selection | `packages/ui/src/settings/ModelProviderSection.tsx` 的 resolveConnectionSelectionForNavItem / persistProviderFamilyModeForNavItem | 页面浏览目前有执行连接副作用 |
| 断开 handler 调用 OAuth logout | 同文件 handleCodingPlanDisconnect | Start 去连接化需要删除对应动作，不能只替换文案 |
| 登录初始化仍可能选择 Start，重启路径保护旧 Start selection | `packages/ui/src/root/oauthProviderFamilySelectionRefresh.ts`、`packages/ui/src/lib/modelProviderFamilyConnectionSelection.ts` | 初始化与旧记录处理必须一并规划 |
| 根层失效观察只 find 第一个 current，Toast 只存一条 notice | `accountConnectionRefreshObserver.ts`、`useAccountConnectionLossNotification.ts` | 并存后可能漏提醒或互相覆盖；是否复用 current 需包含这些消费者 |

## 2. 已核对的调用链与状态 owner

```text
OAuth profile/token + SettingService
                ↓
Account Connection Resolver → Account Source 状态/Overlay
                ↓
ProviderConfigResolver → Settings View / Registry
                ↓
Node ModelSelectionFacade → Effective Selection
                ↓
ModelFactory → Account Request Auth → Start JWT 请求
```

- `createNodeModelSelectionFacade` 同时由 services 的 providerRuntime 与 CLI protocol entrypoint 使用。
- Account Source 在发布前重新核对账号/设置，变更时拒绝迟到结果；resetPrevious 隔离旧账号 LKG。
- 各执行 Environment 使用自己的 Registry；Host/Worker 的账号事实同步不能改成整份 Registry 同步。
- 设置页浏览 owner 是 UI；付费连接的持久化 owner 是 SettingService；模型原意图保持各入口原 owner。
- `connectionKey` 当前包含 selection，若 Start 不再依赖付费连接，应评估去掉这部分身份依赖。

## 3. 与旧材料的差异

| 材料 | 现有描述/状态 | 本轮处理 |
| --- | --- | --- |
| [Todo101](../steps/todo-101-concurrent-account-providers-draft.md) | 多个具体 Account Provider 并存的 Draft，明确延期 | 用户本轮只要求独立 Start；不恢复多 Team/动态实例/抽屉方案 |
| [Todo93](../steps/todo-93-account-plan-loss-manual-switch.md) | 失效只提示一次，用户点击才切换 | 保留无隐式切换目标；独立 Start 的按钮副作用需重新收敛 |
| `docs/testing/model-provider-restart-connection-e2e-cases.md` I27/MP-R03 | 矩阵写 Start→Team；实际测试注入 Recent 后断言 Configured Default | 矩阵与代码漂移；不能证明正常 Session 长期残留旧 Start，不能据此要求全量迁移 |
| `docs/testing/start-plan-manual-claim-e2e-coverage.md` | 仍保留早期自动切换历史和后续裁决 | 实施时按最终目标更新验收，当前不改写历史为新事实 |
| feature graph 的 plan-entitlements | resolveLatestModelProviderFamilyConnectionSelection seed 在当前文件不存在；保留旧 Start 自动回退描述 | 记录 drift，阶段稳定后收敛，不在本轮改图谱 |

## 4. 写回链路与不迁移判断的纠偏

| 入口 | 当前代码事实 | 证据 |
| --- | --- | --- |
| 普通 Session | applySubmissionExecutionState 在普通提交真正开始执行时 setSessionModelSelection 并 persistRuntimeModelSelection；execution scope 的临时模型排除 | `apps/zcode-cli/packages/core/src/runtime/methods/turn-model.ts:40`，`turn.ts:284` |
| Composer | useDraftConfigControl 派生 effectiveSelection；captureAcceptedModelSelection 在 accepted 回调写回，保留原 scope／用户改选保护 | `packages/ui/src/v4/composer/useDraftConfigControl.ts:172`、`:242`，`SessionPane.tsx:1493` |
| Automation | 首次派发通过目标 Host 解析长期选择，将结果写入 run；长期 automation.model_selection 不因该解析更新 | `packages/desktop/src/host/automationModelSelection.ts:5`，`host/index.ts:869`，`packages/services/src/session/automationRepo.ts` 的 fixRunModelSelection |
| Bot | 草稿首发解析后创建会话；绑定后读取 Session 选择解析并提交，走 Session 写回路径 | `packages/services/src/bots/botsService.ts:4878`、`:4994` |
| Wiki | 新生成解析一次，RepoWikiDraftSummary 保存 modelConfig.modelSelection；失败页补齐固定已有生成身份 | `packages/services/src/repo-wiki/repoWikiModelClient.ts:98`，`repoWikiService.ts:369` |
| 显式 Subagent | profile 选择克隆后解析给本次执行，不修改 profile；继承使用父模型 | `apps/zcode-cli/packages/core/src/runtime/helpers/subagent-selection.ts:15`，`runtime/methods/subagent.ts:100` |

只读 effective-selection 函数不写原输入，不能推出整个提交链路不写回。此前由此推导全量 Session／草稿迁移、升级连接快照、逐存储语义版本，属于助手调查不足，已在用户指出写回事实后撤回。

I27/MP-R03 的实际证据：`packages/desktop/test/e2e/helpers/model-provider-restart.ts:133` 把选择注入 localStorage Recent；`conversation-session-model-provider-restart-recovery.test.ts:134` 断言恢复到 DeepSeek Configured Default。它不注入 Session 的 runtime/model_selection，也不证明实际用户存在残留比例。

当前格式已能保存两家 Start 的完整 Provider ID。没有格式层证据要求新增数据迁移；用户确认保留原选择按新规则解释。仍可能存在长期配置保存 Start、过去依赖付费映射的情况；新规则下它使用 Start，无权益时需重选。这是已确认的产品边界，不是“所有配置都已自动纠正”的事实。

## 5. 新推荐的提交入口调查

| 入口 | 当前提交事实 | 与推荐有关的边界 |
| --- | --- | --- |
| 对话 | SessionPane 的 createSubmissionFromComposer／dispatchSendText 形成新提交，accepted 后写回 | 按钮、快捷键、附件、新队列／引导提交需共用检查；不能先发送再推荐 |
| 定时任务表单 | AutomationEditView.submitAutomation 在校验后调用 onSubmit，保存并运行也复用它 | 可在创建／修改模型保存前提示一次 |
| 定时任务立即运行 | management store 仅以 automationId 调 runAutomationNow，无本次选择参数 | 用户最终排除此入口，不扩协议 |
| Wiki | RepoWikiPane.generate 形成新请求；regenerateFailedPages 是另一条固定生成身份路径 | 手动新生成纳入，补齐失败页与自动刷新排除 |
| 自定义 Subagent | SubagentForm.handleSubmit 校验后 onSave | 创建／修改显式模型保存可接；其他字段修改不提示 |
| 内置／插件 Subagent | 共用 SubagentModelOverrideControl，handleValueChange → persistConfig 即改即存 | 模型选择即提交；仅调思考强度、继承／默认或启停排除 |
| Bot／后台执行／闲时 | 各自提交和执行语义已有独立 owner | 用户排除推荐，不改变现有执行路径 |

具体源码：`packages/ui/src/v4/SessionPane.tsx`、`settings/AutomationEditView.tsx:1769`、`store/automationManagementStore.ts:424`、`repo-wiki/RepoWikiPane.tsx:795`、`settings/SubagentsSection.tsx:588`。

余额来源已有 `UsageEntitlementSnapshot` 和 `startPlanQuotaBuckets.ts`：按模型匹配多个有效桶，unknown 不作 0 或正余额。当前 `useV4SessionQuotaBanner` 的查询 enabled 依赖已选 Start，因此不能直接把这个 hook 当成付费模型推荐的数据来源而不调整读取条件。Registry 可执行与 entitlement=true 也不单独证明存在可用余额。

图谱中的 model-selection 节点描述了多个入口共享有效选择读取，但没有本轮新增的提交推荐及持久化偏好边；新增边暂作为待稳定后提炼的 graph delta，不在此次只读调查中改写图谱。全局 observer 当前 find 首个 current 的事实仍成立；最终方案选择只观察付费连接，不采用多个全局通知的候选实现。

## 6. 验证与限制

2026-09-16 为核对既有行为运行：

```sh
pnpm exec vitest run packages/desktop/test/automationModelSelection.test.ts packages/provider/test/facades.test.ts
```

结果：2 个文件、17 项通过。Automation 测试明确验证有效选择可以改变 Provider，但原配置 providerId 不变；Facade 测试验证解析结果不写原输入。这些与 Session／Composer 写回共同构成分入口证据，不能相互替代。

- 无可调用 codegraph，通过精确搜索、imports 和关键调用方阅读核对，未宣称穷尽全部动态路径或真实用户数据。
- 未实施新行为，未执行新功能 E2E、真实账号请求或线上数据审计；未修改真实凭据和任务数据。
- 首轮环境缺 typescript，后续误启动实施准备时依赖安装在 cpu-features／node-pty 本地编译阶段失败；之后上述纯单测已可运行，architecture:check --changed 曾通过。旧“所有工具仍缺依赖”的表述已失效，实施时按实际环境执行必要检查。
- 曾因误解用户表达写出的两份测试草稿已删除，没有保留业务实现或测试变更，不把它们当成已交付用例。
- 不迁移是当前格式事实和用户最终规则共同支持的方案；不保证所有依赖旧映射的长期配置执行效果不变，也没有据此新增自动纠正逻辑。

当前目标与验收由 [Todo154](../steps/todo-154-start-plan-independent-provider.md) 维护，research 不建立另一份待实施方案。
