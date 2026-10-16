# 公共架构门禁与 AI Governance

## 目标

架构规则是全仓公共能力，不属于任何单一业务重构。所有代码变更经过同一条链路：

```text
代码变更 → 策略解析 → 依赖图与变更闭包 → 规则检查与 ratchet → 阅读包与报告
```

第一版覆盖 `packages`、`apps`、desktop、web、server 和 CLI。存量违规进入确定性的 baseline；新违规阻断，baseline 只能通过显式命令和 PR 审核更新。

## 规范来源

- 根目录 `architecture-policy.yaml` 是组织级政策：模块路径、层级、允许边、全局阈值和例外。
- 模块 `module.ts` 是局部依赖声明：`id`、`requires`、`provides` 和公开入口。
- 实际 import graph 从源码生成，不能手工维护。
- feature graph 只描述产品能力和影响面，不承担架构门禁职责。

策略文件和模块声明必须互相校验，禁止出现未被策略覆盖的模块或模块声明中的未知依赖。

## 规则

规则引擎检查层级方向、模块依赖声明、公开入口、循环依赖、UI/Domain 的实现边界、模块必需文件、文件和契约大小、公开方法数以及 lint disable。owner 字段随报告输出，状态写入授权需要在具体状态模块完成 manifest 声明后接入同一规则接口。规则编号和修复建议集中维护在 `scripts/architecture`，AGENTS.md 只提供入口。

## 命令与执行

```text
pnpm architecture:check
pnpm architecture:check --changed
pnpm architecture:report
pnpm architecture:baseline:update
pnpm architecture:context <module-id>
```

本地与 CI 使用同一检查器。`--changed` 解析完整依赖图，但只对本次变更及其必要影响闭包阻断；全局策略、循环依赖和 baseline 增长始终检查。CI 不得自动刷新 baseline。

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
