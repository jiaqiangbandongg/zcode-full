# Todo 57：Provider E2E 实跑与回归收口

> 当前状态（2026-09-09）：本验证 Todo 已关闭，剩余事项由 [Todo102](todo-102-verification-debt-closeout.md) 唯一承接，不再独立排期。下文状态及失败为历史记录，关闭不表示原失败已通过。

> 状态：已实施；45 条 macOS Provider E2E 已通过，仅 1 条真实 SSH Remote Environment Case 因缺少凭据未跑
>
> 日期：2026-09-01
>
> 输入：Todo 52 已迁移的 Provider E2E、Todo 55 的 Provider Template 最终语义、2026-08-31 回归分析、Todo 56 新增的 Remote Environment Provisioning 行为。

## 0. 目标

Todo 52 已完成测试代码、Fixture 和当前产品语义的迁移，但当时完成的主要证据是 E2E typecheck、fixture 校验、单测、lint 和全仓 typecheck，并不等于 37 条受影响 Desktop E2E 已经全部通过真实 WDIO 执行。

本 Todo 在 Todo 56 的生产语义稳定后，实际启动 Desktop/Electron，逐组复现、修复并运行 Provider 相关 E2E，直到能够给出 Case 级执行证据。

```text
Todo 56 生产基线稳定
        |
        v
E2E 前置校验
        |
        v
单 Case WDIO 实跑
        |
        v
按共性根因批量修复
        |
        v
Provider 回归组实跑
        |
        v
容器/整组验证与报告
```

## 1. 验证口径

必须明确区分：

| 证据                           | 能证明什么                                            | 是否等于 E2E 通过 |
| ------------------------------ | ----------------------------------------------------- | ----------------- |
| `typecheck:e2e`                | E2E TypeScript 可编译                                 | 否                |
| fixture check / coverage audit | Fixture、manifest、覆盖矩阵结构正确                   | 否                |
| 单元测试                       | helper/服务局部行为正确                               | 否                |
| WDIO 单 spec                   | Electron 中该 Case 的 setup/action/assertion 实际完成 | 是，该 Case       |
| Docker 单 spec                 | 标准隔离环境中该 Case 通过                            | 是，该环境        |
| Provider/Conversation preset   | 已纳入套件的 Case 批量通过                            | 是，该套件        |

最终报告不得再使用“相关检查通过”代替“E2E 已运行并通过”。未运行、环境阻塞、产品失败和过时 Case 必须分别列出。

## 2. 当前产品边界

- Z.ai / BigModel Provider Family 和结构化 Connection Selection 当前继续保留；不得再次删除对应正式 E2E；
- 旧 `mode/selectedKey` 未发布兼容 Case 继续删除，不恢复兼容迁移；
- Todo 55 已经是本 Todo 的生产基线：普通第三方 Provider 从 Template 创建 Personal 实例，Z.ai/BigModel 按量 API 不再是 Family Connection Selection；
- Account 场景由正式 Account API/Credential mock 驱动，不伪装成 Personal API-key Provider；
- Personal Provider 场景写正式 Personal Overlay；
- Model Selection 使用完整 `{ providerId, modelId, options }`；
- Personal Config 热更新允许生产轮询时间差，统一等待 2 秒；只有 CI 实证仍不足时才在同一 helper 提高到 3 秒；
- 不恢复已删除的 Registry revision push、旧 Provider mode、旧双 reasoning map 或具体模型 hardcode。

## 3. 共性测试基础设施

继续以 Todo 52 的公共边界为准，不新增另一套 Effective Registry fixture：

- `seedPersonalProviderConfig(...)` / 现有等价 helper：只写 Personal Provider/Overlay；
- 正式 Coding Plan mock + Credential Store：准备账号、套餐、quota、activity、opportunity 等上游事实；
- 原子 persisted Model Selection helper：只用于冷启动/重启 Case；
- `waitForSelectableModel(...)`：从正式 Selection View 等待模型可选择；
- `waitForProviderConfigPolling()`：只处理 Personal Config 热更新的 2 秒容忍；
- Bot 最小非空 Selection fixture：只解除 Bot 执行前置，不代替卡片/terminal 断言；
- Provider Family Selection fixture：只写当前结构化 selection，不写旧 mode/selectedKey。

Todo 56 另补 Remote Provisioning E2E helper 时，必须从真实连接生命周期触发，不直接调用 Target Store 伪装用户链路。

## 4. 执行分组

### 4.1 第一组：Smoke 与基础设施

先选择最小且诊断价值最高的 Case，证明 MacBook Pro 标准工作目录能真正启动 Electron、连接 mock provider 并完成断言：

1. 一个 Personal Provider 新增并首发 Case；
2. 一个 Coding Plan Settings Case；
3. 一个冷启动 Model Selection 恢复 Case；
4. 一个 Bot Selection/Card Case。

若 Smoke 无法启动，先修 E2E harness、构建产物或测试环境；不得因此修改 Provider 生产语义。

### 4.2 第二组：Todo 52 的 37 条回归

按共性而非文件顺序执行：

1. Bot 4 条；
2. CTP/QR 与 Upgrade WebView；
3. CW/OTB/Personal Provider 热更新；
4. Restart/Family Connection Selection；
5. Turbo/reasoning；
6. Subagent structured selection。

Todo 55 还必须补齐并实跑以下最终语义代表：

- 同一 Template 创建多个 Provider 实例，Personal Overlay 与真实请求身份互不污染；
- Z.ai/BigModel 按量 API 通过普通 Template 创建，不进入 Account Family Connection Selection；
- Welcome API Key 每次创建新的 Personal Provider 实例，不复用固定 Provider ID；
- Template 默认值、Personal 修改与全部恢复默认使用同一 Resolver 基线；
- Provider 顶层 `enabled`、`standard-builtin` 与普通 Built-in 复活入口在 UI、协议和持久化中归零。

每组处理规则：

- 先用原始 spec 复现并保存完整失败日志/截图；
- 判断是生产 Bug、Fixture 漂移、过时断言还是环境问题；
- 生产 Bug：先增加能固定根因的测试，再最小修复生产代码；
- Fixture 漂移：只改 setup，不弱化原 action/assertion；
- 过时行为：只有已有明确裁决时才能删除或改写 Case，并同步 catalog/matrix；
- 需要改变 Provider/Account/Selection 产品语义时停止实施并请求裁决。

### 4.3 第三组：Todo 56 Remote Provisioning

新增或晋升最小但完整的 Remote Environment 行为证明：

- 同一 Environment 打开第二个 Workspace 不发生第二次首次同步；
- 本地 Personal Config save 后，远端后续新建 Model 使用新配置；
- Configured Default/Account/Credential 变化触发同步；
- 本地清空 Personal Config 或删除 allowlist credential 能传播；
- 同步中连续保存最终以最新快照收敛；
- Provisioning 失败不阻断 Remote Workspace；
- 不影响远程 Workspace 的 `workspaceIdentity` 路由和手机 replayable 边界。

新 Case 先写入对应 case catalog/coverage matrix。需要人工体验确认的交互先放 `manual-review/pending`，未确认前不得伪装为正式覆盖。

## 5. 实跑流程

### 5.1 每个 Case

```bash
pnpm --filter @zcode/desktop typecheck:e2e

pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts \
  --spec './test/e2e/<path>/<case>.test.ts'
```

Conversation replay Case 还必须：

1. 运行 `e2e:fixture:check`；
2. 使用 `common.json + case-local fixture` 实跑，证明不依赖 legacy shared fixture；
3. 再运行默认 replay；
4. 需要进入容器套件的 Case 做单 Case Docker admission proof。

### 5.2 批量回归

按风险递增：

1. Provider/Account/Selection/Provisioning 定向单测；
2. `pnpm --filter @zcode/desktop typecheck:e2e`；
3. 四类 Smoke WDIO；
4. 上述六组 Provider WDIO；
5. Remote Provisioning 正式 Case；
6. `pnpm typecheck`；
7. `pnpm lint`；
8. `pnpm test:unit`；
9. `pnpm test:e2e:container:conversation` 或当前实际收录 Provider Case 的对应 preset。

在 MacBook Pro 上统一从标准仓库目录构建和运行，不从 worktree 的半成品 build、旧 Electron 进程或另一份 clone 混用产物。临时日志和 artifact 使用测试框架既有目录，不建立第二套永久环境配置。

## 6. 修复纪律

- E2E 不直接写 Effective Provider Config、Registry Snapshot 或 executable 标记；
- 不通过延长任意 sleep 掩盖未知竞态；Personal Config 轮询只使用统一 2 秒 helper，必要时统一提高到 3 秒；
- 不把账号 Provider 变成 Personal API-key Provider；
- 不为测试恢复未发布的旧迁移；
- 不以 `providerId`/`modelId` hardcode 推断运行时能力；
- 不弱化 terminal、interaction card、请求路由、恢复身份、reasoning、quota 等原始业务断言；
- 修生产 Bug 时保留中文根因注释和对应回归测试；
- 每组完成后 review diff，确认没有顺手改造无关 CI/workspace 基线。

## 7. 结果记录

在本 Todo 中追加执行矩阵，每个 Case 至少记录：

| Case | 环境 | 首次结果 | 根因分类 | 修改 | 最终命令 | 最终结果 | artifact |
| ---- | ---- | -------- | -------- | ---- | -------- | -------- | -------- |

状态只允许：

- `passed`：实际 WDIO/Docker 执行通过；
- `failed-product`：确认生产行为错误；
- `failed-fixture`：测试输入/断言漂移；
- `blocked-environment`：环境无法启动或依赖缺失；
- `not-run`：尚未执行；
- `deleted-by-decision`：已有明确产品裁决删除。

## 8. 完成门禁

- Todo 52 保留的 Provider E2E 均有实际 WDIO 结果，不再只有静态前置校验；
- Todo 56 的 Environment 级同步至少有一个正式远程生命周期 E2E，其余组合由单元/集成测试覆盖；
- Family 正式行为继续受测，旧 mode/selectedKey 兼容保持归零；
- 所有生产 Bug 有先失败后通过的证据；
- `typecheck:e2e`、根 typecheck、lint、全量 unit 与相关容器 preset 通过；
- 环境 blocker 单独记录，不能将未运行写成通过；
- 更新 case catalog、coverage matrix、Todo 52/56 的实施状态和最终验证矩阵；
- 最后提交 Conventional Commit；若生产修复与纯测试迁移差异较大，可按可审阅边界拆分提交，但不强制为了回退制造额外抽象。

## 9. 2026-09-01 实施结果

本轮没有继续维护旧 Provider Registry fixture，而是修正真实输入和真实运行链：

- Draft Model Selection 现在按“recent 有效选择 → 当前 Account Provider 首个模型 → Host preferred”解析；Account Registry 延迟发布时，Selection View revision 会使没有显式模型意图的预热 Draft 重新水合，避免早到的 DeepSeek 事实被永久冻结；
- Provider Template 的代表 Case 使用两个 DeepSeek Template 实例，验证实例身份隔离、稀疏 Personal Model Rule、恢复默认以及 OpenAI Chat Completions 的真实请求字段；
- OpenAI Chat Completions Fixture 从旧 `max_tokens` 修正为正式 Option Map 产生的 `max_completion_tokens`；Anthropic Fixture 继续使用 `max_tokens`；
- Coding Plan、Upgrade WebView、Subagent、冷恢复、输出预算、Restart、Turbo 和 Bot Case 均保留原业务断言；
- 三条已失去产品对象的 selected-key migration Case 继续按既有裁决删除，不恢复旧 Family mode/selectedKey 兼容；
- SSH-P0-TASK-01 增加正式 Remote Environment 证明：第一个 Workspace 产生 Provisioning 状态记录，同一 SSH Environment 的第二个 Workspace 不再产生第二条首次同步记录。

### 9.1 macOS Electron/WDIO 实跑证据

| 范围                                    |  结果 | Artifact / 状态                                                                                        |
| --------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------ |
| Bot automation / Feishu lifecycle       |   5/5 | `desktop-e2e-20260901-123836-685`                                                                      |
| Coding Plan Team / quota reset          | 18/18 | `desktop-e2e-20260901-134307-916`                                                                      |
| Upgrade WebView refresh                 |   2/2 | `desktop-e2e-20260901-140456-210`                                                                      |
| Built-in Subagent model selection       |   1/1 | `desktop-e2e-20260901-132851-878`                                                                      |
| Context Window cold resume              |   1/1 | `desktop-e2e-20260901-134040-202`                                                                      |
| Model output token budget               |   1/1 | `desktop-e2e-20260901-134123-921`                                                                      |
| Provider settings transition            |   3/3 | `desktop-e2e-20260901-134207-163`                                                                      |
| Provider restart recovery               |   4/4 | `desktop-e2e-20260901-133355-002`                                                                      |
| Turbo recovery                          |   3/3 | `desktop-e2e-20260901-133648-823`                                                                      |
| Turbo switch                            |   3/3 | `desktop-e2e-20260901-133743-135`                                                                      |
| Output-token preflight                  |   1/1 | `desktop-e2e-20260901-134931-393`                                                                      |
| Output-token preflight smoke            |   2/2 | `desktop-e2e-20260901-135009-362`                                                                      |
| Provider Template add/edit/restore/send |   1/1 | `desktop-e2e-20260901-140409-625`                                                                      |
| selected-key migration                  |     — | `deleted-by-decision`                                                                                  |
| SSH Remote Environment Provisioning     |     — | `blocked-environment`：MacBook Pro 未配置 `ZCODE_E2E_SSH_HOST/USERNAME/PASSWORD`，未将静态检查记作通过 |

上述运行都在 MacBook Pro 的独立干净 runtime clone 中使用同一提交和标准 `mise`/WDIO 链路完成，没有复用工作区旧 Electron 产物。

### 9.2 仓库门禁

- Provider/Provisioning/Selection 定向单测：8 个文件、64 条通过；
- 受影响的 9 个 Conversation Fixture 检查全部通过；
- `pnpm --filter @zcode/desktop typecheck:e2e` 通过；
- `pnpm typecheck` 通过；
- `pnpm lint` 通过，仅保留仓库既有 warning；
- `pnpm test:unit`：1501 个 Test Files、12797 条 Tests 通过，1 个文件与 25 条测试按既有配置跳过；
- 修改文件格式检查与 `git diff --check` 通过；
- 全仓 `pnpm fmt:check` 仍被 Electron 文档示例的既有 HTML 语法和 `apps/zcode-cli/tests/gb2312.js` 读取问题阻断；
- Conversation coverage audit 中本轮 OTB manifest/fixture 已恢复一致，剩余失败仅为独立的 Hooks Lifecycle ledger 顺序/文案和三份既有生成文档过期；
- 本机和 MacBook Pro 都没有可用 Docker CLI，因此 Conversation container preset 记为 `blocked-environment`，不记作通过。

### 9.3 Todo 59 后续纠偏

本 Todo 实施时加入的“recent → 当前 Account Provider 首项 → Host preferred”只记录历史执行事实，已经被 Todo 59 取代。当前唯一规则是：有效 Recent 优先；Recent 缺失或失效时直接使用目标 Host 的 `preferredSelection`。Renderer 不再理解 Account Provider 的默认模型优先级，reasoning options 由 Host 统一解析并完整携带。
