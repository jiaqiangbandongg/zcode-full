# 公共架构门禁与 AI Governance

## 目标

架构规则是全仓公共能力，不属于任何单一业务重构。所有代码变更经过同一条链路：

```text
代码变更 → 策略解析 → 依赖图与变更闭包 → 规则检查与 ratchet → 阅读包与报告
```

规则只对 `managed: true` 的模块生效（`managedOnly`）；存量模块保持 unmanaged，不受结构规则约束。对"新代码必须走这套约束"的保证来自 `unmanaged-new-file`：相对比较基线新增、且首次入库晚于 `global.newFilesEnforcedSince` 的源码文件必须落在 managed 模块内，否则阻断；未跟踪文件永远视为新增。生效日期让长期分支不被追溯，也避免各分支往共享 baseline 写存量条目产生冲突。存量违规进入确定性的 baseline；新违规阻断，baseline 只能通过显式命令和 PR 审核更新。

### 指定上游的存量准入

`build:desktop:app` 在 job 级设置 `GIT_DEPTH: "0"`，让 Runner 在架构检查前拉取完整历史。浅克隆会截断祖先链，使已合入的准入提交被误判为未合入。该设置仅作用于此 job，不改变其他 job 的拉取深度；检查器仍严格验证提交祖先关系。

合并包含较新源码、但尚未启用新增文件治理的上游时，策略可在 `global.acceptedUpstreamCommits` 登记上游 `commit`、合并前 `previousHead` 的完整 SHA 和接纳理由 `reason`。两个提交必须在本地存在且已是 HEAD 的祖先；提交前校验也允许 Git 当前 `MERGE_HEAD` 的祖先，使 `--no-commit` 合并可以先验证再提交。分支名、缩写 SHA、缺失对象或不属于当前合并的提交均使检查失败，不自动 fetch 或更新策略。准入只覆盖上游存在、合并前不存在的路径，不把原有文件的修改扩成豁免。

只对 `unmanaged-new-file` 做以下分类：候选文件必须已经跟踪，在指定提交中以同一路径存在，且暂存区与工作区的 Git 内容和文件模式都与该提交一致，才能作为上游存量接纳。改动、重命名、新增、未跟踪文件继续要求 managed 模块。合并冲突后的编辑也属于改动，不以作者、提交信息、路径前缀或日期代替内容核对。

```text
真实 push / CI 变更范围 → 新增文件候选
  → 校验固定上游提交确已合入
  → 同路径、暂存区及工作区均与上游一致：仅免新增模块登记
  → 其余候选：执行新增模块登记规则
完整变更范围 → 原有结构、依赖、环、类型与测试检查
```

接纳不会更换 push/CI 比较基线，不改 changed closure，不向 `.architecture-baseline.json` 写违规，也不豁免 managed 模块中的其他规则；原有生效日期不变。再次合并已登记的固定上游时，过去由某个准入提交引入的路径可与任一已登记上游的原样内容匹配；它仍必须满足暂存区、工作区和模式全部一致。本地后续编辑即使已不是相对 push base 的新路径，也重新要求模块登记。验收覆盖原样合并、重复合并更新、冲突修改、暂存与工作区不一致、重命名、未跟踪文件、后续修改、无效提交以及其他规则仍阻断。

本轮合并后的自有适配按职责收口：项目菜单、拖动预览和项目连接展示归 `project-sidebar`；工作流保存与项目归属绑定归 `project-workflow`；设备连接向导归 `remote-connection-flow`，保留单个 hook 控制器及其闭包，不按行数拆散状态，保留 requestId/entry epoch 与迟到结果丢弃规则。存储启动适配归 Host Worker 和 `project-storage`，子会话事实修复归 `task-facts`，CLI 子代理配置解析归独立纯配置模块。只调整实现边界与导入位置，不改产品流程、迁移 SQL 或 attachment 语义；已有行为用例继续验证这些公开入口。

## 规范来源

- 根目录 `architecture-policy.yaml` 是组织级政策：模块路径、层级、允许边、全局阈值和例外。
- 模块 `module.ts` 是局部依赖声明：`id`、`requires`、`provides` 和公开入口。
- 实际 import graph 从源码生成，不能手工维护。
- feature graph 只描述产品能力和影响面，不承担架构门禁职责。

策略文件和模块声明必须互相校验（规则 `manifest-policy-mismatch`），禁止出现未被策略覆盖的模块或模块声明中的未知依赖。

import 边按 Node 与 TypeScript 的真实解析建立：相对路径、`package.json` 的 `imports`（`#src/*`）、`tsconfig.json` 的 `paths`（`@/*`）、workspace 包名加 `exports`（条件导出与 `dist/` 目标回映到 `src/`）。2026-09 review 发现首版只解析相对路径，跨包依赖全部不建边，module-dependency / deep-import / cycle / layer-direction 对 `@zcode/*` 导入失明；已修复并有回归测试。

配置读取使用 TypeScript 的 JSONC 解析器，支持块注释、行尾注释与尾逗号，并保留字符串中的 glob。
不能用正则删除注释：`@/*`、`#src/*` 与后续 `src/**/*.ts` 或脚本参数 `cache-*/**`
会被误判为注释，导致整个包或路径映射消失。回归要求两种别名都能触发真实的层方向违规。

## 规则

规则引擎检查层级方向、模块依赖声明、公开入口、循环依赖、UI/Domain 的实现边界、模块必需文件、文件和契约大小、公开方法数以及 lint disable。owner 字段随报告输出，状态写入授权需要在具体状态模块完成 manifest 声明后接入同一规则接口。规则编号和修复建议集中维护在 `scripts/architecture`，AGENTS.md 只提供入口。

## 命令与执行

```text
pnpm architecture:check
pnpm architecture:check --changed
pnpm architecture:report
pnpm architecture:baseline:update
pnpm architecture:context <module-id>
pnpm architecture:adopt <module-id> --root <dir> [--layer domain|app|adapters|ui] [--owner <group>]
```

`--changed` 的比较基线按顺序选择：`--base <sha>` 或 `ZCODE_PRE_PUSH_BASE` > CI 合并请求变量（`CI_MERGE_REQUEST_DIFF_BASE_SHA` 等）> pre-push stdin 的远端 sha > `@{upstream}` > 默认分支 merge-base（顺序与 `run-affected-unit-tests` 一致，`origin/staging` 优先）> `HEAD`。报告第二行打印实际使用的基线。2026-09 review 发现首版只用 `git diff HEAD`，CI 干净 checkout 与 pre-push 时差异为空，门禁实际只检查环；已修复。

`architecture:adopt` 把一个目录登记为 managed 模块：从真实 import 反推 `requires`、生成缺失的五件套骨架、在策略文件登记并保留注释。它存在的理由是让"登记模块"比"绕过规则"更便宜。

本地与 CI 使用同一检查器。`--changed` 解析完整依赖图，但只对本次变更及其必要影响闭包阻断；全局策略、循环依赖和 baseline 增长始终检查。CI 不得自动刷新 baseline；`baseline:update -- --changed` 只替换变更闭包内的条目，不会丢弃闭包之外的记录。违规与 baseline 中的文件路径都是相对仓库根的 posix 路径，跨机器稳定。检查器自身的回归测试是 `pnpm test:architecture`，已接入 `verify:pre-push` 与 CI 的 lint 任务。

### Git 文件枚举与 CI 缓存

2026-09-10 的 macOS 打包任务在文件枚举阶段失败：Runner 保留的 `.electron-builder-cache` 未被 Git 忽略，`git ls-files --others --exclude-standard` 输出超过 `execFile` 默认缓冲区。修复由 `scripts/architecture/index.mjs` 的现有变更收集入口负责，不改业务模块、策略或 baseline。

- 根目录的 `.electron-builder-cache/`、`.electron-cache/`、`.pnpm-store/`、`.npm-cache/` 是 CI 持久缓存，加入 `.gitignore`；保留 CI 的缓存路径及清理排除设置，不靠每次删缓存解决问题。
- 已跟踪文件仍比较 `HEAD`，未跟踪文件仍遵守 Git ignore。两个命令使用 NUL 分隔的流式输出，避免固定 `maxBuffer` 上限，也不裁剪路径空白或破坏非 ASCII 文件名。
- 收集入口合并、去重文件名；Git 进程失败时拒绝检查，不把失败或部分输出当成空变更通过。不新增缓存、版本或后台进程，不修改 CI 比较基线语义。

```text
Git diff / 未跟踪文件枚举
  -> 流式解析 NUL 分隔路径
  -> 两个进程均成功后合并去重
  -> 既有架构检查
任一 Git 失败 -> 检查失败
```

验证使用临时 Git 仓库覆盖超过 1 MiB 的未跟踪及已跟踪变化、缓存忽略、特殊路径及 Git 失败传播。只影响开发 / CI 检查，不涉及产品 UI、运行时或持久化数据迁移。

## Agent 工作流

[architecture-governance skill](../../.agents/skills/architecture-governance/SKILL.md) 对代码变更适用，纯文档任务跳过。代码修改前识别预期模块并检查当前基线，修改后重新检查；跨模块、状态归属变化或契约不明确时生成 `architecture:context` 阅读包，局部且契约明确的改动只读相关契约、spec 与测试。Spec、验证范围及完成条件统一遵循[根 AGENTS.md](../../AGENTS.md)，不在本文件重复定义。

阅读包由代码和策略生成，包含目标模块的 `module.ts`、`contract.ts`、示例、契约测试、短 CONTRACT.md、直接依赖契约、owner、允许边和受影响测试，不复制完整实现。

## 推进顺序

先建立策略、依赖图、baseline 和报告模式；再启用高置信度结构规则；随后以 Project/Session 为完整样板验证 contract、module manifest 和阅读包；最后扩展到 workspace identity、identity、model、automation、plugins/MCP 等领域。不得为单个领域复制一套门禁。

## 明确边界

不引入未经验证的通用 IoC/Event Center，不维护第二套手工 OWNERS 依赖图，不让 feature graph 兼任政策，不进行全仓一次性迁移。层级代码量不需要均衡，验收关注决定点、边界、竞态和阅读范围是否收敛。

## Todo103 整合边界

策略模块目录须包含当前重构拆出的 `packages/provider/src` 与 `packages/provider-node/src`，供检查器发现源码并生成对应阅读包。保持与本轮其他存量模块相同的 unmanaged 登记，不把合并扩大为 contract/manifest 的全仓迁移，也不自动刷新 baseline。当前 `managedOnly: true` 下的零违规仅表示已启用规则没有报错，不证明所有存量跨域依赖已通过机械检查；Provider/Selection 交集仍执行人工双向复审。

CLI 独立 lint 同样按指定上游的原样文件处理存量 `max-lines`：运行各包原有 oxlint 参数后，只接纳固定提交中路径、内容及模式均与暂存区和工作区一致的该项诊断。其他 lint 规则仍阻断；有本分支修改的文件、新文件以及缺失/未合入的上游提交均不享受准入。准入名单每次从 Git 生成，不维护逐文件行数 baseline，不向源码写 disable。

CLI 的 `lint` 入口枚举 packages/tools 中声明的 oxlint 命令，保留各包 cwd、参数与配置。非 oxlint 命令或不可解析输出显式失败，不能默默漏掉新包。结果同时报告接纳的存量行数诊断和仍阻断的错误。

超长的 CLI 会话存储、迁移、网关与启动装配保留原实现，不拆成共享全部内部状态的方法片段。协议无关的模型上下文和驻留 lease 放到 session-execution 公开入口，消除 V4 对旧协议目录的反向依赖；原 runtime 和记录仍是状态 owner。

### 行数规则（2026-10-10 裁决）

普通源码的默认上限由 400 调整到 800 行。模块登记、依赖方向、公开入口、循环依赖和契约检查保持严格；不能把文件拆成共享全部内部状态的片段来满足行数指标。

本次整合中已存在且超过 800 行的 CLI 文件及移入模块的既有远程连接 hook，在根 `.oxlintrc.json` 按精确路径登记为行数 warning，保留诊断但允许提交。其余文件超过 800 行仍报错，其他 lint 规则不降级。指定上游原样文件的行数存量仍通过固定提交内容校验接纳，不接受目录级豁免。

远程连接 hook 的原行数 disable 改为精确路径 warning；架构门禁仅登记该文件的行数例外，模块依赖和其他规则仍执行。
