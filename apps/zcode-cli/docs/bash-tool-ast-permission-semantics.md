# Bash Tool AST Permission Semantics

## 背景

Bash tool 的权限、只读和并发安全判断必须避免把动态 shell 结构当成普通只读命令。典型风险是 `ls $(touch out.txt)`：模型表面上调用 `ls`，实际 shell 会先执行命令替换里的 `touch`。

因此 Bash 权限链路需要基于 Bash AST 识别命令替换、进程替换、子 shell、pipeline、重定向等节点；复杂或不可安全归一的命令回到保守路径，不按简单只读命令自动放行。

## 第三方库选择

- `bash-parser` 提供 Bash AST，但最新 npm 版本仍是 `0.5.0`，发布时间较早，维护活跃度和现代 Bash 覆盖面不足。
- `tree-sitter` + `tree-sitter-bash` 的 AST 节点覆盖完整，但 Node 绑定是 native package；在当前仓库的 CLI 构建和跨平台安装链路中会引入额外 build/prebuild 风险。
- `web-tree-sitter` 已在 TUI 间接依赖中出现，但它是 WASM/web 绑定，不自带 Bash grammar；把异步 WASM 初始化放进核心权限判断会增加运行时复杂度。
- `unbash` 是维护中的纯 TypeScript Bash AST parser，0 依赖、同步 API，AST 能结构化区分 command/process substitution、redirect、assignment、pipeline、and/or 和 compound shell 节点，因此作为 Bash 权限语义的 parser 基础。

## 语义边界

- 权限相关判断先解析 AST，再提取安全的 top-level simple command argv。
- 遇到命令替换、进程替换、子 shell、函数、循环、条件、case、here-doc、解析错误或未知动态结构时，权限 matcher fallback open，read-only / concurrency-safe 返回 `false`。
- 简单只读自动 allow 不再只按命令名判断，而是采用 data-driven policy：先通过 AST 提取 simple command argv，再按命令级 `safeFlags` 校验 argv。`tree -a`、`tree -L 2` 这类只读参数可自动 allow，`tree -o out.txt` 这类写输出文件的参数不在 safe flags 内，必须回到正常审批路径。
- 展示分类仍可识别 top-level `cat`、`rg`、`find`、`ls > out.txt` 等 read/search/list 命令，但它只服务 UI / summary，不参与安全放行；`sed -i*`、`find -exec/-delete` 等写语义必须覆盖掉展示分类。

## Read-only policy 结构

Bash read-only 判定按多层 policy table 与执行器组合设计，而不是单一 allowlist：

- 主命令 safe flag policy：按命令声明允许的 flag 与参数类型，覆盖 `tree`、`sed`、`sort`、`file`、`ps`、`date`、`fd`、`test` 等命令。
- 命令族子表合入主表：git 子命令、`rg`、`pyright`、`docker logs/inspect` 等命令族各自维护 safe flags。
- fallback allowlist 和 glob 分支：只有在命令结构、参数和动态特征都安全时才放行。
- 写入/执行选项拒绝表：拒绝 `find -delete/-exec/...` 这类会写入或执行的选项。
- 路径目标、读写类型、redirect 和 git internal path 等更宽的 permission 语义由独立层处理。

ZCode 当前先实现 Bash read-only auto-allow 所需的核心子集：AST 安全检查、simple command 限制、命令级 `safeFlags`、参数类型校验、短 flag 组合、`--flag=value`、`--` 处理、`find` / `sed` 写语义拒绝。后续扩展其他命令时必须只改 policy table，不在执行器里追加命令名特判。

## 项目级 command prefix 权限

command prefix registry 与本文件前述 readonly policy 是两个独立层：前者只决定用户选择
“始终允许此项目”时建议保存哪个 action scope，后者只决定一次 invocation 是否无需审批。
任何 prefix registry 命中都不能把命令提升为 readonly。

prefix resolver 复用同一份 `unbash` AST。安全 simple invocation 可借构建期 Fig registry
跳过已知 global option/value，并将 executable + 稳定 subcommand/action 保存为
`"<prefix>:*"`；path、URL、文件参数和 transient args 不进入 prefix。wrapper 最多两层，
保存时保留 wrapper 与用户原始 executable token。

以下情况统一保存 trim 后完整 command exact：解析失败、dynamic substitution、redirect、
未知 compound node、无法无歧义序列化的 token、动态 env assignment，以及没有稳定 action
边界的高风险 shell/删除/权限修改命令。compound command 的各需审批 invocation 独立生成
规则，最多五条；超过五条回退整串 exact。

匹配时先检查完整 raw exact，再对 AST-safe invocations 做 token-boundary prefix/wildcard
匹配。`allow` 只有在全部需审批 invocation 都被规则集合覆盖时成立；`deny`/`ask` 任一
invocation 命中即成立。因而 `npm run:*` 不得匹配
`npm run test && rm -rf ...`，但多条 allow rules 可以共同覆盖一个安全 compound command。

完整协议、存储和 UI 设计见
`docs/superpowers/specs/2026-07-13-bash-command-permission-registry-design.md`。
