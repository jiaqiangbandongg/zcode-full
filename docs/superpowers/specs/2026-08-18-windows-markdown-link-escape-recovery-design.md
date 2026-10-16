# Windows 路径 markdown 链接转义还原设计

日期：2026-08-18
状态：设计 → 实施
影响面：`packages/ui/src/lib/windowsFileLinkEscapeRemarkPlugin.ts`（新增）、
`packages/ui/src/components/ai-elements/message.tsx`（挂载 remark 插件）。
不改文件打开链路、不改 rehype 改写、不改 citation 插件。

## 背景

同一份「截图失败」现场日志里，除了 Helper DPI 网关拦截（已在 producer 侧修复），
还有第二个用户可见故障：模型走 PowerShell 兜底截图成功落盘

```text
C:\Users\dev\.zcode\workspace\default\screenshot.png   518252 bytes
```

但会话区里的预览打不开，`file.stat` / `file.readMediaPreview` 报 ENOENT，
实际请求的是

```text
C:/Users/dev.zcode/workspace/default/screenshot.png
```

`\.zcode` 变成了 `.zcode` —— 少了一个反斜杠。

## 根因

CommonMark 规定链接目标里的反斜杠转义**只对 ASCII 标点生效**：`\X` 中 X 是标点
时产出 X 本身，否则反斜杠原样保留。Windows 路径恰好横跨这两类：

```text
源码   [screenshot.png](C:\Users\dev\.zcode\workspace\default\screenshot.png)
                          ↑U    ↑z   ↑.      ↑w        ↑d       ↑s
                          留    留   吃掉    留        留       留
mdast  url = C:\Users\dev.zcode\workspace\default\screenshot.png
```

实测（`remark-parse`）确认：只有 `\.` 这一处塌掉，其余反斜杠全部存活。

丢失发生在 **mdast 解析阶段**。现有的 `rewriteLocalFileMarkdownTargetsRehypePlugin`
跑在 rehype 阶段，拿到的 `node.properties.href` 已经是丢失后的字符串，它把
`\` 换成 `/` 只是把错误路径换了个写法，无从还原。

这是**设计层面的阶段错配**，不是那个 rehype 插件的实现 bug：任何 rehype 插件都
无法看到原始 destination 文本。修复必须提前到 remark 阶段，那里 `node.position`
仍然指向 VFile 原文。

## 目标

1. 模型输出的 Windows 绝对路径（盘符与 UNC）链接/图片，`node.url` 还原为原文写法。
2. 还原必须**可验证**：只有「把原文按 CommonMark 规则反转义后恰好等于 `node.url`」
   才替换，否则保持现状。宁可不修，不可修错。
3. 不影响非 Windows 路径、不影响 `http(s)`、不影响相对路径与 citation。

## 非目标

- 不改模型侧输出（让模型自己转义反斜杠不可控，且历史消息已经落库）。
- 不改 rehype 阶段那条链路，它对已正确的 URL 继续照常工作。
- 不处理 `<...>` 尖括号形式与带 title 的链接：这两种在本场景不出现，
  统一按「不还原」处理，保持 fail closed。

## 设计

### 阶段

```text
markdown 源文本
    │
    ├─ remark-parse ──────────► mdast（此时 destination 已被反转义，位置信息尚在）
    │
    ├─ ✦ windowsFileLinkEscapeRemarkPlugin  ← 新增，在此还原 node.url
    │
    ├─ 其余 remark 插件（GFM / citation）
    │
    ├─ mdast → hast
    │
    ├─ rewriteLocalFileMarkdownTargetsRehypePlugin（既有，规整成 /C:/… 供安全层放行）
    │
    └─ rehype-harden → 渲染
```

### 还原算法

对每个 `link` / `image` / `definition` 节点：

1. 门禁：`node.url` 必须形如 `X:\…` / `X:/…`（盘符）或以单个 `\` 开头（UNC）。
   其余一律跳过，普通 URL 不进入本插件的改写面。

   UNC 只要求**单个**前导反斜杠：源码里的 `\\host` 中 `\\` 自身就是一次标点转义，
   解析后只剩一个反斜杠（实测 `[log](\\build01\share\.logs\run.txt)` →
   `\build01\share.logs\run.txt`）。要求两个反而会把真正需要还原的 UNC 全部漏掉。
2. `node.title` 非空则跳过（不解析 title 语法）。
3. 用 `node.position` 的 start/end offset 从 VFile 原文切出整段，按节点形态取
   destination：
   - `link` / `image`：`[label](dest)` / `![alt](dest)`，要求以 `)` 结尾，取最后一个
     `](` 之后到收尾 `)` 之前的片段。Windows 路径不含 `](`，所以在门禁之内「取最后
     一个」是安全的，label/alt 内部的方括号也不会把切片带偏。
   - `definition`：`[ref]: dest`，取 `]:` 之后的片段。引用式链接的 URL 由 definition
     提供，同一处丢失在这条路径上同样成立。
4. 尖括号形式（`<…>`）跳过。
5. **验证**：`unescapeCommonMarkPunctuation(raw) === node.url` 才认为切片正确
   且还原无歧义，此时 `node.url = raw`；否则保持不变。

其中反转义规则与 CommonMark 一致：

```text
\ 后跟 ASCII 标点（! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ \ ] ^ _ ` { | } ~）
  → 去掉反斜杠
其他情况 → 原样保留
```

第 5 步是整个设计的安全阀：切片切错、原文含实体引用（`&amp;`）、
或任何我们没预料到的语法，都会导致等式不成立，从而放弃还原而不是写入错误路径。

### 挂载

`message.tsx` 里 `messageRemarkPlugins` 目前只在
`renderZCodeFileCitations && workspacePath` 时才显式提供，否则传 `undefined`
（走 Streamdown 默认）。本插件必须**无条件**生效，因此改为始终显式提供
`defaultRemarkPlugins + windowsFileLinkEscapeRemarkPlugin`，citation 插件仍按原
条件追加。显式传入默认插件是既有约定（见该处既有注释：不带默认插件会让表格退化）。

## 影响与风险

- **多平台**：门禁只认盘符/UNC 形态，macOS/Linux 上模型不会产出这种 URL，
  插件对它们是一次正则判断。
- **性能**：只在命中门禁时才切片原文，正常会话里命中率极低。
- **误伤**：由第 5 步等式验证兜底；不成立即放弃。
- **历史消息**：还原发生在渲染期，历史消息重新渲染即生效，无需数据迁移。

## 验收

1. 新增单测覆盖：`\.zcode` 还原、image 节点、UNC 前导反斜杠塌陷、引用式 definition、
   无需还原时不动、非 Windows URL 不动、带 title 跳过、尖括号跳过、
   验证不通过（实体引用）时保持原值。
2. `pnpm exec vitest run packages/ui/test/windowsFileLinkEscapeRemarkPlugin.test.ts` 通过，
   且 message.tsx 依赖的 11 个既有测试文件全绿。
3. 端到端：会话里 `[x](C:\Users\dev\.zcode\...\screenshot.png)` 预览可打开。
