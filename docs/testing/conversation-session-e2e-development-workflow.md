# Conversation Session E2E Development Workflow

本文定义 conversation session 从“覆盖面枚举”到“正式 E2E”的开发流水线。目标是让新增 case 能按固定步骤推进，避免在转正时临时修改共享 replay fixture、反复等待长 E2E 才发现数据不匹配。

## 两条流水线

### 覆盖面生成

覆盖面生成回答“需要测什么”：

1. 从功能 spec、现有 case catalog 和 coverage matrix 中抽出状态维度。
2. 使用 `feature-boundary-planner` skill 和 formal-proof 口径辅助枚举排列组合。
3. 与产品或开发者对话剪枝，确认哪些组合是 accepted、undefined 或 pruned。
4. 产出或更新 `docs/conversation-session-case-catalog.md`、`docs/testing/conversation-session-e2e-coverage-matrix.md` 和相关 decision 文档。

这一层只产出文档和待覆盖 case，不直接生成正式 E2E。

### E2E 落地

E2E 落地回答“怎么稳定测”：

1. 为 accepted case 编写或生成 `manual-review/pending` spec。
2. 运行 manual/capture，自动执行用户路径并留下 UI、network、log、session artifact。
3. 人工 review 产品表现，确认 case 语义。
4. 整理 provider replay fixture 和文件 fixture，形成正式测试合同。
5. 将 spec 移到 `packages/desktop/test/e2e/conversation-session/`。
6. 跑本地 default replay。
7. 需要进入 Docker suite 时，先单 spec 跑 `replay-isolated`，通过后再登记进 Docker preset。
8. 常规 Docker 回归按 suite 批量运行，复用同一个镜像、容器和 WDIO 构建入口。
9. MR 与 GitLab Web pipeline 通过手动 optional job 跑正式目录下的 default replay：共享 macOS 与专用 macOS runner job 都是单实例执行，只有 Windows job 使用四个 GitLab/WDIO 原生 shard。三条入口都复用 `ZCODE_E2E_SPEC=./test/e2e/conversation-session/*.test.ts` 等 direct-root glob；这些 glob 是非递归的，只收已经转正到正式目录的 spec，不收 `manual-review/pending`。
10. Docker CI 只收已经自动化稳定的 suite。

## 共享初始化合同

正式目录下的 spec 使用 `prepareV4ConversationE2E` 把测试带到“可发送的空草稿”；`manual-review/pending` 迁移期候选仍可使用 `prepareConversationE2E`。已转正 spec 不得导入 legacy `helpers/conversation-session.js`：V4 pane/composer/timeline 操作来自 `v4-conversation.ts`，tool block 断言来自 `conversation-session-tool.ts`，provider request 断言来自 `conversation-session-network.ts`。这条边界只收敛 formal 证据实现，不改变 catalog 的产品状态组合。

formal promotion 合并前还必须同时满足两条机械合同：spec 的 composer、message、queue、运行态与 task
切换操作只能读取 V4 helper / 已拆分的专项 helper；case manifest 的 `requests` 必须按 case-local
provider fixture 的数组顺序逐项镜像 `id` 与完整 `metadata`。fixture 调整了 matcher 顺序、
`kind`、`timingPolicy` 或 `syntheticReason` 时，manifest 必须在同一提交同步，不能让两份 replay
合同分别漂移。`pnpm audit:conversation-session-coverage` 是最终准入门禁，不能通过放宽 formal
admission 规则让 legacy helper 或 ledger mismatch 进入 direct-root suite。

`prepareV4ConversationE2E` 只负责把测试带到“可发送的空草稿”，必须保持幂等，不能把初始化本身
当作一次“新建任务”产品操作。workspace 冷启动或重新激活后如果已经满足
`activeTaskId=null`、V4 pane `data-session-id="draft"`、idle 且
composer 可见，provider 配置完成后直接复用该草稿；只有当前仍绑定已有 session、处于非 draft
页面或 composer 不存在时，才点击新建任务。

```text
workspace shell ready -> provider setup -> inspect draft
                                         | ready
                                         v
                                  reuse current draft
                                         |
                                         | active session / missing composer
                                         v
                                  click New Task -> wait draft ready
```

`startNewTask` 仍表示测试步骤中的显式用户动作，必须真实点击新建入口并等待同一组 draft 条件，不能
被幂等初始化替代。共享 helper 对 composer、发送/停止控件、消息和运行态采用 V4 test id / pane /
renderer store 优先，legacy ChatView 仅作为兼容回退。初始化或显式新建失败时，helper 应在报错中
携带 pane/store 状态、composer 是否存在以及当前可见 test id，避免 before hook 只留下“元素未显示”
的无上下文超时。V4 pane 为 draft 时，helper 必须从当前窗口导航 TabStore 取得
`workspaceKey = activeWorkspaceIdentity?.trim() || activeWorkspacePath` 并精确读取该 bucket，禁止用
`activeTaskId=null` 在多个 draft workspace 之间猜测；pane 已绑定 task 时，Goal metadata 与
`stopRequested` 必须复用 task store snapshot 的 optimistic/cache 读取语义，不能伪造为空值。
该合同不新增 case 状态组合，沿用 catalog 的 TSL08 workspace draft、H Goal 状态和 I11 new-task
action 三个已确认边界。

## 数据合同

capture artifact 是证据，不是最终测试合同。正式 E2E 使用 case-local fixture 表达稳定合同。

推荐目录：

```text
packages/desktop/test/e2e/fixtures/upstream/common.json
packages/desktop/test/e2e/fixtures/upstream/conversation-session/<case-name>.json
packages/desktop/test/e2e/fixtures/fs/conversation-session/<case-name>/
packages/desktop/test/e2e/fixtures/cases/conversation-session/<case-name>.json
```

- `upstream/common.json`：真正跨 case 复用的辅助响应，例如标题生成。
- `upstream/conversation-session/<case-name>.json`：某个 spec 自己的 provider replay 数据。
- `fixtures/fs/...`：该 case 需要的真实文件系统输入。
- `fixtures/cases/...`：case manifest，记录 spec、provider fixture、文件 fixture、请求来源和时序策略。

### 跨平台运行时路径合同

`.e2e-home` 是 Desktop E2E 的隔离用户目录，不应把 case 文件散落到系统 `/tmp`。spec 在运行时创建、读取、修改或等待的文件统一放到 Agent 实际执行 workspace `ZCodeProject` 下的 `.zcode-e2e/<case>`：

```text
.e2e-home/ZCodeProject/               Agent workspace cwd
└── .zcode-e2e/<case>/                case-owned runtime files
```

- Node 文件操作使用共享 helper 生成的原生绝对路径。
- provider fixture 的 Read/Write/Edit/Glob/Grep 等绝对路径使用 `{{e2eRuntimeRoot}}/<case>/...`；replay server 在请求匹配前展开变量。
- Bash command 使用 `.zcode-e2e/<case>/...` workspace-relative POSIX 路径，禁止依赖 `/tmp`、Windows drive 到 Git Bash mount 的隐式转换或用户 TEMP 目录。
- case manifest 的 `fileFixtures[].path` 使用 workspace-relative 路径。

```text
spec native path ─────────────┐
fixture absolute tool path ───┼─> ZCodeProject/.zcode-e2e/<case>/file
Bash relative path ───────────┘
```

该合同保证 macOS、Linux 和 Windows Git Bash 下的 Node/spec、工具执行与 shell barrier 指向同一文件。新增或修改 conversation E2E 时，fixture contract check 之外还必须通过裸 `/tmp` 审计。

case manifest 与 case-local provider fixture 中的 `spec` 统一表示 **canonical formal target**，始终写成
`./test/e2e/conversation-session/<case>.test.ts`。它不是 pending 阶段当前文件的物理路径；当前路径由
coverage matrix 和传给命令的 `--spec` 表达。这样 fixture 合同从 pending 到 formal 保持稳定，promotion
只移动 spec，不需要重写或覆盖已经人工整理好的 fixture 内容。

```text
manual-review/pending/<case>.test.ts   当前待审文件
                 │ fixture check 读取当前文件与 canonical fixture 合同
                 ▼
fixture JSON: spec=conversation-session/<case>.test.ts
                 │ human review + promotion
                 ▼
conversation-session/<case>.test.ts   canonical formal target 成为当前文件
```

只验证输入框、菜单、键盘选择等 renderer 交互且不会发送 prompt 的纯 UI case，可以在 manifest 中显式写入 `noProviderRequests: true` 并保持 `requests: []`；此时 case-local provider fixture 允许为空，用来表达“没有 provider 合同”，而不是漏填 fixture。

迁移期仍允许加载 legacy `provider-basic.json` / `provider-conversation-tool-cross-product.json`，但新增 case 不应继续往 legacy 共享池追加专用响应。

纯 composer、native picker 或其他不触发 provider 请求的正式 case，可以保留空的 case-local provider fixture，但必须在 manifest 中显式声明 `"providerRequestPolicy": "none"`，并保持 `"requests": []`。这类 case 仍需要跑 `e2e:fixture:check` 和本地 replay；声明只表示该 spec 的稳定合同是“不产生模型请求”，不是跳过正式验证。

## 请求分类

录制时可以全量 capture；转成 fixture 时只把必要请求纳入合同。

| 分类 | 含义 | 处理 |
| --- | --- | --- |
| `main` | case 核心断言依赖的请求，例如 edit rerun、compact summary、goal verifier | 放入 case-local fixture |
| `common` | 多个 case 稳定需要的辅助请求，例如标题生成 | 放入 common fixture |
| `ignore` | capture 中出现但不属于测试合同的请求 | 不进入 case-local fixture，必要时在 manifest 说明 |
| `synthetic` | 真实 capture 不稳定或不能构造的时序/故障，例如慢流、断流、429 | 放入 case-local fixture，并写 `syntheticReason` |

工具可以基于 marker、path、prompt 内容和请求顺序自动建议分类，但产品语义由开发者 review。

## SSE Timing

不同 case 使用不同回放策略，避免所有测试都被慢流拖慢，也避免性能 case 被一次性 body 回放冲掉价值。

| 策略 | 适用场景 |
| --- | --- |
| `fast-text` | 普通功能断言，快速返回即可 |
| `controlled-stream` | stop、queue、interrupted 等需要稳定 streaming 窗口的 case |
| `recorded-stream` | 性能、Markdown 渲染、流式节奏相关 case，需要保留真实 `responseEvents` / `responseChunkTimeline` |
| `fault-stream` | 断流、半包、socket destroy 等故障注入 |

synthetic 的 controlled/fault stream 必须说明原因。典型例子：真实模型太快，无法稳定覆盖 stop window。

Replay capture artifact 属于请求生命周期：请求开始的 `pending`、正常响应终态以及
fixture variable 缺失等 fail-closed 终态都必须等待对应 artifact 写入后，handler 才能返回。
原子替换重试最终失败时，拒绝必须进入 replay server 的统一 handler catch；即使 500 响应已经
结束，也不能把诊断落盘 Promise 留成 fire-and-forget 的未处理拒绝。该错误路径使用可注入的
artifact writer 做 focused test，避免依赖 Windows 文件锁竞争时序。
Replay server 的启动也遵守同一生命周期：`listen` 成功后的首次 artifact 写入若失败，
启动流程必须先等待 HTTP listener 关闭和当前 artifact 写队列收口，再重新抛出原始写入错误；
不得让失败的 fixture 初始化遗留端口或后台 server。

## 转正准入

一个 case 从 `manual-review/pending` 进入正式路径前，至少满足：

1. 对应 catalog/matrix 已经是 accepted 语义。
2. manual/capture artifact 已被 review，或 synthetic 原因已在 manifest 说明。
3. case-local provider fixture 和文件 fixture 已准备好。
4. `e2e:fixture:check` 通过。
5. 本地 default replay 通过。
6. 文档路径从 pending 更新到正式 spec。

pending case 已有 case-local fixture 时，可以在转正前直接检查合同；检查器读取 pending spec 中的 marker，
同时要求两个 fixture JSON 的 `spec` 指向 canonical formal target：

```bash
pnpm --filter @zcode/desktop e2e:fixture:check -- \
  --spec ./test/e2e/conversation-session/manual-review/pending/<case>.test.ts
```

pending manual-review 会按 case 是否已有 case-local fixture 自动隔离模式：已有 fixture 时使用 replay，
缺 fixture 时使用 live/capture。需要临时覆盖 fixture 集合时仍可显式传入 fixture 路径；该变量同时把
provider transport 切到 replay，但仍保留 `ZCODE_E2E_MANUAL_REVIEW=1` 的 pending spec 运行边界，
避免把回放证据误当成真实 provider capture：

```bash
E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/<case>.json \
  pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec \
  './test/e2e/conversation-session/manual-review/pending/<case>.test.ts'
```

如果 case 的产品语义就是不触发 provider 请求，manifest 必须使用
`providerRequestPolicy: "none"` 明确这一点；否则空的 case-local fixture 不能转正。

进入 Docker preset 前还需要：

1. Docker `replay-isolated` 通过。
2. artifact 路径写入运行记录或 PR 描述。
3. `manual-review/pending` 下的 spec 不直接加入 Docker preset。
4. 使用 `e2e:docker:admit` 同步 Docker preset 和准入文档。

## Skill 入口

这份文档是 conversation session 领域的落地实例；通用流程由两个 skill 承接：

- `.agents/skills/feature-boundary-planner`：从功能变动、matrix、formal-proof 和剪枝对话产出需要覆盖的 case 文档。
- `.agents/skills/e2e-case-lifecycle`：从 manual-review spec、capture/replay fixture、promotion、Docker admission 到 CI 的稳定化流程。

## 工具化流程

review 已确认的 pending case 使用 promotion 工具做机械转正：

```bash
pnpm --filter @zcode/desktop e2e:promote -- --spec ./test/e2e/conversation-session/manual-review/pending/<case>.test.ts --reviewed --apply
```

promotion 工具只做确定性脚手架：

1. 将 spec 从 `manual-review/pending` 移到正式 `conversation-session/` 目录。
2. 修正常见 helper 相对 import。
3. 不存在时生成 case-local provider fixture 空壳和 case manifest 空壳；已有 fixture 保持内容不变，其
   `spec` 必须已经是 canonical formal target。
4. 将 coverage matrix 中该 spec 的 pending 路径更新为正式路径。
5. 在同一文件事务内运行 `pnpm audit:conversation-session-coverage`；只有 audit 通过才保留转正结果。
6. audit 失败或执行异常时恢复 spec、fixture、manifest 与 coverage matrix 的转正前快照，退出码为 1，
   禁止留下 formal admission 半状态。
7. 输出后续运行 fixture check、case-local replay、default replay 与 Docker admission 的命令。

promotion 工具不自动决定产品语义，也不把 capture artifact 直接当合同。由于 `--apply` 会在转正事务内执行
formal audit，开发者必须在 pending 阶段根据人工 review 和请求分类先填好 `fixtures` / `requests`，并让
manifest 与 provider fixture 的 `spec` 都指向 canonical formal target；audit 未通过时不会完成转正。转正后再运行：

```bash
pnpm --filter @zcode/desktop e2e:fixture:check -- --spec ./test/e2e/conversation-session/<case>.test.ts

E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/conversation-session/<case>.json \
  pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/<case>.test.ts'

pnpm --filter @zcode/desktop exec wdio run wdio.conf.ts --spec './test/e2e/conversation-session/<case>.test.ts'
```

第一条 replay 命令显式只加载 common + case-local fixture，用来证明正式 case 不依赖 legacy `provider-basic.json` 的专用兜底。

进入 Docker suite 前，先跑单 spec 的断网容器证明：

```bash
E2E_SPEC=./test/e2e/conversation-session/<case>.test.ts \
  pnpm run test:e2e:container
```

通过后再登记进 `conversation-session-verified`：

```bash
pnpm --filter @zcode/desktop e2e:docker:admit -- \
  --spec ./test/e2e/conversation-session/<case>.test.ts \
  --verified \
  --artifact packages/desktop/.e2e-artifacts/<run-id> \
  --apply

pnpm run test:e2e:container:conversation
```

`e2e:docker:admit` 只做机械登记：更新 `scripts/test-desktop-e2e-container.sh` 里的
`conversation-session-verified` preset，并同步
`docs/testing/conversation-session-docker-automation-plan.md`。它不会替代单 spec 的
Docker 证明，也不会允许 `manual-review/pending` spec 直接进 suite。

进入 suite 后，常规回归不再按 case 单独 build/run Docker。`conversation-session-verified`
会把多条 spec 传入同一次 WDIO 运行，复用 Docker 镜像、容器启动、desktop app 构建和
agent server 构建成本。单 spec Docker 运行保留给准入证明和失败定位；真实 capture、
fault-stream、性能/时序敏感、会污染全局配置或依赖特殊网络/文件系统状态的 case，再拆到
独立 preset 或独立容器运行。

## 当前 MVP

第一阶段只做 E2E 落地流水线的基础设施：

1. WDIO 支持自动加载 case-local provider fixture。
2. `conversation-session-edit` 作为样板迁出 legacy 专用 fixture。
3. `conversation-session-running-actions` 作为第二个样板，覆盖通用只读 tool call、case-local final response 和 controlled slow stream 的组合。
4. 提供 `e2e:fixture:check` 秒级检查命令，检查 JSON shape、manifest、fixture id 和 spec marker 覆盖。
5. 提供 `e2e:promote` 转正脚手架，减少移动 spec、修 import、建 manifest 的重复操作。
6. 提供 `e2e:docker:admit` Docker 准入脚手架，减少维护 preset 和准入文档的重复操作。

后续再补 capture-to-fixture，把 capture artifact 自动转换成待 review 的 main/common/ignore/synthetic 草稿。
