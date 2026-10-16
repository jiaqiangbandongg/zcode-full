# Workspace 文件搜索默认过滤器

> 状态：设计确认，2026-08-07。2026-09-15 增补 `.zcodeignore` 单一真相源章节（ZCT-2096811705629528064）。

## 2026-09-28 临时停用自动创建

工作区搜索规则的界面管理入口已临时隐藏，本次同步注释停用 `.zcodeignore` 自动创建代码及其日志，保留实现以便后续恢复。
下文 2026-09-15 章节中的自动创建行为在此期间不执行；其余规则匹配和显式保存 API 保持不变。

```text
搜索 → 工作区 File Service → 已有 .zcodeignore：读取规则
                         └→ 文件不存在：.gitignore + 默认规则，仅内存使用
```

桌面和远程工作区共用此规则加载路径，不改 session/task stream 或 continuous/replayable 边界。
验收：搜索不创建 `.zcodeignore`，内存规则仍过滤构建/依赖目录，手动提供的 `.zcodeignore` 仍生效。

## 背景

Composer 的 `@` 文件候选、Command Center 的 workspace 文件搜索与左侧 Workspace File Tree 的搜索态共同调用
`IFileService.listWorkspaceFiles`。现有实现把默认黑名单直接固化为布尔函数，并且把所有以 `.`
开头的目录整棵剪枝，导致 `.github/workflows`、`.vscode` 等目录中的用户文件无法通过文件名搜索。
部分通用目录名和文件后缀也被过度过滤，例如 `build`、`vendor`、`*.map` 和 `*.min.js`。

2026-09 增补背景：黑名单放开 `bin`/`obj` 等构建目录后，.NET 类 workspace 的 `@` 文件索引会整棵
遍历 `obj/`、`bin/Debug`（数万文件），扫描秒级转圈且候选基数放大渲染层过滤成本（用户反馈
ZCT-2096811705629528064：`@` 引用文件 very slow and make app hang）。根因是索引不感知仓库的
ignore 语义——构建产物几乎总是被 `.gitignore` 声明，工具侧应尊重它（ripgrep/fd/VS Code Quick Open
的默认行为）。本仓库选择把它收敛为 workspace 级的 `.zcodeignore` 单一真相源，见下文专章。

## 本期目标

- 把 workspace 文件黑名单封装为 service 内部的稳定过滤器接口。
- 提供一份默认过滤器实现，修正过宽的默认规则。
- `fileService` 只依赖最终传入的过滤器；未注入时使用默认实现。
- 为后续自定义规则保留替换入口，但本期不定义自定义规则的来源或格式。

本期不实现：

- ~~ignore 文件读取或 Git ignore 语义~~（2026-09-15 已由 `.zcodeignore` 章节落地）；
- ~~Settings 页面、配置 schema 或持久化~~（2026-09-15 已落地 workspace 搜索忽略规则的设置编辑页）；
- ~~glob/matcher 依赖~~（2026-09-15 引入 `ignore` npm 包，见专章）；
- renderer/RPC 传递规则；
- 默认规则与自定义规则的合并策略（`.zcodeignore` 是唯一规则文件，无合并问题）。

未来自定义规则可能来自文件、设置页面或其他配置。配置层负责把规则编译成相同的过滤器接口，
并在创建 file service 时替换默认实现。因为是完整替换而不是与默认黑名单求并集，未来实现可以
重新包含默认被排除的 `node_modules`、`.env` 等路径。

```text
当前
createFileService()
    └─ DefaultWorkspaceFileSearchFilter
          └─ 默认黑名单

未来
自定义规则来源（文件 / 设置页面 / 其他）
    └─ CustomWorkspaceFileSearchFilter
          └─ 注入 createFileService，完整替换默认实现
```

## 过滤器契约

过滤器接收一个 workspace entry 的完整上下文：

- `name`
- `path`
- `relativePath`
- `type`

过滤器分别决定：

- `include`：是否把当前 entry 返回给搜索调用方；
- `traverse`：当前 entry 是目录时，是否继续扫描其后代。

拆开两个决策是隐藏目录行为正确的前提：

```text
普通目录 src/                 include=true   traverse=true
隐藏目录 .github/             include=false  traverse=true
默认排除目录 node_modules/    include=false  traverse=false
普通文件 App.tsx              include=true   traverse=false
```

文件系统自身的不可读、路径消失等错误处理不属于内容过滤器，继续由 `fileService` 负责。目录软链接和
Windows Junction 会先按目标类型交给过滤器判断，但索引不沿链接继续递归，避免链接环和越过 workspace
root 的扫描。

## 默认规则

### 默认排除目录

默认过滤器继续排除并停止遍历明确的大体量依赖、缓存、报告或工具内部目录，包括：

- `.git`、`.hg`、`.svn`；
- `node_modules`、`bower_components`、`jspm_packages`；
- `__pycache__`、`site-packages`、`venv`；
- `coverage`、`htmlcov`、`lcov-report`；
- `CMakeFiles`、`cmake-build-*`、`bazel-*`、`Pods`、`DerivedData`；
- `storybook-static`、`playwright-report`、`test-results`、`allure-results`、`allure-report`、`cdk.out`；
- `eggs`、`pip-wheel-metadata`、`wheels`、`*.egg-info`、`*.dist-info`。

这些规则只是默认实现，不是未来自定义过滤器不可覆盖的安全边界。

### 隐藏路径

- 普通隐藏目录本身不进入候选，但继续扫描后代。
- `.github/workflows/release.yml` 可通过 `release` 搜索到，但 `.github` 不占用空 query 的目录候选。
- `.gitignore` 等普通隐藏文件进入候选。
- `.env` 与 `.env.*` 由默认过滤器排除，包括隐藏目录中的同名文件。
- `.git`、`.hg`、`.svn` 仍按明确目录规则停止遍历。

### 不再默认排除的内容

以下名称可能包含用户维护的源码、脚本或配置，本期从默认目录黑名单移除：

- `vendor`、`env`、`dist`、`build`、`out`、`target`；
- `bin`、`obj`、`classes`、`_build`、`deps`、`dist-newstyle`、`renv`。

以下文件后缀也不再默认排除：

- `*.map`；
- `*.min.js`；
- `*.min.css`。

本期不引入排序权重；恢复后的内容作为普通候选参与既有搜索和排序。

### 继续默认排除的文件

明确的编译缓存、二进制和包产物继续默认排除，例如 `.pyc`、`.class`、`.dll`、`.exe`、
`.o`、`.jar`、`.so`、`.tsbuildinfo`，以及 `coverage.out`、`lcov.info`。

## `.zcodeignore`：workspace 搜索忽略的单一真相源（2026-09-15）

### 定位与数据流

`.zcodeignore` 是 workspace root 下控制本 workspace 文件搜索索引的**唯一规则文件**（gitignore 语法）。
它不是与 `.gitignore` 并行的第二层规则——首次需要规则而文件不存在时，Host 自动创建一份
内容为「root `.gitignore` 拷贝 + 注释分隔的内置默认排除段」的 `.zcodeignore`；此后搜索只遵循
`.zcodeignore`，`.gitignore` 的后续变化不影响搜索（用户想同步可在设置页用「从 .gitignore
重新同步」显式重建）。附加默认段（node_modules/ 等）是行为兼容要求：`.gitignore` 未声明这些
目录的仓库若只做纯拷贝，依赖目录会被整棵放开扫描，回归性能问题；用户删除该段即可放开对应
目录，维持"规则文件是唯一目录真相源、无代码级并集"的承诺。`.zcodeignore` 文件自身是工具
配置，不进入 `@` 候选。

```text
workspace root
  ├─ .gitignore ──(仅首次拷贝)──┐
  │                             ▼
  └─ .zcodeignore <──自动创建── Host: listWorkspaceFiles 扫描前
        ▲                       │ 不存在→原子创建（gitignore 拷贝+默认排除段；
        │                       │   无 .gitignore→说明注释+默认排除段）
        │                       │ 读/建失败→fail-open：内存用同等内容执行，不阻塞扫描
        │                       ▼
        │            ignore 包解析（gitignore spec 2.22 参考实现）
        │                       ▼
        │            目录命中 → 不遍历整棵子树；文件命中 → 不进入候选
        │
  Settings「工作区搜索」section
        ├─ fileService.readWorkspaceFileSearchIgnore（走 workspace 服务解析，远程=远端 Host）
        ├─ textarea 编辑 → writeWorkspaceFileSearchIgnore（原子写，下次扫描生效）
        ├─ 「从 .gitignore 同步」按钮（分区操作：只重写 gitignore 同步区）
        └─ 「恢复默认规则」按钮（分区操作：只重置默认排除段）
```

### 规则语义

- 解析交给 `ignore` npm 包（ESLint 同款，gitignore spec 参考实现），覆盖后声明覆盖先声明、
  `!` 反选（含"父目录排除后子文件无法反选恢复"的 git 原生约束）、anchored 与 basename 匹配、
  `**` 跨层、目录后缀 `/`、字符类与转义。禁止手写解析（repo-wiki 的私有子集实现不满足上述语义）。
- 只存在 workspace root 一个 `.zcodeignore`，不合并子目录的 `.gitignore`/`.zcodeignore`
  （语义透明、可整体编辑；这是相对 ripgrep 嵌套语义的刻意简化）。
- 规则只作用于"搜索索引"（`@` 候选 / Command Center / File Tree 搜索），不影响文件树浏览、
  上传、Agent 文件访问等其他文件能力。
- 内置 `defaultWorkspaceFileSearchFilter` 保留文件级规则（`.env`/二进制后缀）与隐藏目录
  后代可搜语义，与 `.zcodeignore` 规则叠加执行；其目录黑名单部分退役为「默认模板初始内容 +
  fail-open 兜底」，不再作为常规路径的并集规则。

### 自动创建与 fail-open

- 首次扫描发现 `.zcodeignore` 不存在 → 原子写创建（目标目录临时文件 + rename，内容确定性
  相同，并发创建相互覆盖无害）；内容 = root `.gitignore` 拷贝 + 注释分隔的内置默认排除段；
  无 `.gitignore` → 说明注释 + 默认排除段（行为与旧默认黑名单一致）。
- 创建或读取失败（只读文件系统、权限）→ 内存中按同等内容执行（`.gitignore` 可读则按
  "拷贝+默认段"，否则仅默认段）。降级必须 warn 日志，且不得中断扫描（`@` 面板不能因规则
  文件不可用而失败）。
- 创建/降级事件是低频生命周期事件，走 info/warn 级日志，不在扫描热路径刷屏。

### 多端边界（沿用本章既有原则）

`.zcodeignore` 的读取、创建、匹配全部发生在 workspace 所在机器的 file service Host
（本地=窗口 Local Host utility process；远程=远端 zcode-server 进程）。设置页通过 workspace
服务解析访问同一 Host，天然写对机器。UI 不做第二份规则副本或本地预判。

## 多端与调用边界

过滤发生在对应 workspace 的 file service 所在 Host：本地 workspace 使用 Local Host，远程 workspace
使用 Remote Host。UI 不读取本地路径来推断远程过滤结果，也不维护第二份黑名单。

本期不修改 session/task stream、continuous/replayable、remote attachment 或 workspace identity 语义。
Composer `@`、Command Center 与 Workspace File Tree 搜索因共享 `listWorkspaceFiles`，同步使用同一默认过滤器。文件树搜索只复用候选索引、Host 过滤与 fuzzy 匹配排序；搜索后仍走文件树自身行为，例如打开 `PreviewPane` 或定位/展开目录，不插入 Composer mention。

## 验收

- `.github` 等普通隐藏目录的后代可通过文件名搜索，隐藏目录自身不进入候选。
- `.git` 与 `node_modules` 默认不进入候选且不扫描后代。
- `.env`、`.env.*` 默认不进入候选；`.gitignore` 可以进入候选。
- 过去因通用目录名或 `.map`、`.min.js`、`.min.css` 被过滤的文件恢复为普通候选。
- 注入替代过滤器后，默认规则不再额外执行；替代实现可以包含 `node_modules` 和 `.env`。
- 不可读目录容错、返回结构和既有排序保持不变。
- Workspace File Tree 搜索与 `@` 文件候选对同一 workspace 和 query 使用同一候选集合与匹配排序；差异只体现在搜索后的 UI 行为。

`.zcodeignore`（2026-09-15）追加验收：

- 首次扫描自动创建 `.zcodeignore`，内容为 `.gitignore` 拷贝 + 内置默认排除段；无 `.gitignore` 时为说明注释 + 默认排除段（行为与旧内置黑名单一致）。`.zcodeignore` 自身不进入候选。
- `.zcodeignore` 命中的目录整棵不遍历、文件不进入候选；`!` 反选、anchored、`**`、目录后缀 `/` 等语义与 git 一致（由 ignore 包保证）。
- 编辑 `.gitignore` 不影响已有 `.zcodeignore` 的搜索结果；设置页「从 .gitignore 同步」后按新内容生效。

分区操作（2026-09-15 补充）：`.zcodeignore` 内部由两行标记注释分区——gitignore 同步区
（SYNC 标记之上）、默认排除段（两个标记之间）、自定义规则区（DEFAULTS 标记之下）。
「从 .gitignore 同步」只重写 gitignore 同步区；「恢复默认规则」只重置默认排除段；
用户在默认段的删改（如放开 node_modules）与自定义规则区的内容，任何按钮都不会覆盖。
标记行被删除时（旧格式/手动清理）无法结构化定位分区，按钮退化为整体初始内容重建。
两个按钮都只把结果填入编辑框，保存才落盘。
- 只读文件系统或权限失败时扫描不中断，降级链（.zcodeignore → .gitignore → 内置黑名单）产生 warn 日志。
- 远程 workspace 的规则读取/创建/匹配发生在远端 Host，与本地行为一致。
