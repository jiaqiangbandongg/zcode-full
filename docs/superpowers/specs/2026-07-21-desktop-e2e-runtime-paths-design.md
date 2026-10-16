# Desktop E2E Runtime Paths Design

## 背景

Desktop conversation E2E 的部分 spec、provider replay fixture 和 case manifest 把运行时文件写在 `/tmp`。macOS 下 Node.js 与 POSIX Bash 都把它解析为同一个目录；Windows 下 Node.js 把 `/tmp` 解析到当前盘根目录，而 Git Bash 把 `/tmp` 映射到 Windows 用户临时目录。跨进程 barrier 因此可能出现“spec 已创建 release 文件，但 child Bash 永远看不到”的分叉。

BG25 的产品时序没有异常。失败发生在 child Bash tool result 之前，因此 child 不会收到后续 coordinator question，parent 也不会消费 model-only reply。修复目标是统一 E2E 文件坐标系，而不是修改 coordinator、runtime command queue 或 background notification 语义。

## 路径合同

`.e2e-home` 继续作为整个测试进程的隔离 HOME；case 临时文件统一放在 Agent 实际执行 workspace `ZCodeProject` 下的 `.zcode-e2e/<case>`。运行时日志已经确认 child 的 `workingDirectory` 指向这里，而不是 conversation backing workspace：

```text
.e2e-home/
└── ZCodeProject/                    Agent workspace cwd
    └── .zcode-e2e/
        ├── shared/
        └── <case>/                  case-owned runtime files
```

同一文件按消费者暴露两种表示：

```text
Node/spec/tool input: <native-or-portable absolute workspace>/.zcode-e2e/<case>/file
Bash command:         .zcode-e2e/<case>/file
```

- Node 文件 API 使用原生绝对路径。
- Read/Write/Edit/Glob/Grep 等 provider tool input 使用正斜杠归一化后的绝对路径；Windows 文件 API 接受 `C:/...`，fixture 不需要处理 JSON 反斜杠转义。
- Bash 从 workspace cwd 启动，使用平台无关的 POSIX 相对路径，避免 Windows drive、Git Bash mount 和含空格 TEMP 目录转换。
- 每个 case 清理自己的目录；共享只读输入放在 `.zcode-e2e/shared`。

## Replay fixture 变量

Replay server 接收静态 `fixtureVariables`，在 fixture 加载后、请求匹配前递归替换所有字符串。路径 fixture 使用 `{{e2eRuntimeRoot}}`，其值由 WDIO 根据当前 `E2E_HOME_DIR` 计算。

替换必须覆盖 matcher、prompt、tool input、raw SSE body、chunks 和 events。现有按请求提取的 `{{latestAgentId}}` 保持动态响应变量，不与静态路径变量混用。

Replay/capture server 与 WDIO worker 跨进程共享 artifact。writer 必须先写完整临时 JSON，再以 rename 替换目标文件，避免 reader 在 truncate 与写完之间读到半截 JSON。

```text
fixture JSON
  -> parse
  -> apply static fixtureVariables
  -> request matcher
  -> apply request-derived latestAgentId
  -> replay response
```

## 迁移范围

清除 `packages/desktop/test/e2e` 运行目录中的裸 `/tmp`：

- formal 与 manual-review/pending conversation specs；
- case-local 与 legacy DeepSeek replay fixtures；
- case manifests；
- bots harness 和未注册工具 snapshot 等 E2E 测试数据。

迁移不改变 case ID、setup/action/assert、provider 请求分类或 timing policy。普通 unit test 中使用 `tmpdir()` 创建真实临时目录，以及完全不进入 E2E 运行文件系统的 parser 样本，不属于本合同。

## 防回归与验证

- replay server 单测先证明静态变量能参与 matcher，并进入 tool input/raw response。
- 路径合同单测扫描 `packages/desktop/test/e2e`，禁止重新提交裸 `/tmp`。
- fixture checker 验证受影响 case 的 manifest/provider 合同。
- 定向 replay 覆盖 BG25、BG21、permission、tool-cross-product 等真实文件消费者。
- 完成前执行 `pnpm --filter @zcode/desktop typecheck:e2e`、`pnpm typecheck` 和 `pnpm lint`。

## 非目标

- 不修改 desktop continuous、web remote replayable、snapshot、owner/lease 或 workspace identity 语义。
- 不引入新的 Agent runtime、协议字段或 main/relay 状态。
- 不承诺用 CMD 执行 POSIX Bash fixture；Windows Desktop E2E 继续使用现有 Git Bash resolver。
