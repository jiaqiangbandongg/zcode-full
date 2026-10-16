# CLI `zcode plugins` 子命令

> 状态：阶段一 MR1（子命令面）。阶段二 MR2 将补 `--plugin-dir` 会话级插件加载。

## 背景与目标

外围要用 headless 模式在 Docker 容器里自动化评测插件（内置 + zcode 官方市场全量，真模型）。
评测编排、任务设计、判分、凭据注入都在外围；CLI 内核只需要保证「镜像里能把插件装齐、
每次运行能选插件、结果可结构化读取」。stream-json 事件面与 headless 权限模式（默认 yolo）已经够用，
本次只补 `zcode plugins` 子命令树；命令面兼容 Claude Code 的 `claude plugin`，外围评测脚本换 CLI 二进制即可复用。

## 命令面

| 子命令 | 行为 | 落点 |
|---|---|---|
| `list [--json] [--available]` | 列出已加载插件（内置 + 已安装）；`--available` 追加市场目录 | `listZCodePlugins` / `getZCodePluginsOverview` |
| `install <plugin>[@marketplace] [-s <scope>]` | 裸 name 在所有市场里唯一匹配才安装，多个同名报错要求带 `@marketplace` | `installZCodeMarketplacePlugin` |
| `uninstall <plugin> [-s <scope>] [--keep-data] [--force]` | `--keep-data` 只删安装缓存、保留 `data/<plugin-id>`；非 TTY 未带 `--force` 拒绝执行 | `uninstallZCodeMarketplacePlugin`（新增 `keepData`） |
| `enable <plugin> [-s <scope>]` / `disable [plugin] [-a\|--all] [-s <scope>]` | `--all` 逐个关闭当前启用的插件；`--all` 不能与插件名或 `--scope` 同用 | `setZCodePluginEnabled` |
| `update <plugin> [-s <scope>]` | 先刷新所属市场目录再按同条目重装；保留 installedAt 与用户开关 | 新增 `updateZCodeMarketplacePlugin` |
| `validate <path>` | 本地插件目录 / plugin.json / 市场目录 / marketplace.json 只读校验 | 新增 `validateZCodePluginPath` → adapters `validateLocalPluginPath` |
| `marketplace add <source> [--scope] [--sparse <path>]` | `--sparse` 可重复，仅 git/github 源生效（复用既有 `sparsePaths`） | `addZCodePluginMarketplace`（新增 `sparsePaths`） |
| `marketplace list [--json]` / `remove <name>` / `update [name]` | 列出、移除、刷新已知市场 | `getZCodePluginsOverview` / `removeZCodePluginMarketplace` / `updateZCodePluginMarketplace` |
| 别名 `zcode plugin ...` | 单数形式别名，行为与 `zcode plugins` 相同 | `run.ts` |

## JSON 输出契约

字段沿用 zcode 既有命名，结构如下：

- `list --json` 默认输出**数组**（不再有 `{cwd, diagnostics, plugins}` 包装）；每个条目多一个
  `diagnostics` 数组，只放 `pluginId` 归属到自己的诊断。
- `list --available --json` 输出 `{ installed, available, diagnostics }`。
- `install` / `update` / `validate` / `marketplace update` 的 JSON 都带 `ok` 与 `diagnostics`；
  任一 `severity: "error"` 诊断即 `ok: false` 且退出码 1。

## 参数与行为说明

| 项 | zcode 行为 | 原因 |
|---|---|---|
| scope 取值 | `user` / `project`（project 映射内部 `workspace`）；`local` 直接报错 | zcode 没有 local settings 层 |
| `uninstall --force` | 非交互终端不带 `--force` 拒绝卸载 | zcode 既有安全阀，保留 |
| `marketplace add --scope` / `uninstall -s` | 只校验拼写，不改行为 | known marketplaces / 安装记录都是 Host User inventory |
| `marketplace add --sparse` | 不支持变参，需重复 `--sparse a --sparse b` | 全局解析器是 strict `parseArgs` |
| `list --json` 条目字段 | zcode 既有字段 + `diagnostics` | 不破坏现有消费者 |

## 实现要点

- 子命令旗标（`--available`、`-s/--scope`、`-a/--all`、`--keep-data`、`--sparse`）在 `run.ts` 的
  strict 全局解析器注册，收集成 `PluginsCommandFlags` 透传，不影响其他命令。
- `plugins-command.ts` 用 `BOOTSTRAP_EXPORTS` 表把 CLI 依赖名映射到 bootstrap 导出名：测试按依赖名
  注入假实现，生产按导出名懒加载 bootstrap。
- `update` 不新增 adapter 能力：`cacheMarketplacePlugin` 对已存在记录原地覆盖并保留 `installedAt`，
  `enablePluginsByDefaultInFileConfig` 只给未显式声明的 id 补默认值，所以更新不会翻转用户开关。

## 外围评测典型用法

```bash
# 镜像构建阶段：装齐官方市场
zcode plugins marketplace update
zcode plugins list --available --json | jq -r '.available[] | select(.installed==false) | .id' \
  | xargs -n1 zcode plugins install

# 每个任务容器：只开被评测插件
zcode plugins disable --all
zcode plugins enable <plugin-id>
zcode --prompt "<task>" --output-format stream-json
```

## 验证

- 单测：`apps/zcode-cli/packages/cli/tests/plugins-command.test.ts`（子命令路由、scope 映射、
  `--all` 互斥、`--keep-data` 透传、JSON 形状、`plugin` 别名与旗标收集）。
- 真实冒烟（2026-09-14，隔离 `HOME`/`ZCODE_DATA_BASE_DIR`/`ZCODE_STORAGE_DIR`，ZAPI GLM-5.3-Highspeed）：
  `marketplace list` → `marketplace update zcode-plugins-official`（8 → 27 个条目）→ `list --available --json`
  → `install lark-cli` → `plugin disable --all` → `enable lark-cli` → `update lark-cli`（already up to date）
  → `--prompt` 要求加载 lark-cli 的 setup skill，stream-json 中出现 `tool.updated` 且 `toolName: "Skill"`、
  `skill: "lark-cli:setup"`，turn 正常完成 → `uninstall lark-cli --keep-data --force` 后 `data/lark-cli@…` 保留、
  cache 记录移除 → `validate` 对 bundled 插件目录、plugin.json 文件、不存在路径分别返回 0 / 0 / 1。
- 冒烟踩坑：headless 默认模型只读 `~/.zcode/v2/provider_config.json` 的 `config.defaultModelSelection`，
  且必须带 `options.reasoningLevel`，否则静默回退到第一个 provider 的第一个模型。
