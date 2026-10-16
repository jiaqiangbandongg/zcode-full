# dep-refs：变量级 export 引用查询脚本

## 背景

正在做大型重构，需要删大量代码。现有工具的缺口：

- `scripts/dependency-graph.mjs`（已有，460 行）只到 **文件级**，无法回答"`createBotSession` 这个具体 export 被谁用了"
- `pnpm knip` 能列出**完全没人用**的 export，但不告诉**还在用的 export 被谁用**，所以无法支撑"我要改/删 X，谁会受影响"这种判断
- `grep` 找名字会被同名变量、注释、字符串污染，不准

需要一个 CLI：给一个 export symbol，精确列出所有引用位置（基于 TS LanguageService，不是文本匹配）。

## 目标 / 非目标

**目标：**
- 给 `<file>:<exportName>`，列出所有引用位置（含文件、行、列、代码片段）
- 列某文件的所有 export（删文件前的清单）
- JSON 输出，让 agent 能用 Read/jq 消费
- 区分普通引用和 re-export

**非目标：**
- 不取代 `dependency-graph.mjs`（文件级）和 `knip`（unused 检测）
- 不处理 dynamic `import()` 或字符串引用
- 不做全量预生成图（按需查询足矣）

## 设计

### 新增文件 & 命令

新文件 `scripts/dep-refs.mjs`（预估 ~200 行，基于 `ts-morph`）。不修改 `dependency-graph.mjs`。

`package.json` 新增 script：
```json
"dep:refs": "node scripts/dep-refs.mjs"
```

新依赖：`pnpm add -D ts-morph`

### CLI 形态

```bash
# 查 export 的所有引用（核心用法）
pnpm dep:refs <file>:<exportName>

# 列文件的所有 export
pnpm dep:refs --list-exports <file>

# JSON 输出
pnpm dep:refs <file>:<exportName> --json
pnpm dep:refs --list-exports <file> --json

# 可选：缩小扫描范围加速
pnpm dep:refs <file>:<exportName> --scope packages/services
```

### 输出（人读）

查询单个 symbol：

```
createBotSession  (function, exported at packages/services/src/bots/botsService.ts:12)

References (3):
  packages/services/src/node.ts:42:8
    > const session = await createBotSession(opts)
  packages/services/test/botsService.messageFlow.test.ts:15:22
    > await createBotSession({ id: '1' })
  packages/server/src/routes/bots.ts:88:14
    > createBotSession(req.body)

Re-exports (1):
  packages/services/src/index.ts:5
    > export { createBotSession } from './bots/botsService'

Note: static analysis only. Dynamic import() and string-based usage not detected.
```

零引用时：

```
oldHelper  (function, exported at .../botsService.ts:87)

References (0). Safe to delete (no static references and no re-exports).
```

`--list-exports`：

```
packages/services/src/bots/botsService.ts

Exports (4):
  createBotSession   function    line 12
  BotSessionOptions  type        line 5
  DEFAULT_TIMEOUT    const       line 3
  closeBotSession    function    line 87
```

### JSON 输出 schema

```json
{
  "symbol": {
    "name": "createBotSession",
    "kind": "function",
    "file": "packages/services/src/bots/botsService.ts",
    "line": 12
  },
  "references": [
    { "file": "packages/services/src/node.ts", "line": 42, "col": 8, "snippet": "const session = await createBotSession(opts)" }
  ],
  "reExports": [
    { "file": "packages/services/src/index.ts", "line": 5, "snippet": "export { createBotSession } from './bots/botsService'" }
  ],
  "notes": ["Static analysis only. Dynamic import() and string-based usage not detected."]
}
```

`--list-exports --json`：

```json
{
  "file": "packages/services/src/bots/botsService.ts",
  "exports": [
    { "name": "createBotSession", "kind": "function", "line": 12 },
    { "name": "BotSessionOptions", "kind": "type", "line": 5 }
  ]
}
```

### 扫描范围

默认加载所有 workspace 源码 + 测试：
- `packages/*/src/**/*.{ts,tsx,mts,cts}`
- `packages/*/test/**/*.{ts,tsx}`
- `apps/*/src/**/*.{ts,tsx,mts,cts}`
- `harness/**/*.{ts,tsx}`

（test 必须扫，否则"被测试引用"的 export 会被误判为 unused）

`--scope <glob>` 覆盖默认范围，例如 `--scope packages/services` 只加载该包，启动会快很多。

### 关键实现要点（ts-morph API）

| 步骤 | API |
|---|---|
| 创建 Project | `new Project({ tsConfigFilePath: 'tsconfig.base.json', skipAddingFilesFromTsConfig: true })` |
| 显式加载源文件 | `project.addSourceFilesAtPaths(globs)` |
| 找指定 export | `sourceFile.getExportedDeclarations().get(name)` → `Declaration[]`（同名多重载会返回多个） |
| 找引用 | 对每个 declaration 拿到一个 `Identifier`（`getNameNode()` 或类似），调用 `identifier.findReferences()` |
| 区分 re-export | 遍历每个引用节点，向上找父节点：在 `ExportDeclaration` / `ExportSpecifier` 下 → 归入 reExports；否则 references |
| 跳过 declaration 自身 | 引用结果里会包含 declaration 位置，按 file+line 过滤掉 |
| 列 exports | `sourceFile.getExportedDeclarations()` 遍历整个 Map |
| kind 推断 | declaration 的 `getKindName()`：`FunctionDeclaration` → function、`VariableDeclaration` → const、`TypeAliasDeclaration` → type、`InterfaceDeclaration` → interface、`ClassDeclaration` → class |

### 边界处理

| 情况 | 行为 |
|---|---|
| `export *` | ✅ getExportedDeclarations 自动穿透 |
| `import { foo as bar }` 别名 | ✅ findReferences 跟踪 alias |
| type-only import vs value import | ✅ 全找到 |
| 多重 re-export 链 (a → b → c) | ✅ findReferences 穿透 |
| 同名重载（多个 declaration） | 合并所有 declaration 的引用，去重 |
| 文件不存在 / symbol 不存在 | 退出码 1，stderr 给清晰错误 |
| dynamic `import()` 字符串路径 | ❌ 不检测，输出 notes 提示 |
| 命令行未提供 symbol | 提示用 `--list-exports` 先看 |

### 性能

ts-morph 加载整个 monorepo 约 10-30 秒（一次查询的固定开销）。后续查询若加 `--scope` 缩小到单个包，秒级。

不做缓存（实现复杂度不值，knip 已经覆盖"批量"场景）。

### 与现有工具的协作

推荐流程（写进 script 注释 / `dep:refs --help`）：

1. `pnpm knip` → 拿到 unused exports 列表（瞬秒）
2. 对存疑的 export 用 `pnpm dep:refs file:name` 看具体引用者
3. 决定能删 / 要先改调用方

## 失败模式

- **ts-morph 加载报错（tsconfig 配置问题）**：直接退出，把错误原样打到 stderr，不强行容错
- **findReferences 返回空但 declaration 找到了**：正常情况（零引用），按"safe to delete"提示
- **symbol 名拼错**：提示 `--list-exports` 列出该文件的所有 export 供参考

## 测试

- 手动测试为主：
  - 对一个已知有引用的 export 跑，比对引用数和 grep 大致一致
  - 对一个 knip 报告为 unused 的 export 跑，应返回 `References (0)`
  - `--list-exports` 跑 `packages/services/src/bots/botsService.ts`，肉眼比对
- 不写自动化测试：脚本依赖整个 monorepo 编译状态，单测成本高于收益。
