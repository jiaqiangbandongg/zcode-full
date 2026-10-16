# Core / Adapters Boundary Refactor Plan

## 文档定位

本文是一次实现级改造计划，目标是把当前实现重新拉回 `architecture.md` 定义的分层边界：

- `core` 只依赖 `contracts`，只表达业务意图和状态转移。
- `adapters` 只依赖 `contracts`，负责文件系统、子进程、网络、模型 SDK、存储、日志、配置等外部 I/O。
- `bootstrap` 是唯一组合层，负责把 core 需要的 port 绑定到具体 adapter。

本文不是最终接口 RFC。这里列出的 port 名称和阶段任务用于指导迁移；每个 port 的完整 schema、错误类型、取消语义和跨平台细节仍应进入对应 RFC。

## 当前问题

当前实现已经出现 core / adapters 边界泄漏：

1. `@zcode/core` 依赖了 `@zcode/adapters`，违反了 v2 的编译依赖方向。
2. `packages/core/src/runtime.ts` 直接引用 `AiSdkModelAdapter`，导致 provider SDK adapter 形态进入 core。
3. `packages/core/src/tool/handlers/read.ts`、`write.ts`、`edit.ts` 直接使用 `fs/promises`。
4. `packages/core/src/tool/handlers/bash.ts` 直接使用 `child_process.exec`，且是 shell 字符串执行。
5. built-in tool 的注册和具体 I/O handler 位于 core，导致 ToolRuntime 无法做到纯业务编排。
6. `ToolRegistry.toContracts()` 目前只把工具 schema 暴露给模型，没有把模型 tool call 回接到 ZCode 的 permission / scheduler / executor 生命周期。
7. config、logging、model adapter 等能力正在 adapter 层成形，但 core 还没有统一通过 contracts port 消费这些能力。

这些问题会带来三个后果：

- core 不能独立测试，测试会被 Node I/O、provider SDK 和平台差异污染。
- 权限、审计、取消、重试、artifact、trace 无法统一包住所有外部副作用。
- Windows / macOS / Linux 的文件和子进程差异会散落到业务代码里。

## 目标

本次改造完成后应满足：

- `packages/core/package.json` 不再依赖 `@zcode/adapters`。
- `packages/core/src/**` 不直接 import `node:fs`、`fs/promises`、`node:child_process`、`child_process`、provider SDK、HTTP SDK 或 adapter 实现。
- `core` 通过 contracts 中的 port 调用模型、工具 I/O、日志、trace、存储和配置。
- built-in tools 可以分成两层：core 中的 tool contract / lifecycle，adapters 中的 Node I/O implementation。
- bootstrap 创建 adapter 实例并注入 AgentRuntime / ToolRuntime。
- 单测可以用 fake ports 覆盖 core 的 agent loop、tool lifecycle、permission 和 error path。

## 非目标

本计划不一次性完成以下能力：

- 不完整实现 SQLite event store。
- 不完整实现 sandbox。
- 不完整实现 MCP / ZCode app-server。
- 不完整实现 compact / memory / subagent。
- 不重写全部 tool 行为，只先把边界拆干净，并保留最小 Read / Write / Edit / Bash 可运行路径。

## 目标依赖方向

```text
packages/contracts
  ↑
packages/core          packages/adapters
  ↑                         ↑
  └──────── packages/bootstrap ────────┘
                  ↑
          packages/cli / tui / server
```

允许：

- `core -> contracts`
- `adapters -> contracts`
- `bootstrap -> contracts + core + adapters`
- `cli/tui/server -> bootstrap`

禁止：

- `core -> adapters`
- `core -> fs / child_process / fetch / process.env`
- `adapters -> core`
- `contracts -> core / adapters / bootstrap`

## 需要补齐的 contracts

### ModelPort

替代 core 中对 `AiSdkModelAdapter` 的直接依赖。

候选职责：

- `generateText`
- `streamText`
- provider-neutral request / result / stream event
- model error normalization
- trace / abortSignal 传递

落点：

- port 定义进入 `packages/contracts/src/model` 或 `packages/contracts/src/interfaces/model.port.ts`。
- `AiSdkModelAdapter` 实现该 port。
- `AgentRuntimeDeps.modelAdapter` 改成 `ModelPort`。

### FileSystemPort

替代 core tool handler 中的 `fs/promises`。

候选职责：

- read text / binary
- stat / exists
- mkdir
- atomic write
- compare-and-write / stale write 检查
- path normalization
- read baseline / revision / hash

落点：

- port 定义进入 `contracts`。
- Node 实现进入 `adapters/src/fs`。
- 第一阶段先让 Read / Write / Edit 的 core handler 只表达工具语义，并通过 `FileSystemPort` 执行真实 I/O。
- 后续如果要支持可替换 tool implementation，再把 handler 注册移动到 bootstrap/adapters；不能再把 Node `fs` 引回 core。

### ContextSourcePort

替代 context builder 和 runtime 中对宿主进程、工作区文件和项目结构的直接探测。

候选职责：

- 提供已解析的 `EnvInfo`，包括 cwd、platform、shell、Node/OS 版本。
- 按配置查找并读取 AGENTS.md / CLAUDE.md 等用户指令。
- 探测项目类型、包管理器、构建文件和 package scripts。
- 返回 diagnostics，而不是在 core 中吞掉 I/O 错误。

落点：

- port 定义进入 `contracts`。
- Node 实现进入 `adapters/src/context`。
- core `ContextBuilder` 只渲染 `ContextSourceSnapshot`，不直接读 `process`、`node:fs` 或项目文件。
- bootstrap 负责提供 `workingDirectory`，core 不退回 `process.cwd()`。

### ExecutionPort

替代 core 中的 `child_process.exec`。

候选职责：

- 使用 argv 数组执行命令。
- 支持 cwd、env overlay、timeout、abortSignal。
- 支持 stdout/stderr 流式事件和最终结果。
- 归一化 exit code、signal、timeout、cancel、spawn error。
- 预留 sandbox policy。

落点：

- port 定义进入 `contracts`。
- Node 实现进入 `adapters/src/exec`。
- Bash handler 迁到 adapters，core 只调度 `ExecutionPort` 意图。

### ToolRuntimePort / ToolImplementationPort

拆开 tool contract 和 tool implementation。

候选职责：

- core 持有 tool metadata、schema、permission、scheduler、event lifecycle。
- adapter 注册 concrete tool implementation。
- implementation 只能通过 adapter I/O port 做副作用。
- tool result 先进入统一 serializer / artifact policy，再回灌模型。

落点：

- `ToolEntry` 的 handler 类型移动到 contracts 或改为 port-based implementation。
- `core` 不再导出 Node built-in handler。
- `bootstrap` 组装 built-in tool implementation。

### Logger / Trace / Config

已有雏形，但需要边界收口：

- core 只依赖 `Logger`、`TraceContext`、`ConfigPort` contract。
- Node logger、env config、file config 只存在 adapters。
- env 读取只发生在 CLI/bootstrap/adapters，不进入 core。

## 分阶段计划

### Phase 0：修复当前健康度

目标：让边界改造有可靠验证底座。

任务：

- 修复 `packages/adapters/src/config/*.ts` 的 `Partial<RuntimeConfig>` 类型错误。
- 确保 `pnpm test` 可以跑到 core / adapters / cli 全部测试。
- 给每个 package 补真实 `lint` script，避免 `pnpm lint` 空跑。
- 保留当前 dirty worktree 中用户已有改动，不做无关回滚。

验收：

- `pnpm test` 通过。
- `pnpm lint` 至少执行实际 lint task，不能显示 0 tasks。

### Phase 1：切断 core 对 adapters 的编译依赖

目标：让 core 重新成为纯业务包。

任务：

- 在 contracts 中定义最小 `ModelPort`。
- 将 `AgentRuntimeDeps.modelAdapter?: AiSdkModelAdapter` 改为 `modelPort?: ModelPort`。
- `AiSdkModelAdapter` 实现 `ModelPort`。
- 从 `packages/core/package.json` 移除 `@zcode/adapters`。
- 增加 dependency guard 测试：core 源码禁止 import `@zcode/adapters`。

验收：

- `pnpm --filter @zcode/core typecheck` 不需要 adapters build。
- `rg "@zcode/adapters" packages/core/src packages/core/package.json` 无结果。

### Phase 2：迁移 built-in tool I/O 到 adapters

目标：core 不再直接触碰文件系统和子进程。

任务：

- 在 contracts 中定义最小 `FileSystemPort` 和 `ExecutionPort`。
- 将 Read / Write / Edit 的 Node I/O 收敛到 `FileSystemPort`，Bash 继续通过 `ExecutionPort`。
- core 保留 tool schema、metadata、permission、scheduler、event lifecycle。
- bootstrap 注入 Node `FileSystemPort` / `ExecutionPort` / `ContextSourcePort`。
- 增加 dependency guard 测试：core 的文件工具、runtime context 初始化和 context section 禁止 import `fs`、`fs/promises`，禁止读取 `process.cwd()` / `process.env` / `process.platform`。

验收：

- `rg "fs/promises|node:fs|process\\.cwd|process\\.env|process\\.platform" packages/core/src/runtime.ts packages/core/src/context packages/core/src/tool/handlers/{read,write,edit}.ts` 无结果。
- Read / Write / Edit 单测使用 fake `FileSystemPort` 覆盖 core 生命周期。
- Node fs/context adapter 单测覆盖真实 I/O 的 happy path。

### Phase 3：让 model tool call 回到 ZCode ToolRuntime

目标：模型工具调用不能绕过权限、调度、审计和 trace。

任务：

- `ToolRegistry.toContracts()` 生成模型可见 tool schema 时，不直接暴露 I/O handler。
- Model adapter 收到 tool call 后，以 event 形式返回 core，或通过 callback 进入 core `ToolRuntime`。
- AgentRuntime 实现最小 tool loop：
  1. model request
  2. model tool call event
  3. schedule tools
  4. permission check / pending approval
  5. execute tools through ToolRuntime
  6. serialize tool results
  7. continue model request
- 所有 tool lifecycle event 使用同一个 turn trace。

验收：

- 一个 fake model 返回 Read tool call，core 能执行 fake Read implementation 并把 tool result 回灌下一轮 model。
- 高风险 Bash 在默认策略下产生 pending / denied 事件，而不是直接执行。
- tool result 超预算时返回摘要和 artifact 引用，而不是完整塞回模型上下文。

### Phase 4：收敛文件写入正确性

目标：满足跨平台和并发写入基本安全要求。

任务：

- Read 记录 file baseline：path、mtime 或 revision、hash、是否截断读取。
- Write / Edit 写前重读并校验 baseline。
- 支持 atomic write，处理 Windows rename 语义。
- 对 symlink、大小写敏感差异、权限错误、BOM、换行符给出结构化错误。
- 增加 per-path in-process lock，但不把它当成跨进程正确性来源。

验收：

- 未读过的已有文件不允许直接覆盖，除非用户显式允许。
- 文件在读后被外部修改时，Edit / Write 返回 stale write 错误。
- macOS 当前平台测试通过；Windows / Linux 风险在 adapter 文档中明确记录。

### Phase 5：ExecutionPort 跨平台化

目标：Bash / command execution 进入统一执行边界。

任务：

- ExecutionPort 主路径使用 `spawn` / `execFile` argv 数组。
- 明确 shell mode 和 command mode，shell mode 必须显式声明风险。
- 支持 Windows `.cmd` / `.exe` 查找、空格路径、env key 大小写、cwd 校验。
- 支持 timeout、cancel、输出截断、流式 stdout/stderr。
- 支持 sandbox policy 占位。

验收：

- command mode 不依赖 POSIX shell。
- timeout 和 abortSignal 都能结束进程并返回结构化结果。
- 输出超过预算时截断并产生 artifact / preview 策略。

### Phase 6：加架构守门测试

目标：防止边界再次回退。

任务：

- 增加 `tests/architecture-boundary.test.ts` 或 package 内测试。
- 检查 core package dependencies 只允许 `@zcode/contracts`、必要纯类型包和测试依赖。
- 检查 core source 禁止底层 I/O import。
- 检查 adapters source 禁止 import `@zcode/core`。
- 检查 contracts source 禁止 import core / adapters / bootstrap。

验收：

- 任意新增违规 import 会让 CI 失败。

## 推荐提交拆分

1. `docs: add core adapters boundary plan`
2. `fix(adapters): make config adapters typecheck`
3. `test: add architecture boundary guards`
4. `refactor(contracts): add model port`
5. `refactor(core): depend on model port instead of ai sdk adapter`
6. `refactor(contracts): add filesystem and execution ports`
7. `refactor(tools): move node tool implementations to adapters`
8. `feat(core): route model tool calls through tool runtime`
9. `feat(fs): enforce read baseline and stale write checks`
10. `feat(exec): add cross-platform execution adapter`

## 风险与注意事项

- 当前工作区已有未提交改动，迁移时必须按文件域拆分，避免覆盖他人修改。
- `runtime.ts` 正在同时承接 model、tool、trace、logger 改动，建议先把 port 抽出，再重构 agent loop。
- config adapter 目前还在演进，先让类型和测试变绿，再把它接入 bootstrap。
- 不要为了快速切断依赖而把 adapter 类型复制到 core；共享类型必须进入 contracts。
- 不要把 Node I/O handler 从 core 搬到 adapters 后仍由 core 直接 import；注册必须发生在 bootstrap。

## 完成定义

本计划完成时，下面命令应全部通过：

```sh
pnpm lint
pnpm test
pnpm --filter @zcode/core typecheck
```

并且下面检查应无结果：

```sh
rg "@zcode/adapters" packages/core/src packages/core/package.json
rg "fs/promises|node:fs|child_process|node:child_process|process\\.env|fetch\\(" packages/core/src
rg "@zcode/core" packages/adapters/src packages/adapters/package.json
```
