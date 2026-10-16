# 阶段 B：Provider 重构自动化证明收口

> 状态：自动化实现完成；关键 E2E 等待人工 review 与可用图形/Docker 环境
>
> 最近更新：2026-08-25

## 1. 目标

本阶段只补齐能够直接证明 Provider 重构正确性的自动化证据，不改造全仓 CI、workspace、Node、lockfile 或 formatter 基线。

```text
真实 Built-in Config 完整性
            |
            v
真实 Config 到 Active Model 纵向集成
            |
            v
Runtime 分支覆盖审计与补缺
            |
            v
Provider 关键 E2E 晋升
            |
            v
定向与全量回归验证
```

## 2. 自动化证明

1. 直接读取真实 `config/provider/zcode-builtin.json`，为 API Key、Account 与 Request Auth Provider 补入各自最小执行期访问材料，证明每个 Built-in Provider 和模型成员都能解析成完整 Registry Config。
2. 使用真实 Built-in Config 贯通 Overlay、Resolver、Registry、ModelFactory 与 Adapter，证明最终 Provider/Model Config 不被重新推断。
3. 复核普通请求、Compact、Memory、Subagent 与 Off-Peak 均消费同一个 Active Model；已有直接证据的链路不重复造测试。
4. 对 Provider 身份、Registry 冷启动、闲时子 Agent 与候选过滤四个 pending E2E 完成 fixture、replay 和人工 review 门禁；未经人工确认不得晋升。

## 3. 测试边界

- 完整性测试不固定 Provider、Rule 或 Model 总数，也不要求通用 Rule 必须命中 Built-in 成员。
- Built-in API Key Provider 由 Personal Overlay 注入测试 Key；Account Provider 由 Account Overlay 注入 accessId 和必要 Team scope；Request Auth 保持请求期注入。
- 测试可以引用真实模型 ID 固定配置事实，生产代码不得按具体模型 ID 分支。
- `support_pdf: false` 与 `support_audio: false` 是本阶段已确认输入，不修改配置事实。
- Remote Provisioning、真实账号、正式制品、历史数据升级、队列与恢复语义不属于本阶段。

## 4. E2E 决策

第一批候选为：

- `conversation-session-same-model-draft-provider-identity`
- `conversation-session-provider-registry-prewarm`
- `conversation-session-offpeak-subagent-model-inheritance`
- `conversation-session-model-provider-list-filtering`

本阶段不晋升 `model-switch-compact`、`model-switch-queue` 与 `model-provider-session-isolation`。前两者分别存在已知 transport/产品状态问题和更宽的 Queue 交叉面；后者留给会话生命周期专项。

人工 review 于 2026-08-25 确认以下证明边界：

- 同名模型身份使用现有 `same-model-draft-provider-identity`：两个 Provider 暴露完全相同的 modelId，
  使用不同 Provider ID 与 Base URL；复合选择值、菜单选中态、草稿配置和真实请求 URL 都必须保持目标
  Provider。旧 `same-model-provider-identity` 实际使用不同 modelId，只能作为普通跨 Provider 切换覆盖，
  不承担本阶段的同名身份隔离证明。
- 候选过滤 E2E 使用代表性负样本证明 hidden Provider、visible Provider 下的 hidden Model、disabled 或
  incomplete Provider 不进入普通候选；同时以真实 ZCode Built-in Provider + Personal 同 modelId 覆盖证明
  冲突时 Built-in 成员仍可选择、可发送。重复排列和 issue code 继续由 Resolver 单测证明，E2E 不复制
  Resolver 全量状态空间。
- 普通任务中，无显式模型的 Subagent 继承父 ModelFactory，显式模型仍创建自己的 Model；Off-Peak 是
  执行作用域约束，所有 foreground child 必须继续使用本轮闲时 Provider/Ticket/Request Auth，background
  child 在发请求前拒绝，闲时轮结束后的普通消息恢复用户 Provider。
- Registry prewarm 除 provider/model、toolbar 与 last-selected 外，还必须通过 case-local Base URL 证明首个
  请求确实命中冷启动前配置的 custom Provider。

## 5. 完成标准

- 真实 Built-in Config 的全部 Provider 与模型成员由永久测试保护。
- API Key、Account、Request Auth 三条路径均有真实配置到 Active Model 的纵向证据。
- 普通请求、Compact、Memory、Subagent、Off-Peak 均有明确自动化证据。
- 四个 E2E 完成可自动执行的 fixture/replay 验证；只有人工 review 通过的用例才进入正式目录和 Docker preset。
- Provider 定向测试、相关包 typecheck、根 typecheck、lint 与全量 unit 通过。
- 不恢复旧 Provider/Model 抽象、具体模型运行时 hardcode 或第二份模型事实源。

## 6. 实施结果

### 6.1 永久自动化证据

| 证明层                      | 自动化证据                                                                                | 结果                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 真实 Built-in Config 完整性 | `packages/provider-node/test/zcode-builtin-integrity.test.ts`                             | 真实 JSON 的 Provider、模型成员、访问材料 Overlay、完整 Model Config、隐藏闲时模型与旧字段归零均通过 |
| API Key 纵向链路            | `apps/zcode-cli/packages/bootstrap/tests/zcode-builtin-model-runtime-integration.test.ts` | `builtin:zai` 从 Built-in + Personal Overlay 经 Resolver/Registry/ModelFactory 原样进入 Adapter      |
| Account 纵向链路            | 同上                                                                                      | Start Plan 的 Account 成员约束生效，Personal Provider Overlay 保持最后覆盖                           |
| Request Auth 纵向链路       | 同上                                                                                      | 隐藏闲时 Provider 可由普通 Registry 精确创建，Request Auth Source 仅在执行期绑定                     |
| Request Auth 缺失           | `apps/zcode-cli/packages/adapters/tests/model.test.ts`                                    | generate/stream 均在网络调用前返回 `ModelRequestAuthMissing`                                         |
| Model 冻结                  | `apps/zcode-cli/packages/bootstrap/tests/provider-registry-model-runtime.test.ts`         | Registry 更新只影响后来创建的 Model                                                                  |

真实 Built-in 集成测试只捕获 Adapter 的创建参数，不发送网络请求，也没有增加执行 Registry、能力 DTO、
Provider snapshot 或测试专用生产 API。

### 6.2 Runtime 分支覆盖审计

| Runtime 分支 | 直接证据                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 普通请求     | `packages/adapters/tests/model.test.ts`、`packages/core/tests/runtime-model-lifecycle.test.ts`                                                                           |
| Compact      | `packages/core/tests/compact-media-capability.test.ts`、`packages/core/tests/compact-summary-model-request.test.ts`                                                      |
| Memory       | `packages/core/tests/memory-agent-loop.test.ts`、`packages/core/tests/runtime-memory-extraction.test.ts`                                                                 |
| Subagent     | `packages/core/tests/subagent-inherited-model-factory.test.ts`                                                                                                           |
| Off-Peak     | `packages/core/tests/runtime-model-selection.test.ts`、`packages/bootstrap/tests/v4-native-commands.test.ts`、`packages/services/test/offPeakModelSelectionView.test.ts` |

上述测试已经直接读取同一个 Active Model 或 ModelFactory，没有发现需要新增生产分支或第二套模型事实的缺口。
相关 CLI 定向集合共 9 个文件、203 个测试通过。

### 6.3 关键 E2E 门禁状态

四个 pending case 的 case-local manifest 与 replay fixture 均通过机械校验。现有非阻断 warning 为三个 title
fixture 没有 E2E marker，以及 Off-Peak fixture 的两个 marker 未覆盖；它们不改变 fixture contract 通过结论，
留待人工 review 判断是否需要补充观测点。

本机 pending replay 已完成 Desktop、CLI、Adapter 与 Bootstrap 构建。首次运行暴露旧依赖安装状态导致的 Zod
解析冲突，使用仓库标准 `pnpm bootstrap` 后恢复；再次运行越过构建，但宿主没有 `xvfb-run`、Docker/Podman，
Chrome WebDriver session 在业务页面和用例断言前退出。因此这里记录为验证环境 blocker，不记录为产品失败，
也不伪装为绿色 replay。四个用例继续留在 `manual-review/pending`，未执行 promotion 或 Docker admission。

### 6.4 回归结果

- `@zcode/provider`：13 个文件、115 个测试通过；typecheck 通过。
- `@zcode/provider-node`：4 个文件、20 个测试通过；typecheck 通过。并发包测试曾令既有 file watcher
  测试额外收到一次 `watch-error`，串行复跑稳定通过，新增完整性测试始终通过。
- Services 定向：5 个文件、30 个测试通过。
- 真实 Built-in Bootstrap 集成：1 个文件、3 个测试通过。
- 根 `pnpm typecheck`、`pnpm lint`、Desktop E2E typecheck 均通过；lint 保留仓库既有 warning、零 error。
- 根 `pnpm test:unit`：1467 个文件通过、1 个跳过；12418 个测试通过、25 个跳过。

剩余门禁只有四个 pending E2E 的人工 review、正式 replay 与 Docker admission。它们需要具备图形/Docker
运行条件后继续，不需要也不允许通过改造 Provider 生产代码来绕过。
