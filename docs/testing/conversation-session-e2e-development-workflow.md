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

默认 Desktop 全量入口按任意层级的 `manual-review` 目录统一排除候选，不能只枚举已知领域，
否则新增 bots/settings/feedback 目录会被单进程全量误收。显式 spec 或 manual-review 模式仍可
运行候选；默认单进程与分片的正式集合必须一致，不把缺少 capture 环境的候选记为正式回归失败。

## 共享初始化合同

### 正式回放契约维护（2026-10-15）

TUI 的输入与 Enter 分开执行：使用终端粘贴协议并等待本次输入内容绘制，不能把动画产生的新帧当成输入已完成。命令完成等待其明确回执；终端增量绘制可能只输出占位文字的变化后缀，不要求完整占位文字重复出现。

Provider 允许合并相邻 system 消息；incoming reminder 在 wire 中校验全文、角色和唯一性，不要求独占 system text block。user 的 system-reminder 包装仍要求完整独立 block 和成对标签。

项目新建 helper 仅等待主 pane 的唯一空草稿；辅助对话的输入框可以共存，不计入主 pane 的切换判定。

营销触达属于全局应用界面，隔离 fixture 预置已完成职业引导的账号，防止启动弹窗抢占引导焦点；冷启动后等待应用设置入口就绪，不要求激活固定项目。窗口恢复到未选项目草稿时，固定 cwd 的等待会错误终止 beforeEach，令整份营销用例无法继续。

- Coding Plan 数据面代理按当前 worker 的 spec 启动，位于上游回放网络配置之后、HOME 播种之前。混合批次包含 ToolSearch 时，只让 ToolSearch worker 使用自己的 capture proxy，不能关闭其他 worker 的账号模型回放。

- 团队 Provider 共用 Provider ID，模型菜单项按完整团队连接身份分组；专项 helper 由夹具传入连接 key，不能仍用 `registry-provider:<id>` 定位团队行。空白 Composer 不保存未提交改选；跨任务或重启验证未提交选择时，保留非空文字草稿。

- Plugin mention 图标改由 CSS 装饰变量渲染后，读取 `--mention-image` 的实际 URL；不再查找已移除的子 `img`。商店试用会创建独立草稿，后续固定 cwd 用例须重新准备夹具项目。

- 测试应用产物必须独立于共享 `out`：使用写时复制（文件系统不支持时正常复制），不能硬链接。源构建被 `tsc -b` 原地覆盖或单个隔离副本被测试写入时，其他回放副本必须保持不变。类型检查后须重新执行 E2E 构建，不能复用被 TypeScript emit 覆盖的 Host 入口。

I68 专项必须显式提供四档 reasoning Option Spec 及请求协议映射；不再依赖退役的 Agent catalog 补全。模型编辑器的继承测试需移除通用 replay 的 `disabled` 精确覆盖，保留当前推荐配置，并在每次重新打开时显式展开高级区。

推理 Option Spec 的 `values` 按低到高排列，末项是主动切换模型时的默认最高档；I20 夹具显式提供其断言的 `off/low/high/max`，不能沿用旧的默认值置首规则。官方插件只读 profile 的覆盖测试使用当前 `documents:visual-judge`，不再查找已退役的 `document-skills:judge`。

Subagent 保存后先关闭表单，再异步刷新列表。再次编辑须等行恢复 `role="button"`，不能只等行存在就点击仍在刷新、未绑定编辑事件的行。

正式设置用例以稳定身份匹配入口：I23/I24 从 BigModel Template 新建 Personal Provider，并按新实例 ID 核对 API Key 与模型水合，不查询已退役的 Family API Key 连接项。Subagent 作用域按 `data-plugin-scope-key` 选择 `user` 或目标 workspace key；显示名包含设备信息，不能用裸项目名判断身份。MCP 正式用例复用 V4 初始化，保留真实 Agent 协商和 wire 断言。

后台任务的 telemetry 采集按 case 重置 HTTP mock 与 ARMS 缓冲；不能复用跨 case 游标，否则未做 telemetry 断言的中间用例也会计入下一条的精确数量断言。

后台任务行的可见性使用浏览器原生 `checkVisibility`。V4 的 `display: contents` 祖先没有自己的布局盒，但不会隐藏子节点；不能逐层要求祖先拥有非零矩形，否则会把可见的 running/stop 控件误判为消失。

正式用例的准备数据必须满足当前产品契约，不能用降低断言、跳过用例或修改业务逻辑消除失败：

- 固定目录的文件、Hook 和冷恢复场景，通过项目的新建任务入口保持 cwd；全局新建任务仍验证独立目录，不把两种入口混用。
- 模型偏好必须声明在 fixture 的 `reasoningLevel.values` 中；验证请求思考参数的专项同时提供非空 Option Map，普通回放保持空映射。
- `/plan` 是 `app-slash:plan` 本地动作；正式 session 身份只要求非空且非 draft，不依赖 `sess_` 前缀。
- Markdown 选区通过结构化引用进入请求，验证 `<conversation_quote>` 中的来源路径和正文以及历史引用，不再要求旧 `# userselect` 包装。
- Bot 集成夹具使用项目仓库的 session 创建预留合同；ToolSearch 在真实请求事件到达时采集完整正文，并继续归档 Adapter 的原始 Model IO，不能把事后精简的内存事件统计当成消息正文。
- 设置页配置 Provider 时先让输入框失焦并核对连接字段落盘，再操作 API 格式菜单。格式是否已选中以菜单的 `data-state=checked` 为准；Personal overlay 缺省可能继承 Template 的协议格式，不能用旧 snapshot 默认值跳过切换。
- Fork 后 session 身份先切换，模型能力投影随后到达；先等目标能力集合就绪，再断言档位和真实请求，不能把切换瞬间的空集合当作最终能力。
- 批次失败、单场景通过时，先检查准备、清理和导航 owner 的稳定边界，不增加固定等待时间。权限等真实产品异常保留原断言并列为阻塞。

```text
case 的目录与模型要求 → 项目入口 / Provider fixture → 当前草稿就绪
                                                   ↓
                               真实用户操作 → wire / 持久化 / UI 断言
```

默认 `env` 回放 Provider 的准备步骤选择 `high`，其 Personal Config 必须同时声明
`high` / `max` 思考档位；Composer 工具栏专项在其他预设下也必须声明这两个档位。
不能只播种 `disabled` 后让工具栏选择不存在的选项；普通回放仍使用空参数映射，
不向请求额外注入真实模型的思考参数。

Coding Plan mock 必须在 launcher 的 `onPrepare` 阶段启动，再通过 `runnerEnv` 向 worker
传递地址。除具体 spec 名称外，选择器也识别两个已支持的批次入口：
`test/e2e/**/*.test.ts` 和 `test/e2e/conversation-session/*.test.ts`；比较前统一路径
分隔符和可选的 `./` 前缀。正式 CI 的目录通配符尚未展开，不能仅依赖其中出现工具名。
worker 仍按具体 spec 使用或清理 mock 环境，无关 spec 不因本次修复启用 mock。

```text
launcher 收到批次 glob → onPrepare 启动 mock → runnerEnv 传递地址
                                                ↓
worker 收到具体 spec → 按需使用 / 清理 mock 环境 → 执行用例
```

入口回归必须使用正式目录 glob，并通过 exclude 缩小用例范围；仅跑功能名称 glob
不能证明 CI 的初始化路径。此合同只涉及 E2E 启动层，不修改生产实现。

`automations-create-manage` 的项目操作使用当前 `automation-project-select` 和
`role=option`。按 [虚拟项目规格 B18](../superpowers/specs/2026-09-09-virtual-project-design.md)，
候选来自本地虚拟项目，不再使用会话草稿菜单；隔离 fixture 只应列出 `ZCodeProject`。
保留创建、编辑、暂停、恢复与删除断言，不把旧「不在项目中工作」入口作为当前表单前置条件。

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

固定文件夹具的准备还必须确认导航 owner 的 cwd 为 `ZCodeProject` 主要目录，并先于 Provider
初始化完成。该目录上的初始空草稿即使没有项目标签也可复用；不能为补标签重复新建，触发预热
owner 换代。全局新建按虚拟项目规格 D3 创建独立目录，不能用它初始化固定目录夹具；已有会话、
其他 cwd 或非空草稿应通过现有项目行的新建入口返回夹具目录。`skipShellReady` 保留调用方
自备工作区的语义，不强制选择本地夹具。显式 `startNewV4Draft` 仍点击全局新建入口。

工具用例的完全访问准备复用 `switchV4Mode("yolo")`，从当前 V4 composer 的 `data-mode`
确认命令回流；不得查询旧 Select option 或聚合其他 workspace 的配置来判断当前权限。

窗口尺寸准备复用 `setCurrentElectronRendererContentSize`，按当前 WebDriver URL 选择窗口，
设置内容区尺寸并按实际 zoom factor 校验 renderer viewport。不得用外框尺寸减固定误差估算内容区。
后台输出与后台任务响应式用例采用 800px 内容高度，保持原有宽窄断点及滚动断言；
不依赖宿主显示器能容纳 900/1000px 高窗口。

```text
workspace shell ready -> inspect fixture project draft
                              | empty and idle -> reuse
                              | otherwise -> project New Task
                              v
                         provider setup
                              v
                         recheck draft -> select model and thought level
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

| 分类        | 含义                                                                     | 处理                                              |
| ----------- | ------------------------------------------------------------------------ | ------------------------------------------------- |
| `main`      | case 核心断言依赖的请求，例如 edit rerun、compact summary、goal verifier | 放入 case-local fixture                           |
| `common`    | 多个 case 稳定需要的辅助请求，例如标题生成                               | 放入 common fixture                               |
| `ignore`    | capture 中出现但不属于测试合同的请求                                     | 不进入 case-local fixture，必要时在 manifest 说明 |
| `synthetic` | 真实 capture 不稳定或不能构造的时序/故障，例如慢流、断流、429            | 放入 case-local fixture，并写 `syntheticReason`   |

工具可以基于 marker、path、prompt 内容和请求顺序自动建议分类，但产品语义由开发者 review。

## SSE Timing

不同 case 使用不同回放策略，避免所有测试都被慢流拖慢，也避免性能 case 被一次性 body 回放冲掉价值。

| 策略                | 适用场景                                                                                        |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `fast-text`         | 普通功能断言，快速返回即可                                                                      |
| `controlled-stream` | stop、queue、interrupted 等需要稳定 streaming 窗口的 case                                       |
| `recorded-stream`   | 性能、Markdown 渲染、流式节奏相关 case，需要保留真实 `responseEvents` / `responseChunkTimeline` |
| `fault-stream`      | 断流、半包、socket destroy 等故障注入                                                           |

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

### 正式用例当前界面与构建约束

- I68 主输入框使用合并模型菜单及思考滑杆；Subagent 设置继续使用独立档位控件。两处均校验实际档位集合与请求参数。
- CTP-02B 在头像菜单内验证 Team 标签；设置页批次在每条准备前关闭上一条遗留的设置层。
- MP-UI-06 遵循 Todo141：默认显示 ID、上下文和最大输出，高级配置默认折叠，经点击展开后验证能力勾选框、推理编辑和保存。
- I24 的模型控件使用共享 custom: 编解码；不把协议 provider/model 值当成界面值，也不通过手动选模绕过自动水合断言。
- CLH-02 对目标 Host 的 setting.json 写入全程注入失败，避免默认单次故障被初始化写入消耗。
- 分片共享父构建不包含子进程动态网页 mock origin。配置网页 mock 的 child 必须在分配端口后重建；从构建到复制隔离产物全程持有共享构建锁。普通无 mock 的 child 可复用父构建。

```text
child 分配 mock 端口 → 获得构建锁 → 编译对应 origin → 复制隔离产物 → 释放锁 → 回放
```
